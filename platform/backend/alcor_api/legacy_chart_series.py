"""Actual licensed minute-bar closes; no price interpolation or calendar-day padding."""

import asyncio
import gzip
import json
import math
import re
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse, Response

from .card_preferences import JS_WHITESPACE
from .legacy_history_bars import history_member, legacy_number
from .legacy_identity import assert_native_origin
from .legacy_quote_api import gzip_allowed
from .market_contract import CURRENCIES, ZONES, number
from .market_contract import code as security_code
from .market_history_reads import LicensedHistory
from .profile_http import bounded_body


def minute_points(rows, policy, query, days, now=None, *, session_day=False):
    now = now or datetime.now(UTC)
    points, conflicts = {}, set()
    zone = ZoneInfo(ZONES[query.market])
    for row in rows:
        value = row["contents"]
        try:
            at = datetime.fromisoformat(value["at"])
            real_time = getattr(query, "kind", "bars") == "price_series"
            source_point = (policy.source == 'tencent' and policy.source_version == 'tencent-minute-v1'
                            and value.get('dataKind') == 'provider_observed_minute_price')
            if real_time and not source_point and (value.get("dataKind") != "provider_real_time_time_frame" or value.get("sourceBlank") is not False):
                continue
            price = float(number(value["price"] if real_time else value["c"], positive=True))
            if (
                at.tzinfo is None
                or at != row["source_time"]
                or at > now + timedelta(seconds=5)
                or at < now - timedelta(days=35)
                or not math.isfinite(price)
                or value.get("source") != policy.source
                or value.get("sourceVersion") != policy.source_version
                or value.get("currency") != CURRENCIES[query.market]
                or value.get("session") != query.session
            ):
                continue
            local = at.astimezone(zone)
            date, time = local.date().isoformat(), local.strftime("%H:%M")
            if session_day and query.market == "US" and not "04:00" <= time < "20:00":
                continue
            if days == 5 and query.market == "US" and not "09:30" <= time <= "16:00":
                continue
            key = date + " " + time
            point = {"date": date, "time": time, "price": price, "volume": None}
            volume_field = "volume" if real_time else "v"
            if value.get(volume_field) is not None:
                volume = float(number(value[volume_field]))
                if math.isfinite(volume):
                    point["volume"] = volume
            if key in points and points[key]["price"] != price:
                conflicts.add(key)
            points[key] = point
        except (KeyError, TypeError, ValueError, OverflowError):
            continue
    points = [point for key, point in sorted(points.items()) if key not in conflicts]

    def session_date(point):
        date = point["date"]
        if query.market == "US" and days == 1 and not session_day and point["time"] >= "20:00":
            return (datetime.fromisoformat(date) + timedelta(days=1)).date().isoformat()
        return date

    dates = list(dict.fromkeys(session_date(point) for point in points))[-days:]
    return [point for point in points if session_date(point) in dates]


def sample_points(points, target=60):
    if len(points) <= target:
        return points
    middle, buckets = len(points) - 2, max(1, math.floor((max(4, target) - 2) / 2))
    out = [points[0]]
    for bucket in range(buckets):
        start, end = 1 + bucket * middle // buckets, 1 + (bucket + 1) * middle // buckets
        low = high = start
        for index in range(start + 1, end):
            if points[index]["price"] < points[low]["price"]:
                low = index
            if points[index]["price"] > points[high]["price"]:
                high = index
        out.extend(points[index] for index in sorted({low, high}))
    return out + [points[-1]]


async def read_minute_rows(history, who, market, symbol, *, session, source_revision):
    """Read OHLC closes or independently licensed RT observations; never convert RT to bars."""
    arguments = {"frame": "minute", "adjust": "none", "session": session,
                 "source_revision": source_revision, "limit": 16001}
    try:
        return await history.read(who, market, symbol, **arguments)
    except HTTPException as exc:
        if exc.status_code != 503 or (exc.headers or {}).get('Retry-After'):
            raise
    return await history.read(who, market, symbol, kind="price_series", **arguments)


