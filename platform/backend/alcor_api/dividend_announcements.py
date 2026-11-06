"""Bounded source interpretation; an announcement is never an actual cash receipt."""

import re
from datetime import date
from decimal import Decimal, InvalidOperation, localcontext
from fractions import Fraction

NORMALIZER_VERSION = "futu-calendar-cash-basis-v2"
_DATE = re.compile(r"^(\d{4})[./-](\d{1,2})[./-](\d{1,2})(?=$|[ T])")
_CASH = re.compile(
    r"(?<![A-Za-z0-9_.,+\-])([0-9]+(?:\.[0-9]+)?)\s*"
    r"(USD|HKD|CNY|港元|港币|美元|人民币元|人民币)(?![A-Za-z])",
    re.IGNORECASE,
)
_BASIS = re.compile(
    r"(?<![A-Za-z0-9_.,+\-])(?:(?:每(?:持有)?\s*)?([0-9]+)\s*股|每\s*股)\s*"
    r"(?:派息|派现|派发|现金股息|现金红利|股息|分红|派)?\s*$"
)
_SPECIAL = re.compile(
    r"实物分派|优先发售|每持有.*股.*获发|股份分派|以股代息|送股|转增|红股|scrip|stock dividend", re.IGNORECASE
)


def source_date(value):
    if value is None or value == "":
        return None
    if not isinstance(value, str) or len(value) > 128:
        raise ValueError("invalid source date")
    match = _DATE.match(value.strip())
    if not match:
        return None
    try:
        return date(*(int(x) for x in match.groups())).isoformat()
    except ValueError:
        return None


def _per_share(amount, shares):
    """No rounding of nonterminating ratios into a pretend exact quote."""
    ratio = Fraction(amount) / shares
    denominator = ratio.denominator
    for factor in (2, 5):
        while denominator % factor == 0:
            denominator //= factor
    if denominator != 1:
        return None
    with localcontext() as context:
        context.prec = 128
        return format(Decimal(ratio.numerator) / Decimal(ratio.denominator), "f")


def futu_announcement(raw):
    if not isinstance(raw, dict):
        raise ValueError("invalid announcement")  # noqa: TRY004
    statement = raw.get("statement")
    if statement is None:
        statement = ""
    if not isinstance(statement, str) or len(statement) > 8192:
        raise ValueError("invalid announcement statement")
    legs = []
    for match in _CASH.finditer(statement):
        try:
            value = Decimal(match[1])
            if not value.is_finite() or value < 0 or len(value.as_tuple().digits) > 64:
                raise ValueError("invalid source amount")
        except InvalidOperation as exc:
            raise ValueError("invalid source amount") from exc
        label = match[2].upper()
        currency = (
            label
            if label in {"USD", "HKD", "CNY"}
            else "HKD"
            if "港" in label
            else "USD"
            if label == "美元"
            else "CNY"
        )
        basis = _BASIS.search(statement[: match.start()])
        shares = int(basis[1] or "1") if basis else None
        if shares is not None and not 1 <= shares <= 10**9:
            shares = None
        legs.append({"sourceAmount": format(value, "f"), "currency": currency, "basisShares": shares})
    special = bool(_SPECIAL.search(statement))
    amount = currency = None
    reason = "non_cash_or_mixed" if special else "missing_or_ambiguous_cash"
    if not special and len(legs) == 1:
        leg = legs[0]
        reason = "unit_basis_unknown" if leg["basisShares"] is None else "nonterminating_per_share_amount"
        if leg["basisShares"] is not None:
            amount = _per_share(Decimal(leg["sourceAmount"]), leg["basisShares"])
            if amount is not None:
                currency, reason = leg["currency"], None
    return {
        "pubDate": source_date(raw.get("pub_date")),
        "exDate": source_date(raw.get("ex_date")),
        "recordDate": source_date(raw.get("record_date")),
        "payDate": source_date(raw.get("dividend_payable_date")),
        "statement": statement,
        "process": raw.get("process"),
        "fiscalYear": None if raw.get("fiscal_year") in (None, "") else str(raw["fiscal_year"]),
        "amount": amount,
        "currency": currency,
        "kind": "special" if special else "cash" if amount is not None else "unknown",
        "cashReceipt": False,
        "yieldPct": None,
        "yieldUnknownReason": "historical_pre_ex_close_unverified",
        "amountUnknownReason": reason,
        "sourceCashLegs": legs,
        "normalizerVersion": NORMALIZER_VERSION,
        "dateSemantics": "provider_calendar_label_not_payment_timestamp",
        "sourceDates": {
            key: raw.get(key) for key in ("pub_date", "ex_date", "record_date", "dividend_payable_date")
        },
    }
