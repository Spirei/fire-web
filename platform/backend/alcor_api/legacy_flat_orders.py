"""Flat old order protocol over the single manual-fill/internal-intent authorities.

Reads never settle intents. A recorded fill is an explicit owner ledger action,
not evidence that a broker accepted or executed an instruction.
"""

import hashlib
import json
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from decimal import Decimal
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5
from zoneinfo import ZoneInfo

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from psycopg.types.json import Jsonb

from .fx_provider_parser import unique
from .internal_orders import InternalOrders
from .legacy_identity import assert_native_origin, native_identity, web_identity
from .legacy_trade_commands import correction, number
from .legacy_trade_services import LegacyRecordedTrading, LegacyTradeCorrections
from .legacy_trading_snapshot import fee_transport, scalar, snapshot_in_transaction
from .native_app_auth import CLIENT
from .profile_http import bounded_body
from .security import COOKIE, identity, lock_mutation_identity
from .trading import Trading


class TransactionDB:
    """Service composition keeps previews, CAS, mutation and old receipt atomic."""

    def __init__(self, db, conn):
        self.settings, self.conn = db.settings, conn

    @asynccontextmanager
    async def connection(self):
        yield self.conn


def input_number(value, *, zero=False):
    if isinstance(value, str) and value.strip():
        try:
            value = Decimal(value.strip())
        except Exception as exc:
            raise HTTPException(400, "订单数值无效") from exc
    return number(value, zero=zero)


def flat_correction(raw):
    """Only this server-owned adapter can admit explicit flat net settlement."""
    replacement = raw.get("replacement") if isinstance(raw, dict) else None
    explicit_net = isinstance(replacement, dict) and "settlementAmount" in replacement
    explicit_side = isinstance(replacement, dict) and "side" in replacement
    clean = {**raw, "replacement": {k: v for k, v in replacement.items() if k not in ("settlementAmount", "side")}} if explicit_net or explicit_side else raw
    parsed = correction(clean)
    if explicit_net:
        parsed["replacement"] = {**parsed["replacement"],
            "settlementAmount": input_number(replacement["settlementAmount"], zero=True),
            "settlementCurrency": "CNY"}
    if explicit_side:
        if replacement["side"] not in ("buy", "sell"):
            raise HTTPException(400, "更正方向须明确买入或卖出")
        parsed["replacement"] = {**parsed["replacement"], "side": replacement["side"]}
    return parsed


class FlatCorrections(LegacyTradeCorrections):
    allow_flat_net_settlement = True
    allow_flat_side_change = True
    parse_command = staticmethod(flat_correction)


def packed(raw):
    return json.dumps(raw, sort_keys=True, separators=(",", ":"), default=str)


def request_uuid(request, raw):
    explicit = raw.get("requestId", request.headers.get("x-alcor-request-id"))
    try:
        return str(UUID(explicit)) if explicit else str(uuid4()), explicit is not None
    except (TypeError, ValueError, AttributeError) as exc:
        raise HTTPException(400, "请求编号无效") from exc


async def order_identity(request, db, *, write=False):
    from .legacy_optional_credentials import credentials_present
    # Shared by canonical history import/export/receipts and order observations.
    # /api/orders and versioned old protocols retain their original realm.
    canonical = request.url.path.startswith("/api/trading/")
    if "authorization" in request.headers or COOKIE not in request.cookies or not canonical:
        credentials_present(request)
    if request.headers.get("authorization", "").startswith("Bearer fat_") or request.url.path.startswith(
        "/api/v2/"
    ):
        assert_native_origin(request, db.settings)
        who, grant = await native_identity(request, db, "orders.write" if write else "orders.read")
        if grant["client_id"] != CLIENT:
            raise HTTPException(401, "连接已失效，请重新连接")
        return who
    if "authorization" not in request.headers and canonical and COOKIE in request.cookies:
        return await identity(request)
    return (await web_identity(request, db, allow_platform="authorization" not in request.headers, allow_legacy_bearer=True))[0]


async def snapshot(conn, who, *, exact=False):
    await lock_mutation_identity(conn, who, require_admin=False)
    return (await snapshot_in_transaction(conn, who, strict=False, exact=exact))[1]


