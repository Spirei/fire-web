"""Exact, date-bounded reconstruction of the legacy owner-confirmed rule contract."""

import re
from datetime import date
from decimal import ROUND_HALF_UP, Decimal, localcontext

VERSION = "2026-10-20.1"
SOURCES = {
    "sec2025": "https://www.sec.gov/files/rules/other/2025/34-102779.pdf",
    "sec2026": "https://www.sec.gov/rules-regulations/fee-rate-advisories/2026-2",
    "taf": "https://www.finra.org/sites/default/files/2024-11/sr-finra-2024-019.pdf",
    "tafHoliday": "https://www.sec.gov/files/rules/sro/finra/2026/34-106409.pdf",
    "cnTransfer": "https://jrj.sh.gov.cn/SCDT197/20220429/f715759a877b4158812eb6df70ccb49e.html",
    "cnStamp": "https://fgk.chinatax.gov.cn/zcfgk/c102416/c5211343/content.html",
}


def number(value):
    if isinstance(value, bool) or not isinstance(value, (str, int, Decimal)):
        raise ValueError("exact_decimal_required")  # noqa: TRY004 -- stable numeric validation error contract
    text = str(value)
    if len(text) > 80 or not re.fullmatch(r"[0-9]+(?:\.[0-9]{1,18})?", text):
        raise ValueError("decimal_invalid")
    result = Decimal(text)
    if result > Decimal(1000000000000):
        raise ValueError("decimal_range")
    return result


def day(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise ValueError("date_invalid")
    date.fromisoformat(value)
    return value


def plan(raw, provider):
    if not isinstance(raw, dict) or set(raw) - {
        "effectiveFrom",
        "effectiveThrough",
        "confirmed",
        "commissionIncludesExchangeFees",
    }:
        raise ValueError("plan_invalid")
    start, end = day(raw.get("effectiveFrom")), day(raw.get("effectiveThrough"))
    if (
        start > end
        or raw.get("confirmed") is not True
        or ("commissionIncludesExchangeFees" in raw and raw["commissionIncludesExchangeFees"] is not True)
        or (provider == "huatai" and raw.get("commissionIncludesExchangeFees") is not True)
    ):
        raise ValueError("plan_unconfirmed")
    return dict(raw)


def reconstruct(provider, when, side, quantity, price, kind, raw_plan):
    confirmed = plan(raw_plan, provider)
    components = []

    def excluded(reason):
        return {"reason": reason, "fees": None, "components": components}

    try:
        day(when)
    except ValueError:
        return excluded("rate_period_unconfirmed")
    if when > VERSION[:10] or not confirmed["effectiveFrom"] <= when <= confirmed["effectiveThrough"]:
        return excluded("rate_period_unconfirmed")
    qty, price = number(quantity), number(price)
    with localcontext() as context:
        context.prec = 80
        gross = qty * price
        if side not in ("buy", "sell") or qty <= 0 or price <= 0 or gross > Decimal("1e12"):
            return excluded("unsupported_trade")

        def add(kind, value, rate, basis, start, end, source):
            components.append(
                {
                    "kind": kind,
                    "amount": format(value.quantize(Decimal(".01"), rounding=ROUND_HALF_UP), "f"),
                    "rate": str(rate),
                    "basis": basis,
                    "effectiveFrom": start,
                    "effectiveThrough": end,
                    "source": source,
                }
            )

        if provider == "longbridge":
            if kind not in ("us_domestic_equity", "us_etf"):
                return excluded("instrument_or_adr_unconfirmed")
            if qty != qty.to_integral_value():
                return excluded("fractional_order_requires_statement")
            if when < "2025-05-14":
                return excluded("historical_rate_not_supported")
            if side == "sell" and "2026-04-02" <= when <= "2026-04-04":
                return excluded("sec_charge_date_requires_statement")
            start, end = confirmed["effectiveFrom"], confirmed["effectiveThrough"]
            add("commission", Decimal(0), 0, "waived", start, end, "owner_confirmed_plan")
            add(
                "platform",
                max(Decimal(1), min(qty * Decimal(".005"), gross * Decimal(".0099"))),
                ".005",
                "per_share_min_1_cap_0.99pct_minimum_wins",
                start,
                end,
                "owner_confirmed_plan",
            )
            add(
                "clearing",
                min(qty * Decimal(".003"), gross * Decimal(".07")),
                ".003",
                "per_share_cap_7pct_gross",
                start,
                end,
                "owner_confirmed_plan",
            )
            if side == "sell":
                sec = Decimal(0) if when < "2026-04-04" else Decimal(".0000206")
                add(
                    "sec",
                    Decimal(0) if sec == 0 else max(Decimal(".01"), gross * sec),
                    sec,
                    "sell_gross_owner_confirmed_cent_rounding",
                    "2025-05-14" if sec == 0 else "2026-04-04",
                    "2026-04-03" if sec == 0 else "2026-10-20",
                    SOURCES["sec2025" if sec == 0 else "sec2026"],
                )
                paused = when >= "2026-10-01"
                taf = Decimal(0) if paused else Decimal(".000166" if when < "2026-01-01" else ".000195")
                cap = Decimal("8.30" if when < "2026-01-01" else "9.79")
                if taf > 0 and price < taf:
                    return excluded("low_price_taf_requires_statement")
                add(
                    "taf",
                    Decimal(0) if taf == 0 else max(Decimal(".01"), min(qty * taf, cap)),
                    taf,
                    "sell_shares_owner_confirmed_min_0.01_cent_rounding",
                    "2026-10-01" if paused else "2024-01-01" if when < "2026-01-01" else "2026-01-01",
                    "2026-12-31" if paused else "2025-12-31" if when < "2026-01-01" else "2026-09-30",
                    SOURCES["tafHoliday" if paused else "taf"],
                )
        elif provider == "huatai":
            if kind != "cn_a_equity":
                return excluded("cn_fund_or_instrument_requires_statement")
            if when < "2022-04-29":
                return excluded("historical_rate_not_supported")
            add(
                "commission",
                max(Decimal(5), gross * Decimal(".0001154")),
                ".0001154",
                "gross_min_5_includes_exchange_regulatory_fees",
                confirmed["effectiveFrom"],
                confirmed["effectiveThrough"],
                "owner_confirmed_plan",
            )
            add(
                "transfer",
                gross * Decimal(".00001"),
                ".00001",
                "gross_both_sides",
                "2022-04-29",
                "2026-10-20",
                SOURCES["cnTransfer"],
            )
            if side == "sell":
                rate = Decimal(".001" if when < "2023-08-28" else ".0005")
                add(
                    "stamp",
                    gross * rate,
                    rate,
                    "sell_gross",
                    "2008-09-19" if when < "2023-08-28" else "2023-08-28",
                    "2023-08-27" if when < "2023-08-28" else "2026-10-20",
                    SOURCES["cnStamp"],
                )
        else:
            return excluded("provider_not_supported")
        return {
            "reason": None,
            "fees": format(sum((Decimal(c["amount"]) for c in components), Decimal(0)), ".2f"),
            "components": components,
        }
