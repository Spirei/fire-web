"""Versioned daily ledger results and their exact, attributable inputs."""

import asyncio
import logging
from collections import defaultdict
from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal, InvalidOperation, localcontext
from zoneinfo import ZoneInfo

from fastapi import HTTPException, Request
from psycopg.types.json import Jsonb

from .card_preferences_protocol import wire_response
from .market_contract import CURRENCIES, ZONES
from .market_history_evidence import verify_history_rows
from .personal_data_transfer import digest
from .personal_ledger_archive import PRIVATE, investment_file_actor
from .portfolio_series import packed
from .security import assert_expected_account, lock_read_identity

LOG = logging.getLogger(__name__)
DAY = timedelta(days=1)
MAX_POSITIONS = 200
MAX_POSTINGS = 20000
CAPTURE_DELAY = timedelta(minutes=30)
REGULAR_CLOSE = {"US": time(16), "HK": time(16, 10), "CN": time(15)}


def boundary(day):
    return datetime.combine(day + DAY, time.min, UTC)


async def close_input(conn, history, owner, row, day):
    market = row["market"]
    if market not in REGULAR_CLOSE:
        return None, "unsupported_market"
    zone = ZoneInfo(ZONES[market])
    sessions = await (await conn.execute("""
        SELECT d.day,d.status,d.revision,d.continuous_close,d.auction_latest FROM market_calendar_active a
        JOIN market_calendar_days d ON d.revision=a.revision
        WHERE d.market=%s AND d.day BETWEEN %s AND %s ORDER BY d.day DESC
    """, (market, day - 10 * DAY, day))).fetchall()
    observed_day = day
    revision = None
    close_at = None
    if not sessions or sessions[0]["day"] != day or sessions[0]["status"] == "unknown":
        return None, "missing_market_calendar"
    for session in sessions:
        if session["day"] != observed_day or session["status"] == "unknown":
            return None, "missing_market_calendar"
        if session["status"] in ("trading", "half_day"):
            revision = session["revision"]
            local_close = session["auction_latest"] or session["continuous_close"]
            close_at = datetime.combine(observed_day, time.fromisoformat(local_close) if local_close else REGULAR_CLOSE[market], zone)
            break
        observed_day -= DAY
    if not revision or close_at is None:
        return None, "missing_market_calendar"
    choices, retained = await history.choices(conn, owner, market, row["code"], frame="day",
                                              adjust="none", instrument="equity", session="REGULAR", kind="bars")
    if len(choices) != 1:
        return None, "close_source_ambiguous" if choices else "close_source_unavailable" if retained else "missing_close"
    (source, fingerprint), (policy, _) = next(iter(choices.items()))
    start = datetime.combine(observed_day, time.min, zone)
    end = datetime.combine(observed_day + DAY, time.min, zone)
    fact = await (await conn.execute("""
        SELECT f.*,p.raw_sha256,p.observed_at FROM market_facts f JOIN market_source_pages p
          ON p.owner_id=f.owner_id AND p.id=f.page_id
        WHERE f.owner_id=%s AND f.source_revision=%s AND f.series_fingerprint=%s
          AND f.source_time>=%s AND f.source_time<%s AND p.observed_at>=%s
        ORDER BY f.source_time DESC,f.sequence DESC LIMIT 1
    """, (owner, source, fingerprint, start, end, close_at))).fetchone()
    if fact is None:
        return None, "missing_close"
    try:
        await verify_history_rows(conn, owner, source, [fact], policy)
        amount = Decimal(str(fact["contents"]["c"]))
        if not amount.is_finite() or amount <= 0 or fact["contents"].get("currency") not in (None, CURRENCIES[market]):
            raise ValueError
    except (HTTPException, InvalidOperation, KeyError, TypeError, ValueError):
        return None, "unverified_close"
    return {"value": str(amount), "currency": CURRENCIES[market], "tradeDay": observed_day,
            "sourceTime": fact["source_time"], "observedAt": fact["observed_at"], "factId": fact["id"],
            "originalPageId": fact["page_id"], "originalSha256": fact["raw_sha256"], "source": policy.source,
            "sourceRevision": source, "licenseRevision": policy.license_revision, "marketCalendarRevision": revision,
            "regularCloseAt": close_at, "adjustment": "none", "session": "REGULAR"}, None


