"""Read-only App projections of the worker's verified daily ledger results."""

from collections import defaultdict
from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

from fastapi import HTTPException, Request, Response

from .fire_web import bound_member
from .legacy_identity import assert_native_origin, envelope, native_identity
from .market_contract import CURRENCIES, ZONES
from .portfolio_series import packed
from .security import assert_expected_account, lock_read_identity

PATH = "/api/v2/account-assets/analysis-days"
WEB_PATH = "/api/fire/asset-analysis/trend"
DAY = timedelta(days=1)
MAX_DAYS = 3660


def discovery():
    return {"version": 1, "path": PATH, "read_scope": "portfolio.read"}


async def calendar_result(conn, owner, kind, day, opening, positions, postings):
    """Project net security gains by exchange date from complete quantity and cash evidence."""
    prior = {row["recordId"]: row for row in opening}
    ending = {row["recordId"]: row for row in positions}
    active = {rid: row for rid, row in (prior | ending).items()
              if any(Decimal(entry.get(rid, {}).get("quantity") or "0") for entry in (prior, ending))}
    lower = datetime.combine(day, time.min, UTC)
    trades = await (await conn.execute("""
        SELECT id,record_id,account_id,side,currency,settlement_currency,fees,amount,cash_delta,occurred_at,
               before_quantity,after_quantity
        FROM trade_ledger WHERE owner_id=%s AND account_kind=%s AND occurred_at>=%s AND occurred_at<%s
        ORDER BY occurred_at,id LIMIT 20001
    """, (owner, kind, lower - DAY, lower + 2 * DAY))).fetchall()
    if len(trades) > 20000:
        return None
    cash = {row["source_trade_id"]: row for row in postings if row["source_trade_id"]}
    relevant = {}
    for trade in trades:
        row = (ending.get(trade["record_id"]) or prior.get(trade["record_id"]))
        if row is None or row["market"] not in ZONES:
            if trade["id"] in cash:
                return None
            continue
        local_day = trade["occurred_at"].astimezone(ZoneInfo(ZONES[row["market"]])).date()
        if local_day == day:
            relevant[trade["id"]] = trade
            active[trade["record_id"]] = row
    # UTC postings and the selected exchange day must identify exactly the same fills.
    if set(relevant) != set(cash) or not active:
        return None
    by_record = defaultdict(list)
    for identifier, trade in relevant.items():
        posting = cash[identifier]
        if (not posting["affects_owner"] or posting["trade_amendment_id"] is not None
                or posting["kind"] != "trade_" + trade["side"] or posting["amount"] != trade["cash_delta"]
                or posting["currency"] != trade["currency"] or trade["settlement_currency"] != trade["currency"]
                or trade["fees"] is None or trade["side"] not in ("buy", "sell", "dividend")):
            return None
        by_record[trade["record_id"]].append(trade)

    sessions = await (await conn.execute("""
        SELECT d.market,d.status,d.revision FROM market_calendar_active a
        JOIN market_calendar_days d ON d.revision=a.revision
        WHERE d.day=%s AND d.market=ANY(%s)
    """, (day, sorted({row["market"] for row in active.values()})))).fetchall()
    status = {row["market"]: row["status"] for row in sessions}
    if any(status.get(row["market"]) in (None, "unknown") for row in active.values()):
        return None

    total, capital = defaultdict(Decimal), defaultdict(Decimal)
    rows = []
    for rid, row in active.items():
        previous, current = prior.get(rid), ending.get(rid)
        fills = by_record[rid]
        if current is None or (previous is None and not fills):
            return None
        if previous and any(previous[key] != current[key] for key in ("market", "code", "brokerAccountId")):
            return None
        currency = CURRENCIES.get(row["market"])
        if currency is None or any(fill["currency"] != currency or fill["account_id"] != row["brokerAccountId"] for fill in fills):
            return None
        if status[row["market"]] not in ("trading", "half_day") and not fills:
            continue
        if current["value"] is None or (previous and previous["value"] is None):
            return None
        before = Decimal(previous["value"]) if previous else Decimal(0)
        qty = Decimal(previous["quantity"]) if previous else Decimal(0)
        for fill in fills:
            if fill["before_quantity"] != qty:
                return None
            qty = fill["after_quantity"]
        if qty != Decimal(current["quantity"]):
            return None
        amount = Decimal(current["value"]) - before + sum(fill["cash_delta"] for fill in fills)
        total[currency] += amount
        capital[currency] += before + sum(fill["amount"] for fill in fills if fill["side"] == "buy")
        rows.append({"recordId": rid, "market": row["market"], "code": row["code"],
                     "brokerAccountId": row["brokerAccountId"], "currency": currency, "profit": amount,
                     "turnover": sum((fill["amount"] for fill in fills if fill["side"] in ("buy", "sell")), Decimal(0))})
    if not total:
        return None
    return {"profit": dict(total), "capital": dict(capital), "calendarRevision": sessions[0]["revision"], "rows": rows}


