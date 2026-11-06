"""Admin global publication index over the existing immutable global byte registry."""

import asyncio
import hashlib
import json
import re
import secrets
import time
from contextlib import asynccontextmanager
from uuid import UUID, uuid4

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .resource_media import LIFECYCLE
from .security import lock_mutation_identity
from .shared_attachment_media import open_original, stage
from .system_asset_codec import FOLDERS, KINDS, asset_name, image_bytes


class SystemAssets:
    def __init__(self, db, card_directory=None):
        self.db = db
        self.card_directory = card_directory

    @asynccontextmanager
    async def connection(self, connection=None):
        if connection is not None:
            yield connection
        else:
            async with self.db.connection() as conn:
                yield conn

    @asynccontextmanager
    async def context(self, who=None, write=False, *, connection=None):
        async with self.connection(connection) as conn, conn.transaction():
            if who:
                await conn.execute(
                    "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("identity-management:" + who.id,)
                )
            await conn.execute(
                "SELECT pg_advisory_xact_lock"
                + ("" if write else "_shared")
                + "(hashtextextended('system-public-assets',0))"
            )
            if who:
                await lock_mutation_identity(conn, who, require_admin=True)
            yield conn

    async def read(self, who):
        async with self.context(who) as conn:
            row = await (
                await conn.execute("SELECT revision FROM system_asset_scope WHERE namespace='system_public'")
            ).fetchone()
            return {
                "namespace": "system_public",
                "revision": row["revision"],
                "kinds": {
                    key: {"extensions": value[0], "maxBytes": value[1]} for key, value in KINDS.items()
                },
                "cardMaxBytes": 20971520,
            }

    async def receipt(self, who, identifier):
        async with self.context(who) as conn:
            row = await (
                await conn.execute(
                    "SELECT result FROM system_asset_operations WHERE request_id=%s", (identifier,)
                )
            ).fetchone()
            if not row:
                raise HTTPException(404, "未找到原素材操作")
            return row["result"]

    async def upload(self, who, fields, file_name, raw, audit_id, canonical, *, connection=None):
        if fields.get("catalogBinding") and connection is None:
            from .asset_lookup_catalog import AssetCatalog
            # Catalog readers can consult card metadata. Acquire the catalog before
            # the image publication lock, matching readers rather than waiting in a cycle.
            async with AssetCatalog(self.db).context(who, True) as conn:
                if fields["catalogBinding"]["asset"]["type"] == "card":
                    await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended('card-catalog',0))")
                return await self.upload(who, fields, file_name, raw, audit_id, canonical, connection=conn)
        try:
            request = str(UUID(fields.get("requestId", "")))
            if request != fields.get("requestId"):
                raise ValueError()
        except (ValueError, TypeError):
            raise HTTPException(400, "原操作UUID无效") from None
        fingerprint = hashlib.sha256(
            json.dumps(
                {"fields": fields, "fileName": file_name, "sha256": hashlib.sha256(raw).hexdigest()},
                sort_keys=True,
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode()
        ).hexdigest()
        async with self.context(who, True, connection=connection) as conn:
            prior = await (
                await conn.execute(
                    "SELECT fingerprint,result FROM system_asset_operations WHERE request_id=%s", (request,)
                )
            ).fetchone()
            if prior:
                if prior["fingerprint"] != fingerprint:
                    raise HTTPException(409, "原UUID已用于其他素材操作")
                return prior["result"]
            revision = (
                await (
                    await conn.execute(
                        "SELECT revision FROM system_asset_scope WHERE namespace='system_public'"
                    )
                ).fetchone()
            )["revision"]
            error = None
            result = None
            try:
                async with conn.transaction():
                    if canonical and (
                        type(fields.get("expectedRevision")) is not int
                        or fields["expectedRevision"] != revision
                    ):
                        raise HTTPException(409, "共享素材已变化，请重新读取")
                    if revision >= 9007199254740991:
                        raise HTTPException(409, "素材修订已达上限")
                    result = await self.apply(conn, who.id, fields, file_name, raw)
                    if binding := fields.get("catalogBinding"):
                        from .asset_catalog_management import AssetManagement
                        from .asset_lookup_catalog import AssetCatalog

                        if binding["asset"]["type"] == "card":
                            from .card_public_assets import CardPublicAssets
                            result["binding"] = await CardPublicAssets(self.db, self.card_directory).bind(conn, who, binding["expectedRevision"], binding["asset"]["id"], result["version"], binding.get("restoreOriginal", False))
                        else:
                            bound = await AssetManagement(AssetCatalog(self.db)).write(
                                who, UUID(request), binding["expectedRevision"],
                                {**binding["asset"], "imageVersion": result["version"]}, connection=conn,
                            )
                            result["binding"] = {
                                **{key: bound["asset"][key] for key in ("id", "type", "market", "code")},
                                "revision": bound["revision"], "imageVersion": result["version"],
                            }
                    await conn.execute(
                        "UPDATE system_asset_scope SET revision=revision+1 WHERE namespace='system_public'"
                    )
            except HTTPException as reason:
                error = reason
                result = None
            payload = {
                "requestId": request,
                "namespace": "system_public",
                "state": "failed" if error else "completed",
                "revision": revision if error else revision + 1,
                "httpStatus": error.status_code if error else 200,
                "result": result,
                "message": str(error.detail) if error else "ok",
            }
            if result:
                payload.update(result)
            await conn.execute(
                "INSERT INTO system_asset_operations(request_id,actor_id,fingerprint,result) VALUES(%s,%s,%s,%s)",
                (request, who.id, fingerprint, Jsonb(payload)),
            )
            await conn.execute(
                "INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,%s,%s,%s)",
                (
                    who.id,
                    "system-assets.failed" if error else "system-assets.uploaded",
                    "system_public",
                    audit_id,
                ),
            )
            return payload

    async def apply(self, conn, actor, fields, file_name, raw, *, source_original=False):
        kind = fields.get("kind", "")
        folder = fields.get("folder", "").strip() if kind == "asset" else ""
        if kind not in KINDS:
            raise HTTPException(400, "不支持的共享素材类型")
        if folder and folder not in FOLDERS:
            raise HTTPException(400, "无效的素材文件夹")
        extensions, limit = KINDS[kind]
        limit = 20971520 if kind == "asset" and folder == "card" else limit
        if not raw:
            raise HTTPException(400, "请选择要上传的文件")
        if len(raw) > limit:
            raise HTTPException(400, "文件超过该素材类型大小上限")
        ext = file_name.rsplit(".", 1)[-1].lower()
        if ext not in extensions:
            raise HTTPException(400, "该素材类型不支持此图片格式")
        from .legacy_asset_codec import display_bytes
        codec = display_bytes if source_original or fields.get("catalogBinding", {}).get("restoreOriginal") else image_bytes
        output, media = await asyncio.to_thread(codec, raw, ext)
        if not output or len(output) > 20971520 + 65536:
            raise HTTPException(400, "安全素材超过大小上限")
        name = fields.get("name", "").strip()
        code = fields.get("code", "").strip().upper()
        market = fields.get("market", "").strip().upper()
        if kind == "asset" and (
            code
            and (not re.fullmatch("[A-Z0-9][A-Z0-9._:-]{0,39}", code) or ".." in code)
            or len(name.encode("utf-16-le")) // 2 > 120
        ):
            raise HTTPException(400, "素材名称或代码格式不正确")
        prefix = "/uploads/" + kind
        if kind == "asset" and folder:
            prefix += (
                "/"
                + folder
                + ("/" + market if folder in ("stock", "broker") and re.fullmatch(r"[A-Z0-9_-]{1,16}", market) else "")
            )
        filename = (
            asset_name(name, code, market, folder, ext)
            if kind == "asset"
            else str(int(time.time() * 1000)) + "-" + secrets.token_hex(4) + "." + ext
        )
        path = prefix + "/" + filename
        if ".." in path or len(path) > 512:
            raise HTTPException(400, "无效的素材文件名")
        original_sha = hashlib.sha256(raw).hexdigest()
        served_sha = hashlib.sha256(output).hexdigest()
        await conn.execute("SELECT pg_advisory_xact_lock_shared(" + LIFECYCLE + ")")
        # No cross-namespace wait cycle when a source segment holds another SHA.
        # Failure occurs inside the mutation savepoint, releasing every prior lock.
        for digest in sorted({original_sha, served_sha}):
            held = await (
                await conn.execute(
                    "SELECT pg_try_advisory_xact_lock(hashtextextended(%s,0)) ok", ("resource-sha:" + digest,)
                )
            ).fetchone()
            if not held["ok"]:
                raise HTTPException(503, "原件正在处理，请核对原回执后重试")
        try:
            await stage(conn, self.db.settings, original_sha, raw)
            if served_sha != original_sha:
                await stage(conn, self.db.settings, served_sha, output)
        except OSError:
            raise HTTPException(503, "素材原件尚未可靠落盘") from None
        version = uuid4()
        await conn.execute(
            "INSERT INTO system_asset_versions(id,public_path,kind,folder,market,original_sha256,served_sha256,original_size,served_size,media_type,created_by) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (
                version,
                path,
                kind,
                folder,
                market,
                original_sha,
                served_sha,
                len(raw),
                len(output),
                media,
                actor,
            ),
        )
        await conn.execute(
            "INSERT INTO system_asset_paths(public_path,current_version) VALUES(%s,%s) ON CONFLICT(public_path) DO UPDATE SET current_version=excluded.current_version,updated_at=clock_timestamp()",
            (path, version),
        )
        return {
            "kind": kind,
            "url": path + "?sha256=" + served_sha,
            "legacyUrl": path,
            "sha256": served_sha,
            "originalSha256": original_sha,
            "size": len(output),
            "originalSize": len(raw),
            "version": str(version),
        }

    async def public(self, path, sha=None):
        if (
            not re.fullmatch(r"/uploads/(?:ico|background|logo|login|asset)/[A-Za-z0-9._/-]+", path)
            or ".." in path
        ):
            raise HTTPException(400, "无效的素材路径")
        if sha is not None and not re.fullmatch("[a-f0-9]{64}", sha):
            raise HTTPException(400, "无效的素材摘要")
        async with self.context() as conn:
            if sha:
                row = await (
                    await conn.execute(
                        "SELECT * FROM system_asset_versions WHERE public_path=%s AND served_sha256=%s ORDER BY created_at,id LIMIT 1",
                        (path, sha),
                    )
                ).fetchone()
            else:
                row = await (
                    await conn.execute(
                        "SELECT v.* FROM system_asset_paths p JOIN system_asset_versions v ON v.id=p.current_version WHERE p.public_path=%s",
                        (path,),
                    )
                ).fetchone()
            if not row:
                raise HTTPException(404, "素材不存在")
            return row, await open_original(
                self.db.settings, {"sha256": row["served_sha256"], "byte_length": row["served_size"]}
            )

    async def original(self, who, identifier):
        async with self.context(who) as conn:
            row = await (
                await conn.execute("SELECT * FROM system_asset_versions WHERE id=%s", (identifier,))
            ).fetchone()
            if not row:
                raise HTTPException(404, "素材不存在")
            return row, await open_original(
                self.db.settings, {"sha256": row["original_sha256"], "byte_length": row["original_size"]}
            )
