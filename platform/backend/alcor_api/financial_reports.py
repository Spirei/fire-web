"""Administrator report originals and metadata; uploads never attest financial truth."""

import hashlib
import json
import re
from contextlib import asynccontextmanager
from pathlib import PurePosixPath
from uuid import uuid4

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .admin_attachments import iso
from .security import lock_mutation_identity
from .shared_attachment_media import open_original, stage

KINDS = {
    ".pdf": ("original", "application/pdf", 50 * 1024 * 1024),
    ".json": ("parsed", "application/json", 10 * 1024 * 1024),
    ".csv": ("export", "text/csv", 10 * 1024 * 1024),
}


def metadata(data, filename):
    value = {}
    for field, label in (
        ("market", "市场"),
        ("exchange", "交易所"),
        ("code", "股票代码"),
        ("fiscalPeriod", "报告期"),
    ):
        raw = data.get(field, "")
        if not isinstance(raw, str):
            raise HTTPException(400, label + "格式不正确")
        clean = raw.strip().upper()
        if not re.fullmatch(r"[A-Z0-9._-]{1,40}", clean) or ".." in clean:
            raise HTTPException(400, label + "格式不正确")
        value[field] = clean
    year = data.get("fiscalYear")
    if isinstance(year, str) and re.fullmatch(r"[0-9]{4}", year):
        year = int(year)
    if type(year) is not int or not 1900 <= year <= 2200:
        raise HTTPException(400, "财年格式不正确")
    value["fiscalYear"] = year
    for key in ("companyName", "reportType"):
        raw = data.get(key, "")
        if not isinstance(raw, str) or len(raw) > 500 or any(ord(c) < 32 for c in raw):
            raise HTTPException(400, "财报字段无效")
        value[key] = raw.strip()
    name = PurePosixPath(filename.replace("\\", "/")).name
    if not name or len(name.encode("utf-8")) > 255 or any(ord(c) < 32 for c in name):
        raise HTTPException(400, "财报文件名无效")
    ext = PurePosixPath(name).suffix.lower()
    if ext not in KINDS:
        raise HTTPException(400, "仅支持 PDF、JSON、CSV 财报文件")
    value["fileName"] = name
    value["fileKind"], value["mimeType"], limit = KINDS[ext]
    return value, limit


def dto(row):
    return {
        "id": row["id"],
        "market": row["market"],
        "exchange": row["exchange"],
        "companyCode": row["company_code"],
        "companyName": row["company_name"],
        "fiscalYear": row["fiscal_year"],
        "fiscalPeriod": row["fiscal_period"],
        "reportType": row["report_type"],
        "fileKind": row["file_kind"],
        "fileName": row["file_name"],
        "fileUrl": "/api/financial-reports/" + row["id"] + "/original",
        "mimeType": row["mime_type"],
        "fileSize": row["byte_length"],
        "source": row["source"],
        "schemaVersion": "1.0",
        "createdAt": iso(row["created_at"]),
    }


