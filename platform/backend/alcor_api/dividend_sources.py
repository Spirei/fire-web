"""Read-only dividend source protocols. No trading, accounts or legacy-Web calls."""

import hashlib
import json
import re
from dataclasses import asdict, dataclass
from datetime import UTC, date, datetime
from decimal import Decimal, InvalidOperation, localcontext
from urllib.parse import quote, urlencode
from zoneinfo import ZoneInfo

from .dividend_announcements import futu_announcement
from .fx_provider_parser import unique

LIMIT = 131072
TIMEZONES = {"US": "America/New_York", "HK": "Asia/Hong_Kong", "CN": "Asia/Shanghai"}
VERSIONS = {"eastmoney": "eastmoney-sharebonus-v1", "yahoo": "yahoo-dividend-epoch-v1"}


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    # Deterministic JSON preserves number-vs-string types and exact decimal values.
    # It is an interpretation, never a claim these were original wire bytes.
    if value is None or isinstance(value, (str, bool, int)):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, Decimal):
        if not value.is_finite():
            raise ValueError("non_finite")
        return str(value)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(canonical(item) for item in value) + "]"
    if isinstance(value, dict) and all(isinstance(key, str) for key in value):
        return (
            "{"
            + ",".join(
                json.dumps(key, ensure_ascii=False) + ":" + canonical(value[key]) for key in sorted(value)
            )
            + "}"
        )
    raise TypeError("unsupported_exact_json_value")


def load(raw):
    if not isinstance(raw, bytes) or not 1 <= len(raw) <= LIMIT:
        raise ValueError("response_size_invalid")
    value = json.loads(
        raw,
        parse_float=Decimal,
        object_pairs_hook=unique,
        parse_constant=lambda _: (_ for _ in ()).throw(ValueError("non_finite")),
    )
    if not isinstance(value, dict):
        raise ValueError("response_not_object")  # noqa: TRY004 -- External protocol failure.
    return value


@dataclass(frozen=True)
class Target:
    """Installed by the instance operator, never constructed from HTTP request input.

    Permission/license acceptance is a dependency, not inferred from a public URL.
    Fixtures must stay visibly synthetic even though their transport is exercised.
    """

    id: str
    source: str
    host: str
    port: int
    addresses: tuple[str, ...]
    approved_access: bool = False
    fixture: bool = False
    scheme: str = "https"
    allow_plaintext: bool = False
    stale_seconds: int = 259200
    dns_policy: str = 'pinned'

    def validate(self, environment):
        import ipaddress

        if self.source not in {"futu", "eastmoney", "yahoo", "coingecko", "tencent"} or not self.approved_access:
            raise ValueError("source_access_unapproved")
        if self.dns_policy not in ('pinned','public_dns'):
            raise ValueError('target_dns_policy_invalid')
        if self.dns_policy=='public_dns':
            from .market_public_dns import validate_mode
            validate_mode(self)
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", self.id) or not self.addresses:
            raise ValueError("target_invalid")
        if self.fixture and environment != "test":
            raise ValueError("fixture_in_non_test_instance")
        if not 1 <= self.port <= 65535 or not 60 <= self.stale_seconds <= 2592000:
            raise ValueError("target_invalid")
        if self.scheme not in {"http", "https"} or (self.scheme == "http" and not self.allow_plaintext):
            raise ValueError("plaintext_unapproved")
        if self.source == "futu" and (self.scheme != "http" or not self.allow_plaintext):
            raise ValueError("native_sdk_plaintext_requires_explicit_approval")
        if self.source=='tencent' and(self.scheme!='https'or self.host not in ('qt.gtimg.cn','web.ifzq.gtimg.cn')or self.port!=443 or self.fixture):raise ValueError('tencent_fixed_target_required')
        if self.source == 'coingecko' and (self.scheme!='https' or self.host.lower()!='api.coingecko.com'
                                          or self.port!=443 or self.fixture):
            raise ValueError('crypto_fixed_target_required')
        if not self.host or any(c in self.host for c in "/?#@"):
            raise ValueError("target_invalid")
        for address in self.addresses:
            parsed = ipaddress.ip_address(address)
            if self.source in {'coingecko','tencent'} and (not parsed.is_global or parsed.is_multicast or parsed.is_reserved):
                raise ValueError('crypto_public_target_required')
        return self

    @property
    def fingerprint(self):
        definition=asdict(self)
        # Existing operator-pinned targets keep their exact pre-upgrade identity.
        if self.dns_policy=='pinned':definition.pop('dns_policy')
        return digest(canonical(definition).encode())

    @property
    def budget_key(self):
        # Approved aliases of one provider endpoint cannot multiply its request quota.
        return digest(canonical([self.source, self.host.lower(), self.port]).encode())

    def path(self, symbol):
        if self.source=='tencent':
            if not re.fullmatch(r'(?:us|hk|sh|sz|bj|jp|kr)[A-Z0-9._]+',symbol):raise ValueError('tencent_symbol_invalid')
            if self.host=='web.ifzq.gtimg.cn':return '/appstock/app/minute/query'
            return '/q='+symbol
        if self.source == 'coingecko':
            return '/api/v3/coins/markets'
        if self.source == "eastmoney":
            return "/securities/api/data/v1/get"
        if self.source == "yahoo":
            return "/v8/finance/chart/" + quote(symbol, safe="")
        return "/sdk/get_corporate_actions_dividends"

    def approval(self, symbol):
        return {
            "target": [self.scheme, self.host, self.port, self.path(symbol)],
            "addresses": list(self.addresses),
            "allow_plaintext": self.allow_plaintext,
            **({'dnsPolicy':'public_fixed_quote_host'} if self.dns_policy=='public_dns' else {}),
        }


