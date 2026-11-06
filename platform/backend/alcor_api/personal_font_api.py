"""Same-owner fonts; old Web envelopes use the same PG service and protected bytes."""

import json
from uuid import UUID, uuid4

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from starlette.datastructures import UploadFile

from .font_codec import LIMIT
from .legacy_identity import OLD_COOKIE, WEB_COOKIE, assert_native_origin, web_identity
from .personal_fonts import PersonalFonts, legacy
from .profile_http import bounded_body
from .resource_api import no_duplicate_object
from .security import digest, identity
from .system_asset_api import content


def mount_personal_fonts(app, settings, db, rate_limit):
    service = PersonalFonts(db)
    app.state.personal_fonts = service

    async def member(request, old=False):
        if "authorization" in request.headers:
            raise HTTPException(403, "请使用当前本人网页会话")
        assert_native_origin(request, settings)
        if old and (request.cookies.get(WEB_COOKIE) or request.cookies.get(OLD_COOKIE)):
            return (await web_identity(request, db))[0]
        return await identity(request)

    async def upload(request, old=False):
        who = await member(request, old)
        if request.query_params and not old:
            raise HTTPException(400, "查询字段无效")
        address = request.client.host if request.client else "unknown"
        for key, maximum in (
            (digest("font-upload:" + who.id + ":" + address), 60),
            ("font-upload-global", 600),
        ):
            if not await rate_limit(db, key, maximum, window_seconds=3600):
                raise HTTPException(429, "字体上传过于频繁")
        async with app.state.resource_library.upload_slot():
            await bounded_body(request, LIMIT + 65536)
            form = await request.form(max_files=1, max_fields=2)
            try:
                if set(form) - {"file", "requestId", "expectedRevision"} or any(
                    len(form.getlist(k)) != 1 for k in form
                ):
                    raise HTTPException(400, "字体表单无效")
                file = form.get("file")
                if not isinstance(file, UploadFile):
                    raise HTTPException(400, "请选择字体文件")
                identifier = form.get("requestId") or request.headers.get("x-alcor-request-id")
                if (
                    form.get("requestId")
                    and request.headers.get("x-alcor-request-id")
                    and identifier != request.headers["x-alcor-request-id"]
                ):
                    raise HTTPException(400, "原UUID字段不一致")
                generated = identifier is None
                identifier = identifier or str(uuid4())
                if not isinstance(identifier, str):
                    raise HTTPException(400, "原UUID无效")
                try:
                    if str(UUID(identifier)) != identifier:
                        raise ValueError()
                except ValueError:
                    raise HTTPException(400, "原UUID无效") from None
                expected = form.get("expectedRevision")
                if not old and (generated or expected is None):
                    raise HTTPException(400, "需要原UUID和当前字体修订")
                if expected is not None:
                    if (
                        not isinstance(expected, str)
                        or not expected.isascii()
                        or not expected.isdecimal()
                        or len(expected) > 16
                    ):
                        raise HTTPException(400, "字体修订无效")
                    expected = int(expected)
                value = await service.upload(
                    who,
                    identifier,
                    expected,
                    file.filename or "",
                    await file.read(LIMIT + 1),
                    canonical=not old or expected is not None,
                )
                body = (
                    value
                    if not old
                    else {"font": legacy(value["font"])}
                    if value["state"] == "completed"
                    else {"error": value["message"]}
                )
                headers = {
                    "Cache-Control": "private, no-store",
                    "X-Alcor-Request-Id": identifier,
                    "X-Alcor-Revision": str(value["revision"]),
                }
                if generated:
                    headers["X-Alcor-Request-Id-Mode"] = "generated_legacy"
                return JSONResponse(body, status_code=value["httpStatus"], headers=headers)
            finally:
                await form.close()

    @app.get("/api/personal-fonts", tags=["personal-fonts"])
    async def listing(request: Request):
        if request.query_params:
            raise HTTPException(400, "查询字段无效")
        return JSONResponse(
            await service.read(await member(request)), headers={"Cache-Control": "private, no-store"}
        )

    @app.post("/api/personal-fonts", tags=["personal-fonts"])
    async def canonical_upload(request: Request):
        return await upload(request)

    @app.get("/api/fonts", tags=["legacy-web-fonts"])
    async def old_listing(request: Request):
        try:
            result = await service.read(await member(request, True))
            return JSONResponse(
                {"fonts": [legacy(f) for f in result["fonts"]]},
                headers={"Cache-Control": "private, no-store"},
            )
        except HTTPException as error:
            return JSONResponse(
                {"error": str(error.detail)},
                status_code=error.status_code,
                headers={"Cache-Control": "private, no-store"},
            )

    @app.post("/api/fonts", tags=["legacy-web-fonts"])
    async def old_upload(request: Request):
        try:
            return await upload(request, True)
        except HTTPException as error:
            return JSONResponse(
                {"error": str(error.detail)},
                status_code=error.status_code,
                headers={"Cache-Control": "private, no-store"},
            )

    @app.get("/api/personal-fonts/operations/{identifier}", tags=["personal-fonts"])
    async def receipt(identifier: UUID, request: Request):
        if request.query_params:
            raise HTTPException(400, "查询字段无效")
        return JSONResponse(
            await service.operation(await member(request), identifier),
            headers={"Cache-Control": "private, no-store"},
        )

    @app.post("/api/personal-fonts/operations/{identifier}/close", tags=["personal-fonts"])
    async def close(identifier: UUID, request: Request):
        who = await member(request)
        if request.query_params:
            raise HTTPException(400, "查询字段无效")
        await bounded_body(request, 1024)
        try:
            data = json.loads(await request.body(), object_pairs_hook=no_duplicate_object)
            if data != {"expectedKind": "upload"}:
                raise ValueError()
        except (ValueError, TypeError):
            raise HTTPException(400, "关闭字段无效") from None
        return JSONResponse(
            await service.close(who, identifier), headers={"Cache-Control": "private, no-store"}
        )

    async def download(request, identifier, *, original=False, old=False):
        if request.query_params and not old:
            raise HTTPException(400, "查询字段无效")
        row, stream = await service.original(await member(request, old), identifier)
        row = {
            **row,
            "original_size": row["byte_length"],
            "served_size": row["byte_length"],
            "original_sha256": row["sha256"],
            "served_sha256": row["sha256"],
            "media_type": "application/octet-stream" if original else row["media_type"],
        }
        response = content(request, row, stream, private=original)
        response.headers["Cache-Control"] = "private, no-store"
        return response

    @app.get("/api/personal-fonts/{identifier}/content", tags=["personal-fonts"])
    async def served(identifier: str, request: Request):
        return await download(request, identifier)

    @app.get("/api/personal-fonts/{identifier}/original", tags=["personal-fonts"])
    async def original(identifier: str, request: Request):
        return await download(request, identifier, original=True)

    # Register before the global /uploads catch-all. Other system/default fonts are not inferred.
    @app.get("/uploads/fonts/{identifier}", include_in_schema=False)
    @app.get("/api/upload-files/fonts/{identifier}", include_in_schema=False)
    async def old_font(identifier: str, request: Request):
        return await download(request, identifier, old=True)
