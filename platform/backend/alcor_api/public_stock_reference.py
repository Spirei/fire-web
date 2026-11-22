"""Licensed SEC exchange directory for stock discovery without artwork or quote data."""

import asyncio
import logging
import re
from dataclasses import asdict, dataclass
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from hashlib import sha256
from types import SimpleNamespace
from uuid import uuid5

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from . import sec_company_protocol
from .confirmed_stock_listings import stock_identity
from .market_discovery_protocol import digest, stock_symbol
from .public_reference import PublicReference
from .sec_company_transport import Transport


KIND = "security-directory"
SOURCE_VERSION = "sec-company-tickers-exchange-v1"
EXCHANGES = {"nasdaq", "nyse", "nyse american", "nyse arca", "cboe", "iex", "memx"}
MAX_AGE = timedelta(days=7)
log = logging.getLogger("alcor.stock-reference")


@dataclass(frozen=True)
class DirectoryTarget:
    id: str
    directory_addresses: tuple[str, ...]
    user_agent: str
    refresh_daily: bool = False

    def validate(self):
        sec_company_protocol.Target(self.id, self.directory_addresses, self.directory_addresses, self.user_agent).validate()
        if type(self.refresh_daily) is not bool:
            raise ValueError("sec_exchange_directory_refresh_setting")
        return self

    @property
    def fingerprint(self):
        return digest(asdict(self.validate()))

    def request(self, cik=None):
        if cik is not None:
            raise ValueError("sec_exchange_directory_scope")
        self.validate()
        path = "/files/company_tickers_exchange.json"
        return "https://www.sec.gov" + path, {
            "target": ("https", "www.sec.gov", 443, path), "addresses": list(self.directory_addresses),
        }


@lru_cache(maxsize=2)
def parse_exchange_directory(raw):
    document = sec_company_protocol.document(raw)
    fields, data = document.get("fields"), document.get("data")
    if (not isinstance(fields, list) or set(fields) != {"cik", "name", "ticker", "exchange"}
            or len(fields) != 4 or not isinstance(data, list) or not 1 <= len(data) <= 20000):
        raise ValueError("sec_exchange_directory_shape")
    by_code = {}
    for values in data:
        if not isinstance(values, list) or len(values) != len(fields):
            raise ValueError("sec_exchange_directory_row")
        row = dict(zip(fields, values))
        exchange = row["exchange"]
        if not isinstance(exchange, str) or exchange.casefold() not in EXCHANGES:
            continue
        cik, name, code = row["cik"], row["name"], sec_company_protocol.ticker(row["ticker"])
        if (type(cik) is not int or not 1 <= cik <= 9999999999 or not isinstance(name, str)
                or not name.strip() or len(name) > 256 or any(ord(char) < 32 for char in name)):
            raise ValueError("sec_exchange_directory_identity")
        item = {"market": "US", "code": code, "name": name.strip(), "exchange": exchange, "cik": cik}
        if code in by_code and by_code[code] != item:
            raise ValueError("sec_exchange_directory_collision")
        by_code[code] = item
    if not by_code:
        raise ValueError("sec_exchange_directory_empty")
    return {"items": list(by_code.values())}


class PublicStockReference:
    source_version = SOURCE_VERSION
    latest_capture_only = True

    def __init__(self, target_provider, transport=None):
        self.target_provider = target_provider
        self.transport = transport or Transport()
        self.verified_capture = None

    def target(self, policy):
        candidates = [
            DirectoryTarget(**{key: value for key, value in item.items() if key != "kind"})
            for item in self.target_provider() if item.get("kind") == KIND and item.get("id") == policy.target_id
        ]
        if len(candidates) != 1 or candidates[0].fingerprint != policy.target_fingerprint:
            raise HTTPException(503, "SEC 证券目录来源尚未安装")
        return candidates[0]

    def normalize(self, raw, collect=False):
        if not isinstance(raw, dict) or raw != {"market": "US"}:
            raise HTTPException(400, "SEC 证券目录仅支持美股市场")
        return dict(raw)

    def scope(self, query):
        return dict(query)

    def validate(self, policy, target, query):
        if policy.kind != KIND or policy.source_version != self.source_version or query != {"market": "US"}:
            raise ValueError("sec_exchange_directory_scope")

    async def acquire(self, target, query, *, before_request=None):
        if before_request is not None:
            await before_request()
        return [{"kind": KIND, "raw": await self.transport.read(target), "status": 200, "complete": True}]

    def project(self, pages, query):
        if len(pages) != 1 or pages[0]["kind"] != KIND or pages[0]["status"] != 200 or not pages[0]["complete"]:
            raise ValueError("sec_exchange_directory_incomplete")
        return parse_exchange_directory(pages[0]["raw"])

    def combine(self, observations, query):
        last = observations[-1]
        if datetime.now(UTC) - datetime.fromisoformat(last["observedAt"]) > MAX_AGE:
            raise HTTPException(503, "SEC 证券目录需要刷新")
        return last["payload"]


