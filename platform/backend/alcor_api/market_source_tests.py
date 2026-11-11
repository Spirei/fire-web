"""Explicit administrator quote probes over current approved targets only."""
import asyncio
import math
import time
from datetime import UTC, datetime
from uuid import UUID

from fastapi import HTTPException, Request
from psycopg.types.json import Jsonb

from .fx_reference import external_delivery_blocked
from .legacy_identity import assert_native_origin, body
from .market_contract import Query
from .market_worker import decode
from .security import lock_mutation_identity

PROVIDERS = ("futu", "tencent", "eastmoney", "yahoo")


async def selection(authority, conn, who, provider):
    rows = await (await conn.execute("SELECT revision FROM market_source_configs WHERE owner_id=%s ORDER BY revision", (who.id,))).fetchall()
    choices = []
    for row in rows:
        try:
            _, policy = await authority.config(conn, who.id, row["revision"])
            if policy.source != provider:
                continue
            for market, code in (("US", "AAPL"), ("HK", "00700"), ("CN", "600519")):
                query = Query("latest", market, code)
                try:
                    authority.validate_query(policy, query)
                except HTTPException:
                    continue
                choices.append((row["revision"], policy, query))
                break
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

    @app.get("/api/fire/market-sources/tests")
    async def retained(request: Request):
        who = await administrator(request)
        results = {}
        async with db.connection() as conn, conn.transaction():
            await lock_mutation_identity(conn, who)
            for provider in PROVIDERS:
                selected = await selection(authority, conn, who, provider)
                row = await (await conn.execute("SELECT * FROM market_source_tests WHERE owner_id=%s AND provider=%s ORDER BY created_at DESC,request_id DESC LIMIT 1", (who.id, provider))).fetchone()
                if provider == "futu" and selected:
                    legacy = await (await conn.execute("SELECT coalesce(o.result,a.result) AS result,a.created_at FROM market_diagnostic_admissions a LEFT JOIN market_data_operations o ON o.owner_id=a.owner_id AND o.request_id=a.request_id WHERE a.owner_id=%s AND a.source_revision=%s AND a.action='futu.test' ORDER BY a.created_at DESC,a.request_id DESC LIMIT 1", (who.id, selected[0]))).fetchone()
                    if legacy and (not row or legacy["created_at"] > row["created_at"]):
                        value = legacy["result"]
                        verified = value.get("quotePermissionVerified") is True
                        results[provider] = {**value, "state": "available" if verified else "connected" if value.get("ok") else "unknown" if value.get("state") == "unknown" else "unavailable", **({"price":value["quote"]["price"],"code":"AAPL","market":"US"} if verified and value.get("quote") else {})}
                        continue
                matches = selected and row and row["source_revision"] == selected[0] and row["policy_fingerprint"] == selected[1].fingerprint
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
        result = {"requestId": str(identifier), "state": "unavailable", "message": "未取得有效报价"}
        try:
            async with asyncio.timeout(18):
                if provider == "futu":
                    observed = await transport.diagnostic(policy, "futu.test")
                    quote = observed.get("quote") or {}
                    price = quote.get("price") if quote.get("code") == "US.AAPL" and observed.get("quotePermissionVerified") is True else None
                    query = Query("latest", "US", "AAPL")
                    if price is None and observed.get("responded") is True and observed.get("qotLogined") is True:
                        result.update(state="connected", message="OpenD 已连接，报价暂不可用")
                else:
                    original, _ = await transport.read(policy, query, None)
                    facts, _, _ = decode(policy, query, original)
                    fact = facts[-1] if facts else {}
                    price = float(fact["price"]) if fact.get("price") is not None else None
                    result["sourceTime"] = fact.get("at")
                if type(price) in (int, float) and math.isfinite(price) and price > 0:
                    result.update(state="available", message="报价可用", price=price, code=query.code, market=query.market)
        except TimeoutError:
            result["message"] = "检测超时"
        except Exception:  # noqa: BLE001 -- Provider details may contain private connection data.
            result["message"] = "连接或报价不可用"
        result.update(elapsedMs=round((time.perf_counter() - start) * 1000), observedAt=datetime.now(UTC).isoformat())
        async with db.connection() as conn, conn.transaction():
            await lock_mutation_identity(conn, who)
            _, current = await authority.config(conn, who.id, revision)
            if current.fingerprint != policy.fingerprint:
                raise HTTPException(403, "来源配置已变化，请重新检测")
            await conn.execute("UPDATE market_source_tests SET result=%s WHERE owner_id=%s AND request_id=%s AND result IS NULL", (Jsonb(result), who.id, identifier))
        return result
