"""Explicit administrator quote probes over current approved targets only."""
import asyncio
import math
import time
from datetime import UTC, datetime, timedelta
from uuid import UUID

from fastapi import HTTPException, Request
from psycopg.types.json import Jsonb

from .fx_reference import external_delivery_blocked
from .legacy_identity import assert_native_origin, body
from .market_contract import Query
from .market_worker import decode
from .market_sessions import requested_session
from .security import lock_mutation_identity

PROVIDERS = ("futu", "tencent", "eastmoney", "yahoo")
SAMPLES = (("US", "AAPL"), ("HK", "00700"), ("CN", "600519"), ("JP", "7203"), ("KR", "005930"))


def public_probe_failure(error):
    """Expose fixed failure categories, never SDK text, URLs or vendor bodies."""
    import httpcore
    from .dividend_source_transport import ResponseFailure
    if isinstance(error, (TimeoutError, httpcore.TimeoutException)):
        return {'reason':'source_timeout','message':'来源响应超时'}
    if isinstance(error, ResponseFailure) and error.status != 200:
        return {'reason':'source_http_error','message':f'来源返回 HTTP {error.status}'}
    if isinstance(error, httpcore.ProxyError):
        return {'reason':'source_proxy_error','message':'行情代理连接未完成'}
    if isinstance(error, ValueError) and str(error)=='quote_proxy_configuration_invalid':
        return {'reason':'source_proxy_configuration','message':'行情代理配置无效'}
    if isinstance(error, httpcore.NetworkError):
        return {'reason':'source_network_error','message':'来源网络连接失败'}
    if isinstance(error, ValueError) and str(error) in {'address_not_approved','target_not_approved','source_target_unavailable','source_target_changed'}:
        return {'reason':'source_target_changed','message':'来源地址校验未通过'}
    return {'reason':'quote_not_observed','message':'未取得该市场报价'}


def market_queries(authority, policy):
    queries = []
    for market, code in SAMPLES:
        if market not in policy.markets:
            continue
        query = Query("latest", market, code, session=requested_session() if policy.source=='futu' and market=='US' else 'REGULAR')
        try:
            authority.validate_query(policy, query)
        except HTTPException:
            continue
        queries.append(query)
    return queries


async def probe_markets(authority, transport, policy):
    queries = market_queries(authority, policy)
    markets = {query.market: {"market": query.market, "code": query.code, "state": "unknown", "message": "未完成检测"} for query in queries}
    result = {"state": "unavailable", "message": "未取得有效报价", "markets": markets}
    private_transport = None
    try:
        async with asyncio.timeout(55 if policy.source=='futu' else 18):
            known = None
            reader = transport
            if policy.source == "futu":
                # One probe owns one imported SDK lane for both connection and
                # market checks; importing pandas/Futu twice exhausted the probe.
                from .market_transport import Transport
                private_transport = Transport(authority.db, tuple(transport.targets.values()), target_provider=transport.target_provider,
                                              controlled_http=transport.controlled_http, reuse_latest=True)
                reader = private_transport
                observed = await reader.diagnostic(policy, "futu.test")
                connected = observed.get("responded") is True and observed.get("qotLogined") is True
                result["connectionState"] = "connected" if connected else "unavailable"
                if not connected:
                    for row in markets.values(): row.update(state="unavailable", message="OpenD 未连接")
                    return result
                result.update(state="connected", message="OpenD 已连接，报价暂不可用")
                candidate = observed.get("quote") or {}
                if observed.get("quotePermissionVerified") is True and candidate.get("code") == "US.AAPL":
                    known = candidate.get("price")
            for query in queries:
                row = markets[query.market]
                started = time.perf_counter()
                try:
                    if query.market == "US" and known is not None and query.session=='REGULAR':
                        price = known
                        row['session']='REGULAR'
                    else:
                        original, _ = await reader.read(policy, query, None)
                        facts, _, _ = decode(policy, query, original,observed_at=datetime.now(UTC))
                        fact = facts[-1] if facts else {}
                        price = float(fact["price"]) if fact.get("price") is not None else None
                        stamp = datetime.fromisoformat(fact["at"]) if fact.get("at") else None
                        if stamp is not None and (stamp.tzinfo is None or stamp > datetime.now(UTC)+timedelta(seconds=5)):
                            price = None
                        row["sourceTime"] = fact.get("at")
                        row['session']=fact.get('session')
                    if type(price) not in (int, float) or not math.isfinite(price) or price <= 0:
                        raise ValueError("quote_not_observed")
                    row.update(state="available", price=price, message="报价可用")
                except Exception as error:  # noqa: BLE001 -- Only fixed public categories leave the probe.
                    row.update(state="unavailable", **public_probe_failure(error))
                row.update(elapsedMs=round((time.perf_counter()-started)*1000), observedAt=datetime.now(UTC).isoformat())
    except TimeoutError:
        result.update(reason='source_timeout',message='检测超时')
        for row in markets.values():
            if row["state"] == "unknown": row.update(reason='source_timeout',message="检测超时，结果未确认")
    except Exception as error:  # noqa: BLE001 -- Preserve completed market results only.
        result.update(public_probe_failure(error))
    finally:
        if private_transport is not None:
            await private_transport.close()
    available = [row for row in markets.values() if row["state"] == "available"]
    if available:
        first = available[0]
        result.update(state="available" if len(available) == len(markets) else "partial",
                      message="报价可用" if len(available) == len(markets) else f"{len(available)}/{len(markets)} 个市场报价可用",
                      price=first["price"],code=first["code"],market=first["market"])
        if first.get('session'):result['session']=first['session']
    elif markets and all(row.get('reason') == next(iter(markets.values())).get('reason') for row in markets.values()):
        first=next(iter(markets.values()))
        if first.get('reason') and result.get('reason') != 'source_timeout':
            result.update(reason=first['reason'],message=first['message'])
    return result


