"""Owner-scoped ledger reconciliation workbench API for Web Data Management."""

import json
import re
from copy import deepcopy
from decimal import Decimal
from uuid import UUID

from fastapi import HTTPException, Request
from psycopg.errors import UniqueViolation

from .asset_request_domains import require_domain
from .broker_accounts import serialize_brokers
from .broker_metadata import fingerprint
from .card_preferences_protocol import wire_response
from .fx_provider_parser import unique
from .ledger_events import (
    checkpoint_by_request,
    create_opening_checkpoint,
    latest_checkpoint,
    recent_ledger_events,
)
from .legacy_registered_cash import registered_book_source
from .native_ledger import (
    ITEM_LIMIT,
    MAX_REVISION,
    amount,
    cash_key,
    conflict,
    decimal_text,
    ledger_head,
    legacy_baseline,
    receipt as fetch_receipt,
    text,
)
from .native_ledger_repair import commit_ledger_snapshot, plan_baseline_repair
from .personal_ledger_archive import PRIVATE
from .profile_http import bounded_body
from .record_file_api import actor
from .security import assert_expected_account, lock_mutation_identity, lock_read_identity

ROOT = "/api/personal-data-transfer/ledger-reconcile"
BODY_LIMIT = 256 * 1024
CURRENCY_RE = re.compile(r"^[A-Z]{3}$")


def _parse_json(raw: bytes):
    try:
        value = json.loads(raw, object_pairs_hook=unique)
    except (ValueError, UnicodeError, RecursionError):
        raise HTTPException(400, "核准请求 JSON 无效") from None
    if not isinstance(value, dict):
        raise HTTPException(400, "核准请求参数无效")
    return value


def _validate_request_id(value):
    if not isinstance(value, str):
        raise HTTPException(400, "缺少有效的请求编号")
    try:
        rid = UUID(value)
    except ValueError:
        raise HTTPException(400, "请求编号格式无效") from None
    if str(rid) != value:
        raise HTTPException(400, "请求编号格式无效")
    return rid


def _validate_base_revision(value):
    if type(value) is not int or not 1 <= value < MAX_REVISION:
        raise HTTPException(400, "账本版本号无效")
    return value


def _validate_note(value):
    if value is None or value == "":
        return ""
    try:
        return text(value, 200).strip()
    except ValueError:
        raise HTTPException(400, "备注长度或字符无效") from None


def _validate_positions(items):
    if items is None:
        return []
    if not isinstance(items, list) or len(items) > ITEM_LIMIT:
        raise HTTPException(400, "持仓核准列表无效")
    seen = set()
    validated = []
    for item in items:
        if not isinstance(item, dict) or set(item) != {"recordId", "unitCost"}:
            raise HTTPException(400, "持仓核准项字段无效")
        try:
            record_id = text(item["recordId"], 200)
            unit_cost = amount(item["unitCost"], nullable=True, nonnegative=False)
        except ValueError:
            raise HTTPException(400, "持仓成本数值无效") from None
        if record_id in seen:
            raise HTTPException(400, "持仓核准项存在重复编号")
        seen.add(record_id)
        validated.append((record_id, decimal_text(unit_cost)))
    return validated


def _validate_cash(items):
    if items is None:
        return []
    if not isinstance(items, list) or len(items) > ITEM_LIMIT:
        raise HTTPException(400, "现金核准列表无效")
    seen = set()
    validated = []
    for item in items:
        if not isinstance(item, dict) or set(item) != {"currency", "balance"}:
            raise HTTPException(400, "现金核准项字段无效")
        currency = item["currency"]
        if not isinstance(currency, str) or not CURRENCY_RE.fullmatch(currency):
            raise HTTPException(400, "币种代码无效")
        try:
            balance = amount(item["balance"], nullable=True, nonnegative=False)
        except ValueError:
            raise HTTPException(400, "现金余额数值无效") from None
        if currency in seen:
            raise HTTPException(400, "现金核准项存在重复币种")
        seen.add(currency)
        validated.append((currency, decimal_text(balance)))
    return validated


