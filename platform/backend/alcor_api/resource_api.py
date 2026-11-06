"""Lossless native compatibility with a separate same-origin Web session entry."""

import asyncio
import json
import re
from urllib.parse import quote

from fastapi import HTTPException, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.datastructures import UploadFile
from starlette.requests import ClientDisconnect

from .legacy_identity import assert_native_origin, native_identity, native_version
from .profile_http import bounded_body
from .resource_contract import UPLOAD_LIMIT
from .resource_library import ResourceLibrary
from .security import digest, identity


class PrivateResourceResponse(StreamingResponse):
    def __init__(self, original, content, **kwargs):
        self.original = original
        super().__init__(content, **kwargs)

    async def __call__(self, scope, receive, send):
        try:
            return await super().__call__(scope, receive, send)
        finally:
            # Also covers disconnect before the iterator's first next(), when a
            # generator-level finally alone has not yet become active.
            self.original.close()


def byte_range(value, size):
    if value is None:
        return 0, size - 1
    match = re.fullmatch(r"bytes=(\d*)-(\d*)", value)
    if not match or not any(match.groups()):
        raise HTTPException(416, "下载范围无效")
    left, right = match.groups()
    if len(left) > 16 or len(right) > 16:
        raise HTTPException(416, "下载范围无效")
    if not left:
        suffix = int(right)
        if not 1 <= suffix <= 9007199254740991:
            raise HTTPException(416, "下载范围无效")
        return max(0, size - suffix), size - 1
    start = int(left)
    end = min(int(right), size - 1) if right else size - 1
    if start > 9007199254740991 or (right and int(right) > 9007199254740991) or start > end or start >= size:
        raise HTTPException(416, "下载范围无效")
    return start, end


def no_duplicate_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError()
        result[key] = value
    return result


