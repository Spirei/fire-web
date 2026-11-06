"""Legacy month-close shapes over licensed, immutable history facts only."""

import math
import re
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse

from .card_preferences import JS_WHITESPACE
from .legacy_identity import OLD_COOKIE, WEB_COOKIE, assert_native_origin, native_identity, web_identity
from .market_contract import CURRENCIES, ZONES, number
from .market_history_reads import LicensedHistory
from .native_app_auth import CLIENT
from .security import COOKIE, identity


def monthly_series(rows, policy, market):
    """No interpolation, snapshot-to-history conversion, or missing-month fill."""
    values = {}
    for row in rows:
        value = row["contents"]
        try:
            stamp = datetime.fromisoformat(value["at"])
            close = float(number(value["c"], positive=True))
            if (
                stamp.tzinfo is None
                or stamp != row["source_time"]
                or value.get("source") != policy.source
                or value.get("sourceVersion") != policy.source_version
                or value.get("currency") != CURRENCIES[market]
                or value.get("session") != "REGULAR"
                or not math.isfinite(close)
                or close <= 0
            ):
                raise ValueError()
        except (KeyError, TypeError, ValueError, OverflowError) as exc:
            raise HTTPException(503, "月K原始事实无法核对") from exc
        month = stamp.astimezone(ZoneInfo(ZONES[market])).strftime("%Y-%m")
        previous = values.get(month)
        order = (stamp, row["sequence"])
        if previous is None or order > previous[0]:
            values[month] = (order, close)
    months = sorted(values)
    return {"months": months, "closes": [values[month][1] for month in months]}


class MonthlyHistory:
    def __init__(self, authority):
        self.authority, self.db = authority, authority.db

    async def read(self, who, market, symbol, source_revision=None, adjust=None):
        if adjust not in {None, "none", "qfq", "hfq"}:
            raise HTTPException(400, "复权口径无效")
        rows, policy, query, revision = await LicensedHistory(self.authority).read(
            who, market, symbol, frame="month", adjust=adjust,
            source_revision=source_revision, limit=2049,
        )
        if len(rows) > 2048:
            raise HTTPException(503, "月K原始事实超过单次核对范围")
        now = self.authority.clock() if self.authority.clock else datetime.now(UTC)
        if any(row["source_time"] > now + timedelta(seconds=5) for row in rows):
            raise HTTPException(503, "月K事实包含未来时间，未作为已发生历史提供")
        return monthly_series(rows, policy, market), {"sourceRevision": revision, "adjust": query.adjust}


def mount_legacy_monthly_kline(app, settings, authority):
    service = MonthlyHistory(authority)
    app.state.monthly_history = service

    async def member(request, version):
        header = request.headers.get("authorization")
        if version == 2 or header is not None and header.startswith("Bearer fat_"):
            who, grant = await native_identity(request, authority.db, "portfolio.read")
            if grant["client_id"] != CLIENT:
                raise HTTPException(401, "客户端连接已变化")
            return who
        if version == 1 or request.cookies.get(OLD_COOKIE) or request.cookies.get(WEB_COOKIE):
            return (await web_identity(request, authority.db, allow_v1_bearer=version == 1))[0]
        if header is None and request.cookies.get(COOKIE):
            return await identity(request)
        raise HTTPException(401, "月K历史需要本人登录及当前来源许可")

    async def execute(request, version=None):
        headers = {"Cache-Control": "private, no-store", "Vary": "Cookie, Authorization",
                   "X-Alcor-History-Coverage": "unknown"}
        if version:
            headers["X-Alcor-API-Version"] = str(version)
        try:
            assert_native_origin(request, settings)
            who = await member(request, version) if "authorization" in request.headers else None
            for key, maximum in (("kline:" + str(request.client.host if request.client else "unknown"), 120),
                                 ("kline-global", 600)):
                if not await app.state.rate_limit(authority.db, key, maximum, window_seconds=60):
                    raise HTTPException(429, "请求过于频繁，请稍后再试")
            market = request.query_params.get("market", "").strip(JS_WHITESPACE).upper()
            symbol = request.query_params.get("code", "").strip(JS_WHITESPACE).upper()
            if not symbol:
                raise HTTPException(400, "缺少代码")
            if not re.fullmatch(r"[A-Z0-9._-]{1," + ("40" if version else "32") + r"}", symbol):
                raise HTTPException(400, "股票代码不合法")
            if market not in {"US", "HK", "CN", "JP", "KR"}:
                if version:
                    raise HTTPException(400, "暂不支持该市场")
                return JSONResponse({"closes": []}, headers=headers)
            who = who or await member(request, version)
            value, metadata = await service.read(
                who, market, symbol, request.headers.get("x-alcor-market-source"),
                request.headers.get("x-alcor-market-adjust"),
            )
            headers.update({"X-Alcor-Market-Source": metadata["sourceRevision"],
                            "X-Alcor-Market-Adjust": metadata["adjust"]})
            return JSONResponse({"code": 0, "message": "ok", "data": value} if version
                                else {"closes": value["closes"][-12:]}, headers=headers)
        except HTTPException as exc:
            if exc.status_code in (401, 403):
                headers["X-Alcor-Retire-Context"] = "true"
            return JSONResponse({"code": 50002 if exc.status_code >= 500 else exc.status_code * 100 + 1,
                                 "message": str(exc.detail)} if version else {"error": str(exc.detail)},
                                status_code=exc.status_code, headers=headers)

    @app.get("/api/kline")
    async def web_months(request: Request):
        return await execute(request)

    @app.get("/api/v1/kline")
    async def v1_months(request: Request):
        return await execute(request, 1)

    @app.get("/api/v2/kline")
    async def v2_months(request: Request):
        return await execute(request, 2)
