"""Owner-bound font metadata and durable operations over ResourceMedia."""

import hashlib
import json
import re
from contextlib import asynccontextmanager
from uuid import UUID

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .font_codec import LIMIT, MIME, font_name, validate_font
from .resource_media import ResourceMedia
from .security import lock_mutation_identity

PATTERN = re.compile(r"custom-[1-9][0-9]*-[a-f0-9]{64}\.(woff2?|ttf|otf)")
MAX_REVISION = 9007199254740991


def project(row):
    path = "/api/personal-fonts/" + row["id"]
    return {
        "id": row["id"],
        "name": row["name"],
        "sha256": row["sha256"],
        "size": row["byte_length"],
        "mediaType": row["media_type"],
        "contentPath": path + "/content",
        "originalPath": path + "/original",
    }


def legacy(font):
    return {key: font[key] for key in ("id", "name")}


class PersonalFonts:
    def __init__(self, db):
        self.db = db
        self.media = ResourceMedia(db.settings)

    @asynccontextmanager
    async def context(self, who, write=False):
        async with self.db.connection() as conn, conn.transaction():
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("identity-management:" + who.id,)
            )
            await lock_mutation_identity(conn, who, require_admin=False)
            row = await (
                await conn.execute("SELECT active,role,uid FROM users WHERE id=%s FOR SHARE", (who.id,))
            ).fetchone()
            if not row or not row["active"] or row["role"] != who.role:
                raise HTTPException(403, "账号权限已变化")
            if write:
                await conn.execute(
                    "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("personal-fonts:" + who.id,)
                )
            yield conn, row

    async def revision(self, conn, owner):
        row = await (
            await conn.execute("SELECT revision FROM personal_font_scopes WHERE owner_id=%s", (owner,))
        ).fetchone()
        return row["revision"] if row else 0

    async def read(self, who):
        async with self.context(who) as (conn, _):
            rows = await (
                await conn.execute(
                    "SELECT * FROM personal_fonts WHERE owner_id=%s ORDER BY created_at,id", (who.id,)
                )
            ).fetchall()
            return {
                "fonts": [project(r) for r in rows],
                "revision": await self.revision(conn, who.id),
                "maxBytes": LIMIT,
                "maxFonts": 20,
                "formats": list(MIME),
            }

    async def operation(self, who, request):
        async with self.context(who) as (conn, _):
            row = await (
                await conn.execute(
                    "SELECT result FROM personal_font_operations WHERE owner_id=%s AND request_id=%s",
                    (who.id, request),
                )
            ).fetchone()
            if not row:
                raise HTTPException(404, "尚未查到本人原字体操作")
            return row["result"]

    async def prior(self, conn, owner, request):
        if await (
            await conn.execute(
                "SELECT 1 FROM personal_font_source_operations WHERE owner_id=%s AND request_id=%s",
                (owner, request),
            )
        ).fetchone():
            raise HTTPException(409, "原UUID已用于字体来源操作，请查询原来源回执")
        return await (
            await conn.execute(
                "SELECT fingerprint,result FROM personal_font_operations WHERE owner_id=%s AND request_id=%s",
                (owner, request),
            )
        ).fetchone()

    async def save_receipt(self, conn, who, request, fingerprint, value):
        await conn.execute(
            "INSERT INTO personal_font_operations(owner_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)",
            (who.id, request, fingerprint, Jsonb(value)),
        )
        await conn.execute(
            "INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,%s,%s,%s)",
            (who.id, "personal-fonts." + value["state"], value.get("font", {}).get("id", who.id), request),
        )

    async def store(self, conn, owner, user, revision, filename, raw):
        """One quota/codec/dedup authority for direct upload and attested archived originals."""
        changed = False
        ext, name = font_name(filename)
        if not user["uid"] or not re.fullmatch(r"[1-9][0-9]*", user["uid"]):
            raise HTTPException(409, "该账号尚无可核对的数字UID，不能构造旧字体编号")
        if not raw or len(raw) > LIMIT:
            raise HTTPException(413 if len(raw) > LIMIT else 400, "字体不能超过 10 MB")
        if ext not in MIME:
            raise HTTPException(400, "请选择 WOFF2、WOFF、TTF 或 OTF 字体")
        sha = hashlib.sha256(raw).hexdigest()
        identifier = "custom-" + user["uid"] + "-" + sha + "." + ext
        existing = await (
            await conn.execute(
                "SELECT * FROM personal_fonts WHERE owner_id=%s AND id=%s", (owner, identifier)
            )
        ).fetchone()
        if existing:
            try:
                await self.media.stage(conn, owner, raw)
            except OSError:
                raise HTTPException(503, "字体原件尚未可靠落盘") from None
            result = {"font": project(existing), "deduplicated": True}
        else:
            if revision >= MAX_REVISION:
                raise HTTPException(409, "字体修订已达上限")
            count = (
                await (
                    await conn.execute("SELECT count(*) n FROM personal_fonts WHERE owner_id=%s", (owner,))
                ).fetchone()
            )["n"]
            if count >= 20:
                raise HTTPException(400, "最多上传 20 款字体")
            await validate_font(raw, ext)
            try:
                await self.media.stage(conn, owner, raw)
            except OSError:
                raise HTTPException(503, "字体原件尚未可靠落盘") from None
            row = await (
                await conn.execute(
                    "INSERT INTO personal_fonts(owner_id,id,name,sha256,byte_length,extension,media_type) VALUES(%s,%s,%s,%s,%s,%s,%s) RETURNING *",
                    (owner, identifier, name, sha, len(raw), ext, MIME[ext]),
                )
            ).fetchone()
            await conn.execute(
                "INSERT INTO personal_font_scopes(owner_id,revision) VALUES(%s,%s) ON CONFLICT(owner_id) DO UPDATE SET revision=excluded.revision",
                (owner, revision + 1),
            )
            changed = True
            result = {"font": project(row), "deduplicated": False}
        return result, changed

    async def upload(self, who, request, expected, filename, raw, *, canonical):
        request = str(UUID(str(request)))
        fingerprint = hashlib.sha256(
            json.dumps(
                ["upload", filename, hashlib.sha256(raw).hexdigest(), expected],
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode()
        ).hexdigest()
        async with self.context(who, True) as (conn, user):
            old = await self.prior(conn, who.id, request)
            if old:
                if old["result"].get("canceled"):
                    return old["result"]
                if old["fingerprint"] != fingerprint:
                    raise HTTPException(409, "原UUID已用于其他字体操作")
                return old["result"]
            revision = await self.revision(conn, who.id)
            error = None
            result = None
            changed = False
            try:
                async with conn.transaction():
                    if canonical and (type(expected) is not int or expected != revision):
                        raise HTTPException(409, "本人字体已变化，请重新读取")
                    result, changed = await self.store(conn, who.id, user, revision, filename, raw)
            except HTTPException as reason:
                error = reason
            value = {
                "requestId": request,
                "kind": "upload",
                "state": "failed" if error else "completed",
                "revision": revision + int(changed),
                "httpStatus": error.status_code if error else 200,
                "message": str(error.detail) if error else "ok",
                **(result or {}),
            }
            await self.save_receipt(conn, who, request, fingerprint, value)
            return value

    async def close(self, who, request):
        request = str(UUID(str(request)))
        async with self.context(who, True) as (conn, _):
            old = await self.prior(conn, who.id, request)
            if old:
                return old["result"]
            value = {
                "requestId": request,
                "kind": "upload",
                "state": "failed",
                "revision": await self.revision(conn, who.id),
                "httpStatus": 409,
                "message": "原字体操作已显式关闭",
                "canceled": True,
            }
            await self.save_receipt(
                conn, who, request, hashlib.sha256(b"explicit-close-upload").hexdigest(), value
            )
            return value

    async def original(self, who, identifier):
        if not PATTERN.fullmatch(identifier):
            raise HTTPException(404, "本人字体不存在")
        async with self.context(who) as (conn, _):
            row = await (
                await conn.execute(
                    "SELECT * FROM personal_fonts WHERE owner_id=%s AND id=%s", (who.id, identifier)
                )
            ).fetchone()
            if not row:
                aliases = await (
                    await conn.execute(
                        "SELECT DISTINCT f.* FROM personal_fonts f JOIN personal_font_source_aliases a ON a.owner_id=f.owner_id AND a.target_id=f.id WHERE a.owner_id=%s AND a.original_id=%s",
                        (who.id, identifier),
                    )
                ).fetchall()
                row = aliases[0] if len(aliases) == 1 else None
            if not row:
                raise HTTPException(404, "本人字体不存在；旧文件须有明确来源映射")
            return row, await self.media.open(conn, who.id, row["sha256"])
