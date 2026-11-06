"""Mountable compatibility reference routes using existing platform identity helpers."""

from uuid import UUID

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse

from .fx_service import ManagedFx
from .legacy_identity import assert_native_origin, body, native_identity, web_identity


def mount_rates(app, settings, db, *, worker=None, wait_timeout=15):
    service = worker or ManagedFx(db)

    async def authorize(request, version):
        assert_native_origin(request, settings)
        if version is None:
            who = (await web_identity(request, db))[0]
            return "user:" + who.id, who
        authorization = request.headers.get("authorization")
        if authorization is not None:
            if (
                version == 1
                and authorization.startswith("Bearer ")
                and not authorization.startswith("Bearer fat_")
            ):
                if not authorization.removeprefix("Bearer "):
                    raise HTTPException(401, "需要有效会话")
                who = (await web_identity(request, db, allow_v1_bearer=True))[0]
            else:
                who = (await native_identity(request, db))[0]
            return "user:" + who.id, who
        return "public:" + str(request.client.host if request.client else "unknown"), None

    async def read(request, version):
        # A legacy refresh query is a read intent on the new platform. Only an
        # explicit authenticated POST may reserve quota and enqueue the Worker.
        from .legacy_rates_read import read_snapshot
        return await read_snapshot(request, version, settings, db, service)

    @app.get("/api/rates")
    async def web(request: Request):
        return await read(request, None)

    @app.get("/api/v{version}/rates")
    async def native(version: int, request: Request):
        if version not in (1, 2):
            raise HTTPException(404, "接口不存在")
        return await read(request, version)

    @app.get("/api/reference/rates/operations/{request_id}")
    async def receipt(request_id: str, request: Request):
        from .security import COOKIE, identity

        if request.cookies.get(COOKIE):
            principal = "user:" + (await identity(request)).id
        else:
            principal, _ = await authorize(request, 2)
        return await service.receipt(principal, request_id)

    @app.get("/api/reference/rates/provider")
    async def config(request: Request):
        from .security import administrator

        await administrator(request)
        async with db.connection() as conn:
            return await (
                await conn.execute(
                    "SELECT c.enabled,c.daily_budget,c.revision,p.config AS custom FROM fx_config c LEFT JOIN fx_provider_revisions p ON p.id=c.provider_revision WHERE singleton=true"
                )
            ).fetchone()

    @app.put("/api/reference/rates/provider")
    async def configure(request: Request):
        from .security import administrator

        who = await administrator(request)
        data = await body(request, ("enabled", "dailyBudget", "revision", "custom"))
        if set(data) not in (
            {"enabled", "dailyBudget", "revision"},
            {"enabled", "dailyBudget", "revision", "custom"},
        ):
            raise HTTPException(400, "配置参数无效")
        try:
            return {
                "revision": await service.configure(
                    who, data["enabled"], data["dailyBudget"], data["revision"], data.get("custom")
                )
            }
        except (ValueError, KeyError, TypeError, TimeoutError, OSError) as exc:
            messages = {
                "approval_addresses_invalid": "请填写并确认自定义接口的服务器 IP",
                "approval_invalid": "请确认自定义接口地址和服务器 IP",
                "url_invalid": "请输入完整有效的汇率接口地址",
                "base_invalid": "基准币种须为三个大写字母，如 USD",
                "time_field_invalid": "来源时间字段格式无效，请核对响应格式设置",
                "time_precision_invalid": "请选择有效的来源时间精度",
                "source_time_policy_invalid": "设置时间字段后须选择对应的时间精度",
                "schedule_invalid": "定时更新时间格式无效",
                "timezone_invalid": "定时更新的时区无效",
                "timezone_required": "定时更新需要填写时区",
            }
            raise HTTPException(400, messages.get(str(exc), "接口设置未通过校验，请核对自定义接口及高级设置")) from None

    from .admin_verification import VerificationInput, verify_admin_access

    @app.post("/api/reference/rates/provider/reauthenticate", status_code=204)
    async def reauthenticate(data: VerificationInput, request: Request):
        from .security import administrator

        who = await administrator(request)
        return await verify_admin_access(data, request, who, "reference")

    @app.get("/api/reference/rates")
    async def canonical_rates(request: Request, observationId: UUID | None = None):
        from .security import identity

        await identity(request)
        value = await service.snapshot(observationId, exact=True)
        status = await service.status()
        return {**value, **status, "refreshEnabled": status["enabled"] and not status["quarantined"],
                "refreshMethod": "POST", "refreshPath": "/api/reference/rates/refresh", "automaticRefreshOnRead": False}

    @app.post("/api/reference/rates/refresh", status_code=202)
    async def canonical_refresh(request: Request):
        from .security import identity

        who = await identity(request)
        data = await body(request, ("requestId",))
        if set(data) != {"requestId"}:
            raise HTTPException(400, "刷新参数无效")
        try:
            identifier = str(UUID(data["requestId"]))
        except (ValueError, TypeError, AttributeError):
            raise HTTPException(400, "requestId 无效") from None
        if identifier != data["requestId"]:
            raise HTTPException(400, "requestId 无效")
        await service.submit("user:" + who.id, identifier, who.id, authorization=who)
        return {"requestId": identifier, **await service.receipt("user:" + who.id, identifier)}

    @app.get("/api/reference/rates/observations")
    async def observations(request: Request):
        from .security import identity
        await identity(request)
        if set(request.query_params)-{"limit","before"} or any(len(request.query_params.getlist(key))!=1 for key in request.query_params):
            raise HTTPException(400,"汇率历史参数无效")
        limit=request.query_params.get("limit","25")
        if not limit.isascii() or not limit.isdecimal() or len(limit)>3 or not 1<=int(limit)<=100:
            raise HTTPException(400,"汇率历史分页无效")
        return JSONResponse(await service.observations(limit=int(limit),before=request.query_params.get("before")),
                            headers={"Cache-Control":"private, no-store","Vary":"Cookie"})

    @app.get("/api/reference/rates/observations/{observation_id}/original")
    async def original(observation_id: UUID, request: Request):
        from fastapi.responses import Response

        from .security import administrator
        if request.query_params:raise HTTPException(400,"不支持查询参数")
        who=await administrator(request)
        raw,sha=await service.original(who,observation_id)
        return Response(raw,media_type="application/json",headers={"Cache-Control":"private, no-store","Vary":"Cookie",
            "Content-Disposition":'attachment; filename="fx-observation.json"',"X-Content-Type-Options":"nosniff","X-Alcor-Source-SHA256":sha})

    from .fx_response_originals import mount_fx_response_originals
    mount_fx_response_originals(app,db)
    return service
