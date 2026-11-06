"""Owner record source archive, editable preview and atomic canonical confirmation."""

import hashlib
import json
from datetime import UTC, datetime
from decimal import Decimal
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .fx_provider_parser import unique
from .legacy_flat_orders import TransactionDB
from .notification_security import principal
from .portfolio_records import PortfolioRecords, normalize, record_dto
from .record_image_ocr import ImageOCR, identity, hashed_target


def encoded(value):
    return json.loads(
        json.dumps(value, default=lambda item: item.isoformat() if isinstance(item, datetime) else str(item))
    )


def hashed(value):
    return hashlib.sha256(
        json.dumps(encoded(value), sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def read_xlsx(raw):
    from .record_workbooks import record_sheet
    rows = record_sheet(raw)
    aliases = {
        "订单状态": "name",
        "代码": "code",
        "股票代码": "code",
        "市场": "market",
        "数量": "qty",
        "现价": "price",
        "成本": "cost",
        "来源": "source",
        "原编号": "id",
        "本人": "user_id",
        "备注": "note",
        "券商账户": "brokerAccountId",
        "账户市场": "accountMarket",
        "分组": "group",
    }
    return [
        {
            aliases.get(k, k): v
            for k, v in row.items()
            if len(k) > 3
            or k in aliases
            or k in {"id", "qty", "name", "code", "market", "price", "cost", "source", "note", "group"}
        }
        for row in rows
    ]


def source_rows(raw, fmt):
    if fmt == "xlsx":
        return read_xlsx(raw), []
    data = json.loads(
        raw,
        parse_float=Decimal,
        object_pairs_hook=unique,
        parse_constant=lambda value: (_ for _ in ()).throw(ValueError("nonfinite")),
    )
    not_applied = []
    if isinstance(data, list):
        return data, []
    if not isinstance(data, dict):
        raise HTTPException(400, "记录文件须为对象或数组")
    if data.get("format") == "fire-site-backup":
        domains = data.get("data")
        if not isinstance(domains, dict) or not isinstance(domains.get("records"), list):
            raise HTTPException(400, "备份记录无效")
        not_applied = [
            key for key, value in domains.items() if key != "records" and value not in (None, [], {}, "")
        ]
        return domains["records"], not_applied
    if isinstance(data.get("records"), list):
        return data["records"], [key for key, value in data.get("history", {}).items() if value]
    if isinstance(data.get("rows"), list):
        return data["rows"], []
    raise HTTPException(400, "文件中没有记录数组")


class RecordImports:
    def __init__(self, db):
        self.db = db
        self.records = PortfolioRecords(db)
        self.ocr = ImageOCR(db)

    async def upload(self, who, rid, raw, fmt, filename, target_id=None):
        try:
            rid = str(UUID(str(rid)))
        except ValueError as exc:
            raise HTTPException(400, "请求编号无效") from exc
        budget = {"image": 8 * 1024 * 1024, "json": 10 * 1024 * 1024, "xlsx": 16 * 1024 * 1024}.get(fmt)
        if not budget or not raw or len(raw) > budget:
            raise HTTPException(413, "文件为空、类型无效或超过限制")
        fingerprint = hashed([hashlib.sha256(raw).hexdigest(), fmt, target_id])
        source_id = uuid4()
        async with self.db.connection() as conn, conn.transaction():
            await self.records.lock(conn, who.id, who)
            prior = await (
                await conn.execute(
                    "SELECT * FROM record_import_sources WHERE owner_id=%s AND request_id=%s", (who.id, rid)
                )
            ).fetchone()
            if prior:
                if prior["fingerprint"] != fingerprint:
                    raise HTTPException(409, "请求编号对应不同原件或识别来源")
                return await self.operation_on_connection(conn, who, rid)
            if await (
                await conn.execute(
                    "SELECT 1 FROM portfolio_request_reservations WHERE owner_id=%s AND request_id=%s",
                    (who.id, rid),
                )
            ).fetchone():
                raise HTTPException(409, "原UUID已用于其他记录操作")
            await conn.execute(
                "INSERT INTO record_import_sources(owner_id,id,request_id,fingerprint,format,filename,raw,sha256,principal,origin_instance,target_id) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                (
                    who.id,
                    source_id,
                    rid,
                    fingerprint,
                    fmt,
                    filename[:255],
                    raw,
                    hashlib.sha256(raw).hexdigest(),
                    principal(who),
                    self.db.settings.instance_id,
                    target_id,
                ),
            )
        provider_raw = None
        try:
            if fmt == "image":
                async with self.db.connection() as conn, conn.transaction():
                    await self.records.read_lock(conn, who.id, who)
                    from .fx_reference import external_delivery_blocked

                    if await external_delivery_blocked(conn):
                        raise HTTPException(503, "恢复副本已隔离外部识别")
                recognized = await self.ocr.recognize(who, target_id, raw, request_id=rid)
                provider_raw = recognized.pop("raw", None)
                rows = recognized.pop("rows", [])
                result = {**recognized, "rows": rows, "raw": recognized.pop("text", "")}
                not_applied = []
            else:
                rows, not_applied = source_rows(raw, fmt)
                result = {"state": "parsed", "rows": encoded(rows)}
            if len(result.get("rows", [])) > 2000:
                result.update(
                    state="rejected",
                    rows=[],
                    reason="单次最多预览2000条，原件已保存，请分批导入",
                    sourceRowCount=len(rows),
                )
            result.update(
                sourceId=str(source_id),
                requestId=rid,
                format=fmt,
                sourceSha256=hashlib.sha256(raw).hexdigest(),
                notApplied=not_applied,
            )
        except HTTPException as exc:
            result = {
                "state": "unavailable" if exc.status_code == 503 else "rejected",
                "sourceId": str(source_id),
                "requestId": rid,
                "format": fmt,
                "rows": [],
                "reason": str(exc.detail),
            }
        except Exception:  # noqa: BLE001 -- Provider/raw parser diagnostics never disclose URLs or credentials.
            result = {
                "state": "unknown" if fmt == "image" else "rejected",
                "sourceId": str(source_id),
                "requestId": rid,
                "format": fmt,
                "rows": [],
                "reason": "识别或解析结果尚未确认；只读核对原UUID",
            }
        async with self.db.connection() as conn, conn.transaction():
            # Received provider bytes belong to the immutable admission even if the
            # actor or licence was revoked while the external request was in flight.
            admitted = await (await conn.execute(
                "SELECT * FROM record_import_sources WHERE owner_id=%s AND request_id=%s FOR SHARE",
                (who.id, rid),
            )).fetchone()
            instance = await (await conn.execute("SELECT instance_id FROM alcor_instance WHERE singleton")).fetchone()
            if (not admitted or admitted["id"] != source_id or admitted["fingerprint"] != fingerprint
                    or admitted["principal"] != principal(who)
                    or str(admitted["origin_instance"]) != str(self.db.settings.instance_id)
                    or not instance or str(instance["instance_id"]) != str(admitted["origin_instance"])):
                raise HTTPException(409, "原识别请求与当前实例无法核对")
            active = True
            try:
                async with conn.transaction():
                    await self.records.read_lock(conn, who.id, who)
                    if fmt == "image":
                        current_target = self.ocr.target(who, target_id)
                        bindings=result.get("attemptTargets") or {target_id:result.get("targetFingerprint")}
                        for identifier, fingerprint in bindings.items():
                            current_target=self.ocr.target(who,identifier)
                            if fingerprint and fingerprint != hashed_target(current_target):
                                raise HTTPException(403, "识别来源已变化")
            except HTTPException:
                active = False
            if not active:
                result = {"state": "retained_unavailable", "sourceId": str(source_id), "requestId": rid,
                          "format": fmt, "rows": [], "originalRetained": True,
                          "providerResponseRetained": provider_raw is not None, "willRetryAutomatically": False}
            await conn.execute(
                "INSERT INTO record_import_source_results(owner_id,source_id,request_id,result,provider_raw) VALUES(%s,%s,%s,%s,%s)",
                (who.id, source_id, rid, Jsonb(result), provider_raw),
            )
        return result

    async def operation_on_connection(self, conn, who, rid):
        row = await (
            await conn.execute(
                "SELECT result FROM record_import_operations WHERE owner_id=%s AND request_id=%s",
                (who.id, rid),
            )
        ).fetchone()
        if row:
            return row["result"]
        row = await (
            await conn.execute(
                "SELECT result FROM record_import_source_results WHERE owner_id=%s AND request_id=%s",
                (who.id, rid),
            )
        ).fetchone()
        if row:
            return row["result"]
        row = await (
            await conn.execute(
                "SELECT id,format FROM record_import_sources WHERE owner_id=%s AND request_id=%s",
                (who.id, rid),
            )
        ).fetchone()
        if not row:
            raise HTTPException(404, "记录导入回执不存在")
        return {
            "requestId": str(rid),
            "sourceId": str(row["id"]),
            "format": row["format"],
            "state": "unknown",
            "willRetryAutomatically": False,
        }

    async def operation(self, who, rid):
        async with self.db.connection() as conn, conn.transaction():
            await self.records.read_lock(conn, who.id, who)
            return await self.operation_on_connection(conn, who, rid)

    async def preview(self, who, raw, *, legacy_input=None):
        if not isinstance(raw, dict) or set(raw) - {"sourceId", "rows", "groupId", "mappings"}:
            raise HTTPException(400, "记录预览字段无效")
        async with self.db.connection() as conn, conn.transaction():
            collection = await self.records.lock(conn, who.id, who)
            source = await (
                await conn.execute(
                    "SELECT * FROM record_import_sources WHERE owner_id=%s AND id=%s",
                    (who.id, raw.get("sourceId")),
                )
            ).fetchone()
            if not source or str(source["origin_instance"]) != str(self.db.settings.instance_id):
                raise HTTPException(404, "当前实例原件不存在")
            result = await self.operation_on_connection(conn, who, source["request_id"])
            rows = raw.get("rows", result.get("rows"))
            if not isinstance(rows, list) or not 1 <= len(rows) <= 2000:
                raise HTTPException(400, "单次须有1至2000条记录")
            mappings = raw.get("mappings", {})
            group = raw.get("groupId", "")
            if not isinstance(mappings, dict):
                raise HTTPException(400, "记录映射无效")
            current = await (
                await conn.execute(
                    "SELECT * FROM portfolio_records WHERE owner_id=%s AND deleted_at IS NULL ORDER BY id LIMIT 10001",
                    (who.id,),
                )
            ).fetchall()
            if len(current) > 10000:
                raise HTTPException(409, "记录范围超出本次核对预算")
            plans = []
            seen = set()
            for index, item in enumerate(rows, 1):
                plan = {"rowIndex": index, "status": "blocked", "original": encoded(item)}
                plans.append(plan)
                try:
                    if not isinstance(item, dict):
                        raise HTTPException(400, "记录须为对象")
                    symbol, market = identity(item.get("code", ""), item.get("market", ""))
                    chosen = mappings.get(str(index), {})
                    if not isinstance(chosen, dict) or set(chosen) - {"recordId", "brokerAccountId"}:
                        raise HTTPException(400, "逐行映射无效")
                    matches = (
                        [r for r in current if r["id"] == chosen["recordId"]]
                        if chosen.get("recordId")
                        else [r for r in current if identity(r["code"], r["market"]) == (symbol, market)]
                    )
                    if len(matches) > 1:
                        raise HTTPException(409, "同证券存在多个账户，请明确recordId")
                    if item.get("user_id") not in (None, "", who.id) and not (
                        chosen.get("recordId") or chosen.get("brokerAccountId")
                    ):
                        raise HTTPException(409, "原owner不同，须显式映射本人记录或账户")
                    if chosen.get("recordId") and not matches:
                        raise HTTPException(404, "显式映射的本人记录不存在，不能改为新增")
                    old = matches[0] if matches else None
                    if old and identity(old["code"], old["market"]) != (symbol, market):
                        raise HTTPException(409, "映射记录身份不同")
                    if not symbol or not market:
                        raise HTTPException(400, "须明确股票代码和市场")
                    key = old["id"] if old else market + ":" + symbol
                    if key in seen:
                        raise HTTPException(409, "同一记录在本次导入中重复")
                    seen.add(key)
                    previous = record_dto(old) if old else {}
                    data = {
                        key: previous.get(key, "")
                        for key in ("group", "note", "brokerAccountId", "watchGroupId", "accountMarket")
                    }
                    data.update(
                        name=item.get("name") or previous.get("name") or symbol,
                        code=symbol,
                        market=market,
                        source=item.get("source") or previous.get("source") or "snapshot",
                    )
                    for field in ("qty", "price", "cost"):
                        data[field] = item[field] if field in item else previous.get(field)
                    if group:
                        data["watchGroupId"] = group
                    if chosen.get("brokerAccountId"):
                        data["brokerAccountId"] = chosen["brokerAccountId"]
                    if (
                        item.get("brokerAccountId")
                        and not chosen.get("brokerAccountId")
                        and (not old or item["brokerAccountId"] != old["broker_account_id"])
                    ):
                        raise HTTPException(409, "来源账户编号须显式映射，不能推断为当前账户")
                    normalized = normalize(data, old)
                    kind = "update" if old else "create"
                    await self.records.check(conn, who.id, kind, old, normalized)
                    plan.update(
                        status="ready",
                        action=kind,
                        recordId=old["id"] if old else None,
                        recordRevision=old["revision"] if old else None,
                        **normalized,
                        data=normalized,
                    )
                except HTTPException as exc:
                    plan["reason"] = str(exc.detail)
            if set(mappings) - {str(i) for i in range(1, len(rows) + 1)}:
                raise HTTPException(400, "映射行号超出原记录范围")
            plan = {
                "sourceId": str(source["id"]),
                "sourceSha256": source["sha256"],
                "rows": plans,
                "notApplied": result.get("notApplied", []),
                "sourceFormat": source["format"],
            }
            if legacy_input is not None:
                plan["legacyInput"] = legacy_input
            identifier = uuid4()
            expiration = await (
                await conn.execute(
                    "INSERT INTO record_import_previews(owner_id,id,source_id,collection_revision,principal,plan) VALUES(%s,%s,%s,%s,%s,%s) RETURNING expires_at",
                    (who.id, identifier, source["id"], collection, principal(who), Jsonb(plan)),
                )
            ).fetchone()
            return {
                **self.public(plan),
                "previewId": str(identifier),
                "collectionRevision": collection,
                "expiresAt": expiration["expires_at"].isoformat(),
            }

    @staticmethod
    def public(plan):
        return {
            **{k: v for k, v in plan.items() if k != "legacyInput"},
            "rows": [{k: v for k, v in row.items() if k not in {"original", "data"}} for row in plan["rows"]],
        }

    async def submit(self, who, raw):
        if (
            not isinstance(raw, dict)
            or set(raw) != {"requestId", "previewId", "confirm"}
            or raw["confirm"] is not True
        ):
            raise HTTPException(400, "请明确确认原记录预览")
        try:
            rid, preview_id = UUID(raw["requestId"]), UUID(raw["previewId"])
        except (ValueError, TypeError) as exc:
            raise HTTPException(400, "请求编号无效") from exc
        async with self.db.connection() as conn, conn.transaction():
            collection = await self.records.lock(conn, who.id, who)
            prior = await (
                await conn.execute(
                    "SELECT * FROM record_import_operations WHERE owner_id=%s AND request_id=%s",
                    (who.id, rid),
                )
            ).fetchone()
            if prior:
                if prior["fingerprint"] != hashed(raw):
                    raise HTTPException(409, "原UUID已用于不同导入")
                return prior["result"]
            if await (
                await conn.execute(
                    "SELECT 1 FROM portfolio_request_reservations WHERE owner_id=%s AND request_id=%s",
                    (who.id, rid),
                )
            ).fetchone():
                raise HTTPException(409, "原UUID已用于其他记录操作")
            preview = await (
                await conn.execute(
                    "SELECT * FROM record_import_previews WHERE owner_id=%s AND id=%s FOR UPDATE",
                    (who.id, preview_id),
                )
            ).fetchone()
            if (
                not preview
                or preview["principal"] != principal(who)
                or preview["expires_at"] <= datetime.now(UTC)
                or preview["collection_revision"] != collection
            ):
                raise HTTPException(409, "预览已过期或记录集合已变化")
            if await (
                await conn.execute(
                    "SELECT 1 FROM record_import_operations WHERE owner_id=%s AND preview_id=%s",
                    (who.id, preview_id),
                )
            ).fetchone():
                raise HTTPException(409, "预览已提交，请查询原UUID")
            plan = preview["plan"]
            if plan["notApplied"]:
                raise HTTPException(
                    409,
                    "此文件含记录以外或金融历史域，须通过各领域原件导入；未应用："
                    + ",".join(plan["notApplied"]),
                )
            if any(row["status"] != "ready" for row in plan["rows"]):
                raise HTTPException(409, "存在未核对记录，未执行任何写入")
            service = PortfolioRecords(TransactionDB(self.db, conn))
            children = []
            added = updated = 0
            for row in plan["rows"]:
                child = uuid5(
                    NAMESPACE_URL,
                    "alcor.record-import:" + who.id + ":" + str(rid) + ":" + str(row["rowIndex"]),
                )
                proof = await service.preview(
                    who.id,
                    row["action"],
                    row["data"],
                    record_id=row["recordId"] or "",
                    revision=row["recordRevision"],
                    authorization=who,
                )
                receipt = await service.confirm(who.id, proof["previewId"], str(child), authorization=who)
                children.append(str(child))
                added += row["action"] == "create"
                updated += row["action"] == "update"
                original = row["original"]
                await conn.execute(
                    "INSERT INTO record_import_links(owner_id,source_id,row_index,original_id,source_owner,target_record_id,child_request_id,source_metadata) VALUES(%s,%s,%s,%s,%s,%s,%s,%s)",
                    (
                        who.id,
                        preview["source_id"],
                        row["rowIndex"],
                        str(original.get("id")) if original.get("id") is not None else None,
                        str(original.get("user_id")) if original.get("user_id") is not None else None,
                        receipt["recordId"],
                        child,
                        Jsonb(original),
                    ),
                )
            result = {
                "requestId": str(rid),
                "parentRequestId": str(rid),
                "childRequestIds": children,
                "previewId": str(preview_id),
                "sourceId": str(preview["source_id"]),
                "state": "completed",
                "partial": False,
                "added": added,
                "updated": updated,
                "skipped": 0,
                "total": len(children),
                "notApplied": [],
            }
            await conn.execute(
                "INSERT INTO record_import_operations(owner_id,request_id,preview_id,fingerprint,result) VALUES(%s,%s,%s,%s,%s)",
                (who.id, rid, preview_id, hashed(raw), Jsonb(result)),
            )
            await conn.execute(
                "INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'portfolio.records.imported',%s,%s)",
                (who.id, str(preview["source_id"]), rid),
            )
            return result
