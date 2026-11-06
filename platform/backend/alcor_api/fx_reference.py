"""Opt-in fixed public provider. No quote fetch occurs on import or ordinary reads."""

import asyncio
import hashlib
import json
import re
from datetime import UTC, date, datetime
from decimal import Decimal, DecimalException
from fractions import Fraction
from uuid import UUID, uuid4

import httpcore
import httpx
from fastapi import HTTPException

from .market_reference import amount, currency

PROVIDER = "frankfurter-v1"
URI = "https://api.frankfurter.dev/v1/latest?base=USD"


def parse_raw(raw, received_at):
    if not isinstance(raw, bytes) or not 1 <= len(raw) <= 131072 or received_at.tzinfo is None:
        raise ValueError("invalid source response")

    def unique(pairs):
        value = {}
        for k, v in pairs:
            if k in value:
                raise ValueError("duplicate source field")
            value[k] = v
        return value

    data = json.loads(
        raw,
        parse_float=Decimal,
        object_pairs_hook=unique,
        parse_constant=lambda x: (_ for _ in ()).throw(ValueError("invalid number")),
    )
    if (
        not isinstance(data, dict)
        or data.get("base") != "USD"
        or type(data.get("amount")) not in (int, Decimal)
        or data.get("amount") != 1
    ):
        raise ValueError("unexpected provider base or amount")
    if not isinstance(data.get("date"), str) or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", data["date"]):
        raise ValueError("source date precision invalid")
    if not isinstance(data.get("rates"), dict) or not 1 <= len(data["rates"]) <= 200:
        raise ValueError("invalid source rates")
    observed = date.fromisoformat(data["date"])
    if observed > received_at.astimezone(UTC).date():
        raise ValueError("future observation date")
    rates = {currency(k): amount(v) for k, v in data["rates"].items()}
    if rates.pop("USD", Decimal(1)) != 1 or not rates:
        raise ValueError("invalid rates")
    normalized = json.dumps(
        {
            "provider": PROVIDER,
            "uri": URI,
            "base": "USD",
            "observation_date": observed.isoformat(),
            "rates": {k: format(v, "f") for k, v in sorted(rates.items())},
        },
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    return {
        "date": observed,
        "rates": rates,
        "raw_sha": hashlib.sha256(raw).hexdigest(),
        "normalized_sha": hashlib.sha256(normalized).hexdigest(),
    }


async def persist(conn, raw, received_at, identifier):
    parsed = parse_raw(raw, received_at)
    identifier = UUID(str(identifier))
    await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended('fx-provider:frankfurter-v1',0))")
    prior = await (await conn.execute("SELECT * FROM fx_observations WHERE id=%s", (identifier,))).fetchone()
    if prior:
        if (
            prior["normalized_sha256"] != parsed["normalized_sha"]
            or bytes(prior["original_bytes"]) != raw
            or prior["received_at"] != received_at
        ):
            raise ValueError("observation UUID content collision")
        return identifier
    await conn.execute(
        "INSERT INTO fx_observations(id,provider,source_uri,base_currency,observation_date,received_at,original_bytes,raw_sha256,normalized_sha256) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s)",
        (
            identifier,
            PROVIDER,
            URI,
            "USD",
            parsed["date"],
            received_at,
            raw,
            parsed["raw_sha"],
            parsed["normalized_sha"],
        ),
    )
    for code, value in parsed["rates"].items():
        await conn.execute(
            "INSERT INTO fx_values(observation_id,currency,rate) VALUES(%s,%s,%s)", (identifier, code, value)
        )
    return identifier


async def external_delivery_blocked(conn):
    return bool(
        await (
            await conn.execute(
                "SELECT 1 FROM restore_quarantine WHERE category='external_delivery_disabled' AND payload->>'disabled'='true'"
            )
        ).fetchone()
    )


