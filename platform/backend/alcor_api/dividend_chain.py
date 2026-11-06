"""PG-only announcement revisions, history evidence and explicit actual-receipt links.

This candidate is not mounted by the production application. Source records are
supplied documents; no provider is contacted or implicitly authenticated.
"""

import hashlib
import json
import re
from datetime import UTC
from decimal import Decimal, localcontext
from uuid import uuid4
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from alcor_api.dividend_announcements import NORMALIZER_VERSION, futu_announcement
from alcor_api.dividend_entitlements import (
    CoverageVerification,
    coverage_input,
    fingerprint,
    ident,
    replay,
    text,
    timestamp,
)
from alcor_api.security import lock_mutation_identity
from alcor_api.trading import exact


def announcement_input(raw):
    fields = {
        "requestId",
        "source",
        "market",
        "code",
        "sourceEventId",
        "sourceRevision",
        "capturedAt",
        "marketTimezone",
        "dateBasis",
        "expectedPreviousRevision",
        "raw",
        "sourceBytes",
    }
    if not isinstance(raw, dict) or raw.keys() != fields or raw["source"] != "futu":
        raise ValueError("invalid source announcement")
    ident(raw["requestId"])
    if raw["market"] not in {"US", "HK", "CN"} or not re.fullmatch(r"[A-Z0-9._-]{1,40}", raw["code"]):
        raise ValueError("explicit security identity required")
    text(raw["sourceEventId"])
    text(raw["sourceRevision"])
    timestamp(raw["capturedAt"])
    if raw["expectedPreviousRevision"] is not None:
        ident(raw["expectedPreviousRevision"])
    if raw["marketTimezone"] is not None:
        text(raw["marketTimezone"], 128)
        ZoneInfo(raw["marketTimezone"])
    if raw["dateBasis"] not in {None, "source_calendar_date"}:
        raise ValueError("invalid source date contract")
    payload = raw["raw"]
    if not isinstance(payload, dict) or payload.keys() - {
        "statement",
        "pub_date",
        "ex_date",
        "record_date",
        "dividend_payable_date",
        "process",
        "fiscal_year",
    }:
        raise ValueError("unsupported raw source fields")
    for key in ("process", "fiscal_year"):
        value = payload.get(key)
        if value is not None and (
            not isinstance(value, (str, int)) or isinstance(value, bool) or len(str(value)) > 256
        ):
            raise ValueError("invalid source metadata")
    normalized = futu_announcement(payload)
    original = raw["sourceBytes"]
    if not isinstance(original, str) or not 1 <= len(original.encode()) <= 16384:
        raise ValueError("source record too large")

    def unique_fields(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise ValueError("duplicate source fields")
            value[key] = item
        return value

    if json.loads(original, object_pairs_hook=unique_fields) != payload:
        raise ValueError("raw source bytes do not match the supplied source record")
    return {**raw, "normalized": normalized, "rawPayload": original}


def announcement_view(row):
    return {
        "revision": str(row["revision"]),
        "previousRevision": str(row["previous_revision"]) if row["previous_revision"] else None,
        "version": row["version"],
        "source": row["source"],
        "sourceEventId": row["source_event_id"],
        "sourceRevision": row["source_revision"],
        "market": row["market"],
        "code": row["code"],
        "marketTimezone": row["market_timezone"],
        "dateBasis": row["date_basis"],
        "capturedAt": row["captured_at"].isoformat(),
        "rawSha256": row["raw_sha256"],
        "normalizerVersion": row["normalizer_version"],
        "announcement": row["normalized"],
        "sourceAssurance": "owner_supplied_provider_shaped_record",
        "cashReceipt": False,
    }


class DividendChain:
    def __init__(self, db, coverage_verifier=None):
        self.db = db
        # An offline server-installed verifier of BOTH announcement and history source bytes,
        # their identities/date contracts and quantity-domain completeness. Never a browser flag.
        self.coverage_verifier = coverage_verifier

    async def append(self, who, raw):
        try:
            data = announcement_input(raw)
        except (ValueError, TypeError, KeyError) as exc:
            raise HTTPException(422, "公告来源、单位、证券或日期参数无效") from exc
        async with self.db.connection() as conn, conn.transaction():
            await lock_mutation_identity(conn, who)
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("dividend-source:" + who.id,)
            )
            prior = await (
                await conn.execute(
                    "SELECT * FROM dividend_announcement_revisions WHERE owner_id=%s AND request_id=%s",
                    (who.id, data["requestId"]),
                )
            ).fetchone()
            stamp = fingerprint(raw)
            if prior:
                if prior["fingerprint"] != stamp:
                    raise HTTPException(409, "请求编号已用于不同公告修订")
                return announcement_view(prior)
            now = (await (await conn.execute("SELECT clock_timestamp() AS at")).fetchone())["at"]
            if timestamp(data["capturedAt"]) > now:
                raise HTTPException(422, "来源采集时间不能晚于当前时间")
            previous = await (
                await conn.execute(
                    "SELECT * FROM dividend_announcement_revisions WHERE owner_id=%s AND source=%s AND market=%s AND code=%s AND source_event_id=%s ORDER BY version DESC LIMIT 1",
                    (who.id, data["source"], data["market"], data["code"], data["sourceEventId"]),
                )
            ).fetchone()
            expected = str(previous["revision"]) if previous else None
            if expected != data["expectedPreviousRevision"]:
                raise HTTPException(409, "公告来源修订已变化，请核对原事件版本")
            revision = uuid4()
            row = await (
                await conn.execute(
                    """INSERT INTO dividend_announcement_revisions(
                owner_id,revision,request_id,source,market,code,source_event_id,source_revision,
                previous_revision,version,captured_at,market_timezone,date_basis,raw_payload,
                raw_sha256,normalizer_version,normalized,fingerprint)
                VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *""",
                    (
                        who.id,
                        revision,
                        data["requestId"],
                        data["source"],
                        data["market"],
                        data["code"],
                        data["sourceEventId"],
                        data["sourceRevision"],
                        previous["revision"] if previous else None,
                        previous["version"] + 1 if previous else 1,
                        timestamp(data["capturedAt"]),
                        data["marketTimezone"],
                        data["dateBasis"],
                        data["rawPayload"],
                        hashlib.sha256(data["rawPayload"].encode()).hexdigest(),
                        NORMALIZER_VERSION,
                        Jsonb(data["normalized"]),
                        stamp,
                    ),
                )
            ).fetchone()
            await conn.execute(
                "INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'dividend.announcement.revised',%s,%s)",
                (who.id, str(revision), data["requestId"]),
            )
            return announcement_view(row)

    async def capture_coverage(self, who, raw):
        try:
            data = coverage_input(raw)
        except (ValueError, TypeError, KeyError) as exc:
            raise HTTPException(422, "完整历史证据参数无效；所有数量变动范围均须明确") from exc
        async with self.db.connection() as conn, conn.transaction():
            await lock_mutation_identity(conn, who, require_admin=False)
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("dividend-coverage:" + who.id,)
            )
            old = await (
                await conn.execute(
                    "SELECT revision,fingerprint FROM dividend_history_evidence WHERE owner_id=%s AND request_id=%s",
                    (who.id, data["requestId"]),
                )
            ).fetchone()
            stamp = fingerprint(raw)
            if old:
                if old["fingerprint"] != stamp:
                    raise HTTPException(409, "请求编号已用于其他历史证据")
                return {"revision": str(old["revision"]), "sourceAssurance": "owner_confirmed"}
            record = await (
                await conn.execute(
                    """SELECT r.*,b.account_kind,b.holding_source FROM portfolio_records r JOIN broker_accounts b
                ON b.owner_id=r.owner_id AND b.id=r.broker_account_id
                WHERE r.owner_id=%s AND r.id=%s AND r.deleted_at IS NULL FOR SHARE OF r,b""",
                    (who.id, data["recordId"]),
                )
            ).fetchone()
            if not record:
                raise HTTPException(404, "证券记录或稳定账户不存在")
            if record["revision"] != data["recordRevision"]:
                raise HTTPException(409, "证券版本已变化，请重新核对历史证据")
            manifest = data["manifest"]
            if tuple(manifest[key] for key in ("ownerId", "recordId", "accountId", "market", "code")) != (
                who.id,
                record["id"],
                record["broker_account_id"],
                record["market"],
                record["code"],
            ):
                raise HTTPException(409, "原始历史证据的本人、账户或证券身份不一致")
            revision = uuid4()
            await conn.execute(
                """INSERT INTO dividend_history_evidence(
                owner_id,revision,request_id,record_id,record_revision,account_id,account_kind,market,code,
                ledger_tip_id,source_reference,document,document_sha256,input_payload,fingerprint)
                VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (
                    who.id,
                    revision,
                    data["requestId"],
                    record["id"],
                    record["revision"],
                    record["broker_account_id"],
                    record["account_kind"],
                    record["market"],
                    record["code"],
                    record["trade_tip_id"],
                    data["sourceReference"],
                    data["document"],
                    data["documentSha256"],
                    Jsonb(data),
                    stamp,
                ),
            )
            await conn.execute(
                "INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'dividend.history.evidence',%s,%s)",
                (who.id, str(revision), data["requestId"]),
            )
            return {
                "revision": str(revision),
                "sourceAssurance": "owner_confirmed",
                "documentSha256": data["documentSha256"],
            }

    async def _authorize_read(self, conn, who):
        found = await (
            await conn.execute(
                """SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
            WHERE s.token_hash=%s AND u.id=%s AND s.client_id='new-web' AND u.active
            AND s.expires_at>clock_timestamp() AND s.session_version=u.session_version""",
                (who.token_hash, who.id),
            )
        ).fetchone()
        if not found:
            raise HTTPException(401, "读取授权已变化，请重新登录")

    async def list(self, who, market, code, limit=50, before=None):
        if (
            market not in {"US", "HK", "CN"}
            or not re.fullmatch(r"[A-Z0-9._-]{1,40}", code)
            or type(limit) is not int
            or not 1 <= limit <= 100
            or before is not None
            and (type(before) is not int or before < 1)
        ):
            raise HTTPException(422, "证券或分页参数无效")
        async with self.db.connection() as conn, conn.transaction():
            await conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            await self._authorize_read(conn, who)
            rows = await (
                await conn.execute(
                    """SELECT * FROM (SELECT DISTINCT ON(source,source_event_id) * FROM dividend_announcement_revisions
                WHERE owner_id=%s AND market=%s AND code=%s ORDER BY source,source_event_id,version DESC) latest
                WHERE (%s::bigint IS NULL OR sequence<%s) ORDER BY sequence DESC LIMIT %s""",
                    (who.id, market, code, before, before, limit + 1),
                )
            ).fetchall()
            return {
                "items": [announcement_view(row) for row in rows[:limit]],
                "nextCursor": rows[limit - 1]["sequence"] if len(rows) > limit else None,
            }

    async def history(self, who, revision, limit=50, before=None):
        if (
            type(limit) is not int
            or not 1 <= limit <= 100
            or before is not None
            and (type(before) is not int or before < 1)
        ):
            raise HTTPException(422, "分页参数无效")
        async with self.db.connection() as conn, conn.transaction():
            await conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            await self._authorize_read(conn, who)
            row = await self._announcement(conn, who, revision)
            rows = await (
                await conn.execute(
                    "SELECT * FROM dividend_announcement_revisions WHERE owner_id=%s AND source=%s AND market=%s AND code=%s AND source_event_id=%s AND (%s::bigint IS NULL OR version<%s) ORDER BY version DESC LIMIT %s",
                    (
                        who.id,
                        row["source"],
                        row["market"],
                        row["code"],
                        row["source_event_id"],
                        before,
                        before,
                        limit + 1,
                    ),
                )
            ).fetchall()
            return {
                "items": [announcement_view(item) for item in reversed(rows[:limit])],
                "nextVersion": rows[limit - 1]["version"] if len(rows) > limit else None,
            }

    async def _announcement(self, conn, who, revision):
        row = await (
            await conn.execute(
                "SELECT * FROM dividend_announcement_revisions WHERE owner_id=%s AND revision=%s",
                (who.id, revision),
            )
        ).fetchone()
        if not row:
            raise HTTPException(404, "公告修订不存在")
        return row

    async def _entitlement(self, conn, who, record_id, revision, coverage_revision):
        announcement = await self._announcement(conn, who, revision)
        record = await (
            await conn.execute(
                """SELECT r.*,b.account_kind,b.holding_source FROM portfolio_records r JOIN broker_accounts b
            ON b.owner_id=r.owner_id AND b.id=r.broker_account_id
            WHERE r.owner_id=%s AND r.id=%s AND r.deleted_at IS NULL""",
                (who.id, record_id),
            )
        ).fetchone()
        if not record:
            raise HTTPException(404, "本人证券记录不存在")
        coverage = None
        if coverage_revision is not None:
            coverage = await (
                await conn.execute(
                    "SELECT * FROM dividend_history_evidence WHERE owner_id=%s AND revision=%s AND record_id=%s",
                    (who.id, coverage_revision, record_id),
                )
            ).fetchone()
            if not coverage:
                raise HTTPException(404, "本人历史证据不存在")
        rows = await (
            await conn.execute(
                "SELECT * FROM trade_ledger WHERE owner_id=%s AND record_id=%s ORDER BY before_record_revision LIMIT 10001",
                (who.id, record_id),
            )
        ).fetchall()
        verification = (
            self.coverage_verifier(coverage, announcement) if coverage and self.coverage_verifier else None
        )
        if verification is not None and not isinstance(verification, CoverageVerification):
            raise HTTPException(503, "历史来源验证器返回无效证据")
        if (
            verification
            and verification.assurance == "synthetic_verified_fixture"
            and self.db.settings.environment != "test"
        ):
            verification = None
        now = (await (await conn.execute("SELECT clock_timestamp() AS at")).fetchone())["at"]
        value = replay(announcement, record, rows, coverage, verification, now.astimezone(UTC))
        linked = await (
            await conn.execute(
                """SELECT l.receipt_request_id,l.allocated_gross,r.result FROM dividend_receipt_links l
            JOIN dividend_receipts r ON r.owner_id=l.owner_id AND r.request_id=l.receipt_request_id
            WHERE l.owner_id=%s AND l.announcement_revision=%s AND l.record_id=%s ORDER BY l.created_at,l.request_id""",
                (who.id, revision, record_id),
            )
        ).fetchall()
        with localcontext() as context:
            context.prec = 128
            total = sum((row["allocated_gross"] for row in linked), start=Decimal(0))
        expected = Decimal(value["expectedGross"]) if value["expectedGross"] is not None else None
        reconciliation = (
            "not_linked"
            if not linked
            else "gross_matched"
            if expected == total
            else "partially_linked"
            if expected is not None and total < expected
            else "requires_review"
        )
        return {
            **value,
            "actualReceipts": [
                {
                    "requestId": str(row["receipt_request_id"]),
                    "allocatedGross": str(row["allocated_gross"]),
                    "receipt": row["result"],
                }
                for row in linked
            ],
            "reconciliationState": reconciliation,
            "actualReceiptLinking": "explicit_owner_association_only",
        }

    async def entitlement(self, who, record_id, revision, coverage_revision=None):
        async with self.db.connection() as conn, conn.transaction():
            await conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            await self._authorize_read(conn, who)
            return await self._entitlement(conn, who, record_id, revision, coverage_revision)

    async def link(self, who, raw):
        fields = {
            "requestId",
            "receiptRequestId",
            "announcementRevision",
            "recordId",
            "allocatedGross",
            "confirmedAssociation",
        }
        try:
            if not isinstance(raw, dict) or raw.keys() != fields or raw["confirmedAssociation"] is not True:
                raise ValueError()
            for name in ("requestId", "receiptRequestId", "announcementRevision"):
                ident(raw[name])
            text(raw["recordId"])
            amount = exact(raw["allocatedGross"])
            if amount <= 0:
                raise ValueError()
        except (ValueError, TypeError, KeyError) as exc:
            raise HTTPException(422, "实际凭证关联参数无效") from exc
        async with self.db.connection() as conn, conn.transaction():
            await lock_mutation_identity(conn, who, require_admin=False)
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("dividend-links:" + who.id,)
            )
            old = await (
                await conn.execute(
                    "SELECT input_payload,fingerprint FROM dividend_receipt_links WHERE owner_id=%s AND request_id=%s",
                    (who.id, raw["requestId"]),
                )
            ).fetchone()
            if old:
                if old["fingerprint"] != fingerprint(raw):
                    raise HTTPException(409, "请求编号已用于不同的实际凭证关联")
                return old["input_payload"]
            ann = await self._announcement(conn, who, raw["announcementRevision"])
            receipt = await (
                await conn.execute(
                    "SELECT * FROM dividend_receipts WHERE owner_id=%s AND request_id=%s",
                    (who.id, raw["receiptRequestId"]),
                )
            ).fetchone()
            if not receipt or receipt["record_id"] != raw["recordId"]:
                raise HTTPException(404, "本人实际到账凭证不存在")
            record = await (
                await conn.execute(
                    "SELECT market,code FROM portfolio_records WHERE owner_id=%s AND id=%s",
                    (who.id, raw["recordId"]),
                )
            ).fetchone()
            if (
                ann["market"] != record["market"]
                or ann["code"] != record["code"]
                or ann["normalized"]["currency"] != receipt["input_payload"]["trade"]["currency"]
            ):
                raise HTTPException(409, "公告证券或原币与实际凭证不一致")
            if await (
                await conn.execute(
                    "SELECT 1 FROM dividend_receipt_links WHERE owner_id=%s AND receipt_request_id=%s AND announcement_revision=%s",
                    (who.id, raw["receiptRequestId"], raw["announcementRevision"]),
                )
            ).fetchone():
                raise HTTPException(409, "该实际凭证与公告修订已关联")
            used = (
                await (
                    await conn.execute(
                        "SELECT COALESCE(sum(allocated_gross),0) AS amount FROM dividend_receipt_links WHERE owner_id=%s AND receipt_request_id=%s",
                        (who.id, raw["receiptRequestId"]),
                    )
                ).fetchone()
            )["amount"]
            with localcontext() as context:
                context.prec = 128
                excessive = used + amount > exact(receipt["input_payload"]["grossAmount"])
            if excessive:
                raise HTTPException(409, "关联总额超过该凭证实际原币总额")
            await conn.execute(
                "INSERT INTO dividend_receipt_links(owner_id,request_id,receipt_request_id,announcement_revision,record_id,allocated_gross,input_payload,fingerprint) VALUES(%s,%s,%s,%s,%s,%s,%s,%s)",
                (
                    who.id,
                    raw["requestId"],
                    raw["receiptRequestId"],
                    raw["announcementRevision"],
                    raw["recordId"],
                    amount,
                    Jsonb(raw),
                    fingerprint(raw),
                ),
            )
            await conn.execute(
                "INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'dividend.receipt.linked',%s,%s)",
                (who.id, raw["announcementRevision"], raw["requestId"]),
            )
            return raw

    async def notices(self, who, limit=50, before=None):
        if (
            type(limit) is not int
            or not 1 <= limit <= 100
            or before is not None
            and (type(before) is not int or before < 1)
        ):
            raise HTTPException(422, "分页参数无效")
        async with self.db.connection() as conn, conn.transaction():
            await conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            await self._authorize_read(conn, who)
            rows = await (
                await conn.execute(
                    "SELECT id,task_id,contents,created_at,sequence FROM dividend_review_notices WHERE owner_id=%s AND (%s::bigint IS NULL OR sequence<%s) ORDER BY sequence DESC LIMIT %s",
                    (who.id, before, before, limit + 1),
                )
            ).fetchall()
            return {
                "items": [
                    {
                        "id": str(row["id"]),
                        "taskId": str(row["task_id"]),
                        "createdAt": row["created_at"].isoformat(),
                        **row["contents"],
                    }
                    for row in rows[:limit]
                ],
                "nextCursor": rows[limit - 1]["sequence"] if len(rows) > limit else None,
            }
