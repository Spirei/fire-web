"""Market identities and actual source facts; no source IO, scheduling or inferred OHLC."""

import hashlib
import json
import re
from dataclasses import dataclass
from datetime import UTC, date, datetime
from decimal import Decimal, InvalidOperation, localcontext
from zoneinfo import ZoneInfo

MARKETS = ("US", "HK", "CN", "JP", "KR", "SG", "ASSET")
ZONES = {
    "US": "America/New_York",
    "HK": "Asia/Hong_Kong",
    "CN": "Asia/Shanghai",
    "JP": "Asia/Tokyo",
    "KR": "Asia/Seoul",
    "SG": "Asia/Singapore",
    "ASSET": "UTC",
}
CURRENCIES = {"US": "USD", "HK": "HKD", "CN": "CNY", "JP": "JPY", "KR": "KRW", "SG": "SGD", "ASSET": "USD"}


def canonical(value):
    if isinstance(value, Decimal):
        if not value.is_finite():
            raise ValueError("non_finite")
        return str(value)
    if value is None or isinstance(value, (str, int, bool)):
        return json.dumps(value, ensure_ascii=False)
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
    raise ValueError("exact_json_required")


def digest(value):
    return hashlib.sha256(value if isinstance(value, bytes) else canonical(value).encode()).hexdigest()


def code(market, raw):
    if market not in MARKETS or not isinstance(raw, str):
        raise ValueError("security_invalid")
    value = raw.strip().upper()
    if market == "US":
        value = re.sub(r"\.(AM|N|OQ|PS|K)$", "", value)
    elif market == "HK" and value.isascii() and value.isdigit():
        value = value.lstrip("0").zfill(5)
    elif market == "CN" and value.isascii() and value.isdigit():
        value = value.zfill(6)
    elif market == "JP":
        value = re.sub(r"\.T$", "", value)
    elif market == "KR":
        value = re.sub(r"\.(KS|KQ)$", "", value)
    if not re.fullmatch(r"[A-Z0-9._-]{1,40}", value):
        raise ValueError("security_invalid")
    return value


def public_items(items):
    values = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        try:
            market = item["market"]
            symbol = code(market, item["code"])
        except (ValueError, KeyError, TypeError):
            continue
        key = json.dumps([market, symbol], separators=(",", ":"))
        values[key] = {"id": key, "market": market, "code": symbol}
    return list(values.values())


def number(raw, *, positive=False, signed=False):
    if isinstance(raw, bool) or not isinstance(raw, (str, int, float, Decimal)):
        raise TypeError("observed_number_required")
    try:
        value = Decimal(str(raw))
    except InvalidOperation as exc:
        raise ValueError("invalid_number") from exc
    if (
        not value.is_finite()
        or len(value.as_tuple().digits) > 64
        or abs(value.adjusted()) > 64
        or (value <= 0 if positive else value < 0 and not signed)
    ):
        raise ValueError("invalid_number")
    return value


def source_time(value, timezone):
    """Reject DST ambiguity/nonexistence unless the source supplied an actual offset."""
    if not isinstance(value, str):
        raise TypeError("source_time_required")
    try:
        stamp = datetime.fromisoformat(value)
        zone = ZoneInfo(timezone)
    except (ValueError, KeyError) as exc:
        raise ValueError("source_time_invalid") from exc
    if stamp.tzinfo is not None:
        return stamp.astimezone(UTC)
    candidates = {
        stamp.replace(tzinfo=zone, fold=fold).astimezone(UTC)
        for fold in (0, 1)
        if stamp.replace(tzinfo=zone, fold=fold).astimezone(UTC).astimezone(zone).replace(tzinfo=None)
        == stamp
    }
    if len(candidates) != 1:
        raise ValueError("source_local_time_ambiguous_or_nonexistent")
    return candidates.pop()


