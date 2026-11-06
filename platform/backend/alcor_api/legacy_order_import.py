"""Explicit uploaded workbook plans and same-authority group-atomic posting.

Missing fee, owner/account identity or historical opening facts are blockers.
No exporter row is evidence of cash completeness and no position is backfilled.
"""

import hashlib
import json
import re
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation, localcontext
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5
from zoneinfo import ZoneInfo

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse, Response
from psycopg.types.json import Jsonb
from starlette.datastructures import UploadFile

from .fx_provider_parser import unique
from .legacy_flat_orders import FlatOrders, TransactionDB, order_identity, packed, request_uuid, snapshot
from .legacy_order_workbooks import MAX_BYTES, read_sheet
from .notification_security import principal
from .profile_http import bounded_body
from .trading import MARKET_CURRENCY, Trading

MARKETS = {
    "美国": "US",
    "美股": "US",
    "香港": "HK",
    "港股": "HK",
    "中国": "CN",
    "A股": "CN",
    "日本": "JP",
    "日股": "JP",
    "韩国": "KR",
    "韩股": "KR",
    "新加坡": "SG",
    "英国": "UK",
}


def code(value):
    return re.sub(r"\.(?:US|HK|SH|SZ|SS|T|KS|SI|L)$", "", value.strip().upper())


def at(value):
    value = value.strip()
    zones = {
        " ET": "America/New_York",
        " 美东": "America/New_York",
        " 北京时间": "Asia/Shanghai",
        " 东京时间": "Asia/Tokyo",
        " 首尔时间": "Asia/Seoul",
    }
    for suffix, zone in zones.items():
        if value.endswith(suffix):
            when = datetime.fromisoformat(value[: -len(suffix)])
            if when.tzinfo is not None:
                raise ValueError("成交时间时区重复")
            first = when.replace(tzinfo=ZoneInfo(zone), fold=0)
            if first.utcoffset() != when.replace(tzinfo=ZoneInfo(zone), fold=1).utcoffset():
                raise ValueError("成交时区处于重叠或跳时，须明确UTC偏移")
            return first.astimezone(UTC).isoformat()
    when = datetime.fromisoformat(value)
    if when.tzinfo is None:
        raise ValueError("成交时间缺少明确时区")
    return when.astimezone(UTC).isoformat()


def amount(value, *, positive=False):
    try:
        value = Decimal(value.replace(",", "").strip())
        if (
            not value.is_finite()
            or value < 0
            or positive
            and value <= 0
            or value > Decimal("1e12")
            or value.normalize().as_tuple().exponent < -8
        ):
            raise ValueError("金额或数量无效")
        return format(value, "f")
    except InvalidOperation as exc:
        raise ValueError("金额或数量缺失") from exc


