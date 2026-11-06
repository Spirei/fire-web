"""Owned native cash DTOs; financial authority stays in CashLedger."""

import hashlib
import json
import re
from datetime import UTC, datetime
from decimal import Decimal

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse

from .broker_accounts import broker_account
from .cash_ledger import CashLedger, add
from .legacy_broker_read import LEGACY_CURRENCIES, iso
from .legacy_financing import js_number
from .legacy_identity import assert_native_origin, native_identity
from .native_app_auth import CLIENT
from .source_read_access import source_read_lock


class CashReadError(HTTPException):
    def __init__(self, status, detail, code):
        super().__init__(status, detail)
        self.legacy_code = code


def error_body(exc):
    return {"code": getattr(exc, "legacy_code", exc.status_code * 100 + 1), "message": str(exc.detail)}


def money(value):
    return None if value is None else float(js_number(value))


def revision(value):
    return hashlib.sha256(
        json.dumps(value, ensure_ascii=True, separators=(",", ":"), sort_keys=True).encode()
    ).hexdigest()


def snapshot_dto(owner, account, snapshot, facts, *, instance, observed_at):
    """Protocol projection only: no balance, opening or zero is derived here."""
    global_revision = revision(
        ["platform-cash-read/1", instance, owner, account["account_kind"], snapshot["revision"]]
    )
    result = []
    for row in sorted(snapshot["currencies"], key=lambda item: item["currency"]):
        currency = row["currency"]
        if currency not in LEGACY_CURRENCIES:
            raise HTTPException(409, "旧账户协议不支持当前账户币种，请使用平台账户接口")
        opening = row["opening"]
        if opening is not None and account["account_kind"] not in ("real", "simulated"):
            raise HTTPException(409, "账户真实或模拟身份尚未核对")
        fact = facts.get(currency, {})
        ledger_capacity = fact.get("ledgerCapacity", {})
        if opening is not None and fact.get("openingAmount") is None:
            raise HTTPException(503, "现金期初原流水暂时无法核对")
        official = account["holding_source"] == "official"
        observation = row.get("officialObservation")
        if official and (not isinstance(observation, dict) or observation.get("state") not in ("reported", "unavailable")
                         or row["balance"] is not None and observation.get("state") != "reported"):
            raise HTTPException(503, "官方现金快照来源暂时无法核对")
        known = not official and opening is not None and row["complete"] is True and row["balance"] is not None
        state = (
            "official_readonly"
            if official
            else "uninitialized"
            if opening is None
            else "ready"
            if known
            else "incomplete"
        )
        reasons = (
            ["official_snapshot_not_cash_ledger_history"]
            if official
            else ["opening_not_set"]
            if opening is None
            else ["broker_buying_power_not_enforced"]
            if known
            else ["cash_ledger_source_incomplete", "broker_buying_power_not_enforced"]
        )
        result.append(
            {
                "currency": currency,
                "cashRevision": snapshot["revision"] if opening is not None else 0,
                "state": state,
                "opening": None
                if opening is None
                else {
                    "amount": money(fact["openingAmount"]),
                    "asOf": iso(opening["opening_at"]),
                    "basis": opening["opening_basis"],
                },
                "balance": money(row["balance"]) if known or official else None,
                "registeredBalance": money(row["registeredBalance"]),
                "activity": {
                    key: money(value) if key != "entryCount" else value
                    for key, value in fact["activity"].items()
                }
                if known and fact.get("activity") is not None
                else None,
                "withdrawalCapacity": {
                    "amount": None,
                    "reservedGlobalBuyCash": None,
                    "basis": "min_broker_balance_and_owner_fund_cash_after_reservations",
                },
                "ledgerWithdrawalCapacity": {
                    "amount": money(ledger_capacity.get("amount")),
                    "reservedBuyCash": money(ledger_capacity.get("reservedCash")),
                    "complete": ledger_capacity.get("complete") is True,
                    "basis": "min_account_and_verified_owner_kind_cash_after_reservations",
                    "coverageScope": "platform_owner_kind_cash",
                    "accountKind": account["account_kind"],
                },
                "available": None,
                "reserved": None,
                "complete": known,
                "unavailableReasons": reasons,
                "officialObservation": row["officialObservation"] if official else None,
                **({"configured": row.get("configured", True),
                    "sourceOnly": row.get("sourceOnly", False)} if official else {}),
            }
        )
    return {
        "userId": owner,
        "brokerAccountId": account["id"],
        "accountKind": account["account_kind"],
        "brokerRevision": account["revision"],
        "globalCashRevision": global_revision,
        "snapshotRevision": revision(
            [
                global_revision,
                account["id"],
                account["revision"],
                account["holding_source"],
                result,
            ]
        ),
        "holdingSource": account["holding_source"],
        "asOf": iso(observed_at),
        "tradingCashBasis": "owner_currency_ledger",
        "currencies": result,
        "coverageScope": "platform_registered_cash_only",
        "activityCoverageScope": "platform_posted_events_including_corrections",
        "historicalCoverageKnown": False,
        "withdrawalCapacityKnown": False,
    }


