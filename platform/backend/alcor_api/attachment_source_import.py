"""Immutable global source evidence and explicit small-segment application to one tree."""

import asyncio
import hashlib
import posixpath
from uuid import UUID, uuid4

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .admin_attachments import AdminAttachments, encoded
from .attachment_source_registry import AttachmentSourceError, SourceScan, load_sources
from .resource_media import LIFECYCLE
from .shared_attachment_media import open_original, stage
from .source_window import access_error_message


def fingerprint(value):
    return hashlib.sha256(encoded(value)).hexdigest()


def verify_manifest(row):
    if (
        fingerprint(row["manifest"]) != row["digest"]
        or row["manifest"].get("sourceIdentity") != row["binding_hash"]
    ):
        raise HTTPException(409, "来源清单完整性校验失败")
    if row["state"] == "sealed" and (
        row["manifest"].get("captureComplete") is not True
        or row["manifest"].get("blockedCount") != 0
        or row["manifest"].get("blockers")
    ):
        raise HTTPException(409, "来源清单完整范围无法核验")


class AttachmentSourceImport:
    def __init__(self, db):
        self.db = db
        self.attachments = AdminAttachments(db)

    async def prior(self, conn, request, hashed, kind):
        row = await (
            await conn.execute(
                "SELECT fingerprint,result FROM admin_attachment_operations WHERE request_id=%s AND namespace='admin_shared'",
                (request,),
            )
        ).fetchone()
        if not row:
            return None
        if row["result"].get("canceled") and row["result"].get("kind") == kind:
            return row["result"]
        if row["fingerprint"] != hashed:
            raise HTTPException(409, "原UUID已用于其他附件操作")
        return row["result"]

    async def receipt(self, conn, who, request, hashed, kind, result, error=None):
        revision = (
            await (
                await conn.execute(
                    "SELECT revision FROM admin_attachment_scope WHERE namespace='admin_shared'"
                )
            ).fetchone()
        )["revision"]
        payload = {
            "requestId": request,
            "namespace": "admin_shared",
            "kind": kind,
            "state": "failed" if error else "completed",
            "revision": revision,
            "httpStatus": error.status_code if error else 200,
            "message": str(error.detail) if error else "ok",
            "result": None if error else {"ok": True, **result},
            "targetImportCompleted": False,
            **(
                {
                    k: v
                    for k, v in result.items()
                    if k
                    not in {"state", "revision", "httpStatus", "namespace", "requestId", "message", "result"}
                }
                if not error
                else {}
            ),
        }
        if result and result.get("canceled"):
            payload["canceled"] = True
        await conn.execute(
            "INSERT INTO admin_attachment_operations(request_id,actor_id,fingerprint,result) VALUES(%s,%s,%s,%s)",
            (request, who.id, hashed, Jsonb(payload)),
        )
        await conn.execute(
            "INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,%s,'admin_shared',%s)",
            (who.id, "attachments.source-" + kind, request),
        )
        return payload

    async def options(self, who):
        async with self.attachments.context(who):
            try:
                sources = load_sources(self.db.settings)
            except AttachmentSourceError:
                return {"items": [], "state": "unavailable", "message": "附件来源登记无法核验"}
            return {
                "items": [
                    {
                        "alias": s.alias,
                        "namespace": "admin_shared",
                        "scope": "attachments.migrate",
                        "layout": "fire-web-data-attachments-v1",
                        "migrationWindow": s.status(),
                        "maxEntries": s.max_entries,
                        "maxBytes": s.max_bytes,
                        "maxDepth": s.max_depth,
                    }
                    for s in sources.values()
                ]
            }

    async def capture(self, who, data):
        request = str(UUID(data["requestId"]))
        hashed = fingerprint({"kind": "capture", **data})
        async with self.attachments.context(who, True) as conn:
            prior = await self.prior(conn, request, hashed, "capture")
            if prior:
                return prior
            error = None
            result = None
            try:
                async with conn.transaction():
                    try:
                        source = load_sources(self.db.settings).get(data["sourceAlias"])
                        if not source:
                            raise HTTPException(404, "附件来源未由操作员登记")
                        source.require()
                    except AttachmentSourceError as reason:
                        raise HTTPException(409, access_error_message(reason)) from None
                    scan = SourceScan(source)
                    iterator = scan.walk()
                    sentinel = object()
                    try:
                        while True:
                            try:
                                value = await asyncio.to_thread(next, iterator, sentinel)
                            except AttachmentSourceError as reason:
                                scan.blockers.append({"path": "", "reason": str(reason)})
                                break
                            if value is sentinel:
                                break
                            item, raw = value
                            if raw is not None:
                                try:
                                    async with conn.transaction():
                                        await conn.execute(
                                            "SELECT pg_advisory_xact_lock_shared(" + LIFECYCLE + ")"
                                        )
                                        held = await (
                                            await conn.execute(
                                                "SELECT pg_try_advisory_xact_lock(hashtextextended(%s,0)) ok",
                                                ("resource-sha:" + item["sha256"],),
                                            )
                                        ).fetchone()
                                        if not held["ok"]:
                                            raise HTTPException(503, "原件正在处理")
                                        await stage(conn, self.db.settings, item["sha256"], raw)
                                except (OSError, HTTPException):
                                    item.update(
                                        captureState="blocked", reason="captured_original_not_durable"
                                    )
                    finally:
                        await asyncio.to_thread(iterator.close)
                    await asyncio.to_thread(scan.finish)
                    ready = sum(i["captureState"] == "ready" for i in scan.items)
                    blocked = len(scan.items) - ready
                    complete = not scan.blockers and blocked == 0
                    manifest = {
                        "sourceAlias": source.alias,
                        "sourceIdentity": source.binding,
                        "definitionHash": source.definition,
                        "namespace": "admin_shared",
                        "captureMode": "per-file-verified-tree-scan",
                        "captureComplete": complete,
                        "entryCount": len(scan.items),
                        "readyCount": ready,
                        "blockedCount": blocked,
                        "knownFileBytes": sum(
                            i["size"] for i in scan.items if i["kind"] == "file" and i["size"] is not None
                        ),
                        "blockers": scan.blockers,
                        "itemDigest": fingerprint(scan.items),
                        "targetImportCompleted": False,
                    }
                    identifier = uuid4()
                    digest = fingerprint(manifest)
                    await conn.execute(
                        "INSERT INTO admin_attachment_source_manifests(id,platform_instance,source_alias,binding_hash,manifest,digest,state,created_by) VALUES(%s,%s,%s,%s,%s,%s,%s,%s)",
                        (
                            identifier,
                            self.db.settings.instance_id,
                            source.alias,
                            source.binding,
                            Jsonb(manifest),
                            digest,
                            "sealed" if complete else "partial",
                            who.id,
                        ),
                    )
                    for ordinal, item in enumerate(scan.items):
                        await conn.execute(
                            "INSERT INTO admin_attachment_source_items(manifest_id,ordinal,evidence) VALUES(%s,%s,%s)",
                            (identifier, ordinal, Jsonb(item)),
                        )
                    await conn.execute(
                        "INSERT INTO admin_attachment_source_progress(manifest_id) VALUES(%s)", (identifier,)
                    )
                    result = {
                        "manifestId": str(identifier),
                        "digest": digest,
                        "captureState": "sealed" if complete else "partial",
                        **manifest,
                    }
            except HTTPException as reason:
                error = reason
            return await self.receipt(conn, who, request, hashed, "capture", result, error)

    async def manifest(self, conn, identifier):
        row = await (
            await conn.execute("SELECT * FROM admin_attachment_source_manifests WHERE id=%s", (identifier,))
        ).fetchone()
        if not row:
            raise HTTPException(404, "附件来源清单不存在")
        verify_manifest(row)
        return row

    async def summary(self, conn, row):
        verify_manifest(row)
        stats = await (
            await conn.execute(
                "SELECT count(*) total,count(*) FILTER(WHERE i.evidence->>'captureState'='ready' AND r.state IS NULL) pending,count(*) FILTER(WHERE r.state='applied') applied,count(*) FILTER(WHERE i.evidence->>'captureState'<>'ready' OR r.state='blocked') blocked FROM admin_attachment_source_items i LEFT JOIN admin_attachment_source_results r ON r.manifest_id=i.manifest_id AND r.ordinal=i.ordinal WHERE i.manifest_id=%s",
                (row["id"],),
            )
        ).fetchone()
        if stats["total"] != row["manifest"].get("entryCount"):
            raise HTTPException(409, "来源清单项目数量不完整，不能判断导入完成")
        drift = await (
            await conn.execute(
                """WITH RECURSIVE paths AS (
          SELECT id,name::text rel,current_version FROM admin_attachment_entries WHERE parent_id IS NULL AND deleted_at IS NULL
          UNION ALL SELECT e.id,p.rel||'/'||e.name,e.current_version FROM admin_attachment_entries e JOIN paths p ON e.parent_id=p.id WHERE e.deleted_at IS NULL
        ) SELECT count(*) n FROM admin_attachment_source_items i
        JOIN admin_attachment_source_results r ON r.manifest_id=i.manifest_id AND r.ordinal=i.ordinal AND r.state='applied'
        JOIN admin_attachment_source_links l ON l.binding_hash=%s AND l.source_path=i.evidence->>'path'
        LEFT JOIN paths p ON p.id=l.entry_id WHERE i.manifest_id=%s AND (p.id IS NULL OR p.rel<>l.source_path OR l.kind='file' AND p.current_version IS DISTINCT FROM l.version_id)""",
                (row["binding_hash"], row["id"]),
            )
        ).fetchone()
        revision = await (
            await conn.execute(
                "SELECT revision FROM admin_attachment_source_progress WHERE manifest_id=%s", (row["id"],)
            )
        ).fetchone()
        complete = (
            row["platform_instance"] == self.db.settings.instance_id
            and row["state"] == "sealed"
            and stats["pending"] == 0
            and stats["blocked"] == 0
            and drift["n"] == 0
        )
        return {
            "manifestId": str(row["id"]),
            "digest": row["digest"],
            "state": row["state"],
            "manifest": row["manifest"],
            "manifestRevision": revision["revision"],
            **stats,
            "targetChangedCount": drift["n"],
            "targetImportCompleted": complete,
            "instanceReenrollmentRequired": row["platform_instance"] != self.db.settings.instance_id,
        }

    async def read(self, who, identifier, after=-1, limit=50):
        async with self.attachments.context(who) as conn:
            row = await self.manifest(conn, identifier)
            items = await (
                await conn.execute(
                    "SELECT i.ordinal,i.evidence,r.state AS apply_state,r.result FROM admin_attachment_source_items i LEFT JOIN admin_attachment_source_results r ON r.manifest_id=i.manifest_id AND r.ordinal=i.ordinal WHERE i.manifest_id=%s AND i.ordinal>%s ORDER BY i.ordinal LIMIT %s",
                    (identifier, after, limit + 1),
                )
            ).fetchall()
            return {
                **await self.summary(conn, row),
                "items": items[:limit],
                "nextAfter": items[limit - 1]["ordinal"] if len(items) > limit else None,
            }

    async def listing(self, who, after=None, limit=25):
        async with self.attachments.context(who) as conn:
            cursor = None
            if after:
                cursor = await (
                    await conn.execute(
                        "SELECT created_at,id FROM admin_attachment_source_manifests WHERE id=%s", (after,)
                    )
                ).fetchone()
                if not cursor:
                    raise HTTPException(400, "清单分页位置无效")
            rows = await (
                await conn.execute(
                    "SELECT * FROM admin_attachment_source_manifests WHERE (%s::timestamptz IS NULL OR (created_at,id)<(%s,%s)) ORDER BY created_at DESC,id DESC LIMIT %s",
                    (
                        cursor["created_at"] if cursor else None,
                        cursor["created_at"] if cursor else None,
                        cursor["id"] if cursor else None,
                        limit + 1,
                    ),
                )
            ).fetchall()
            return {
                "items": [await self.summary(conn, row) for row in rows[:limit]],
                "nextCursor": str(rows[limit - 1]["id"]) if len(rows) > limit else None,
            }

    async def original(self, who, identifier, ordinal):
        async with self.attachments.context(who) as conn:
            item = await (
                await conn.execute(
                    "SELECT evidence FROM admin_attachment_source_items WHERE manifest_id=%s AND ordinal=%s",
                    (identifier, ordinal),
                )
            ).fetchone()
            evidence = item["evidence"] if item else None
            if not evidence or evidence["kind"] != "file" or not evidence["sha256"]:
                raise HTTPException(404, "该项没有已捕获原件")
            row = await (
                await conn.execute(
                    "SELECT sha256,byte_length FROM admin_attachment_objects WHERE sha256=%s AND byte_length=%s",
                    (evidence["sha256"], evidence["size"]),
                )
            ).fetchone()
            if not row:
                raise HTTPException(404, "该项原件没有可靠落盘证据")
            return row, await open_original(self.db.settings, row)

    async def target_status(self, conn, row, item):
        e = item["evidence"]
        path = e["path"]
        link = await (
            await conn.execute(
                "SELECT l.*,e.deleted_at FROM admin_attachment_source_links l JOIN admin_attachment_entries e ON e.id=l.entry_id WHERE l.binding_hash=%s AND l.source_path=%s",
                (row["binding_hash"], path),
            )
        ).fetchone()
        if link:
            if link["kind"] != e["kind"] or link["sha256"] != e["sha256"] or link["byte_length"] != e["size"]:
                return "blocked", "source_revision_requires_reconciliation", link
            if link["deleted_at"] is not None:
                return "blocked", "target_was_deleted", link
            try:
                actual = await self.attachments.resolve(conn, path)
            except HTTPException:
                return "blocked", "target_path_changed", link
            if (
                actual is None
                or actual["id"] != link["entry_id"]
                or e["kind"] == "file"
                and actual["current_version"] != link["version_id"]
            ):
                return "blocked", "target_was_changed", link
            return "already_applied", None, link
        try:
            actual = await self.attachments.resolve(conn, path)
        except HTTPException:
            actual = None
        if actual:
            return "blocked", "target_path_collision", None
        parent = posixpath.dirname(path)
        if parent:
            try:
                actual = await self.attachments.resolve(conn, parent)
            except HTTPException:
                actual = None
            if not actual or actual["kind"] != "directory":
                return "ready", "parent_required_in_segment", None
            valid = await (
                await conn.execute(
                    "SELECT 1 FROM admin_attachment_source_links WHERE binding_hash=%s AND source_path=%s AND entry_id=%s AND kind='directory'",
                    (row["binding_hash"], parent, actual["id"]),
                )
            ).fetchone()
            if not valid:
                return "blocked", "target_parent_not_source_mapped", None
        return "ready", None, None

    async def plan(self, conn, row, max_items, retry):
        revision = (
            await (
                await conn.execute(
                    "SELECT revision FROM admin_attachment_scope WHERE namespace='admin_shared'"
                )
            ).fetchone()
        )["revision"]
        progress = (
            await (
                await conn.execute(
                    "SELECT revision FROM admin_attachment_source_progress WHERE manifest_id=%s", (row["id"],)
                )
            ).fetchone()
        )["revision"]
        candidates = await (
            await conn.execute(
                "SELECT i.ordinal,i.evidence FROM admin_attachment_source_items i LEFT JOIN admin_attachment_source_results r ON r.manifest_id=i.manifest_id AND r.ordinal=i.ordinal WHERE i.manifest_id=%s AND i.evidence->>'captureState'='ready' AND (r.state IS NULL OR (%s AND r.state='blocked')) ORDER BY i.ordinal LIMIT %s",
                (row["id"], retry, max_items),
            )
        ).fetchall()
        items = []
        for item in candidates:
            status, reason, _ = await self.target_status(conn, row, item)
            items.append(
                {
                    "ordinal": item["ordinal"],
                    "path": item["evidence"]["path"],
                    "kind": item["evidence"]["kind"],
                    "size": item["evidence"]["size"],
                    "sha256": item["evidence"]["sha256"],
                    "status": status,
                    "reason": reason,
                }
            )
        for item in items:
            parent = posixpath.dirname(item["path"])
            if item["reason"] == "parent_required_in_segment" and not any(
                p["path"] == parent
                and p["kind"] == "directory"
                and p["status"] in ("ready", "already_applied")
                for p in items
                if p["ordinal"] < item["ordinal"]
            ):
                item.update(status="blocked", reason="source_parent_not_applied")
        plan = {
            "manifestId": str(row["id"]),
            "digest": row["digest"],
            "expectedRevision": revision,
            "manifestRevision": progress,
            "maxItems": max_items,
            "retryBlocked": retry,
            "items": items,
        }
        return {**plan, "preview": fingerprint(plan)}

    async def preview(self, who, identifier, data):
        async with self.attachments.context(who) as conn:
            row = await self.manifest(conn, identifier)
            if row["platform_instance"] != self.db.settings.instance_id:
                raise HTTPException(409, "恢复副本须重新登记来源与导入清单")
            return {
                **await self.plan(conn, row, data["maxItems"], data["retryBlocked"]),
                "summary": await self.summary(conn, row),
            }

    async def segment(self, who, identifier, data):
        request = str(UUID(data["requestId"]))
        hashed = fingerprint({"kind": "segment", "manifestId": str(identifier), **data})
        async with self.attachments.context(who, True) as conn:
            prior = await self.prior(conn, request, hashed, "segment")
            if prior:
                return prior
            error = None
            result = None
            try:
                async with conn.transaction():
                    row = await self.manifest(conn, identifier)
                    if row["platform_instance"] != self.db.settings.instance_id:
                        raise HTTPException(409, "恢复副本须重新登记来源与导入清单")
                    plan = await self.plan(conn, row, data["maxItems"], data["retryBlocked"])
                    if any(data[k] != plan[k] for k in ("preview", "expectedRevision", "manifestRevision")):
                        raise HTTPException(409, "导入预览或附件目录已变化，请重新核对")
                    results = []
                    changed = False
                    for candidate in plan["items"]:
                        item = await (
                            await conn.execute(
                                "SELECT ordinal,evidence FROM admin_attachment_source_items WHERE manifest_id=%s AND ordinal=%s",
                                (identifier, candidate["ordinal"]),
                            )
                        ).fetchone()
                        e = item["evidence"]
                        value = {"ordinal": item["ordinal"], "path": e["path"], "state": "blocked"}
                        try:
                            async with conn.transaction():
                                status, reason, link = await self.target_status(conn, row, item)
                                if status == "blocked":
                                    raise HTTPException(409, reason)
                                if status == "already_applied":
                                    value.update(
                                        state="applied",
                                        entryId=str(link["entry_id"]),
                                        fileVersion=str(link["version_id"]) if link["version_id"] else None,
                                        alreadyApplied=True,
                                    )
                                else:
                                    imported = await self.attachments.import_captured(conn, who.id, e)
                                    await conn.execute(
                                        "INSERT INTO admin_attachment_source_links(binding_hash,source_path,kind,sha256,byte_length,entry_id,version_id) VALUES(%s,%s,%s,%s,%s,%s,%s)",
                                        (
                                            row["binding_hash"],
                                            e["path"],
                                            e["kind"],
                                            e["sha256"],
                                            e["size"],
                                            imported["entryId"],
                                            imported.get("fileVersion"),
                                        ),
                                    )
                                    value.update(state="applied", **imported)
                                    changed = True
                        except HTTPException as reason:
                            value["reason"] = str(reason.detail)
                        await conn.execute(
                            "INSERT INTO admin_attachment_source_results(manifest_id,ordinal,state,result,request_id) VALUES(%s,%s,%s,%s,%s) ON CONFLICT(manifest_id,ordinal) DO UPDATE SET state=excluded.state,result=excluded.result,request_id=excluded.request_id",
                            (identifier, item["ordinal"], value["state"], Jsonb(value), request),
                        )
                        results.append(value)
                    if changed:
                        await conn.execute(
                            "UPDATE admin_attachment_scope SET revision=revision+1 WHERE namespace='admin_shared'"
                        )
                    await conn.execute(
                        "UPDATE admin_attachment_source_progress SET revision=revision+1 WHERE manifest_id=%s",
                        (identifier,),
                    )
                    summary = await self.summary(conn, row)
                    result = {
                        "manifestId": str(identifier),
                        "items": results,
                        "summary": summary,
                        "manifestRevision": summary["manifestRevision"],
                        "targetImportCompleted": summary["targetImportCompleted"],
                    }
            except HTTPException as reason:
                error = reason
            return await self.receipt(conn, who, request, hashed, "segment", result, error)

    async def close(self, who, request, kind):
        request = str(request)
        async with self.attachments.context(who, True) as conn:
            row = await (
                await conn.execute(
                    "SELECT result FROM admin_attachment_operations WHERE request_id=%s", (request,)
                )
            ).fetchone()
            if row:
                return row["result"]
            return await self.receipt(
                conn,
                who,
                request,
                fingerprint({"cancel": request, "kind": kind}),
                kind,
                {"canceled": True},
                HTTPException(409, "原附件导入操作已显式关闭"),
            )
