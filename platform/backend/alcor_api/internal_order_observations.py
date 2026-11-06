"""Explicit intent observations and confirmed, separately identified ledger fills.

No network reads, scheduler or broker transmission occurs here. A real owner
statement can record an actual fill without inventing a historical quote;
simulation execution requires a fresh licensed original point and explicit fees.
"""

import hashlib
import json
import secrets
from dataclasses import asdict
from datetime import UTC, datetime
from decimal import Decimal, localcontext
from uuid import NAMESPACE_URL, UUID, uuid5
from zoneinfo import ZoneInfo

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from psycopg.types.json import Jsonb

from .asset_request_domains import require_domain
from .fx_provider_parser import unique
from .internal_order_families import cancel_siblings_on_connection, create_children_on_connection
from .internal_orders import InternalOrders, fingerprint, order_dto
from .legacy_flat_orders import TransactionDB, order_identity
from .legacy_identity import envelope
from .legacy_trading_snapshot import command_snapshot, snapshot_in_transaction
from .market_alert_reader import SharedQuotes
from .price_alert_quotes import Quote, admissible, session_context
from .profile_http import bounded_body
from .security import digest
from .trading import Trading, normalize

ZONES = {
    "US": "America/New_York",
    "HK": "Asia/Hong_Kong",
    "CN": "Asia/Shanghai",
    "JP": "Asia/Tokyo",
    "KR": "Asia/Seoul",
    "SG": "Asia/Singapore",
    "UK": "Europe/London",
}


def encoded(value):
    return json.loads(
        json.dumps(value, default=lambda item: item.isoformat() if isinstance(item, datetime) else str(item))
    )



def condition_matches(order_type, side, price, trigger_price, observed):
    """Original orders.shouldFill fixed thresholds; rebound is not a trailing watermark."""
    price, observed = Decimal(str(price)), Decimal(str(observed))
    threshold = price if trigger_price is None else Decimal(str(trigger_price))
    if order_type == "limit":
        return observed <= price if side == "buy" else observed >= price
    if order_type in ("trigger_buy", "rebound_sell"):
        return observed <= threshold
    if order_type in ("trigger_sell", "rebound_buy"):
        return observed >= threshold
    return order_type == "market"

def command(raw, owner, order_id, *, legacy=False):
    required = {"requestId", "accountId", "snapshotRevision", "orderRevision", "recordRevision"}
    if (
        not isinstance(raw, dict)
        or not required <= set(raw)
        or set(raw)
        - required
        - ({"actualFill", "confirmedSimulationExecution", "simulationFees"} if not legacy else set())
    ):
        raise HTTPException(400, "观察参数无效")
    try:
        rid = str(UUID(raw["requestId"]))
        order_id = str(UUID(str(order_id)))
    except (ValueError, TypeError, AttributeError) as exc:
        raise HTTPException(400, "观察请求编号无效") from exc
    if (
        raw["accountId"] != owner
        or any(type(raw[k]) is not int or raw[k] < 1 for k in ("orderRevision", "recordRevision"))
        or not isinstance(raw["snapshotRevision"], str)
        or len(raw["snapshotRevision"]) != 64
    ):
        raise HTTPException(400, "本人账户或观察版本无效")
    if "actualFill" in raw and ("confirmedSimulationExecution" in raw or "simulationFees" in raw):
        raise HTTPException(400, "实际成交与模拟执行不可合并")
    if "confirmedSimulationExecution" in raw and raw["confirmedSimulationExecution"] is not True:
        raise HTTPException(400, "模拟执行须明确确认")
    if "simulationFees" in raw and raw.get("confirmedSimulationExecution") is not True:
        raise HTTPException(400, "模拟费用须关联显式模拟执行")
    return {**raw, "requestId": rid}, order_id


