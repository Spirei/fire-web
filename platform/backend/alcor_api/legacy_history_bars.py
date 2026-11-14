"""Old full OHLC protocol over explicit licensed period facts; never aggregate snapshots."""

import math
import re
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from psycopg.errors import LockNotAvailable

from .card_preferences import JS_WHITESPACE
from .legacy_identity import OLD_COOKIE, WEB_COOKIE, assert_native_origin, native_identity, web_identity
from .market_contract import CURRENCIES, ZONES, number
from .market_history_reads import LicensedHistory
from .market_yahoo_history import CRYPTOS
from .native_app_auth import CLIENT
from .security import COOKIE, identity


def legacy_number(raw):
    value = (raw or "").strip(JS_WHITESPACE)
    if not value:
        return 0.0
    try:
        if re.fullmatch(r"0[xX][a-fA-F0-9]+|0[bB][01]+|0[oO][0-7]+", value):
            try:
                return float(int(value, 0))
            except OverflowError:
                return math.inf
        if re.fullmatch(r"[+-]?(?:(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?|Infinity)", value):
            return float(value)
    except (ValueError, OverflowError):
        return math.nan
    return math.nan


def bar_limit(raw):
    numeric = legacy_number(raw)
    if not numeric or math.isnan(numeric):
        numeric = 320
    return math.floor(min(3300, max(60, numeric)))


def bar_rows(rows, policy, query, now=None):
    now = now or datetime.now(UTC)
    result = []
    for row in rows:
        value = row["contents"]
        try:
            stamp = datetime.fromisoformat(value["at"])
            if (
                stamp.tzinfo is None
                or stamp != row["source_time"]
                or stamp > now + timedelta(seconds=5)
                or value.get("source") != policy.source
                or value.get("sourceVersion") != policy.source_version
                or value.get("currency") != CURRENCIES[query.market]
                or value.get("session") != query.session
            ):
                raise ValueError()
            numeric = {key: float(number(value[key], positive=True)) for key in ("o", "h", "l", "c")}
            if (
                any(not math.isfinite(item) for item in numeric.values())
                or numeric["h"] < max(numeric.values())
                or numeric["l"] > min(numeric.values())
            ):
                raise ValueError()
            item = {
                "d": stamp.astimezone(ZoneInfo(ZONES[query.market])).date().isoformat(),
                **numeric,
                "v": None,
            }
            if value.get("v") is not None:
                volume = float(number(value["v"]))
                if not math.isfinite(volume):
                    raise ValueError()
                item["v"] = volume
            result.append(item)
        except (KeyError, TypeError, ValueError, OverflowError) as exc:
            raise HTTPException(503, "历史OHLC原始事实无法核对") from exc
    return result