def select_orders(value, query, *, maximum=5000):
    scope = query.get("scope", "all")
    if scope not in ("today", "history"):
        scope = "all"
    try:
        limit = min(maximum, max(1, int(float(query.get("limit", "200") or "200"))))
    except (ValueError, OverflowError):
        limit = 200
    record = query.get("recordId", "").strip()
    today = datetime.now(ZoneInfo("Asia/Shanghai")).date()
    items = []
    for item in value["orders"]:
        if record and item["recordId"] != record:
            continue
        when = datetime.fromisoformat(item["tradedAt"]).astimezone(ZoneInfo("Asia/Shanghai")).date()
        if scope == "today" and when != today or scope == "history" and when >= today:
            continue
        items.append(item)
    return {
        "orders": items[:limit],
        "scope": scope,
        "recordId": record or None,
        "snapshotRevision": value["snapshotRevision"],
        "settledOnRead": False,
        "coverage": {
            "available": len(items),
            "returned": min(limit, len(items)),
            "truncated": len(items) > limit,
        },
    }


class FlatOrders:
    def __init__(self, db):
        self.db = db

    async def actual_dividend(self, conn, db, who, record, raw, rid, child_rid):
        from .dividend_receipts import DividendReceipts
        from .dividend_receipts import normalize as normalize_receipt
        receipt = raw.get("actualReceipt")
        if not isinstance(receipt, dict):
            raise HTTPException(409, "股息须提供actualReceipt实际总额、税费、币种、事件编号及明确到账确认，不能按数量乘价格估算")
        if receipt.get("requestId") not in (None, rid, child_rid):
            raise HTTPException(409, "实际股息凭证须使用同一原请求编号")
        if receipt.get("recordId") != record["recordId"] or receipt.get("recordRevision") != record["recordRevision"]:
            raise HTTPException(409, "实际股息凭证的本人证券或修订不一致")
        command = {**receipt, "requestId": child_rid}
        normalized = normalize_receipt(command)
        if "fees" in raw and Decimal(input_number(raw["fees"], zero=True)) != Decimal(normalized["trade"]["fees"]):
            raise HTTPException(409, "旧订单费用与实际股息税费凭证不一致")
        if "note" in raw and raw["note"] != receipt.get("note", ""):
            raise HTTPException(409, "股息原备注须与实际凭证一致")
        if "tradedAt" in raw:
            try:
                same_time = datetime.fromisoformat(raw["tradedAt"]) == datetime.fromisoformat(normalized["trade"]["occurredAt"])
            except (ValueError, TypeError):
                same_time = False
            if not same_time:
                raise HTTPException(409, "旧订单时间与实际到账凭证不一致")
        service = DividendReceipts(db)
        proof = await service.preview(who, command)
        result = await service.submit(who, command, proof["preview"])
        after = await snapshot(conn, who)
        item = next(row for row in after["orders"] if row["id"] == result["tradeId"])
        position = next((row for row in after["positions"] if row["recordId"] == record["recordId"]), None)
        return {"order": item, "position": self.position(position), "pending": False,
            "actualReceipt": {key: result[key] for key in ("eventReference", "grossAmount", "withheldTax", "processingFee", "source")},
            "legacyQuantityPriceApplied": False, "brokerExecution": False}

    async def mutate(self, who, action, order_id, raw, rid, explicit):
        fingerprint = hashlib.sha256(packed([action, order_id, raw]).encode()).hexdigest()
        async with self.db.connection() as conn, conn.transaction():
            await Trading(self.db).lock(conn, who)
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("flat-orders:" + who.id,)
            )
            prior = await (
                await conn.execute(
                    "SELECT * FROM legacy_flat_order_operations WHERE owner_id=%s AND request_id=%s",
                    (who.id, rid),
                )
            ).fetchone()
            if prior:
                if prior["fingerprint"] != fingerprint:
                    raise HTTPException(409, "请求编号已用于不同订单操作")
                return prior["result"]
            from .asset_request_domains import require_domain

            await require_domain(conn, who.id, rid, "legacy_flat_order")
            child_rid = str(uuid5(NAMESPACE_URL, "alcor.flat-order:" + who.id + ":" + rid + ":" + action))
            view = await snapshot(conn, who, exact=True)
            completed_children = [child_rid]
            note_declaration = None
            db = TransactionDB(self.db, conn)
            current = (
                next((item for item in view["orders"] if item["id"] == order_id), None) if order_id else None
            )
            if order_id and not current:
                raise HTTPException(404, "订单不存在")
            if current and "orderRevision" in raw and (type(raw["orderRevision"]) is not int or raw["orderRevision"] != current["revision"]):
                raise HTTPException(409, "原订单修订已变化，请重新读取")
            if current and "noteRevision" in raw and (type(raw["noteRevision"]) is not int or raw["noteRevision"] != current.get("noteRevision", 0)):
                raise HTTPException(409, "订单备注修订已变化，请重新读取")
            if action == "cancel" or action == "delete" and current["executionModel"] == "internal_pending":
                if current["executionModel"] != "internal_pending":
                    raise HTTPException(409, "只能撤销未成交内部委托")
                command = {
                    "requestId": child_rid,
                    "action": "cancel",
                    "orderId": order_id,
                    "orderRevision": current["revision"],
                }
                service = InternalOrders(db)
                proof = await service.preview(who, command)
                result = await service.submit(who, command, proof["preview"])
                await conn.execute(
                    """INSERT INTO internal_order_contexts(owner_id,order_id,order_revision,request_id,draft)
                    SELECT owner_id,order_id,%s,%s,draft FROM internal_order_contexts
                    WHERE owner_id=%s AND order_id=%s AND order_revision=%s""",
                    (result["order"]["revision"], child_rid, who.id, order_id, current["revision"]),
                )
                after = await snapshot(conn, who)
                output = next(item for item in after["orders"] if item["id"] == result["order"]["id"])
                if action == "delete":
                    output = {
                        "deletedId": order_id,
                        "position": self.position(
                            next(
                                (r for r in after["positions"] if r["recordId"] == current["recordId"]), None
                            )
                        ),
                    }
            elif action == "amend" and current["executionModel"] == "internal_pending":
                from .internal_order_actions import InternalOrderActions, get_context

                original = await get_context(conn, who.id, order_id, current["revision"])
                draft = original["draft"] if original else None
                if (not isinstance(draft,dict) or draft.get("orderType") not in ("limit","market","trigger_buy","trigger_sell","rebound_buy","rebound_sell")
                        or draft.get("tif") not in ("day","gtc","custom") or draft.get("session") not in ("REGULAR","EXTENDED")):
                    raise HTTPException(409,"原内部委托声明尚未核对，不能补造类型、时段或有效期")
                command = {
                    "requestId": child_rid,
                    "accountId": who.id,
                    "recordId": current["recordId"],
                    "recordRevision": current["recordRevision"],
                    "snapshotRevision": view["snapshotRevision"],
                    "orderRevision": current["revision"],
                    "side": raw.get("side"),
                    "mode": "order",
                    "orderType": raw["orderType"] if "orderType" in raw else draft["orderType"],
                    "qty": Decimal(input_number(raw.get("qty"))),
                    "price": Decimal(input_number(raw.get("price"))),
                    "fees": Decimal(input_number(raw.get("fees"), zero=True)),
                    "tif": raw["tif"] if "tif" in raw else draft["tif"],
                    "session": raw["session"] if "session" in raw else draft["session"],
                    "note": raw.get("note", current.get("note", "")),
                }
                retained_attachments=draft.get("attachmentsExact",draft.get("attachments"))
                if retained_attachments is not None:
                    if not isinstance(retained_attachments, dict):
                        raise HTTPException(409, "原附加单声明尚未核对，不能补造")
                    command["attachments"] = {
                        key: {field: Decimal(input_number(value, zero=field == "fees"))
                              if field in ("percent", "fees", "limitPrice") else value
                              for field, value in leg.items()}
                        if key in ("takeProfit", "stopLoss") and isinstance(leg, dict) else leg
                        for key, leg in retained_attachments.items()
                    }
                if "expiresAt" in raw or "expiresAt" in draft:
                    command["expiresAt"] = raw["expiresAt"] if "expiresAt" in raw else draft["expiresAt"]
                if "triggerPrice" in raw or "triggerPrice" in draft:
                    trigger = raw["triggerPrice"] if "triggerPrice" in raw else draft["triggerPrice"]
                    command["triggerPrice"] = None if trigger is None else Decimal(input_number(trigger))
                if raw.get("settlementAmount") is not None:
                    raise HTTPException(409, "内部委托不能将实际跨币结算当预估")
                service = InternalOrderActions(db)
                proof = await service.preview_native(who, command, order_id)
                result = await service.submit_native(
                    who, {**command, "previewRevision": proof["previewRevision"]}, order_id
                )
                after = await snapshot(conn, who)
                output = {
                    "order": next(
                        row for row in after["orders"] if row["id"] == result["data"]["items"][0]["id"]
                    ),
                    "position": self.position(
                        next((r for r in after["positions"] if r["recordId"] == current["recordId"]), None)
                    ),
                }
            elif action in ("amend", "delete"):
                if current["executionModel"] != "owner_recorded_fill" or current["status"] != "filled":
                    raise HTTPException(409, "此操作须选择当前有效的已记录成交；内部委托请显式撤销")
                metadata_only = False
                if action == "amend" and "note" in raw:
                    from .flat_order_notes import root_trade, valid_note
                    note = valid_note(raw["note"])
                    root = await root_trade(conn, who.id, order_id)
                    if root["record_id"] != current["recordId"]:
                        raise HTTPException(409, "备注原成交与当前证券不一致")
                    if note != current.get("note", ""):
                        previous = current.get("noteRevision", 0)
                        note_declaration = {"rootTradeId": str(root["id"]), "recordId": root["record_id"],
                            "note": note, "noteRevision": previous + 1, "priorNoteRevision": previous}
                    metadata_only = set(raw) <= {"requestId", "note", "orderRevision", "noteRevision"}
                    if not metadata_only and raw.get("side") in ("buy", "sell"):
                        same_amounts = all(Decimal(input_number(raw.get(key), zero=key == "fees")) == Decimal(str(current[key])) for key in ("qty", "price", "fees"))
                        same_net = raw.get("settlementAmount") is None or current.get("settlementAmount") is not None and Decimal(input_number(raw["settlementAmount"], zero=True)) == Decimal(str(current["settlementAmount"]))
                        same_time = "tradedAt" not in raw or datetime.fromisoformat(raw["tradedAt"]) == datetime.fromisoformat(current["tradedAt"])
                        metadata_only = same_amounts and same_net and same_time and raw["side"] == current["side"]
                if metadata_only:
                    after = await snapshot(conn, who)
                    output = {"order": next(row for row in after["orders"] if row["id"] == order_id),
                        "position": self.position(next((row for row in after["positions"] if row["recordId"] == current["recordId"]), None)),
                        "metadataOnly": True, "financialHistoryChanged": False}
                    completed_children = []
                else:
                    command = {
                        "requestId": child_rid,
                        "accountId": who.id,
                        "snapshotRevision": view["snapshotRevision"],
                        "recordId": current["recordId"],
                        "recordRevision": current["recordRevision"],
                        "action": action,
                        "orders": [{"id": order_id, "revision": current["revision"]}],
                    }
                    if action == "amend":
                        if raw.get("side") not in ("buy", "sell"):
                            raise HTTPException(400, "更正方向须明确买入或卖出")
                        command["replacement"] = {
                            "qty": Decimal(input_number(raw.get("qty"))),
                            "price": Decimal(input_number(raw.get("price"))),
                            "fees": Decimal(input_number(raw.get("fees"), zero=True)),
                            "tradedAt": raw.get("tradedAt") or current["tradedAt"],
                        }
                        if raw["side"] != current["side"]:
                            command["replacement"]["side"] = raw["side"]
                        if raw.get("settlementAmount") is not None:
                            command["replacement"]["settlementAmount"] = Decimal(input_number(raw["settlementAmount"], zero=True))
                    service = FlatCorrections(db)
                    proof = await service.preview(who, command)
                    result = await service.submit(who, command, proof["previewRevision"])
                    if result.get("state") == "failed":
                        raise HTTPException(result.get("status", 409), result.get("message", "更正未完成"))
                    after = await snapshot(conn, who)
                    position = next(
                        (row for row in after["positions"] if row["recordId"] == current["recordId"]), None
                    )
                    if action == "delete":
                        output = {"deletedId": order_id, "position": self.position(position)}
                    else:
                        replacement = next(
                            (
                                item
                                for item in after["orders"]
                                if item.get("correction", {}).get("operationId") == child_rid
                                and item["status"] == "filled"
                            ),
                            None,
                        )
                        if replacement is None:
                            raise HTTPException(409, "更正后的原单映射缺失")
                        output = {"order": replacement, "position": self.position(position)}
            else:
                record_id = raw.get("recordId")
                record = next((row for row in view["positions"] if row["recordId"] == record_id), None)
                if record is None:
                    raise HTTPException(404, "证券不存在")
                if raw.get("side") == "dividend":
                    output = await self.actual_dividend(conn, db, who, record, raw, rid, child_rid)
                else:
                    mode = raw.get("mode") or ("order" if raw.get("orderType") else "record")
                    if raw.get("fees") is None or raw.get("fees") == "":
                        raise HTTPException(409, "请明确核对实付费用；未知不能补零")
                    qty, price, fees = (
                        Decimal(input_number(raw.get(k), zero=k == "fees")) for k in ("qty", "price", "fees")
                    )
                    if mode == "order":
                        from .internal_order_actions import InternalOrderActions

                        command = {
                            "requestId": child_rid,
                            "accountId": who.id,
                            "recordId": record_id,
                            "recordRevision": record["recordRevision"],
                            "snapshotRevision": view["snapshotRevision"],
                            "side": raw.get("side"),
                            "mode": "order",
                            "orderType": raw.get("orderType") or "limit",
                            "qty": qty,
                            "price": price,
                            "fees": fees,
                            "tif": raw.get("tif") or "day",
                            "session": raw.get("session") or "REGULAR",
                            "note": raw.get("note", ""),
                        }
                        if "expiresAt" in raw:
                            command["expiresAt"] = raw["expiresAt"]
                        if "triggerPrice" in raw:
                            command["triggerPrice"] = None if raw["triggerPrice"] is None else Decimal(input_number(raw["triggerPrice"]))
                        service = InternalOrderActions(db)
                        proof = await service.preview_native(who, command)
                        result = await service.submit_native(
                            who, {**command, "previewRevision": proof["previewRevision"]}
                        )
                        after = await snapshot(conn, who)
                        item = next(
                            row for row in after["orders"] if row["id"] == result["data"]["items"][0]["id"]
                        )
                        output = {"order": item, "position": self.position(record), "pending": True}
                    elif mode == "record":
                        command = {
                            "requestId": child_rid,
                            "accountId": who.id,
                            "recordId": record_id,
                            "recordRevision": record["recordRevision"],
                            "snapshotRevision": view["snapshotRevision"],
                            "side": raw.get("side"),
                            "mode": "record",
                            "orderType": raw.get("orderType") or "limit",
                            "qty": qty,
                            "price": price,
                            "fees": fees,
                            "tif": raw.get("tif") or "day",
                            "session": raw.get("session") or "REGULAR",
                            "tradedAt": raw.get("tradedAt") or datetime.now(UTC).isoformat(),
                            "note": raw.get("note", ""),
                        }
                        if raw.get("settlementAmount") is not None:
                            command["settlementAmount"] = Decimal(input_number(raw["settlementAmount"]))
                        if "expiresAt" in raw:
                            command["expiresAt"] = raw["expiresAt"]
                        if "triggerPrice" in raw:
                            command["triggerPrice"] = None if raw["triggerPrice"] is None else Decimal(input_number(raw["triggerPrice"]))
                        service = LegacyRecordedTrading(db)
                        await service.preview(who, command)
                        result = await service.submit(who, command)
                        if result.get("state") == "failed":
                            raise HTTPException(result.get("status", 409), result.get("message", "登记未完成"))
                        old = result["legacyReceipt"]["data"]
                        output = {
                            "order": old["items"][0],
                            "position": self.position(old["snapshot"]["position"]),
                            "pending": False,
                        }
                    else:
                        raise HTTPException(400, "登记模式无效")
            if note_declaration is not None:
                from .flat_order_notes import note_projection
                output["order"] = note_projection(output["order"], note_declaration)
            output = scalar(output)
            payload = {
                "result": output,
                "requestId": rid,
                "parentRequestId": rid,
                "childRequestIds": completed_children,
                "legacyClientIdempotency": explicit,
                "brokerExecution": False,
            }
            if note_declaration is not None:
                payload["noteDeclaration"] = note_declaration
            await conn.execute(
                "INSERT INTO legacy_flat_order_operations(owner_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)",
                (who.id, rid, fingerprint, Jsonb(payload)),
            )
            return payload

    @staticmethod
    def position(item):
        if item is None:
            return {"qty": None, "cost": None}
        return {"qty": item.get("qty", item.get("quantity")), "cost": item.get("cost")}