class FxWorker:
    def __init__(self, db, *, enabled=False, transport=None, request_timeout=15):
        self.db = db
        self.enabled = enabled
        self.transport = transport
        self.request_timeout = min(15, max(0.001, request_timeout))

    async def claim_task(self):
        if not self.enabled:
            return "disabled", None
        async with self.db.connection() as conn, conn.transaction():
            if await external_delivery_blocked(conn):
                return "quarantined", None
            task = await (
                await conn.execute(
                    "SELECT * FROM fx_refresh_tasks WHERE state='queued' ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1"
                )
            ).fetchone()
            if not task:
                return "idle", None
            await conn.execute(
                "UPDATE fx_refresh_tasks SET state='running',started_at=clock_timestamp() WHERE id=%s",
                (task["id"],),
            )
        return "running", task

    async def once(self):
        status, task = await self.claim_task()
        if task is None:
            return status
        from .fx_response_originals import ResponseRejected, retain
        origin=str(self.db.settings.instance_id)
        raw=None;response_status=None;complete=False
        representation='http_response_body' if task.get('provider_revision') else 'http_decoded_response_body'
        try:
            if task.get("provider_revision"):
                from .fx_custom import read

                async with asyncio.timeout(self.request_timeout), self.db.connection() as conn:
                    raw = await read(
                        conn, self.db, task["provider_revision"], getattr(self, "custom_requester", None)
                    )
                response_status=getattr(raw,'status',None)
                complete=getattr(raw,'complete',True)
            else:
                async with (
                    asyncio.timeout(self.request_timeout),
                    httpx.AsyncClient(
                        timeout=10, follow_redirects=False, trust_env=False, transport=self.transport
                    ) as client,
                    client.stream("GET", URI, headers={"Accept": "application/json"}) as response,
                ):
                    response_status=response.status_code
                    raw = bytearray()
                    async for chunk in response.aiter_bytes():
                        raw.extend(chunk)
                        if len(raw) > 131072:
                            raw=raw[:131072]
                            raise ValueError("provider response too large")
                    complete=True
            received = datetime.now(UTC)
            await retain(self.db,task,origin,raw,response_status,complete,representation)
            if not complete or response_status is not None and response_status!=200:
                raise ValueError('provider_http_error')
            async with self.db.connection() as conn, conn.transaction():
                locked = await (
                    await conn.execute(
                        "SELECT state FROM fx_refresh_tasks WHERE id=%s FOR UPDATE", (task["id"],)
                    )
                ).fetchone()
                if locked["state"] != "running":
                    return "interrupted"
                config=await(await conn.execute('SELECT enabled,provider_revision FROM fx_config WHERE singleton FOR SHARE')).fetchone()
                if not config or not config['enabled'] or config['provider_revision']!=task.get('provider_revision') or await external_delivery_blocked(conn):
                    raise HTTPException(503,'汇率采集许可已变化')
                if task.get("provider_revision"):
                    from .fx_custom import authorize_source
                    await authorize_source(conn,self.db,task['provider_revision'])
                    from .fx_custom import persist as persist_custom

                    observation = await persist_custom(
                        conn, bytes(raw), received, uuid4(), task["provider_revision"]
                    )
                else:
                    observation = await persist(conn, bytes(raw), received, uuid4())
                await conn.execute(
                    "UPDATE fx_refresh_tasks SET state='completed',completed_at=clock_timestamp(),observation_id=%s WHERE id=%s",
                    (observation, task["id"]),
                )
                await conn.execute(
                    "INSERT INTO audit_events(actor_id,action,target_id) VALUES(%s,'reference.fx.completed',%s)",
                    (task["owner_id"], str(task["id"])),
                )
            return "completed"
        except (
            HTTPException,
            OSError,
            ValueError,
            KeyError,
            TypeError,
            DecimalException,
            httpx.HTTPError,
            httpcore.NetworkError,
            httpcore.ProtocolError,
            httpcore.TimeoutException,
            TimeoutError,
        ) as error:
            if isinstance(error,ResponseRejected):
                raw,response_status,complete=error.raw,error.status,error.complete
            if raw is not None:
                await retain(self.db,task,origin,raw,response_status,complete,representation)
            async with self.db.connection() as conn:
                await conn.execute(
                    "UPDATE fx_refresh_tasks SET state='failed',completed_at=clock_timestamp(),error_code='provider_unavailable' WHERE id=%s AND state='running'",
                    (task["id"],),
                )
            return "failed"

    async def recover_interrupted(self):
        async with self.db.connection() as conn:
            await conn.execute(
                "UPDATE fx_refresh_tasks SET state='interrupted',completed_at=clock_timestamp(),error_code='worker_interrupted' WHERE state='running' AND started_at<clock_timestamp()-interval '2 minutes'"
            )

    async def snapshot(self, observation_id=None, *, exact=False):
        async with self.db.connection() as conn, conn.transaction():
            row = await (
                await conn.execute(
                    "SELECT o.*,c.provider_revision AS selected_revision FROM fx_config c LEFT JOIN LATERAL (SELECT * FROM fx_observations WHERE ((%s::uuid IS NULL AND provider_revision IS NOT DISTINCT FROM c.provider_revision) OR id=%s::uuid) ORDER BY source_instant DESC NULLS LAST,observation_date DESC NULLS LAST,received_at DESC,id DESC LIMIT 1) o ON true WHERE c.singleton=true",
                    (observation_id, observation_id),
                )
            ).fetchone()
            if not row or row["id"] is None:
                if observation_id is not None:
                    raise HTTPException(404, "汇率观测不存在")
                return {
                    "base": "USD",
                    "rates": {"USD": "1" if exact else 1},
                    "quoted": [],
                    "identityCurrencies": ["USD"],
                    "updatedAt": None,
                    "observationId": None, "providerRevision": None, "state": "unknown",
                    "receivedAt": None, "freshness": "not_assessed",
                    "updatedAtAuthority": "provider_response_received_at",
                    "observationDate": None,
                    "source": "custom" if row and row["selected_revision"] else PROVIDER,
                }
            rates = await (
                await conn.execute(
                    "SELECT currency,rate,numerator,denominator FROM fx_values WHERE observation_id=%s ORDER BY currency",
                    (row["id"],),
                )
            ).fetchall()
            from .reference_integrity import fx_observation
            config=None
            if row.get('provider_revision') is not None:
                provider=await(await conn.execute('SELECT config FROM fx_provider_revisions WHERE id=%s',(row['provider_revision'],))).fetchone()
                config=provider['config'] if provider else None
            try:
                fx_observation(row,rates,config)
            except (ValueError,TypeError,KeyError,ArithmeticError):
                return {'base':'USD','rates':{'USD':'1' if exact else 1},'quoted':[],
                        'identityCurrencies':['USD'],'updatedAt':None,'receivedAt':None,
                        'observationId':str(row['id']),'providerRevision':str(row['provider_revision']) if row.get('provider_revision') else None,
                        'state':'retained_unavailable','freshness':'not_assessed','integrityState':'unavailable',
                        'unavailableReason':'retained_original_or_projection_integrity','observationDate':None,
                        'observationInstant':None,'sourcePrecision':'unknown','source':row['provider'],
                        'updatedAtAuthority':'provider_response_received_at'}
            return {
                "base": "USD",
                "rates": {
                    "USD": "1" if exact else 1,
                    **{r["currency"]: format(r["rate"], "f") if exact else float(r["rate"]) for r in rates},
                },
                "quoted": ([] if exact else ["USD"]) + [r["currency"] for r in rates],
                "identityCurrencies": ["USD"],
                "updatedAt": int(row["received_at"].timestamp() * 1000),
                "observationId": str(row["id"]), "providerRevision": str(row["provider_revision"]) if row.get("provider_revision") else None,
                "receivedAt": row["received_at"].isoformat(), "state": "observed", "freshness": "not_assessed",
                "rawSha256": row["raw_sha256"], "normalizedSha256": row["normalized_sha256"],
                "updatedAtAuthority": "provider_response_received_at",
                "observationDate": row["observation_date"].isoformat() if row["observation_date"] else None,
                "observationInstant": row["source_instant"].isoformat()
                if row.get("source_instant")
                else None,
                "sourcePrecision": row.get("source_precision", "date"),
                "roundedCurrencies": [
                    r["currency"]
                    for r in rates
                    if r.get("numerator") is not None
                    and Fraction(r["rate"]) != Fraction(int(r["numerator"]), int(r["denominator"]))
                ],
                "exactRatios": {
                    r["currency"]: {"numerator": str(r["numerator"]), "denominator": str(r["denominator"])}
                    for r in rates
                    if r.get("numerator") is not None
                },
                "ratesPrecision": "display-rounded"
                if any(r.get("numerator") is not None for r in rates)
                else "source-decimal",
                "source": row["provider"],
            }
