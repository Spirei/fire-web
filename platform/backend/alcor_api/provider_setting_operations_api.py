"""Five old provider-setting routes and explicit administrator operations."""

import json
from uuid import UUID, uuid4

from fastapi import HTTPException, Request, Response

from .card_preferences_protocol import wire_response
from .profile_http import bounded_body
from .provider_setting_operations import ProviderSettingOperations
from .security import digest, identity


def mount_provider_setting_operations(app, db):
    service = ProviderSettingOperations(db)
    app.state.provider_setting_operations = service

    async def member(request, legacy=False):
        if legacy:
            from .legacy_optional_credentials import credentials_present

            credentials_present(request)
            from .legacy_site_settings import member as legacy_admin_member

            who = await legacy_admin_member(request, db)
        else:
            if "authorization" in request.headers:
                raise HTTPException(403, "请使用当前管理员Web会话")
            who = await identity(request)
        if who.role != "admin":
            raise HTTPException(403, "需要管理员权限")
        return who

    async def body(request):
        from .fx_provider_parser import unique

        def reject(_):
            raise ValueError("nonfinite")

        try:
            value = json.loads(
                await bounded_body(request, 16384), object_pairs_hook=unique, parse_constant=reject
            )
            if not isinstance(value, dict):
                raise TypeError()
            return value
        except (ValueError, TypeError, UnicodeError):
            raise HTTPException(400, "提供商操作字段无效") from None

    async def execute(request, kind, legacy=False):
        headers = {
            "Cache-Control": "no-store, private",
            "Vary": "Cookie, Authorization",
            "X-Content-Type-Options": "nosniff",
        }
        try:
            who = await member(request, legacy)
            if kind == "tests":
                return wire_response(await service.tests(who), headers)
            address = request.client.host if request.client else "unknown"
            limit = 3 if kind == "mail-test" else 20 if kind == "xueqiu-cookie" else 12
            seconds = 600 if kind == "mail-test" else 60
            for key, maximum in (
                (kind + ":" + who.id + ":" + address, limit),
                ("provider-op-global:" + kind, 30 if kind == "mail-test" else 60),
            ):
                if not await app.state.rate_limit(db, digest(key), maximum, window_seconds=seconds):
                    raise HTTPException(429, "测试或读取过于频繁，请稍后再试")
            image = None
            filename = None
            if kind == "model-icon":
                await bounded_body(request, 2 * 1024 * 1024 + 65536)
                async with request.form(max_files=1, max_fields=10, max_part_size=2 * 1024 * 1024) as form:
                    allowed = {
                        "requestId",
                        "expectedRevision",
                        "serviceId",
                        "file",
                        "password",
                        "code",
                        "currentPassword",
                        "kind",
                        "folder",
                        "modelServicesRevision",
                        "modelServices",
                    }
                    if set(form) - allowed or any(len(form.getlist(k)) != 1 for k in form):
                        raise HTTPException(400, "模型图标上传字段无效")
                    file = form.get("file")
                    if not hasattr(file, "read"):
                        raise HTTPException(400, "请选择模型图标")
                    filename = file.filename or "icon.png"
                    image = await file.read(2 * 1024 * 1024 + 1)
                    if not 0 < len(image) <= 2 * 1024 * 1024:
                        raise HTTPException(400, "模型图标最大2MiB")
                    raw = {
                        k: form[k]
                        for k in ("requestId", "serviceId", "password", "code", "currentPassword")
                        if k in form
                    }
                    if form.get("modelServices"):
                        try:
                            raw["modelServices"] = json.loads(str(form["modelServices"]))
                        except (ValueError, TypeError) as exc:
                            raise HTTPException(400, "模型服务文档格式无效") from exc
                    revision = form.get("expectedRevision", form.get("modelServicesRevision"))
                    if revision is not None:
                        try:
                            raw["expectedRevision"] = int(revision)
                        except (ValueError, TypeError):
                            raise HTTPException(409, "模型配置版本无效，请重新读取") from None
            else:
                raw = await body(request)
            allowed = {"requestId", "expectedRevision", "password", "currentPassword", "code"}
            if kind == "model-test":
                allowed |= {"serviceId", "provider", "model", "apiUrl", "apiKey"}
            if kind == "mail-test":
                allowed |= {
                    "targetId",
                    "smtpHost",
                    "smtpPort",
                    "smtpSecure",
                    "smtpUser",
                    "smtpPassword",
                    "smtpFromName",
                    "smtpFromEmail",
                }
            if kind == "model-icon":
                allowed |= {"serviceId", "modelServices"}
            if set(raw) - allowed:
                raise HTTPException(400, "提供商操作字段无效")
            generated = legacy and not raw.get("requestId")
            if not raw.get("requestId"):
                if not legacy:
                    raise HTTPException(400, "操作需要原UUID")
                raw["requestId"] = str(uuid4())
            raw["requestId"] = str(UUID(str(raw["requestId"])))
            if not legacy and type(raw.get("expectedRevision")) is not int:
                raise HTTPException(400, "请先读取当前私有设置版本")
            if kind == "xueqiu-cookie":
                result = await service.reveal(who, raw)
            elif kind == "model-icon":
                result = await service.icon(who, raw, image, filename)
            else:
                result = await service.test(who, kind, raw)
            status = 200 if result["state"] == "completed" else 202 if result["state"] == "unknown" else 502
            return wire_response({**result, "legacyClientIdempotency": not generated}, headers, status)
        except (ValueError, TypeError, UnicodeError):
            return wire_response({"error": "提供商请求格式无效"}, headers, 400)
        except HTTPException as exc:
            headers.update(exc.headers or {})
            if exc.status_code in (401, 403) and headers.get("X-Alcor-Proof-Rejected") != "true":
                headers["X-Alcor-Retire-Context"] = "true"
            error = {"error": str(exc.detail)}
            if not legacy and headers.get("X-Alcor-Proof-Rejected") == "true":
                error = {"error": {"message": str(exc.detail), "code": "provider_proof_rejected"}}
            return wire_response(error, headers, exc.status_code)

    for prefix, legacy in (("/api/settings", True), ("/api/admin/provider-operations", False)):
        for path, kind, methods in (
            ("/mail-test", "mail-test", ["POST"]),
            ("/model-test", "model-test", ["POST"]),
            ("/model-test", "tests", ["GET"]),
            ("/model-icon", "model-icon", ["POST"]),
            ("/xueqiu-cookie", "xueqiu-cookie", ["POST"]),
        ):

            def endpoint(action, old):
                async def handler(request: Request):
                    return await execute(request, action, old)

                return handler

            app.add_api_route(
                prefix + path,
                endpoint(kind, legacy),
                methods=methods,
                operation_id=("legacy_" if legacy else "admin_")
                + "provider_"
                + kind.replace("-", "_")
                + "_"
                + methods[0].lower(),
            )

    @app.get("/api/admin/provider-operations/operations/{identifier}", tags=["provider-settings"])
    async def receipt(identifier: UUID, request: Request):
        return wire_response(
            await service.receipt(await member(request), identifier), {"Cache-Control": "no-store, private"}
        )

    @app.get("/api/admin/provider-operations/originals/{identifier}", tags=["provider-settings"])
    async def original(identifier: UUID, request: Request):
        return Response(
            await service.original(await member(request), identifier),
            media_type="application/octet-stream",
            headers={
                "Cache-Control": "no-store, private",
                "Content-Disposition": 'attachment; filename="provider-response-original.bin"',
                "X-Content-Type-Options": "nosniff",
            },
        )
