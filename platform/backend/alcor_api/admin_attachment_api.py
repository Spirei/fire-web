"""One admin-shared service, canonical API and the old Web's thin response adapter."""

import json
from urllib.parse import quote
from uuid import UUID, uuid4

from fastapi import HTTPException, Request, Response
from fastapi.responses import JSONResponse
from starlette.datastructures import UploadFile
from starlette.requests import ClientDisconnect

from .admin_attachments import LIMIT, AdminAttachments
from .legacy_identity import LegacyError, web_identity
from .profile_http import bounded_body
from .resource_api import PrivateResourceResponse, byte_range, no_duplicate_object
from .security import digest, identity


def mime(name):
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    return {
        "png": "image/png",
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "gif": "image/gif",
        "webp": "image/webp",
        "svg": "image/svg+xml",
        "pdf": "application/pdf",
        "txt": "text/plain; charset=utf-8",
        "md": "text/markdown; charset=utf-8",
        "csv": "text/csv; charset=utf-8",
        "json": "application/json; charset=utf-8",
        "xml": "application/xml; charset=utf-8",
        "html": "text/plain; charset=utf-8",
    }.get(ext, "application/octet-stream")


def mount_admin_attachments(app, settings):
    from .main import rate_limit

    service = AdminAttachments(app.state.db)
    app.state.admin_attachments = service

    async def member(request, canonical):
        if "authorization" in request.headers:
            raise HTTPException(403, "请使用管理员网页登录会话")
        who = await identity(request) if canonical else (await web_identity(request, app.state.db))[0]
        if who.role != "admin":
            raise HTTPException(403, "需要管理员权限")
        if not await rate_limit(app.state.db, digest("admin-attachments:" + who.id), 180, window_seconds=60):
            raise HTTPException(429, "请求过于频繁")
        return who

    async def execute(request, canonical):
        try:
            who = await member(request, canonical)
            query = request.query_params
            allowed = (
                {"path", "action"}
                if request.method == "GET"
                else {"path", "force"}
                if request.method == "DELETE"
                else set()
            )
            if set(query) - allowed or any(len(query.getlist(k)) != 1 for k in query):
                raise HTTPException(400, "查询字段无效")
            if request.method == "GET":
                action = query.get("action", "")
                if action in ("download", "preview"):
                    row, stream = await service.content(who, path=query.get("path", ""))
                    return content(request, row, stream, action == "preview")
                if canonical and action not in ("", "directories"):
                    raise HTTPException(400, "读取操作无效")
                return JSONResponse(
                    await service.listing(who, query.get("path", ""), canonical, action == "directories"),
                    headers={"Cache-Control": "private, no-store"},
                )
            file = None
            if request.method == "DELETE":
                body = await bounded_body(request, 65536)
                if body:
                    raw = json.loads(body, object_pairs_hook=no_duplicate_object)
                else:
                    raw = {}
                if not isinstance(raw, dict) or set(raw) - {"requestId", "expectedRevision"}:
                    raise HTTPException(400, "删除字段无效")
                raw.update(action="delete", path=query.get("path", ""), force=query.get("force") == "1")
                if "force" in query and query["force"] not in ("0", "1"):
                    raise HTTPException(400, "删除标记无效")
                return await commit(request, who, raw, file, canonical)
            # Reuse F26's actual PG-global parser slots, including pool_size=1.
            async with app.state.resource_library.upload_slot():
                if (
                    request.headers.get("content-type", "").split(";")[0].strip().lower()
                    == "application/json"
                ):
                    raw = json.loads(
                        await bounded_body(request, 65536), object_pairs_hook=no_duplicate_object
                    )
                    if not isinstance(raw, dict):
                        raise ValueError()
                else:
                    await bounded_body(request, LIMIT + 1024 * 1024)
                    form = await request.form(max_files=1, max_fields=12)
                    try:
                        if any(len(form.getlist(k)) != 1 for k in form):
                            raise ValueError()
                        raw = {k: v for k, v in form.multi_items() if k != "file"}
                        upload = form.get("file")
                        if upload is not None:
                            if not isinstance(upload, UploadFile):
                                raise ValueError()
                            file = (upload.filename or "", await upload.read(LIMIT + 1))
                    finally:
                        await form.close()
                return await commit(request, who, raw, file, canonical)
        except (HTTPException, LegacyError) as error:
            value = error.detail if isinstance(error.detail, dict) else {"error": str(error.detail)}
            return JSONResponse(
                value, status_code=error.status_code, headers={"Cache-Control": "private, no-store"}
            )
        except ClientDisconnect:
            return JSONResponse({"error": "请求已断开，请查询原操作"}, status_code=499)
        except (UnicodeError, ValueError, TypeError):
            return JSONResponse({"error": "请求字段无效"}, status_code=400)

    async def commit(request, who, raw, upload, canonical):
        if set(raw) - {
            "action",
            "dir",
            "parent",
            "name",
            "source",
            "targetDir",
            "conflict",
            "requestId",
            "expectedRevision",
            "path",
            "force",
        }:
            raise HTTPException(400, "附件字段无效")
        for k, v in raw.items():
            if k not in ("expectedRevision", "force") and not isinstance(v, str):
                raise ValueError()
        if "expectedRevision" in raw and isinstance(raw["expectedRevision"], str):
            value = raw["expectedRevision"]
            if not value.isascii() or not value.isdecimal() or len(value) > 16:
                raise ValueError()
            raw["expectedRevision"] = int(value)
        if canonical and "requestId" not in raw:
            raise HTTPException(400, "需要原操作UUID")
        raw.setdefault("requestId", str(uuid4()))
        raw.setdefault("action", "upload")
        raw["conflict"] = raw.get("conflict") if raw.get("conflict") in ("replace", "keep-both") else "error"
        for key in ("dir", "parent", "name", "source", "targetDir"):
            if key in raw:
                raw[key] = raw[key].strip()
        value = await service.mutate(who, raw, request.state.request_id, upload, legacy=not canonical)
        if canonical:
            body = value
        else:
            body = (
                value["result"]
                if value["state"] == "completed"
                else value["error"]
                if isinstance(value["error"], dict)
                else {"error": str(value["error"])}
            )
        return JSONResponse(
            body,
            status_code=value["httpStatus"],
            headers={
                "Cache-Control": "private, no-store",
                "X-Alcor-Operation": value["requestId"],
                "X-Alcor-Revision": str(value["revision"]),
            },
        )

    def content(request, row, stream, preview=False):
        size = row["byte_length"]
        headers = {
            "Accept-Ranges": "bytes",
            "Cache-Control": "private, no-store",
            "ETag": '"' + row["sha256"] + '"',
            "Content-Type": mime(row["original_name"]) if preview else "application/octet-stream",
            "Content-Disposition": ("inline" if preview else "attachment")
            + "; filename*=UTF-8''"
            + quote(row["original_name"], safe=""),
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'",
        }
        if len(request.headers.getlist("range")) > 1 or "range" in request.headers and size == 0:
            stream.close()
            return Response(status_code=416, headers={**headers, "Content-Range": f"bytes */{size}"})
        try:
            start, end = byte_range(request.headers.get("range"), size) if size else (0, -1)
        except HTTPException:
            stream.close()
            return Response(status_code=416, headers={**headers, "Content-Range": f"bytes */{size}"})
        length = end - start + 1
        headers["Content-Length"] = str(length)
        if "range" in request.headers:
            headers["Content-Range"] = f"bytes {start}-{end}/{size}"

        async def chunks():
            import asyncio

            try:
                stream.seek(start)
                remaining = length
                while remaining:
                    raw = await asyncio.to_thread(stream.read, min(1024 * 1024, remaining))
                    if not raw:
                        raise OSError("original truncated")
                    remaining -= len(raw)
                    yield raw
            finally:
                stream.close()

        return PrivateResourceResponse(
            stream, chunks(), status_code=206 if "range" in request.headers else 200, headers=headers
        )

    @app.get("/api/admin/attachments", operation_id="canonical_attachments_get")
    @app.post("/api/admin/attachments", operation_id="canonical_attachments_post")
    @app.delete("/api/admin/attachments", operation_id="canonical_attachments_delete")
    async def canonical(request: Request):
        return await execute(request, True)

    @app.get("/api/attachments", operation_id="legacy_attachments_get")
    @app.post("/api/attachments", operation_id="legacy_attachments_post")
    @app.delete("/api/attachments", operation_id="legacy_attachments_delete")
    async def legacy(request: Request):
        return await execute(request, False)

    @app.get("/api/admin/attachments/operations/{identifier}")
    async def receipt(identifier: UUID, request: Request):
        return JSONResponse(
            await service.receipt(await member(request, True), identifier),
            headers={"Cache-Control": "private, no-store"},
        )

    @app.get("/api/admin/attachments/versions/{identifier}")
    async def version(identifier: UUID, request: Request):
        if request.query_params:
            raise HTTPException(400, "查询字段无效")
        row, stream = await service.content(await member(request, True), version=identifier)
        return content(request, row, stream)
