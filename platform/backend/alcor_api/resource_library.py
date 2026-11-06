"""One PG resource index for canonical clients and v1/v2 compatibility adapters."""

import asyncio
import base64
import hashlib
import hmac
import json
import re
from contextlib import asynccontextmanager
from datetime import datetime
from uuid import uuid4

import psycopg
from fastapi import HTTPException
from psycopg import sql
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from .db import TargetMismatch, verify_identity
from .resource_contract import KINDS, QUOTA, category, classify, name, request_id, revision, shape
from .resource_media import ResourceMedia
from .security import lock_mutation_identity


def file_value(row, base):
    return {
        "id": row["id"],
        "category": row["category"],
        "folderId": row["folder_id"],
        "name": row["name"],
        "kind": row["kind"],
        "mime": row["mime"],
        "sizeBytes": row["size_bytes"],
        "sha256": row["sha256"],
        "revision": row["revision"],
        "createdAt": row["created_at"].isoformat(),
        "state": "ready",
        "downloadPath": base + "/files/" + row["id"] + "/content",
    }


def folder_value(row):
    return {
        "id": row["id"],
        "category": row["category"],
        "parentId": row["parent_id"],
        "name": row["name"],
        "revision": row["revision"],
        "createdAt": row["created_at"].isoformat(),
    }


def project(value, base):
    if isinstance(value, dict):
        result = {k: project(v, base) for k, v in value.items()}
        if isinstance(result.get("id"), str) and result["id"].startswith("rlf_") and "sha256" in result:
            result["downloadPath"] = base + "/files/" + result["id"] + "/content"
        return result
    return [project(v, base) for v in value] if isinstance(value, list) else value