def security(source, market, code):
    if market not in TIMEZONES or not isinstance(code, str) or not re.fullmatch(r"[A-Z0-9._-]{1,40}", code):
        raise ValueError("security_invalid")
    if source == "eastmoney":
        if market != "CN" or not re.fullmatch(r"\d{6}", code):
            raise ValueError("eastmoney_requires_cn_security")
        return code
    if source == "futu":
        if market == "HK" and code.isdigit():
            return "HK." + code.lstrip("0").zfill(5)
        if market == "CN" and re.fullmatch(r"\d{6}", code):
            return (
                "BJ."
                if code.startswith(("4", "8", "920"))
                else "SH."
                if code.startswith(("6", "9"))
                else "SZ."
            ) + code
        if market == "US":
            return "US." + re.sub(r"\.(OQ|N|AM|PS|K)$", "", code)
    if source == "yahoo" and market in {"US", "HK"}:
        value = re.sub(r"\.(US|HK|AM|N|OQ|PS|K)$", "", code)
        return value.zfill(4) + ".HK" if market == "HK" and value.isdigit() else value
    raise ValueError("source_security_unsupported")


def request(target, config, cursor):
    symbol = security(target.source, config["market"], config["code"])
    if target.source == "eastmoney":
        params = {
            "reportName": "RPT_SHAREBONUS_DET",
            "columns": "ALL",
            "filter": '(SECURITY_CODE="' + symbol + '")',
            "pageNumber": cursor,
            "pageSize": 200,
            "sortTypes": -1,
            "sortColumns": "EX_DIVIDEND_DATE",
            "source": "HSF10",
            "client": "PC",
        }
    elif target.source == "yahoo":
        # Explicit bounded window, never an implied full-history claim.
        params = {
            "period1": config["periodFrom"],
            "period2": config["periodThrough"],
            "interval": "1d",
            "events": "div,splits",
        }
    else:
        return {"symbol": symbol, "cursor": 1}
    authority = (
        target.host
        if target.port == (443 if target.scheme == "https" else 80)
        else f"{target.host}:{target.port}"
    )
    return {
        "url": f"{target.scheme}://{authority}{target.path(symbol)}?{urlencode(params)}",
        "approval": target.approval(symbol),
        "symbol": symbol,
    }


def numeric(raw):
    if isinstance(raw, bool) or not isinstance(raw, (str, int, Decimal)):
        return None
    try:
        value = Decimal(raw)
    except (InvalidOperation, ValueError):
        return None
    return (
        value
        if value.is_finite()
        and value >= 0
        and len(value.as_tuple().digits) <= 64
        and abs(value.adjusted()) <= 64
        else None
    )


def calendar(raw):
    # Eastmoney's midnight suffix is a calendar label, not a UTC instant.
    if not isinstance(raw, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}(?: 00:00:00)?", raw):
        return None
    try:
        return date.fromisoformat(raw[:10]).isoformat()
    except ValueError:
        return None