def mount_resources(app, settings, db, rate_limit):
    service = ResourceLibrary(db)
    app.state.resource_library = service

    async def execute(request, action="", version=None, web=False):
        if version is not None:
            native_version(request)
        legacy = version is not None
        base = (
            "/api/resource-library"
            if web
            else f"/api/v{version}/resource-library"
            if legacy
            else "/api/client/resource-library"
        )
        headers = {"Cache-Control": "no-store, private"}
        if legacy:
            headers["X-Alcor-API-Version"] = str(version)
        try:
            assert_native_origin(request, settings)
            read = request.method == "GET"
            methods = {"": {"GET"}, "folders": {"GET", "POST"}, "files": {"GET", "POST"}}
            if not legacy:
                methods["folder-tree"] = {"GET"}
            parts = action.split("/")
            if len(parts) == 2 and parts[0] in ("folders", "files"):
                methods[action] = (
                    {"DELETE"}
                    | ({"GET"} if parts[0] == "files" else set())
                    | ({"PATCH"} if not legacy else set())
                )
            if len(parts) == 3 and parts[0] == "files" and parts[2] == "content":
                methods[action] = {"GET"}
            if len(parts) == 2 and parts[0] in ("uploads", "deletions", "operations"):
                methods[action] = {"GET"}
            if action not in methods:
                raise HTTPException(404, "接口不存在")
            if request.method not in methods[action]:
                raise HTTPException(405, "不支持此请求方法")
            if (
                action not in (("folders", "files") if legacy else ("folders", "files", "folder-tree"))
                and request.query_params
            ):
                raise HTTPException(400, "查询字段无效")
            if web:
                if "authorization" in request.headers:
                    raise HTTPException(403, "请使用当前网页登录会话")
                who = await identity(request)
            else:
                who, _ = await native_identity(request, db, "resources.read" if read else "resources.write")
            if not await rate_limit(db, digest("resources:" + who.id), 180, window_seconds=60):
                raise HTTPException(429, "请求过于频繁")
            if read:
                if len(parts) == 2 and parts[0] in ("uploads", "deletions", "operations"):
                    result = await service.receipt(
                        who, parts[1], base, {"uploads": "upload", "deletions": "delete"}.get(parts[0])
                    )
                elif len(parts) == 3:
                    if len(request.headers.getlist("range")) > 1:
                        raise HTTPException(416, "下载范围无效")
                    row, stream = await service.content(who, parts[1])
                    size = row["size_bytes"]
                    try:
                        start, end = byte_range(request.headers.get("range"), size)
                    except HTTPException:
                        stream.close()
                        return Response(
                            status_code=416, headers={**headers, "Content-Range": f"bytes */{size}"}
                        )
                    partial = "range" in request.headers
                    headers.update(
                        {
                            "Content-Type": row["mime"],
                            "Content-Disposition": "attachment; filename=\"download\"; filename*=UTF-8''"
                            + quote(row["name"], safe=""),
                            "Content-Security-Policy": "sandbox; default-src 'none'",
                            "X-Content-Type-Options": "nosniff",
                            "Accept-Ranges": "bytes",
                        }
                    )
                    if partial:
                        headers["Content-Range"] = f"bytes {start}-{end}/{size}"
                    headers["Content-Length"] = str(end - start + 1)

                    def chunks():
                        try:
                            stream.seek(start)
                            left = end - start + 1
                            while left:
                                chunk = stream.read(min(left, 1024 * 1024))
                                if not chunk:
                                    raise OSError("原文件在传输期间发生变化")
                                left -= len(chunk)
                                yield chunk
                        finally:
                            stream.close()

                    return PrivateResourceResponse(
                        stream, chunks(), status_code=206 if partial else 200, headers=headers
                    )
                else:
                    result = await service.read(
                        who, base, parts[1] if len(parts) == 2 else action, request.query_params
                    )
                return JSONResponse(
                    {"code": 0, "message": "ok", "data": result} if legacy else result, headers=headers
                )
            upload = None
            if action == "files" and request.method == "POST":
                if request.query_params:
                    raise HTTPException(400, "上传不接受查询参数")
                if request.headers.get("content-type", "").split(";")[0] != "multipart/form-data":
                    raise HTTPException(400, "需要文件表单")
                if not await rate_limit(db, digest("resource-upload:" + who.id), 30, window_seconds=3600):
                    raise HTTPException(429, "上传过于频繁")
                async with service.upload_slot(), asyncio.timeout(300):
                    async with request.form(max_files=1, max_fields=6, max_part_size=4096) as form:
                        allowed = {"file", "category", "folderId", "requestId", "name"} | (
                            {"folderRevision"} if not legacy else set()
                        )
                        if (
                            set(form) - allowed
                            or any(len(form.getlist(k)) != 1 for k in form)
                            or not isinstance(form.get("file"), UploadFile)
                        ):
                            raise HTTPException(400, "上传字段无效")
                        file = form["file"]
                        upload = await file.read(UPLOAD_LIMIT + 1)
                        if not 1 <= len(upload) <= UPLOAD_LIMIT:
                            raise HTTPException(413, "文件须为1字节至50MiB")
                        raw = {k: v for k, v in form.items() if k != "file"}
                        raw["name"] = raw.get("name", file.filename)
                        if any(not isinstance(v, str) for v in raw.values()):
                            raise HTTPException(400, "上传字段无效")
                        if "folderRevision" in raw:
                            value = raw["folderRevision"]
                            if not re.fullmatch(r"[1-9][0-9]{0,15}", value):
                                raise HTTPException(400, "版本无效")
                            raw["folderRevision"] = int(value)
                    # Parent/owner/grant/quota are checked under the mutation lock.
                    result, failure = await service.mutate(
                        who, "upload", raw, base, request.state.request_id, upload=upload, legacy=legacy
                    )
            else:
                if request.headers.get("content-type", "").split(";")[0] != "application/json":
                    raise HTTPException(400, "需要JSON请求")
                try:
                    raw = json.loads(await bounded_body(request, 4096), object_pairs_hook=no_duplicate_object)
                except (UnicodeError, ValueError):
                    raise HTTPException(400, "请求格式无效") from None
                kind = (
                    "folder_create"
                    if action == "folders"
                    else ("folder_" if parts[0] == "folders" else "file_")
                    + ("delete" if request.method == "DELETE" else "update")
                )
                if parts[0] == "files" and request.method == "DELETE":
                    kind = "delete"
                result, failure = await service.mutate(
                    who,
                    kind,
                    raw,
                    base,
                    request.state.request_id,
                    identifier=parts[1] if len(parts) == 2 else None,
                    legacy=legacy,
                )
            headers["X-Alcor-Resource-Request-ID"] = result["requestId"]
            if failure:
                return JSONResponse(
                    {"code": result["code"], "message": result["message"]}
                    if legacy
                    else {
                        "error": {"code": str(result["code"]), "message": result["message"]},
                        "requestId": result["requestId"],
                    },
                    status_code=failure.status_code,
                    headers=headers,
                )
            status = 201 if request.method == "POST" else 200
            return JSONResponse(
                {"code": 0, "message": "ok", "data": result["result"]} if legacy else result,
                status_code=status,
                headers=headers,
            )
        except ClientDisconnect:
            message = "请求已断开，请查询原操作"
            return JSONResponse(
                {"code": 49901, "message": message} if legacy else {"error": {"code": "request_disconnected", "message": message}},
                status_code=499,
                headers=headers,
            )
        except HTTPException as exc:
            if legacy:
                return JSONResponse(
                    {"code": exc.status_code * 100 + 1, "message": str(exc.detail)},
                    status_code=exc.status_code,
                    headers=headers,
                )
            raise

    async def cancel_original(request, identifier, *, web=False):
        assert_native_origin(request, settings)
        if request.query_params:
            raise HTTPException(400, "取消操作不接受查询参数")
        if web:
            if "authorization" in request.headers:
                raise HTTPException(403, "请使用当前网页登录会话")
            who = await identity(request)
        else:
            who, _ = await native_identity(request, db, "resources.write")
        if not await rate_limit(db, digest("resources:" + who.id), 180, window_seconds=60):
            raise HTTPException(429, "请求过于频繁")
        if request.headers.get("content-type", "").split(";")[0] != "application/json":
            raise HTTPException(400, "需要JSON请求")
        try:
            raw = json.loads(await bounded_body(request, 4096), object_pairs_hook=no_duplicate_object)
        except ClientDisconnect:
            raise HTTPException(499, "请求已断开，请查询原操作") from None
        except (UnicodeError, ValueError):
            raise HTTPException(400, "请求格式无效") from None
        base = "/api/resource-library" if web else "/api/client/resource-library"
        result = await service.cancel(who, identifier, raw, base, request.state.request_id)
        return JSONResponse(
            result,
            headers={
                "Cache-Control": "no-store, private",
                "X-Alcor-Resource-Request-ID": result["requestId"],
            },
        )

    @app.post("/api/resource-library/operations/{identifier}/cancel")
    async def web_cancel_original(identifier: str, request: Request):
        return await cancel_original(request, identifier, web=True)

    @app.post("/api/client/resource-library/operations/{identifier}/cancel")
    async def native_cancel_original(identifier: str, request: Request):
        return await cancel_original(request, identifier)

    def endpoint(action, versioned, web):
        if versioned:
            if "{identifier}" in action:

                async def native_item(request: Request, version: int, identifier: str):
                    return await execute(request, action.replace("{identifier}", identifier), version)

                return native_item

            async def native_collection(request: Request, version: int):
                return await execute(request, action, version)

            return native_collection
        if "{identifier}" in action:

            async def canonical_item(request: Request, identifier: str):
                return await execute(request, action.replace("{identifier}", identifier), web=web)

            return canonical_item

        async def canonical_collection(request: Request):
            return await execute(request, action, web=web)

        return canonical_collection

    for audience, prefix, versioned, web in (
        ("native", "/api/v{version}/resource-library", True, False),
        ("client", "/api/client/resource-library", False, False),
        ("web", "/api/resource-library", False, True),
    ):
        routes = {
            "": {"GET"},
            "folders": {"GET", "POST"},
            "files": {"GET", "POST"},
            "folders/{identifier}": {"DELETE"},
            "files/{identifier}": {"GET", "DELETE"},
            "files/{identifier}/content": {"GET"},
            "uploads/{identifier}": {"GET"},
            "deletions/{identifier}": {"GET"},
            "operations/{identifier}": {"GET"},
        }
        if not versioned:
            routes["folder-tree"] = {"GET"}
            routes["folders/{identifier}"].add("PATCH")
            routes["files/{identifier}"].add("PATCH")
        for action, methods in routes.items():
            handler = endpoint(action, versioned, web)
            for method in sorted(methods):
                identifier = re.sub(r"[^a-zA-Z0-9]", "_", action)
                app.add_api_route(
                    prefix + ("/" + action if action else ""),
                    handler,
                    methods=[method],
                    operation_id=f"resources_{audience}_{identifier}_{method.lower()}",
                )

    # Exact documented routes above are the advertised protocol. Hidden fallbacks
    # retain old 404/405 error envelopes without inventing executable actions.
    @app.api_route(
        "/api/v{version}/resource-library",
        methods=["GET", "POST", "DELETE", "PATCH"],
        include_in_schema=False,
    )
    @app.api_route(
        "/api/v{version}/resource-library/{action:path}",
        methods=["GET", "POST", "DELETE", "PATCH"],
        include_in_schema=False,
    )
    async def native_fallback(version: int, request: Request, action: str = ""):
        return await execute(request, action, version)

    @app.api_route(
        "/api/client/resource-library", methods=["GET", "POST", "DELETE", "PATCH"], include_in_schema=False
    )
    @app.api_route(
        "/api/client/resource-library/{action:path}",
        methods=["GET", "POST", "DELETE", "PATCH"],
        include_in_schema=False,
    )
    async def canonical_fallback(request: Request, action: str = ""):
        return await execute(request, action)

    @app.api_route(
        "/api/resource-library", methods=["GET", "POST", "DELETE", "PATCH"], include_in_schema=False
    )
    @app.api_route(
        "/api/resource-library/{action:path}",
        methods=["GET", "POST", "DELETE", "PATCH"],
        include_in_schema=False,
    )
    async def web_fallback(request: Request, action: str = ""):
        return await execute(request, action, web=True)