class OrderImport:
    def __init__(self, db):
        self.db = db

    async def plan(self, conn, who, rows, mappings, view):
        if not isinstance(mappings, dict) or len(mappings) > 20000:
            raise HTTPException(400, "行归属映射无效")
        records = await (
            await conn.execute(
                "SELECT r.*,b.account_kind FROM portfolio_records r LEFT JOIN broker_accounts b ON b.owner_id=r.owner_id AND b.id=r.broker_account_id AND b.deleted_at IS NULL WHERE r.owner_id=%s AND r.deleted_at IS NULL ORDER BY r.id LIMIT 10001",
                (who.id,),
            )
        ).fetchall()
        if len(records) > 10000:
            raise HTTPException(409, "证券范围超过本次完整核对预算")
        known = {row["id"]: row for row in records}
        plans = []
        seen = {}
        order_numbers = {}
        filled = 0
        prior_links = await (
            await conn.execute(
                "SELECT content_hash FROM legacy_order_import_links WHERE owner_id=%s", (who.id,)
            )
        ).fetchall()
        prior_hashes = {row["content_hash"] for row in prior_links}
        for index, row in enumerate(rows, 1):
            result = {"rowIndex": index, "raw": row, "state": "ignored", "feesKnown": False, "recordId": None}
            plans.append(result)
            if row.get("订单状态", row.get("A")) != "已成交":
                result["reason"] = "not_filled"
                continue
            filled += 1
            market = MARKETS.get(
                row.get("市场", row.get("B", "")).strip(), row.get("市场", row.get("B", "")).strip().upper()
            )
            symbol = code(row.get("股票代码", row.get("C", "")))
            result.update(market=market, code=symbol, state="blocked")
            try:
                if not market or not symbol:
                    raise ValueError("市场或证券代码缺失")
                if re.fullmatch(r"[A-Z]+\d{6}[CP]\d+", symbol):
                    raise ValueError("期权须独立确认合约乘数和实付金额")
                direction = row.get("方向", row.get("E", ""))
                side = "buy" if "买" in direction else "sell" if "卖" in direction else None
                if not side:
                    raise ValueError("股息或未知方向须独立实际收款记录")
                mapped = mappings.get(str(index))
                if mapped is not None:
                    if not isinstance(mapped, dict) or set(mapped) != {"recordId"}:
                        raise ValueError("逐行归属映射无效")
                    record = known.get(mapped["recordId"])
                    candidates = [record] if record else []
                else:
                    candidates = [r for r in records if r["market"] == market and code(r["code"]) == symbol]
                if len(candidates) != 1:
                    raise ValueError("未找到唯一已登记证券，请明确本人账户下的recordId")
                record = candidates[0]
                if (
                    record["market"] != market
                    or code(record["code"]) != symbol
                    or not record["broker_account_id"]
                    or record["account_kind"] not in ("real", "simulated")
                ):
                    raise ValueError("证券市场、代码或稳定账户关系尚未核对")
                result["recordId"] = record["id"]
                qty = amount(row.get("成交数量", row.get("M", "")), positive=True)
                price = amount(row.get("成交均价", row.get("L", "")), positive=True)
                when = at(row.get("委托时间", row.get("K", "")))
                raw_fee = row.get("费用", row.get("手续费"))
                if raw_fee is None or raw_fee.strip() in ("", "—", "--"):
                    raise ValueError("原件缺少实付费用，不能按旧导入器默认零")
                fees = amount(raw_fee)
                with localcontext() as precision:
                    precision.prec = 80
                    gross = Decimal(qty) * Decimal(price)
                stated_amount = row.get("成交金额", row.get("N", "")).strip()
                if stated_amount and Decimal(amount(stated_amount)) != gross:
                    raise ValueError("原成交金额与数量均价不同，请使用实际结算来源核对")
                result.update(
                    quantity=qty,
                    price=price,
                    amount=amount(stated_amount) if stated_amount else None,
                    calculatedGross=str(gross),
                    fees=fees,
                    side=side,
                    tradedAt=when,
                    accountKind=record["account_kind"],
                    currency=row.get("币种", row.get("J")) or None,
                )
                native_currency=MARKET_CURRENCY.get(record["market"])
                declared_currency=row.get("币种",row.get("J","")).strip().upper()
                if not native_currency or declared_currency!=native_currency:
                    raise ValueError("原件币种缺失或与证券原币不一致，不能按当前账户补填")
                settled_currency=row.get("结算币种","").strip().upper()
                settled=row.get("实际结算净额","").strip()
                connect=record["market"]=="HK" and record["account_market"]=="CN"
                actual_settlement=None
                if connect:
                    if settled_currency!="CNY" or settled in ("","—","--"):
                        raise ValueError("港股通须提供原件明确人民币净结算额，不推导汇率")
                    actual_settlement=amount(settled,positive=True)
                    result.update(settlementCurrency="CNY",settlementAmount=actual_settlement)
                else:
                    if settled_currency not in ("","—","--",native_currency):
                        raise ValueError("实际结算币种与明确本人账户不符")
                    if settled not in ("","—","--"):
                        with localcontext() as precision:
                            precision.prec=80
                            expected=gross+Decimal(fees) if side=="buy" else gross-Decimal(fees)
                        if Decimal(amount(settled))!=expected:
                            raise ValueError("实际结算净额与原币成交和实付费用不符")
                account_label=row.get("账户归属","").strip()
                if account_label not in ("","—","--") and MARKETS.get(account_label,account_label.upper())!=(record["account_market"] or record["market"]):
                    raise ValueError("原件账户归属与明确映射的本人证券关系不一致")
                result["feesKnown"] = True
                command = {
                    "recordId": record["id"],
                    "side": side,
                    "qty": qty,
                    "price": price,
                    "fees": fees,
                    "tradedAt": when,
                    "mode": "record",
                    "note": "Uploaded historical filled order; original workbook retained.",
                }
                if actual_settlement is not None:
                    command["settlementAmount"]=actual_settlement
                content = hashlib.sha256(
                    packed([record["broker_account_id"], record["id"], when, side, qty, price]).encode()
                ).hexdigest()
                result.update(
                    contentHash=content, command=command, originalOrderNo=row.get("订单号", row.get("T", ""))
                )
                identical = next(
                    (
                        o
                        for o in view["orders"]
                        if o["recordId"] == record["id"]
                        and o["side"] == side
                        and at(o["tradedAt"]) == when
                        and Decimal(str(o["qty"])) == Decimal(qty)
                        and Decimal(str(o["price"])) == Decimal(price)
                    ),
                    None,
                )
                if identical and (
                    identical.get("fees") is None or Decimal(str(identical["fees"])) != Decimal(fees)
                ):
                    raise ValueError("相同成交的费用不同，请走原成交更正，不重复导入")
                if identical and connect and (
                    identical.get("settlementCurrency")!="CNY" or identical.get("settlementAmount") is None
                    or Decimal(str(identical["settlementAmount"]))!=Decimal(actual_settlement)
                ):
                    raise ValueError("相同成交的实际净结算未核实或不同，请走原成交更正")
                observed_terms=(fees,actual_settlement)
                if content in seen and seen[content]!=observed_terms:
                    raise ValueError("原件相同成交对应不同实付费用或净结算，不能跳过冲突")
                if content in prior_hashes or content in seen or identical:
                    result.update(state="duplicate", reason="existing_original_fill")
                    continue
                original = result["originalOrderNo"]
                if original and original in order_numbers and order_numbers[original] != content:
                    raise ValueError("同一原订单号对应不同成交内容，请核对分笔成交")
                if original:
                    order_numbers[original] = content
                seen[content]=observed_terms
                result["state"] = "ready"
            except (ValueError, TypeError, KeyError) as exc:
                result["reason"] = str(exc)
        blocked_records = {
            row["recordId"] for row in plans if row["state"] == "blocked" and row["recordId"] is not None
        }
        for row in plans:
            if row["state"] == "ready" and row["recordId"] in blocked_records:
                row.update(state="blocked", reason="同一证券组存在未核对行，整组保留原件待核对")
        unknown_keys = set(mappings) - {str(i) for i in range(1, len(rows) + 1)}
        if unknown_keys:
            raise HTTPException(400, "行映射包含原件之外的行号")
        return {
            "totalFilled": filled,
            "imported": 0,
            "skipped": sum(r["state"] in ("ignored", "blocked") for r in plans),
            "duplicated": sum(r["state"] == "duplicate" for r in plans),
            "groups": [],
            "rows": plans,
            "financialAuthority": "explicit_owner_uploaded_history",
            "cashCoverageKnown": False,
        }

    async def preview(self, who, raw, filename, mappings):
        rows = read_sheet(raw)
        if not rows:
            raise HTTPException(422, "文件中没有订单数据行")
        source_id, preview_id = uuid4(), uuid4()
        async with self.db.connection() as conn, conn.transaction():
            await Trading(self.db).lock(conn, who)
            view = await snapshot(conn, who, exact=True)
            plan = await self.plan(conn, who, rows, mappings, view)
            digest = hashlib.sha256(raw).hexdigest()
            await conn.execute(
                "INSERT INTO legacy_order_import_sources(owner_id,id,filename,sha256,raw,rows,principal,origin_instance) VALUES(%s,%s,%s,%s,%s,%s,%s,%s)",
                (
                    who.id,
                    source_id,
                    filename[:255],
                    digest,
                    raw,
                    Jsonb(rows),
                    principal(who),
                    self.db.settings.instance_id,
                ),
            )
            row = await (
                await conn.execute(
                    "INSERT INTO legacy_order_import_previews(owner_id,id,source_id,snapshot_revision,mappings,result,principal) VALUES(%s,%s,%s,%s,%s,%s,%s) RETURNING expires_at",
                    (
                        who.id,
                        preview_id,
                        source_id,
                        view["snapshotRevision"],
                        Jsonb(mappings),
                        Jsonb(plan),
                        principal(who),
                    ),
                )
            ).fetchone()
            return {
                **self.public(plan),
                "dryRun": True,
                "fileName": filename[:255],
                "previewId": str(preview_id),
                "sourceId": str(source_id),
                "sourceSha256": digest,
                "snapshotRevision": view["snapshotRevision"],
                "expiresAt": row["expires_at"].isoformat(),
            }

    @staticmethod
    def public(plan):
        return {
            **{key:value for key,value in plan.items() if key != "personalTransfer"},
            "rows": [
                {k: v for k, v in row.items() if k not in ("raw", "command", "contentHash")}
                for row in plan["rows"]
            ],
        }

    async def submit(self, who, raw):
        if (
            not isinstance(raw, dict)
            or set(raw) != {"requestId", "previewId", "confirm"}
            or raw["confirm"] is not True
        ):
            raise HTTPException(400, "请明确确认原件预览")
        try:
            rid, preview_id = str(UUID(raw["requestId"])), UUID(raw["previewId"])
        except (ValueError, TypeError, AttributeError) as exc:
            raise HTTPException(400, "请求编号无效") from exc
        fingerprint = hashlib.sha256(packed(raw).encode()).hexdigest()
        async with self.db.connection() as conn, conn.transaction():
            await Trading(self.db).lock(conn, who)
            prior = await (
                await conn.execute(
                    "SELECT * FROM legacy_order_import_operations WHERE owner_id=%s AND request_id=%s",
                    (who.id, rid),
                )
            ).fetchone()
            if prior:
                if prior["fingerprint"] != fingerprint:
                    raise HTTPException(409, "请求编号已用于其他导入")
                return prior["result"]
            from .asset_request_domains import require_domain

            await require_domain(conn, who.id, rid, "legacy_order_import")
            preview = await (
                await conn.execute(
                    "SELECT * FROM legacy_order_import_previews WHERE owner_id=%s AND id=%s FOR UPDATE",
                    (who.id, preview_id),
                )
            ).fetchone()
            if (
                not preview
                or preview["principal"] != principal(who)
                or preview["expires_at"] <= datetime.now(UTC)
            ):
                raise HTTPException(409, "导入预览已过期或不属于当前会话")
            used = await (
                await conn.execute(
                    "SELECT request_id FROM legacy_order_import_operations WHERE owner_id=%s AND preview_id=%s",
                    (who.id, preview_id),
                )
            ).fetchone()
            if used:
                raise HTTPException(409, "此预览已提交，请仅核对原请求编号")
            source = await (
                await conn.execute(
                    "SELECT * FROM legacy_order_import_sources WHERE owner_id=%s AND id=%s",
                    (who.id, preview["source_id"]),
                )
            ).fetchone()
            if str(source["origin_instance"]) != str(self.db.settings.instance_id):
                raise HTTPException(409, "原件不属于当前实例")
            original_bytes=bytes(source["raw"])
            if hashlib.sha256(original_bytes).hexdigest()!=source["sha256"]:
                raise HTTPException(409,"原订单工作簿完整性无法核对")
            parent_binding=preview["result"].get("personalTransfer")
            if parent_binding is None:
                original_rows=read_sheet(original_bytes)
            else:
                required={"ownerId","instanceId","parentRequestId","parentSourceId","childRequestId","sourceSha256"}
                if not isinstance(parent_binding,dict) or set(parent_binding)!=required:
                    raise HTTPException(409,"个人订单父来源绑定无效")
                try:
                    parent_request=UUID(parent_binding["parentRequestId"])
                    parent_source=UUID(parent_binding["parentSourceId"])
                except (ValueError,TypeError,AttributeError):
                    raise HTTPException(409,"个人订单父来源编号无效") from None
                if (parent_binding["ownerId"]!=who.id or parent_binding["instanceId"]!=str(self.db.settings.instance_id)
                        or parent_binding["sourceSha256"]!=source["sha256"]
                        or parent_binding["childRequestId"]!=rid or rid!=str(uuid5(parent_request,"orders"))):
                    raise HTTPException(409,"个人订单子请求与原父来源不一致")
                parent=await(await conn.execute('SELECT raw,sha256,origin_instance FROM personal_data_transfer_sources WHERE owner_id=%s AND id=%s AND request_id=%s',(who.id,parent_source,parent_request))).fetchone()
                if (not parent or str(parent["origin_instance"])!=str(self.db.settings.instance_id)
                        or parent["sha256"]!=source["sha256"] or bytes(parent["raw"])!=original_bytes):
                    raise HTTPException(409,"个人订单原件不属于当前父来源")
                from .personal_data_transfer import validate
                from .personal_order_projection import personal_order_rows
                try:
                    payload=json.loads(original_bytes,parse_float=Decimal,object_pairs_hook=unique,
                        parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
                    personal_data,_=validate(payload)
                    original_rows=personal_order_rows(personal_data)
                except (ValueError,UnicodeError,RecursionError):
                    raise HTTPException(409,"个人订单原JSON无法重现") from None
            if original_rows!=source["rows"]:
                raise HTTPException(409,"原订单工作簿与已存解析结果不一致")
            view = await snapshot(conn, who, exact=True)
            if view["snapshotRevision"] != preview["snapshot_revision"]:
                raise HTTPException(409, "账户或历史已变化，请重新预览原件")
            regenerated=await self.plan(conn,who,original_rows,preview["mappings"],view)
            if packed(regenerated)!=packed({key:value for key,value in preview["result"].items() if key!="personalTransfer"}):
                raise HTTPException(409,"原件预览计划无法重现，请重新核对")
            plans = preview["result"]["rows"]
            groups = {}
            imported = 0
            # A failure rolls back the entire security group, including child receipts.
            for row in plans:
                if row["state"] == "ready":
                    groups.setdefault(row["recordId"], []).append(row)
            outcomes = []
            completed_children = []
            for record_id, items in groups.items():
                items.sort(key=lambda row: (row["command"]["tradedAt"], row["rowIndex"]))
                try:
                    async with conn.transaction():
                        bridge = FlatOrders(TransactionDB(self.db, conn))
                        group_children = []
                        for row in items:
                            command = {
                                **row["command"],
                                **{key: Decimal(row["command"][key]) for key in ("qty", "price", "fees")},
                            }
                            child = str(
                                uuid5(
                                    NAMESPACE_URL,
                                    "alcor.order-import:" + who.id + ":" + rid + ":" + str(row["rowIndex"]),
                                )
                            )
                            result = await bridge.mutate(who, "create", None, command, child, True)
                            trade_id = result["result"]["order"]["id"]
                            group_children.append(child)
                            await conn.execute(
                                "INSERT INTO legacy_order_import_links(owner_id,source_id,row_index,content_hash,request_id,trade_id,original_order_no) VALUES(%s,%s,%s,%s,%s,%s,%s)",
                                (
                                    who.id,
                                    source["id"],
                                    row["rowIndex"],
                                    row["contentHash"],
                                    child,
                                    trade_id,
                                    row.get("originalOrderNo"),
                                ),
                            )
                    imported += len(items)
                    completed_children.extend(group_children)
                    outcomes.append(
                        {
                            "recordId": record_id,
                            "market": items[0]["market"],
                            "code": items[0]["code"],
                            "orderCount": len(items),
                            "action": "imported",
                            "createdRecord": False,
                        }
                    )
                except HTTPException as exc:
                    if exc.status_code in (401, 403):
                        raise
                    outcomes.append(
                        {
                            "recordId": record_id,
                            "market": items[0]["market"],
                            "code": items[0]["code"],
                            "orderCount": len(items),
                            "action": "skipped",
                            "createdRecord": False,
                            "reason": str(exc.detail),
                        }
                    )
            result = {
                **self.public(preview["result"]),
                "dryRun": False,
                "requestId": rid,
                "previewId": str(preview_id),
                "sourceId": str(source["id"]),
                "sourceSha256": source["sha256"],
                "fileName": source["filename"],
                "imported": imported,
                "skipped": preview["result"]["skipped"]
                + sum(g["orderCount"] for g in outcomes if g["action"] == "skipped"),
                "groups": outcomes,
                "state": "completed",
                "partial": any(g["action"] == "skipped" for g in outcomes)
                or any(r["state"] == "blocked" for r in plans),
                "brokerExecution": False,
                "parentRequestId": rid,
                "childRequestIds": completed_children,
            }
            await conn.execute(
                "INSERT INTO legacy_order_import_operations(owner_id,request_id,preview_id,fingerprint,result) VALUES(%s,%s,%s,%s,%s)",
                (who.id, rid, preview_id, fingerprint, Jsonb(result)),
            )
            return result

    async def receipt(self, who, rid):
        async with self.db.connection() as conn, conn.transaction():
            await Trading(self.db).lock(conn, who)
            row = await (
                await conn.execute(
                    "SELECT result FROM legacy_order_import_operations WHERE owner_id=%s AND request_id=%s",
                    (who.id, rid),
                )
            ).fetchone()
            if not row:
                raise HTTPException(404, "导入回执不存在")
            return row["result"]


def mount_order_import(app, db):
    service = OrderImport(db)
    app.state.legacy_order_import = service

    async def upload(request, who):
        if not await app.state.rate_limit(db, "order-import:" + who.id, 10, window_seconds=60):
            raise HTTPException(429, "导入过于频繁，请稍后再试")
        await bounded_body(request, MAX_BYTES + 65536)
        try:
            form = await request.form(max_files=1, max_fields=4, max_part_size=MAX_BYTES)
            if set(form) - {"file", "mappings", "previewId", "requestId"} or any(
                len(form.getlist(key)) != 1 for key in form
            ):
                raise ValueError()
            file = form.get("file")
            if not isinstance(file, UploadFile):
                raise TypeError()
            content = await file.read(MAX_BYTES + 1)
            if not content or len(content) > MAX_BYTES:
                raise HTTPException(413, "文件过大或为空，最大16MB")
            mappings = json.loads(form.get("mappings", "{}"), object_pairs_hook=unique)
            return await service.preview(who, content, file.filename or "orders.xlsx", mappings), form
        except (ValueError, TypeError) as exc:
            raise HTTPException(400, "请选择有效的xlsx文件和归属映射") from exc

    @app.post("/api/trading/history/import/preview")
    async def preview(request: Request):
        return (await upload(request, await order_identity(request, db, write=True)))[0]

    @app.post("/api/trading/history/import/submissions")
    async def submit(request: Request):
        who = await order_identity(request, db, write=True)
        raw = json.loads(await bounded_body(request, 16384), object_pairs_hook=unique)
        return await service.submit(who, raw)

    @app.get("/api/trading/history/import/operations/{request_id}")
    async def receipt(request: Request, request_id: UUID):
        return await service.receipt(await order_identity(request, db), request_id)

    @app.get("/api/trading/history/import/sources/{source_id}/original")
    async def original(request: Request, source_id: UUID):
        who = await order_identity(request, db)
        async with db.connection() as conn, conn.transaction():
            await Trading(db).lock(conn, who)
            row = await (
                await conn.execute(
                    "SELECT raw,sha256 FROM legacy_order_import_sources WHERE owner_id=%s AND id=%s",
                    (who.id, source_id),
                )
            ).fetchone()
            if not row:
                raise HTTPException(404, "原件不存在")
            content = bytes(row["raw"])
            if hashlib.sha256(content).hexdigest() != row["sha256"]:
                raise HTTPException(409, "原件完整性核对失败")
            return Response(
                content,
                media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                headers={
                    "Cache-Control": "no-store",
                    "Content-Disposition": 'attachment; filename="orders-original.xlsx"',
                    "X-Content-SHA256": row["sha256"],
                },
            )

    @app.post("/api/v1/orders/import")
    async def old_import(request: Request):
        who = await order_identity(request, db, write=True)
        if request.query_params.get("dryRun") == "1":
            return (await upload(request, who))[0]
        # A second explicit upload must match a prior plan, never silently adopt
        # today's first account or overwrite an unrelated position by its code.
        await bounded_body(request, MAX_BYTES + 65536)
        form = await request.form(max_files=1, max_fields=4, max_part_size=MAX_BYTES)
        file = form.get("file")
        if not isinstance(file, UploadFile):
            raise HTTPException(400, "请选择要导入的xlsx文件")
        content = await file.read(MAX_BYTES + 1)
        if not content or len(content) > MAX_BYTES:
            raise HTTPException(413, "文件过大或为空")
        if not await app.state.rate_limit(db, "order-import:" + who.id, 10, window_seconds=60):
            raise HTTPException(429, "导入过于频繁，请稍后再试")
        digest = hashlib.sha256(content).hexdigest()
        async with db.connection() as conn, conn.transaction():
            await Trading(db).lock(conn, who)
            prior = await (
                await conn.execute(
                    """SELECT p.id FROM legacy_order_import_previews p JOIN legacy_order_import_sources s ON s.owner_id=p.owner_id AND s.id=p.source_id WHERE p.owner_id=%s AND p.principal=%s AND s.sha256=%s AND p.expires_at>clock_timestamp() ORDER BY p.created_at DESC LIMIT 1""",
                    (who.id, principal(who), digest),
                )
            ).fetchone()
        if not prior:
            raise HTTPException(409, "请先上传同一原件dryRun=1预览并核对逐行归属与未知费用")
        raw_request = {"requestId": form.get("requestId") or request.headers.get("x-alcor-request-id")}
        rid, explicit = request_uuid(request, raw_request)
        result = await service.submit(who, {"requestId": rid, "previewId": str(prior["id"]), "confirm": True})
        return JSONResponse(
            result,
            headers={
                "Cache-Control": "no-store",
                "X-Alcor-Request-Id": rid,
                "X-Alcor-Client-Idempotency": "true" if explicit else "false",
            },
        )
