"""One PostgreSQL template authority for administrator edits and client discovery."""

import hashlib
import json
from copy import deepcopy
from uuid import UUID

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .mail_template_model import DEFAULTS, render_text, validate
from .security import lock_mutation_identity


async def read_templates(conn):
    row = await (
        await conn.execute("SELECT revision,templates FROM mail_template_state WHERE singleton")
    ).fetchone()
    return {
        "revision": row["revision"] if row else 0,
        "templates": row["templates"] if row else deepcopy(DEFAULTS),
    }


class MailTemplates:
    def __init__(self, db):
        self.db = db

    async def read(self, who=None):
        async with self.db.connection() as conn, conn.transaction():
            if who:
                await lock_mutation_identity(conn, who, require_admin=True)
            return await read_templates(conn)

    async def save(self, who, data):
        if (
            not isinstance(data, dict)
            or set(data) != {"requestId", "expectedRevision", "template"}
            or type(data["expectedRevision"]) is not int
            or not 0 <= data["expectedRevision"] < 9007199254740991
        ):
            raise HTTPException(422, "需要原操作编号、当前修订及模板")
        try:
            rid = str(UUID(data["requestId"]))
        except (ValueError, TypeError, AttributeError):
            raise HTTPException(422, "原操作编号无效") from None
        template = validate(data["template"])
        fingerprint = hashlib.sha256(
            json.dumps(data, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()
        ).hexdigest()
        async with self.db.connection() as conn, conn.transaction():
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("identity-management:" + who.id,)
            )
            await lock_mutation_identity(conn, who, require_admin=True)
            await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended('mail-template-state',0))")
            prior = await (
                await conn.execute(
                    "SELECT * FROM mail_template_operations WHERE actor_id=%s AND request_id=%s",
                    (who.id, rid),
                )
            ).fetchone()
            if prior:
                if prior["fingerprint"] != fingerprint:
                    raise HTTPException(409, "原操作编号已有不同内容")
                return prior["receipt"]
            current = await read_templates(conn)
            if current["revision"] != data["expectedRevision"]:
                receipt = {
                    "requestId": rid,
                    "state": "failed",
                    "status": 409,
                    "revision": current["revision"],
                    "message": "模板已变化，请重新读取",
                }
            else:
                templates = [
                    template if item["id"] == template["id"] else item for item in current["templates"]
                ]
                revision = current["revision"] + 1
                await conn.execute(
                    "INSERT INTO mail_template_state(singleton,revision,templates) VALUES(true,%s,%s) ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision,templates=excluded.templates,updated_at=clock_timestamp()",
                    (revision, Jsonb(templates)),
                )
                receipt = {
                    "requestId": rid,
                    "state": "completed",
                    "status": 200,
                    "revision": revision,
                    "template": template,
                }
                await conn.execute(
                    "INSERT INTO audit_events(actor_id,action,request_id) VALUES(%s,'mail.template.saved',%s)",
                    (who.id, rid),
                )
            await conn.execute(
                "INSERT INTO mail_template_operations(actor_id,request_id,fingerprint,receipt) VALUES(%s,%s,%s,%s)",
                (who.id, rid, fingerprint, Jsonb(receipt)),
            )
            return receipt

    async def close(self, who, rid):
        async with self.db.connection() as conn, conn.transaction():
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("identity-management:" + who.id,)
            )
            await lock_mutation_identity(conn, who, require_admin=True)
            await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended('mail-template-state',0))")
            prior = await (
                await conn.execute(
                    "SELECT receipt FROM mail_template_operations WHERE actor_id=%s AND request_id=%s",
                    (who.id, rid),
                )
            ).fetchone()
            if prior:
                return prior["receipt"]
            current = await read_templates(conn)
            receipt = {
                "requestId": str(rid),
                "state": "failed",
                "status": 409,
                "revision": current["revision"],
                "message": "未提交请求已关闭",
            }
            await conn.execute(
                "INSERT INTO mail_template_operations(actor_id,request_id,fingerprint,receipt) VALUES(%s,%s,%s,%s)",
                (who.id, rid, hashlib.sha256(b"closed-unsubmitted-request").hexdigest(), Jsonb(receipt)),
            )
            await conn.execute(
                "INSERT INTO audit_events(actor_id,action,request_id) VALUES(%s,'mail.template.request.closed',%s)",
                (who.id, rid),
            )
            return receipt

    async def receipt(self, who, rid):
        async with self.db.connection() as conn, conn.transaction():
            await lock_mutation_identity(conn, who, require_admin=True)
            row = await (
                await conn.execute(
                    "SELECT receipt FROM mail_template_operations WHERE actor_id=%s AND request_id=%s",
                    (who.id, rid),
                )
            ).fetchone()
            if not row:
                raise HTTPException(404, "原操作不存在")
            return row["receipt"]


async def render_configured(conn, template_id, values):
    templates = (await read_templates(conn))["templates"]
    template = next((item for item in templates if item["id"] == template_id), None)
    if template is None:
        raise HTTPException(503, "邮件模板不可用")
    return render_text(template, values)
