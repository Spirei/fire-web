"""Personal group icon versions over the existing private immutable resource byte store."""

import asyncio
import hashlib
import json
import re
from contextlib import asynccontextmanager
from uuid import UUID, uuid4

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .resource_media import LIFECYCLE, ResourceMedia
from .security import lock_mutation_identity
from .system_asset_codec import KINDS, asset_name, image_bytes
from .watchlists import WatchGroups, dto

LIMIT = 2097152


def projection(row):
    version = str(row["id"])
    base = "/api/watch-groups/" + row["group_id"] + "/icons/" + version
    return {
        "version": version,
        "groupId": row["group_id"],
        "url": row["legacy_path"] + "?sha256=" + row["served_sha256"],
        "contentPath": base + "/content",
        "originalPath": base + "/original",
        "sha256": row["served_sha256"],
        "originalSha256": row["original_sha256"],
        "size": row["served_size"],
        "originalSize": row["original_size"],
        "mediaType": row["media_type"],
    }


async def reference(conn, owner, group, icon):
    if group["kind"] != "custom":
        raise HTTPException(400, "市场分组不支持自定义图标")
    if not isinstance(icon, str) or len(icon) > 2048:
        raise HTTPException(400, "分组图标地址不合法")
    icon = icon.strip()
    if not icon:
        return ""
    if await mapped_version(conn, owner, group["id"], icon):
        return icon
    from .watch_group_icon_source_mapping import legacy_reference

    imported = await legacy_reference(conn, owner, group["id"], icon)
    if imported:
        return imported
    raise HTTPException(409, "图标尚未有本人同组文件映射，请上传原图或清空；不会读取未知外链")


async def mapped_version(conn, owner, group, url):
    path, separator, sha = url.partition("?sha256=")
    if not separator or not re.fullmatch("[a-f0-9]{64}", sha):
        return None
    return await (
        await conn.execute(
            "SELECT * FROM watch_group_icon_versions WHERE owner_id=%s AND group_id=%s AND legacy_path=%s AND served_sha256=%s ORDER BY created_at DESC,id DESC LIMIT 1",
            (owner, group, path, sha),
        )
    ).fetchone()