def mount_legacy_flat_orders(app):
    db = app.state.db
    service = FlatOrders(db)
    app.state.legacy_flat_orders = service

    async def perform(request, version, action, order_id=None):
        headers = {"Cache-Control": "no-store, private", "X-Alcor-API-Version": str(version)}
        try:
            who = await order_identity(request, db, write=action != "list")
            if action == "list":
                async with db.connection() as conn, conn.transaction():
                    value = scalar(select_orders(await snapshot(conn, who), request.query_params))
            else:
                if request.query_params:
                    raise HTTPException(400, "不支持查询参数")
                if not await app.state.rate_limit(db, "flat-orders:" + who.id, 120, window_seconds=60):
                    raise HTTPException(429, "请求过于频繁")
                content = await bounded_body(request, 65536)
                raw = json.loads(content, parse_float=Decimal, object_pairs_hook=unique) if content else {}
                if not isinstance(raw, dict):
                    raise HTTPException(400, "请求须为JSON对象")
                allowed = {
                    "requestId",
                    "actualReceipt",
                    "orderRevision",
                    "noteRevision",
                    "recordId",
                    "side",
                    "qty",
                    "price",
                    "fees",
                    "settlementAmount",
                    "triggerPrice",
                    "orderType",
                    "tif",
                    "expiresAt",
                    "session",
                    "tradedAt",
                    "note",
                    "mode",
                }
                if set(raw) - allowed:
                    raise HTTPException(400, "订单字段无效")
                rid, explicit = request_uuid(request, raw)
                outcome = await service.mutate(who, action, order_id, raw, rid, explicit)
                value = outcome["result"]
                headers.update(
                    {
                        "X-Alcor-Request-Id": outcome["requestId"],
                        "X-Alcor-Client-Idempotency": "true"
                        if outcome["legacyClientIdempotency"]
                        else "false",
                    }
                )
            return JSONResponse(
                {
                    "code": 0,
                    "message": "ok",
                    "data": fee_transport(value, request.headers.get("x-alcor-trade-fees") == "details-v1"),
                },
                headers=headers,
            )
        except (ValueError, TypeError):
            return JSONResponse(
                {"code": 40002, "message": "订单请求参数无效", "data": None}, status_code=400, headers=headers
            )
        except HTTPException as exc:
            return JSONResponse(
                {
                    "code": getattr(exc, "business_code", exc.status_code * 100 + 1),
                    "message": str(exc.detail),
                    "data": None,
                },
                status_code=exc.status_code,
                headers={**headers, **(exc.headers or {})},
            )

    @app.get("/api/trading/history/operations/{request_id}")
    async def receipt(request: Request, request_id: UUID):
        who = await order_identity(request, db)
        async with db.connection() as conn, conn.transaction():
            await lock_mutation_identity(conn, who, require_admin=False)
            row = await (
                await conn.execute(
                    "SELECT result FROM legacy_flat_order_operations WHERE owner_id=%s AND request_id=%s",
                    (who.id, request_id),
                )
            ).fetchone()
            if not row:
                raise HTTPException(404, "原订单操作回执不存在")
            return row["result"]

    for version in (1, 2):

        def endpoint(action, version=version):
            async def handler(request: Request):
                return await perform(request, version, action)

            return handler

        def item_endpoint(action, version=version):
            async def handler(request: Request, order_id: str):
                return await perform(request, version, action, order_id)

            return handler

        for method, action in (("GET", "list"), ("POST", "create")):
            app.add_api_route(
                f"/api/v{version}/orders",
                endpoint(action),
                methods=[method],
                operation_id=f"legacy_orders_v{version}_{method.lower()}",
            )
        for method, action in (
            ("PUT", "amend"),
            ("DELETE", "delete"),
            *([("PATCH", "cancel")] if version == 1 else []),
        ):
            app.add_api_route(
                f"/api/v{version}/orders/{{order_id}}",
                item_endpoint(action),
                methods=[method],
                operation_id=f"legacy_order_v{version}_{method.lower()}",
            )

    from .legacy_order_export import mount_order_export
    from .legacy_order_import import mount_order_import

    mount_order_export(app, db)
    mount_order_import(app, db)
