"""Legacy stock detail composes existing PG quote, FX and actual day-bar authorities."""

import math
import re
from datetime import UTC, datetime
from decimal import Decimal, localcontext

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse

from .card_preferences import JS_WHITESPACE
from .fx_reference import FxWorker
from .legacy_history_bars import bar_rows, history_member
from .legacy_identity import assert_native_origin
from .market_contract import CURRENCIES
from .market_history_reads import LicensedHistory
from .market_quote_selection import configured_quotes

QUOTE_FIELDS = (
    "name",
    "price",
    "change",
    "changePct",
    "open",
    "high",
    "low",
    "prevClose",
    "session",
    "volume",
    "amount",
    "pe",
    "turnover",
    "amplitude",
    "epsTtm",
    "weekHigh",
    "weekLow",
    "pb",
    "dividendYieldTtm",
    "volumeRatio",
    "totalShares",
    "floatShares",
    "staticPe",
    "dividendTtm",
    "averagePrice",
    "marketCap",
    "time",
    "source",
    "displayStale",
    "detailMetrics",
    "snapshotMetrics",
    "equityValid",
    "peTtm",
    "peBasis",
    "circularMarketVal",
    "earningPerShare",
    "earningPerSharePeriod",
    "fundValid",
    "fundUnits",
    "fundAssetsUnderManagement",
    "fundNetAssetValue",
    "fundMetrics",
    "marketCapBasis",
)
CURRENCIES_OUT = ("USD", "HKD", "CNY", "SGD", "JPY", "KRW", "EUR")


def observed_caps(cap, currency, rates):
    if cap is None:
        return None
    try:
        value = Decimal(str(cap))
        if not value.is_finite() or value <= 0:
            return None
        out = {currency: float(value)}
        base = Decimal(str(rates[currency])) if currency in rates else None
        if base is not None and base.is_finite() and base > 0:
            with localcontext() as context:
                context.prec = 80
                for target in CURRENCIES_OUT:
                    if target not in rates:
                        continue
                    rate = Decimal(str(rates[target]))
                    if not rate.is_finite() or rate <= 0:
                        continue
                    amount = float(value / base * rate)
                    if math.isfinite(amount):
                        out[target] = amount
        return out
    except (ValueError, TypeError, ArithmeticError):
        return None


def mount_legacy_stock_detail(app, settings, authority):
    history, fx = LicensedHistory(authority), FxWorker(authority.db)

    async def execute(request, version):
        headers = {
            "Cache-Control": "private, no-store",
            "Vary": "Cookie, Authorization",
            "X-Alcor-API-Version": str(version),
            "X-Alcor-History-Coverage": "unknown",
        }
        try:
            assert_native_origin(request, settings)
            who = (
                await history_member(request, authority.db, version)
                if "authorization" in request.headers
                else None
            )
            market = request.query_params.get("market", "").strip(JS_WHITESPACE).upper()
            symbol = request.query_params.get("code", "").strip(JS_WHITESPACE).upper()
            if not market or not symbol:
                raise HTTPException(400, "缺少 market / code")
            if not re.fullmatch(r"[A-Z0-9._-]{1,40}", symbol):
                raise HTTPException(400, "股票代码不合法")
            if market not in ("US", "HK", "CN", "JP", "KR"):
                raise HTTPException(400, "暂不支持该市场")
            who = who or await history_member(request, authority.db, version)
            if not await app.state.rate_limit(
                authority.db, "stock-detail:" + who.id, 60, window_seconds=60
            ) or not await app.state.rate_limit(authority.db, "stock-detail-global", 300, window_seconds=60):
                raise HTTPException(429, "请求过于频繁，请稍后再试")
            history_only = request.query_params.get("view") == "history"
            limit = 320
            if history_only:
                raw = request.query_params.get("limit")
                if raw is not None and (not re.fullmatch(r"[0-9]{1,5}", raw) or not 60 <= int(raw) <= 12000):
                    raise HTTPException(400, "历史条数须为60至12000的整数")
                limit = int(raw) if raw is not None else 320
            kline, kline_state = [], "not_requested"
            if history_only or request.query_params.get("includeKline") != "0":
                try:
                    rows, policy, query, revision = await history.read(
                        who,
                        market,
                        symbol,
                        frame="day",
                        adjust="qfq",
                        source_revision=request.headers.get("x-alcor-market-source"),
                        limit=limit,
                    )
                    kline = bar_rows(
                        rows, policy, query, authority.clock() if authority.clock else datetime.now(UTC)
                    )
                    kline_state = "observed"
                    headers["X-Alcor-Market-Source"] = revision
                except HTTPException as exc:
                    if exc.status_code in (401, 403, 409) or history_only:
                        raise
                    kline_state = "unavailable"
            if history_only:
                data = {"market": market, "code": symbol, "historyLimit": limit, "kline": kline}
            else:
                identifier = market + ":" + symbol
                latest = await configured_quotes(
                    authority, who,
                    [{"id": identifier, "market": market, "code": symbol}],
                    request.headers.get("x-alcor-market-source"),
                )
                source = latest["quotes"].get(identifier)
                quote = {key: source.get(key) for key in QUOTE_FIELDS} if source else None
                if quote and "cached" in source:
                    quote["cached"] = source["cached"]
                rates_state, rates, observation = "unavailable", {"USD": 1}, None
                rates_updated = None
                try:
                    snapshot = await fx.snapshot()
                    rates, observation = snapshot["rates"], snapshot.get("observationId")
                    rates_updated = snapshot.get("updatedAt")
                    rates_state = "observed" if snapshot.get("quoted") else "identity_only"
                except Exception:  # noqa: BLE001 -- Missing FX never becomes a built-in estimate.
                    rates_state = "unavailable"
                currency = CURRENCIES[market]
                data = {
                    "market": market,
                    "code": symbol,
                    "name": quote.get("name") if quote else None,
                    "currency": currency,
                    "quote": quote,
                    "marketCap": observed_caps(quote.get("marketCap") if quote else None, currency, rates),
                    "rates": rates,
                    "kline": kline,
                    "migration": {
                        "quoteState": latest["quoteStates"].get(identifier),
                        "klineState": kline_state,
                        "ratesState": rates_state,
                        "ratesObservationId": observation,
                        "ratesUpdatedAt": rates_updated,
                        "etfShareFallback": "observed_fund_units" if quote and quote.get('fundUnits') is not None else "unavailable",
                        "etfShareSourceSupported": "futu_snapshot_trust_units",
                    },
                }
            return JSONResponse({"code": 0, "message": "ok", "data": data}, headers=headers)
        except HTTPException as exc:
            if exc.status_code in (401, 403):
                headers["X-Alcor-Retire-Context"] = "true"
            return JSONResponse(
                {
                    "code": 50002 if exc.status_code >= 500 else exc.status_code * 100 + 1,
                    "message": str(exc.detail),
                },
                status_code=exc.status_code,
                headers=headers,
            )

    @app.get("/api/v1/stock-detail")
    async def v1(request: Request):
        return await execute(request, 1)

    @app.get("/api/v2/stock-detail")
    async def v2(request: Request):
        return await execute(request, 2)
