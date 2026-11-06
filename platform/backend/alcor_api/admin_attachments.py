"""PG virtual admin-shared file tree. Paths never resolve to host filesystem paths."""

import asyncio
import hashlib
import json
import posixpath
import re
import subprocess
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from uuid import UUID, uuid4

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .security import lock_mutation_identity
from .shared_attachment_media import open_original, stage

LIMIT = 50 * 1024 * 1024


def relpath(raw, root=False):
    if not isinstance(raw, str):
        raise HTTPException(400, "无效的路径")
    clean = raw.replace("\\", "/").lstrip("/").strip()
    if not clean and root:
        return ""
    if (
        not clean
        or "\0" in clean
        or any(part in ("", ".", "..") or len(part.encode()) > 255 for part in clean.split("/"))
    ):
        raise HTTPException(400, "无效的路径")
    return clean


def filename(raw):
    clean = re.sub(r'[\\/:*?"<>|]', "_", raw).strip()
    return clean or "file-" + str(int(datetime.now(UTC).timestamp() * 1000))


def iso(value):
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def locale_order(values):
    if len(values) < 2:
        return list(range(len(values)))
    body = json.dumps(values, ensure_ascii=False).encode()
    if len(body) > 16 * 1024 * 1024:
        raise HTTPException(503, "目录排序超过读取预算")
    code = "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write(JSON.stringify(JSON.parse(s).map((v,i)=>({v,i})).sort((a,b)=>a.v.localeCompare(b.v,'zh-CN')).map(v=>v.i))));"
    try:
        run = subprocess.run(["node", "-e", code], input=body, capture_output=True, timeout=5, check=True)
        result = json.loads(run.stdout)
        if sorted(result) != list(range(len(values))):
            raise ValueError()
        return result
    except (OSError, ValueError, subprocess.SubprocessError):
        raise HTTPException(503, "目录排序暂不可用") from None