async def fx_inputs(conn, currencies, day, cutoff):
    usd = {"USD": {"rate": "1", "basis": "same_currency"}}
    requested = sorted(currencies - {"USD"})
    if not requested:
        return usd
    oldest = day - timedelta(days=day.weekday() - 4) if day.weekday() >= 5 else day
    # Choose a published observation once per valuation day and currency across
    # all accounts. A later retry may fill a gap, but cannot reprice a fixing.
    await conn.execute("""
        INSERT INTO portfolio_daily_fx_fixings(valuation_day,currency,observation_id)
        SELECT DISTINCT ON (v.currency) %s::date,v.currency,o.id
        FROM fx_observations o JOIN fx_values v ON v.observation_id=o.id
        WHERE o.base_currency='USD' AND o.observation_date BETWEEN %s AND %s AND v.currency=ANY(%s)
          AND (o.source_instant IS NULL OR o.source_instant<%s)
          AND NOT EXISTS(SELECT 1 FROM portfolio_daily_fx_fixings f WHERE f.valuation_day=%s AND f.currency=v.currency)
        ORDER BY v.currency,o.observation_date DESC,o.received_at DESC,o.id DESC
        ON CONFLICT(valuation_day,currency) DO NOTHING
    """, (day, oldest, day, requested, cutoff, day))
    rows = await (await conn.execute("""
        SELECT v.currency,v.rate,o.id,o.provider,o.provider_revision,
               o.received_at,o.observation_date,o.raw_sha256,f.frozen_at
        FROM portfolio_daily_fx_fixings f JOIN fx_observations o ON o.id=f.observation_id
        JOIN fx_values v ON v.observation_id=f.observation_id AND v.currency=f.currency
        WHERE f.valuation_day=%s AND f.currency=ANY(%s) ORDER BY f.currency
    """, (day, requested))).fetchall()
    return usd | {row["currency"]: {"rate": str(row["rate"]), "basis": "native_per_usd",
                                       "dateBasis": "same_day" if row["observation_date"] == day else "weekend_carry_forward",
                                       "observationId": row["id"], "source": row["provider"], "sourceRevision": row["provider_revision"],
                                       "observationDay": row["observation_date"], "observedAt": row["received_at"],
                                       "frozenAt": row["frozen_at"], "originalSha256": row["raw_sha256"]} for row in rows}