async def _recent_adjustments(conn, owner_id: str):
    rows = await (await conn.execute('''
        SELECT request_id, revision, event, created_at
        FROM native_ledger_transactions
        WHERE owner_id=%s AND event->>'kind' IN ('repair_baseline', 'reconcile_adjustment')
        ORDER BY revision DESC
        LIMIT 20
    ''', (owner_id,))).fetchall()
    return [
        {
            "requestId": str(row["request_id"]),
            "revision": row["revision"],
            "kind": row["event"].get("kind"),
            "note": row["event"].get("note", ""),
            "createdAt": row["created_at"].isoformat(),
            "positionUpdates": row["event"].get("positionUpdates", []),
            "cashUpdates": row["event"].get("cashUpdates", []),
        }
        for row in rows
    ]


def _checkpoint_dto(checkpoint, archive, *, has_sealable_data: bool):
    if checkpoint is not None:
        return {
            "sealed": True,
            "checkpointVersion": checkpoint["checkpoint_version"],
            "sourceAuthority": checkpoint["source_authority"],
            "sourceSha256": checkpoint["source_sha256"],
            "createdAt": checkpoint["created_at"].isoformat(),
            "note": checkpoint["note"],
            "diskArchiveDependency": False,
            "canSeal": has_sealable_data,
        }
    return {
        "sealed": False,
        "checkpointVersion": 0,
        "sourceAuthority": None,
        "sourceSha256": archive["source_sha256"] if archive is not None else None,
        "createdAt": None,
        "note": "",
        "diskArchiveDependency": archive is not None,
        "canSeal": has_sealable_data,
    }