async def activity_facts(conn, owner, account, snapshot):
    facts = {}
    for row in snapshot["currencies"]:
        if row["opening"] is None:
            continue
        scope = (owner, account["id"], row["currency"], account["account_kind"])
        opening = await (
            await conn.execute(
                "SELECT e.amount FROM cash_ledger_accounts a JOIN cash_ledger_entries e ON e.owner_id=a.owner_id AND e.account_id=a.account_id AND e.currency=a.currency AND e.request_id=a.opening_request_id WHERE a.owner_id=%s AND a.account_id=%s AND a.currency=%s AND e.account_kind=%s AND e.kind IN ('opening','allocation') AND e.occurred_at=a.opening_at",
                scope,
            )
        ).fetchone()
        if not opening:
            raise HTTPException(503, "现金期初原流水暂时无法核对")
        activity = await (
            await conn.execute(
                "SELECT count(*) AS count,coalesce(sum(amount) FILTER(WHERE kind='external_deposit'),0) AS deposits,coalesce(-sum(amount) FILTER(WHERE kind='external_withdrawal'),0) AS withdrawals,coalesce(sum(amount) FILTER(WHERE kind IN ('trade_buy','trade_sell','trade_dividend','fee_correction','trade_correction')),0) AS trades FROM cash_ledger_entries WHERE owner_id=%s AND account_id=%s AND currency=%s AND account_kind=%s",
                scope,
            )
        ).fetchone()
        facts[row["currency"]] = {
            "openingAmount": opening["amount"],
            "activity": {
                "openingAmount": opening["amount"],
                "externalDeposits": activity["deposits"],
                "externalWithdrawals": activity["withdrawals"],
                "netExternalFlow": add(activity["deposits"], activity["withdrawals"].copy_negate()),
                "tradeNetFlow": activity["trades"],
                "entryCount": activity["count"],
            },
        }
    return facts


def history_query(query):
    if any(
        key not in ("currency", "limit", "offset", "snapshotRevision") or len(query.getlist(key)) != 1
        for key in query
    ):
        raise HTTPException(400, "流水参数无效")
    currency = query.get("currency", "")
    if currency not in LEGACY_CURRENCIES:
        raise HTTPException(400, "币种无效")
    limit, offset, expected = (
        query.get("limit", "50"),
        query.get("offset", "0"),
        query.get("snapshotRevision"),
    )
    if (
        not re.fullmatch(r"[1-9][0-9]*", limit)
        or len(limit) > 3
        or int(limit) > 200
        or not re.fullmatch(r"[0-9]+", offset)
        or len(offset) > 16
        or int(offset) > 9007199254740991
        or expected is not None
        and not re.fullmatch(r"[a-f0-9]{64}", expected)
    ):
        raise HTTPException(400, "流水分页无效")
    if int(offset) > 0 and expected is None:
        raise HTTPException(409, "流水续页需要原快照版本")
    return currency, int(limit), int(offset), expected


def history_dto(page, owner, account_id, currency, *, instance, limit, offset, expected=None):
    if page["accountId"] != account_id:
        raise HTTPException(503, "现金流水来源暂时无法核对")
    snap = revision(
        [
            "platform-cash-entries/1",
            instance,
            owner,
            account_id,
            page["accountKind"],
            currency,
            page["revision"],
        ]
    )
    if expected is not None and expected != snap:
        raise CashReadError(409, "流水已变化，请从第一页重读", 40902)
    items = []
    for entry in page["items"]:
        if entry["currency"] != currency:
            raise HTTPException(503, "现金流水来源暂时无法核对")
        if entry["sourceTradeId"] is not None and entry["actualFeeKnown"] is not True:
            raise HTTPException(409, "旧流水协议不能表达尚未核实的实付费用，请使用平台精确流水接口")
        amount = Decimal(entry["registeredAmount"])
        items.append(
            {
                "id": entry["id"],
                "operationId": entry["requestId"]
                if entry["receipt"] and entry["receipt"]["kind"] == "cash"
                else None,
                "brokerAccountId": account_id,
                "currency": currency,
                "kind": "opening" if entry["kind"] == "allocation" else entry["kind"],
                "amount": money(amount.copy_abs()),
                "direction": -1 if amount < 0 else 1,
                "occurredAt": entry["occurredAt"],
                "createdAt": entry["createdAt"],
                "note": entry["note"],
                "sourceOrderId": entry["sourceTradeId"],
                "balanceAfter": None,
                "registeredAmount": entry["registeredAmount"],
                "amountAuthority": "registered_posting",
                "receipt": entry["receipt"],
                "affectsOwnerCash": entry["affectsOwnerCash"],
            }
        )
    return {
        "snapshotRevision": snap,
        "balancesComplete": False,
        "pagination": {"limit": limit, "offset": offset, "total": page["total"]},
        "items": items,
        "accountKind": page["accountKind"],
        "coverageScope": "platform_registered_entries_only",
        "historicalCoverageKnown": False,
    }