@dataclass(frozen=True)
class Query:
    kind: str
    market: str
    code: str
    frame: str = "latest"
    adjust: str = "none"
    session: str = "REGULAR"
    instrument: str = "equity"
    start: str | None = None
    through: str | None = None

    def validate(self):
        if self.kind not in {"latest", "bars", "price_series"} or self.code != code(self.market, self.code):
            raise ValueError("query_invalid")
        if (
            self.frame not in {"latest", "minute", "day", "week", "month", "quarter", "year"}
            or self.adjust not in {"none", "qfq", "hfq"}
            or self.session not in {"REGULAR", "ALL", "PRE", "AFTER", "OVERNIGHT"}
            or self.instrument not in {"equity", "index", "asset"}
        ):
            raise ValueError("query_semantics_invalid")
        if self.kind == "latest":
            if (
                self.frame != "latest"
                or self.adjust != "none"
                or self.start is not None
                or self.through is not None
            ):
                raise ValueError("latest_not_history")
        else:
            try:
                begin, end = date.fromisoformat(self.start), date.fromisoformat(self.through)
            except (ValueError, TypeError) as exc:
                raise ValueError("explicit_history_window_required") from exc
            if begin > end or (end - begin).days > 366 * 15 or self.frame == "latest":
                raise ValueError("history_window_invalid")
            if self.kind == "price_series" and self.adjust != "none":
                raise ValueError("price_series_has_no_corporate_adjustment_claim")
        return self


def series_fingerprint(query):
    from dataclasses import asdict

    return digest({key: value for key, value in asdict(query).items() if key not in {"start", "through"}})


def snapshot_metrics(row):
    """Observed SDK metrics only; equity-only values require its explicit validity marker."""
    value = row.get("equity_valid")
    valid = (
        value
        if type(value) is bool
        else value.lower() == "true"
        if isinstance(value, str) and value.lower() in ("true", "false")
        else None
    )
    result = {"equityValid": valid} if valid is not None else {}
    trust = row.get('trust_valid')
    trust_valid = trust if type(trust) is bool else trust.lower() == 'true' if isinstance(trust, str) and trust.lower() in ('true', 'false') else None
    if trust_valid is not None:
        result['fundValid'] = trust_valid
    if trust_valid is True:
        # The provider's fund units/AUM are separate from equity issued shares and market cap.
        for source, field in (('trust_outstanding_units', 'fundUnits'), ('trust_aum', 'fundAssetsUnderManagement'),
                              ('trust_netAssetValue', 'fundNetAssetValue')):
            if row.get(source) is not None:
                try:
                    result[field] = str(number(row[source], positive=True))
                except (ValueError, TypeError, OverflowError):
                    pass
    fields = [
        ("turnover_rate", "turnover", False, False),
        ("amplitude", "amplitude", False, False),
        ("volume_ratio", "volumeRatio", False, False),
        ("avg_price", "averagePrice", True, False),
        ("highest52weeks_price", "weekHigh", True, False),
        ("lowest52weeks_price", "weekLow", True, False),
    ]
    if valid is True:
        fields += [
            ("total_market_val", "marketCap", True, False),
            ("circular_market_val", "circularMarketVal", True, False),
            ("issued_shares", "totalShares", True, False),
            ("outstanding_shares", "floatShares", True, False),
            ("dividend_ratio_ttm", "dividendYieldTtm", False, False),
            ("dividend_ttm", "dividendTtm", False, False),
            ("earning_per_share", "earningPerShare", False, True),
            ("pe_ttm_ratio", "peTtm", False, True),
            ("pe_ratio", "peRatio", False, True),
            ("pb_ratio", "pb", False, True),
        ]
    for source, target, positive, signed in fields:
        if row.get(source) is None:
            continue
        try:
            metric = number(row[source], positive=positive, signed=signed)
            if signed and metric == 0 and target in ("peTtm", "peRatio", "pb"):
                continue
            result[target] = str(metric)
        except (ValueError, TypeError, OverflowError):
            continue
    if "earningPerShare" in result:
        result["earningPerSharePeriod"] = "unspecified"
    if (
        "weekHigh" in result
        and "weekLow" in result
        and Decimal(result["weekHigh"]) < Decimal(result["weekLow"])
    ):
        result.pop("weekHigh")
        result.pop("weekLow")
    if "peTtm" in result:
        result.update(pe=result["peTtm"], peBasis="pe_ttm_ratio")
    elif "peRatio" in result:
        result.update(pe=result["peRatio"], peBasis="pe_ratio")
    return result



def latest_snapshot(row, query, stamp):
    # Derived baselines/ratios must not truncate a provider observation to Decimal's default 28 digits.
    with localcontext() as context:
        context.prec = 160
        return _latest_snapshot(row, query, stamp)


