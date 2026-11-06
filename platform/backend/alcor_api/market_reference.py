"""Offline draft. Inputs are explicit source observations, never fallback estimates."""

import re
from datetime import date, timedelta
from decimal import Decimal


def amount(value):
    if isinstance(value, bool) or not isinstance(value, (str, int, Decimal)):
        raise TypeError("exact decimal input required")
    result = Decimal(value)
    if (
        not result.is_finite()
        or result <= 0
        or abs(result.adjusted()) > 30
        or (len(result.as_tuple().digits) > 38)
    ):
        raise ValueError("positive bounded rate required")
    return result


def currency(code):
    if not isinstance(code, str) or not re.fullmatch("[A-Z]{3}", code):
        raise ValueError("explicit ISO-style currency code required")
    return code


def calendar_unknown(market, year):
    zones = {"CN": "Asia/Shanghai", "HK": "Asia/Hong_Kong", "US": "America/New_York"}
    if market not in zones or type(year) is not int or (not 2000 <= year <= 2100):
        raise ValueError("invalid calendar query")
    day = date(year, 1, 1)
    days = []
    while day.year == year:
        days.append(
            {
                "date": day.isoformat(),
                "weekday": (day.weekday() + 1) % 7,
                "isWeekend": day.weekday() >= 5,
                "status": "unknown",
                "isTradingDay": None,
                "reason": "unverified_year",
                "actualTradingStatus": "unknown",
                "close": None,
                "sourceIds": [],
            }
        )
        day += timedelta(days=1)
    return {
        "market": market,
        "year": year,
        "timeZone": zones[market],
        "coverage": {"status": "unknown", "temporaryClosures": "unknown"},
        "days": days,
    }