class Observations:
    def __init__(self, db, authority):
        self.db, self.authority = db, authority
        self.reader = SharedQuotes(authority) if authority else None

    async def context(self, conn, who, raw, order_id):
        row = await (
            await conn.execute(
                "SELECT * FROM internal_orders WHERE owner_id=%s AND id=%s FOR UPDATE", (who.id, order_id)
            )
        ).fetchone()
        if not row:
            raise HTTPException(404, "内部委托不存在")
        if row["status"] != "pending" or row["revision"] != raw["orderRevision"]:
            raise HTTPException(409, "委托状态或版本已变化")
        context = await (
            await conn.execute(
                "SELECT * FROM internal_order_contexts WHERE owner_id=%s AND order_id=%s AND order_revision=%s",
                (who.id, order_id, row["revision"]),
            )
        ).fetchone()
        if not context:
            raise HTTPException(409, "原委托类型、时段与有效期声明尚未核对")
        record = await (
            await conn.execute(
                "SELECT * FROM portfolio_records WHERE owner_id=%s AND id=%s AND deleted_at IS NULL",
                (who.id, row["record_id"]),
            )
        ).fetchone()
        if (
            not record
            or record["revision"] != raw["recordRevision"]
            or record["broker_account_id"] != row["account_id"]
            or (record["market"], record["code"], record["account_market"], record["source"])
            != (row["record_market"], row["record_code"], row["record_account_market"], row["record_source"])
        ):
            raise HTTPException(409, "原证券身份、账户或版本已变化")
        _,view,scoped = await command_snapshot(conn,who,raw['snapshotRevision'],record_id=row['record_id'])
        context={**context,'_projectionScoped':scoped}
        if view["snapshotRevision"] != raw["snapshotRevision"]:
            raise HTTPException(409, "账户或历史快照已变化")
        draft = context["draft"]
        rule = {
            "owner_id": who.id,
            "account_id": who.id,
            "source_identity": "platform",
            "config": {
                "market": row["record_market"],
                "code": row["record_code"],
                "extended": draft.get("session") == "EXTENDED",
                **({"sourceRevision": draft["sourceRevision"]} if draft.get("sourceRevision") else {}),
            },
            "activated_at": context["confirmed_at"],
            "last_quote_at": None,
        }
        return row, context, record, rule

    async def read_quote(self, who, raw, order_id):
        async with self.db.connection() as conn, conn.transaction():
            await InternalOrders(self.db).lock(conn, who)
            _, _, _, rule = await self.context(conn, who, raw, order_id)
        if self.reader is None:
            return None
        try:
            return await self.reader.read(rule)
        except (HTTPException, ValueError, KeyError):
            return None

    async def quote(self, conn, rule, quote, now):
        if not quote or rule["config"]["market"] not in {"US", "HK", "CN"}:
            return None
        if not admissible(quote, rule, now, self.db.settings.environment):
            return None
        try:
            version, revision, license_revision = quote.version.split(":", 2)
            _, policy = await self.authority.config(conn, rule["owner_id"], UUID(revision))
            if (version, license_revision, quote.source_id) != (
                policy.source_version,
                policy.license_revision,
                policy.source,
            ):
                return None
            session = await session_context(conn, quote)
            if not session:
                return None
            return {
                "priceExact": str(quote.amount),
                "currency": quote.currency,
                "at": quote.at.isoformat(),
                "receivedAt": quote.received.isoformat(),
                "session": quote.session,
                "cached": quote.cached,
                "witness": quote.observation_authority,
                "source": quote.source_id,
                "sourceVersion": version,
                "sourceRevision": revision,
                "licenseRevision": license_revision,
                "rawSha256": hashlib.sha256(quote.raw).hexdigest(),
                **encoded(session),
            }
        except (HTTPException, ValueError):
            return None

    async def plan(self, conn, who, raw, order_id, quote):
        row, context, record, rule = await self.context(conn, who, raw, order_id)
        now = (await (await conn.execute("SELECT clock_timestamp() AS at")).fetchone())["at"]
        draft = context["draft"]
        zone = ZoneInfo(ZONES[row["record_market"]])
        quoted = await self.quote(conn, rule, quote, now)
        family = await (
            await conn.execute(
                "SELECT * FROM internal_order_family_legs WHERE owner_id=%s AND order_id=%s",
                (who.id, order_id),
            )
        ).fetchone()
        limit_type = draft.get("orderType") == "limit"
        deadline = None
        deadline_date = None
        if draft.get("expiresAt"):
            if len(draft["expiresAt"]) == 10:
                deadline_date = datetime.fromisoformat(draft["expiresAt"]).date()
            else:
                deadline = datetime.fromisoformat(draft["expiresAt"])
        met = False
        if quoted:
            trigger = not family or (
                quote.amount >= family["trigger_price"]
                if family["trigger_above"]
                else quote.amount <= family["trigger_price"]
            )
            limit = condition_matches(draft.get("orderType"), row["side"], row["limit_price"], draft.get("triggerPrice"), quote.amount)
            met = trigger and limit
        plan = {
            "requestId": raw["requestId"],
            "orderId": order_id,
            "state": "waiting" if not quoted else "condition_not_met",
            "quote": quoted,
            "conditionMet": met,
            "brokerExecution": False,
            "executionModel": "observation_only",
            "triggerAuthority": "licensed_source_observation" if quoted else "unknown",
            "fill": None,
            "dependencies": {
                "snapshotRevision": raw["snapshotRevision"],
                "orderRevision": row["revision"],
                "recordRevision": record["revision"],
            },
        }
        if raw.get("actualFill") is not None:
            if row["account_kind"] != "real":
                raise HTTPException(409, "实际成交声明仅对应真实账户，模拟须显式模拟执行")
            if (
                not isinstance(raw["actualFill"], dict)
                or raw["actualFill"].get("confirmedActualFill") is not True
                or "fees" not in raw["actualFill"]
                or "occurredAt" not in raw["actualFill"]
            ):
                raise HTTPException(400, "须明确实际成交时间及已实付费用")
            fill = normalize(
                {
                    **raw["actualFill"],
                    "requestId": str(
                        uuid5(
                            NAMESPACE_URL,
                            "alcor.order-observation:" + who.id + ":" + raw["requestId"] + ":actual",
                        )
                    ),
                }
            )
            if (
                fill["recordId"],
                fill["recordRevision"],
                fill["side"],
                Decimal(fill["quantity"]),
                fill["currency"],
            ) != (row["record_id"], record["revision"], row["side"], row["quantity"], row["currency"]):
                raise HTTPException(409, "实际成交与原委托证券、方向、数量或币种不符")
            when = datetime.fromisoformat(fill["occurredAt"])
            if (deadline is not None and when > deadline) or (deadline_date is not None and when.astimezone(zone).date() > deadline_date):
                raise HTTPException(409, "实际成交晚于原委托明确到期时间")
            if when < row["created_at"] or when > now:
                raise HTTPException(409, "实际成交时间须对应原委托登记之后的已发生事实")
            if (
                draft.get("tif") == "day"
                and when.astimezone(zone).date() != context["confirmed_at"].astimezone(zone).date()
            ):
                raise HTTPException(409, "实际成交不在原委托声明的当地有效日")
            if limit_type and (
                Decimal(fill["price"]) > row["limit_price"]
                if row["side"] == "buy"
                else Decimal(fill["price"]) < row["limit_price"]
            ):
                raise HTTPException(409, "实际成交价不符合原限价")
            if fill.get("feeInput", {}).get("source") == "rule_calculated":
                raise HTTPException(409, "估计费用不是已实付费用")
            plan.update(
                state="ready_actual_fill",
                fill=fill,
                executionModel="owner_declared_actual_fill",
                triggerAuthority="owner_declared_actual_fill",
            )
        elif (deadline is not None and now >= deadline) or (deadline_date is not None and now.astimezone(zone).date() > deadline_date):
            plan.update(state="expired", executionModel="explicit_declared_deadline_expiry")
        elif (
            draft.get("tif") == "day"
            and now.astimezone(zone).date() > context["confirmed_at"].astimezone(zone).date()
        ):
            plan.update(state="expired", executionModel="explicit_local_day_expiry")
        elif raw.get("confirmedSimulationExecution") is True:
            if row["account_kind"] != "simulated":
                raise HTTPException(409, "真实账户不能用模拟报价填充实际成交")
            if quoted and met:
                if not isinstance(raw.get("simulationFees"), str):
                    raise HTTPException(400, "请明确模拟费用，不从委托估值冒充实际费用")
                with localcontext() as precision:
                    precision.prec = 80
                    gross = row["quantity"] * quote.amount
                fill = normalize(
                    {
                        "requestId": str(
                            uuid5(
                                NAMESPACE_URL,
                                "alcor.order-observation:" + who.id + ":" + raw["requestId"] + ":simulation",
                            )
                        ),
                        "recordId": row["record_id"],
                        "recordRevision": record["revision"],
                        "side": row["side"],
                        "quantity": str(row["quantity"]),
                        "price": str(quote.amount),
                        "amount": str(gross),
                        "fees": raw["simulationFees"],
                        "currency": row["currency"],
                        "settlementCurrency": row["currency"],
                        "occurredAt": quote.at.isoformat(),
                        "confirmedActualFill": True,
                        "note": "Explicit simulated execution from licensed observed point; not a broker execution or actual paid fee.",
                    }
                )
                plan.update(
                    state="ready_simulation",
                    fill=fill,
                    executionModel="explicit_simulated_execution",
                    feeAuthority="owner_confirmed_simulation_estimate",
                )
        elif met:
            plan["state"] = (
                "needs_actual_fill" if row["account_kind"] == "real" else "needs_simulation_confirmation"
            )
        return row, context, plan

    async def preview(self, who, order_id, raw):
        raw, order_id = command(raw, who.id, order_id)
        quote = await self.read_quote(who, raw, order_id)
        async with self.db.connection() as conn, conn.transaction():
            await InternalOrders(self.db).lock(conn, who)
            _, _, plan = await self.plan(conn, who, raw, order_id, quote)
            token = secrets.token_urlsafe(32)
            meta = asdict(quote) if quote and plan["quote"] else None
            raw_quote = meta.pop("raw") if meta else None
            row = await (
                await conn.execute(
                    "INSERT INTO internal_order_observation_previews(token_hash,owner_id,session_hash,order_id,fingerprint,dependencies,plan,quote_meta,quote_raw) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING expires_at",
                    (
                        digest(token),
                        who.id,
                        who.token_hash,
                        order_id,
                        fingerprint(encoded(raw)),
                        Jsonb(plan["dependencies"]),
                        Jsonb(plan),
                        Jsonb(encoded(meta)) if meta else None,
                        raw_quote,
                    ),
                )
            ).fetchone()
            return {**self.public(plan), "preview": token, "expiresAt": row["expires_at"].isoformat()}

    @staticmethod
    def public(plan):
        result = {k: v for k, v in plan.items() if k not in {"fill", "dependencies"}}
        if plan.get("fill"):
            result["fillSummary"] = {
                key: plan["fill"][key]
                for key in (
                    "recordId",
                    "side",
                    "quantity",
                    "price",
                    "amount",
                    "fees",
                    "currency",
                    "settlementCurrency",
                    "settlementAmount",
                    "occurredAt",
                )
            }
        return result

    async def submit(self, who, order_id, raw, token=None, *, legacy=False):
        raw, order_id = command(raw, who.id, order_id, legacy=legacy)
        hashed = fingerprint(encoded({"orderId": order_id, "data": raw}))
        # Original UUID lookup is before every quote read; an unknown response
        # must not admit a new observation or a second child fill.
        async with self.db.connection() as conn, conn.transaction():
            await InternalOrders(self.db).lock(conn, who)
            prior = await (
                await conn.execute(
                    "SELECT * FROM internal_order_operations WHERE owner_id=%s AND request_id=%s",
                    (who.id, raw["requestId"]),
                )
            ).fetchone()
            if prior:
                if prior["fingerprint"] != hashed:
                    raise HTTPException(409, "原请求编号已用于其他委托操作")
                return prior["result"]
        quote = await self.read_quote(who, raw, order_id) if legacy else None
        async with self.db.connection() as conn, conn.transaction():
            await InternalOrders(self.db).lock(conn, who)
            prior = await (
                await conn.execute(
                    "SELECT * FROM internal_order_operations WHERE owner_id=%s AND request_id=%s",
                    (who.id, raw["requestId"]),
                )
            ).fetchone()
            if prior:
                if prior["fingerprint"] != hashed:
                    raise HTTPException(409, "原请求编号已用于其他委托操作")
                return prior["result"]
            await require_domain(conn, who.id, raw["requestId"], "internal_order")
            if not legacy:
                proof = await (
                    await conn.execute(
                        "SELECT * FROM internal_order_observation_previews WHERE token_hash=%s AND owner_id=%s AND session_hash=%s AND order_id=%s AND expires_at>clock_timestamp()",
                        (digest(token) if isinstance(token, str) else "", who.id, who.token_hash, order_id),
                    )
                ).fetchone()
                if not proof or proof["fingerprint"] != fingerprint(encoded(raw)):
                    raise HTTPException(409, "观察预览已过期或不属于当前请求")
                meta = proof["quote_meta"]
                if meta:
                    quote = Quote(
                        **{
                            **meta,
                            "at": datetime.fromisoformat(meta["at"]),
                            "received": datetime.fromisoformat(meta["received"]),
                            "amount": Decimal(meta["amount"]),
                            "raw": bytes(proof["quote_raw"]),
                        }
                    )
            row, context, plan = await self.plan(conn, who, raw, order_id, quote)
            if not legacy and (
                plan["dependencies"] != proof["dependencies"]
                or plan["state"] != proof["plan"]["state"]
                or plan["fill"] != proof["plan"]["fill"]
            ):
                raise HTTPException(409, "观察条件、来源时效或金融依赖已变化，请重新预览")
            child_ids = []
            children = []
            siblings = []
            trade = None
            if plan["state"] in {"ready_actual_fill", "ready_simulation", "expired"}:
                kind = {
                    "ready_actual_fill": "actual_fill",
                    "ready_simulation": "simulation",
                    "expired": "expiry",
                }[plan["state"]]
                fill = plan["fill"]
                child = fill["requestId"] if fill else None
                status = "expired" if kind == "expiry" else "filled"
                now = (await (await conn.execute("SELECT clock_timestamp() AS at")).fetchone())["at"]
                await conn.execute(
                    """INSERT INTO internal_order_completion_proofs(owner_id,request_id,order_id,before_revision,after_revision,before_snapshot,after_snapshot,kind,child_request_id,fill,quote_meta,quote_raw)
                    SELECT owner_id,%s,id,revision,revision+1,to_jsonb(o),to_jsonb(o)||jsonb_build_object('revision',revision+1,'status',%s::text,'completed_at',%s::timestamptz,'completion_request_id',%s::uuid),%s,%s,%s,%s,%s
                    FROM internal_orders o WHERE owner_id=%s AND id=%s""",
                    (
                        raw["requestId"],
                        status,
                        now,
                        raw["requestId"],
                        kind,
                        child,
                        Jsonb(fill) if fill else None,
                        Jsonb(plan["quote"]) if plan["quote"] else None,
                        quote.raw if quote and plan["quote"] else None,
                        who.id,
                        order_id,
                    ),
                )
                updated = await (
                    await conn.execute(
                        "UPDATE internal_orders SET status=%s,completed_at=%s,completion_request_id=%s WHERE owner_id=%s AND id=%s RETURNING *",
                        (status, now, raw["requestId"], who.id, order_id),
                    )
                ).fetchone()
                # Own reservation is released only under the deferred exact-fill
                # proof. Any child failure rolls this status change back.
                await conn.execute(
                    "UPDATE cash_ledger_collections SET revision=revision+1 WHERE owner_id=%s", (who.id,)
                )
                if fill:
                    trading = Trading(TransactionDB(self.db, conn))
                    preview = await trading.preview(who, fill)
                    trade = await trading.submit(who, fill, preview["preview"])
                    child_ids = [child]
                    children = await create_children_on_connection(
                        conn,
                        who,
                        updated,
                        context,
                        {
                            "quantity": fill["quantity"],
                            "price": fill["price"],
                            "tradeId": trade["tradeId"],
                            "simulation": kind == "simulation",
                        },
                        raw["requestId"],
                    )
                    siblings = await cancel_siblings_on_connection(conn, who, updated, raw["requestId"])
                row = updated
            _,after=await snapshot_in_transaction(conn,who,strict=False,scope_record_id=row['record_id'] if context.get('_projectionScoped') else None)
            selected_ids = {order_id, *[item["id"] for item in children], *[item["id"] for item in siblings]}
            old_items = [item for item in after["orders"] if item["id"] in selected_ids]
            committed = {
                key: after[key] for key in ("accountId", "snapshotRevision", "collectionRevision", "cash")
            }
            committed["position"] = next(
                (item for item in after["positions"] if item["recordId"] == row["record_id"]), None
            )
            legacy_receipt = {
                "requestId": raw["requestId"],
                "accountId": who.id,
                "kind": "observe_trade",
                "state": "completed",
                "code": 0,
                "message": "ok",
                "data": {
                    "items": old_items,
                    "snapshot": committed,
                    "observationState": plan["state"],
                    "brokerExecution": False,
                },
                "completedAt": datetime.now(UTC).isoformat(),
            }
            receipt = {
                **self.public(plan),
                "requestId": raw["requestId"],
                "parentRequestId": raw["requestId"],
                "childRequestIds": child_ids,
                "state": "completed",
                "observationState": plan["state"],
                "order": order_dto(row),
                "trade": trade,
                "children": children,
                "cancelledSiblings": siblings,
                "kind": "internal_order_observation",
                "legacyReceipt": legacy_receipt,
                "willRetryAutomatically": False,
            }
            await conn.execute(
                "INSERT INTO internal_order_operations(owner_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)",
                (who.id, raw["requestId"], hashed, Jsonb(receipt)),
            )
            await conn.execute(
                "INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'internal-order.observed',%s,%s)",
                (who.id, order_id, raw["requestId"]),
            )
            return receipt

    async def receipt(self, who, request_id):
        return await InternalOrders(self.db).receipt(who, str(request_id))


