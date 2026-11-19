"""Closing dates proved by an immutable imported order book."""

from collections import OrderedDict
from datetime import UTC, datetime
from decimal import Decimal

from .database_migration_history import observed_time
from .legacy_order_projection import native_fields
from .portfolio_records import symbol


_closing_cache = OrderedDict()
_CACHE_LIMIT = 32


def confirmed_last_sales(source):
    if native_fields(source, ()) is None:
        return {}
    packet = source["originals"]
    last_by_record, unknown_dates, tied = {}, set(), set()
    for order in packet["orders"]:
        if order["status"] != "filled" or order["side"] not in ("buy", "sell"):
            continue
        normalized = packet["normalized_orders"][order["id"]]
        record_id = packet["maps"]["records"][order["record_id"]]
        try:
            observed = datetime.fromisoformat(normalized.get("occurredAt"))
        except (ValueError, TypeError):
            unknown_dates.add(record_id)
            continue
        if observed.utcoffset() is None:
            unknown_dates.add(record_id)
            continue
        created = observed_time(order.get("created_at"), packet["timezone"])
        ranking = (observed, datetime.fromisoformat(created) if created else datetime.min.replace(tzinfo=UTC))
        prior = last_by_record.get(record_id)
        if prior is None or prior[0] < ranking:
            last_by_record[record_id] = ranking, order, normalized
            tied.discard(record_id)
        elif prior[0] == ranking:
            tied.add(record_id)
    closed = {}
    for record_id, (ranking, order, normalized) in last_by_record.items():
        if record_id in unknown_dates or record_id in tied or order["side"] != "sell":
            continue
        try:
            before, after, sold = (Decimal(order[key]) for key in ("position_qty_before", "position_qty_after", "qty"))
        except (KeyError, TypeError, ArithmeticError):
            continue
        if before.is_finite() and sold.is_finite() and after.is_finite() and before == sold > 0 and after == 0:
            market = order["market"]
            closed[record_id] = (market, symbol(order["code"], market), normalized["accountKind"], ranking[0])
    return closed


def registered_closures(source, owner, records, actual, accounts, now):
    if source is None:
        return {}
    candidates = [
        row for row in records if row["qty"] in (None, 0)
        and not (row["trade_tip_id"] or row["position_transfer_id"] or actual[row["id"]].get("officialObservation"))
    ]
    if not candidates:
        return {}
    key = (owner, source["source_sha256"])
    if key not in _closing_cache:
        _closing_cache[key] = confirmed_last_sales(source)
        if len(_closing_cache) > _CACHE_LIMIT:
            _closing_cache.popitem(last=False)
    _closing_cache.move_to_end(key)
    dates = _closing_cache[key]
    confirmed = {}
    for row in candidates:
        evidence = dates.get(row["id"])
        if evidence is None:
            continue
        market, code, kind, when = evidence
        account = accounts.get(row["broker_account_id"])
        if (market == row["market"] and code == symbol(row["code"], market) and when <= now
                and (account is None or account["account_kind"] == kind)):
            confirmed[row["id"]] = when
    return confirmed
