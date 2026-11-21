"""Current portfolio-cycle evidence for Alcor's shared trading P&L."""
import asyncio
from collections import defaultdict
from datetime import UTC, datetime, time, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

from fastapi import HTTPException, Request, Response

from .database_migration_history import registered_orders
from .fee_repair_model import effective_projection
from .legacy_identity import assert_native_origin, envelope, native_identity
from .legacy_order_projection import READ_MODEL
from .legacy_trading_snapshot import require_order_coverage, scalar
from .market_contract import ZONES
from .scope_coverage import require_global
from .security import lock_read_identity

PATH = "/api/v2/account-assets/trading-cycle"
BASIS = "new_york_20_trading_gross_v1"
NEW_YORK = ZoneInfo("America/New_York")
DAY = timedelta(days=1)
MAX_ROWS = 5000


def discovery():
    return {"version": 1, "path": PATH, "read_scope": "portfolio.read", "basis": BASIS}


def cycle_range(at):
    local = at.astimezone(NEW_YORK)
    day = local.date() if local.time() >= time(20) else local.date() - DAY
    return tuple(datetime.combine(date, time(20), NEW_YORK).astimezone(UTC) for date in (day, day + DAY))


def event_time(value):
    if isinstance(value, str):
        value = datetime.fromisoformat(value)
    if value is None or value.tzinfo is None:
        raise ValueError("missing execution time")
    return value


def fill_item(row, record, *, projection=None):
    amendment = row.get("_latest_amendment")
    event = row.get("_effective_event") or row
    facts = projection if projection is not None else row
    settlement = event.get("settlement_currency", row["settlement_currency"])
    identity = row["account_id"] == record["broker_account_id"]
    return {
        "id": str(amendment["replacement_id"] if amendment else row["id"]),
        "recordId": row["record_id"], "market": record["market"], "code": record["code"],
        "name": record["name"], "accountMarket": record["account_market"] or record["market"],
        "side": event["side"], "status": "filled", "qty": Decimal(event["quantity"]),
        "price": Decimal(event["price"]), "filledQty": Decimal(event["quantity"]),
        "executedPrice": Decimal(event["price"]), "amount": Decimal(event["amount"]),
        "positionQtyBefore": facts["before_quantity"], "positionQtyAfter": facts["after_quantity"],
        "tradedAt": event_time(event["occurred_at"]), "createdAt": row["created_at"], "revision": 1,
        "recordRevision": record["revision"], "identityMatches": identity, "brokerAccountId": row["account_id"],
        "settlementCurrency": settlement if settlement != row["currency"] else None,
        "settlementAmount": Decimal(event["settlement_amount"]) if event.get("settlement_amount") is not None else None,
    }


async def period_fills(conn, owner, records, start):
    # Read both original candidates and replacements moved across the cycle
    # boundary. Replaying an amended chain is limited to those affected records.
    rows = await (await conn.execute("""
        SELECT * FROM trade_ledger WHERE owner_id=%s AND account_kind IN ('real','simulated')
            AND occurred_at>=%s ORDER BY occurred_at,id LIMIT %s
    """, (owner, start, MAX_ROWS + 1))).fetchall()
    moves = await (await conn.execute("""
        SELECT DISTINCT record_id FROM trade_amendments WHERE owner_id=%s AND action<>'delete'
            AND (replacement->>'occurred_at')::timestamptz>=%s LIMIT %s
    """, (owner, start, MAX_ROWS + 1))).fetchall()
    if len(rows) > MAX_ROWS or len(moves) > MAX_ROWS:
        raise HTTPException(409, "本交易周期成交超出完整读取上限")
    amended = {row["record_id"] for row in moves}
    if not (amended | {row["record_id"] for row in rows}) <= records.keys():
        raise HTTPException(409, "本交易周期证券归属不完整")
    for row in rows:
        record = records[row["record_id"]]
        if record["amendment_tip_id"] is not None:
            amended.add(record["id"])
    kinds = {row["account_kind"] for row in rows}
    kinds.update(record["account_kind"] for record in records.values() if record["qty"] and record["account_kind"])
    items = [fill_item(row, records[row["record_id"]]) for row in rows
             if row["record_id"] not in amended and row["side"] in ("buy", "sell")]
    if amended:
        from .position_transfer_checkpoint import attach_openings
        from .trade_amendment_history import attach_amendments
        replay = await (await conn.execute("""
            SELECT * FROM trade_ledger WHERE owner_id=%s AND record_id=ANY(%s)
            ORDER BY record_id,before_record_revision LIMIT %s
        """, (owner, sorted(amended), MAX_ROWS + 1))).fetchall()
        if len(replay) > MAX_ROWS:
            raise HTTPException(409, "本交易周期涉及的更正链超出完整读取上限")
        await attach_amendments(conn, owner, replay)
        await attach_openings(conn, owner, [records[rid] for rid in amended])
        ids = [row["id"] for row in replay]
        fees = await (await conn.execute("""
            SELECT trade_id,new_fees FROM trade_fee_corrections WHERE owner_id=%s AND trade_id=ANY(%s)
        """, (owner, ids))).fetchall()
        projections = await (await conn.execute("""
            SELECT * FROM trade_fee_projections WHERE owner_id=%s AND record_id=ANY(%s) LIMIT %s
        """, (owner, sorted(amended), MAX_ROWS + 1))).fetchall()
        if len(projections) > MAX_ROWS:
            raise HTTPException(409, "本交易周期涉及的更正链超出完整读取上限")
        by_record, by_projection = defaultdict(list), defaultdict(list)
        for row in replay:
            by_record[row["record_id"]].append(row)
        for row in projections:
            by_projection[row["record_id"]].append(row)
        corrections = {row["trade_id"]: row["new_fees"] for row in fees}
        for rid, chain in by_record.items():
            try:
                effective = effective_projection(chain, records[rid], corrections, by_projection[rid])
            except ValueError:
                raise HTTPException(409, "本交易周期的成交更正链尚未核对") from None
            for row in chain:
                event = row.get("_effective_event") or row
                if (not row.get("_effective_inactive") and event["side"] in ("buy", "sell")
                        and event_time(event["occurred_at"]) >= start):
                    items.append(fill_item(row, records[rid], projection=effective[row["id"]]))
                    kinds.add(row["account_kind"])
    # Legacy unknown execution dates must remain visible to the proof checker.
    imported = await registered_orders(conn, owner, native_records=list(records.values()), trading_start=start)
    if any(row["recordId"] not in records for row in imported):
        raise HTTPException(409, "本交易周期的历史成交归属不完整")
    for item in imported:
        if item.get("originalReadModel") != READ_MODEL:
            item["identityMatches"] = False
    if len(items) + len(imported) > MAX_ROWS or len({row["id"] for row in items + imported}) != len(items) + len(imported):
        raise HTTPException(409, "本交易周期成交超限或有重复身份")
    kinds.update(row["accountKind"] for row in imported)
    if len(kinds) > 1 or kinds - {"real", "simulated"}:
        raise HTTPException(409, "本交易周期成交无法合并真实与模拟账户")
    return sorted(items + imported, key=lambda row: row["id"])


