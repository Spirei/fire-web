"""Thin old v1/v2 and canonical native personal-profile adapters."""

from fastapi import HTTPException, Request, Response
from starlette.datastructures import UploadFile

from .legacy_identity import (
    LegacyError,
    assert_native_origin,
    body,
    envelope,
    native_identity,
    native_version,
)
from .personal_profiles import PersonalProfiles
from .profile_http import bounded_body
from .security import digest, identity


def mount_personal_profiles(app, settings, db, rate_limit):
    service = PersonalProfiles(db)
    app.state.personal_profiles = service

    async def execute(request, action, requestId=None, version=None, platform=False):
        assert_native_origin(request, settings)
        if platform:
            if "authorization" in request.headers:
                raise HTTPException(403, "请使用当前网页登录会话")
            who = await identity(request)
        else:
            who, _ = await native_identity(
                request, db, "portfolio.read" if request.method == "GET" else "profile.write"
            )
        sha256 = None
        if request.query_params:
            if (
                request.method != "GET"
                or action != "background"
                or list(request.query_params) != ["sha256"]
                or len(request.query_params.getlist("sha256")) != 1
            ):
                raise HTTPException(400, "不支持查询参数")
            sha256 = request.query_params["sha256"]
        path = (
            "/api/account/personal-profile/background"
            if platform
            else f"/api/v{version}/personal-profile/background"
            if version
            else "/api/client/personal-profile/background"
        )
        if request.method == "GET":
            if action == "operation":
                return await service.receipt(who, requestId, path)
            if action == "profile":
                return await service.read(who, path)
            raw, kind = await service.background(who, sha256)
            return Response(
                raw,
                media_type=kind,
                headers={
                    "Cache-Control": "no-store, private",
                    "X-Content-Type-Options": "nosniff",
                    "Content-Disposition": "inline",
                },
            )
        if not await rate_limit(db, digest("personal-profile:" + who.id), 30, window_seconds=60):
            raise HTTPException(429, "保存过于频繁")
        media = None
        if action == "background":
            if not request.headers.get("content-type", "").startswith("multipart/form-data;"):
                raise HTTPException(400, "需要图片表单")
            await bounded_body(request, 8388608 + 16384)
            form = await request.form(max_files=1, max_fields=4)
            if (
                set(form) - {"file", "requestId", "revision", "migration"}
                or any(len(form.getlist(k)) != 1 for k in ("file", "requestId", "revision"))
                or len(form.getlist("migration")) > 1
            ):
                raise HTTPException(400, "表单无效")
            file = form["file"]
            rev = form["revision"]
            migration = form.get("migration")
            if (
                not isinstance(file, UploadFile)
                or file.content_type != "image/jpeg"
                or not isinstance(rev, str)
                or not rev.isascii()
                or not rev.isdecimal()
                or (len(rev) > 1 and rev.startswith("0"))
                or migration not in (None, "true", "false")
            ):
                raise HTTPException(400, "图片或版本无效")
            media = await file.read()
            raw = {"requestId": form["requestId"], "revision": int(rev), "migration": migration == "true"}
        else:
            if request.headers.get("content-type", "").split(";")[0] != "application/json":
                raise HTTPException(400, "需要JSON请求")
            await bounded_body(request, 16384)
            raw = await body(request, ("requestId", "revision", "changes", "migration"), 16384)
        result, error = await service.mutate(who, raw, path, request.state.request_id, media)
        if error:
            raise LegacyError(error.status_code, result["code"], str(error.detail))
        return result

    @app.get("/api/v{version}/personal-profile")
    @app.patch("/api/v{version}/personal-profile")
    async def legacy_profile(version: int, request: Request, response: Response):
        native_version(request)
        return envelope(await execute(request, "profile", version=version), request, response)

    @app.get("/api/v{version}/personal-profile/background")
    @app.post("/api/v{version}/personal-profile/background")
    async def legacy_background(version: int, request: Request, response: Response):
        native_version(request)
        result = await execute(request, "background", version=version)
        return result if isinstance(result, Response) else envelope(result, request, response)

    @app.get("/api/v{version}/personal-profile/operations/{requestId}")
    async def legacy_receipt(version: int, requestId: str, request: Request, response: Response):
        native_version(request)
        return envelope(await execute(request, "operation", requestId, version), request, response)

    @app.get("/api/client/personal-profile")
    @app.patch("/api/client/personal-profile")
    async def canonical_profile(request: Request):
        return await execute(request, "profile")

    @app.get("/api/client/personal-profile/background")
    @app.post("/api/client/personal-profile/background")
    async def canonical_background(request: Request):
        return await execute(request, "background")

    @app.get("/api/client/personal-profile/operations/{requestId}")
    async def canonical_receipt(requestId: str, request: Request):
        return await execute(request, "operation", requestId)

    @app.get("/api/account/personal-profile")
    @app.patch("/api/account/personal-profile")
    async def platform_profile(request: Request):
        return await execute(request, "profile", platform=True)

    @app.get("/api/account/personal-profile/background")
    @app.post("/api/account/personal-profile/background")
    async def platform_background(request: Request):
        return await execute(request, "background", platform=True)

    @app.get("/api/account/personal-profile/operations/{requestId}")
    async def platform_receipt(requestId: str, request: Request):
        return await execute(request, "operation", requestId, platform=True)