def _latest_snapshot(row, query, stamp):
    """Select a source field, never relabel regular prices as an extended session."""
    requested = query.session
    if requested == 'ALL' or requested != 'REGULAR' and query.market != 'US':
        raise ValueError('latest_session_not_supported')
    prefix = {'PRE':'pre','AFTER':'after','OVERNIGHT':'overnight'}.get(requested)
    local = stamp.astimezone(ZoneInfo(ZONES[query.market]))
    minute = local.hour * 60 + local.minute
    if prefix and not ({'PRE':240 <= minute < 570, 'AFTER':960 <= minute < 1200,
                        'OVERNIGHT':minute >= 1200 or minute < 240}[requested]):
        raise ValueError('snapshot_update_outside_requested_session')
    price = number(row.get(prefix + '_price' if prefix else 'last_price'), positive=True)
    result = {'price':str(price),'name':row.get('name') if isinstance(row.get('name'),str) else '',
              'session':requested if prefix else 'UNKNOWN','requestedSession':requested,
              'priceField':prefix + '_price' if prefix else 'last_price',
              'cached':None,'providerCacheState':'unknown',
              'sourceTimestampAuthority':'snapshot_update_time_not_individual_extended_trade_time' if prefix else 'snapshot_update_time_not_individual_trade_time',
              'sessionWindowAuthority':'source_snapshot_local_clock_window_not_verified_trading_calendar',
              'individualSessionTradeTimeKnown':False,
              'priceNumberAuthority':'sdk_scalar_decimal_text_not_wire_precision',
              'prevClose':None,'change':None,'changePct':None}
    def optional(source, target, *, positive=False, signed=False):
        if row.get(source) is not None:
            try:
                result[target] = str(number(row[source],positive=positive,signed=signed))
            except (ValueError,TypeError,OverflowError):
                pass
    # Only fields of the selected session populate its volumes/highs/lows.
    for source,target in ((prefix+'_high_price' if prefix else 'high_price','high'),
                          (prefix+'_low_price' if prefix else 'low_price','low'),
                          (prefix+'_volume' if prefix else 'volume','volume'),
                          (prefix+'_turnover' if prefix else 'turnover','amount')):
        optional(source,target,positive=target in ('high','low'))
    if not prefix:
        optional('open_price','open',positive=True)
    optional('prev_close_price','regularPrevClose',positive=True)
    if prefix:
        optional(prefix+'_change_val','providerSessionChange',signed=True)
        optional(prefix+'_change_rate','providerSessionChangePct',signed=True)
        if requested in ('PRE','OVERNIGHT'):
            delta = result.get('providerSessionChange')
            if delta is None:
                # An older regular baseline is not proof of this extended cycle.
                raise ValueError('extended_session_baseline_unknown')
            previous = price - Decimal(delta)
            if previous <= 0:
                raise ValueError('extended_session_baseline_invalid')
            result.update(prevClose=str(previous),change=delta,
                          changePct=str(Decimal(delta)/previous*100),
                          changeBasis='source_session_price_minus_source_session_change')
        elif 'regularPrevClose' in result:
            previous = Decimal(result['regularPrevClose'])
            result.update(prevClose=str(previous),change=str(price-previous),
                          changePct=str((price-previous)/previous*100),changeBasis='extended_price_vs_regular_previous_close')
        else:
            result.update(change=result.get('providerSessionChange'),changePct=result.get('providerSessionChangePct'),
                          changeBasis='provider_after_hours_change_baseline_unspecified')
    elif 'regularPrevClose' in result:
        previous = Decimal(result['regularPrevClose'])
        result.update(prevClose=str(previous),change=str(price-previous),
                      changePct=str((price-previous)/previous*100),changeBasis='last_price_vs_source_prev_close')
    # Source instrument identity is explicit; OTC/underlying classification is never guessed from ticker.
    for source,target in (('stock_owner','underlyingSymbol'),('sec_status','securityStatus')):
        if isinstance(row.get(source),str) and row[source]:
            result[target] = row[source]
    for source,target in (('suspension','suspended'),('equity_valid','equityValid'),('index_valid','indexValid'),
                          ('trust_valid','fundValid'),('wrt_valid','warrantValid'),('option_valid','optionValid')):
        if type(row.get(source)) is bool:
            result[target] = row[source]
    optional('price_spread','priceSpread',positive=True)
    optional('lot_size','lotSize',positive=True)
    result['otc'] = None
    return result