def mount(app, db, authority):
    async def analysis_days(who, *, before=None, day=None, web=False):
        budget = "web-analysis-days:" if web else "native-analysis-days:"
        if not await app.state.read_rate_limit(db, budget + who.id, 30, window_seconds=60):
            raise HTTPException(429, "请求过于频繁")
        async with db.connection() as conn, conn.transaction():
            await lock_read_identity(conn, who)
            rows = await (await conn.execute("""
                WITH latest AS (
                    SELECT DISTINCT ON (valuation_day) valuation_day,revision,captured_at,result
                    FROM portfolio_daily_results
                    WHERE owner_id=%s AND account_kind='real' AND valuation_day<%s
                    ORDER BY valuation_day DESC,revision DESC LIMIT %s
                )
                SELECT l.valuation_day AS day,l.revision,l.result->>'equity' AS equity,
                    l.result->>'priorEquity' AS prior,l.result->>'priorRevision' AS "priorRevision",
                    l.result->>'pnl' AS pnl,CASE WHEN %s THEN NULL WHEN %s THEN l.result->'calendar'
                        ELSE (l.result->'calendar')-'rows' END AS calendar,
                    (SELECT jsonb_object_agg(code,fx->>'rate') FROM jsonb_each(l.result->'fx') e(code,fx)) AS rates,
                    ARRAY(SELECT DISTINCT (v->'close'->>'sourceRevision')::uuid
                        FROM jsonb_array_elements(l.result->'positions') v WHERE v->'close'->>'sourceRevision' IS NOT NULL) AS sources,
                    ARRAY(SELECT DISTINCT v->'close'->>'marketCalendarRevision'
                        FROM jsonb_array_elements(l.result->'positions') v WHERE v->'close'->>'marketCalendarRevision' IS NOT NULL) AS calendars,
                    EXISTS(SELECT 1 FROM cash_ledger_entries e WHERE e.owner_id=%s AND e.account_kind='real'
                        AND e.occurred_at<((l.valuation_day+1)::timestamp AT TIME ZONE 'UTC') AND e.created_at>l.captured_at)
                        OR (NOT l.result ? 'nativeLedgerRevision' AND EXISTS(
                            SELECT 1 FROM native_ledger_transactions t WHERE t.owner_id=%s AND t.revision=1
                            AND t.created_at<((l.valuation_day+1)::timestamp AT TIME ZONE 'UTC')
                        )) AS changed,
                    (SELECT revision FROM market_calendar_active WHERE singleton) AS "activeCalendar"
                FROM latest l ORDER BY l.valuation_day DESC
            """, (who.id, day + DAY if day is not None else before or date.max, 2 if day else MAX_DAYS + 1,
                  web, day is not None, who.id, who.id))).fetchall()
            if day is not None and (not rows or rows[0]["day"] != day):
                rows = []
            allowed = set()
            for source in {source for row in rows for source in row["sources"]}:
                try:
                    await authority.config(conn, who.id, source)
                except HTTPException as error:
                    if error.status_code not in (403, 404, 409, 503):
                        raise
                else:
                    allowed.add(source)

            items = []
            def usable(row):
                return (not row["changed"] and set(row["sources"]) <= allowed
                        and all(revision == row["activeCalendar"] for revision in row["calendars"]))

            for index, row in enumerate(rows[:1 if day else MAX_DAYS]):
                previous = rows[index + 1] if index + 1 < len(rows) else None
                current = usable(row)
                linked = (current and previous and previous["day"] + DAY == row["day"]
                          and str(previous["revision"]) == row["priorRevision"] and usable(previous))
                calendar = row["calendar"] if linked else None
                if calendar and calendar["calendarRevision"] != row["activeCalendar"]:
                    calendar = None
                items.append({"day": row["day"], "revision": row["revision"],
                              "equity": row["equity"] if current else None,
                              "prior": row["prior"] if linked else None, "pnl": row["pnl"] if linked else None,
                              "rates": row["rates"] if current else None, "calendar": calendar,
                              "retired": not current})
            next_day = rows[MAX_DAYS - 1]["day"] if len(rows) > MAX_DAYS else None
        return packed({"accountId": who.id, "basis": "settled_real_ledger_v1", "items": items, "next": next_day})

    @app.get(PATH, operation_id="native_portfolio_analysis_days")
    async def read(request: Request, response: Response, before: date | None = None, day: date | None = None):
        assert_native_origin(request, db.settings)
        who, _ = await native_identity(request, db, "portfolio.read")
        if (set(request.query_params) - {"before", "day"}
                or any(len(request.query_params.getlist(name)) != 1 for name in request.query_params)
                or day is not None and (before is not None or day == date.max)):
            raise HTTPException(400, "日终分析查询参数无效")
        return envelope(await analysis_days(who, before=before, day=day), request, response)

    @app.get(WEB_PATH, operation_id="web_asset_analysis_trend")
    async def web_trend(request: Request, response: Response):
        assert_native_origin(request, db.settings, web_session_cookies=True)
        who = await bound_member(request)
        assert_expected_account(request, who.id)
        if request.query_params:
            raise HTTPException(400, "日终趋势查询参数无效")
        response.headers["Cache-Control"] = "no-store, private"
        response.headers["Vary"] = "Cookie"
        return await analysis_days(who, web=True)
