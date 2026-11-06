"""Quote provenance and annual-session checks. No caller-supplied completeness flags."""

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

from .fx_provider_parser import unique
from .fx_provider_transport import fetch
from .price_alert_contract import timestamp

ZONES = {"US": "America/New_York", "HK": "Asia/Hong_Kong", "CN": "Asia/Shanghai"}


@dataclass(frozen=True)
class Quote:
    owner: str
    account: str
    source_identity: str
    source_id: str
    version: str
    market: str
    code: str
    amount: Decimal
    currency: str
    at: object
    received: object
    session: str
    cached: bool | None
    raw: bytes
    fixture: bool = False
    observation_authority: str | None = None


class ControlledHttpQuotes:
    """Installed test protocol only; it is not a real supplier API adapter."""

    source_id = "controlled-http-quote"
    version = "controlled-quote-v1"
    fixture = True

    def __init__(self, url, approval, now):
        self.url, self.approval, self.now = url, approval, now

    @property
    def fingerprint(self):
        return hashlib.sha256(
            json.dumps([self.source_id, self.version, self.url, self.approval], sort_keys=True).encode()
        ).hexdigest()

    async def read(self, row):
        raw = await fetch(self.url, self.approval)
        value = json.loads(raw, parse_float=Decimal, object_pairs_hook=unique)
        expected = (
            row["owner_id"],
            row["account_id"],
            row["source_identity"],
            row["config"]["market"],
            row["config"]["code"],
        )
        if tuple(value.get(k) for k in ("owner", "account", "sourceIdentity", "market", "code")) != expected:
            raise ValueError("quote_scope_mismatch")
        if not isinstance(value.get("price"), str) or type(value.get("cached")) is not bool:
            raise ValueError("quote_precision_or_cache_unknown")
        amount = Decimal(value["price"])
        if (
            not amount.is_finite()
            or amount <= 0
            or len(amount.as_tuple().digits) > 64
            or abs(amount.adjusted()) > 64
        ):
            raise ValueError("quote_invalid")
        return Quote(
            *expected[:3],
            self.source_id,
            self.version,
            *expected[3:],
            amount,
            value.get("currency"),
            timestamp(value.get("time")),
            self.now(),
            value.get("session"),
            value["cached"],
            raw,
            True,
        )


async def session_context(conn, quote):
    """Annual calendar is only the schedule; fresh source session is independently required."""
    local = quote.at.astimezone(ZoneInfo(ZONES[quote.market]))
    day = local.date()
    if quote.market == "US" and quote.session == "OVERNIGHT" and local.hour >= 20:
        day += timedelta(days=1)
    row = await (
        await conn.execute(
            """SELECT d.*,m.timezone FROM market_calendar_active a JOIN market_calendar_days d ON d.revision=a.revision
        JOIN market_calendar_markets m ON m.revision=d.revision AND m.market=d.market WHERE a.singleton
        AND d.market=%s AND d.day=%s""",
            (quote.market, day),
        )
    ).fetchone()
    if not row or row["status"] not in {"trading", "half_day"} or not row["source_ids"]:
        return None
    hhmm = local.strftime("%H:%M")
    close = (
        row["continuous_close"]
        if row["status"] == "half_day"
        else {"US": "16:00", "HK": "16:00", "CN": "15:00"}[quote.market]
    )
    if quote.market == "US":
        expected = (
            "PRE"
            if "04:00" <= hhmm < "09:30"
            else "REGULAR"
            if "09:30" <= hhmm < close
            else "AFTER"
            if close <= hhmm < "20:00"
            else "OVERNIGHT"
            if hhmm >= "20:00" or hhmm < "04:00"
            else None
        )
    else:
        afternoon = "13:00"
        expected = "REGULAR" if "09:30" <= hhmm < "11:30" or afternoon <= hhmm < close else None
        if quote.market == "HK" and "11:30" <= hhmm < "12:00" and hhmm < close:
            expected = "REGULAR"
    if expected != quote.session and not (expected and quote.session=='ALL' and quote.observation_authority=='source_rt_observed_point'):
        return None
    return {
        "date": day.isoformat(),
        "calendarRevision": row["revision"],
        "marketTimezone": row["timezone"],
        "rawSha256": hashlib.sha256(quote.raw).hexdigest(),
        "quoteObservationAuthority": quote.observation_authority,
        "providerCacheState": 'unknown' if quote.cached is None else 'source_declared',
        "observedSession": expected,
    }


def admissible(quote, row, now, environment):
    if not isinstance(quote, Quote) or quote.fixture and environment != "test":
        return False
    if (
        not isinstance(quote.at, datetime)
        or quote.at.tzinfo is None
        or not isinstance(quote.received, datetime)
        or quote.received.tzinfo is None
        or not isinstance(quote.raw, bytes)
        or not 1 <= len(quote.raw) <= (2097152 if quote.observation_authority=='source_rt_observed_point' else 131072)
    ):
        return False
    if (
        not isinstance(quote.amount, Decimal)
        or not quote.amount.is_finite()
        or quote.amount <= 0
        or abs(quote.amount.adjusted()) > 64
        or len(quote.amount.as_tuple().digits) > 64
    ):
        return False
    rule = row["config"]
    return (
        (quote.owner, quote.account, quote.source_identity, quote.market, quote.code)
        == (row["owner_id"], row["account_id"], row["source_identity"], rule["market"], rule["code"])
        and quote.source_id
        and quote.version
        # Real RT points are independently re-parsed from their source original. This does not assert an uncached network response.
        and (quote.cached is False or quote.cached is None and quote.observation_authority=='source_rt_observed_point')
        and quote.currency == {"US": "USD", "HK": "HKD", "CN": "CNY"}[rule["market"]]
        and quote.at >= row["activated_at"]
        and (row["last_quote_at"] is None or quote.at > row["last_quote_at"])
        and -5 <= (now - quote.at).total_seconds() <= 90
        and quote.received <= now + timedelta(seconds=5)
        and (rule["extended"] or quote.session == "REGULAR")
    )
