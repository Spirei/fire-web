"""Canonical /api entry with explicit old v1/v2 native protocol adapters."""

from uuid import UUID

from fastapi import HTTPException, Request, Response
from fastapi.responses import JSONResponse

from .legacy_identity import assert_native_origin, body, envelope, native_identity, native_version
from .legacy_optional_credentials import credentials_present
from .native_app_auth import CLIENT
from .price_alert_contract import visible
from .security import identity


def filtered(value, negotiated):
    result = dict(value)
    if "snapshot" in result:
        result["snapshot"] = filtered(result["snapshot"], negotiated)
    if "channels" in result:
        result["channels"] = [row for row in result["channels"] if row["channel"] in visible(negotiated)]
    return result


def mount(app, service):
    app.state.price_alert_candidate = service

    async def budget(request, who, category="price-alerts"):
        from .security import digest

        write = request.method != "GET"
        admit = app.state.rate_limit if write else app.state.read_rate_limit
        if not await admit(
            service.db,
            digest(category + (":write:" if write else ":read:") + who.id),
            60 if write else 180,
            window_seconds=60,
        ):
            raise HTTPException(429, "请求过于频繁，请稍后再试")

    async def perform(request, action, request_id=None, legacy=False):
        credentials_present(request, platform=not legacy)
        if request.url.query:
            raise HTTPException(400, "不支持查询参数")
        if legacy:
            native_version(request)
            assert_native_origin(request, service.db.settings)
        if legacy or request.headers.get("authorization") is not None:
            import re
            if not re.fullmatch(r'Bearer fat_[A-Za-z0-9_-]{43}', request.headers.get('authorization','')):
                raise HTTPException(401, '需要有效的 App 连接')
            assert_native_origin(request, service.db.settings)
            who, grant = await native_identity(
                request, service.db, "portfolio.read" if request.method == "GET" else "portfolio.write"
            )
            if grant["client_id"]!=CLIENT:raise HTTPException(401,"客户端连接已变化")
        else:
            who = await identity(request)
        await budget(request, who)
        negotiated = request.headers.get("x-alcor-price-alerts")
        if action == "snapshot":
            return filtered(await service.snapshot(who), negotiated)
        if action == "operation" and request.method == "GET":
            return filtered(await service.operation(who, request_id), negotiated)
        raw = await body(
            request,
            (
                "action",
                "ruleId",
                "revision",
                "rule",
                "state",
                "channel",
                "enabled",
                "eventIds",
                "allThrough",
                "recipient",
                "verificationCode",
                "challengeId",
            ),
            limit=16384,
        )
        if action == "telegram":
            if raw:
                raise HTTPException(400, "绑定请求无效")
            return await service.bindings.begin_telegram(
                who, request.headers.get("x-alcor-notification-proof")
            )
        return filtered(
            await service.mutate(
                who, request_id, raw, negotiated, request.headers.get("x-alcor-notification-proof"), legacy=legacy
            ),
            negotiated,
        )

    async def owner(request):
        credentials_present(request, platform=True)
        if "authorization" in request.headers:
            assert_native_origin(request, service.db.settings)
            who,grant = await native_identity(
                request, service.db, "portfolio.read" if request.method == "GET" else "portfolio.write"
            )
            if grant["client_id"]!=CLIENT:raise HTTPException(401,"客户端连接已变化")
        else:
            who = await identity(request)
        await budget(request, who, "business-notifications")
        return who

    @app.post("/api/notifications/security/verify")
    async def verify_notification_security(request: Request):
        who = await owner(request)
        from .security import digest

        if not await app.state.rate_limit(service.db, digest("notification-security:" + who.id), 20):
            raise HTTPException(429, "确认过于频繁，请稍后再试")
        raw = await body(request, ("operation", "currentPassword", "code"), limit=16384)
        return await service.providers.security.verify(who, raw)

    @app.post("/api/notifications/providers")
    async def configure_notification_provider(request: Request):
        who = await owner(request)
        raw = await body(
            request, ("requestId", "channel", "targetId", "expectedRevision", "credentials"), limit=16384
        )
        return await service.providers.configure(who, raw, request.headers.get("x-alcor-notification-proof"))

    @app.post("/api/notifications/providers/{revision}/test")
    async def test_notification_provider(revision: str, request: Request):
        who = await owner(request)
        raw = await body(request, ("requestId",), limit=1024)
        return await service.providers.test(who, revision, raw.get("requestId"))

    @app.post("/api/notifications/providers/{revision}/revoke")
    async def revoke_notification_provider(revision: str, request: Request):
        who = await owner(request)
        raw = await body(request, ("requestId",), limit=1024)
        return await service.providers.revoke(
            who, revision, raw.get("requestId"), request.headers.get("x-alcor-notification-proof")
        )

    @app.get("/api/notifications/providers")
    async def notification_providers(request: Request):
        who = await owner(request)
        async with service.db.connection() as conn, conn.transaction():
            await conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
            await service.authorize_read(conn, who)
            result = []
            for channel in ("email", "telegram", "wechat", "feishu", "discord", "qq"):
                row = await service.providers.latest(conn, who.id, channel)
                current = await service.providers.current(conn, who.id, channel)
                state = await service.bindings.state(conn, who.id, channel)
                result.append(
                    {
                        "channel": channel,
                        "revision": str(row["revision"]) if row else None,
                        "active": current is not None,
                        **state,
                    }
                )
            return {"providers": result}

    @app.get("/api/notifications/deliveries/{delivery_id}")
    async def notification_delivery(delivery_id: UUID, request: Request):
        who = await owner(request)
        async with service.db.connection() as conn, conn.transaction():
            await conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
            await service.authorize_read(conn, who)
            row = await (
                await conn.execute(
                    """SELECT d.*,e.kind FROM business_notification_deliveries d JOIN business_notification_events e
                ON e.owner_id=d.owner_id AND e.id=d.event_id WHERE d.owner_id=%s AND d.id=%s""",
                    (who.id, delivery_id),
                )
            ).fetchone()
            if row is None:
                raise HTTPException(404, "原通知回执不存在")
            if getattr(who, "native_client", False) and row["kind"] not in {
                "price.alert",
                "price.alert.test",
                "notification.binding",
            }:
                raise HTTPException(403, "当前连接未获此业务通知权限")
            return {
                "id": str(row["id"]),
                "eventId": str(row["event_id"]),
                "channel": row["channel"],
                "state": row["state"],
                "receipt": row["receipt"],
                "updatedAt": row["updated_at"].isoformat(),
                "willRetryAutomatically": False,
            }

    @app.get("/api/price-alerts")
    async def canonical_snapshot(request: Request):
        return JSONResponse(await perform(request, "snapshot"), headers={'Cache-Control':'no-store, private','Vary':'Cookie, Authorization, X-Alcor-Price-Alerts'})

    @app.get("/api/price-alerts/operations/{request_id}")
    async def canonical_receipt(request_id: str, request: Request):
        return JSONResponse(await perform(request, "operation", request_id), headers={'Cache-Control':'no-store, private','Vary':'Cookie, Authorization, X-Alcor-Price-Alerts'})

    @app.post("/api/price-alerts/operations/{request_id}")
    async def canonical_mutation(request_id: str, request: Request):
        return JSONResponse(await perform(request, "operation", request_id), headers={'Cache-Control':'no-store, private','Vary':'Cookie, Authorization, X-Alcor-Price-Alerts'})

    @app.post("/api/price-alerts/telegram-link")
    async def canonical_telegram(request: Request):
        return await perform(request, "telegram")

    async def old(request, response, action, request_id=None):
        try:
            value = await perform(request, action, request_id, legacy=True)
            response.headers.update({'Cache-Control':'no-store, private','Vary':'Cookie, Authorization, X-Alcor-Price-Alerts'})
            return envelope(value, request, response)
        except HTTPException as exc:
            status = 409 if exc.status_code == 428 else exc.status_code
            return JSONResponse(
                {
                    "code": getattr(exc, "business_code", status * 100 + 1),
                    "message": str(exc.detail),
                },
                status_code=status,
                headers={'Cache-Control':'no-store, private','Vary':'Cookie, Authorization, X-Alcor-Price-Alerts',
                         **(exc.headers or {}),
                         **({'X-Alcor-Retire-Context':'true'} if status in (401,403) else {})},
            )

    @app.get("/api/v1/price-alerts")
    @app.get("/api/v2/price-alerts")
    async def old_snapshot(request: Request, response: Response):
        return await old(request, response, "snapshot")

    @app.get("/api/v1/price-alerts/operations/{request_id}")
    @app.get("/api/v2/price-alerts/operations/{request_id}")
    async def old_receipt(request_id: str, request: Request, response: Response):
        return await old(request, response, "operation", request_id)

    @app.post("/api/v1/price-alerts/operations/{request_id}")
    @app.post("/api/v2/price-alerts/operations/{request_id}")
    async def old_mutation(request_id: str, request: Request, response: Response):
        return await old(request, response, "operation", request_id)
