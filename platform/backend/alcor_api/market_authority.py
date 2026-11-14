"""One owner/license/instance-bound PG authority for demands, source pages and facts."""

from dataclasses import asdict, dataclass
from datetime import UTC, date, datetime, timedelta
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .market_contract import (
    MARKETS,
    ZONES,
    Query,
    collection_purpose,
    digest,
    installed_bar_semantics,
    installed_latest_semantics,
    installed_price_series_semantics,
    series_fingerprint,
)
from .market_contract import (
    code as normalized_code,
)
from .native_app_auth import active_grant, authenticate
from .security import lock_mutation_identity, lock_read_identity


@dataclass(frozen=True)
class Policy:
    id: str
    source: str
    source_version: str
    target_id: str
    target_fingerprint: str
    owner_id: str
    license_revision: str
    purposes: tuple[str, ...]
    markets: tuple[str, ...]
    fixture: bool = False
    source_symbols: tuple[tuple[str, str, str], ...] = ()
    timestamp_zones: tuple[tuple[str,str], ...] = ()

    @property
    def fingerprint(self):
        raw = asdict(self)
        if not self.source_symbols:
            raw.pop('source_symbols')
        if not self.timestamp_zones:raw.pop('timestamp_zones')
        return digest(raw)



def valid_source_symbols(policy):
    try:
        from zoneinfo import ZoneInfo
        zones=policy.timestamp_zones
        if not isinstance(zones,(tuple,list))or len(zones)>5 or len({v[0]for v in zones})!=len(zones):return False
        for market,zone in zones:
            if policy.source!='tencent'or policy.source_version!='tencent-quotes-v1'or market not in policy.markets or market not in ('US','HK','CN','JP','KR')or not isinstance(zone,str):return False
            ZoneInfo(zone)
    except (ValueError,TypeError,KeyError,IndexError):return False
    aliases = policy.source_symbols
    if not isinstance(aliases, (tuple, list)):
        return False
    seen = set()
    for item in aliases:
        if (not isinstance(item, (tuple, list)) or len(item) != 3
                or not all(isinstance(value, str) and value for value in item)):
            return False
        market, symbol, provider = item
        key = (market, symbol)
        # The installed Yahoo adapter accepts only board selection for the same Korean security.
        if (policy.source != 'yahoo' or policy.source_version != 'yahoo-chart-history-v1'
                or market != 'KR' or market not in policy.markets or key in seen
                or not symbol.isascii() or not symbol.isdigit()
                or provider not in (symbol + '.KS', symbol + '.KQ')):
            return False
        try:
            if normalized_code(market, symbol) != symbol:
                return False
        except (ValueError, TypeError):
            return False
        seen.add(key)
    return True

def query_from(raw):
    if not isinstance(raw, dict):
        raise HTTPException(400, "行情查询参数无效")
    try:
        return Query(**raw).validate()
    except (TypeError, ValueError) as exc:
        raise HTTPException(400, "行情查询范围或口径无效") from exc