async def calculate(conn, history, owner, kind, day):
    cutoff = boundary(day)
    lower = cutoff - DAY
    prior = await (await conn.execute("""
        SELECT revision,captured_at,result FROM portfolio_daily_results
        WHERE owner_id=%s AND account_kind=%s AND valuation_day=%s ORDER BY revision DESC LIMIT 1
    """, (owner, kind, day - DAY))).fetchone()
    missing = []
    positions = []
    cash = defaultdict(Decimal)
    external = defaultdict(Decimal)
    daily_postings = []
    stock_values = defaultdict(Decimal)
    def issue(reason, **details):
        missing.append({"reason": reason, **details})
    accounts = await (await conn.execute("""
        SELECT id,currencies,holding_source FROM broker_accounts
        WHERE owner_id=%s AND account_kind=%s AND created_at<%s AND (deleted_at IS NULL OR deleted_at>=%s)
        ORDER BY id LIMIT 201
    """, (owner, kind, cutoff, cutoff))).fetchall()
    if len(accounts) > MAX_POSITIONS:
        issue("account_limit")
    account_ids = [row["id"] for row in accounts[:MAX_POSITIONS]]
    if not account_ids:
        issue("missing_account")
    records = await (await conn.execute("""
        SELECT p.id,p.code,p.name,p.market,p.qty,p.cost,p.broker_account_id,p.revision,p.source,p.updated_at,
               p.trade_tip_id,p.amendment_tip_id,p.fee_projection_id,p.position_transfer_id,
               NOT EXISTS(SELECT 1 FROM trade_ledger t WHERE t.owner_id=p.owner_id AND t.id=p.trade_tip_id
                          AND t.occurred_at>=%s) AND p.updated_at<%s AS scoped_revision
        FROM portfolio_records r
        LEFT JOIN LATERAL (
            SELECT h.current_value FROM portfolio_record_versions h
            WHERE r.updated_at>=%s AND h.owner_id=r.owner_id AND h.record_id=r.id AND h.captured_at<%s
            ORDER BY h.revision DESC LIMIT 1
        ) historical ON TRUE
        CROSS JOIN LATERAL jsonb_populate_record(r,historical.current_value) p
        WHERE r.owner_id=%s AND r.created_at<%s AND (r.deleted_at IS NULL OR r.deleted_at>=%s)
          AND (p.broker_account_id=ANY(%s) OR (%s='real' AND p.broker_account_id IS NULL AND p.qty>0))
        ORDER BY p.id LIMIT 201
    """, (cutoff, cutoff, cutoff, cutoff, owner, cutoff, cutoff, account_ids, kind))).fetchall()
    if len(records) > MAX_POSITIONS:
        issue("position_limit")
    accounts_by_id = {row["id"]: row for row in accounts}
    for row in records[:MAX_POSITIONS]:
        rid = row["id"]
        same_revision = row["scoped_revision"]
        item = {"recordId": rid, "brokerAccountId": row["broker_account_id"], "name": row["name"],
                "code": row["code"], "market": row["market"], "recordRevision": row["revision"],
                "recordedAt": row["updated_at"], "source": row["source"] or "recorded_position",
                "tradeId": row["trade_tip_id"], "amendmentId": row["amendment_tip_id"],
                "feeProjectionId": row["fee_projection_id"], "positionTransferEventId": row["position_transfer_id"],
                "quantity": str(row["qty"]) if same_revision and row["qty"] is not None else None,
                "cost": str(row["cost"]) if same_revision and row["cost"] is not None else None,
                "close": None, "value": None}
        positions.append(item)
        if not same_revision:
            issue("position_revision_after_cutoff", recordId=rid)
        elif row["broker_account_id"] is None:
            issue("unassigned_position", recordId=rid)
        elif accounts_by_id[row["broker_account_id"]]["holding_source"] == "official":
            issue("official_position_needs_statement", recordId=rid)
        elif row["qty"] is None:
            issue("missing_position_quantity", recordId=rid)
        elif row["qty"] == 0:
            item["value"] = "0"
        else:
            price, reason = await close_input(conn, history, owner, row, day)
            if reason:
                issue(reason, recordId=rid)
                continue
            item["close"] = price
            value = row["qty"] * Decimal(price["value"])
            item["value"] = str(value)
            stock_values[price["currency"]] += value
    openings = await (await conn.execute("""
        SELECT account_id,currency,opening_request_id,opening_at FROM cash_ledger_accounts
        WHERE owner_id=%s AND account_id=ANY(%s) AND opening_at<%s ORDER BY account_id,currency
    """, (owner, account_ids, cutoff))).fetchall()
    opened = {(row["account_id"], row["currency"]) for row in openings}
    for account in accounts:
        for currency in account["currencies"]:
            if (account["id"], currency) not in opened:
                issue("missing_cash_opening", accountId=account["id"], currency=currency)
    balances = await (await conn.execute("""
        SELECT currency, sum(amount) FILTER (WHERE affects_owner) AS balance, count(*) AS count,
               bool_or(occurred_at<%s AND created_at>%s) AS changed_prior
        FROM cash_ledger_entries WHERE owner_id=%s AND account_kind=%s AND occurred_at<%s GROUP BY currency
        ORDER BY currency
    """, (lower, prior["captured_at"] if prior else None, owner, kind, cutoff))).fetchall()
    cash.update({row["currency"]: row["balance"] for row in balances if row["balance"] is not None})
    postings = await (await conn.execute("""
        SELECT id,account_id,currency,kind,amount,occurred_at,created_at,request_id,source_trade_id,
               trade_amendment_id,affects_owner
        FROM cash_ledger_entries WHERE owner_id=%s AND account_kind=%s AND occurred_at>=%s AND occurred_at<%s
        ORDER BY occurred_at,id LIMIT 20001
    """, (owner, kind, lower, cutoff))).fetchall()
    if len(postings) > MAX_POSTINGS:
        issue("cash_posting_limit")
    for row in postings[:MAX_POSTINGS]:
        daily_postings.append(row)
        if row["affects_owner"] and row["kind"] in ("external_deposit", "external_withdrawal", "opening"):
            external[row["currency"]] += row["amount"]
    currencies = {code for group in (cash, stock_values, external) for code, value in group.items() if value}
    fx = await fx_inputs(conn, currencies, day, cutoff)
    for code in sorted(currencies - fx.keys()):
        issue("missing_historical_fx", currency=code)
    value = None
    if not missing:
        value = sum(((cash[code] + stock_values[code]) / Decimal(fx[code]["rate"]) for code in sorted(currencies)), Decimal(0))
    # A correction from an earlier accounting date must never show as today's profit.
    old_value = prior["result"]["equity"] if prior else None
    if old_value is None:
        issue("missing_prior_equity")
    elif any(row["changed_prior"] for row in balances):
        issue("prior_period_posting_changed")
    if any(row["affects_owner"] and row["kind"] not in (
        "opening", "external_deposit", "external_withdrawal", "trade_buy", "trade_sell", "trade_dividend", "allocation"
    ) for row in daily_postings):
        issue("unclassified_cash_adjustment")
    if prior and old_value is not None:
        prior_qty = {row["recordId"]: Decimal(row["quantity"]) for row in prior["result"]["positions"] if row["quantity"] is not None}
        qty = {row["recordId"]: Decimal(row["quantity"]) for row in positions if row["quantity"] is not None}
        trade_ids = [row["source_trade_id"] for row in daily_postings if row["source_trade_id"]]
        deltas = defaultdict(Decimal)
        if trade_ids:
            trades = await (await conn.execute("SELECT id,record_id,after_quantity-before_quantity AS delta FROM trade_ledger WHERE owner_id=%s AND id=ANY(%s)", (owner, trade_ids))).fetchall()
            for trade in trades:
                deltas[trade["record_id"]] += trade["delta"]
        for rid in sorted(qty.keys() | prior_qty.keys() | deltas.keys()):
            if qty.get(rid, 0) - prior_qty.get(rid, 0) != deltas[rid]:
                issue("unattributed_position_change", recordId=rid)
    flow = None if currencies - fx.keys() else sum((amount / Decimal(fx[code]["rate"]) for code, amount in sorted(external.items()) if amount), Decimal(0))
    pnl = value - Decimal(old_value) - flow if not missing else None
    return packed({"day": day, "cutoff": cutoff, "accountKind": kind, "currency": "USD", "rule": "utc_close_nav_less_net_external_cash_v1",
                   "state": "complete" if pnl is not None else "partial" if positions or balances else "missing",
                   "pnl": pnl, "equity": value, "priorEquity": old_value, "externalFlow": flow,
                   "priorRevision": prior["revision"] if prior else None,
                   "positions": positions, "cashByCurrency": dict(cash), "closeValueByCurrency": dict(stock_values),
                   "externalFlowByCurrency": dict(external), "cashOpenings": openings, "cashPostings": daily_postings,
                   "cashPostingCount": sum(row["count"] for row in balances), "cashPostingsSha256": digest(packed(daily_postings)),
                   "fx": fx, "missing": missing})


