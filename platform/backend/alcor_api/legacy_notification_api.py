"""Owner-scoped social channels and durable explicit Telegram link operations."""

import re
from uuid import UUID

from fastapi import HTTPException, Request, Response

from .legacy_identity import assert_native_origin, body, envelope, native_identity
from .legacy_optional_credentials import credentials_present
from .security import identity


def mount_legacy_notifications(app, settings, service):
    async def actor(request, *, legacy=False, write=False):
        credentials_present(request, platform=not legacy)
        if request.url.query:
            raise HTTPException(400, "不支持查询参数")
        if legacy or request.headers.get("authorization") is not None:
            assert_native_origin(request, settings)
            if not re.fullmatch(r"Bearer fat_[A-Za-z0-9_-]{43}", request.headers.get("authorization", "")):
                raise HTTPException(401, "需要有效的 App 连接")
            who, grant = await native_identity(request, service.db, "portfolio.write" if write else "portfolio.read")
            from .native_app_auth import CLIENT
            if grant["client_id"] != CLIENT:
                raise HTTPException(401, "连接已失效，请重新连接")
            return who
        return await identity(request)

    async def social(request: Request, response: Response):
        who = await actor(request, legacy=True)
        names = (
            ("wechat", "企业微信"),
            ("telegram", "电报"),
            ("feishu", "飞书"),
            ("qq", "QQ"),
            ("discord", "Discord"),
            ("webpush", "WebPush"),
            ("email", "邮件"),
        )
        rows = []
        async with service.db.connection() as conn, conn.transaction():
            await service.authorize_read(conn, who)
            for channel, name in names:
                state = await service.bindings.state(conn, who.id, channel) if channel != "webpush" else {}
                configured = bool(state.get("configured"))
                row = {
                    "id": channel,
                    "name": name,
                    "enabled": configured,
                    "configured": configured,
                    "bindable": configured and channel not in {"email", "webpush"},
                    "ready": bool(state.get("ready")),
                    "verificationState": state.get("verificationState", "unavailable"),
                }
                provider=await service.providers.current(conn,who.id,channel) if configured else None
                if provider:
                    target=service.providers.target(provider['target_id'],channel,provider['target_fingerprint'])
                    row['name']=target.label or name
                if channel == "wechat":
                    row.update(
                        kind="wecom", smart_robot=False if configured else None, binding="verification-code"
                    )
                if channel in {"feishu", "qq", "discord"}:
                    row["binding"] = "verification-code"
                if channel == "telegram":
                    row.update(bot_username=None, api_base=None)
                    provider = await service.providers.current(conn, who.id, channel)
                    if provider and configured:
                        _, values = service.providers.materialize(provider)
                        row["bot_username"] = values["botUsername"]
                if channel=='webpush':
                    row.update(service.providers.discovery('webpush'),bindable=False,ready=False,discoveryOnly=True)
                rows.append(row)
        return envelope({"version": 2, "channels": rows}, request, response)

    async def old_link(request: Request, response: Response):
        who = await actor(request, legacy=True, write=True)
        if await body(request, (), limit=16384):
            raise HTTPException(400, "绑定请求无效")
        result = await service.bindings.begin_telegram(
            who, None, request_id=request.headers.get("x-alcor-request-id"), legacy=True
        )
        return envelope(result, request, response)

    @app.post("/api/notifications/telegram-links")
    async def create_link(request: Request):
        who = await actor(request, write=True)
        raw = await body(request, ("requestId",), limit=16384)
        if set(raw) != {"requestId"}:
            raise HTTPException(400, "需要原请求编号")
        return await service.bindings.begin_telegram(
            who, request.headers.get("x-alcor-notification-proof"), request_id=raw["requestId"]
        )

    @app.get("/api/notifications/telegram-links/operations/{request_id}")
    async def link_receipt(request: Request, request_id: str):
        return await service.bindings.link_receipt(await actor(request, write=True), request_id)

    @app.get("/api/notifications/provider-targets")
    async def targets(request: Request):
        who = await actor(request)
        async with service.db.connection() as conn:
            await service.authorize_read(conn, who)
        values = (
            service.providers.target_provider()
            if service.providers.target_provider
            else service.providers.targets.values()
        )
        result = []
        for target in values:
            if target.channel=='webpush':continue  # metadata does not install a transport consumer
            try:
                service.providers.target(target.id, target.channel, target.fingerprint)
            except HTTPException:
                continue
            result.append({"id": target.id, "channel": target.channel, "label": target.channel})
        return {"targets": result}

    @app.get("/api/notifications/providers/operations/{request_id}")
    async def provider_receipt(request: Request, request_id: str):
        who = await actor(request)
        try:
            rid = UUID(request_id)
        except ValueError as exc:
            raise HTTPException(400, "请求编号无效") from exc
        async with service.db.connection() as conn, conn.transaction():
            await service.authorize_read(conn, who)
            results = []
            for table, kind in (
                ("business_notification_provider_revisions", "configure"),
                ("business_notification_provider_checks", "test"),
                ("business_notification_provider_revocations", "revoke"),
            ):
                row = await (
                    await conn.execute(
                        f"SELECT * FROM {table} WHERE owner_id=%s AND request_id=%s", (who.id, rid)
                    )
                ).fetchone()
                if row:
                    result = {
                        "requestId": str(rid),
                        "operation": kind,
                        "revision": str(row.get("provider_revision", row.get("revision"))),
                    }
                    if kind == "configure":
                        result["configured"] = True
                    elif kind == "revoke":
                        result["revoked"] = True
                    else:
                        result.update(status=row["status"], identity=row["identity"])
                    results.append(result)
            if len(results) > 1:
                raise HTTPException(409, "请求编号对应多个历史操作，请核对操作类型")
            if results:
                return results[0]
            pending = await (
                await conn.execute(
                    "SELECT provider_revision FROM business_notification_provider_probe_admissions WHERE owner_id=%s AND request_id=%s",
                    (who.id, rid),
                )
            ).fetchone()
            if pending:
                return {
                    "requestId": str(rid),
                    "operation": "test",
                    "revision": str(pending["provider_revision"]),
                    "status": "unknown",
                    "willRetryAutomatically": False,
                }
            raise HTTPException(404, "操作回执不存在")

    for version in (1, 2):
        app.add_api_route(
            f"/api/v{version}/social-channels",
            social,
            methods=["GET"],
            operation_id=f"legacy_social_channels_v{version}",
        )
        app.add_api_route(
            f"/api/v{version}/price-alerts/telegram-link",
            old_link,
            methods=["POST"],
            operation_id=f"legacy_telegram_link_v{version}",
        )
