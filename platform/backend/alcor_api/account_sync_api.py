"""Exact v2 sync envelopes over shared watch domain; missing signal sources are explicit."""

from uuid import UUID, uuid5

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse

from .account_signals import DOMAINS, AccountSignals
from .fee_state_sync import FeeStateSync
from .legacy_identity import assert_native_origin, native_identity
from .native_app_auth import CLIENT
from .profile_http import bounded_body
from .security import digest, identity
from .watch_state import WatchState


def discovery():
    """Installed protocol, not a connection or financial-source assertion."""
    return {"version": 1, "path": "/api/v2/account-sync", "state_path": "/api/v2/app-state",
        "operation_path": "/api/v2/app-state/operations/{requestId}", "namespaces": ["watch", "fees"],
        "domains": list(DOMAINS), "interval_seconds": 15, "patch_only": True,
        "automatic_mutation_replay": False}


def mount_account_sync(app, settings, db, rate_limit):
    service = WatchState(db)
    fees = FeeStateSync(db)
    app.state.watch_state = service

    async def execute(request, *, legacy=False, native=False, signal=False, identifier=None):
        headers = {"Cache-Control": "private, no-store", "Vary": "Authorization" if native else "Cookie"}
        if legacy:
            headers["X-Alcor-API-Version"] = "2"
        try:
            from .legacy_optional_credentials import credentials_present
            credentials_present(request, platform=not native)
            assert_native_origin(request, settings)
            if native:
                who, grant = await native_identity(request, db, "portfolio.write" if request.method == "POST" else "portfolio.read")
                if grant["client_id"] != CLIENT:
                    raise HTTPException(401, "连接已失效")
            else:
                if "authorization" in request.headers:
                    raise HTTPException(403, "请使用当前网页登录会话")
                who = await identity(request)
            if signal:
                if request.query_params:
                    raise HTTPException(400, "不支持查询参数")
                signals = await AccountSignals(db).read(who, legacy_watermarks=legacy)
                forbidden = [key for key, state in signals["domains"].items() if state["state"] == "forbidden"]
                unavailable = [key for key, state in signals["domains"].items() if state["state"] in ("unavailable", "partial")]
                if forbidden:
                    raise HTTPException(403, "旧同步协议所需变更信号权限不足：" + ",".join(forbidden))
                if unavailable:
                    raise HTTPException(503, "旧同步协议无法表达未知变更信号，待安装来源：" + ",".join(unavailable))
                # Opaque committed-row watermarks are not commit counts or
                # financial/data-domain permission. Completeness is independent.
                # The old DTO has no instanceId. Derive its UUID epoch from both persisted
                # generation and the actual PG instance, so a restored target invalidates it.
                epoch = str(uuid5(UUID(signals["epoch"]), "alcor-account-sync:" + signals["instanceId"]))
                result = {"version": 1, "userId": who.id, "epoch": epoch, "revisions": signals["revisions"]}
            elif identifier is not None:
                if request.query_params:
                    raise HTTPException(400, "不支持查询参数")
                try:
                    result = await service.receipt(who, identifier)
                except HTTPException as exc:
                    if exc.status_code!=404:raise
                    result = await fees.receipt(who,identifier)
            elif request.method == "GET":
                if list(request.query_params) != ["namespace"] or len(request.query_params.getlist("namespace")) != 1:
                    raise HTTPException(400, "同步类别无效")
                namespace = request.query_params["namespace"]
                if namespace == "fees":
                    from .fee_plans import FeePlans
                    result = await FeePlans(db).legacy_fields(who)
                elif namespace == "watch":
                    result = await service.read(who)
                else:
                    raise HTTPException(400, "同步类别无效")
            else:
                if request.query_params:
                    raise HTTPException(400, "不支持查询参数")
                if not await rate_limit(db, digest("app-state:" + who.id), 120, window_seconds=60):
                    raise HTTPException(429, "操作过于频繁")
                import json
                def reject_constant(_):
                    raise ValueError()
                try:
                    from .fx_provider_parser import unique
                    body = json.loads(await bounded_body(request, 1024 * 1024), parse_constant=reject_constant, object_pairs_hook=unique)
                except (ValueError, UnicodeError, RecursionError):
                    raise HTTPException(400, "同步修改无效") from None
                result = await (fees if isinstance(body,dict) and body.get('namespace')=='fees' else service).submit(who,body)
            return JSONResponse({"code": 0, "message": "ok", "data": result} if legacy else result, headers=headers)
        except HTTPException as exc:
            if exc.status_code in (401, 403):
                headers["X-Alcor-Retire-Context"] = "true"
            code = 50001 if exc.status_code >= 500 else exc.status_code * 100 + 1
            # A well-formed token that does not resolve is 40102. A missing token stays 40101.
            if legacy and exc.status_code == 401 and str(exc.detail) == "连接已失效，请重新连接":
                code = 40102
            return JSONResponse({"code": code, "message": str(exc.detail)} if legacy else {"error": {"code": code, "message": str(exc.detail)}}, status_code=exc.status_code, headers=headers)

    @app.get("/api/v2/account-sync")
    async def legacy_signals(request: Request):
        return await execute(request, legacy=True, native=True, signal=True)

    @app.get("/api/v2/app-state")
    @app.post("/api/v2/app-state")
    async def legacy_state(request: Request):
        return await execute(request, legacy=True, native=True)

    @app.get("/api/v2/app-state/operations/{requestId}")
    async def legacy_receipt(requestId: str, request: Request):
        return await execute(request, legacy=True, native=True, identifier=requestId)

    @app.get("/api/account/state")
    @app.post("/api/account/state")
    async def web_state(request: Request):
        return await execute(request)

    @app.get("/api/account/state/operations/{requestId}")
    async def web_receipt(requestId: str, request: Request):
        return await execute(request, identifier=requestId)

    @app.get("/api/client/account/state")
    @app.post("/api/client/account/state")
    async def client_state(request: Request):
        return await execute(request, native=True)

    @app.get("/api/client/account/state/operations/{requestId}")
    async def client_receipt(requestId: str, request: Request):
        return await execute(request, native=True, identifier=requestId)
