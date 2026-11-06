"""Pure evidence and full-history checks; does not mutate trades or cash."""

from decimal import Decimal, localcontext
from zoneinfo import ZoneInfo

from .fee_rules import reconstruct
from .trade_accounting import FilledTrade, Position, apply_filled_trade, replay_economic_trades

UNSET = object()


def unresolved_fee(row):
    return bool(row.get("actual_fee_pending")) or (row.get("source") in ("legacy_import_zero", "unverified_legacy"))


def trade(row, fees=UNSET):
    if row.get('_effective_event'):
        row={**row,**row['_effective_event']}
        fees=Decimal(row['fees'])
    if fees is UNSET:
        fees = None if unresolved_fee(row) else row["fees"]
    return FilledTrade(
        row["side"],
        row["quantity"],
        row["price"],
        fees,
        row["amount"],
        row["currency"],
        row["settlement_currency"],
        row["settlement_amount"],
    )


def effective_trades(rows,fees,*,registered=False):
    from .trade_amendment_history import effective_rows
    return [trade(row,fees.get(row['id'],row['fees'] if registered else UNSET)) for row in effective_rows(rows)]


def replay(rows, record, corrections, projections):
    rows = sorted(rows, key=lambda row: row["before_record_revision"])
    if record.get('position_transfer_id'):
        from .trade_amendment_history import transfer_replay
        return transfer_replay(rows,record,corrections,projections)
    if rows and rows[0].get('_record_amendments'):
        from .trade_amendment_history import amended_replay
        return amended_replay(rows,record,corrections,projections)
    if not rows or rows[0]["before_quantity"] != 0 or rows[0]["previous_trade_id"] is not None:
        raise ValueError("opening_history_missing")
    initial = Position(Decimal(0), rows[0]["before_cost"])
    original = initial
    previous = None
    previous_revision = 0
    for row in rows:
        intervening = [
            p
            for p in projections
            if previous_revision <= p["before_record_revision"] < row["before_record_revision"]
            and p["trade_tip_id"] == previous
        ]
        if intervening:
            latest = max(intervening, key=lambda p: p["before_record_revision"])
            original = Position(original.quantity, latest["after_cost"])
        if (
            row["previous_trade_id"] != previous
            or row["before_record_revision"] <= previous_revision
            or row["before_quantity"] != original.quantity
            or row["before_cost"] != original.cost
        ):
            raise ValueError("history_lineage_incomplete")
        original = apply_filled_trade(original, trade(row, row["fees"])).position
        if original.quantity != row["after_quantity"] or original.cost != row["after_cost"]:
            raise ValueError("original_projection_mismatch")
        previous, previous_revision = row["id"], row["before_record_revision"]
    recent = [
        p
        for p in projections
        if p["before_record_revision"] > previous_revision and p["trade_tip_id"] == previous
    ]
    if recent:
        original = Position(
            original.quantity, max(recent, key=lambda p: p["before_record_revision"])["after_cost"]
        )
    if (
        record["trade_tip_id"] != previous
        or record["qty"] != original.quantity
        or record["cost"] != original.cost
    ):
        raise ValueError("current_projection_mismatch")
    events = [trade(row, corrections.get(row["id"], UNSET)) for row in rows]
    position = initial
    for event in events:
        position = apply_filled_trade(position, event).position
    unresolved = any(unresolved_fee(row) and row["id"] not in corrections for row in rows)
    if position.quantity != record["qty"] or not unresolved and position.cost != record["cost"]:
        raise ValueError("effective_history_mismatch")
    return initial, events


