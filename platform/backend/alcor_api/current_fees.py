"""Explicit owner-confirmed fee estimates, not broker-reported actual charges."""

from datetime import datetime
from decimal import ROUND_CEILING, ROUND_HALF_UP, Decimal, localcontext
from uuid import UUID
from zoneinfo import ZoneInfo

from .fee_plans import calculate_component, validate_rule
from .fee_rules import SOURCES, day, number

VERSION = "2026-10-23.1"


def parse_input(raw):
    if (
        not isinstance(raw, dict)
        or set(raw)
        - {
            "source",
            "brokerAccountId",
            "providerId",
            "confirmed",
            "ruleVersion",
            "instrumentKind",
            "plan",
            "components",
        }
        or raw.get("confirmed") is not True
        or raw.get("source") not in ("owner_recorded", "rule_calculated")
    ):
        raise ValueError("fee_input_invalid")
    if raw["source"] == "owner_recorded":
        if set(raw) & {"ruleVersion", "instrumentKind", "plan"}:
            raise ValueError("manual_fee_not_rule")
        parts = raw.get("components")
        if parts is not None:
            if not isinstance(parts, list) or len(parts) > 20:
                raise ValueError("components_invalid")
            seen = set()
            for part in parts:
                if (
                    not isinstance(part, dict)
                    or set(part) != {"kind", "amount", "currency"}
                    or not isinstance(part["kind"], str)
                    or not 1 <= len(part["kind"]) <= 60
                    or part["kind"] in seen
                    or part["currency"] not in ("USD", "HKD", "CNY", "JPY", "KRW", "SGD", "GBP")
                ):
                    raise ValueError("component_invalid")
                number(part["amount"])
                seen.add(part["kind"])
    else:
        if raw.get("ruleVersion") != VERSION or "components" in raw:
            raise ValueError("fee_rule_version")
        plan = raw.get("plan")
        if (
            not isinstance(plan, dict)
            or set(plan) - {"id", "revision", "effectiveFrom", "effectiveThrough", "overrides"}
            or day(plan.get("effectiveFrom")) > day(plan.get("effectiveThrough"))
        ):
            raise ValueError("fee_period_missing")
        if ("id" in plan) != ("revision" in plan):
            raise ValueError("personal_plan_identity_revision_required")
        if "id" in plan and (
            not isinstance(plan["id"], str)
            or str(UUID(plan["id"])) != plan["id"]
            or type(plan["revision"]) is not int
            or not 1 <= plan["revision"] <= 9007199254740991
        ):
            raise ValueError("personal_plan_identity_revision_invalid")
        overrides = plan.get("overrides")
        if not isinstance(overrides, dict) or set(overrides) - {"commission", "platform", "fundCommission"}:
            raise ValueError("fee_rules_missing")
        for rule in overrides.values():
            validate_rule(rule)
    return raw


def calculate(data, record, account, raw):
    with localcontext() as ctx:
        ctx.prec = 80
        return _calculate(data, record, account, raw)