def retained_futu(authority, policy, value, previous=None):
    """An AAPL-only connection check cannot erase another market's observation."""
    previous = previous or {}
    markets = {query.market: {"market":query.market,"code":query.code,"state":"unknown","message":"尚未检测"}
               for query in market_queries(authority, policy)}
    for market, row in (previous.get("markets") or {}).items():
        if market in markets:
            markets[market] = row
    verified = value.get("quotePermissionVerified") is True
    quote = value.get("quote") or {}
    price = quote.get("price")
    verified = verified and quote.get("code") == "US.AAPL" and type(price) in (int,float) and math.isfinite(price) and price > 0
    if "US" in markets:
        markets["US"] = {"market":"US","code":"AAPL","state":"available" if verified else "unavailable",
                         "observedAt":value.get("observedAt"), **({"price":price} if verified else {"message":"未取得该市场报价"})}
    available = [row for row in markets.values() if row["state"] == "available"]
    state = ("available" if len(available) == len(markets) else "partial") if available else "connected" if value.get("ok") else "unknown" if value.get("state") == "unknown" else "unavailable"
    return {**value,"state":state,"markets":markets,
            **({"price":price,"code":"AAPL","market":"US"} if verified else {})}


async def selection(authority, conn, who, provider):
    installed = tuple(authority.policy_provider()) if authority.policy_provider else authority.policies
    fingerprints = [policy.fingerprint for policy in installed if policy.owner_id == who.id and policy.source == provider]
    if not fingerprints:
        return None
    rows = await (await conn.execute("SELECT revision FROM market_source_configs WHERE owner_id=%s AND policy_fingerprint=ANY(%s) ORDER BY revision LIMIT 1001", (who.id, fingerprints))).fetchall()
    if len(rows) > 1000:
        raise HTTPException(503, "当前来源版本超过核对范围")
    choices = []
    for row in rows:
        try:
            _, policy = await authority.config(conn, who.id, row["revision"])
            if policy.source != provider:
                continue
            queries = market_queries(authority, policy)
            if queries: choices.append((row["revision"], policy, queries[0]))
        except HTTPException:
            continue
    return choices[0] if len(choices) == 1 else None