def _name(value):
    return " ".join(re.findall(r"[^\W_]+", value.casefold()))


def public_stock_reference(db):
    adapter = PublicStockReference(lambda: db.settings.public_sec_targets)
    return PublicReference(db, policy_provider=lambda: db.settings.public_reference_policies, adapters={KIND: adapter})


async def refresh_directory(service):
    if not service.has_kind(KIND):
        return None
    adapter = service.adapters[KIND]
    query = {"market": "US"}
    async with service.db.connection() as conn, conn.transaction():
        rows = await (await conn.execute(
            "SELECT id,policy_id FROM public_reference_licenses ORDER BY id LIMIT 101"
        )).fetchall()
        if len(rows) > 100:
            return None
        active = []
        for row in rows:
            try:
                policy = service.policy(row["policy_id"])
                if policy.kind != KIND or not adapter.target(policy).refresh_daily:
                    continue
                license_record, policy = await service.current(conn, row["id"], "collect", query)
                await service.current(conn, row["id"], "display", query)
                active.append((row["id"], license_record["created_by"], policy))
            except HTTPException:
                continue
        if len(active) != 1:
            return None
        identifier, owner, policy = active[0]

        async def authorize(connection):
            actor = await (await connection.execute(
                "SELECT 1 FROM users WHERE id=%s AND active AND role='admin' FOR SHARE", (owner,)
            )).fetchone()
            if not actor or not adapter.target(policy).refresh_daily:
                raise HTTPException(403, "SEC 证券目录自动刷新已停用")

        await authorize(conn)
        day = (await (await conn.execute("SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date AS day")).fetchone())["day"]
        request_id = uuid5(identifier, f"{KIND}:{day}")
        hashed = digest({"schedule": KIND, "day": day.isoformat(), "license": str(identifier)})
        who = SimpleNamespace(id=owner)
        await service.request_lock(conn, request_id)
        receipt = await service.prior(conn, who, request_id, hashed)
        retained = []
        if receipt:
            if "kind" in receipt:
                return None
            previous = await (await conn.execute(
                "SELECT * FROM public_reference_pages WHERE request_id=%s ORDER BY page_number", (request_id,)
            )).fetchall()
            if not previous:
                return None
            for row in previous:
                body = bytes(row["raw_bytes"])
                if sha256(body).hexdigest() != row["raw_sha256"]:
                    raise ValueError("sec_exchange_directory_original_mismatch")
                retained.append((row["id"], {
                    "kind": row["kind"], "raw": body, "status": row["http_status"], "complete": row["complete"],
                }))
        else:
            await conn.execute(
                """INSERT INTO public_reference_admissions
                (request_id,request_hash,license_id,query,scope,origin_instance,created_by)
                VALUES(%s,%s,%s,%s,%s,%s,%s)""",
                (request_id, hashed, identifier, Jsonb(query), Jsonb(query), policy.instance_id, owner),
            )
    return await service.complete_capture(
        request_id, identifier, query, query, adapter, policy, hashed, who, authorize, retained=retained,
    )


async def stock_reference_loop(db, stop, ready):
    service = public_stock_reference(db)
    while not stop.is_set():
        if ready():
            try:
                await refresh_directory(service)
            except Exception:
                log.warning("SEC 证券目录刷新未完成")
        try:
            await asyncio.wait_for(stop.wait(), 300)
        except TimeoutError:
            pass


def match_listings(items, text, limit=8):
    needle = text.strip().upper()
    name = _name(text)
    if len(name) < 2:
        return []
    results = []
    for item in items:
        listing_name = _name(item["name"])
        if item["code"] == needle:
            rank = 0
        elif listing_name == name:
            rank = 1
        elif item["code"].startswith(needle) or listing_name.startswith(name + " "):
            rank = 2
        else:
            continue
        results.append((rank, item["code"], item))
    return [item for _, _, item in sorted(results, key=lambda result: result[:2])[:limit]]


async def find_listings(service, text):
    if service is None or len(_name(text)) < 2 or not service.has_kind(KIND):
        return []
    try:
        observed = await service.read(KIND, {"market": "US"})
    except HTTPException as exc:
        if exc.status_code in (403, 404, 409, 503):
            return []
        raise
    return match_listings(observed["items"], text)


async def add_listings(service, results, text):
    needle = text.strip().casefold()
    if any(needle in (row["code"].casefold(), row["name"].casefold()) for row in results):
        return results
    existing = {stock_identity(row["market"], row["code"]) for row in results}
    discovered = []
    for row in await find_listings(service, text):
        identity = stock_identity(row["market"], row["code"])
        if identity in existing:
            continue
        market, code = identity
        existing.add(identity)
        discovered.append({"market": market, "code": code, "name": row["name"],
                           "symbol": stock_symbol(market, code), "price": None, "changePct": None})
    exact = [row for row in discovered if row["code"].casefold() == needle or _name(row["name"]) == _name(text)]
    return [*exact, *results, *(row for row in discovered if row not in exact)][:8]