class WatchGroupIcons:
    def __init__(self, db):
        self.db = db
        self.groups = WatchGroups(db)
        self.media = ResourceMedia(db.settings)

    async def authorize(self, conn, who):
        await lock_mutation_identity(conn, who, require_admin=False)
        current = await (
            await conn.execute("SELECT active,role FROM users WHERE id=%s", (who.id,))
        ).fetchone()
        if not current or not current["active"] or current["role"] != who.role:
            raise HTTPException(403, "账号权限已变化")

    @asynccontextmanager
    async def reading(self, who):
        async with self.db.connection() as conn, conn.transaction():
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("identity-management:" + who.id,)
            )
            await self.authorize(conn, who)
            yield conn

    async def upload(self, who, group_id, request_id, expected, file_name, raw, *, canonical):
        try:
            request_id = str(UUID(str(request_id)))
        except (ValueError, TypeError):
            raise HTTPException(400, "原操作UUID无效") from None
        fingerprint = hashlib.sha256(
            json.dumps(
                ["upload-icon", group_id, file_name, hashlib.sha256(raw).hexdigest(), expected],
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode()
        ).hexdigest()
        async with self.db.connection() as conn, conn.transaction():
            revision = await self.groups.lock(conn, who.id)
            await self.authorize(conn, who)
            prior = await (
                await conn.execute(
                    "SELECT fingerprint,result FROM watch_group_operations WHERE owner_id=%s AND request_id=%s",
                    (who.id, request_id),
                )
            ).fetchone()
            if prior:
                if prior["fingerprint"] != fingerprint:
                    raise HTTPException(409, "原UUID已用于其他分组操作")
                return prior["result"]
            result = None
            error = None
            try:
                async with conn.transaction():
                    if canonical and (type(expected) is not int or expected != revision):
                        raise HTTPException(409, "分组已变化，请重新读取")
                    if revision >= 9007199254740991:
                        raise HTTPException(409, "分组修订已达上限")
                    group = await (
                        await conn.execute(
                            "SELECT * FROM watch_groups WHERE owner_id=%s AND id=%s AND deleted_at IS NULL",
                            (who.id, group_id),
                        )
                    ).fetchone()
                    if not group:
                        raise HTTPException(404, "分组不存在；旧编号需明确映射")
                    if group["kind"] != "custom":
                        raise HTTPException(400, "市场分组不支持自定义图标")
                    if not raw:
                        raise HTTPException(400, "请选择要上传的文件")
                    if len(raw) > LIMIT:
                        raise HTTPException(413, "文件过大，最大2MiB")
                    ext = file_name.rsplit(".", 1)[-1].lower()
                    if ext not in KINDS["asset"][0]:
                        raise HTTPException(400, "允许JPG、PNG、GIF、WEBP、SVG，最大2MiB")
                    output, mime = await asyncio.to_thread(image_bytes, raw, ext)
                    if not output or len(output) > LIMIT + 65536:
                        raise HTTPException(400, "安全展示图超出大小上限")
                    original = hashlib.sha256(raw).hexdigest()
                    served = hashlib.sha256(output).hexdigest()
                    await conn.execute("SELECT pg_advisory_xact_lock_shared(" + LIFECYCLE + ")")
                    for sha in sorted({original, served}):
                        held = await (
                            await conn.execute(
                                "SELECT pg_try_advisory_xact_lock(hashtextextended(%s,0)) ok",
                                ("resource-sha:" + sha,),
                            )
                        ).fetchone()
                        if not held["ok"]:
                            raise HTTPException(503, "原件正在处理，请核对原回执后重试")
                    try:
                        await self.media.stage(conn, who.id, raw)
                        if served != original:
                            await self.media.stage(conn, who.id, output)
                    except OSError:
                        raise HTTPException(503, "图标原件尚未可靠落盘") from None
                    if not re.fullmatch(r"[A-Za-z0-9_-]+", who.id) or not re.fullmatch(
                        r"[A-Za-z0-9_-]+", group_id
                    ):
                        raise HTTPException(400, "图标所属编号不合法")
                    filename = asset_name(group["name"], "", "", "group", "jpg" if ext == "jpeg" else ext)
                    path = "/uploads/asset/group/" + who.id + "/" + group_id + "/" + filename
                    row = await (
                        await conn.execute(
                            "INSERT INTO watch_group_icon_versions(id,owner_id,group_id,legacy_path,original_sha256,served_sha256,original_size,served_size,media_type) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *",
                            (uuid4(), who.id, group_id, path, original, served, len(raw), len(output), mime),
                        )
                    ).fetchone()
                    media = projection(row)
                    group = await (
                        await conn.execute(
                            "UPDATE watch_groups SET icon=%s,revision=%s,updated_at=clock_timestamp() WHERE owner_id=%s AND id=%s RETURNING *",
                            (media["url"], revision + 1, who.id, group_id),
                        )
                    ).fetchone()
                    await conn.execute(
                        "UPDATE watch_group_collections SET revision=%s WHERE owner_id=%s",
                        (revision + 1, who.id),
                    )
                    result = {"group": dto(group), "icon": media}
            except HTTPException as reason:
                error = reason
            payload = {
                "requestId": request_id,
                "state": "failed" if error else "completed",
                "revision": revision if error else revision + 1,
                "httpStatus": error.status_code if error else 200,
                "message": str(error.detail) if error else "ok",
                **(result or {}),
            }
            await conn.execute(
                "INSERT INTO watch_group_operations(owner_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)",
                (who.id, request_id, fingerprint, Jsonb(payload)),
            )
            await conn.execute(
                "INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,%s,%s,%s)",
                (
                    who.id,
                    "watch-groups.icon-failed" if error else "watch-groups.icon-uploaded",
                    group_id,
                    request_id,
                ),
            )
            return payload

    async def current(self, who, group_id):
        async with self.reading(who) as conn:
            group = await (
                await conn.execute(
                    "SELECT * FROM watch_groups WHERE owner_id=%s AND id=%s AND deleted_at IS NULL",
                    (who.id, group_id),
                )
            ).fetchone()
            if not group:
                raise HTTPException(404, "本人分组不存在")
            revision = await (
                await conn.execute(
                    "SELECT revision FROM watch_group_collections WHERE owner_id=%s", (who.id,)
                )
            ).fetchone()
            row = await mapped_version(conn, who.id, group_id, group["icon"])
            alias_mapped = False
            if row is None and group["icon"]:
                from .watch_group_icon_source_mapping import legacy_reference

                mapped = await legacy_reference(conn, who.id, group_id, group["icon"])
                if mapped:
                    row = await mapped_version(conn, who.id, group_id, mapped)
                    alias_mapped = row is not None
            media = projection(row) if row else None
            return {
                "group": dto(group),
                "revision": revision["revision"] if revision else 0,
                "icon": media,
                "sourceState": "mapped_source_alias"
                if alias_mapped
                else "mapped"
                if media
                else "unmapped"
                if group["icon"]
                else "empty",
                "extensions": KINDS["asset"][0],
                "maxBytes": LIMIT,
            }

    async def history(self, who, group_id, *, after=None, limit=50):
        if type(limit) is not int or not 1 <= limit <= 100:
            raise HTTPException(400, "图标版本分页上限无效")
        async with self.reading(who) as conn:
            group = await (
                await conn.execute(
                    "SELECT id,icon,deleted_at FROM watch_groups WHERE owner_id=%s AND id=%s",
                    (who.id, group_id),
                )
            ).fetchone()
            if not group:
                raise HTTPException(404, "本人分组不存在")
            cursor = None
            if after is not None:
                try:
                    after = UUID(str(after))
                except (ValueError, TypeError) as exc:
                    raise HTTPException(400, "图标版本游标无效") from exc
                cursor = await (
                    await conn.execute(
                        "SELECT created_at,id FROM watch_group_icon_versions WHERE owner_id=%s AND group_id=%s AND id=%s",
                        (who.id, group_id, after),
                    )
                ).fetchone()
                if not cursor:
                    raise HTTPException(409, "原图标版本游标不属于本人此分组")
            if cursor:
                rows = await (
                    await conn.execute(
                        "SELECT * FROM watch_group_icon_versions WHERE owner_id=%s AND group_id=%s AND (created_at,id)<(%s,%s) ORDER BY created_at DESC,id DESC LIMIT %s",
                        (who.id, group_id, cursor["created_at"], cursor["id"], limit + 1),
                    )
                ).fetchall()
            else:
                rows = await (
                    await conn.execute(
                        "SELECT * FROM watch_group_icon_versions WHERE owner_id=%s AND group_id=%s ORDER BY created_at DESC,id DESC LIMIT %s",
                        (who.id, group_id, limit + 1),
                    )
                ).fetchall()
            current_url = group["icon"]
            if current_url and not await mapped_version(conn, who.id, group_id, current_url):
                from .watch_group_icon_source_mapping import legacy_reference

                current_url = await legacy_reference(conn, who.id, group_id, current_url) or current_url
            values = []
            for row in rows[:limit]:
                item = projection(row)
                item.update(
                    createdAt=row["created_at"].isoformat(),
                    current=current_url == item["url"],
                    availability="not_checked",
                )
                values.append(item)
            return {
                "groupId": group_id,
                "groupDeleted": group["deleted_at"] is not None,
                "items": values,
                "nextCursor": str(rows[limit - 1]["id"]) if len(rows) > limit else None,
                "originalsRetained": True,
                "authority": "owner_registered_immutable_versions",
            }

    async def version(self, who, group_id, identifier, *, original=False):
        async with self.reading(who) as conn:
            row = await (
                await conn.execute(
                    "SELECT * FROM watch_group_icon_versions WHERE owner_id=%s AND group_id=%s AND id=%s",
                    (who.id, group_id, identifier),
                )
            ).fetchone()
            if not row:
                raise HTTPException(404, "本人图标版本不存在")
            sha = row["original_sha256"] if original else row["served_sha256"]
            return row, await self.media.open(conn, who.id, sha)

    async def legacy(self, who, path, sha):
        async with self.reading(who) as conn:
            row = await (
                await conn.execute(
                    "SELECT * FROM watch_group_icon_versions WHERE owner_id=%s AND legacy_path=%s AND (%s::text IS NULL OR served_sha256=%s) ORDER BY created_at DESC,id DESC LIMIT 1",
                    (who.id, path, sha, sha),
                )
            ).fetchone()
            if not row:
                raise HTTPException(404, "本人图标不存在")
            return row, await self.media.open(conn, who.id, row["served_sha256"])