def eligibility(row, record, account, selection, evidence, corrected, checkpoint):
    from .position_transfer_checkpoint import opening
    boundary=opening(record)
    if boundary is not None and row['before_record_revision']<=boundary['revision']:
        return 'immutable_position_transfer_boundary'
    if account["holding_source"] != "manual":
        return "official_account_readonly"
    if row["account_id"] != account["id"] or record["broker_account_id"] != account["id"]:
        return "broker_ownership_unconfirmed"
    if row["side"] not in ("buy", "sell"):
        return "not_filled_equity_trade"
    if row["source"] == "owner_recorded":
        return "explicit_fee_preserved"
    if row["source"] not in ("legacy_import_zero", "unverified_legacy"):
        return "api_fee_preserved"
    if row["fees"] != 0:
        return "existing_fee_preserved"
    if corrected:
        return "fee_already_reconstructed"
    expected = (
        "US"
        if account["provider_id"] == "longbridge"
        else "CN"
        if account["provider_id"] == "huatai"
        else None
    )
    if (
        not expected
        or record["market"] != expected
        or record["account_market"] not in ("", expected)
        or row["settlement_currency"] != row["currency"]
        or row["settlement_amount"] is not None
    ):
        return "market_or_settlement_not_supported"
    if checkpoint and row["occurred_at"] <= checkpoint:
        return "opening_checkpoint_requires_reconciliation"
    if not evidence:
        return "legacy_source_inventory_missing"
    authority = evidence["detail"].get("feeAuthority")
    if authority not in ("legacy_import_zero", "unverified_legacy"):
        return "explicit_fee_preserved"
    if authority == "unverified_legacy" and selection.get("legacyImportConfirmed") is not True:
        return "legacy_import_proof_missing_manual_review"
    if not selection.get("brokerOwnershipConfirmed"):
        return "historical_broker_ownership_unconfirmed"
    if not selection.get("wholeOrderConfirmed"):
        return "split_order_or_discount_unconfirmed"
    return None


def candidate(row, record, account, selection, plan):
    local_day = (
        row["occurred_at"]
        .astimezone(ZoneInfo("America/New_York" if record["market"] == "US" else "Asia/Shanghai"))
        .date()
        .isoformat()
    )
    estimate = reconstruct(
        account["provider_id"],
        local_day,
        row["side"],
        row["quantity"],
        row["price"],
        selection["instrumentKind"],
        plan,
    )
    if estimate["reason"]:
        return estimate["reason"], None
    return None, {
        "orderId": str(row["id"]),
        "recordId": record["id"],
        "market": record["market"],
        "code": record["code"],
        "side": row["side"],
        "qty": str(row["quantity"]),
        "price": str(row["price"]),
        "tradedAt": row["occurred_at"].isoformat(),
        "oldFees": str(row["fees"]),
        "newFees": estimate["fees"],
        "feeDelta": str(Decimal(estimate["fees"]) - row["fees"]),
        "currency": row["currency"],
        "components": estimate["components"],
        "source": "owner_reconstructed",
        "confirmation": selection,
    }


def effective_projection(rows, record, corrections, projections):
    with localcontext() as context:
        context.prec = 80
        return _effective_projection(rows, record, corrections, projections)


def _effective_projection(rows, record, corrections, projections):
    from .position_transfer_checkpoint import current_rows, economic_initial, opening
    all_rows = sorted(rows, key=lambda row: row["before_record_revision"])
    initial, events = replay(all_rows, record, corrections, projections)
    ordered = current_rows(all_rows,record)
    economics = []
    replay_economic_trades(economic_initial(record,initial), events, on_step=economics.append)
    previous_pnl = Decimal(0)
    position = initial
    result = {row['id']: {key: row[key] for key in ('before_quantity','before_cost','after_quantity','after_cost','realized_pnl')} for row in all_rows if row not in ordered}
    if opening(record) is not None:
        for value in result.values():
            value['projectionScope']='pre_transfer_original_registration'
    if opening(record) is not None or ordered and ordered[0].get('_record_amendments'):
        from .trade_amendment_history import effective_rows
        active=effective_rows(ordered)
        result.update({row['id']:{'before_quantity':None,'before_cost':None,'after_quantity':None,'after_cost':None,'realized_pnl':None} for row in ordered if row.get('_effective_inactive')})
    else:active=ordered
    for row, event, economic in zip(active, events, economics):
        before = position
        position = apply_filled_trade(position, event).position
        pnl = (
            None
            if event.side == "buy" or economic.realized_pnl is None or previous_pnl is None
            else economic.realized_pnl - previous_pnl
        )
        previous_pnl = economic.realized_pnl
        result[row["id"]] = {
            "before_quantity": before.quantity,
            "before_cost": before.cost,
            "after_quantity": position.quantity,
            "after_cost": position.cost,
            "realized_pnl": pnl,
        }
    return result
