"""Pure observed broker-position/cash overview over existing PG authorities.

Different account kinds and original currencies never share a cash book. This
is not a complete wealth report, a performance time series or a broker balance.
"""

import hashlib
import json
from collections import defaultdict
from datetime import date, datetime
from decimal import Decimal, localcontext
from uuid import UUID

from fastapi import HTTPException

from .actual_projection import actual_records_dto, confirmed_actual_fees
from .cash_overview import CashOverview
from .fee_repair_model import replay
from .fx_reference import FxWorker
from .legacy_asset_authority import LegacyAssetAuthority
from .legacy_asset_snapshot import CURRENCIES, complete_sum, decimal
from .legacy_flat_orders import TransactionDB
from .market_quote_selection import configured_quotes
from .position_transfer_checkpoint import economic_initial
from .scope_coverage import record_status, scope_status, status
from .trade_accounting import replay_economic_trades
from .trade_amendment_history import attach_amendments


def encode(value):
    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, dict):
        return {key: encode(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [encode(item) for item in value]
    return value


def conversion(value, source, target, fx):
    if value is None or source is None:
        return None
    if source == target:
        return value
    if fx.get("state") != "observed" or not fx.get("observationId"):
        return None

    def ratio(currency):
        if currency == "USD":
            return Decimal(1)
        exact = fx.get("exactRatios", {}).get(currency)
        if exact:
            return Decimal(exact["numerator"]) / Decimal(exact["denominator"])
        return decimal(fx["rates"].get(currency))

    before, after = ratio(source), ratio(target)
    return (
        value / before * after
        if before is not None and after is not None and before > 0 and after > 0
        else None
    )


async def economics(conn, owner, records):
    ids = [row["id"] for row in records]
    if not ids:
        return {}
    fills = await (
        await conn.execute(
            "SELECT * FROM trade_ledger WHERE owner_id=%s AND record_id=ANY(%s) ORDER BY record_id,before_record_revision LIMIT 20001",
            (owner, ids),
        )
    ).fetchall()
    if len(fills) > 20000:
        raise HTTPException(409, "有效成交重放超过本次完整读取预算")
    await attach_amendments(conn, owner, fills)
    paid = await confirmed_actual_fees(conn, owner, [row["id"] for row in fills])
    fees = {row["trade_id"]: row["actual_fee"] for row in paid}
    projections = await (
        await conn.execute(
            "SELECT * FROM trade_fee_projections WHERE owner_id=%s AND record_id=ANY(%s) ORDER BY record_id,before_record_revision LIMIT 20001",
            (owner, ids),
        )
    ).fetchall()
    if len(projections) > 20000:
        raise HTTPException(409, "费用重放超过完整读取预算")
    grouped = defaultdict(list)
    projected = defaultdict(list)
    for row in fills:
        grouped[row["record_id"]].append(row)
    for row in projections:
        projected[row["record_id"]].append(row)
    result = {}
    for record in records:
        rid = record["id"]
        if not grouped[rid]:
            continue
        try:
            initial, events = replay(grouped[rid], record, fees, projected[rid])
            value = replay_economic_trades(economic_initial(record, initial), events)
            if value.complete and value.position.quantity == record["qty"]:
                result[rid] = {"average": value.position.cost, "realized": value.realized_pnl}
        except (ValueError, ArithmeticError):
            continue
    return result


def totals(positions):
    cost = complete_sum([row["_cost"] for row in positions])
    market = complete_sum([row["_market"] for row in positions])
    pnl = complete_sum([row["_pnl"] for row in positions])
    realized = complete_sum([row["_realized"] for row in positions]) if positions else None
    return {
        "cost": cost,
        "marketValue": market,
        "unrealizedPnl": pnl,
        "unrealizedPnlPct": pnl / abs(cost) * 100
        if pnl is not None and cost not in (None, Decimal(0))
        else None,
        "realizedPnl": realized,
    }


def public(position):
    return {key: value for key, value in position.items() if not key.startswith("_")}


class PortfolioOverview(LegacyAssetAuthority):
    async def read(self, who, *, currency="USD", cost_method="diluted", us_price="observed"):
        if (
            not isinstance(currency, str)
            or len(currency) != 3
            or not currency.isascii()
            or not currency.isupper()
            or cost_method not in {"diluted", "average_open"}
            or us_price not in {"observed", "regular"}
        ):
            raise HTTPException(400, "资产汇总显示参数无效")
        async with self.context(who,shared_read=True) as conn:
            original = await (
                await conn.execute(
                    "SELECT id,market,code,revision FROM portfolio_records WHERE owner_id=%s AND deleted_at IS NULL ORDER BY id LIMIT 10001",
                    (who.id,),
                )
            ).fetchall()
            if len(original) > 10000:
                raise HTTPException(409, "证券范围超出完整读取预算")
        quoted = {"quotes": {}, "quoteStates": {}}
        try:
            if original:
                quoted = await configured_quotes(
                    self.market_authority, who,
                    [{"id": r["id"], "market": r["market"], "code": r["code"]} for r in original],
                    regular=us_price == "regular",
                )
        except HTTPException as exc:
            if exc.status_code in (401, 403):
                raise
            quoted["readState"] = "unavailable"
        async with self.context(who,shared_read=True) as conn:
            # Every existing financial writer holds the same owner locks. Quotes
            # are used only when its captured record identity/revision still fits.
            rows = await (
                await conn.execute(
                    "SELECT * FROM portfolio_records WHERE owner_id=%s AND deleted_at IS NULL ORDER BY id LIMIT 10001",
                    (who.id,),
                )
            ).fetchall()
            if len(rows) > 10000:
                raise HTTPException(409, "证券范围超出完整读取预算")
            accounts = await (
                await conn.execute(
                    "SELECT id,name,account_kind,holding_source,revision,currencies FROM broker_accounts WHERE owner_id=%s AND deleted_at IS NULL ORDER BY id LIMIT 101",
                    (who.id,),
                )
            ).fetchall()
            if len(accounts) > 100:
                raise HTTPException(409, "账户范围超出完整读取预算")
            by_account = {r["id"]: r for r in accounts}
            before = {r["id"]: r for r in original}
            actual = await actual_records_dto(conn, who.id, rows)
            economic = await economics(conn, who.id, rows)
            cash = await CashOverview(self.db).on_connection(conn, who)
            fx = await FxWorker(TransactionDB(self.db, conn)).snapshot(exact=True)
            coverage = await status(conn, who.id)
            now = (await (await conn.execute("SELECT clock_timestamp() AS at")).fetchone())["at"]
            positions = []
            unassigned = []
            missing = []
            with localcontext() as precision:
                precision.prec = 80
                for row in rows:
                    rid = row["id"]
                    value = actual[rid]
                    account = by_account.get(row["broker_account_id"])
                    declaration, stored = await self.declaration(conn, who.id, row)
                    units = (
                        stored is None or declaration["identityMatches"] and declaration["kind"] != "unknown"
                    )
                    quantity = decimal(value.get("qty"))
                    official = value.get("officialObservation")
                    state = quoted["quoteStates"].get(rid, {})
                    quote = quoted["quotes"].get(rid)
                    same = rid in before and all(
                        before[rid][key] == row[key] for key in ("revision", "market", "code")
                    )
                    if state.get("sourceRevision"):
                        try:
                            _, policy = await self.market_authority.config(
                                conn, who.id, state["sourceRevision"]
                            )
                            if policy.license_revision != state.get("licenseRevision"):
                                raise HTTPException(403, "报价许可已变化")
                        except HTTPException:
                            quote = None
                            state = {
                                "state": "retained_unavailable",
                                "sourceRevision": state.get("sourceRevision"),
                                "licenseRevision": state.get("licenseRevision"),
                            }
                    observed = (
                        quote
                        if same
                        and (
                            us_price != "regular"
                            or row["market"] != "US"
                            or quote
                            and quote.get("session") == "REGULAR"
                        )
                        else None
                    )
                    price = decimal(state.get("priceExact")) if observed else None
                    price_source = "licensed_quote" if price is not None else "unknown"
                    price_at = state.get("sourceTime") if price is not None else None
                    native_currency = CURRENCIES.get(row["market"]) or (
                        observed.get("currency") if observed else None
                    )
                    diluted = decimal(value.get("cost"))
                    average = decimal(value.get("cost")) if official else economic.get(rid, {}).get("average")
                    unit_cost = diluted if cost_method == "diluted" else average
                    cost_authority = value.get("costAuthority") or (
                        "effective_actual_ledger_average"
                        if cost_method == "average_open" and average is not None
                        else "owner_registered_diluted_unit_cost"
                    )
                    zero = quantity == 0
                    native_market = (
                        Decimal(0)
                        if zero
                        else quantity * price
                        if units and quantity is not None and quantity > 0 and price is not None
                        else None
                    )
                    native_cost = (
                        Decimal(0)
                        if zero
                        else quantity * unit_cost
                        if units and quantity is not None and quantity > 0 and unit_cost is not None
                        else None
                    )
                    pnl = (
                        native_market - native_cost
                        if native_market is not None and native_cost is not None
                        else None
                    )
                    if value.get("transferObservation", {}).get("economicCostBasisKnown") is False:
                        pnl = None
                    realized = economic.get(rid, {}).get("realized") if not official else None
                    known = await record_status(conn, who.id, rid)
                    reasons = []
                    if quantity is None:
                        reasons.append("quantity_unknown")
                    if not units:
                        reasons.append("valuation_unit_unknown")
                    if price is None and not zero:
                        reasons.append("price_unknown")
                    if unit_cost is None and not zero:
                        reasons.append("cost_unknown")
                    if not known:
                        reasons.append("legacy_record_scope_incomplete")
                    if realized is None:
                        reasons.append("realized_history_or_actual_fees_unknown")
                    if native_currency is None:
                        reasons.append("currency_unknown")
                    converted = {
                        key: conversion(amount, native_currency, currency, fx)
                        for key, amount in (
                            ("cost", native_cost),
                            ("marketValue", native_market),
                            ("unrealizedPnl", pnl),
                            ("realizedPnl", realized),
                        )
                    }
                    if native_market is not None and converted["marketValue"] is None:
                        reasons.append("fx_observation_missing")
                    item = {
                        "recordId": rid,
                        "recordRevision": row["revision"],
                        "brokerAccountId": row["broker_account_id"],
                        "accountKind": account["account_kind"] if account else "unknown",
                        "market": row["market"],
                        "accountMarket": row["account_market"] or row["market"],
                        "code": row["code"],
                        "name": row["name"],
                        "currency": native_currency,
                        "quantity": quantity,
                        "price": price,
                        "priceSource": price_source,
                        "priceAt": price_at,
                        "priceAuthority": "licensed_quote_observation"
                        if price_source == "licensed_quote"
                        else "unknown",
                        "quoteState": state,
                        "quoteCached": observed.get("cached") if observed else None,
                        "quoteSession": observed.get("session") if observed else None,
                        "positionAsOf": official.get("reportDate") if official else None,
                        "recordUpdatedAt": value.get("updatedAt"),
                        "savedMark": {
                            "price": decimal(
                                value.get("registeredPrice") if official else value.get("price")
                            ),
                            "currency": native_currency,
                            "observedAt": None,
                            "recordUpdatedAt": value.get("updatedAt"),
                            "authority": "owner_saved_record_mark",
                            "usedForCurrentValuation": False,
                        },
                        "reportedObservation": {
                            **official,
                            "price": decimal(value.get("price")),
                            "currency": native_currency,
                            "usedForCurrentValuation": False,
                        }
                        if official
                        else None,
                        "officialObservation": official,
                        "instrument": declaration,
                        "valuationBasis": "legacy_record_unit"
                        if stored is None
                        else "owner_declared_unit"
                        if units
                        else "unknown",
                        "cost": native_cost,
                        "unitCost": unit_cost,
                        "costMethod": cost_method,
                        "costAuthority": cost_authority,
                        "marketValue": native_market,
                        "unrealizedPnl": pnl,
                        "unrealizedPnlPct": pnl / abs(native_cost) * 100
                        if pnl is not None and native_cost not in (None, Decimal(0))
                        else None,
                        "realizedPnl": realized,
                        "realizedAuthority": "effective_actual_ledger_full_replay"
                        if realized is not None
                        else "unknown",
                        "converted": {"currency": currency, **converted},
                        "complete": known
                        and native_market is not None
                        and converted["marketValue"] is not None,
                        "unavailableReasons": reasons,
                        "_market": converted["marketValue"],
                        "_cost": converted["cost"],
                        "_pnl": converted["unrealizedPnl"],
                        "_realized": converted["realizedPnl"],
                        "_nativeMarket": native_market,
                        "_nativeCost": native_cost,
                        "_nativePnl": pnl,
                        "_nativeRealized": realized,
                        "_known": known,
                    }
                    if not account or account["account_kind"] not in {"real", "simulated"}:
                        unassigned.append(item)
                    else:
                        positions.append(item)
                    if not item["complete"]:
                        missing.append(rid)
                books = []
                cash_accounts = {r["accountId"]: r for r in cash["accounts"]}
                for kind in ("real", "simulated"):
                    selected = [r for r in positions if r["accountKind"] == kind]
                    selected_accounts = [a for a in accounts if a["account_kind"] == kind]
                    book_cash = next((r["currencies"] for r in cash["books"] if r["accountKind"] == kind), [])
                    funds = (
                        complete_sum(
                            [
                                conversion(decimal(r["ownerBalance"]), r["currency"], currency, fx)
                                for r in book_cash
                            ]
                        )
                        if book_cash
                        else None
                    )
                    currencies = {r["currency"] for r in selected if r["currency"]} | {
                        r["currency"] for r in book_cash
                    }
                    covered = all([await scope_status(conn, who.id, kind, curr) for curr in currencies])
                    result = totals(selected)
                    valuation = covered and all(r["complete"] for r in selected)
                    if not valuation:
                        result["marketValue"] = None
                    if not covered or any(not r["_known"] for r in selected):
                        result["cost"] = result["unrealizedPnl"] = result["unrealizedPnlPct"] = result[
                            "realizedPnl"
                        ] = None
                    result["cash"] = funds
                    result["totalAsset"] = (
                        result["marketValue"] + funds
                        if result["marketValue"] is not None and funds is not None
                        else None
                    )
                    market_rows = []
                    for market in sorted({r["market"] for r in selected}):
                        grouped = [r for r in selected if r["market"] == market]
                        amount = totals(grouped)
                        amount["currency"] = currency
                        amount["market"] = market
                        amount["positionCount"] = sum(
                            row["quantity"] is not None and row["quantity"] > 0 for row in grouped
                        )
                        amount["complete"] = covered and all(r["complete"] for r in grouped)
                        amount["weightPct"] = (
                            amount["marketValue"] / result["marketValue"] * 100
                            if valuation
                            and result["marketValue"] is not None
                            and result["marketValue"] > 0
                            and amount["marketValue"] is not None
                            else None
                        )
                        market_rows.append(amount)
                    account_rows = []
                    for account in selected_accounts:
                        grouped = [r for r in selected if r["brokerAccountId"] == account["id"]]
                        snapshot = cash_accounts.get(account["id"], {}).get("snapshot", {})
                        cash_rows = {r["currency"]: r for r in snapshot.get("currencies", [])}
                        account_currencies = sorted(
                            {r["currency"] for r in grouped if r["currency"]}
                            | set(cash_rows)
                            | set(account["currencies"])
                        )
                        amounts = []
                        for curr in account_currencies:
                            natives = [
                                {
                                    **r,
                                    "_market": r["_nativeMarket"],
                                    "_cost": r["_nativeCost"],
                                    "_pnl": r["_nativePnl"],
                                    "_realized": r["_nativeRealized"],
                                }
                                for r in grouped
                                if r["currency"] == curr
                            ]
                            summary = totals(natives)
                            balance = decimal(cash_rows.get(curr, {}).get("balance"))
                            summary.update(
                                currency=curr,
                                cash=balance,
                                totalAsset=summary["marketValue"] + balance
                                if summary["marketValue"] is not None and balance is not None
                                else None,
                                complete=all(r["_known"] and r["_nativeMarket"] is not None for r in natives)
                                and bool(cash_rows.get(curr, {}).get("complete")),
                                cashAuthority=cash_rows.get(curr, {}).get(
                                    "balanceAuthority", "platform_posted_cash_ledger"
                                ),
                                officialObservation=cash_rows.get(curr, {}).get("officialObservation"),
                            )
                            amounts.append(summary)
                        account_rows.append(
                            {
                                "accountId": account["id"],
                                "name": account["name"],
                                "accountKind": kind,
                                "holdingSource": account["holding_source"],
                                "currencies": amounts,
                            }
                        )
                    candidates = [
                        r
                        for r in selected
                        if r["quantity"] is not None
                        and r["quantity"] > 0
                        and r["_pnl"] is not None
                        and r["complete"]
                    ]
                    gainers = sorted(
                        (r for r in candidates if r["_pnl"] > 0), key=lambda r: (-r["_pnl"], r["recordId"])
                    )[:20]
                    losers = sorted(
                        (r for r in candidates if r["_pnl"] < 0), key=lambda r: (r["_pnl"], r["recordId"])
                    )[:20]
                    books.append(
                        {
                            "accountKind": kind,
                            "totals": result,
                            "accounts": account_rows,
                            "markets": market_rows,
                            "positions": [public(r) for r in selected],
                            "ranking": {
                                "basis": "known_observed_unrealized_pnl",
                                "gainers": [public(r) for r in gainers],
                                "losers": [public(r) for r in losers],
                                "unavailable": [
                                    r["recordId"] for r in selected if r["_pnl"] is None or not r["complete"]
                                ],
                            },
                            "coverageScope": "bound_accounts_of_declared_kind",
                            "excludedUnassignedRecordIds": [r["recordId"] for r in unassigned],
                            "completeness": {
                                "valuation": valuation,
                                "cost": covered and result["cost"] is not None,
                                "cash": funds is not None,
                                "realized": covered and result["realizedPnl"] is not None,
                                "missingRecordIds": [r["recordId"] for r in selected if not r["complete"]],
                            },
                        }
                    )
                revision = hashlib.sha256(
                    json.dumps(
                        encode(
                            {
                                "records": rows,
                                "positions": [public(row) for row in positions + unassigned],
                                "coverage": coverage,
                                "cash": cash["snapshotRevision"],
                                "quotes": quoted["quoteStates"],
                                "fx": fx.get("observationId"),
                                "options": [currency, cost_method, us_price],
                            }
                        ),
                        sort_keys=True,
                        default=str,
                        separators=(",", ":"),
                    ).encode()
                ).hexdigest()
                return encode(
                    {
                        "currency": currency,
                        "costMethod": cost_method,
                        "usPrice": us_price,
                        "revision": revision,
                        "asOf": now,
                        "books": books,
                        "unassigned": {
                            "positions": [public(r) for r in unassigned],
                            "reason": "account_kind_or_binding_unknown",
                        },
                        "quoteStatus": {
                            "state": quoted.get("readState", "read"),
                            "missing": [
                                r["recordId"]
                                for r in positions + unassigned
                                if r["priceSource"] != "licensed_quote"
                            ],
                        },
                        "fx": fx,
                        "coverage": coverage,
                        "scope": "platform_broker_securities_and_cash",
                        "fullWealthComplete": False,
                        "unrepresentedDomains": ["cards", "other_assets", "unbound_legacy_balances"],
                        "collectionOnRead": False,
                        "calculationPrecision": 80,
                        "observedAssetValuesArePerformanceReturns": False,
                        "missingRecordIds": missing,
                    }
                )