async def opening_closes(conn, history, owner, records, items, start, end):
    from .portfolio_daily import MAX_POSITIONS, close_input
    involved = set()
    for item in items:
        try:
            if event_time(item["tradedAt"]) < end:
                involved.add(item["recordId"])
        except (ValueError, TypeError):
            continue
    symbols = {(row["market"], row["code"]): row for row in records.values()
               if row["market"] in ZONES and (row["qty"] or row["id"] in involved)}
    results = []
    for (market, code), row in sorted(symbols.items())[:MAX_POSITIONS]:
        regular_day = (start + timedelta(hours=12)).astimezone(ZoneInfo(ZONES[market])).date()
        price, _ = await close_input(conn, history, owner, row, regular_day - DAY)
        if price is not None:
            results.append({"market": market, "code": code, "day": price["tradeDay"], "price": price["value"]})
    return results


def mount(app, db, authority):
    from .market_history_reads import LicensedHistory
    history = LicensedHistory(authority)

    @app.get(PATH, operation_id="native_account_trading_cycle")
    async def read(request: Request, response: Response, cycleStart: datetime | None = None, closes: bool = False):
        assert_native_origin(request, db.settings)
        who, _ = await native_identity(request, db, "portfolio.read")
        params = request.query_params
        if set(params) - {"cycleStart", "closes"} or any(len(params.getlist(key)) != 1 for key in params):
            raise HTTPException(400, "交易周期查询参数无效")
        if not await app.state.read_rate_limit(db, "native-trading-cycle:" + who.id, 120, window_seconds=60):
            raise HTTPException(429, "交易周期读取过于频繁")
        async with db.connection() as conn, conn.transaction():
            await conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
            await lock_read_identity(conn, who, require_admin=False)
            now = (await (await conn.execute("SELECT transaction_timestamp() AS at")).fetchone())["at"]
            wall, _ = cycle_range(now)
            if cycleStart is not None and (cycleStart.tzinfo is None or not wall - 7 * DAY <= cycleStart <= wall
                                           or cycle_range(cycleStart)[0] != cycleStart):
                raise HTTPException(400, "超出最近交易周期范围")
            start, end = cycle_range(cycleStart or now)
            await require_global(conn, who.id)
            await require_order_coverage(conn, who.id)
            rows = await (await conn.execute("""
                SELECT r.*, a.account_kind FROM portfolio_records r LEFT JOIN broker_accounts a
                  ON a.owner_id=r.owner_id AND a.id=r.broker_account_id AND a.deleted_at IS NULL
                WHERE r.owner_id=%s AND r.deleted_at IS NULL ORDER BY r.id LIMIT %s
            """, (who.id, MAX_ROWS + 1))).fetchall()
            if len(rows) > MAX_ROWS:
                raise HTTPException(409, "本交易周期持仓目录超出完整读取上限")
            head = await (await conn.execute("""
                SELECT revision FROM portfolio_record_collections WHERE owner_id=%s
            """, (who.id,))).fetchone()
            records = {row["id"]: row for row in rows}
            items = await period_fills(conn, who.id, records, start)
            transfers = await (await conn.execute("""
                SELECT source_record_id,target_record_id FROM broker_position_transfers
                WHERE owner_id=%s AND occurred_at>=%s LIMIT %s
            """, (who.id, start, MAX_ROWS + 1))).fetchall()
            if len(transfers) > MAX_ROWS:
                raise HTTPException(409, "本交易周期转仓超出完整读取上限")
            uncertain = {row[key] for row in transfers for key in ("source_record_id", "target_record_id")}
            uncertain &= records.keys()
            prices = []
            if closes:
                # Optional price evidence has its own short budget so a
                # history read cannot delay an otherwise ready cycle.
                try:
                    async with conn.transaction(), asyncio.timeout(2):
                        prices = await opening_closes(conn, history, who.id, records, items, start, end)
                except TimeoutError:
                    pass
        return envelope(scalar({
            "accountId": who.id, "basis": BASIS, "asOf": now, "cycleStart": start, "cycleEnd": end,
            "collectionRevision": head["revision"] if head else 0,
            "records": {rid: row["revision"] for rid, row in records.items()},
            "items": items, "uncertainRecords": sorted(uncertain), "openingCloses": prices,
        }), request, response)
