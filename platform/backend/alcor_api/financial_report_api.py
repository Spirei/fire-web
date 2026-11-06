"""Private administrator report files; legacy v1 uses the same PG authority."""

from urllib.parse import quote
from uuid import UUID, uuid4

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.background import BackgroundTask
from starlette.datastructures import UploadFile

from .financial_reports import FinancialReports
from .legacy_identity import legacy_me_mutation_trusted, web_identity
from .profile_http import bounded_body
from .security import administrator


def mount_financial_reports(app, settings, db):
    service = FinancialReports(db)
    app.state.financial_reports = service
    headers = {
        "Cache-Control": "private, no-store",
        "Vary": "Cookie, Authorization",
        "X-Alcor-Source-Coverage": "platform-only",
    }

    async def member(request, legacy=False):
        if legacy:
            if request.method not in ("GET", "HEAD") and not legacy_me_mutation_trusted(request):
                raise HTTPException(401, "未登录")
            try:
                who = (await web_identity(request, db, allow_legacy_bearer=True))[0]
            except HTTPException:
                raise HTTPException(401, "未登录") from None
            if who.role != "admin":
                raise HTTPException(403, "需要管理员权限")
            return who
        if "authorization" in request.headers:
            raise HTTPException(403, "请使用当前网页管理员会话")
        return await administrator(request)

    def error(exc, legacy):
        return JSONResponse(
            {"code": exc.status_code * 100 + 1, "message": str(exc.detail)}
            if legacy
            else {"error": str(exc.detail)},
            status_code=exc.status_code,
            headers={
                **headers,
                **({"X-Alcor-Retire-Context": "true"} if exc.status_code in (401, 403) else {}),
            },
        )

    async def revision(who, request, data, legacy):
        raw_id = request.headers.get("x-alcor-request-id") if legacy else data.get("requestId")
        raw_revision = (
            request.headers.get("x-alcor-reports-revision") if legacy else data.get("expectedRevision")
        )
        try:
            identifier = UUID(raw_id) if raw_id is not None else uuid4() if legacy else None
            if identifier is None:
                raise ValueError()
        except (TypeError, ValueError):
            raise HTTPException(400, "原操作编号无效") from None
        if legacy and raw_id is not None and raw_revision is None:
            raise HTTPException(400, "请同时提供原操作编号和集合版本")
        if raw_revision is None and legacy:
            expected = (await service.listing(who, {}))["revision"]
        elif (
            isinstance(raw_revision, str)
            and raw_revision.isascii()
            and raw_revision.isdecimal()
            and len(raw_revision) < 17
        ):
            expected = int(raw_revision)
        else:
            raise HTTPException(400, "集合版本无效")
        return identifier, expected

    async def list_reports(request, legacy=False):
        try:
            who = await member(request, legacy)
            filters = {
                key: request.query_params.getlist(key)[0].strip().upper()
                for key in ("market", "exchange", "code")
                if request.query_params.getlist(key) and request.query_params.getlist(key)[0]
            }
            value = await service.listing(who, filters)
            return JSONResponse(
                {"code": 0, "message": "ok", "data": value["reports"]} if legacy else value,
                headers={**headers, "X-Alcor-Reports-Revision": str(value["revision"])},
            )
        except HTTPException as exc:
            return error(exc, legacy)

    async def upload(request, legacy=False):
        try:
            who = await member(request, legacy)
            await bounded_body(request, 50 * 1024 * 1024 + 65536)
            async with request.form(max_files=1, max_fields=12, max_part_size=4096) as form:
                file = form.get("file")
                if not isinstance(file, UploadFile):
                    raise HTTPException(400, "请选择财报文件")
                allowed = {
                    "file",
                    "market",
                    "exchange",
                    "code",
                    "companyName",
                    "fiscalYear",
                    "fiscalPeriod",
                    "reportType",
                } | (set() if legacy else {"requestId", "expectedRevision"})
                if set(form) - allowed or any(len(form.getlist(key)) != 1 for key in form):
                    raise HTTPException(400, "财报字段无效")
                data = {key: value for key, value in form.items() if key != "file"}
                if any(not isinstance(value, str) for value in data.values()):
                    raise HTTPException(400, "财报字段无效")
                request_id, expected = await revision(who, request, data, legacy)
                raw = await file.read(50 * 1024 * 1024 + 1)
                result = await service.upload(who, request_id, expected, data, file.filename or "", raw)
            extra = {
                **headers,
                "X-Alcor-Request-Id": str(request_id),
                "X-Alcor-Reports-Revision": str(result["revision"]),
            }
            return JSONResponse(
                {"code": 0, "message": "ok", "data": result["report"]} if legacy else result,
                status_code=200 if legacy else 201,
                headers=extra,
            )
        except HTTPException as exc:
            return error(exc, legacy)

    async def delete(request, identifier, legacy=False):
        try:
            who = await member(request, legacy)
            data = {} if legacy else dict(request.query_params)
            request_id, expected = await revision(who, request, data, legacy)
            result = await service.delete(who, request_id, expected, identifier)
            return JSONResponse(
                {"code": 0, "message": "ok", "data": {"deleted": True}} if legacy else result,
                headers={
                    **headers,
                    "X-Alcor-Request-Id": str(request_id),
                    "X-Alcor-Reports-Revision": str(result["revision"]),
                },
            )
        except HTTPException as exc:
            return error(exc, legacy)

    @app.get("/api/financial-reports")
    async def canonical_list(request: Request):
        return await list_reports(request)

    @app.post("/api/financial-reports")
    async def canonical_upload(request: Request):
        return await upload(request)

    @app.delete("/api/financial-reports/{identifier}")
    async def canonical_delete(identifier: str, request: Request):
        return await delete(request, identifier)

    @app.get("/api/v1/financial-reports")
    async def legacy_list(request: Request):
        return await list_reports(request, True)

    @app.post("/api/v1/financial-reports")
    async def legacy_upload(request: Request):
        return await upload(request, True)

    @app.delete("/api/v1/financial-reports/{identifier}")
    async def legacy_delete(identifier: str, request: Request):
        return await delete(request, identifier, True)

    @app.get("/api/financial-reports/operations/{request_id}")
    async def receipt(request_id: UUID, request: Request):
        try:
            return JSONResponse(await service.receipt(await member(request), request_id), headers=headers)
        except HTTPException as exc:
            return error(exc, False)

    @app.post("/api/financial-reports/operations/{request_id}/close")
    async def close(request_id: UUID, request: Request):
        try:
            who = await member(request)
            raw = await bounded_body(request, 128)
            if raw.strip() not in (b"", b"{}"):
                raise HTTPException(400, "关闭请求不能携带财报内容")
            return JSONResponse(await service.close(who, request_id), headers=headers)
        except HTTPException as exc:
            return error(exc, False)

    @app.get("/api/financial-reports/{identifier}/original")
    async def original(identifier: str, request: Request):
        try:
            # The returned legacy DTO points here too. No upload directory is public.
            legacy = not request.cookies.get("alcor_session")
            who = await member(request, legacy)
            row, stream = await service.original(who, identifier)
            return StreamingResponse(
                iter(lambda: stream.read(1024 * 1024), b""),
                media_type=row["mime_type"],
                headers={
                    **headers,
                    "Content-Disposition": "attachment; filename*=UTF-8''" + quote(row["file_name"], safe=""),
                    "X-Content-Type-Options": "nosniff",
                    "Content-Length": str(row["byte_length"]),
                },
                background=BackgroundTask(stream.close),
            )
        except HTTPException as exc:
            return error(exc, False)
