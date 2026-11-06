import re

from fastapi import HTTPException, Request, Response
from fastapi.responses import JSONResponse

from .market_calendar import Calendars


def mount_calendar(app, db, settings=None):
    service = Calendars(db)

    async def reference_identity(request):
        if "authorization" in request.headers:
            from .legacy_identity import native_identity

            who, _ = await native_identity(request, db)
            return who
        else:
            from .security import identity

            return await identity(request)

    async def read(request, batch, *, public_cache=True, who=None):
        try:
            from .legacy_identity import assert_native_origin, native_identity

            if settings is not None:
                assert_native_origin(request, settings)
            if request.headers.get('authorization') is not None:
                if not re.fullmatch(r'Bearer fat_[A-Za-z0-9_-]{43}', request.headers['authorization']):
                    raise HTTPException(401, '需要有效的 App 连接')
                who, _ = await native_identity(request, db)
                public_cache = False
        except HTTPException as exc:
            return JSONResponse({'code':getattr(exc,'business_code',exc.status_code*100+1),
                                 'message':str(exc.detail),'data':None},status_code=exc.status_code,
                                headers={'Cache-Control':'no-store, private','Vary':'Origin, Authorization, Cookie',
                                         **(exc.headers or {}),
                                         **({'X-Alcor-Retire-Context':'true'} if exc.status_code in (401,403) else {})})
        params = request.query_params
        year = params.get("year", "")
        market = params.get("market", "")
        valid = (
            len(params.getlist("year")) == 1
            and len(year) == 4
            and year.isascii()
            and year.isdecimal()
            and 2000 <= int(year) <= 2100
        )
        valid = valid and (
            not params.getlist("market") and not params.getlist("markets")
            if batch
            else len(params.getlist("market")) == 1 and market in ("CN", "HK", "US")
        )
        if not valid:
            return JSONResponse({"code": 40001, "message": "批量接口固定返回 CN、HK、US；只需传入 2000–2100 的四位 year" if batch else "market 必须为 CN、HK 或 US；year 必须为 2000–2100 的四位年份", "data": None}, status_code=400)
        try:
            data = await service.batch(int(year), who=who)
        except HTTPException as exc:
            return JSONResponse({'code':exc.status_code*100+1,'message':str(exc.detail),'data':None},
                                status_code=exc.status_code,headers={'Cache-Control':'no-store, private',
                                'Vary':'Origin, Authorization, Cookie','X-Alcor-Retire-Context':'true',**(exc.headers or {})})
        except (ValueError, TypeError, KeyError):
            return JSONResponse({'code':50301,'message':'日历来源完整性暂不可验证','data':None},
                                status_code=503,headers={'Cache-Control':'no-store, private'})
        if data is None:
            return JSONResponse({"code": 50301, "message": "日历来源尚未载入", "data": None}, status_code=503)
        key = f"batch-{year}" if batch else f"{market}-{year}"
        etag = f'"market-calendar-1-{data["calendarVersion"]}-{key}"'
        headers = {
            "ETag": etag,
            "Cache-Control": "public, max-age=300, must-revalidate" if public_cache else "no-store, private",
            "Vary": "Origin, Authorization" if public_cache else "Origin, Authorization, Cookie",
            "X-Alcor-API-Version": "2",
        }
        tags = [s.strip().removeprefix("W/") for s in request.headers.get("if-none-match", "").split(",")]
        if etag in tags or "*" in tags:
            return Response(status_code=304, headers=headers)
        return JSONResponse(
            {"code": 0, "message": "ok", "data": data if batch else data["calendars"][market]},
            headers=headers,
        )

    @app.get("/api/v2/market-calendar")
    async def single(request: Request):
        return await read(request, False)

    @app.get("/api/v2/market-calendar/batch")
    async def batch(request: Request):
        return await read(request, True)

    @app.get("/api/reference/calendar/discovery")
    async def discovery():
        descriptor = await service.discovery()
        if descriptor is None:
            return None
        return {
            **{key: value for key, value in descriptor.items() if key != "api_version"},
            "path": "/api/reference/calendar",
            "batch_path": "/api/reference/calendar/batch",
            "access": "authenticated",
            "legacy_public_paths": ["/api/v2/market-calendar", "/api/v2/market-calendar/batch"],
        }

    @app.get("/api/reference/calendar")
    async def canonical_calendar(request: Request):
        who = await reference_identity(request)
        return await read(request, False, public_cache=False, who=who)

    @app.get("/api/reference/calendar/batch")
    async def canonical_batch(request: Request):
        who = await reference_identity(request)
        return await read(request, True, public_cache=False, who=who)