def futu_rows(payload, query):
    """Normalize the real SDK records representation; an invalid row never becomes zero."""
    query.validate()
    if (
        not isinstance(payload, dict)
        or not isinstance(payload.get("records"), list)
        or len(payload["records"]) > (6000 if query.kind == "price_series" else 1000)
    ):
        raise ValueError("futu_records_invalid")
    from .dividend_sources import security

    symbol = security("futu", query.market, query.code)
    facts, issues = [], []
    for position, row in enumerate(payload["records"]):
        try:
            if not isinstance(row, dict) or row.get("code") != symbol:
                raise ValueError("source_security_mismatch")
            stamp = source_time(
                row.get("update_time" if query.kind == "latest" else "time" if query.kind == "price_series" else "time_key"), ZONES[query.market]
            )
            if (
                query.kind != "latest"
                and not query.start
                <= stamp.astimezone(ZoneInfo(ZONES[query.market])).date().isoformat()
                <= query.through
            ):
                raise ValueError("source_outside_requested_window")
            fact = {
                "at": stamp.isoformat(),
                "currency": CURRENCIES[query.market],
                "marketTimezone": ZONES[query.market],
                "source": "futu",
                "sourceVersion": "futu-sdk-records-v1",
                "session": "UNKNOWN" if query.kind == "latest" else query.session,
            }
            if query.kind == "latest":
                fact.update(latest_snapshot(row, query, stamp))
                metrics = snapshot_metrics(row)
                if query.session != 'REGULAR':
                    fact['regularSnapshotMetrics'] = {key:metrics.pop(key) for key in
                        ('turnover','amplitude','volumeRatio','averagePrice') if key in metrics}
                    for source,target in (({'PRE':'pre','AFTER':'after','OVERNIGHT':'overnight'}[query.session]+'_amplitude','amplitude'),):
                        if row.get(source) is not None:
                            try:
                                fact[target] = str(number(row[source]))
                            except (ValueError,TypeError):
                                pass
                fact.update(metrics)
                fact["snapshotMetricsVersion"] = 2
            elif query.kind == "bars":
                values = {
                    key: number(row.get(source), positive=True)
                    for key, source in (("o", "open"), ("h", "high"), ("l", "low"), ("c", "close"))
                }
                if values["h"] < max(values.values()) or values["l"] > min(values.values()):
                    raise ValueError("source_ohlc_inconsistent")
                fact.update({key: str(value) for key, value in values.items()})
                for source, target in (("volume", "v"), ("turnover", "amount")):
                    if row.get(source) is not None:
                        fact[target] = str(number(row[source]))
            elif query.kind == 'price_series':
                # Futu explicitly calls is_blank=True forged data. Never persist such points as facts.
                if row.get('is_blank') is not False:
                    raise ValueError('source_blank_or_unverified_point')
                fact.update(price=str(number(row.get('cur_price'),positive=True)), dataKind='provider_real_time_time_frame', sourceBlank=False)
                for source,target,positive in (('avg_price','avgPrice',True),('last_close','prevClose',True),('volume','volume',False),('turnover','amount',False)):
                    fact[target] = None
                    if row.get(source) is not None:
                        try:
                            fact[target] = str(number(row[source],positive=positive))
                        except (ValueError,TypeError):
                            pass
            else:
                raise ValueError("futu_price_series_protocol_not_installed")
            facts.append(fact)
        except (ValueError, TypeError, KeyError):
            issues.append({"position": position, "reason": "source_record_invalid_or_unknown"})
    return facts, issues


def installed_latest_semantics(query):
    return (query.kind == 'latest' and query.frame == 'latest' and query.adjust == 'none'
            and query.instrument == 'equity' and query.market in ('US','HK','CN')
            and (query.session == 'REGULAR' or query.market == 'US' and query.session in ('PRE','AFTER','OVERNIGHT')))


def installed_bar_semantics(query):
    return (
        query.kind == "bars"
        and query.instrument == "equity"
        and (
            query.frame in ("day", "week", "month", "quarter", "year")
            and query.session == "REGULAR"
            or query.frame == "minute"
            and (query.session == "REGULAR" or query.session == "ALL" and query.market == "US")
        )
    )



def installed_price_series_semantics(query):
    return (query.kind == 'price_series' and query.frame == 'minute' and query.adjust == 'none'
            and query.instrument == 'equity' and query.market in ('US','HK','CN')
            and (query.session == 'REGULAR' or query.session == 'ALL' and query.market == 'US'))


def collection_purpose(query):
    if query.kind == "latest":
        return "latest"
    value = query.kind + "." + query.frame
    return value + "." + query.session if query.frame == "minute" else value
