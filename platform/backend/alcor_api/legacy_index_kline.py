"""Legacy index/proxy shapes over licensed facts; ETFs remain explicit proxies."""

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse

from .legacy_history_bars import bar_rows, history_member
from .legacy_identity import assert_native_origin
from .market_history_reads import LicensedHistory
from .market_yahoo_history import INDEXES

# Exact old INDEX_MAP.futuDaily assignments, not inferred financial relationships.
BENCHMARKS = {
    "dji": ("道琼斯", "US", "DIA"),
    "spx": ("标普500", "US", "SPY"),
    "ndx": ("纳斯达克", "US", "QQQ"),
    "hsi": ("恒生指数", "HK", "02800"),
}
INDEX_NAMES = {
    **{key: value[0] for key, value in BENCHMARKS.items()},
    "sse": "上证指数",
    "szse": "深证成指",
    "n225": "日经225",
    "ks11": "韩国KOSPI",
    "sti": "富时新加坡海峡",
}
DAILY_REFERENCES = {"spx": "usINX", "ndx": "usIXIC"}


def proxy_months(items):
    values = {}
    for item in items:
        # The label groups actual source dates; no month-end date or OHLC is manufactured.
        values[item["d"][:7]] = item
    months = sorted(values)
    return {
        "months": months,
        "closes": [values[month]["c"] for month in months],
        "observedDates": [values[month]["d"] for month in months],
        "monthEndFinalized": None,
    }


def mount_legacy_index_kline(app, settings, authority):
    history = LicensedHistory(authority)

    async def execute(request, version):
        headers = {
            "Cache-Control": "private, no-store",
            "Vary": "Cookie, Authorization",
            "X-Alcor-API-Version": str(version),
            "X-Alcor-History-Coverage": "unknown",
        }
        kind = "unknown"
        key = request.query_params.get("key", "").lower()
        daily = request.query_params.get("view") == "daily"
        try:
            assert_native_origin(request, settings)
            who = (
                await history_member(request, authority.db, version)
                if "authorization" in request.headers
                else None
            )
            client = request.client.host if request.client else "unknown"
            if not await app.state.rate_limit(
                authority.db, "index-kline:" + client, 120, window_seconds=60
            ) or not await app.state.rate_limit(authority.db, "index-kline-global", 600, window_seconds=60):
                raise HTTPException(429, "请求过于频繁，请稍后再试")
            if daily:
                if key not in DAILY_REFERENCES:
                    raise HTTPException(400, "不支持的日线指数")
            elif key not in INDEX_NAMES:
                raise HTTPException(400, "未知指数")
            who = who or await history_member(request, authority.db, version)
            async def real_index():
                market, symbol, provider_symbol = INDEXES[key]
                rows, policy, query, revision = await history.read(
                    who, market, symbol, frame="day", adjust="none", instrument="index",
                    source_revision=request.headers.get("x-alcor-market-source"), limit=1500,
                )
                observed = bar_rows(rows, policy, query, authority.clock() if authority.clock else None)
                dates = [row["d"] for row in observed]
                if len(set(dates)) != len(dates):
                    raise HTTPException(503, "指数原始日线日期重复，未静默覆盖")
                value = {
                    "schemaVersion": 1, "kind": "index", "proxy": False, "isActualIndex": True,
                    "key": key, "name": "纳斯达克综合指数" if key == "ndx" else INDEX_NAMES[key],
                    "market": market, "code": symbol, "sourceSymbol": provider_symbol,
                    "frequency": "day" if daily else "month", "source": policy.source,
                    "sourceRevision": revision, "licenseRevision": policy.license_revision,
                    "adjust": "none", "coverage": "observed_days_only",
                }
                if daily:
                    # Preserve the actual old daily API reference string while
                    # separately naming the verified provider's own symbol.
                    value.update(symbol=DAILY_REFERENCES[key], rows=[{"d": row["d"], "c": row["c"]} for row in observed])
                else:
                    value.update(proxy_months(observed), aggregation="last_observed_day_per_month")
                headers.update({"X-Alcor-Index-Kind": "index", "X-Alcor-Market-Source": revision})
                return value

            if daily or key not in BENCHMARKS:
                kind = "index"
                value = await real_index()
                return JSONResponse({"code": 0, "message": "ok", "data": value}, headers=headers)
            kind = "benchmark_proxy"
            name, market, symbol = BENCHMARKS[key]
            try:
                rows, policy, query, revision = await history.read(
                    who, market, symbol, frame="day", adjust="qfq", instrument="equity",
                    source_revision=request.headers.get("x-alcor-market-source"), limit=1500,
                )
            except HTTPException as missing:
                if missing.status_code != 503:
                    raise
                # Exactly the old proxy-then-index ordering, but only over
                # explicitly licensed, already collected platform facts.
                kind = "index"
                value = await real_index()
                return JSONResponse({"code": 0, "message": "ok", "data": value}, headers=headers)
            observations = bar_rows(rows, policy, query, authority.clock() if authority.clock else None)
            if not observations:
                raise HTTPException(503, "尚无该代理证券的真实日线记录")
            value = {
                **proxy_months(observations),
                "schemaVersion": 1,
                "kind": "benchmark_proxy",
                "proxy": True,
                "isActualIndex": False,
                "key": key,
                "name": symbol + " 基准代理",
                "requestedIndex": {"key": key, "name": name},
                "frequency": "month",
                "proxyInstrument": {
                    "market": market,
                    "code": symbol,
                    "instrument": "equity",
                    "adjust": "qfq",
                },
                "aggregation": "last_observed_day_per_month",
                "coverage": "observed_days_only",
                "source": policy.source,
                "sourceRevision": revision,
                "licenseRevision": policy.license_revision,
                "trueIndexSourceState": "not_selected",
            }
            headers.update(
                {
                    "X-Alcor-Index-Kind": "benchmark-proxy",
                    "X-Alcor-Proxy-Symbol": market + ":" + symbol,
                    "X-Alcor-Market-Source": revision,
                }
            )
            return JSONResponse({"code": 0, "message": "ok", "data": value}, headers=headers)
        except HTTPException as exc:
            if exc.status_code in (401, 403):
                headers["X-Alcor-Retire-Context"] = "true"
            error = {
                "code": 50301 if exc.status_code >= 500 else exc.status_code * 100 + 1,
                "message": str(exc.detail),
            }
            if exc.status_code >= 500:
                error["data"] = {
                    "key": key,
                    "kind": kind,
                    "frequency": "day" if daily else "month",
                    "state": "unavailable",
                    "proxy": kind == "benchmark_proxy",
                    "isActualIndex": False if kind == "benchmark_proxy" else None,
                    "rows": None,
                    "coverage": "unknown",
                }
            return JSONResponse(error, status_code=exc.status_code, headers=headers)

    @app.get("/api/v1/index-kline")
    async def v1(request: Request):
        return await execute(request, 1)

    @app.get("/api/v2/index-kline")
    async def v2(request: Request):
        return await execute(request, 2)