def mount(app, settings, authority, transport, member):
    db = authority.db

    async def administrator(request):
        assert_native_origin(request, settings)
        who = await member(request)
        if who.role != "admin":
            raise HTTPException(403, "需要管理员权限")
        return who

    @app.post('/api/fire/market-sources/setup')
    async def configure_sources(request: Request):
        who=await administrator(request)
        if not await app.state.rate_limit(db,'market-source-setup:'+who.id,5,window_seconds=60):raise HTTPException(429,'接入请求过于频繁',headers={'Retry-After':'60'})
        raw=await body(request,('requestId',))
        if set(raw)!={'requestId'}:raise HTTPException(400,'行情设置字段无效')
        try:rid=UUID(str(raw['requestId']))
        except (ValueError,TypeError):raise HTTPException(400,'请求编号无效') from None
        from .market_source_setup import setup
        from fastapi.responses import JSONResponse
        return JSONResponse(await setup(db,authority,who,rid),headers={'Cache-Control':'private, no-store'})

    @app.get("/api/fire/market-sources/tests")
    async def retained(request: Request):
        who = await administrator(request)
        results = {}
        async with db.connection() as conn, conn.transaction():
            await lock_mutation_identity(conn, who)
            for provider in PROVIDERS:
                selected = await selection(authority, conn, who, provider)
                row = await (await conn.execute("SELECT * FROM market_source_tests WHERE owner_id=%s AND provider=%s ORDER BY created_at DESC,request_id DESC LIMIT 1", (who.id, provider))).fetchone()
                matches = selected and row and row["source_revision"] == selected[0] and row["policy_fingerprint"] == selected[1].fingerprint
                if provider == "futu" and selected:
                    legacy = await (await conn.execute("SELECT coalesce(o.result,a.result) AS result,a.created_at FROM market_diagnostic_admissions a LEFT JOIN market_data_operations o ON o.owner_id=a.owner_id AND o.request_id=a.request_id WHERE a.owner_id=%s AND a.source_revision=%s AND a.action='futu.test' ORDER BY a.created_at DESC,a.request_id DESC LIMIT 1", (who.id, selected[0]))).fetchone()
                    if legacy and (not row or legacy["created_at"] > row["created_at"]):
                        results[provider] = retained_futu(authority,selected[1],legacy["result"],row["result"] if matches else None)
                        continue
                results[provider] = (row["result"] or {"state": "unknown", "requestId": str(row["request_id"]), "message": "上次检测结果尚未确认"}) if matches else {"state": "untested" if selected else "unconfigured"}
        from fastapi.responses import JSONResponse
        return JSONResponse({"results": results}, headers={"Cache-Control": "private, no-store"})

    @app.post("/api/fire/market-sources/tests")
    async def probe(request: Request):
        who = await administrator(request)
        raw = await body(request, ("provider", "requestId"))
        if set(raw) != {"provider", "requestId"} or raw.get("provider") not in PROVIDERS:
            raise HTTPException(400, "行情源检测参数无效")
        try:
            identifier = UUID(raw["requestId"])
        except (ValueError, TypeError, AttributeError):
            raise HTTPException(400, "检测编号无效") from None
        provider = raw["provider"]
        if not await app.state.rate_limit(db, "market-source-tests:" + who.id, 12, window_seconds=60):
            raise HTTPException(429, "检测过于频繁，请稍后再试")
        async with db.connection() as conn, conn.transaction():
            await authority.owner_lock(conn, who)
            await lock_mutation_identity(conn, who)
            previous = await (await conn.execute("SELECT * FROM market_source_tests WHERE owner_id=%s AND request_id=%s", (who.id, identifier))).fetchone()
            if previous:
                if previous["provider"] != provider:
                    raise HTTPException(409, "检测编号已用于其他来源")
                if previous["source_revision"]:
                    await authority.config(conn, who.id, previous["source_revision"])
                return previous["result"] or {"requestId": str(identifier), "state": "unknown", "message": "检测结果尚未确认"}
            if await external_delivery_blocked(conn):
                raise HTTPException(503, "实例处于恢复隔离，未执行外部检测")
            selected = await selection(authority, conn, who, provider)
            final = {"requestId": str(identifier), "state": "unconfigured", "message": "尚无唯一已配置的可用行情来源", "observedAt": datetime.now(UTC).isoformat()}
            await conn.execute("INSERT INTO market_source_tests(owner_id,request_id,provider,source_revision,policy_fingerprint,result) VALUES(%s,%s,%s,%s,%s,%s)", (who.id, identifier, provider, selected[0] if selected else None, selected[1].fingerprint if selected else None, None if selected else Jsonb(final)))
            if not selected:
                return final
        revision, policy, query = selected
        start = time.perf_counter()
        result = {"requestId": str(identifier), **await probe_markets(authority, transport, policy)}
        result.update(elapsedMs=round((time.perf_counter() - start) * 1000), observedAt=datetime.now(UTC).isoformat())
        async with db.connection() as conn, conn.transaction():
            await lock_mutation_identity(conn, who)
            _, current = await authority.config(conn, who.id, revision)
            if current.fingerprint != policy.fingerprint:
                raise HTTPException(403, "来源配置已变化，请重新检测")
            await conn.execute("UPDATE market_source_tests SET result=%s WHERE owner_id=%s AND request_id=%s AND result IS NULL", (Jsonb(result), who.id, identifier))
        return result
