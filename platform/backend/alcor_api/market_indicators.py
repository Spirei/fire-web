"""Pure observed-bar chart derivations; never a price source or a financial ledger.

MA, EMA and BOLL follow the old StockKline formulas, including its rounded
BOLL mean and first-observation EMA seed. EMA visibility now requires a full
window. MACD and Wilder RSI are explicit new definitions, not old UI parity.
No calendar/session slots, missing prices, volume or amount are synthesized.
"""

import math
from decimal import ROUND_HALF_UP, Decimal, localcontext

DEFAULT_MA_PERIODS = (5, 10, 20, 30, 60, 120, 250, 500)


def _number(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        result = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return result if math.isfinite(result) and 0 < result < 1e65 else None


def _rounded(value):
    if value is None or not math.isfinite(value):
        return None
    # JS toFixed(4): round the exact binary64 value, with positive half ties up.
    # Indicator prices are bounded by the source contract, but keep this pure
    # boundary safe for direct callers as well.
    if abs(value) >= 1e21:
        return str(value)
    with localcontext() as context:
        context.prec = 80
        rounded = Decimal.from_float(value).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)
    return format(rounded, "f")


def calculate_indicators(facts, *, ma_periods=DEFAULT_MA_PERIODS, price_field="c"):
    """Return aligned points over the supplied chronological, licensed facts only.

    Invalid closes create an explicit reset, rather than bridge an unknown price.
    Time gaps remain gaps; windows count observed bars and do not certify a full
    trading calendar. The caller retains source/license/revision authorization.
    """
    if price_field not in ("c", "price"):
        raise ValueError("indicator_price_field_invalid")
    if not isinstance(facts, list) or len(facts) > 24000:
        raise ValueError("indicator_observation_budget")
    if (
        not isinstance(ma_periods, (tuple, list))
        or len(ma_periods) > 16
        or any(type(period) is not int or not 1 <= period <= 2000 for period in ma_periods)
        or len(set(ma_periods)) != len(ma_periods)
    ):
        raise ValueError("indicator_window_invalid")
    points, values, sums = [], [], {period: 0.0 for period in ma_periods}
    ema = {12: None, 20: None, 26: None}
    signal, dif_count, gain, loss = None, 0, None, None
    gains, losses = [], []
    previous_close, boll_sum = None, 0.0
    for fact in facts:
        if not isinstance(fact, dict):
            raise TypeError("indicator_fact_invalid")
        close = _number(fact.get(price_field))
        point = {
            "factId": fact.get("factId"),
            "at": fact.get("at"),
            "ma": {str(period): None for period in ma_periods},
            "ema20": None,
            "boll20": {"mid": None, "upper": None, "lower": None},
            "macd": {"dif": None, "dea": None, "hist": None},
            "rsi14": None,
            "volume": fact.get("v", fact.get("volume")),
            "amount": fact.get("amount"),
            "observationsInSegment": 0,
        }
        if close is None:
            values, sums = [], {period: 0.0 for period in ma_periods}
            ema, signal, dif_count = {12: None, 20: None, 26: None}, None, 0
            gain, loss, gains, losses, previous_close = None, None, [], [], None
            boll_sum = 0.0
            points.append(point)
            continue
        values.append(close)
        index = len(values) - 1
        boll_sum += close
        if index >= 20:
            boll_sum -= values[index - 20]
        point["observationsInSegment"] = len(values)
        for period in ma_periods:
            sums[period] += close
            if index >= period:
                sums[period] -= values[index - period]
            if len(values) >= period:
                point["ma"][str(period)] = _rounded(sums[period] / period)
        for period in ema:
            alpha = 2 / (period + 1)
            ema[period] = close if ema[period] is None else close * alpha + ema[period] * (1 - alpha)
        if len(values) >= 20:
            point["ema20"] = _rounded(ema[20])
            # StockKline's BOLL mean is MA20 rounded to four decimals first.
            mid = float(_rounded(boll_sum / 20))
            deviation = math.sqrt(sum((value - mid) ** 2 for value in values[-20:]) / 20)
            point["boll20"] = {
                "mid": _rounded(mid),
                "upper": _rounded(mid + 2 * deviation),
                "lower": _rounded(mid - 2 * deviation),
            }
        if len(values) >= 26:
            dif = ema[12] - ema[26]
            signal = dif if signal is None else dif * 0.2 + signal * 0.8
            dif_count += 1
            point["macd"]["dif"] = _rounded(dif)
            if dif_count >= 9:
                point["macd"].update(dea=_rounded(signal), hist=_rounded(2 * (dif - signal)))
        if previous_close is not None:
            change = close - previous_close
            positive, negative = max(change, 0.0), max(-change, 0.0)
            if gain is None:
                gains.append(positive)
                losses.append(negative)
                if len(gains) == 14:
                    gain, loss = sum(gains) / 14, sum(losses) / 14
            else:
                gain, loss = (gain * 13 + positive) / 14, (loss * 13 + negative) / 14
            if gain is not None:
                rsi = (
                    50.0 if gain == 0 and loss == 0 else 100.0 if loss == 0 else 100 - 100 / (1 + gain / loss)
                )
                point["rsi14"] = _rounded(rsi)
        previous_close = close
        points.append(point)
    return {
        "version": 1,
        "basis": "observed_bars_not_verified_calendar",
        "authority": "derived_chart_only",
        "inputField": price_field,
        "rounding": "binary64_js_toFixed4",
        "maPeriods": list(ma_periods),
        "points": points,
        "definitions": {
            "ma": "trailing_observed_close_mean",
            "ema20": "first_close_seed_alpha_2_over_21_full_20_observation_visibility",
            "boll20": "population_std_about_legacy_rounded_ma20_multiple_2",
            "macd": "ema12_minus_ema26_signal9_seed_first_valid_dif_histogram_times2",
            "rsi14": "wilder_14_changes_flat50_no_loss100",
        },
        "legacyFormulaParity": ["MA", "EMA_seed_and_recurrence", "BOLL"],
        "newDefinitions": ["MACD", "RSI", "EMA_full_window_visibility"],
        "unsupported": ["KDJ"],
        "calendarCompletenessVerified": False,
    }