def _calculate(data, record, account, raw):
    raw = parse_input(raw)
    if (
        raw.get("brokerAccountId") != account["id"]
        or record["broker_account_id"] != account["id"]
        or raw.get("providerId") != account["provider_id"]
        or account["holding_source"] != "manual"
    ):
        raise ValueError("fee_account_source_mismatch")
    market = (
        "connect"
        if record["market"] == "HK" and record["account_market"] == "CN"
        else {"HK": "hk", "CN": "cn", "US": "us", "JP": "jp", "KR": "kr", "SG": "sg", "UK": "uk"}.get(record["market"])
    )
    if market is None:
        raise ValueError("fee_market_unsupported")
    from .trading import MARKET_CURRENCY
    currency = MARKET_CURRENCY[record["market"]]
    total = number(data["fees"])
    parts = []
    if raw["source"] == "owner_recorded":
        if raw.get("components") is not None:
            for part in raw["components"]:
                if part["currency"] != currency:
                    raise ValueError("fee_currency_mismatch")
                parts.append({**part, "amount": str(number(part["amount"])), "source": "owner_recorded"})
            if sum((Decimal(p["amount"]) for p in parts), Decimal(0)) != total:
                raise ValueError("fee_components_total_mismatch")
        return {
            "source": "owner_recorded",
            "currency": currency,
            "total": str(total),
            "components": parts if raw.get("components") is not None else None,
            "brokerAccountId": account["id"],
            "providerId": account["provider_id"],
            "brokerRevision": account["revision"],
            "ruleVersion": None,
            "ruleSnapshot": None,
        }
    if market not in ("us", "hk", "cn", "connect"):
        raise ValueError("fee_rule_market_unsupported")
    when = datetime.fromisoformat(data["occurredAt"])
    if when.tzinfo is None:
        raise ValueError("fee_timezone_missing")
    date = (
        when.astimezone(ZoneInfo("America/New_York" if market == "us" else "Asia/Shanghai"))
        .date()
        .isoformat()
    )
    plan = raw["plan"]
    kind = raw.get("instrumentKind")
    if (
        not plan["effectiveFrom"] <= date <= plan["effectiveThrough"]
        or not "2025-07-01" <= date <= "2026-10-23"
    ):
        raise ValueError("fee_period_unconfirmed")
    allowed = {
        "us": ("us_domestic_equity", "us_etf"),
        "cn": ("cn_a_equity", "cn_fund"),
        "hk": ("hk_equity", "hk_etf"),
        "connect": ("hk_equity", "hk_etf"),
    }
    if kind not in allowed[market]:
        raise ValueError("instrument_unconfirmed")
    if not (
        account["provider_id"] == "longbridge"
        and market in ("us", "hk")
        or account["provider_id"] == "huatai"
        and market in ("cn", "connect")
    ):
        raise ValueError("provider_market_unsupported")
    side = data["side"]
    if side not in ("buy", "sell"):
        raise ValueError("dividend_requires_statement")
    qty, price = number(data["quantity"]), number(data["price"])
    gross = qty * price
    if gross > Decimal("1e12"):
        raise ValueError("trade_amount_bound")
    defaults = {
        "cn": {
            "commission": {"basis": "permille", "rate": "0.1154", "minimum": "5"},
            "fundCommission": {"basis": "permille", "rate": "0.1", "minimum": "5"},
        },
        "connect": {"commission": {"basis": "percent", "rate": "0.3"}},
        "hk": {"commission": {"basis": "free"}, "platform": {"basis": "order", "rate": "15"}},
        "us": {
            "commission": {"basis": "free"},
            "platform": {"basis": "percent", "rate": "0.99", "maximum": "0.99"}
            if qty < 1
            else {"basis": "share", "rate": "0.005", "minimum": "1", "maximumPercent": "0.99"},
        },
    }[market]
    resolved = {}

    def add(kind, value, rule, source, ceiling=False):
        rounded = value.quantize(
            Decimal(1) if ceiling else Decimal(".01"), rounding=ROUND_CEILING if ceiling else ROUND_HALF_UP
        )
        parts.append(
            {
                "kind": kind,
                "amount": format(rounded, ".2f"),
                "currency": currency,
                "rule": rule,
                "source": source,
            }
        )

    def component(kind):
        rule = plan["overrides"].get(kind, defaults.get(kind))
        if rule is None:
            raise ValueError("fee_rule_missing")
        resolved[kind] = rule
        add(
            kind,
            calculate_component(rule, qty, gross, side),
            rule,
            "owner_personal_plan" if kind in plan["overrides"] else "owner_confirmed_reference",
        )

    with localcontext() as ctx:
        ctx.prec = 80
        component("fundCommission" if market == "cn" and kind == "cn_fund" else "commission")
        if market not in ("cn", "connect") or "platform" in plan["overrides"]:
            component("platform")
        if market == "cn" and kind != "cn_fund":
            add(
                "transfer",
                gross * Decimal(".00001"),
                {"rate": "0.00001", "effectiveFrom": "2022-04-29"},
                SOURCES["cnTransfer"],
            )
            if side == "sell":
                add(
                    "stamp",
                    gross * Decimal(".0005"),
                    {"rate": "0.0005", "effectiveFrom": "2023-08-28"},
                    SOURCES["cnStamp"],
                )
        elif market == "us":
            if qty >= 1:
                add(
                    "clearing",
                    min(qty * Decimal(".003"), gross * Decimal(".07")),
                    {"perShare": "0.003", "maximumGrossPercent": "7"},
                    "owner_confirmed_reference",
                )
            if side == "sell":
                if "2026-04-02" <= date <= "2026-04-04":
                    raise ValueError("sec_charge_date_requires_statement")
                sec = Decimal(0) if date < "2026-04-04" else Decimal(".0000206")
                paused = date >= "2026-10-01"
                taf = Decimal(".000166" if date < "2026-01-01" else ".000195")
                cap = Decimal("8.30" if date < "2026-01-01" else "9.79")
                if not paused and price < taf:
                    raise ValueError("low_price_taf_requires_statement")
                add(
                    "sec",
                    Decimal(0) if not sec else max(Decimal(".01"), gross * sec),
                    {"rate": str(sec), "effectiveFrom": "2025-05-14" if not sec else "2026-04-04"},
                    SOURCES["sec2025" if not sec else "sec2026"],
                )
                add(
                    "taf",
                    Decimal(0) if paused else max(Decimal(".01"), min(qty * taf, cap)),
                    {
                        "rate": "0" if paused else str(taf),
                        "maximum": str(cap),
                        "effectiveFrom": "2026-10-01"
                        if paused
                        else "2024-01-01"
                        if date < "2026-01-01"
                        else "2026-01-01",
                    },
                    SOURCES["tafHoliday" if paused else "taf"],
                )
        elif market in ("hk", "connect"):
            add(
                "stamp",
                Decimal(0) if kind == "hk_etf" else gross * Decimal(".001"),
                {"rate": "0" if kind == "hk_etf" else "0.001", "etfClassification": "owner_confirmed"},
                "https://www.ird.gov.hk/eng/faq/ETFs.htm"
                if kind == "hk_etf"
                else "https://www.ird.gov.hk/eng/faq/sdu.htm",
                True,
            )
            for key, rate in [
                ("trading", ".0000565"),
                ("sfc", ".000027"),
                ("afrc", ".0000015"),
                ("settlement", ".000042"),
            ]:
                add(
                    key,
                    gross * Decimal(rate),
                    {"rate": rate, "effectiveFrom": "2025-06-30" if key == "settlement" else "2023-01-01"},
                    "https://www.hkex.com.hk/news/market-communications/2025/250221news?sc_lang=en"
                    if key == "settlement"
                    else "https://www.hkex.com.hk/Services/Rules-and-Forms-and-Fees/Fees/Securities-(Hong-Kong)/Trading/Transaction?sc_lang=en",
                )
        estimated = sum((Decimal(p["amount"]) for p in parts), Decimal(0))
        if total != estimated:
            raise ValueError("fees_do_not_match_confirmed_estimate")
    return {
        "source": "rule_calculated",
        "currency": currency,
        "total": str(total),
        "components": parts,
        "brokerAccountId": account["id"],
        "providerId": account["provider_id"],
        "brokerRevision": account["revision"],
        "ruleVersion": VERSION,
        "ruleSnapshot": {
            "engineVersion": VERSION,
            "day": date,
            "market": market,
            "instrumentKind": kind,
            "plan": plan,
            "resolvedRules": resolved,
            "rounding": "component_half_up_2_then_sum",
            "brokerBill": False,
        },
    }