async def capture_day(db, history, owner, kind, day, *, now=None):
    now = now or datetime.now(UTC)
    if now < boundary(day) + CAPTURE_DELAY:
        raise ValueError("Day has not closed")
    async with db.connection() as conn, conn.transaction():
        await conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        lock = await (await conn.execute("SELECT pg_try_advisory_xact_lock(hashtextextended(%s,0)) AS acquired",
                                        (f"portfolio-daily:{owner}:{kind}:{day}",))).fetchone()
        if not lock["acquired"]:
            return None
        if not await (await conn.execute("SELECT 1 FROM users WHERE id=%s AND active FOR SHARE", (owner,))).fetchone():
            return None
        with localcontext() as ctx:
            ctx.prec = 80
            result = await calculate(conn, history, owner, kind, day)
        fingerprint = digest(result)
        latest = await (await conn.execute("""
            SELECT revision,input_sha256 FROM portfolio_daily_results WHERE owner_id=%s AND account_kind=%s
            AND valuation_day=%s ORDER BY revision DESC LIMIT 1
        """, (owner, kind, day))).fetchone()
        revision = None
        if latest is None or latest["input_sha256"] != fingerprint:
            revision = latest["revision"] + 1 if latest else 1
            await conn.execute("""
                INSERT INTO portfolio_daily_results(owner_id,account_kind,valuation_day,revision,input_sha256,result)
                VALUES(%s,%s,%s,%s,%s,%s)
            """, (owner, kind, day, revision, fingerprint, Jsonb(result)))
        await conn.execute("""
            INSERT INTO portfolio_daily_checks(owner_id,account_kind,valuation_day) VALUES(%s,%s,%s)
            ON CONFLICT(owner_id,account_kind,valuation_day) DO UPDATE SET checked_at=clock_timestamp()
        """, (owner, kind, day))
        return {**result, "revision": revision} if revision else None