def mount_legacy_chart_series(app, settings, authority):
    history = LicensedHistory(authority,automatic=True)

    async def observed(request, who, market, symbol, days, *, sessions=False, minimum_points=2):
        session = "ALL" if market == "US" and (days == 1 or sessions) else "REGULAR"
        rows, policy, query, revision = await read_minute_rows(
            history, who, market, symbol, session=session,
            source_revision=request.headers.get("x-alcor-market-source"),
        )
        if len(rows) > 16000:
            raise HTTPException(503, "分时原始记录超过读取预算")
        points = minute_points(rows, policy, query, days, authority.clock() if authority.clock else None, session_day=sessions)
        if len(points) < minimum_points:
            raise HTTPException(503, "尚无足够的真实分时观察点")
        return points, policy.source, revision

    async def response(request, mode, version=None):
        headers = {
            "Cache-Control": "private, no-store",
            "Vary": "Authorization, Cookie, Accept-Encoding",
            "X-Alcor-History-Coverage": "unknown",
        }
        if version:
            headers["X-Alcor-API-Version"] = str(version)
        try:
            assert_native_origin(request, settings)
            who = (
                await history_member(request, authority.db, version)
                if "authorization" in request.headers
                else None
            )
            params = request.query_params
            market, symbol = params.get("market", "").upper(), params.get("code", "").upper()
            if mode in ("sessions", "five"):
                symbol = re.sub(r"\.(OQ|N|AM|PS|K)$", "", symbol)
                if market != "US":
                    raise HTTPException(
                        400, "扩展时段首版仅支持美股" if mode == "sessions" else "五日分钟行情首版仅支持美股"
                    )
                days = 1 if mode == "sessions" else 5
            else:
                days = legacy_number(params.get("days", ""))
                if (
                    market not in ("US", "HK", "CN", "JP", "KR")
                    or days not in (1, 5)
                    or not re.fullmatch(r"[A-Z0-9._-]{1,40}", symbol)
                ):
                    raise HTTPException(400, "分时参数无效")
                days = int(days)
            if not re.fullmatch(r"[A-Z0-9._-]{1,40}", symbol):
                raise HTTPException(400, "股票代码不合法")
            who = who or await history_member(request, authority.db, version)
            if not await app.state.read_rate_limit(
                authority.db, "chart-series:" + who.id, 90, window_seconds=60
            ) or not await app.state.read_rate_limit(authority.db, "chart-series-global", 500, window_seconds=60):
                raise HTTPException(429, "请求过于频繁，请稍后重试")
            points, source, revision = await observed(
                request, who, market, symbol, days, sessions=mode == "sessions",
                minimum_points=2 if mode == "series" else 1,
            )
            if mode == "sessions":
                selected = []
                for point in points:
                    time = point["time"]
                    session = (
                        "PRE"
                        if "04:00" <= time < "09:30"
                        else "REGULAR"
                        if "09:30" <= time <= "16:00"
                        else "AFTER"
                        if "16:00" < time < "20:00"
                        else None
                    )
                    if session:
                        selected.append({**point, "session": session})
                if not selected:
                    raise HTTPException(503, "尚无该时段真实观察点")
                value = {
                    "market": market,
                    "code": symbol,
                    "points": selected,
                    "source": source,
                    "coverage": {"pre": "04:00-09:29", "regular": "09:30-16:00", "after": "16:01-19:59", "overnight": False},
                    "sessionClassificationAuthority": "legacy_clock_ranges_not_verified_trading_calendar",
                    "actualTradingSessionKnown": False,
                    "observedCoverage": {
                        "pre": any(p["session"] == "PRE" for p in selected),
                        "regular": any(p["session"] == "REGULAR" for p in selected),
                        "after": any(p["session"] == "AFTER" for p in selected),
                        "complete": None,
                    },
                }
            elif mode == "five":
                value = {"market": market, "code": symbol, "points": points, "source": source}
            else:
                value = {
                    "market": market,
                    "code": symbol,
                    "days": days,
                    "source": source,
                    "coverage": {
                        "overnight": market == "US"
                        and any(point["time"] < "04:00" or point["time"] >= "20:00" for point in points)
                    },
                    "points": [{key: point[key] for key in ("date", "time", "price")} for point in points],
                }
            value["observationCoverage"] = {"requestedDays": days,
                "observedLocalDates": sorted({point["date"] for point in points}),
                "assurance": "observed_points_only", "complete": None}
            headers["X-Alcor-Market-Source"] = revision
            return JSONResponse(
                {"code": 0, "message": "ok", "data": value} if version else value, headers=headers
            )
        except HTTPException as exc:
            headers.update(exc.headers or {})
            if exc.status_code in (401, 403):
                headers["X-Alcor-Retire-Context"] = "true"
            return JSONResponse(
                {
                    "code": 50002 if exc.status_code >= 500 else exc.status_code * 100 + 1,
                    "message": str(exc.detail),
                }
                if version
                else {"error": str(exc.detail)},
                status_code=exc.status_code,
                headers=headers,
            )

    @app.get("/api/v1/chart-series")
    async def series_v1(request: Request):
        return await response(request, "series", 1)

    @app.get("/api/v2/chart-series")
    async def series_v2(request: Request):
        return await response(request, "series", 2)

    @app.get("/api/kline/session-day")
    async def sessions_web(request: Request):
        return await response(request, "sessions")

    @app.get("/api/v1/kline-sessions")
    async def sessions_v1(request: Request):
        return await response(request, "sessions", 1)

    @app.get("/api/v2/kline-sessions")
    async def sessions_v2(request: Request):
        return await response(request, "sessions", 2)

    @app.get("/api/kline/five-day")
    async def five(request: Request):
        return await response(request, "five")

    async def charts(request, version=None):
        headers = {"Cache-Control": "private, no-store", "Vary": "Cookie, Authorization, Accept-Encoding"}
        if version:
            headers["X-Alcor-API-Version"] = str(version)
        try:
            assert_native_origin(request, settings)
            client = request.client.host if request.client else "unknown"
            if not await app.state.read_rate_limit(
                authority.db, "charts-ip:" + client, 120, window_seconds=60
            ) or not await app.state.read_rate_limit(authority.db, "charts-global", 600, window_seconds=60):
                raise HTTPException(429, "请求过于频繁，请稍后再试")
            who = (
                await history_member(request, authority.db, version)
                if "authorization" in request.headers
                else None
            )
            try:
                body = json.loads(
                    await bounded_body(request, 65536),
                    parse_constant=lambda _: (_ for _ in ()).throw(ValueError()),
                )
            except (ValueError, UnicodeError, RecursionError):
                body = None
            raw = body.get("items") if isinstance(body, dict) else None
            raw = raw if isinstance(raw, list) else []
            if len(raw) > 100:
                raise HTTPException(400, "单次最多获取 100 只走势")
            if not raw:
                data = {"charts": {}}
            else:
                items = []
                for item in raw:
                    if (
                        not isinstance(item, dict)
                        or not isinstance(item.get("id"), str)
                        or len(item["id"].encode("utf-16-le", "surrogatepass")) // 2 > 100
                        or not isinstance(item.get("code"), str)
                        or not re.fullmatch(r"[A-Za-z0-9._-]{1,40}", item["code"].strip(JS_WHITESPACE))
                    ):
                        continue
                    try:
                        item["id"].encode("utf-8")
                    except UnicodeError:
                        continue
                    market = item.get("market") if isinstance(item.get("market"), str) else "OTHER"
                    items.append(
                        {
                            "id": item["id"],
                            "market": market.strip(JS_WHITESPACE) or "OTHER",
                            "code": item["code"].strip(JS_WHITESPACE),
                        }
                    )
                if not items:
                    raise HTTPException(400, "没有有效的股票代码")
                identities = {}
                for item in items:
                    try:
                        identity = (item["market"], security_code(item["market"], item["code"]))
                    except ValueError:
                        identity = (item["market"], item["code"])
                    if item["id"] in identities and identities[item["id"]] != identity:
                        raise HTTPException(400, "重复走势编号对应不同证券")
                    identities[item["id"]] = identity
                who = who or await history_member(request, authority.db, version)
                if not await app.state.read_rate_limit(authority.db, "charts:" + who.id, 120, window_seconds=60):
                    raise HTTPException(429, "请求过于频繁，请稍后再试")
                # POST is explicit observation intent; the same scope checks as
                # quote registration apply, and collection stays in the Worker.
                from .market_history_demands import prepare
                from .market_subscription_writes import subscription_items
                from .legacy_identity import native_identity
                from uuid import UUID,uuid4
                try:
                    writer=who
                    if getattr(who,'native_client',False):writer,_=await native_identity(request,authority.db,'portfolio.write')
                    normalized=subscription_items({'items':[{'market':i['market'],'code':i['code']} for i in items if i['market'] in ('US','HK','CN')]})
                    identifier = request.headers.get('x-alcor-request-id')
                    await prepare(
                        authority, writer, UUID(identifier) if identifier else uuid4(), normalized, 5,
                        minute=True, observation=True, opportunistic=not identifier,
                    )
                except (HTTPException,ValueError):
                    # Read-only App grants may consume already observed facts.
                    # A failed registration never fabricates or replays a fact.
                    pass
                values = {}
                for item in items:
                    try:
                        rows, policy, query, _ = await read_minute_rows(
                            history, who, item["market"], item["code"],
                            session="ALL" if item["market"] == "US" else "REGULAR",
                            source_revision=request.headers.get("x-alcor-market-source"),
                        )
                        if len(rows) > 16000:
                            raise HTTPException(503, "分时原始记录超过读取预算")
                        points = minute_points(
                            rows, policy, query, 1, authority.clock() if authority.clock else None,
                            session_day=item["market"] == "US",
                        )
                        if len(points) < 2:
                            continue
                        latest = max(point["date"] for point in points)
                        selected = [
                            {key: point[key] for key in ("time", "price", "volume")}
                            for point in points
                            if point["date"] == latest
                        ]
                        source_time = datetime.fromisoformat(latest + "T" + selected[-1]["time"]).replace(
                            tzinfo=ZoneInfo(ZONES[item["market"]])
                        )
                        values[item["id"]] = {
                            "date": latest,
                            "stale": None,
                            "sourceObservedAt": source_time.isoformat(),
                            "expectedSessionKnown": False,
                            "points": sample_points(selected) if body.get("sample") is True else selected,
                            "source": policy.source,
                        }
                    except HTTPException as exc:
                        if exc.status_code in (401, 403, 409):
                            raise
                data = {"charts": values}
                headers["X-Alcor-Chart-State"] = "observed" if len(values) == len(identities) else "partial"
            raw = json.dumps(
                {"code": 0, "message": "ok", "data": data} if version else data,
                ensure_ascii=False,
                allow_nan=False,
                separators=(",", ":"),
            ).encode()
            if gzip_allowed(request.headers.get("accept-encoding", "")):
                packed = await asyncio.to_thread(gzip.compress, raw, mtime=0)
                if len(packed) < len(raw):
                    raw = packed
                    headers["Content-Encoding"] = "gzip"
            return Response(raw, media_type="application/json", headers=headers)
        except HTTPException as exc:
            headers.update(exc.headers or {})
            if exc.status_code in (401, 403):
                headers["X-Alcor-Retire-Context"] = "true"
            return JSONResponse(
                {
                    "code": 50002 if exc.status_code >= 500 else exc.status_code * 100 + 1,
                    "message": str(exc.detail),
                }
                if version
                else {"error": str(exc.detail)},
                status_code=exc.status_code,
                headers=headers,
            )

    @app.post("/api/charts")
    async def charts_web(request: Request):
        return await charts(request)

    @app.post("/api/v1/charts")
    async def charts_v1(request: Request):
        return await charts(request, 1)

    @app.post("/api/v2/charts")
    async def charts_v2(request: Request):
        return await charts(request, 2)
