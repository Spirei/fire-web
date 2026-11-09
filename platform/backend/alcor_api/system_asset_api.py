"""Shared system uploads and narrowly indexed public rendering; no public directory mount."""

import asyncio
import re
from uuid import UUID, uuid4

from fastapi import HTTPException, Request, Response
from fastapi.responses import JSONResponse
from starlette.datastructures import UploadFile

from .profile_http import bounded_body
from .resource_api import PrivateResourceResponse, byte_range
from .security import digest, identity
from .system_assets import SystemAssets

# Bundled illustration from the old security-check route. Host volumes are not consulted.
SECURITY_CHECK_SVG = (
    b'<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100" fil'
    b'l="none"><defs><linearGradient id="shield" x1="20" y1="10" x2="77" y2="82" gradientUnits="'
    b'userSpaceOnUse"><stop stop-color="#9b9cff"/><stop offset=".38" stop-color="#0866ff"/><stop'
    b' offset="1" stop-color="#00d5f4"/></linearGradient><linearGradient id="fold" x1="32" y1="4'
    b'9" x2="60" y2="90" gradientUnits="userSpaceOnUse"><stop stop-color="#1340da"/><stop offset'
    b'="1" stop-color="#002a98"/></linearGradient></defs><path d="M49 8c-14 0-27 5-35 10v27c0 23'
    b' 13 37 35 47 22-10 35-24 35-47V18C76 13 63 8 49 8Z" fill="url(#shield)"/><path d="M14 36c7'
    b' 23 21 38 45 46l-10 10C27 82 14 68 14 45Z" fill="url(#fold)"/><circle cx="76" cy="64" r="2'
    b'2" fill="white"/><circle cx="76" cy="64" r="17" stroke="#0866ff" stroke-width="3.5"/><path'
    b' d="M76 54v12" stroke="#0866ff" stroke-width="4" stroke-linecap="round"/><circle cx="76" c'
    b'y="73" r="2.2" fill="#0866ff"/></svg>'
)