def mount_ledger_reconcile(app, db):
    @app.get(ROOT)
    async def read_state(request: Request):
        if request.query_params:
            raise HTTPException(400, "不接受这些查询参数")
        who = await actor(request, db, write=False)
        assert_expected_account(request, who.id)
        async with db.connection() as conn, conn.transaction():
            await serialize_brokers(conn, who.id, shared_read=True)
            await lock_read_identity(conn, who)
            head = await ledger_head(conn, who.id)
            checkpoint = await latest_checkpoint(conn, who.id)
            archive = await registered_book_source(conn, who.id) if checkpoint is None else None
            events = await recent_ledger_events(conn, who.id, limit=30)
            if not head:
                baseline, _ = await legacy_baseline(conn, db, who, lock_orders=False)
                positions = [
                    {
                        "recordId": item["recordId"], "market": item["market"],
                        "code": item["code"], "name": item["name"],
                        "brokerAccountId": item["brokerAccountId"],
                        "quantity": item["quantity"], "unitCost": item["unitCost"],
                        "legacyQuantity": item["quantity"], "legacyUnitCost": item["unitCost"],
                        "suggestedUnitCost": None, "nativeFillCount": 0,
                    }
                    for item in baseline["positions"]
                ]
                cash = [
                    {
                        "currency": item["currency"], "balance": item["balance"],
                        "legacyBalance": item["balance"], "nativeCashDelta": "0",
                        "suggestedBalance": None,
                    }
                    for item in baseline["cash"]
                    if item.get("brokerAccountId") is None
                ]
                sealable = any(row["balance"] is not None for row in cash) or any(
                    row["unitCost"] is not None for row in positions
                )
                return wire_response({
                    "ownerId": who.id, "adopted": False, "revision": 0, "updatedAt": None,
                    "positions": positions, "cash": cash,
                    "checkpoint": _checkpoint_dto(checkpoint, archive, has_sealable_data=sealable),
                    "baselineDiff": {"hasGaps": False, "positionUpdates": [], "cashUpdates": [], "warnings": []},
                    "recentAdjustments": [],
                    "events": events,
                }, PRIVATE)

            plan = await plan_baseline_repair(conn, db, who, head, strict=False)
            snapshot = head["snapshot"]
            base_positions = {item["recordId"]: item for item in plan["baseline"]["positions"]}
            suggested_pos = {item["recordId"]: item["unitCostAfter"] for item in plan["position_updates"]}
            fills_by_record = plan["fills_by_record"]
            positions = []
            for item in sorted(snapshot["positions"], key=lambda row: (row["market"], row["code"], row["recordId"])):
                rid = item["recordId"]
                base = base_positions.get(rid)
                positions.append({
                    "recordId": rid, "market": item["market"], "code": item["code"], "name": item["name"],
                    "brokerAccountId": item.get("brokerAccountId"),
                    "quantity": item.get("quantity"), "unitCost": item.get("unitCost"),
                    "legacyQuantity": base.get("quantity") if base else None,
                    "legacyUnitCost": base.get("unitCost") if base else None,
                    "suggestedUnitCost": suggested_pos.get(rid),
                    "nativeFillCount": len(fills_by_record.get(rid, [])),
                })

            base_cash = {
                item["currency"]: item.get("balance")
                for item in plan["baseline"]["cash"]
                if item.get("brokerAccountId") is None
            }
            live_cash = {
                item["currency"]: item.get("balance")
                for item in snapshot["cash"]
                if item.get("brokerAccountId") is None
            }
            suggested_cash = {item["currency"]: item["balanceAfter"] for item in plan["cash_updates"]}
            currencies = sorted(set(live_cash) | set(base_cash) | set(plan["cash_deltas"]))
            cash = []
            for currency in currencies:
                delta = plan["cash_deltas"].get(currency, Decimal(0))
                cash.append({
                    "currency": currency,
                    "balance": live_cash.get(currency),
                    "legacyBalance": base_cash.get(currency),
                    "nativeCashDelta": decimal_text(delta),
                    "suggestedBalance": suggested_cash.get(currency),
                })

            sealable = any(v is not None for v in base_cash.values()) or any(
                v is not None for v in live_cash.values()
            ) or any(row["unitCost"] is not None for row in positions)
            adjustments = await _recent_adjustments(conn, who.id)
            return wire_response({
                "ownerId": who.id, "adopted": True, "revision": head["revision"],
                "updatedAt": head["updated_at"].isoformat(),
                "positions": positions, "cash": cash,
                "checkpoint": _checkpoint_dto(checkpoint, archive, has_sealable_data=sealable),
                "baselineDiff": {
                    "hasGaps": bool(plan["position_updates"] or plan["cash_updates"]),
                    "positionUpdates": plan["position_updates"],
                    "cashUpdates": plan["cash_updates"],
                    "warnings": plan["warnings"],
                },
                "recentAdjustments": adjustments,
                "events": events,
            }, PRIVATE)

    @app.post(ROOT + "/checkpoint")
    async def seal_checkpoint(request: Request):
        if request.query_params:
            raise HTTPException(400, "不接受这些查询参数")
        who = await actor(request, db, write=True)
        assert_expected_account(request, who.id)
        if not await app.state.rate_limit(db, "ledger-reconcile:" + who.id, 60, window_seconds=60):
            raise HTTPException(429, "核准操作过于频繁，请稍后再试")
        raw = _parse_json(await bounded_body(request, BODY_LIMIT))
        if set(raw) - {"requestId", "note"} or "requestId" not in raw:
            raise HTTPException(400, "期初固化参数无效")
        request_id = _validate_request_id(raw["requestId"])
        note = _validate_note(raw.get("note"))
        try:
            async with db.connection() as conn, conn.transaction():
                await serialize_brokers(conn, who.id, shared_read=False)
                await lock_mutation_identity(conn, who, require_admin=False)
                prior = await checkpoint_by_request(conn, who.id, request_id)
                if prior is not None:
                    if prior["note"] != note:
                        conflict("原请求编号已用于不同核准内容")
                    return wire_response({
                        "ownerId": who.id,
                        "requestId": str(request_id),
                        "checkpointVersion": prior["checkpoint_version"],
                        "sourceAuthority": prior["source_authority"],
                        "sourceSha256": prior["source_sha256"],
                        "cashCurrencies": len(prior["cash_balances"]),
                        "positionCount": len(prior["position_costs"]),
                        "note": prior["note"],
                        "createdAt": prior["created_at"].isoformat(),
                    }, PRIVATE)
                await require_domain(conn, who.id, request_id, "native_ledger")
                archive = await registered_book_source(conn, who.id)
                baseline, _ = await legacy_baseline(conn, db, who, lock_orders=False)
                head = await ledger_head(conn, who.id)
                cash_balances = {
                    item["currency"]: item["balance"]
                    for item in baseline["cash"]
                    if item.get("brokerAccountId") is None and item.get("balance") is not None
                }
                if head is not None:
                    for item in head["snapshot"]["cash"]:
                        if item.get("brokerAccountId") is None and item.get("balance") is not None:
                            cash_balances.setdefault(item["currency"], item["balance"])
                position_costs = [
                    {
                        "recordId": item["recordId"], "market": item["market"],
                        "code": item["code"], "quantity": item["quantity"], "unitCost": item["unitCost"],
                    }
                    for item in baseline["positions"]
                    if item.get("unitCost") is not None
                ]
                if not cash_balances and not position_costs:
                    raise HTTPException(400, "当前没有可固化的已核实期初数据")
                authority = (
                    "sealed_legacy_registered_book_checkpoint"
                    if archive is not None else "owner_verified_opening_checkpoint"
                )
                result = await create_opening_checkpoint(
                    conn, who.id,
                    request_id=request_id,
                    source_authority=authority,
                    source_sha256=archive["source_sha256"] if archive is not None else None,
                    cash_balances=cash_balances,
                    position_costs=position_costs,
                    note=note,
                )
                await conn.execute(
                    "INSERT INTO asset_request_domains(owner_id,request_id,domain) VALUES(%s,%s,'native_ledger')",
                    (who.id, request_id),
                )
                return wire_response(result, PRIVATE)
        except UniqueViolation as exc:
            if exc.diag.constraint_name not in ("asset_request_domain", "asset_request_domains_pkey", "broker_request_domain"):
                raise
            conflict("原请求编号已用于其他金融操作")

    @app.post(ROOT + "/baseline")
    async def apply_baseline(request: Request):
        if request.query_params:
            raise HTTPException(400, "不接受这些查询参数")
        who = await actor(request, db, write=True)
        assert_expected_account(request, who.id)
        if not await app.state.rate_limit(db, "ledger-reconcile:" + who.id, 60, window_seconds=60):
            raise HTTPException(429, "核准操作过于频繁，请稍后再试")
        raw = _parse_json(await bounded_body(request, BODY_LIMIT))
        if set(raw) - {"requestId", "baseRevision", "note"} or not {"requestId", "baseRevision"} <= set(raw):
            raise HTTPException(400, "基线核准参数无效")
        request_id = _validate_request_id(raw["requestId"])
        base_revision = _validate_base_revision(raw["baseRevision"])
        note = _validate_note(raw.get("note"))
        request_hash = fingerprint({"kind": "repair_baseline", "baseRevision": base_revision, "note": note})

        try:
            async with db.connection() as conn, conn.transaction():
                await serialize_brokers(conn, who.id, shared_read=False)
                await lock_mutation_identity(conn, who, require_admin=False)
                old = await fetch_receipt(conn, who.id, request_id)
                if old:
                    if old["fingerprint"] != request_hash:
                        conflict("原请求编号已用于不同核准内容")
                    return wire_response(old["receipt"], PRIVATE)
                await require_domain(conn, who.id, request_id, "native_ledger")
                head = await ledger_head(conn, who.id)
                if not head:
                    conflict("当前账户尚未接入原生账本")
                if head["revision"] != base_revision:
                    conflict("原生账本版本已变化，请刷新后再核准")
                plan = await plan_baseline_repair(conn, db, who, head, strict=False)
                position_updates = plan["position_updates"]
                cash_updates = plan["cash_updates"]
                if not position_updates and not cash_updates:
                    raise HTTPException(400, "当前没有可自动回填的基线缺口")
                next_revision = base_revision + 1
                event = {
                    "requestId": str(request_id), "kind": "repair_baseline",
                    "baseRevision": base_revision, "note": note,
                    "positionUpdates": position_updates, "cashUpdates": cash_updates,
                }
                result = {
                    "ownerId": who.id, "requestId": str(request_id), "kind": "repair_baseline",
                    "previousRevision": base_revision, "sourceRevision": next_revision,
                    "positionUpdates": position_updates, "cashUpdates": cash_updates,
                    "warnings": plan["warnings"],
                }
                await commit_ledger_snapshot(
                    conn, who.id, next_revision, plan["repaired"], request_id, event, result,
                    expected_fingerprint=request_hash,
                )
                return wire_response(result, PRIVATE)
        except UniqueViolation as exc:
            if exc.diag.constraint_name not in ("asset_request_domain", "asset_request_domains_pkey", "broker_request_domain"):
                raise
            conflict("原请求编号已用于其他金融操作")

    @app.post(ROOT + "/adjust")
    async def adjust_values(request: Request):
        if request.query_params:
            raise HTTPException(400, "不接受这些查询参数")
        who = await actor(request, db, write=True)
        assert_expected_account(request, who.id)
        if not await app.state.rate_limit(db, "ledger-reconcile:" + who.id, 60, window_seconds=60):
            raise HTTPException(429, "核准操作过于频繁，请稍后再试")
        raw = _parse_json(await bounded_body(request, BODY_LIMIT))
        allowed = {"requestId", "baseRevision", "note", "positions", "cash"}
        if set(raw) - allowed or not {"requestId", "baseRevision"} <= set(raw):
            raise HTTPException(400, "核准请求参数无效")
        request_id = _validate_request_id(raw["requestId"])
        base_revision = _validate_base_revision(raw["baseRevision"])
        note = _validate_note(raw.get("note"))
        positions_req = _validate_positions(raw.get("positions"))
        cash_req = _validate_cash(raw.get("cash"))
        if not positions_req and not cash_req:
            raise HTTPException(400, "请至少提供一项持仓成本或原币现金核准")
        request_hash = fingerprint({
            "kind": "reconcile_adjustment", "baseRevision": base_revision, "note": note,
            "positions": positions_req, "cash": cash_req,
        })

        try:
            async with db.connection() as conn, conn.transaction():
                await serialize_brokers(conn, who.id, shared_read=False)
                await lock_mutation_identity(conn, who, require_admin=False)
                old = await fetch_receipt(conn, who.id, request_id)
                if old:
                    if old["fingerprint"] != request_hash:
                        conflict("原请求编号已用于不同核准内容")
                    return wire_response(old["receipt"], PRIVATE)
                await require_domain(conn, who.id, request_id, "native_ledger")
                head = await ledger_head(conn, who.id)
                if not head:
                    conflict("当前账户尚未接入原生账本")
                if head["revision"] != base_revision:
                    conflict("原生账本版本已变化，请刷新后再核准")

                updated = deepcopy(head["snapshot"])
                pos_by_id = {item["recordId"]: item for item in updated["positions"]}
                position_updates = []
                for record_id, new_cost in positions_req:
                    target = pos_by_id.get(record_id)
                    if target is None:
                        raise HTTPException(404, "未找到对应的原生账本持仓")
                    before_cost = target.get("unitCost")
                    if before_cost == new_cost:
                        continue
                    target["unitCost"] = new_cost
                    position_updates.append({
                        "recordId": record_id, "market": target["market"], "code": target["code"],
                        "unitCostBefore": before_cost, "unitCostAfter": new_cost,
                    })

                cash_map = {cash_key(item): item for item in updated["cash"]}
                cash_updates = []
                for currency, new_balance in cash_req:
                    key = (None, currency)
                    existing = cash_map.get(key)
                    before_balance = existing.get("balance") if existing else None
                    if before_balance == new_balance and existing is not None:
                        continue
                    cash_map[key] = {"currency": currency, "brokerAccountId": None, "balance": new_balance}
                    cash_updates.append({
                        "currency": currency, "balanceBefore": before_balance, "balanceAfter": new_balance,
                    })

                if not position_updates and not cash_updates:
                    raise HTTPException(400, "提交的数值与当前账本一致，无需变更")

                updated["cash"] = sorted(
                    cash_map.values(),
                    key=lambda row: (row.get("brokerAccountId") or "", row["currency"]),
                )
                next_revision = base_revision + 1
                event = {
                    "requestId": str(request_id), "kind": "reconcile_adjustment",
                    "baseRevision": base_revision, "note": note,
                    "positionUpdates": position_updates, "cashUpdates": cash_updates,
                }
                result = {
                    "ownerId": who.id, "requestId": str(request_id), "kind": "reconcile_adjustment",
                    "previousRevision": base_revision, "sourceRevision": next_revision,
                    "note": note,
                    "positionUpdates": position_updates, "cashUpdates": cash_updates,
                }
                await commit_ledger_snapshot(
                    conn, who.id, next_revision, updated, request_id, event, result,
                    expected_fingerprint=request_hash,
                )
                return wire_response(result, PRIVATE)
        except UniqueViolation as exc:
            if exc.diag.constraint_name not in ("asset_request_domain", "asset_request_domains_pkey", "broker_request_domain"):
                raise
            conflict("原请求编号已用于其他金融操作")