async def history_read(db, who, account_id, query):
    from .cash_history import entries

    currency, limit, offset, expected = history_query(query)
    async with db.connection() as conn, conn.transaction():
        await source_read_lock(conn, who)
        head = await (
            await conn.execute("SELECT revision FROM cash_ledger_collections WHERE owner_id=%s", (who.id,))
        ).fetchone()
        current = head["revision"] if head else 0
        instance = str(
            (await (await conn.execute("SELECT instance_id FROM alcor_instance WHERE singleton")).fetchone())[
                "instance_id"
            ]
        )

    async def read_page(size, start):
        try:
            return await entries(
                db, who, account_id, currency=currency, limit=size, offset=start, revision=current
            )
        except HTTPException as exc:
            if exc.status_code == 409:
                raise CashReadError(409, "流水已变化，请从第一页重读", 40902) from None
            raise

    page = await read_page(min(limit, 100), offset)
    if limit > 100 and len(page["items"]) == 100 and page["total"] > offset + 100:
        rest = await read_page(limit - 100, offset + 100)
        if (
            rest["revision"] != page["revision"]
            or rest["total"] != page["total"]
            or rest["accountKind"] != page["accountKind"]
        ):
            raise CashReadError(409, "流水已变化，请从第一页重读", 40902)
        page = {**page, "items": [*page["items"], *rest["items"]]}
    return history_dto(
        page, who.id, account_id, currency, instance=instance, limit=limit, offset=offset, expected=expected
    )


def mount_legacy_cash_reads(app):
    service = CashLedger(app.state.db)

    async def respond(request, version, accountId, *, history=False):
        headers = {
            "Cache-Control": "no-store, private",
            "Vary": "Authorization",
            "X-Alcor-API-Version": str(version),
            "X-Alcor-Source-Coverage": "platform-only",
        }
        try:
            if version not in (1, 2):
                raise HTTPException(404, "接口不存在")
            db = app.state.db
            try:
                assert_native_origin(request, db.settings)
            except HTTPException:
                raise HTTPException(403, "请求来源不受信任") from None
            if not re.fullmatch(r"Bearer fat_[A-Za-z0-9_-]{43}", request.headers.get("authorization", "")):
                raise HTTPException(401, "需要有效的 App 连接")
            try:
                who, grant = await native_identity(request, db, "portfolio.read")
            except HTTPException as exc:
                if exc.status_code == 401:
                    raise HTTPException(401, "需要有效的 App 连接") from None
                if exc.status_code == 403:
                    raise HTTPException(403, "连接缺少明确授权的范围") from None
                raise
            if grant["client_id"] != CLIENT:
                raise HTTPException(401, "需要有效的 App 连接")
            if request.query_params and not history:
                raise HTTPException(400, "不支持查询参数")
            if not re.fullmatch(r"ba-[a-f0-9]{24}", accountId):
                raise HTTPException(404, "账户不存在")
            if history:
                value = await history_read(db, who, accountId, request.query_params)
                return JSONResponse({"code": 0, "message": "ok", "data": value}, headers=headers)
            async with db.connection() as conn, conn.transaction():
                await conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
                await source_read_lock(conn, who)
                account = await broker_account(conn, who.id, accountId)
                head = await (
                    await conn.execute(
                        "SELECT revision FROM cash_ledger_collections WHERE owner_id=%s", (who.id,)
                    )
                ).fetchone()
                snapshot = await service.snapshot_on_connection(
                    conn, who, accountId, head["revision"] if head else 0
                )
                facts = await activity_facts(conn, who.id, account, snapshot)
                if account["account_kind"] in ("real", "simulated") and account["holding_source"] == "manual":
                    for row in snapshot["currencies"]:
                        facts.setdefault(row["currency"], {})[
                            "ledgerCapacity"
                        ] = await service.withdrawal_capacity_on_connection(
                            conn, who, accountId, row["currency"], account_kind=account["account_kind"]
                        )
                instance = await (
                    await conn.execute("SELECT instance_id FROM alcor_instance WHERE singleton")
                ).fetchone()
                value = snapshot_dto(
                    who.id,
                    account,
                    snapshot,
                    facts,
                    instance=str(instance["instance_id"]),
                    observed_at=datetime.now(UTC),
                )
            return JSONResponse({"code": 0, "message": "ok", "data": value}, headers=headers)
        except HTTPException as exc:
            if exc.status_code in (401, 403):
                headers["X-Alcor-Retire-Context"] = "true"
            return JSONResponse(
                error_body(exc),
                status_code=exc.status_code,
                headers=headers,
            )
        except Exception:  # noqa: BLE001 -- stable legacy boundary never exposes database/input details
            return JSONResponse(
                {"code": 50001, "message": "资金未确认，请查询原UUID回执"}, status_code=500, headers=headers
            )

    @app.get("/api/v{version}/broker-accounts/{accountId}/cash")
    async def account_cash(request: Request, version: int, accountId: str):
        return await respond(request, version, accountId)

    @app.get("/api/v{version}/broker-accounts/{accountId}/cash/entries")
    async def account_entries(request: Request, version: int, accountId: str):
        return await respond(request, version, accountId, history=True)