def mount_system_assets(app, settings, db, rate_limit):
    service = SystemAssets(db, getattr(app.state, "legacy_card_directory", None))
    app.state.system_assets = service

    async def admin(request):
        if "authorization" in request.headers:
            raise HTTPException(403, "请使用当前网页管理员会话")
        from .legacy_identity import OLD_COOKIE, WEB_COOKIE
        if request.cookies.get(WEB_COOKIE) or request.cookies.get(OLD_COOKIE):
            from .fire_web import member
            who = await member(request)
        else:
            who = await identity(request)
        if who.role != "admin":
            raise HTTPException(403, "需要管理员权限")
        return who

    async def form_upload(who, form, request, canonical=False):
        if (
            set(form)
            - (
                {"file", "kind", "folder", "name", "code", "market", "requestId", "expectedRevision"}
                | ({"assetId", "catalogRevision", "publicMetadataConfirmed"} if canonical else set())
            )
            or len(form.getlist("file")) != 1
            or any(len(form.getlist(k)) != 1 for k in form)
        ):
            raise HTTPException(400, "上传表单无效")
        file = form.get("file")
        if not isinstance(file, UploadFile):
            raise HTTPException(400, "请选择要上传的文件")
        fields = {k: v for k, v in form.items() if k != "file"}
        if any(not isinstance(v, str) for v in fields.values()):
            raise HTTPException(400, "上传字段无效")
        if canonical and ("requestId" not in fields or "expectedRevision" not in fields):
            raise HTTPException(400, "需要原UUID和当前素材修订")
        fields.setdefault("requestId", str(uuid4()))
        if "expectedRevision" in fields:
            value = fields["expectedRevision"]
            if not value.isascii() or not value.isdecimal() or len(value) > 16:
                raise HTTPException(400, "素材修订无效")
            fields["expectedRevision"] = int(value)
        binding_fields = {"assetId", "catalogRevision", "publicMetadataConfirmed"}
        if binding_fields & set(fields):
            from .asset_catalog_management import TYPES, identifier

            if (
                not binding_fields <= set(fields)
                or fields.get("publicMetadataConfirmed") != "true"
                or fields.get("kind") != "asset"
                or fields.get("folder") not in (*TYPES, "card")
            ):
                raise HTTPException(400, "对应图标的目录信息不完整")
            catalog_revision = fields.pop("catalogRevision")
            if (
                not catalog_revision.isascii()
                or not catalog_revision.isdecimal()
                or len(catalog_revision) > 16
                or int(catalog_revision) >= 9007199254740991
            ):
                raise HTTPException(400, "素材目录修订无效")
            raw_id = fields.pop("assetId")
            if fields["folder"] == "card":
                if (not raw_id.startswith("card:") and not re.fullmatch(r"legacy-file:[a-f0-9]{32}", raw_id)) or len(raw_id) > 2048 or any(ord(c) < 32 for c in raw_id):
                    raise HTTPException(400, "卡面标识无效")
                aid = raw_id
            else:
                aid = identifier(raw_id)
            fields.pop("publicMetadataConfirmed")
            fields["catalogBinding"] = {
                "expectedRevision": int(catalog_revision),
                "asset": {
                    "id": aid,
                    "type": fields["folder"],
                    "market": fields.get("market", ""),
                    "code": fields.get("code", ""),
                    "name": fields.get("name", ""),
                },
            }
            if not re.fullmatch(r"[A-Z0-9][A-Z0-9._:-]{0,39}", fields.get("code", "")):
                import hashlib

                fields["code"] = "icon-" + hashlib.sha256(aid.encode()).hexdigest()[:16]
            if fields["folder"] == "card":
                fields["name"] = "卡面图片"
        value = await service.upload(
            who, fields, file.filename or "", await file.read(20971521), request.state.request_id, canonical
        )
        body = (
            value
            if canonical
            else {"url": value["legacyUrl"]}
            if value["state"] == "completed"
            else {"error": value["message"]}
        )
        return JSONResponse(
            body,
            status_code=value["httpStatus"],
            headers={
                "Cache-Control": "no-store",
                "X-Alcor-Operation": value["requestId"],
                "X-Alcor-Revision": str(value["revision"]),
            },
        )

    app.state.system_asset_form = form_upload

    @app.get("/api/admin/shared-assets")
    async def read(request: Request):
        if request.query_params:
            raise HTTPException(400, "查询字段无效")
        return await service.read(await admin(request))

    @app.post("/api/admin/shared-assets/upload")
    async def upload(request: Request):
        who = await admin(request)
        address = request.client.host if request.client else "unknown"
        for key, maximum in ((digest("upload:" + address + ":" + who.id), 60), ("upload-global", 600)):
            if not await rate_limit(db, key, maximum, window_seconds=3600):
                raise HTTPException(429, "上传过于频繁")
        if request.query_params:
            raise HTTPException(400, "查询字段无效")
        async with app.state.resource_library.upload_slot():
            await bounded_body(request, 21 * 1024 * 1024)
            form = await request.form(max_files=1, max_fields=12)
            try:
                return await form_upload(who, form, request, True)
            finally:
                await form.close()

    @app.get("/api/admin/shared-assets/operations/{identifier}")
    async def receipt(identifier: UUID, request: Request):
        if request.query_params:
            raise HTTPException(400, "查询字段无效")
        return await service.receipt(await admin(request), identifier)

    @app.post("/api/admin/shared-assets/restore-card")
    async def restore_card(request: Request):
        import json
        import hashlib
        from pathlib import Path
        who = await admin(request)
        try:
            raw = json.loads(await bounded_body(request, 8192))
            if (not isinstance(raw, dict) or set(raw) != {"requestId", "expectedRevision", "catalogRevision", "assetId", "publicMetadataConfirmed"}
                    or raw["publicMetadataConfirmed"] is not True
                    or any(type(raw[k]) is not int or not 0 <= raw[k] < 9007199254740991 for k in ("expectedRevision", "catalogRevision"))
                    or not isinstance(raw["assetId"], str)):
                raise ValueError()
        except (ValueError, TypeError, UnicodeError):
            raise HTTPException(400, "卡面恢复字段无效") from None
        async with app.state.resource_library.upload_slot():
            from .card_public_assets import CardPublicAssets
            source = await CardPublicAssets(db, service.card_directory).source(raw["assetId"])
            if source is None:
                raise HTTPException(409, "原始卡面尚未核对，无法恢复")
            directory = service.card_directory if source["relativePath"].startswith("cards/") else getattr(service.card_directory, "asset_directory", None)
            if directory is None:
                raise HTTPException(409, "原始素材目录尚未核对")
            original = await asyncio.to_thread(directory.read_original, source["relativePath"])
            fields = {"kind": "asset", "folder": "card", "name": "原始卡面", "code": "original-" + hashlib.sha256(raw["assetId"].encode()).hexdigest()[:16], "requestId": raw["requestId"], "expectedRevision": raw["expectedRevision"],
                      "catalogBinding": {"expectedRevision": raw["catalogRevision"], "restoreOriginal": True, "asset": {"id": raw["assetId"], "type": "card"}}}
            value = await service.upload(who, fields, Path(source["relativePath"]).name, original, request.state.request_id, True)
            return JSONResponse(value, status_code=value["httpStatus"], headers={"Cache-Control": "no-store"})

    @app.get("/api/admin/shared-assets/versions/{identifier}/original")
    async def original(identifier: UUID, request: Request):
        if request.query_params:
            raise HTTPException(400, "查询字段无效")
        row, stream = await service.original(await admin(request), identifier)
        return content(request, row, stream, private=True)

    @app.get("/api/celeb-portraits/{filename}")
    async def celeb_portrait(filename: str, request: Request):
        from .legacy_asset_directory import LegacyCelebPortraits, public_upload_root
        if set(request.query_params) - {"sha256"} or len(request.query_params.getlist("sha256")) > 1:
            raise HTTPException(400, "图片参数无效")
        row, stream = await asyncio.to_thread(LegacyCelebPortraits(public_upload_root(settings)).open_bytes, "celebs/" + filename, request.query_params.get("sha256"))
        return content(request, row, stream, immutable=request.query_params.get("sha256") is not None)

    @app.get("/uploads/{path:path}")
    async def public(path: str, request: Request):
        if path.startswith("celebs/"):
            return await celeb_portrait(path[len("celebs/"):], request)
        if path.startswith(("asset/", "cards/")):
            from .asset_library_access import assert_material_read
            await assert_material_read(request, db)
        if re.search(b"%2f|%5c|%00", request.scope.get("raw_path", b""), re.IGNORECASE):
            raise HTTPException(400, "无效的素材路径")
        query = request.query_params
        if "sha256" in query and (len(query.getlist("sha256")) != 1 or set(query) != {"sha256"}):
            raise HTTPException(400, "素材摘要参数无效")
        # Old public URLs ignore ordinary cache-busting query fields; sha256 is strict.
        sha = query.get("sha256")
        if sha is not None and not re.fullmatch(r"[a-f0-9]{64}", sha):
            raise HTTPException(400, "无效的素材摘要")
        directory = getattr(app.state, "legacy_card_directory" if path.startswith("cards/") else "legacy_asset_directory", None)
        # Unicode legacy filenames and manifest cards never enter the ASCII
        # registered-path parser. Every component is checked by the readonly adapter.
        if directory is not None and (path.startswith("cards/") or path.startswith("asset/") and not re.fullmatch(r"[A-Za-z0-9._/-]+", path)):
            row, stream = await asyncio.to_thread(directory.open_bytes, path, sha)
            return content(request, row, stream, immutable=sha is not None)
        try:
            row, stream = await service.public("/uploads/" + path, sha)
        except HTTPException as exc:
            if exc.status_code != 404 or directory is None or not path.startswith(("asset/", "cards/")):
                raise
            row, stream = await asyncio.to_thread(directory.open_bytes, path, sha)
        return content(request, row, stream, immutable=sha is not None)

    @app.get(
        "/api/system-assets/security-check",
        responses={200: {"content": {"image/svg+xml": {}}}},
    )
    async def security_check():
        return security_check_response()