def normalize(source, row, market, timezone=None):
    if source == "futu":
        value = futu_announcement(row)
        # Futu documentation establishes market-local YYYY/MM/DD, not arbitrary datetimes.
        value["dateContractVerified"] = all(
            row.get(key) in (None, "")
            or isinstance(row[key], str)
            and re.fullmatch(r"\d{4}/\d{2}/\d{2}", row[key]) is not None
            and value[field] is not None
            for key, field in (
                ("pub_date", "pubDate"),
                ("ex_date", "exDate"),
                ("record_date", "recordDate"),
                ("dividend_payable_date", "payDate"),
            )
        )
        return value
    value = {
        "cashReceipt": False,
        "yieldPct": None,
        "amount": None,
        "currency": None,
        "kind": "unknown",
        "amountUnknownReason": "source_semantics_unverified",
        "normalizerVersion": VERSIONS[source],
        "sourceDates": {},
        "pubDate": None,
        "exDate": None,
        "recordDate": None,
        "payDate": None,
        "nonCashChanges": [],
        "dateContractVerified": False,
        "sourceCashLegs": [],
    }
    if source == "eastmoney":
        if row.get("SECURITY_CODE") is None:
            raise ValueError("source_security_missing")
        cash = numeric(row.get("PRETAX_BONUS_RMB"))
        non_cash = {
            key: str(row[key])
            for key in ("BONUS_RATIO", "IT_RATIO")
            if numeric(row.get(key)) is not None and numeric(row[key]) > 0
        }
        value.update(
            statement=row.get("IMPL_PLAN_PROFILE"),
            process=row.get("ASSIGN_PROGRESS"),
            sourceDates={
                key: row.get(key)
                for key in ("PLAN_NOTICE_DATE", "PUBLISH_DATE", "EX_DIVIDEND_DATE", "EQUITY_RECORD_DATE")
            },
            exDate=calendar(row.get("EX_DIVIDEND_DATE")),
            pubDate=calendar(row.get("PLAN_NOTICE_DATE") or row.get("PUBLISH_DATE")),
            recordDate=calendar(row.get("EQUITY_RECORD_DATE")),
            nonCashChanges=[{"sourceField": key, "perTenShares": val} for key, val in non_cash.items()],
            fiscalYear=str(row.get("REPORT_DATE", ""))[:4] or None,
        )
        if cash is not None:
            value["sourceCashLegs"] = [
                {"sourceAmount": format(cash, "f"), "basisShares": 10, "currency": "CNY"}
            ]
        if cash is not None and row.get("ASSIGN_PROGRESS") == "实施分配" and not non_cash:
            with localcontext() as context:
                context.prec = 128
                value.update(
                    amount=format(cash / Decimal(10), "f"),
                    currency="CNY",
                    kind="cash",
                    amountUnknownReason=None,
                )
        elif non_cash:
            value.update(kind="special", amountUnknownReason="non_cash_or_mixed")
        # Per-ten convention corroborated by publisher's page. Date API contract/closed coverage are unverified.
        value["dateSemantics"] = "observed_calendar_label_unverified_api_contract"
    else:
        epoch, amount = numeric(row.get("date")), numeric(row.get("amount"))
        value.update(
            statement=None,
            process="historical_distribution",
            fiscalYear=None,
            sourceDates={"epoch": str(epoch) if epoch is not None else None},
            nonCashChanges=row.get("_nonCashChanges", []),
        )
        if timezone and epoch is not None and epoch == epoch.to_integral_value():
            try:
                value["exDate"] = (
                    datetime.fromtimestamp(int(epoch), UTC).astimezone(ZoneInfo(timezone)).date().isoformat()
                )
            except (ValueError, OverflowError, OSError):
                pass
        # An observed amount without a documented share/currency/date contract is not booked as exact cash.
        value["sourceAmount"] = None if amount is None else str(amount)
        value["dateSemantics"] = "observed_epoch_with_response_exchange_timezone_unverified_contract"
    return value


@dataclass(frozen=True)
class Page:
    records: tuple
    next_cursor: int | None
    total: int | None
    timezone: str | None
    pagination: str
    non_cash: tuple = ()
    page_count: int = 1