class ResourceLibrary:
    def __init__(self, db):
        self.db = db
        self.media = ResourceMedia(db.settings)

    @asynccontextmanager
    async def upload_slot(self):
        # PG transaction locks bound multipart parsers across API processes, not
        # only a process-local counter. No identity/entity rows are held here.
        # A permitted pool size of one must still upload successfully. The
        # process-global slot uses a dedicated, identity-checked connection and
        # never holds a pool member while the mutation waits for that pool.
        async with (
            await psycopg.AsyncConnection.connect(
                self.db.settings.database_url.get_secret_value(),
                autocommit=True,
                row_factory=dict_row,
                connect_timeout=self.db.settings.connect_timeout,
                options="-c statement_timeout=5000 -c lock_timeout=2000 -c idle_in_transaction_session_timeout=0",
            ) as conn,
            conn.transaction(),
        ):
            await verify_identity(conn, self.db.settings)
            versions = await (await conn.execute("SELECT name,sha256 FROM schema_migrations")).fetchall()
            if {row["name"]: row["sha256"] for row in versions} != self.db.expected_migrations:
                raise TargetMismatch("Database schema does not match this application release")
            ok = False
            for slot in (71140801, 71140802):
                row = await (
                    await conn.execute("SELECT pg_try_advisory_xact_lock(%s) AS ok", (slot,))
                ).fetchone()
                if row["ok"]:
                    ok = True
                    break
            if not ok:
                raise HTTPException(429, "服务器正在接收文件，请稍后再试")
            yield

    async def usage(self, conn, owner):
        row = await (
            await conn.execute(
                "SELECT coalesce(sum(size_bytes),0) AS used,count(*) AS n FROM resource_files WHERE owner_id=%s AND deleted_at IS NULL",
                (owner,),
            )
        ).fetchone()
        return {"usedBytes": int(row["used"]), "fileCount": row["n"], "quotaBytes": QUOTA}

    async def folder(self, conn, owner, identifier):
        if not isinstance(identifier, str) or not re.fullmatch(r"rld_[0-9a-f]{32}", identifier):
            raise HTTPException(404, "目录不存在")
        row = await (
            await conn.execute(
                "SELECT * FROM resource_folders WHERE owner_id=%s AND id=%s AND deleted_at IS NULL",
                (owner, identifier),
            )
        ).fetchone()
        if not row:
            raise HTTPException(404, "目录不存在")
        return row

    async def file(self, conn, owner, identifier):
        if not isinstance(identifier, str) or not re.fullmatch(r"rlf_[0-9a-f]{32}", identifier):
            raise HTTPException(404, "文件不存在")
        row = await (
            await conn.execute(
                "SELECT * FROM resource_files WHERE owner_id=%s AND id=%s AND deleted_at IS NULL",
                (owner, identifier),
            )
        ).fetchone()
        if not row:
            raise HTTPException(404, "文件不存在")
        return row

    async def parent(self, conn, owner, cat, value, expected=None, *, strict=False):
        if value in ("", None):
            if expected is not None:
                raise HTTPException(400, "根目录不接受目录版本")
            return None
        row = await self.folder(conn, owner, value)
        if row["category"] != cat:
            raise HTTPException(404, "目录不存在")
        if (strict or expected is not None) and revision(expected) != row["revision"]:
            raise HTTPException(409, "目录版本已变化")
        return row

    async def bump(self, conn, owner, identifiers):
        ids = sorted({i for i in identifiers if i})
        if ids:
            row = await (
                await conn.execute(
                    "SELECT 1 FROM resource_folders WHERE owner_id=%s AND id=ANY(%s) AND revision>=9007199254740991 LIMIT 1",
                    (owner, ids),
                )
            ).fetchone()
            if row:
                raise HTTPException(409, "目录版本已达上限")
            await conn.execute(
                "UPDATE resource_folders SET revision=revision+1 WHERE owner_id=%s AND id=ANY(%s)",
                (owner, ids),
            )

    async def receipt(self, who, rid, base, kind=None):
        rid = request_id(rid)
        async with self.db.connection() as conn, conn.transaction():
            await lock_mutation_identity(conn, who, require_admin=False)
            row = await (
                await conn.execute(
                    "SELECT result,kind FROM resource_operation_receipts WHERE owner_id=%s AND request_id=%s",
                    (who.id, rid),
                )
            ).fetchone()
            if not row:
                from .resource_import import source_receipt
                row = await source_receipt(conn, who.id, rid)
            if not row or (kind and row["kind"] != kind):
                raise HTTPException(404, "操作不存在")
            return project(row["result"], base)

    async def cancel(self, who, original_id, raw, base, audit_id):
        """Explicitly fence a not-yet-registered original UUID; never undo success."""
        shape(raw, ("expectedKind",))
        kind = raw.get("expectedKind")
        if not isinstance(kind, str) or kind not in {
            "upload",
            "delete",
            "folder_create",
            "folder_delete",
            "folder_update",
            "file_update",
        }:
            raise HTTPException(400, "原操作类型无效")
        rid = request_id(original_id)
        async with self.db.connection() as conn, conn.transaction():
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("identity-management:" + who.id,)
            )
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("resources:" + who.id,)
            )
            await lock_mutation_identity(conn, who, require_admin=False)
            prior = await (
                await conn.execute(
                    "SELECT kind,result FROM resource_operation_receipts WHERE owner_id=%s AND request_id=%s",
                    (who.id, rid),
                )
            ).fetchone()
            if prior:
                if prior["kind"] != kind:
                    raise HTTPException(409, "原操作类型与回执不符，请查询原UUID")
                return project(prior["result"], base)
            from .resource_import import source_receipt
            original = await source_receipt(conn, who.id, rid)
            if original:
                if original['kind'] != kind:
                    raise HTTPException(409, '原操作类型与回执不符，请查询原UUID')
                if original['result']['state'] != 'pending':
                    return project(original['result'], base)
            # The same owner lock covers every original mutation's prior check
            # through commit. A late original can never pass this tombstone.
            result = {
                "requestId": str(rid),
                "kind": kind,
                "state": "failed",
                "fileId": "",
                "result": None,
                "code": 40901,
                "message": "原操作已取消",
                "cancelled": True,
            }
            await conn.execute(
                "INSERT INTO resource_operation_receipts(owner_id,request_id,kind,result) VALUES(%s,%s,%s,%s)",
                (who.id, rid, kind, Jsonb(result)),
            )
            await conn.execute(
                "INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'resource.operation.cancelled',%s,%s)",
                (who.id, str(rid), audit_id),
            )
        return project(result, base)

    async def read(self, who, base, action, query):
        async with self.db.connection() as conn, conn.transaction():
            await lock_mutation_identity(conn, who, require_admin=False)
            if not action:
                from .resource_contract import discovery

                return {**discovery(base), "usage": await self.usage(conn, who.id)}
            if action == "folder-tree":
                if set(query) != {"category"} or len(query.getlist("category")) != 1:
                    raise HTTPException(400, "查询字段无效")
                cat = category(query["category"])
                rows = await (
                    await conn.execute(
                        "SELECT * FROM resource_folders WHERE owner_id=%s AND category=%s AND deleted_at IS NULL ORDER BY created_at,id LIMIT 129",
                        (who.id, cat),
                    )
                ).fetchall()
                if len(rows) > 128:
                    raise HTTPException(409, "目录范围超出当前限制")
                return {"items": [folder_value(row) for row in rows]}
            if action == "folders":
                return await self.listing(conn, who.id, base, query, True)
            if action == "files":
                return await self.listing(conn, who.id, base, query, False)
            return file_value(await self.file(conn, who.id, action), base)

    async def content(self, who, identifier):
        async with self.db.connection() as conn, conn.transaction():
            await lock_mutation_identity(conn, who, require_admin=False)
            row = await self.file(conn, who.id, identifier)
            stream = await self.media.open(conn, who.id, row["sha256"])
            return row, stream

    async def listing(self, conn, owner, base, q, folders):
        allowed = (
            {"category", "parentId", "limit", "cursor"}
            if folders
            else {"category", "kind", "folderId", "limit", "cursor", "sort", "direction", "q"}
        )
        if set(q) - allowed or any(len(q.getlist(k)) != 1 for k in q):
            raise HTTPException(400, "查询字段无效")
        cat = category(q.get("category")) if folders or "category" in q else None
        search = q.get("q")
        if search is not None and (not 1 <= len(search) <= 120 or search != search.strip() or any(ord(c) < 32 or ord(c) == 127 for c in search)):
            raise HTTPException(400, "搜索名称无效")
        raw_limit = q.get("limit", "30")
        if (
            len(raw_limit) > 3
            or not raw_limit.isascii()
            or not raw_limit.isdecimal()
            or not 1 <= int(raw_limit) <= 100
        ):
            raise HTTPException(400, "每页条数为1至100")
        limit = int(raw_limit)
        kind = q.get("kind")
        if kind is not None and kind not in KINDS:
            raise HTTPException(400, "文件类型无效")
        parent = q.get("parentId", "") if folders else q.get("folderId")
        if parent not in (None, "", "root"):
            row = await self.folder(conn, owner, parent)
            if cat and row["category"] != cat:
                raise HTTPException(404, "目录不存在")
        if folders and parent == "root":
            raise HTTPException(404, "目录不存在")
        if not folders and parent == "":
            raise HTTPException(404, "目录不存在")
        order = "createdAt" if folders else q.get("sort", "createdAt")
        direction = "desc" if folders else q.get("direction", "desc")
        if order not in ("name", "createdAt") or direction not in ("asc", "desc"):
            raise HTTPException(400, "排序无效")
        column = "name" if order == "name" else "created_at"
        binding_parts = [owner, "folders" if folders else "files", cat, kind, parent, order, direction]
        if search is not None:
            binding_parts.append(search)
        binding = json.dumps(
            binding_parts,
            ensure_ascii=False,
            separators=(",", ":"),
        )
        secret = (
            await (await conn.execute("SELECT secret FROM resource_cursor_key WHERE singleton")).fetchone()
        )["secret"].encode()
        after = None
        if "cursor" in q:
            try:
                cursor = q["cursor"]
                payload, sig = cursor.split(".")
                if len(cursor) > 1024 or not hmac.compare_digest(
                    hmac.new(secret, payload.encode(), hashlib.sha256).hexdigest(), sig
                ):
                    raise ValueError()
                after = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
                if (
                    set(after) != {"binding", "value", "id"}
                    or after["binding"] != binding
                    or not isinstance(after["value"], str)
                    or not re.fullmatch(r"rld_[0-9a-f]{32}" if folders else r"rlf_[0-9a-f]{32}", after["id"])
                ):
                    raise ValueError()
                if column == "created_at":
                    after["value"] = datetime.fromisoformat(after["value"])
            except (ValueError, TypeError, KeyError, UnicodeError):
                raise HTTPException(400, "分页游标无效") from None
        conditions = [sql.SQL("owner_id=%s"), sql.SQL("deleted_at IS NULL")]
        values = [owner]
        if search is not None:
            conditions.append(sql.SQL("strpos(lower(name), lower(%s)) > 0"))
            values.append(search)
        for key, value in (("category", cat), ("kind", kind)):
            if value is not None:
                conditions.append(sql.SQL("{}=%s").format(sql.Identifier(key)))
                values.append(value)
        if folders or parent is not None:
            conditions.append(
                sql.SQL("{} IS NOT DISTINCT FROM %s").format(
                    sql.Identifier("parent_id" if folders else "folder_id")
                )
            )
            values.append(None if parent in ("", "root") else parent)
        sort_column = (
            sql.SQL('{} COLLATE "C"').format(sql.Identifier(column))
            if column == "name"
            else sql.Identifier(column)
        )
        if after:
            conditions.append(
                sql.SQL("({},id) {} (%s,%s)").format(sort_column, sql.SQL(">" if direction == "asc" else "<"))
            )
            values.extend((after["value"], after["id"]))
        values.append(limit + 1)
        rows = await (
            await conn.execute(
                sql.SQL("SELECT * FROM {} WHERE {} ORDER BY {} {},id {} LIMIT %s").format(
                    sql.Identifier("resource_folders" if folders else "resource_files"),
                    sql.SQL(" AND ").join(conditions),
                    sort_column,
                    sql.SQL(direction),
                    sql.SQL(direction),
                ),
                values,
            )
        ).fetchall()
        items = rows[:limit]
        next_cursor = None
        if len(rows) > limit:
            last = items[-1]
            value = last[column] if column == "name" else last[column].isoformat()
            payload = (
                base64.urlsafe_b64encode(
                    json.dumps(
                        {"binding": binding, "value": value, "id": last["id"]},
                        ensure_ascii=False,
                        separators=(",", ":"),
                    ).encode()
                )
                .decode()
                .rstrip("=")
            )
            next_cursor = payload + "." + hmac.new(secret, payload.encode(), hashlib.sha256).hexdigest()
        result = {
            "items": [folder_value(r) if folders else file_value(r, base) for r in items],
            "nextCursor": next_cursor,
        }
        if not folders:
            result["usage"] = await self.usage(conn, owner)
        return result

    async def mutate(self, who, kind, raw, base, audit_id, *, identifier=None, upload=None, legacy=False):
        keys = {
            "upload": ("requestId", "category", "folderId", "folderRevision", "name"),
            "delete": ("requestId", "revision"),
            "folder_create": ("requestId", "category", "parentId", "parentRevision", "name"),
            "folder_delete": ("requestId", "revision"),
            "folder_update": ("requestId", "revision", "name", "parentId", "parentRevision"),
            "file_update": ("requestId", "revision", "name", "folderId", "folderRevision"),
        }
        shape(raw, keys[kind])
        # Old folder endpoints had no UUID field. Their compatibility calls gain
        # a server receipt ID header without imposing an incompatible JSON key.
        rid = request_id(
            raw.get("requestId", str(uuid4()) if legacy and kind.startswith("folder_") else None)
        )
        failure = None
        data = None
        async with self.db.connection() as conn, conn.transaction():
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("identity-management:" + who.id,)
            )
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("resources:" + who.id,)
            )
            await lock_mutation_identity(conn, who, require_admin=False)
            prior = await (
                await conn.execute(
                    "SELECT 1 FROM resource_operation_receipts WHERE owner_id=%s AND request_id=%s UNION ALL SELECT 1 FROM resource_import_originals WHERE owner_id=%s AND request_id=%s",
                    (who.id, rid, who.id, rid),
                )
            ).fetchone()
            if prior:
                raise HTTPException(409, "此操作已登记，请查询原UUID结果")
            try:
                async with conn.transaction():
                    data = await self.apply(conn, who.id, kind, raw, base, identifier, upload, legacy)
                    await conn.execute(
                        "INSERT INTO audit_events(actor_id,action,request_id) VALUES(%s,%s,%s)",
                        (who.id, "resource." + kind, audit_id),
                    )
            except HTTPException as exc:
                failure = exc
            result = {
                "requestId": str(rid),
                "kind": kind,
                "state": "failed" if failure else "completed",
                "fileId": data.get("id", data.get("deletedId", identifier or ""))
                if data
                else identifier or "",
                "result": data,
                "code": failure.status_code * 100 + 1 if failure else 0,
                "message": str(failure.detail) if failure else "ok",
            }
            await conn.execute(
                "INSERT INTO resource_operation_receipts(owner_id,request_id,kind,result) VALUES(%s,%s,%s,%s)",
                (who.id, rid, kind, Jsonb(result)),
            )
        return project(result, base), failure

    async def apply(self, conn, owner, kind, raw, base, identifier, upload, legacy):
        if kind == "upload":
            cat = category(raw.get("category"))
            filename = name(raw.get("name"))
            folder = await self.parent(
                conn, owner, cat, raw.get("folderId"), raw.get("folderRevision"), strict=not legacy
            )
            filekind, mime = await asyncio.to_thread(classify, upload, filename, cat)
            usage = await self.usage(conn, owner)
            if usage["usedBytes"] + len(upload) > QUOTA or usage["fileCount"] >= 5000:
                raise HTTPException(409, "个人资源库容量或文件数已达上限")
            sha = await self.media.stage(conn, owner, upload)
            identifier = "rlf_" + uuid4().hex
            row = await (
                await conn.execute(
                    """INSERT INTO resource_files(id,owner_id,category,folder_id,name,kind,mime,size_bytes,sha256)
                VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *""",
                    (
                        identifier,
                        owner,
                        cat,
                        folder["id"] if folder else None,
                        filename,
                        filekind,
                        mime,
                        len(upload),
                        sha,
                    ),
                )
            ).fetchone()
            await self.bump(conn, owner, [row["folder_id"]])
            return file_value(row, base)
        if kind == "folder_create":
            cat = category(raw.get("category"))
            filename = name(raw.get("name"), folder=True)
            parent = await self.parent(
                conn, owner, cat, raw.get("parentId"), raw.get("parentRevision"), strict=not legacy
            )
            count = await (
                await conn.execute(
                    "SELECT count(*) AS n FROM resource_folders WHERE owner_id=%s AND deleted_at IS NULL",
                    (owner,),
                )
            ).fetchone()
            if count["n"] >= 128:
                raise HTTPException(409, "目录数量已达上限")
            await self.check_depth(conn, owner, parent["id"] if parent else None, 1)
            await self.unique_folder(conn, owner, cat, parent["id"] if parent else None, filename)
            row = await (
                await conn.execute(
                    "INSERT INTO resource_folders(id,owner_id,category,parent_id,name) VALUES(%s,%s,%s,%s,%s) RETURNING *",
                    ("rld_" + uuid4().hex, owner, cat, parent["id"] if parent else None, filename),
                )
            ).fetchone()
            await self.bump(conn, owner, [row["parent_id"]])
            return folder_value(row)
        expected = revision(raw.get("revision"))
        row = await (
            self.folder(conn, owner, identifier)
            if kind.startswith("folder_")
            else self.file(conn, owner, identifier)
        )
        if expected != row["revision"] or expected == 9007199254740991:
            raise HTTPException(409, "文件或目录版本已变化")
        if kind == "delete":
            # Verify first: missing bytes are corruption, never a successful delete.
            await self.media.read(conn, owner, row["sha256"])
            deleted = await (
                await conn.execute(
                    "UPDATE resource_files SET deleted_at=clock_timestamp(),revision=revision+1 WHERE owner_id=%s AND id=%s RETURNING deleted_at",
                    (owner, identifier),
                )
            ).fetchone()
            await self.bump(conn, owner, [row["folder_id"]])
            return {
                "deletedId": identifier,
                "fileDeleted": True,
                "removedBytes": row["size_bytes"],
                "usedBytes": (await self.usage(conn, owner))["usedBytes"],
                "deletedAt": deleted["deleted_at"].isoformat(),
            }
        if kind == "folder_delete":
            has = await (
                await conn.execute(
                    """SELECT 1 FROM resource_folders WHERE owner_id=%s AND parent_id=%s AND deleted_at IS NULL
                UNION ALL SELECT 1 FROM resource_files WHERE owner_id=%s AND folder_id=%s AND deleted_at IS NULL LIMIT 1""",
                    (owner, identifier, owner, identifier),
                )
            ).fetchone()
            if has:
                raise HTTPException(409, "目录不为空")
            await conn.execute(
                "UPDATE resource_folders SET deleted_at=clock_timestamp(),revision=revision+1 WHERE owner_id=%s AND id=%s",
                (owner, identifier),
            )
            await self.bump(conn, owner, [row["parent_id"]])
            return {"deletedId": identifier}
        is_folder = kind == "folder_update"
        parent_key = "parentId" if is_folder else "folderId"
        old_parent_key = "parent_id" if is_folder else "folder_id"
        if not set(raw) & {"name", parent_key}:
            raise HTTPException(400, "没有要修改的字段")
        filename = name(raw["name"], folder=is_folder) if "name" in raw else row["name"]
        new_parent = row[old_parent_key]
        if parent_key in raw:
            target = await self.parent(
                conn,
                owner,
                row["category"],
                raw[parent_key],
                raw.get("parentRevision" if is_folder else "folderRevision"),
                strict=True,
            )
            new_parent = target["id"] if target else None
        elif "parentRevision" in raw or "folderRevision" in raw:
            raise HTTPException(400, "目录版本必须与目标目录一起提供")
        if is_folder:
            await self.check_depth(
                conn, owner, new_parent, await self.height(conn, owner, identifier), identifier
            )
            await self.unique_folder(conn, owner, row["category"], new_parent, filename, identifier)
        table = "resource_folders" if is_folder else "resource_files"
        changed = await (
            await conn.execute(
                sql.SQL(
                    "UPDATE {} SET name=%s,{}=%s,revision=revision+1 WHERE owner_id=%s AND id=%s RETURNING *"
                ).format(sql.Identifier(table), sql.Identifier(old_parent_key)),
                (filename, new_parent, owner, identifier),
            )
        ).fetchone()
        await self.bump(conn, owner, [row[old_parent_key], new_parent])
        return folder_value(changed) if is_folder else file_value(changed, base)

    async def unique_folder(self, conn, owner, cat, parent, filename, exclude=""):
        exists = await (
            await conn.execute(
                "SELECT 1 FROM resource_folders WHERE owner_id=%s AND category=%s AND parent_id IS NOT DISTINCT FROM %s AND name=%s AND id<>%s AND deleted_at IS NULL",
                (owner, cat, parent, filename, exclude),
            )
        ).fetchone()
        if exists:
            raise HTTPException(409, "目录名称已存在")

    async def check_depth(self, conn, owner, parent, height, exclude=None):
        depth = 0
        seen = set()
        while parent:
            if parent == exclude or parent in seen:
                raise HTTPException(409, "不能把目录移到自身内部")
            seen.add(parent)
            depth += 1
            parent = (await self.folder(conn, owner, parent))["parent_id"]
        if depth + height > 8:
            raise HTTPException(400, "最多8层目录")

    async def height(self, conn, owner, identifier):
        row = await (
            await conn.execute(
                """WITH RECURSIVE tree AS (
            SELECT id,1 AS depth FROM resource_folders WHERE owner_id=%s AND id=%s AND deleted_at IS NULL
            UNION ALL SELECT f.id,t.depth+1 FROM resource_folders f JOIN tree t ON f.parent_id=t.id
            WHERE f.owner_id=%s AND f.deleted_at IS NULL AND t.depth<=8)
            SELECT max(depth) AS depth FROM tree""",
                (owner, identifier, owner),
            )
        ).fetchone()
        return row["depth"]
