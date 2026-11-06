"""Observed close-to-close security price effects, separate from current exposure estimates."""

import hashlib
from collections import defaultdict
from datetime import datetime, time, timedelta
from decimal import Decimal, localcontext
from zoneinfo import ZoneInfo

from fastapi import HTTPException

from .actual_projection import actual_record_dto
from .legacy_asset_authority import LegacyAssetAuthority
from .market_contract import CURRENCIES, ZONES
from .market_history_reads import LicensedHistory
from .portfolio_overview import encode
from .position_transfer_checkpoint import attach_openings, current_rows, opening
from .scope_coverage import record_status
from .trade_amendment_history import attach_amendments, effective_rows
from .trade_amendment_model import verify_physical


def number(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        result = Decimal(str(value))
        return result if result.is_finite() else None
    except (ValueError, ArithmeticError):
        return None


def stamp(value):
    return datetime.fromisoformat(value) if isinstance(value, str) else value


class DailyActivitySummary(LegacyAssetAuthority):
    def __init__(self, db, market_authority):
        super().__init__(db, market_authority)

    async def closes(self, conn, who, record, now):
        history = LicensedHistory(self.market_authority)
        choices, retained = await history.choices(
            conn,
            who.id,
            record["market"],
            record["code"],
            frame="day",
            adjust="none",
            instrument="equity",
            session="REGULAR",
            kind="bars",
        )
        if len(choices) != 1:
            return (
                None,
                "history_retained_unavailable"
                if retained and not choices
                else "licensed_unadjusted_daily_history_missing"
                if not choices
                else "multiple_history_sources_require_explicit_selection",
            )
        (revision, series), (policy, query) = next(iter(choices.items()))
        rows = await (
            await conn.execute(
                """SELECT * FROM (SELECT DISTINCT ON(source_time) * FROM market_facts WHERE owner_id=%s AND source_revision=%s AND series_fingerprint=%s ORDER BY source_time DESC,sequence DESC) newest ORDER BY source_time DESC LIMIT 32""",
                (who.id, revision, series),
            )
        ).fetchall()
        zone = ZoneInfo(ZONES[record["market"]])
        today = now.astimezone(zone).date()
        days = {}
        for row in rows:
            value = row["contents"]
            at = stamp(value.get("at"))
            close = number(value.get("c"))
            if (
                not isinstance(at, datetime)
                or at.tzinfo is None
                or at != row["source_time"]
                or value.get("source") != policy.source
                or value.get("sourceVersion") != policy.source_version
                or value.get("currency") != CURRENCIES[record["market"]]
                or value.get("session") != "REGULAR"
                or close is None
                or close <= 0
            ):
                return None, "daily_fact_identity_or_price_unknown"
            day = at.astimezone(zone).date()
            if day < today and day not in days:
                days[day] = (row, close)
        dates = sorted(days)
        if len(dates) < 2:
            return None, "two_observed_completed_daily_bars_missing"
        before, day = dates[-2:]
        selected = [days[before][0], days[day][0]]
        for row in selected:
            page = await (
                await conn.execute(
                    "SELECT raw_bytes,raw_sha256 FROM market_source_pages WHERE owner_id=%s AND id=%s AND source_revision=%s",
                    (who.id, row["page_id"], revision),
                )
            ).fetchone()
            if not page or hashlib.sha256(bytes(page["raw_bytes"])).hexdigest() != page["raw_sha256"]:
                return None, "daily_source_original_unverified"
        return {
            "previousDate": before.isoformat(),
            "date": day.isoformat(),
            "previousClose": days[before][1],
            "close": days[day][1],
            "priceDifference": days[day][1] - days[before][1],
            "currency": CURRENCIES[record["market"]],
            "source": {
                "sourceRevision": str(revision),
                "licenseRevision": policy.license_revision,
                "adjust": query.adjust,
                "pageIds": [str(r["page_id"]) for r in selected],
                "factIds": [str(r["id"]) for r in selected],
                "observationScope": "last_two_observed_completed_bars",
                "consecutiveTradingDaysVerified": False,
            },
        }, None

    async def quantity_proof(self, conn, owner, record, start, end):
        if not await record_status(conn, owner, record["id"]):
            return None, {"state": "unknown"}, "record_source_scope_incomplete"
        fills = await (
            await conn.execute(
                "SELECT * FROM trade_ledger WHERE owner_id=%s AND record_id=%s ORDER BY before_record_revision LIMIT 10001",
                (owner, record["id"]),
            )
        ).fetchall()
        if len(fills) > 10000:
            return None, {"state": "unknown"}, "trade_replay_budget_exceeded"
        await attach_openings(conn, owner, [record])
        await attach_amendments(conn, owner, fills)
        fees = await (
            await conn.execute(
                "SELECT * FROM trade_fee_projections WHERE owner_id=%s AND record_id=%s ORDER BY before_record_revision LIMIT 10001",
                (owner, record["id"]),
            )
        ).fetchall()
        if len(fees) > 10000:
            return None, {"state": "unknown"}, "fee_replay_budget_exceeded"
        try:
            amendments = fills[0].get("_record_amendments", []) if fills else []
            initial = verify_physical(fills, record, fees, amendments)
            boundary = opening(record)
            active = effective_rows(current_rows(fills, record))
            anchor = (
                boundary["at"]
                if boundary
                else min(stamp((r.get("_effective_event") or r)["occurred_at"]) for r in active)
                if active
                else None
            )
            if anchor is None or anchor > start:
                return None, {"state": "unknown"}, "verified_opening_not_before_observation_window"
            qty = initial.quantity
            used = []
            for raw in active:
                event = {**raw, **raw.get("_effective_event", {})}
                at = stamp(event["occurred_at"])
                if start <= at < end:
                    return (
                        None,
                        {"state": "unknown", "openingAt": anchor.isoformat()},
                        "within_window_trade_or_dividend_requires_cashflow_reconciliation",
                    )
                if at < start:
                    amount = number(event["quantity"])
                    if amount is None:
                        return None, {"state": "unknown"}, "historical_trade_quantity_unknown"
                    if event["side"] == "buy":
                        qty += amount
                    elif event["side"] == "sell":
                        qty -= amount
                    used.append(str(raw["id"]))
            if qty < 0:
                return None, {"state": "unknown"}, "historical_quantity_invalid"
            # No event crosses either whole local day: quantity is known at any
            # actual session close without assuming a historical holiday/half-day calendar.
            proof = {
                "state": "verified_constant_quantity",
                "openingAt": anchor.isoformat(),
                "quantity": qty,
                "tradeIds": used,
                "transferCheckpointId": str(record["position_transfer_id"])
                if record.get("position_transfer_id")
                else None,
                "windowStart": start.isoformat(),
                "windowEnd": end.isoformat(),
                "authority": "verified_platform_journal_not_external_broker_statement",
            }
            return qty, proof, None
        except (ValueError, ArithmeticError, KeyError, HTTPException):
            return None, {"state": "unknown"}, "effective_trade_or_transfer_lineage_unverified"

    async def read(self, who):
        async with self.context(who) as conn:
            await self.market_authority.authorize_read(conn, who)
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("market-owner:" + who.id,)
            )
            rows = await (
                await conn.execute(
                    "SELECT * FROM portfolio_records WHERE owner_id=%s AND deleted_at IS NULL AND market IN ('US','HK','CN','JP','KR') AND qty>0 ORDER BY id LIMIT 1001",
                    (who.id,),
                )
            ).fetchall()
            if len(rows) > 1000:
                raise HTTPException(409, "日汇总证券范围超过完整读取预算")
            accounts = await (
                await conn.execute(
                    "SELECT * FROM broker_accounts WHERE owner_id=%s AND deleted_at IS NULL", (who.id,)
                )
            ).fetchall()
            by_account = {r["id"]: r for r in accounts}
            now = (await (await conn.execute("SELECT clock_timestamp() AS at")).fetchone())["at"]
            books = defaultdict(list)
            markets = {}
            dates = set()
            with localcontext() as precision:
                precision.prec = 80
                for record in rows:
                    account = by_account.get(record["broker_account_id"])
                    kind = (
                        account["account_kind"]
                        if account and account["account_kind"] in {"real", "simulated"}
                        else "unknown"
                    )
                    projected = await actual_record_dto(conn, who.id, record)
                    qty = number(projected.get("qty"))
                    currency = CURRENCIES[record["market"]]
                    reasons = []
                    item = {
                        "recordId": record["id"],
                        "accountId": record["broker_account_id"],
                        "market": record["market"],
                        "code": record["code"],
                        "quantity": qty,
                        "currency": currency,
                        "actualPnl": None,
                        "currentExposurePriceMoveEstimate": None,
                        "previousDate": None,
                        "date": None,
                        "previousClose": None,
                        "close": None,
                        "priceDifference": None,
                        "quantityProof": {"state": "unknown"},
                        "source": None,
                        "reasons": reasons,
                    }
                    prices, error = await self.closes(conn, who, record, now)
                    if error:
                        reasons.append(error)
                    if prices:
                        item.update(prices)
                        dates.add(prices["date"])
                        declaration, stored = await self.declaration(conn, who.id, record)
                        units = (
                            stored is None
                            or declaration["identityMatches"]
                            and declaration["kind"] == "cash_equity"
                        )
                        if not units:
                            reasons.append("security_units_or_multiplier_unknown")
                        if qty is not None and qty >= 0 and units:
                            item["currentExposurePriceMoveEstimate"] = qty * prices["priceDifference"]
                        else:
                            reasons.append("current_quantity_unknown")
                        zone = ZoneInfo(ZONES[record["market"]])
                        start = datetime.combine(
                            datetime.fromisoformat(prices["previousDate"]).date(), time(), zone
                        )
                        end = datetime.combine(
                            datetime.fromisoformat(prices["date"]).date() + timedelta(days=1), time(), zone
                        )
                        historical, proof, error = await self.quantity_proof(conn, who.id, record, start, end)
                        item["quantityProof"] = proof
                        if error:
                            reasons.append(error)
                        if kind == "unknown":
                            reasons.append("account_kind_unknown")
                        if account and account["holding_source"] != "manual":
                            reasons.append("official_report_is_not_complete_period_trade_history")
                        if (
                            historical is not None
                            and units
                            and kind != "unknown"
                            and account
                            and account["holding_source"] == "manual"
                        ):
                            item["actualPnl"] = historical * prices["priceDifference"]
                    books[(kind, currency)].append(item)
                    if prices:
                        group = markets.setdefault(
                            record["market"], {"holdings": 0, "pnl": None, "date": prices["date"]}
                        )
                        group["holdings"] += 1
                        group["date"] = max(group["date"], prices["date"])
            # Source revocation/expiry may occur while local journal facts are read.
            for positions in books.values():
                for item in positions:
                    source = item.get("source")
                    if source:
                        try:
                            _, policy = await self.market_authority.config(
                                conn, who.id, source["sourceRevision"]
                            )
                            if policy.license_revision != source["licenseRevision"]:
                                raise HTTPException(409, "来源许可已变化")
                        except HTTPException:
                            item.update(
                                actualPnl=None,
                                currentExposurePriceMoveEstimate=None,
                                previousClose=None,
                                close=None,
                                priceDifference=None,
                            )
                            item["reasons"].append("history_source_authorization_changed")
            result_books = []
            for (kind, currency), positions in books.items():

                def total(field, positions=positions):
                    return (
                        sum((p[field] for p in positions), Decimal(0))
                        if positions
                        and all(p[field] is not None for p in positions)
                        and len({p["date"] for p in positions}) == 1
                        else None
                    )

                result_books.append(
                    {
                        "accountKind": kind,
                        "currency": currency,
                        "actualPnl": total("actualPnl"),
                        "currentExposurePriceMoveEstimate": total("currentExposurePriceMoveEstimate"),
                        "complete": total("actualPnl") is not None,
                        "reasons": list(dict.fromkeys(reason for p in positions for reason in p["reasons"])),
                        "positions": positions,
                    }
                )
            return encode(
                {
                    "date": next(iter(dates))
                    if len(dates) == 1
                    else " ~ ".join(sorted(dates)[:: max(1, len(dates) - 1)])
                    if dates
                    else "",
                    "holdings": sum(v["holdings"] for v in markets.values()),
                    "markets": markets,
                    "settlement": "最近两根已观测且已结束的日K收盘价差",
                    "legacySettlement":"上一交易日收盘相对前收盘",
                    "lastTradingDayVerified":False,
                    "books": result_books,
                    "calculation": {
                        "actualPnlScope": "verified_platform_security_price_effect_only",
                        "currentExposureEstimateIsActualPnl": False,
                        "feesAndFxIncluded": False,
                        "collectionOnRead": False,
                        "scope": "current_positive_positions_only",
                        "closedPositionsIncluded": False,
                        "wholeAccountDailyProfitKnown": False,
                    },
                }
            )