def parse(source, raw, config, cursor):
    root = load(raw)
    market, code = config["market"], config["code"]
    if source == "futu":
        if root.keys() != {"dividend_list"} or not isinstance(root["dividend_list"], list):
            raise ValueError("futu_response_invalid")
        rows = root["dividend_list"]
        if len(rows) > 10000:
            raise ValueError("row_budget_exhausted")
        if any(not isinstance(row, dict) for row in rows):
            raise ValueError("futu_record_invalid")
        return Page(
            tuple((f"/dividend_list/{i}", row, normalize(source, row, market)) for i, row in enumerate(rows)),
            None,
            len(rows),
            TIMEZONES[market],
            "single_sdk_response_not_closed_history",
        )
    if source == "eastmoney":
        result = root.get("result")
        if root.get("success") is not True or not isinstance(result, dict):
            raise ValueError("eastmoney_provider_error")
        pages, count, rows = result.get("pages"), result.get("count"), result.get("data")
        if (
            type(pages) is not int
            or type(count) is not int
            or pages < 1
            or count < 0
            or not isinstance(rows, list)
        ):
            raise ValueError("eastmoney_pagination_invalid")
        if pages > 50 or count > 10000 or cursor > pages or len(rows) > 200 or (count > 0 and not rows):
            raise ValueError("source_pagination_budget_or_gap")
        if any(not isinstance(row, dict) or row.get("SECURITY_CODE") != code for row in rows):
            raise ValueError("source_security_mismatch")
        return Page(
            tuple((f"/result/data/{i}", row, normalize(source, row, market)) for i, row in enumerate(rows)),
            cursor + 1 if cursor < pages else None,
            count,
            TIMEZONES[market],
            "observed_pages_not_snapshot_isolation",
            page_count=pages,
        )
    chart = root.get("chart")
    if (
        not isinstance(chart, dict)
        or chart.get("error") is not None
        or not isinstance(chart.get("result"), list)
        or len(chart["result"]) != 1
    ):
        raise ValueError("yahoo_provider_error")
    result = chart["result"][0]
    if not isinstance(result, dict) or not isinstance(result.get("meta"), dict):
        raise ValueError("yahoo_metadata_invalid")  # noqa: TRY004 -- External protocol failure.
    if result["meta"].get("symbol") != security(source, market, code):
        raise ValueError("source_security_mismatch")
    timezone = result["meta"].get("exchangeTimezoneName")
    try:
        ZoneInfo(timezone)
    except (TypeError, ValueError, KeyError):
        timezone = None
    events = result.get("events")
    if events is None:
        # Absence is retained, not asserted to prove no corporate actions existed.
        events = {}
    if not isinstance(events, dict):
        raise ValueError("yahoo_events_invalid")  # noqa: TRY004 -- External protocol failure.
    rows, splits = events.get("dividends", {}), events.get("splits", {})
    if not isinstance(rows, dict) or not isinstance(splits, dict) or len(rows) + len(splits) > 10000:
        raise ValueError("yahoo_events_invalid")
    records = []
    for key, row in rows.items():
        if not isinstance(row, dict) or not key.isdigit() or str(row.get("date")) != key:
            raise ValueError("yahoo_event_identity_invalid")
        epoch = numeric(row.get("date"))
        if epoch is None or not config["periodFrom"] <= epoch < config["periodThrough"]:
            raise ValueError("yahoo_event_outside_window")
        normalized = normalize(source, row, market, timezone)
        normalized["sourceCurrency"] = result["meta"].get("currency")
        records.append(("/chart/result/0/events/dividends/" + key, row, normalized))
    for key, row in splits.items():
        if not isinstance(row, dict) or not key.isdigit():
            raise ValueError("yahoo_split_invalid")
        epoch = numeric(row.get("date"))
        if (
            epoch is None
            or str(row["date"]) != key
            or not config["periodFrom"] <= epoch < config["periodThrough"]
        ):
            raise ValueError("yahoo_event_outside_window")
        # Preserve split information; the unified quantity ledger remains the only place to apply it.
        records.append(
            (
                "/chart/result/0/events/splits/" + key,
                row,
                {**normalize(source, row, market, timezone), "kind": "special", "nonCashChanges": [row]},
            )
        )
    return Page(
        tuple(records),
        None,
        len(records),
        timezone,
        "bounded_epoch_window_no_closed_history",
        tuple(splits.values()),
    )