def security_check_response():
    return Response(
        SECURITY_CHECK_SVG,
        headers={
            "Content-Type": "image/svg+xml; charset=utf-8",
            "Cache-Control": "public, max-age=0, must-revalidate",
            "X-Content-Type-Options": "nosniff",
        },
    )


def content(request, row, stream, private=False, immutable=False):
    size = row["original_size"] if private else row["served_size"]
    sha = row["original_sha256"] if private else row["served_sha256"]
    headers = {
        "Content-Type": row["media_type"],
        "Content-Length": str(size),
        "ETag": '"' + sha + '"',
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, no-store"
        if private
        else "public, max-age=31536000, immutable"
        if immutable
        else "public, max-age=0, must-revalidate",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'",
    }
    if str(request.url.path).startswith(("/uploads/asset/", "/uploads/cards/")):
        headers["Cache-Control"] = "private, no-store"
        headers["Vary"] = "Cookie, Authorization"
    if private:
        headers["Content-Disposition"] = "attachment"
    if not private and request.headers.get("if-none-match") in (headers["ETag"], "*"):
        stream.close()
        return Response(status_code=304, headers={k: v for k, v in headers.items() if k != "Content-Length"})
    if len(request.headers.getlist("range")) > 1:
        stream.close()
        return Response(status_code=416, headers={**headers, "Content-Range": f"bytes */{size}"})
    try:
        start, end = byte_range(request.headers.get("range"), size)
    except HTTPException:
        stream.close()
        return Response(status_code=416, headers={**headers, "Content-Range": f"bytes */{size}"})
    length = end - start + 1
    headers["Content-Length"] = str(length)
    if "range" in request.headers:
        headers["Content-Range"] = f"bytes {start}-{end}/{size}"

    async def chunks():
        try:
            stream.seek(start)
            remaining = length
            while remaining:
                raw = await asyncio.to_thread(stream.read, min(1048576, remaining))
                if not raw:
                    raise OSError("original truncated")
                remaining -= len(raw)
                yield raw
        finally:
            stream.close()

    return PrivateResourceResponse(
        stream, chunks(), status_code=206 if "range" in request.headers else 200, headers=headers
    )
