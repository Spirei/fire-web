"""Fixed approved target only; no port scan, arbitrary URL, subscription or trading mutation."""

import json
import math
import re
import time
from datetime import UTC, datetime
from uuid import UUID, uuid4

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from psycopg.types.json import Jsonb

from .card_preferences import JS_WHITESPACE, js_text
from .fx_provider_parser import unique
from .fx_reference import external_delivery_blocked
from .legacy_identity import OLD_COOKIE, WEB_COOKIE, assert_native_origin, web_identity
from .market_contract import digest as operation_digest
from .profile_http import bounded_body
from .security import administrator, lock_mutation_identity


def quota_projection(value):
    subscription, history = value.get("subscription", {}), value.get("historyKl", {})
    subscription = subscription if isinstance(subscription, dict) else {}
    history = history if isinstance(history, dict) else {}

    def counter(data, key):
        raw = data.get(key)
        return raw if type(raw) is int and raw >= 0 else None

    sub = {
        "totalUsed": counter(subscription, "total_used"),
        "remain": counter(subscription, "remain"),
        "ownUsed": counter(subscription, "own_used"),
        "totalQuota": None,
        "ownTotalQuota": None,
    }
    historical = {
        "used": counter(history, "used_quota"),
        "remain": counter(history, "remain_quota"),
        "totalQuota": None,
    }
    has_sub = any(sub[key] is not None for key in ("totalUsed", "remain", "ownUsed"))
    has_history = any(historical[key] is not None for key in ("used", "remain"))
    if not has_sub and not has_history:
        return None
    return {
        "subscription": sub if has_sub else None,
        "historyKl": historical if has_history else None,
        "rawSubscription": {
            key: counter(subscription, key)
            for key in ("total_used", "remain", "own_used")
            if counter(subscription, key) is not None
        },
        "rawHistoryKl": {
            key: counter(history, key)
            for key in ("used_quota", "remain_quota")
            if counter(history, key) is not None
        },
        "subscriptionScope": "current_temporary_quote_connection",
        "totalsKnown": False,
        "detailsRequested": False,
    }