class Authority:
    def __init__(self, db, policies=(), *, policy_provider=None, clock=None):
        self.db, self.policies, self.policy_provider = db, tuple(policies), policy_provider
        if clock is not None and db.settings.environment != "test":
            raise ValueError("fixture_clock_outside_test")
        self.clock = clock

    def policy(self, identifier, owner, fingerprint=None):
        current = tuple(self.policy_provider()) if self.policy_provider else self.policies
        matches = [row for row in current if row.id == identifier]
        if len(matches) != 1:
            raise HTTPException(503, "行情来源尚未获实例授权")
        row = matches[0]
        if (
            row.owner_id != owner
            or not row.license_revision
            or not isinstance(row.purposes, (tuple, list))
            or not row.purposes
            or not all(isinstance(value, str) and value for value in row.purposes)
            or not isinstance(row.markets, (tuple, list))
            or not row.markets
            or not all(isinstance(value, str) for value in row.markets)
            or not set(row.markets) <= set(MARKETS)
            or not valid_source_symbols(row)
            or (fingerprint is not None and row.fingerprint != fingerprint)
            or (row.fixture and self.db.settings.environment != "test")
        ):
            raise HTTPException(503, "行情来源许可或目标已变化")
        return row

    async def authorize_read(self, conn, who):
        if getattr(who, "native_client", False):
            grant = await authenticate(conn, who.native_access_token, "portfolio.read")
            if grant["user_id"] != who.id or grant["id"] != who.grant_id:
                raise HTTPException(401, "读取授权已变化")
        elif not await (
            await conn.execute(
                """SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
            WHERE u.id=%s AND s.token_hash=%s AND s.client_id=ANY(%s) AND u.active
            AND s.expires_at>clock_timestamp() AND s.session_version=u.session_version""",
                (who.id, who.token_hash,
                 ['legacy-web','legacy-v1'] if getattr(who,'legacy_client',False) and not getattr(who,'legacy_platform',False) else ['new-web']),
            )
        ).fetchone():
            raise HTTPException(401, "读取授权已变化")

    async def owner_lock(self, conn, who, *, shared_identity=False, opportunistic=False):
        # Observation only renews quote intent. Keep its current write-scope
        # proof, but do not take UPDATE on the native account/grant and block
        # independent account reads. Source/intent mutations stay serialized.
        identity_lock = lock_read_identity if shared_identity else lock_mutation_identity
        await identity_lock(conn, who, require_admin=False)
        key = "market-owner:" + who.id
        if opportunistic:
            row = await (await conn.execute(
                "SELECT pg_try_advisory_xact_lock(hashtextextended(%s,0)) AS acquired", (key,),
            )).fetchone()
            if not row["acquired"]:
                raise HTTPException(503, "行情采集登记繁忙，请稍后重试", headers={"Retry-After": "3"})
            return
        await conn.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", (key,)
        )

    async def config(self, conn, owner, revision):
        row = await (
            await conn.execute(
                """SELECT c.* FROM market_source_configs c JOIN users u ON u.id=c.owner_id
            WHERE c.owner_id=%s AND c.revision=%s AND u.active AND c.session_version=u.session_version
            AND c.origin_instance=%s AND NOT EXISTS(SELECT 1 FROM market_source_revocations r WHERE r.owner_id=c.owner_id AND r.revision=c.revision)""",
                (owner, revision, self.db.settings.instance_id),
            )
        ).fetchone()
        if row is None:
            raise HTTPException(409, "当前行情来源已撤销或需重新确认")
        policy = self.policy(row["policy_id"], owner, row["policy_fingerprint"])
        if row["native_grant_id"]:
            grant = await active_grant(conn, row["native_grant_id"])
            if not grant or grant["user_id"] != owner or "portfolio.write" not in grant["scope"].split():
                raise HTTPException(409, "行情来源的客户端授权已撤销")
        return row, policy

    async def receipt(self, conn, owner, request_id, operation=None):
        row = await (
            await conn.execute(
                "SELECT * FROM market_data_operations WHERE owner_id=%s AND request_id=%s",
                (owner, request_id),
            )
        ).fetchone()
        if row is None:
            row = await (await conn.execute(
                'SELECT fingerprint,result FROM market_diagnostic_admissions WHERE owner_id=%s AND request_id=%s',
                (owner, request_id),
            )).fetchone()
        if row and operation is not None and row["fingerprint"] != digest(operation):
            raise HTTPException(409, "原请求编号已用于不同操作")
        return row["result"] if row else None

    async def save_receipt(self, conn, owner, request_id, operation, result):
        await conn.execute(
            "INSERT INTO market_data_operations(owner_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)",
            (owner, request_id, digest(operation), Jsonb(result)),
        )
        return result

    async def configure(self, who, request_id, policy_id):
        request_id = UUID(str(request_id))
        operation = {"action": "source.configure", "policyId": policy_id}
        async with self.db.connection() as conn, conn.transaction():
            await self.owner_lock(conn, who)
            prior = await self.receipt(conn, who.id, request_id, operation)
            if prior:
                return prior
            policy = self.policy(policy_id, who.id)
            user = await (
                await conn.execute("SELECT session_version FROM users WHERE id=%s", (who.id,))
            ).fetchone()
            revision = uuid4()
            await conn.execute(
                """INSERT INTO market_source_configs(owner_id,revision,request_id,policy_id,policy_fingerprint,origin_instance,session_version,native_grant_id)
                VALUES(%s,%s,%s,%s,%s,%s,%s,%s)""",
                (
                    who.id,
                    revision,
                    request_id,
                    policy_id,
                    policy.fingerprint,
                    self.db.settings.instance_id,
                    user["session_version"],
                    getattr(who, "grant_id", None),
                ),
            )
            return await self.save_receipt(
                conn,
                who.id,
                request_id,
                operation,
                {
                    "requestId": str(request_id),
                    "revision": str(revision),
                    "status": "configured_untested",
                    "providerCalls": 0,
                },
            )

    def validate_query(self, policy, query):
        from .market_yahoo_history import VERSION, installed
        yahoo = policy.source == 'yahoo' and policy.source_version == VERSION and installed(query, policy)
        from .market_tencent_latest import VERSION as TENCENT_VERSION,installed as tencent_installed
        tencent=policy.source=='tencent'and policy.source_version==TENCENT_VERSION and tencent_installed(query)
        from .market_tencent_minute import VERSION as TENCENT_MINUTE_VERSION,installed as tencent_minute_installed
        tencent_minute=policy.source=='tencent'and policy.source_version==TENCENT_MINUTE_VERSION and tencent_minute_installed(query)
        from .market_eastmoney_latest import VERSION as EASTMONEY_VERSION, installed as eastmoney_installed
        eastmoney = policy.source == 'eastmoney' and policy.source_version == EASTMONEY_VERSION and eastmoney_installed(query)
        crypto = False
        if policy.source == 'coingecko':
            from .market_crypto_latest import VERSION as CRYPTO_VERSION
            from .market_crypto_latest import installed as crypto_installed
            crypto = policy.source_version == CRYPTO_VERSION and crypto_installed(query)
            if not crypto:
                raise HTTPException(503, '此加密资产来源尚未安装该证券或行情口径')
        if query.kind == 'latest' and not (
            yahoo or crypto or tencent or eastmoney or policy.source == 'futu' and policy.source_version == 'futu-sdk-records-v1' and installed_latest_semantics(query)
            or policy.fixture and policy.source != 'futu'
        ):
            raise HTTPException(503, '此来源尚未安装该最新报价口径')
        if policy.source == 'yahoo' and not yahoo:
            raise HTTPException(503, '此来源尚未安装该证券或行情口径')
        if query.kind != "latest" and not (
            yahoo or tencent_minute or
            (installed_bar_semantics(query) or installed_price_series_semantics(query))
            and (
                policy.source == "futu"
                and query.market in ("US", "HK", "CN")
                or policy.fixture
                and policy.source != "futu"
            )
        ):
            raise HTTPException(503, "此来源尚未安装该历史采集口径")
        if (
            query.kind != "latest"
            and policy.source == "futu"
            and policy.source_version != "futu-sdk-records-v1"
        ):
            raise HTTPException(503, "当前历史来源协议版本尚未安装")
        purpose = collection_purpose(query)
        if (
            not isinstance(policy.purposes, (tuple, list))
            or not isinstance(policy.markets, (tuple, list))
            or query.market not in policy.markets
            or purpose not in policy.purposes
        ):
            raise HTTPException(403, "当前来源许可未覆盖此市场或数据用途")

    async def demand(self, who, request_id, revision, raw_query, expected_revision=0, *, remove=False, observed=False):
        request_id, revision = UUID(str(request_id)), UUID(str(revision))
        query = query_from(raw_query)
        operation = {
            "action": "demand.remove" if remove else "demand.register",
            "sourceRevision": str(revision),
            "query": asdict(query),
            "expectedRevision": expected_revision,
            **({"observation": True} if observed else {}),
        }
        if type(expected_revision) is not int or expected_revision < 0:
            raise HTTPException(400, "需求版本无效")
        principal = str(getattr(who, "grant_id", None) or "web:" + who.token_hash)
        async with self.db.connection() as conn, conn.transaction():
            await self.owner_lock(conn, who, shared_identity=observed and not remove)
            prior = await self.receipt(conn, who.id, request_id, operation)
            if prior:
                return prior
            _, policy = await self.config(conn, who.id, revision)
            self.validate_query(policy, query)
            stream = await (
                await conn.execute(
                    "SELECT * FROM market_streams WHERE owner_id=%s AND source_revision=%s AND query_fingerprint=%s FOR UPDATE",
                    (who.id, revision, digest(asdict(query))),
                )
            ).fetchone()
            if stream is None:
                if remove:
                    raise HTTPException(404, "本人行情需求不存在")
                stream = await (
                    await conn.execute(
                        "INSERT INTO market_streams(owner_id,source_revision,id,query_fingerprint,query) VALUES(%s,%s,%s,%s,%s) RETURNING *",
                        (who.id, revision, uuid4(), digest(asdict(query)), Jsonb(asdict(query))),
                    )
                ).fetchone()
            old = await (
                await conn.execute(
                    "SELECT *,revoked_at IS NULL AND hot_until>clock_timestamp() AND expires_at>clock_timestamp() AS hot FROM market_demands WHERE owner_id=%s AND stream_id=%s AND principal=%s FOR UPDATE",
                    (who.id, stream["id"], principal),
                )
            ).fetchone()
            if (old["revision"] if old else 0) != expected_revision:
                raise HTTPException(409, "行情需求已变化，请重新核对")
            if query.kind == "latest" and not old and not remove and not await (
                await conn.execute(
                    "SELECT 1 FROM market_demands WHERE owner_id=%s AND stream_id=%s AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>clock_timestamp()) LIMIT 1",
                    (who.id, stream["id"]),
                )
            ).fetchone():
                count = await (
                    await conn.execute(
                        """SELECT count(DISTINCT (s.query->>'market',s.query->>'code',s.query->>'instrument')) AS n FROM market_demands d JOIN market_streams s ON s.owner_id=d.owner_id AND s.id=d.stream_id
                    WHERE d.owner_id=%s AND d.revoked_at IS NULL AND d.expires_at>clock_timestamp() AND s.query->>'kind'='latest'""",
                        (who.id,),
                    )
                ).fetchone()
                same_security=await (await conn.execute("SELECT 1 FROM market_demands d JOIN market_streams s ON s.owner_id=d.owner_id AND s.id=d.stream_id WHERE d.owner_id=%s AND d.revoked_at IS NULL AND d.expires_at>clock_timestamp() AND s.query->>'kind'='latest' AND s.query->>'market'=%s AND s.query->>'code'=%s AND s.query->>'instrument'=%s LIMIT 1",(who.id,query.market,query.code,query.instrument))).fetchone()
                if count["n"] >= 256 and not same_security:
                    raise HTTPException(409, "最多保留256个行情订阅")
            user = await (
                await conn.execute("SELECT session_version FROM users WHERE id=%s", (who.id,))
            ).fetchone()
            row = await (
                await conn.execute(
                    """INSERT INTO market_demands(owner_id,stream_id,principal,native_grant_id,session_version,expires_at,hot_until,origin,revoked_at)
                VALUES(%s,%s,%s,%s,%s,clock_timestamp()+interval '7 days',clock_timestamp()+interval '90 seconds','client',CASE WHEN %s THEN clock_timestamp() ELSE NULL END)
                ON CONFLICT(owner_id,stream_id,principal) DO UPDATE SET revision=market_demands.revision+1,session_version=excluded.session_version,
                expires_at=excluded.expires_at,hot_until=excluded.hot_until,revoked_at=excluded.revoked_at RETURNING *""",
                    (
                        who.id,
                        stream["id"],
                        principal,
                        getattr(who, "grant_id", None),
                        user["session_version"],
                        remove,
                    ),
                )
            ).fetchone()
            await conn.execute(
                "UPDATE market_streams SET demand_generation=demand_generation+1 WHERE owner_id=%s AND id=%s",
                (who.id, stream["id"]),
            )
            if query.kind=='latest' and (not observed or not old or not old['hot'] or old['session_version']!=user['session_version']):
                # Repeated visible-page observations renew demand retention,
                # but must not shorten the worker's five-second source cadence.
                # New/revived demand still wakes a sleeping stream immediately.
                await conn.execute('UPDATE market_streams SET next_due=least(next_due,clock_timestamp()) WHERE owner_id=%s AND id=%s',(who.id,stream['id']))
            return await self.save_receipt(
                conn,
                who.id,
                request_id,
                operation,
                {
                    "requestId": str(request_id),
                    "streamId": str(stream["id"]),
                    "revision": row["revision"],
                    "revoked": remove,
                    "expiresAt": row["expires_at"].isoformat(),
                    "collection": "worker_pending",
                    "observation": observed,
                },
            )

    async def read(self, who, revision, raw_query, *, limit=1000):
        query = query_from(raw_query)
        if not 1 <= limit <= 12000:
            raise HTTPException(400, "查询数量无效")
        async with self.db.connection() as conn, conn.transaction():
            await conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            await self.authorize_read(conn, who)
            _, policy = await self.config(conn, who.id, revision)
            self.validate_query(policy, query)
            stream = await (
                await conn.execute(
                    "SELECT * FROM market_streams WHERE owner_id=%s AND source_revision=%s AND query_fingerprint=%s",
                    (who.id, revision, digest(asdict(query))),
                )
            ).fetchone()
            begin = (
                datetime.combine(
                    date.fromisoformat(query.start), datetime.min.time(), ZoneInfo(ZONES[query.market])
                )
                if query.start
                else None
            )
            end = (
                datetime.combine(
                    date.fromisoformat(query.through) + timedelta(days=1),
                    datetime.min.time(),
                    ZoneInfo(ZONES[query.market]),
                )
                if query.through
                else None
            )
            facts = await (
                await conn.execute(
                    """SELECT * FROM (SELECT DISTINCT ON (source_time) * FROM market_facts WHERE owner_id=%s AND source_revision=%s AND series_fingerprint=%s
                AND (%s::timestamptz IS NULL OR source_time>=%s) AND (%s::timestamptz IS NULL OR source_time<%s)
                ORDER BY source_time DESC,sequence DESC) newest ORDER BY source_time DESC LIMIT %s""",
                    (
                        who.id,
                        revision,
                        series_fingerprint(query),
                        begin,
                        begin,
                        end,
                        end,
                        1 if query.kind == "latest" else limit,
                    ),
                )
            ).fetchall()
            coverage = (
                await (
                    await conn.execute(
                        "SELECT * FROM market_coverage_receipts WHERE owner_id=%s AND stream_id=%s ORDER BY created_at DESC LIMIT 1",
                        (who.id, stream["id"]),
                    )
                ).fetchone()
                if stream and query.kind != "latest"
                else None
            )
            state = "observed" if facts else "unknown"
            if query.kind == "latest" and facts:
                now = self.clock() if self.clock else datetime.now(UTC)
                age = (now - facts[0]["source_time"]).total_seconds()
                if not -5 <= age <= 90 or facts[0]["contents"].get("cached") is not False:
                    state = "stale"
            return {
                "streamId": str(stream["id"]) if stream else None,
                "sourceRevision": str(revision),
                "licenseRevision": policy.license_revision,
                "query": asdict(query),
                "facts": [
                    {
                        **row["contents"],
                        "factId": str(row["id"]),
                        "revision": row["sequence"],
                        "pageId": str(row["page_id"]),
                    }
                    for row in reversed(facts)
                ],
                "state": state,
                "coverage": coverage["assurance"] if coverage else "unknown",
                "fullBusinessHistoryVerified": False,
            }

    async def revoke(self, who, request_id, revision):
        request_id, revision = UUID(str(request_id)), UUID(str(revision))
        operation = {"action": "source.revoke", "revision": str(revision)}
        async with self.db.connection() as conn, conn.transaction():
            await self.owner_lock(conn, who)
            previous = await self.receipt(conn, who.id, request_id, operation)
            if previous:
                return previous
            if not await (
                await conn.execute(
                    "SELECT 1 FROM market_source_configs WHERE owner_id=%s AND revision=%s",
                    (who.id, revision),
                )
            ).fetchone():
                raise HTTPException(404, "本人来源配置不存在")
            await conn.execute(
                "INSERT INTO market_source_revocations(owner_id,revision,request_id) VALUES(%s,%s,%s) ON CONFLICT(owner_id,revision) DO NOTHING",
                (who.id, revision, request_id),
            )
            await conn.execute(
                """UPDATE tasks t SET status=CASE WHEN t.status='running' THEN 'cancel_requested' ELSE 'cancelled' END,
                finished_at=CASE WHEN t.status='queued' THEN clock_timestamp() ELSE t.finished_at END FROM market_data_jobs j JOIN market_streams s ON s.owner_id=j.owner_id AND s.id=j.stream_id
                WHERE j.task_id=t.id AND s.owner_id=%s AND s.source_revision=%s AND t.status IN ('queued','running')""",
                (who.id, revision),
            )
            return await self.save_receipt(
                conn,
                who.id,
                request_id,
                operation,
                {"requestId": str(request_id), "sourceRevision": str(revision), "revoked": True},
            )