class FinancialReports:
    def __init__(self, db):
        self.db = db

    @asynccontextmanager
    async def context(self, who, write=False):
        async with self.db.connection() as conn, conn.transaction():
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("identity-management:" + who.id,)
            )
            await conn.execute(
                "SELECT pg_advisory_xact_lock"
                + ("" if write else "_shared")
                + "(hashtextextended('financial-report-files',0))"
            )
            await lock_mutation_identity(conn, who, require_admin=True)
            yield conn

    async def listing(self, who, filters):
        async with self.context(who) as conn:
            rows = await (
                await conn.execute(
                    """SELECT * FROM financial_report_files WHERE deleted_at IS NULL
                AND (%s::text IS NULL OR market=%s) AND (%s::text IS NULL OR exchange=%s)
                AND (%s::text IS NULL OR company_code=%s)
                ORDER BY fiscal_year DESC,fiscal_period DESC,created_at DESC,id DESC LIMIT 1001""",
                    tuple(
                        v
                        for key in ("market", "exchange", "code")
                        for v in (filters.get(key), filters.get(key))
                    ),
                )
            ).fetchall()
            if len(rows) > 1000:
                raise HTTPException(503, "财报列表超出读取预算，请缩小筛选范围")
            revision = (await (await conn.execute("SELECT revision FROM financial_report_scope")).fetchone())[
                "revision"
            ]
            return {
                "reports": [dto(row) for row in rows],
                "revision": revision,
                "sourceCoverage": "platform-only",
                "historicalCoverageKnown": False,
            }

    async def previous(self, conn, who, request_id, fingerprint):
        old = await (
            await conn.execute(
                "SELECT * FROM financial_report_operations WHERE actor_id=%s AND request_id=%s",
                (who.id, request_id),
            )
        ).fetchone()
        if old and old["fingerprint"] != fingerprint:
            raise HTTPException(409, "原请求编号已用于其他财报操作")
        return old["result"] if old else None

    async def remember(self, conn, who, request_id, fingerprint, result, action, target):
        await conn.execute(
            "INSERT INTO financial_report_operations(actor_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)",
            (who.id, request_id, fingerprint, Jsonb(result)),
        )
        await conn.execute(
            "INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,%s,%s,%s)",
            (who.id, action, target, request_id),
        )
        return result

    async def revision(self, conn, expected):
        row = await (await conn.execute("SELECT revision FROM financial_report_scope FOR UPDATE")).fetchone()
        if type(expected) is not int or expected != row["revision"] or expected >= 9007199254740990:
            raise HTTPException(409, "财报文件列表已变化，请重新读取")
        return row["revision"] + 1

    async def upload(self, who, request_id, expected, fields, name, raw):
        value, limit = metadata(fields, name)
        if not raw or len(raw) > limit:
            raise HTTPException(400, f"文件大小不能超过 {limit // 1024 // 1024}MB")
        digest = hashlib.sha256(raw).hexdigest()
        fingerprint = hashlib.sha256(
            json.dumps(["upload", expected, value, digest], sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        async with self.context(who, True) as conn:
            old = await self.previous(conn, who, request_id, fingerprint)
            if old:
                return old
            revision = await self.revision(conn, expected)
            await stage(conn, self.db.settings, digest, raw)
            identifier = "fr-" + uuid4().hex[:20]
            snapshot = {
                "metadata": value,
                "sha256": digest,
                "byteLength": len(raw),
                "sourceVerified": False,
                "originInstance": str(self.db.settings.instance_id),
                "uploadedBy": who.id,
            }
            row = await (
                await conn.execute(
                    """INSERT INTO financial_report_files(
                id,market,exchange,company_code,company_name,fiscal_year,fiscal_period,report_type,file_kind,file_name,
                mime_type,sha256,byte_length,uploaded_by,origin_instance,source_snapshot)
                VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *""",
                    (
                        identifier,
                        value["market"],
                        value["exchange"],
                        value["code"],
                        value["companyName"],
                        value["fiscalYear"],
                        value["fiscalPeriod"],
                        value["reportType"],
                        value["fileKind"],
                        value["fileName"],
                        value["mimeType"],
                        digest,
                        len(raw),
                        who.id,
                        self.db.settings.instance_id,
                        Jsonb(snapshot),
                    ),
                )
            ).fetchone()
            await conn.execute("UPDATE financial_report_scope SET revision=%s", (revision,))
            result = {
                "requestId": str(request_id),
                "state": "completed",
                "revision": revision,
                "report": dto(row),
                "sha256": digest,
                "sourceVerified": False,
            }
            return await self.remember(
                conn, who, request_id, fingerprint, result, "financial-report.uploaded", identifier
            )

    async def delete(self, who, request_id, expected, identifier):
        fingerprint = hashlib.sha256(json.dumps(["delete", expected, identifier]).encode()).hexdigest()
        async with self.context(who, True) as conn:
            old = await self.previous(conn, who, request_id, fingerprint)
            if old:
                return old
            revision = await self.revision(conn, expected)
            row = await (
                await conn.execute(
                    "UPDATE financial_report_files SET deleted_at=clock_timestamp(),deleted_by=%s WHERE id=%s AND deleted_at IS NULL RETURNING *",
                    (who.id, identifier),
                )
            ).fetchone()
            if not row:
                raise HTTPException(404, "财报文件不存在")
            await conn.execute("UPDATE financial_report_scope SET revision=%s", (revision,))
            result = {
                "requestId": str(request_id),
                "state": "completed",
                "revision": revision,
                "deleted": True,
                "id": identifier,
            }
            return await self.remember(
                conn, who, request_id, fingerprint, result, "financial-report.deleted", identifier
            )

    async def receipt(self, who, request_id):
        async with self.context(who) as conn:
            row = await (
                await conn.execute(
                    "SELECT result FROM financial_report_operations WHERE actor_id=%s AND request_id=%s",
                    (who.id, request_id),
                )
            ).fetchone()
            if not row:
                raise HTTPException(404, "原财报操作不存在")
            return row["result"]

    async def close(self, who, request_id):
        async with self.context(who, True) as conn:
            old = await (
                await conn.execute(
                    "SELECT result FROM financial_report_operations WHERE actor_id=%s AND request_id=%s",
                    (who.id, request_id),
                )
            ).fetchone()
            if old:
                return old["result"]
            result = {"requestId": str(request_id), "state": "closed"}
            return await self.remember(
                conn,
                who,
                request_id,
                hashlib.sha256(b"closed-financial-report-request").hexdigest(),
                result,
                "financial-report.request.closed",
                str(request_id),
            )

    async def original(self, who, identifier):
        async with self.context(who) as conn:
            row = await (
                await conn.execute(
                    "SELECT * FROM financial_report_files WHERE id=%s AND deleted_at IS NULL", (identifier,)
                )
            ).fetchone()
            if not row:
                raise HTTPException(404, "财报文件不存在")
            return row, await open_original(self.db.settings, row)