def mount_legacy_futu_diagnostics(app, settings, authority, transport):
    db = authority.db

    async def member(request):
        authorization = request.headers.get("authorization")
        if authorization is not None:
            if not re.fullmatch(r"Bearer [a-fA-F0-9]{64}\s*", authorization):
                raise HTTPException(401, "请使用管理员网页登录会话")
            who = (await web_identity(request, db, allow_legacy_bearer=True, web_bearer_only=True))[0]
        elif not request.headers.get("x-csrf-token") and (
            request.cookies.get(WEB_COOKIE) or request.cookies.get(OLD_COOKIE)
        ):
            who = (await web_identity(request, db))[0]
        else:
            who = await administrator(request)
        if who.role != "admin":
            raise HTTPException(403, "需要管理员权限")
        return who

    async def select(conn, who, action, selector):
        if selector is not None:
            try:
                revision = UUID(str(selector))
            except (ValueError, TypeError, AttributeError) as exc:
                raise HTTPException(400, "行情来源版本无效") from exc
            candidates = [{"revision": revision}]
        else:
            candidates = await (
                await conn.execute(
                    "SELECT revision FROM market_source_configs WHERE owner_id=%s ORDER BY revision LIMIT 1001",
                    (who.id,),
                )
            ).fetchall()
            if len(candidates) > 1000:
                raise HTTPException(503, "来源记录超过核对范围")
        choices = []
        for row in candidates:
            try:
                _, policy = await authority.config(conn, who.id, row["revision"])
            except HTTPException:
                if selector is not None:
                    raise HTTPException(403, "当前来源许可不可用") from None
                continue
            if (
                policy.source != "futu"
                or policy.source_version != "futu-sdk-records-v1"
                or action not in policy.purposes
            ):
                if selector is not None:
                    raise HTTPException(403, "本人来源未明确许可该检查用途")
                continue
            choices.append((row["revision"], policy))
        if not choices:
            raise HTTPException(503, "请先保存 OpenD 连接设置")
        if len(choices) != 1:
            raise HTTPException(409, "存在多个许可来源，请明确选择来源版本")
        revision, policy = choices[0]
        targets = (
            {target.id: target for target in transport.target_provider()}
            if transport.target_provider
            else transport.targets
        )
        target = targets.get(policy.target_id)
        if not target or target.source != "futu" or target.fingerprint != policy.target_fingerprint:
            raise HTTPException(503, "已许可的固定目标当前不可用")
        target.validate(settings.environment)
        return revision, policy, target

    async def execute(request, action):
        headers = {"Cache-Control": "private, no-store", "Vary": "Cookie, Authorization"}
        try:
            assert_native_origin(request, settings)
            who = await member(request)
            raw_body = await bounded_body(request, 4096)
            if not raw_body.strip():
                raise HTTPException(400, "请提交明确的检查参数对象")
            try:
                body = json.loads(raw_body, object_pairs_hook=unique, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
            except (ValueError, UnicodeError, RecursionError) as exc:
                raise HTTPException(400, "检查参数JSON无效，未执行检查") from exc
            if not isinstance(body, dict) or set(body) - {"host", "port", "sourceRevision", "requestId"}:
                raise HTTPException(400, "检查参数无效，只能核对已批准目标")
            raw_id = body.get("requestId")
            try:
                identifier = UUID(str(raw_id)) if raw_id is not None else uuid4()
            except (ValueError, TypeError, AttributeError) as exc:
                raise HTTPException(400, "原请求编号无效") from exc
            headers["X-Alcor-Request-Id"] = str(identifier)
            selector = request.headers.get("x-alcor-market-source") or body.get("sourceRevision")
            if (
                request.headers.get("x-alcor-market-source")
                and body.get("sourceRevision")
                and request.headers["x-alcor-market-source"] != body["sourceRevision"]
            ):
                raise HTTPException(400, "来源版本不一致")
            operation = {
                "action": action,
                "body": {key: value for key, value in body.items() if key != "requestId"},
                "sourceSelector": selector,
            }
            if not await app.state.rate_limit(
                db, "futu-diagnostic:" + who.id, 10, window_seconds=60
            ) or not await app.state.rate_limit(db, "futu-diagnostic-global", 30, window_seconds=60):
                raise HTTPException(429, "检查过于频繁，请稍后重试")
            async with db.connection() as conn, conn.transaction():
                await authority.owner_lock(conn, who)
                await lock_mutation_identity(conn, who, require_admin=True)
                if getattr(who, "legacy_client", False):
                    web = await (
                        await conn.execute(
                            "SELECT 1 FROM sessions WHERE token_hash=%s AND user_id=%s AND client_id='legacy-web'",
                            (who.token_hash, who.id),
                        )
                    ).fetchone()
                    if not web:
                        raise HTTPException(403, "此客户端没有管理检查权限")
                await conn.execute(
                    "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))",
                    ("market-diagnostic:" + who.id + ":" + str(identifier),),
                )
                if prior := await authority.receipt(conn, who.id, identifier, operation):
                    return JSONResponse(prior, headers=headers)
                if await external_delivery_blocked(conn):
                    raise HTTPException(503, "实例处于恢复隔离，未执行外部检查")
                revision, policy, target = await select(conn, who, action, selector)
                supplied_host = body.get("host")
                if supplied_host not in (None, "") and (
                    not isinstance(supplied_host, str)
                    or supplied_host.strip(JS_WHITESPACE).lower()
                    not in {target.host.lower(), *(address.lower() for address in target.addresses)}
                ):
                    raise HTTPException(403, "指定目标不匹配本人已批准来源，未执行探测")
                if body.get("port") not in (None, ""):
                    text = js_text(body["port"])
                    if not re.fullmatch(r"[0-9]{1,5}", text) or not 1 <= int(text) <= 65535:
                        raise HTTPException(400, "端口不合法")
                    if int(text) != target.port:
                        raise HTTPException(403, "指定端口不匹配已批准来源，未执行探测")
                admitted = {
                    "requestId": str(identifier), "legacyRequestIdGenerated": raw_id is None,
                    "legacyClientIdempotency": raw_id is not None, "receiptId": str(identifier),
                    "adminOnly": True, "kind": action, "sourceRevision": str(revision),
                    "state": "unknown", "externalRequestAdmitted": True, "automaticRetry": False,
                }
                await conn.execute(
                    "INSERT INTO market_diagnostic_admissions(owner_id,request_id,source_revision,action,fingerprint,result) VALUES(%s,%s,%s,%s,%s,%s)",
                    (who.id, identifier, revision, action, operation_digest(operation), Jsonb(admitted)),
                )
            started = time.perf_counter()
            try:
                observed = await transport.diagnostic(policy, action)
            except TimeoutError:
                observed = {"errorCode":"diagnostic_timeout"}
            except Exception:  # noqa: BLE001 -- Optional SDK failures contain no safe client-visible details.
                observed = {"errorCode":"sdk_or_connection_unavailable"}
            total_elapsed_ms = round((time.perf_counter() - started) * 1000)
            measured = observed.get("connectionElapsedMs")
            elapsed_ms = measured if type(measured) is int and 0 <= measured <= total_elapsed_ms else total_elapsed_ms
            async with db.connection() as conn, conn.transaction():
                await authority.owner_lock(conn, who)
                await lock_mutation_identity(conn, who, require_admin=True)
                try:
                    await authority.config(conn, who.id, revision)
                except HTTPException as exc:
                    raise HTTPException(403, "来源许可已变化，未展示检查结果") from exc
                result = {
                    "requestId": str(identifier),
                    "legacyRequestIdGenerated": raw_id is None,
                    "legacyClientIdempotency": raw_id is not None,
                    "receiptId": str(identifier),
                    "adminOnly": True,
                    "kind": action,
                    "sourceRevision": str(revision),
                    "licenseRevision": policy.license_revision,
                    "observedAt": datetime.now(UTC).isoformat(),
                    "observationRecorded": True,
                    "elapsedMs": elapsed_ms,
                    "totalElapsedMs": total_elapsed_ms,
                    "sdkStartupMs": observed.get("sdkStartupMs") if type(observed.get("sdkStartupMs")) is int else None,
                }
                if action == "futu.test":
                    logged = observed.get("qotLogined")
                    known = type(logged) is bool and observed.get("responded") is True
                    quote = observed.get("quote")
                    price = quote.get("price") if isinstance(quote, dict) and quote.get("code") == "US.AAPL" else None
                    verified = ("latest" in policy.purposes and "US" in policy.markets
                                and observed.get("quotePermissionVerified") is True
                                and type(price) in (int, float) and math.isfinite(price) and price > 0)
                    result.update(
                        {
                            "ok": known and logged,
                            "state": "available"
                            if known and logged
                            else "unavailable"
                            if known
                            else "unknown",
                            "message": (f"连接成功，AAPL 报价 {price}" if verified else "OpenD已响应且行情已登录，AAPL 报价暂不可用")
                            if known and logged
                            else "OpenD已响应，行情未登录"
                            if known
                            else "OpenD 检测超时，请检查连接与 SDK 响应"
                            if observed.get("errorCode") == "diagnostic_timeout"
                            else "SDK/OpenD状态未知或不可用",
                            "qotLogined": logged if known else None,
                            "quotePermissionVerified": bool(known and logged and verified),
                            "quote": {"code": "US.AAPL", "price": price} if known and logged and verified else None,
                            "testKind": "quote_snapshot" if known and logged and verified else "quote_context_status",
                        }
                    )
                else:
                    quota = quota_projection(observed)
                    result.update(
                        {
                            "ok": quota is not None,
                            "quota": quota,
                            "state": "unknown"
                            if quota is None
                            else "observed"
                            if quota["subscription"] and quota["historyKl"]
                            else "partial",
                        }
                    )
                await authority.save_receipt(conn, who.id, identifier, operation, result)
                await conn.execute(
                    "INSERT INTO audit_events(actor_id,action,request_id) VALUES(%s,%s,%s)",
                    (who.id, "market." + action, identifier),
                )
            headers["X-Alcor-Request-Id"] = str(identifier)
            return JSONResponse(result, headers=headers)
        except HTTPException as exc:
            if exc.status_code in (401, 403):
                headers["X-Alcor-Retire-Context"] = "true"
            return JSONResponse(
                {"error": str(exc.detail), "state": "unavailable"},
                status_code=exc.status_code,
                headers=headers,
            )
        except ValueError:
            return JSONResponse(
                {"error": "固定来源配置不可用", "state": "unknown"}, status_code=503, headers=headers
            )

    @app.get("/api/futu/test")
    async def last_test(request: Request):
        # Opening settings reads the retained result; it never probes OpenD.
        assert_native_origin(request, settings)
        who = await member(request)
        async with db.connection() as conn, conn.transaction():
            revision, _, target = await select(conn, who, "futu.test", None)
            await lock_mutation_identity(conn, who, require_admin=True)
            row = await (await conn.execute(
                "SELECT coalesce(o.result,a.result) AS result,a.created_at FROM market_diagnostic_admissions a "
                "LEFT JOIN market_data_operations o ON o.owner_id=a.owner_id AND o.request_id=a.request_id "
                "WHERE a.owner_id=%s AND a.source_revision=%s AND a.action='futu.test' "
                "ORDER BY a.created_at DESC,a.request_id DESC LIMIT 1", (who.id, revision),
            )).fetchone()
            checked = await (await conn.execute(
                "SELECT result,created_at FROM market_source_tests WHERE owner_id=%s AND provider='futu' AND source_revision=%s ORDER BY created_at DESC,request_id DESC LIMIT 1", (who.id, revision),
            )).fetchone()
            if checked and checked["result"] and (not row or checked["created_at"] > row["created_at"]):
                value = checked["result"]
                known = (value.get("markets") or {}).get("US") or {}
                if not known and value.get("market") == "US" and value.get("code") == "AAPL":
                    known = value
                price = known.get("price")
                quoted = known.get("state") in ("available","partial") and known.get("code") == "AAPL" and type(price) in (int,float) and math.isfinite(price) and price > 0
                row = {"result": {**value, "ok": value.get("connectionState") == "connected" or value["state"] in ("available", "partial", "connected"),
                                  **({"quotePermissionVerified":True,"quote":{"code":"US.AAPL","price":known["price"]}} if quoted else {})}}
        return JSONResponse({"host": target.host, "port": target.port, "lastTest": row["result"] if row else None},
                            headers={"Cache-Control": "private, no-store", "Vary": "Cookie, Authorization"})

    @app.post("/api/futu/test")
    async def test(request: Request):
        return await execute(request, "futu.test")

    @app.post("/api/futu/quota")
    async def quota(request: Request):
        return await execute(request, "futu.quota")