async def capture_due(db, history, *, now=None):
    now = now or datetime.now(UTC)
    day = (now - CAPTURE_DELAY).date() - DAY
    async with db.connection() as conn:
        rows = await (await conn.execute("""
            SELECT b.owner_id,b.account_kind,d.day::date AS day
            FROM broker_accounts b JOIN users u ON u.id=b.owner_id AND u.active
            CROSS JOIN generate_series(%s::date::timestamp,%s::date::timestamp,interval '1 day') d(day)
            LEFT JOIN portfolio_daily_checks c ON c.owner_id=b.owner_id AND c.account_kind=b.account_kind AND c.valuation_day=d.day::date
            WHERE b.account_kind IN ('real','simulated') AND b.created_at<(d.day+interval '1 day') AT TIME ZONE 'UTC'
              AND (b.deleted_at IS NULL OR b.deleted_at>=(d.day+interval '1 day') AT TIME ZONE 'UTC')
              AND (c.checked_at IS NULL OR c.checked_at<%s)
            GROUP BY b.owner_id,b.account_kind,d.day
            ORDER BY min(c.checked_at) NULLS FIRST,d.day,b.owner_id,b.account_kind LIMIT 4
        """, (day - 6 * DAY, day, now - timedelta(hours=2)))).fetchall()
    for row in rows:
        try:
            async with asyncio.timeout(25):
                await capture_day(db, history, row["owner_id"], row["account_kind"], row["day"], now=now)
        except Exception as exc:  # noqa: BLE001 -- one unavailable ledger must leave other accounts eligible
            LOG.warning("portfolio_daily_capture_unavailable type=%s", type(exc).__name__)


async def daily_result_loop(db, history, stop, ready):
    while not stop.is_set():
        try:
            if ready():
                await capture_due(db, history)
        except Exception as exc:  # noqa: BLE001 -- a failed scheduler pass must never stop the worker
            LOG.warning("portfolio_daily_schedule_unavailable type=%s", type(exc).__name__)
        try:
            await asyncio.wait_for(stop.wait(), 60)
        except TimeoutError:
            pass