def aggregate_observed_days(items, frame):
    """Original period rule: group actual daily OHLC; never fill a missing day."""
    groups = {}
    for item in items:
        date = datetime.fromisoformat(item["d"]).date()
        if frame == "week":
            key = (date - timedelta(days=date.weekday())).isoformat()
        elif frame == "quarter":
            key = (date.year, (date.month - 1) // 3)
        elif frame == "year":
            key = date.year
        else:
            key = (date.year, date.month)
        groups.setdefault(key, []).append(item)
    return [{"d": rows[-1]["d"], "o": rows[0]["o"], "h": max(row["h"] for row in rows),
             "l": min(row["l"] for row in rows), "c": rows[-1]["c"],
             "v": sum(row["v"] for row in rows) if all(row["v"] is not None for row in rows) else None}
            for rows in groups.values()]


async def history_member(request, db, version=None):
    from .legacy_optional_credentials import market_platform_session_selected

    if version is None and market_platform_session_selected(request):
        return await identity(request)
    header = request.headers.get("authorization")
    if version == 2 or header is not None and header.startswith("Bearer fat_"):
        who, grant = await native_identity(request, db, "portfolio.read")
        if grant["client_id"] != CLIENT:
            raise HTTPException(401, "客户端连接已变化")
        return who
    if version == 1 or request.cookies.get(OLD_COOKIE) or request.cookies.get(WEB_COOKIE):
        return (await web_identity(request, db, allow_v1_bearer=version == 1))[0]
    if header is None and request.cookies.get(COOKIE):
        return await identity(request)
    raise HTTPException(401, "历史行情需要本人登录及当前来源许可")


def mount_legacy_history_bars(app, settings, authority):
    service = LicensedHistory(authority,automatic=True)
    app.state.licensed_history = service

    @app.post('/api/kline/prepare')
    @app.post('/api/v1/kline/prepare')
    @app.post('/api/v2/kline/prepare')
    async def prepare_history(request: Request):
        from .legacy_identity import body
        from .market_subscription_writes import subscription_items
        from .market_history_demands import prepare
        from uuid import UUID
        assert_native_origin(request,settings)
        version=2 if request.url.path.startswith('/api/v2/') else 1 if request.url.path.startswith('/api/v1/') else None
        who=await history_member(request,authority.db,version)
        if getattr(who,'native_client',False):who,_=await native_identity(request,authority.db,'portfolio.write')
        raw=await body(request,('requestId','items','days','index','adjust','minute'))
        if set(raw)-{'requestId','items','days','index','adjust','minute'}:raise HTTPException(400,'历史需求字段无效')
        if type(raw.get('minute',False)) is not bool:raise HTTPException(400,'历史时间粒度无效')
        try:rid=UUID(str(raw['requestId']))
        except (ValueError,TypeError,KeyError):raise HTTPException(400,'请求编号无效') from None
        items=subscription_items({'items':raw.get('items')})
        for item in items:item['instrument']='index' if raw.get('index') is True else 'asset' if item['market']=='ASSET' else 'equity'
        try:
            result=await prepare(authority,who,rid,items,raw.get('days',330),adjust=raw.get('adjust','none'),minute=raw.get('minute',False))
        except LockNotAvailable:
            raise HTTPException(503,'历史采集登记繁忙，请稍后使用原请求编号重试',headers={'Retry-After':'3'}) from None
        versioned=request.url.path.startswith(('/api/v1/','/api/v2/'))
        return JSONResponse({'code':0,'message':'ok','data':result} if versioned else result,headers={'Cache-Control':'private, no-store'})

    @app.get('/api/kline/preparations/{request_id}')
    @app.get('/api/v1/kline/preparations/{request_id}')
    @app.get('/api/v2/kline/preparations/{request_id}')
    async def preparation_progress(request_id:str,request:Request):
        from uuid import UUID
        from .market_history_demands import progress
        assert_native_origin(request,settings)
        version=2 if request.url.path.startswith('/api/v2/') else 1 if request.url.path.startswith('/api/v1/') else None
        who=await history_member(request,authority.db,version)
        try:rid=UUID(request_id)
        except ValueError:raise HTTPException(400,'请求编号无效') from None
        if not await app.state.read_rate_limit(authority.db,'history-progress:'+who.id,180,window_seconds=60):raise HTTPException(429,'历史进度读取过于频繁')
        result=await progress(authority,who,rid)
        return JSONResponse({'code':0,'message':'ok','data':result} if version else result,headers={'Cache-Control':'private, no-store','Vary':'Cookie, Authorization'})

    @app.get("/api/kline/full")
    async def full(request: Request):
        headers = {
            "Cache-Control": "private, no-store",
            "Vary": "Cookie, Authorization",
            "X-Alcor-History-Coverage": "unknown",
        }
        try:
            assert_native_origin(request, settings)
            client = request.client.host if request.client else "unknown"
            if not await app.state.read_rate_limits(
                authority.db,
                (
                    ("kline-full-ip:" + client, 300),
                    ("kline-full-global", 600),
                ),
                window_seconds=60,
            ):
                raise HTTPException(429, "请求过于频繁，请稍后再试")
            who = await history_member(request, authority.db) if "authorization" in request.headers else None
            market = request.query_params.get("market", "").strip(JS_WHITESPACE).upper()
            symbol = request.query_params.get("code", "").strip(JS_WHITESPACE).upper()
            if not market or not symbol:
                raise HTTPException(400, "缺少 market / code")
            if not re.fullmatch(r"[A-Z0-9._-]{1,32}", symbol):
                raise HTTPException(400, "股票代码不合法")
            if market == "ASSET":
                if symbol not in CRYPTOS:
                    raise HTTPException(400, "暂不支持该加密货币")
            elif market not in ("US", "HK", "CN", "JP", "KR", "SG"):
                raise HTTPException(400, "暂不支持该市场")
            if market == "SG" and request.query_params.get("index") != "1":
                raise HTTPException(400, "暂不支持该市场")
            period = request.query_params.get("period", "").upper()
            frame = {"WEEK": "week", "MONTH": "month", "QUARTER": "quarter", "YEAR": "year"}.get(
                period, "day"
            )
            adjust = request.query_params.get("adjust", "").lower()
            adjust = adjust if adjust in ("none", "hfq") else "qfq"
            requested_adjust = adjust
            instrument = "asset" if market == "ASSET" else "index" if request.query_params.get("index") == "1" else "equity"
            if instrument in ("asset", "index"):
                # Index levels and raw crypto OHLC do not assert a stock split or
                # dividend adjustment. Never label these facts qfq by default.
                adjust = "none"
            who = who or await history_member(request, authority.db)
            if not await app.state.read_rate_limit(authority.db, "history-full:" + who.id, 300, window_seconds=60):
                raise HTTPException(429, "请求过于频繁，请稍后再试")
            rows, policy, query, revision = await service.read(
                who,
                market,
                symbol,
                frame="day",
                adjust=adjust,
                instrument=instrument,
                source_revision=request.headers.get("x-alcor-market-source"),
                limit=(12000 if frame == "year" else 3300) if frame != "day" else bar_limit(request.query_params.get("limit")),
            )
            items = bar_rows(rows, policy, query, authority.clock() if authority.clock else None)
            if frame != "day":
                items = aggregate_observed_days(items, frame)[-bar_limit(request.query_params.get("limit")):]
                headers["X-Alcor-Period-Aggregation"] = "last-observed-day"
            headers.update({"X-Alcor-Market-Source": revision, "X-Alcor-Market-Adjust": adjust})
            return JSONResponse(
                {
                    "market": market,
                    "code": symbol,
                    "period": period if frame != "day" else None,
                    "adjust": adjust,
                    "items": items,
                    "instrument": instrument,
                    **({"requestedAdjust": requested_adjust, "corporateAdjustmentNotApplicable": True}
                       if instrument in ("asset", "index") else {}),
                    **({"sourceSymbol": CRYPTOS[symbol], "priceSeriesToOhlc": False} if instrument == "asset" else {}),
                },
                headers=headers,
            )
        except HTTPException as exc:
            headers.update(exc.headers or {})
            if exc.status_code in (401, 403):
                headers["X-Alcor-Retire-Context"] = "true"
            return JSONResponse({"error": str(exc.detail)}, status_code=exc.status_code, headers=headers)

    from .legacy_chart_series import mount_legacy_chart_series

    mount_legacy_chart_series(app, settings, authority)

    from .legacy_stock_detail import mount_legacy_stock_detail

    mount_legacy_stock_detail(app, settings, authority)

    from .legacy_index_kline import mount_legacy_index_kline

    mount_legacy_index_kline(app, settings, authority)