async def active_demands(conn, stream, authority=None):
    rows = await (
        await conn.execute(
            """SELECT d.* FROM market_demands d JOIN users u ON u.id=d.owner_id
        WHERE d.owner_id=%s AND d.stream_id=%s AND d.revoked_at IS NULL AND (d.expires_at IS NULL OR d.expires_at>clock_timestamp())
        AND u.active AND d.session_version=u.session_version""",
            (stream["owner_id"], stream["id"]),
        )
    ).fetchall()
    valid = []
    for row in rows:
        if row["origin"] == "price.alert":
            from .market_alert_reader import alert_demand_alive

            if not await alert_demand_alive(conn, row, stream, authority):
                continue
        if row["origin"] == "client" and not row["native_grant_id"]:
            principal=row["principal"]
            if not principal.startswith("web:"):
                continue
            session=await (await conn.execute(
                "SELECT 1 FROM sessions WHERE user_id=%s AND token_hash=%s AND expires_at>clock_timestamp() AND session_version=%s AND client_id=ANY(%s)",
                (row["owner_id"],principal[4:],row["session_version"],["new-web","legacy-web","legacy-v1"]),
            )).fetchone()
            if not session:
                continue
        if row["native_grant_id"]:
            grant = await active_grant(conn, row["native_grant_id"])
            if (
                not grant
                or grant["user_id"] != row["owner_id"]
                or "portfolio.write" not in grant["scope"].split()
            ):
                continue
        valid.append(row)
    return valid