def mount_portfolio_daily(app, db, authority):
    @app.get("/api/v2/investment-files/daily-results", operation_id="native_investment_files_daily_results")
    @app.get("/api/personal-data-transfer/daily-results", operation_id="portfolio_daily_results")
    async def read(request: Request, kind: str = "real", before: date | None = None,
                   day: date | None = None, revision: int | None = None, folders: bool = False,
                   year: int | None = None, month: int | None = None):
        try:
            who = await investment_file_actor(request, db)
            assert_expected_account(request, who.id)
            if (kind not in ("real", "simulated") or (revision is not None and (revision < 1 or day is None))
                    or (day and (before or folders or year is not None or month is not None))
                    or (year is not None and not 1 <= year <= 9998)
                    or (month is not None and (year is None or not 1 <= month <= 12 or folders))
                    or (folders and before) or (year is not None and not folders and month is None)):
                raise HTTPException(400, "日终记录查询参数无效")
            async with db.connection() as conn, conn.transaction():
                await lock_read_identity(conn, who)
                if folders and year is None:
                    rows = await (await conn.execute("""
                        SELECT extract(year FROM valuation_day)::int AS year, count(DISTINCT valuation_day) AS count
                        FROM portfolio_daily_results WHERE owner_id=%s AND account_kind=%s GROUP BY 1 ORDER BY 1 DESC
                    """, (who.id, kind))).fetchall()
                    value = {"items": rows, "next": None}
                elif folders:
                    rows = await (await conn.execute("""
                        SELECT extract(month FROM valuation_day)::int AS month, count(DISTINCT valuation_day) AS count
                        FROM portfolio_daily_results WHERE owner_id=%s AND account_kind=%s AND valuation_day>=%s
                        AND valuation_day<%s GROUP BY 1 ORDER BY 1 DESC
                    """, (who.id, kind, date(year, 1, 1), date(year + 1, 1, 1)))).fetchall()
                    value = {"items": [{**row, "year": year} for row in rows], "next": None}
                elif day:
                    rows = await (await conn.execute("""
                        SELECT revision FROM portfolio_daily_results
                        WHERE owner_id=%s AND account_kind=%s AND valuation_day=%s ORDER BY revision DESC
                    """, (who.id, kind, day))).fetchall()
                    revisions = [row["revision"] for row in rows]
                    selected_revision = revision or (revisions[0] if revisions else None)
                    selected = await (await conn.execute("""
                        SELECT revision,captured_at,input_sha256,result FROM portfolio_daily_results
                        WHERE owner_id=%s AND account_kind=%s AND valuation_day=%s AND revision=%s
                    """, (who.id, kind, day, selected_revision))).fetchone()
                    if selected is None:
                        raise HTTPException(404, "该日日终快照尚未保存")
                    for source in {p["close"]["sourceRevision"] for p in selected["result"]["positions"] if p["close"]}:
                        try:
                            await authority.config(conn, who.id, source)
                        except HTTPException:
                            raise HTTPException(409, "该版快照的行情来源目前不可查看") from None
                    value = {**selected["result"], "revision": selected["revision"], "capturedAt": selected["captured_at"],
                             "inputSha256": selected["input_sha256"], "revisions": revisions}
                else:
                    first = date(year, month, 1) if month is not None else None
                    end = (first.replace(day=28) + 4 * DAY).replace(day=1) if first else None
                    rows = await (await conn.execute("""
                        SELECT DISTINCT ON (valuation_day) valuation_day AS day,revision,captured_at AS "capturedAt",
                             result->>'state' AS state,result->>'pnl' AS pnl,result->>'currency' AS currency,
                             result->>'equity' AS equity,jsonb_array_length(result->'missing') AS "missingCount"
                        FROM portfolio_daily_results WHERE owner_id=%s AND account_kind=%s
                            AND (%s::date IS NULL OR valuation_day<%s)
                            AND (%s::date IS NULL OR valuation_day>=%s AND valuation_day<%s)
                        ORDER BY valuation_day DESC,revision DESC LIMIT %s
                    """, (who.id, kind, before, before, first, first, end, 31 if month else 25))).fetchall()
                    value = {"items": rows if month else rows[:24], "next": rows[23]["day"] if month is None and len(rows) > 24 else None}
            return wire_response(packed(value), PRIVATE)
        except HTTPException as exc:
            return wire_response({"error": exc.detail}, {**PRIVATE, **(exc.headers or {})}, exc.status_code)
