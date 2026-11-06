"""Owner-scoped account icons: exact originals, safe display bytes and durable UUIDs."""

import asyncio
import hashlib
import io
import json
import warnings
from uuid import UUID, uuid4

from fastapi import HTTPException
from PIL import Image, ImageOps
from psycopg.types.json import Jsonb

from .broker_accounts import broker_account, broker_collection, serialize_brokers
from .security import lock_mutation_identity

LIMIT = 2097152


def normalized_icon(raw, media_type):
    if not raw or len(raw) > LIMIT:
        raise HTTPException(413 if len(raw) > LIMIT else 400, "图片最大2MiB且不能为空")
    magic = (
        "image/png" if raw.startswith(b"\x89PNG\r\n\x1a\n") else
        "image/jpeg" if raw.startswith(b"\xff\xd8\xff") else
        "image/webp" if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP" else None
    )
    if media_type != magic or magic is None:
        raise HTTPException(400, "图片类型与内容不符")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as picture:
                if picture.format != {"image/png": "PNG", "image/jpeg": "JPEG", "image/webp": "WEBP"}[magic]:
                    raise ValueError()
                if (picture.width > 4096 or picture.height > 4096 or picture.width * picture.height > 16777216
                        or getattr(picture, "n_frames", 1) != 1 or (magic == "image/png" and b"acTL" in raw)):
                    raise ValueError()
                picture.load()
                output = ImageOps.exif_transpose(picture).convert("RGBA")
                output.thumbnail((512, 512), Image.Resampling.LANCZOS)
                buffer = io.BytesIO()
                output.save(buffer, format="PNG")
                content = buffer.getvalue()
                if not content or len(content) > LIMIT:
                    raise ValueError()
                return content
    except (OSError, ValueError, SyntaxError, Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise HTTPException(400, "图片无法安全解码") from None


def request_uuid(value):
    try:
        return str(UUID(str(value)))
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(422, "原请求UUID无效") from None


class BrokerIcons:
    def __init__(self, db):
        self.db = db

    async def authorize(self, conn, who):
        await serialize_brokers(conn, who.id)
        await lock_mutation_identity(conn, who, require_admin=False)

    async def content(self, who, account_id, *, original=False):
        async with self.db.connection() as conn, conn.transaction():
            await self.authorize(conn, who)
            account = await broker_account(conn, who.id, account_id)
            row = await (await conn.execute(
                "SELECT original,content,original_sha256,content_sha256 FROM broker_icon_versions "
                "WHERE owner_id=%s AND account_id=%s AND id=%s",
                (who.id, account_id, account.get("icon_version")),
            )).fetchone()
            if not row:
                raise HTTPException(404, "自定义图标不存在")
            return bytes(row["original" if original else "content"])

    async def upload(self, who, account_id, request_id, revision, raw, media_type, *, project=None):
        # Decode away from the event loop, before taking an owner transaction lock.
        content = await asyncio.to_thread(normalized_icon, raw, media_type)
        return await self.mutate(who, account_id, request_id, revision, raw=raw, content=content, project=project)

    async def reset(self, who, account_id, request_id, revision, *, project=None):
        return await self.mutate(who, account_id, request_id, revision, project=project)

    async def mutate(self, who, account_id, request_id, revision, *, raw=None, content=None, project=None):
        request_id = request_uuid(request_id)
        if type(revision) is not int or not 1 <= revision < 9007199254740991:
            raise HTTPException(422, "账户版本无效")
        kind = "upload_icon" if raw is not None else "reset_icon"
        fingerprint = hashlib.sha256(json.dumps(
            [kind, account_id, revision, hashlib.sha256(raw).hexdigest() if raw is not None else None],
            separators=(",", ":"),
        ).encode()).hexdigest()
        async with self.db.connection() as conn, conn.transaction():
            await self.authorize(conn, who)
            previous = await (await conn.execute(
                "SELECT fingerprint,result FROM broker_account_operations WHERE owner_id=%s AND request_id=%s",
                (who.id, request_id),
            )).fetchone()
            if previous:
                if previous["result"].get("state") == "closed":
                    return previous["result"]
                if previous["fingerprint"] != fingerprint:
                    raise HTTPException(409, "原UUID已有其他请求，请查询原回执")
                return previous["result"]
            error, data = None, None
            try:
                async with conn.transaction():
                    account = await broker_account(conn, who.id, account_id)
                    if account["revision"] != revision:
                        raise HTTPException(409, "账户已变化，请重新读取")
                    icon_id = uuid4() if raw is not None else None
                    if raw is not None:
                        await conn.execute(
                            "INSERT INTO broker_icon_versions(id,owner_id,account_id,original,original_sha256,content,content_sha256) "
                            "VALUES(%s,%s,%s,%s,%s,%s,%s)",
                            (icon_id, who.id, account_id, raw, hashlib.sha256(raw).hexdigest(), content,
                             hashlib.sha256(content).hexdigest()),
                        )
                    row = await (await conn.execute(
                        "UPDATE broker_accounts SET icon_version=%s,revision=revision+1,updated_at=clock_timestamp() "
                        "WHERE owner_id=%s AND id=%s RETURNING revision",
                        (icon_id, who.id, account_id),
                    )).fetchone()
                    await conn.execute(
                        "INSERT INTO broker_account_collections(owner_id,revision) VALUES(%s,1) "
                        "ON CONFLICT(owner_id) DO UPDATE SET revision=broker_account_collections.revision+1", (who.id,),
                    )
                    await conn.execute(
                        "INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,%s,%s,%s)",
                        (who.id, "broker." + kind, account_id, request_id),
                    )
                    data = {"accountId": account_id, "revision": row["revision"],
                            "iconVersion": str(icon_id) if icon_id else None}
            except HTTPException as exc:
                error = {"status": exc.status_code, "message": str(exc.detail)}
            result = {"request_id": request_id, "kind": kind, "account_id": account_id,
                      "state": "failed" if error else "completed", "error": error, "data": data,
                      "collection_revision": await broker_collection(conn, who.id)}
            if project is not None and error is None:
                result["legacy_snapshot"] = await project(conn, who.id, account_id)
            await conn.execute(
                "INSERT INTO broker_account_operations(owner_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)",
                (who.id, request_id, fingerprint, Jsonb(result)),
            )
            return result

    async def receipt(self, who, request_id):
        request_id = request_uuid(request_id)
        async with self.db.connection() as conn, conn.transaction():
            await self.authorize(conn, who)
            row = await (await conn.execute(
                "SELECT result FROM broker_account_operations WHERE owner_id=%s AND request_id=%s",
                (who.id, request_id),
            )).fetchone()
            if not row:
                raise HTTPException(404, "尚无原UUID结果，请继续查询或关闭")
            return row["result"]

    async def close(self, who, request_id):
        request_id = request_uuid(request_id)
        async with self.db.connection() as conn, conn.transaction():
            await self.authorize(conn, who)
            result = {"request_id": request_id, "kind": "close", "state": "closed", "error": None,
                      "data": None, "account_id": None}
            await conn.execute(
                "INSERT INTO broker_account_operations(owner_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s) "
                "ON CONFLICT(owner_id,request_id) DO NOTHING",
                (who.id, request_id, "closed", Jsonb(result)),
            )
            return (await (await conn.execute(
                "SELECT result FROM broker_account_operations WHERE owner_id=%s AND request_id=%s",
                (who.id, request_id),
            )).fetchone())["result"]