class AdminAttachments:
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
                + "(hashtextextended('admin-shared-attachments',0))"
            )
            await lock_mutation_identity(conn, who, require_admin=True)
            yield conn

    async def resolve(self, conn, path, create=False, actor=None):
        path = relpath(path, True)
        parent = None
        row = None
        for part in path.split("/") if path else []:
            if parent is not None and row["kind"] != "directory":
                raise HTTPException(400, "目标不是目录")
            row = await (
                await conn.execute(
                    "SELECT * FROM admin_attachment_entries WHERE parent_id IS NOT DISTINCT FROM %s AND name=%s AND deleted_at IS NULL",
                    (parent, part),
                )
            ).fetchone()
            if not row and create:
                identifier = uuid4()
                row = await (
                    await conn.execute(
                        "INSERT INTO admin_attachment_entries(id,parent_id,name,kind,created_by) VALUES(%s,%s,%s,'directory',%s) RETURNING *",
                        (identifier, parent, part, actor),
                    )
                ).fetchone()
            if not row:
                raise HTTPException(400, "目标不存在")
            parent = row["id"]
        return row if path else None

    async def parent(self, conn, path, actor):
        parent = await self.resolve(conn, posixpath.dirname(path), True, actor)
        if parent and parent["kind"] != "directory":
            raise HTTPException(400, "目标不是目录")
        return parent["id"] if parent else None

    async def target(self, conn, path, conflict):
        parent = await self.resolve(conn, posixpath.dirname(path))
        parent_id = parent["id"] if parent else None
        name = posixpath.basename(path)
        row = await (
            await conn.execute(
                "SELECT * FROM admin_attachment_entries WHERE parent_id IS NOT DISTINCT FROM %s AND name=%s AND deleted_at IS NULL",
                (parent_id, name),
            )
        ).fetchone()
        if not row:
            return path, None
        if conflict == "replace":
            return path, row
        if conflict == "keep-both":
            stem, ext = posixpath.splitext(name)
            for n in range(1, 10000):
                candidate = f"{stem} ({n}){ext}"
                if not await (
                    await conn.execute(
                        "SELECT 1 FROM admin_attachment_entries WHERE parent_id IS NOT DISTINCT FROM %s AND name=%s AND deleted_at IS NULL",
                        (parent_id, candidate),
                    )
                ).fetchone():
                    return posixpath.join(posixpath.dirname(path), candidate), None
            raise HTTPException(400, "无法生成可用的文件名")
        raise HTTPException(409, {"error": "同名文件或目录已存在", "code": "ATTACHMENT_EXISTS", "path": path})

    async def listing(self, who, path, canonical=False, directories=False):
        path = relpath(path, True)
        async with self.context(who) as conn:
            revision = (
                await (
                    await conn.execute(
                        "SELECT revision FROM admin_attachment_scope WHERE namespace='admin_shared'"
                    )
                ).fetchone()
            )["revision"]
            if directories:
                rows = await (
                    await conn.execute(
                        "WITH RECURSIVE dirs AS (SELECT id,name::text rel FROM admin_attachment_entries WHERE parent_id IS NULL AND kind='directory' AND deleted_at IS NULL UNION ALL SELECT e.id,d.rel||'/'||e.name FROM admin_attachment_entries e JOIN dirs d ON e.parent_id=d.id WHERE e.kind='directory' AND e.deleted_at IS NULL) SELECT rel FROM dirs"
                    )
                ).fetchall()
                paths = ["", *[r["rel"] for r in rows]]
                order = await asyncio.to_thread(locale_order, paths)
                value = {"directories": [paths[i] for i in order]}
            else:
                try:
                    parent = await self.resolve(conn, path)
                except HTTPException:
                    parent = None
                    rows = []
                else:
                    if parent and parent["kind"] != "directory":
                        raise HTTPException(400, "目标不是目录")
                    rows = await (
                        await conn.execute(
                            "SELECT e.*,coalesce(v.byte_length,0) byte_length FROM admin_attachment_entries e LEFT JOIN admin_attachment_versions v ON v.id=e.current_version WHERE e.parent_id IS NOT DISTINCT FROM %s AND e.deleted_at IS NULL ORDER BY e.modified_at DESC,e.id",
                            (parent["id"] if parent else None,),
                        )
                    ).fetchall()
                items = [
                    {
                        "name": r["name"],
                        "rel": posixpath.join(path, r["name"]),
                        "isDir": r["kind"] == "directory",
                        "size": 0 if r["kind"] == "directory" else r["byte_length"],
                        "mtime": iso(r["modified_at"]),
                        "ext": ""
                        if r["kind"] == "directory"
                        else posixpath.splitext(r["name"])[1][1:].lower(),
                    }
                    for r in rows
                ]
                dirs = [r for r in items if r["isDir"]]
                value = {
                    "path": path,
                    "dirs": [
                        dirs[i] for i in await asyncio.to_thread(locale_order, [r["name"] for r in dirs])
                    ],
                    "files": [r for r in items if not r["isDir"]],
                }
            return (
                {**value, "namespace": "admin_shared", "revision": revision, "legacySourceImported": False}
                if canonical
                else value
            )

    async def receipt(self, who, identifier):
        async with self.context(who) as conn:
            row = await (
                await conn.execute(
                    "SELECT result FROM admin_attachment_operations WHERE namespace='admin_shared' AND request_id=%s",
                    (identifier,),
                )
            ).fetchone()
            if not row:
                raise HTTPException(404, "原操作不存在")
            return row["result"]

    async def mutate(self, who, raw, identifier, upload=None, legacy=False):
        try:
            request = str(UUID(raw.get("requestId", "")))
            if request != raw.get("requestId"):
                raise ValueError()
        except (ValueError, TypeError):
            raise HTTPException(400, "原操作UUID无效") from None
        fingerprint = hashlib.sha256(
            encoded(
                {
                    **raw,
                    "fileName": upload[0] if upload else None,
                    "fileSha256": hashlib.sha256(upload[1]).hexdigest() if upload else None,
                }
            )
        ).hexdigest()
        async with self.context(who, True) as conn:
            prior = await (
                await conn.execute(
                    "SELECT fingerprint,result FROM admin_attachment_operations WHERE namespace='admin_shared' AND request_id=%s",
                    (request,),
                )
            ).fetchone()
            if prior:
                if prior["fingerprint"] != fingerprint:
                    raise HTTPException(409, "原UUID已用于其他附件操作，请查询原UUID")
                return prior["result"]
            revision = (
                await (
                    await conn.execute(
                        "SELECT revision FROM admin_attachment_scope WHERE namespace='admin_shared'"
                    )
                ).fetchone()
            )["revision"]
            error = None
            try:
                async with conn.transaction():
                    if not legacy and (
                        type(raw.get("expectedRevision")) is not int or raw["expectedRevision"] != revision
                    ):
                        raise HTTPException(409, "附件目录已变化，请重新读取")
                    if revision >= 9007199254740991:
                        raise HTTPException(409, "附件目录修订已达上限")
                    result = await self.apply(conn, who.id, raw, upload)
                    await conn.execute(
                        "UPDATE admin_attachment_scope SET revision=revision+1 WHERE namespace='admin_shared'"
                    )
            except HTTPException as reason:
                error = reason
                result = None
            version = result.pop("_versionId", None) if result else None
            digest = result.pop("_sha256", None) if result else None
            payload = {
                "requestId": request,
                "namespace": "admin_shared",
                "state": "failed" if error else "completed",
                "revision": revision if error else revision + 1,
                "httpStatus": error.status_code if error else 200,
                "result": result,
                "error": error.detail if error else None,
                "message": (
                    error.detail.get("error", "附件操作失败")
                    if isinstance(error.detail, dict)
                    else str(error.detail)
                )
                if error
                else "ok",
            }
            if version:
                payload.update(
                    fileVersion=version,
                    sha256=digest,
                    downloadPath="/api/admin/attachments/versions/" + version,
                )
            await conn.execute(
                "INSERT INTO admin_attachment_operations(request_id,actor_id,fingerprint,result) VALUES(%s,%s,%s,%s)",
                (request, who.id, fingerprint, Jsonb(payload)),
            )
            await conn.execute(
                "INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,%s,%s,%s)",
                (
                    who.id,
                    "attachments.failed" if error else "attachments." + raw["action"],
                    "admin_shared",
                    identifier,
                ),
            )
            return payload

    async def transfer(self, conn, actor, raw):
        original = raw.get("source", "")
        if not original:
            raise HTTPException(400, "缺少源路径")
        source = relpath(original)
        try:
            row = await self.resolve(conn, source)
        except HTTPException as error:
            if error.detail == "目标不存在":
                raise HTTPException(400, "源文件不存在") from None
            raise
        action = raw["action"]
        directory = (
            (original.rsplit("/", 1)[0] if "/" in original else "")
            if action == "rename"
            else raw.get("targetDir", "")
        )
        directory = relpath(directory, True)
        name = filename(raw.get("name", "")) if action == "rename" else posixpath.basename(source)
        destination = relpath((directory + "/" if directory else "") + name)
        parent = await self.parent(conn, destination, actor)
        destination, existing = await self.target(conn, destination, raw.get("conflict", "error"))
        destination = relpath(destination)
        if destination == source or destination.startswith(source + "/"):
            raise HTTPException(400, "不能把目录移动或复制到自身内部")
        if source.startswith(destination + "/"):
            # The old rm(destination) before rename/copy could erase its own source.
            # Fail atomically, preserving both original index and original bytes.
            raise HTTPException(400, "不能用包含源路径的目录替换")
        tree = await (
            await conn.execute(
                "WITH RECURSIVE tree AS ("
                "SELECT e.*,0 depth FROM admin_attachment_entries e WHERE id=%s "
                "UNION ALL SELECT e.*,t.depth+1 FROM admin_attachment_entries e JOIN tree t ON e.parent_id=t.id WHERE e.deleted_at IS NULL) "
                "SELECT t.*,v.sha256,v.byte_length FROM tree t LEFT JOIN admin_attachment_versions v ON v.id=t.current_version ORDER BY t.depth,t.id",
                (row["id"],),
            )
        ).fetchall()
        for entry in tree:
            if entry["kind"] == "file":
                stream = await open_original(self.db.settings, entry)
                stream.close()
        if existing:
            await conn.execute(
                "WITH RECURSIVE tree AS (SELECT id FROM admin_attachment_entries WHERE id=%s "
                "UNION ALL SELECT e.id FROM admin_attachment_entries e JOIN tree t ON e.parent_id=t.id WHERE e.deleted_at IS NULL) "
                "UPDATE admin_attachment_entries SET deleted_at=clock_timestamp(),modified_at=clock_timestamp() WHERE id IN (SELECT id FROM tree)",
                (existing["id"],),
            )
        name = posixpath.basename(destination)
        root_version = root_sha = None
        if action != "copy":
            await conn.execute(
                "UPDATE admin_attachment_entries SET parent_id=%s,name=%s WHERE id=%s",
                (parent, name, row["id"]),
            )
            if row["kind"] == "file":
                root_version, root_sha = str(tree[0]["current_version"]), tree[0]["sha256"]
                if name != row["name"]:
                    root_version = await self.transfer_version(conn, actor, row["id"], name, tree[0])
        else:
            identities = {}
            for entry in tree:
                copied = uuid4()
                top = entry["id"] == row["id"]
                copied_name = name if top else entry["name"]
                await conn.execute(
                    "INSERT INTO admin_attachment_entries(id,parent_id,name,kind,created_by) VALUES(%s,%s,%s,%s,%s)",
                    (
                        copied,
                        parent if top else identities[entry["parent_id"]],
                        copied_name,
                        entry["kind"],
                        actor,
                    ),
                )
                identities[entry["id"]] = copied
                if entry["kind"] == "file":
                    version = await self.transfer_version(conn, actor, copied, copied_name, entry)
                    if top:
                        root_version, root_sha = version, entry["sha256"]
        result = {"ok": True, "path": destination}
        if root_version:
            result.update(_versionId=root_version, _sha256=root_sha)
        return result

    async def transfer_version(self, conn, actor, entry, name, source):
        version = uuid4()
        await conn.execute(
            "INSERT INTO admin_attachment_versions(id,entry_id,sha256,byte_length,original_name,created_by) VALUES(%s,%s,%s,%s,%s,%s)",
            (version, entry, source["sha256"], source["byte_length"], name, actor),
        )
        await conn.execute(
            "UPDATE admin_attachment_entries SET current_version=%s WHERE id=%s", (version, entry)
        )
        return str(version)

    async def apply(self, conn, actor, raw, upload):
        action = raw["action"]
        if action in ("rename", "move", "copy"):
            return await self.transfer(conn, actor, raw)
        if action == "mkdir":
            parent_path = raw.get("dir", raw.get("parent", ""))
            path = relpath((parent_path + "/" if parent_path else "") + filename(raw.get("name", "")))
            await self.parent(conn, path, actor)
            await self.target(conn, path, "error")
            await self.resolve(conn, path, True, actor)
            return {"ok": True, "path": path}
        if action == "upload":
            if upload is None:
                raise HTTPException(400, "缺少文件")
            name, data = upload
            if len(data) > LIMIT:
                raise HTTPException(413, "单个文件最大 50MB")
            path = relpath(
                (raw.get("dir", raw.get("parent", "")) + "/" if raw.get("dir", raw.get("parent", "")) else "")
                + filename(name)
            )
            parent = await self.parent(conn, path, actor)
            path, existing = await self.target(conn, path, raw.get("conflict", "error"))
            path = relpath(path)
            if existing and existing["kind"] != "file":
                raise HTTPException(400, "同名目录已存在，不能用文件替换")
            digest = hashlib.sha256(data).hexdigest()
            try:
                await stage(conn, self.db.settings, digest, data)
            except OSError:
                raise HTTPException(503, "原文件尚未可靠落盘") from None
            entry = existing["id"] if existing else uuid4()
            if not existing:
                await conn.execute(
                    "INSERT INTO admin_attachment_entries(id,parent_id,name,kind,created_by) VALUES(%s,%s,%s,'file',%s)",
                    (entry, parent, posixpath.basename(path), actor),
                )
            version = uuid4()
            await conn.execute(
                "INSERT INTO admin_attachment_versions(id,entry_id,sha256,byte_length,original_name,created_by) VALUES(%s,%s,%s,%s,%s,%s)",
                (version, entry, digest, len(data), posixpath.basename(path), actor),
            )
            await conn.execute(
                "UPDATE admin_attachment_entries SET current_version=%s,modified_at=clock_timestamp() WHERE id=%s",
                (version, entry),
            )
            return {
                "ok": True,
                "path": path,
                "size": len(data),
                "_versionId": str(version),
                "_sha256": digest,
            }
        if action == "delete":
            row = await self.resolve(conn, raw.get("path", ""))
            if row is None:
                raise HTTPException(400, "缺少路径")
            children = await (
                await conn.execute(
                    "WITH RECURSIVE tree AS (SELECT id FROM admin_attachment_entries WHERE id=%s UNION ALL SELECT e.id FROM admin_attachment_entries e JOIN tree t ON e.parent_id=t.id WHERE e.deleted_at IS NULL) SELECT id FROM tree",
                    (row["id"],),
                )
            ).fetchall()
            if row["kind"] == "directory" and len(children) > 1 and not raw.get("force"):
                raise HTTPException(400, "目录非空，无法删除（请先清空目录内容）")
            await conn.execute(
                "UPDATE admin_attachment_entries SET deleted_at=clock_timestamp(),modified_at=clock_timestamp() WHERE id=ANY(%s)",
                ([r["id"] for r in children],),
            )
            return {"ok": True}
        raise HTTPException(503, "此附件操作尚未迁移")

    async def import_captured(self, conn, actor, evidence):
        # Only an internally verified immutable manifest can call this method.
        path = evidence["path"]
        if relpath(path) != path:
            raise HTTPException(400, "原附件路径不能无损表示")
        parent = await self.resolve(conn, posixpath.dirname(path))
        if parent is not None and parent["kind"] != "directory":
            raise HTTPException(409, "来源父目录不可用")
        await self.target(conn, path, "error")
        entry = uuid4()
        if evidence["kind"] == "file":
            row = await (await conn.execute("SELECT sha256,byte_length FROM admin_attachment_objects WHERE sha256=%s AND byte_length=%s", (evidence["sha256"], evidence["size"]))).fetchone()
            if not row:
                raise HTTPException(409, "来源原件尚未完整捕获")
            stream = await open_original(self.db.settings, row)
            stream.close()
        await conn.execute("INSERT INTO admin_attachment_entries(id,parent_id,name,kind,created_by) VALUES(%s,%s,%s,%s,%s)", (entry, parent["id"] if parent else None, posixpath.basename(path), evidence["kind"], actor))
        result = {"entryId": str(entry)}
        if evidence["kind"] == "file":
            version = await self.transfer_version(conn, actor, entry, posixpath.basename(path), {"sha256":evidence["sha256"],"byte_length":evidence["size"]})
            result.update(fileVersion=version,sha256=evidence["sha256"],downloadPath="/api/admin/attachments/versions/"+version)
        try:
            ns = evidence["sourceMtimeNs"]
            modified = datetime.fromtimestamp(ns // 1000000000,UTC).replace(microsecond=(ns % 1000000000)//1000)
        except (ValueError,OverflowError,OSError,KeyError,TypeError):
            raise HTTPException(409, "原附件时间无法无损核对") from None
        await conn.execute("UPDATE admin_attachment_entries SET modified_at=%s WHERE id=%s", (modified,entry))
        return result

    async def content(self, who, path=None, version=None):
        async with self.context(who) as conn:
            if version:
                row = await (
                    await conn.execute(
                        "SELECT v.*,e.deleted_at FROM admin_attachment_versions v JOIN admin_attachment_entries e ON e.id=v.entry_id WHERE v.id=%s",
                        (version,),
                    )
                ).fetchone()
            else:
                entry = await self.resolve(conn, path)
                row = await (
                    await conn.execute(
                        "SELECT v.*,e.deleted_at FROM admin_attachment_versions v JOIN admin_attachment_entries e ON e.current_version=v.id WHERE e.id=%s",
                        (entry["id"] if entry else None,),
                    )
                ).fetchone()
            if not row or row["deleted_at"] is not None:
                raise HTTPException(400, "文件不存在")
            return row, await open_original(self.db.settings, row)