def mount_internal_order_observations(app, db, authority):
    service = Observations(db, authority)
    app.state.internal_order_observations = service

    async def payload(request):
        if request.query_params:
            raise HTTPException(400, "不支持查询参数")
        try:
            return json.loads(await bounded_body(request, 65536), object_pairs_hook=unique)
        except (ValueError, UnicodeDecodeError) as exc:
            raise HTTPException(400, "观察请求JSON无效") from exc

    @app.post("/api/trading/orders/{order_id}/observations/preview")
    async def preview(request: Request, order_id: UUID):
        return await service.preview(
            await order_identity(request, db, write=True), str(order_id), await payload(request)
        )

    @app.post("/api/trading/orders/{order_id}/observations/submissions")
    async def submit(request: Request, order_id: UUID):
        who = await order_identity(request, db, write=True)
        raw = await payload(request)
        if (
            not isinstance(raw, dict)
            or set(raw) != {"data", "preview", "confirm"}
            or raw["confirm"] is not True
        ):
            raise HTTPException(400, "请确认原观察预览")
        return await service.submit(who, str(order_id), raw["data"], raw["preview"])

    @app.get("/api/trading/orders/observations/operations/{request_id}")
    async def operation(request: Request, request_id: UUID):
        return await service.receipt(await order_identity(request, db), request_id)

    async def old_observe(request: Request, order_id: UUID):
        from .legacy_identity import assert_native_origin, native_identity
        from .native_app_auth import CLIENT

        assert_native_origin(request, db.settings)
        who, grant = await native_identity(request, db, "orders.write")
        if grant["client_id"] != CLIENT:
            raise HTTPException(401, "连接已失效，请重新连接")
        result = await service.submit(who, str(order_id), await payload(request), legacy=True)
        from fastapi import Response

        response = Response()
        value = envelope(result["legacyReceipt"], request, response)
        return JSONResponse(
            value,
            headers={
                key: value for key, value in response.headers.items() if key.lower() != "content-length"
            },
        )

    for version in (1, 2):
        app.add_api_route(
            f"/api/v{version}/account-assets/trading/orders/{{order_id}}/observations",
            old_observe,
            methods=["POST"],
            operation_id=f"legacy_order_observation_v{version}",
        )
