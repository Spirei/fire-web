"""Private explicit card recognition adapters; no automatic card or wallet writes."""

import json
from uuid import UUID, uuid4

from fastapi import HTTPException, Request, Response

from .card_preferences_protocol import card_member, wire_response
from .card_recognition import CardRecognition
from .profile_http import bounded_body
from .security import digest, identity


def mount_card_recognition(app, db):
    service = CardRecognition(db)
    app.state.card_recognition = service

    async def member(request, legacy=False):
        try:
            if legacy:
                return await card_member(request, db)
            if "authorization" in request.headers:
                raise HTTPException(403, "请使用当前网页登录会话")
            return await identity(request)
        except HTTPException as exc:
            if exc.status_code in (401, 403):
                exc.headers = {**(exc.headers or {}), "X-Alcor-Retire-Context": "true",
                    "Cache-Control": "no-store, private"}
            raise

    private_headers = {"Cache-Control": "no-store, private", "Vary": "Cookie, Authorization"}

    async def parsed(request):
        def reject(_):
            raise ValueError("nonfinite")

        try:
            value = json.loads(await bounded_body(request, 16384), parse_constant=reject)
            if not isinstance(value, dict):
                raise TypeError()
            return value
        except (ValueError, TypeError, UnicodeError):
            raise HTTPException(400, "识别请求格式无效") from None

    async def execute(request, legacy=False):
        headers = {"Cache-Control": "no-store, private", "Vary": "Cookie, Authorization"}
        try:
            who = await member(request, legacy)
            address = request.client.host if request.client else "unknown"
            if not await app.state.rate_limit(
                db, digest("card-recognize:" + who.id + ":" + address), 30, window_seconds=60
            ):
                raise HTTPException(429, "识别过于频繁，请稍后再试")
            available = (await service.targets(who))["targets"]
            if legacy and not available:
                return wire_response({"enabled": False, "card": None}, headers)
            if request.headers.get("content-type", "").startswith("multipart/form-data") and not legacy:
                try:
                    async with request.form(max_files=1, max_fields=2, max_part_size=8 * 1024 * 1024) as form:
                        if set(form) != {"requestId", "targetId", "file"} or any(
                            len(form.getlist(k)) != 1 for k in form
                        ):
                            raise ValueError()
                        upload = form["file"]
                        if not hasattr(upload, "read"):
                            raise ValueError()
                        raw = await upload.read(8 * 1024 * 1024 + 1)
                        rid = str(UUID(str(form["requestId"])))
                        target_id = str(form["targetId"])
                except (ValueError, TypeError):
                    raise HTTPException(400, "卡面上传字段无效") from None
                generated = False
            else:
                data = await parsed(request)
                allowed = (
                    {"requestId", "targetId", "image"}
                    if legacy
                    else {"requestId", "targetId", "imageVersion"}
                )
                if set(data) - allowed:
                    raise HTTPException(400, "识别字段无效")
                generated = legacy and not data.get("requestId")
                try:
                    rid = (
                        str(UUID(data["requestId"]))
                        if data.get("requestId")
                        else str(uuid4())
                        if legacy
                        else None
                    )
                except (ValueError, TypeError, AttributeError):
                    raise HTTPException(400, "识别原UUID无效") from None
                if rid is None:
                    raise HTTPException(400, "识别需要原请求UUID")
                target_id = data.get("targetId")
                if target_id is None and legacy and len(available) == 1:
                    target_id = available[0]["id"]
                if not isinstance(target_id, str):
                    raise HTTPException(409, "请明确选择已许可识别来源")
                if legacy:
                    if not isinstance(data.get("image"), str):
                        raise HTTPException(400, "卡面图片地址无效")
                    raw = await service.image(who, path=data["image"])
                else:
                    if not data.get("imageVersion"):
                        raise HTTPException(400, "图片不可变版本缺失")
                    raw = await service.image(who, version=data["imageVersion"])
            result = await service.recognize(who, rid, target_id, raw)
            result = {**result, "legacyClientIdempotency": not generated}
            if legacy:
                result["enabled"] = True
            return wire_response(result, headers)
        except HTTPException as exc:
            if exc.status_code in (401, 403):
                headers["X-Alcor-Retire-Context"] = "true"
            return wire_response({"error": str(exc.detail)}, headers, exc.status_code)

    @app.get("/api/account/card-recognition/targets", tags=["card-recognition"])
    async def targets(request: Request):
        return wire_response(await service.targets(await member(request)), private_headers)

    @app.post("/api/account/card-recognition/operations", tags=["card-recognition"])
    async def recognize(request: Request):
        return await execute(request)

    @app.get("/api/account/card-recognition/operations/{identifier}", tags=["card-recognition"])
    async def operation(identifier: UUID, request: Request):
        return wire_response(await service.receipt(await member(request), identifier), private_headers)

    @app.get("/api/account/card-recognition/operations/{identifier}/input", tags=["card-recognition"])
    async def input_original(identifier: UUID, request: Request):
        raw = await service.input_original(await member(request), identifier)
        return Response(
            raw,
            media_type="application/octet-stream",
            headers={
                "Cache-Control": "no-store, private",
                "Content-Disposition": 'attachment; filename="recognition-input-original.bin"',
                "X-Content-Type-Options": "nosniff",
            },
        )

    @app.get("/api/account/card-recognition/originals/{identifier}", tags=["card-recognition"])
    async def original(identifier: UUID, request: Request):
        _, raw = await service.original(await member(request), identifier)
        return Response(
            raw,
            media_type="application/octet-stream",
            headers={
                "Cache-Control": "no-store, private",
                "Content-Disposition": 'attachment; filename="recognition-provider-original.bin"',
                "X-Content-Type-Options": "nosniff",
            },
        )

    @app.post("/api/cards/recognize", tags=["legacy-web-cards"])
    async def old(request: Request):
        return await execute(request, True)

    @app.get("/api/cards/recognize/operations/{identifier}", tags=["legacy-web-cards"])
    async def old_operation(identifier: UUID, request: Request):
        return wire_response(await service.receipt(await member(request, True), identifier), private_headers)
