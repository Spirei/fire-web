"""Admin-only bounded metadata snapshots. No font/sidecar bytes, owner guesses or source paths."""

import asyncio
import json
import os
import stat
from contextlib import asynccontextmanager
from datetime import UTC, datetime

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .font_source_files import directory, roots
from .font_source_owner import verify_owner
from .personal_fonts import PATTERN
from .security import lock_mutation_identity
from .source_authority import definition_hash, physical_identity_hash
from .source_snapshot import SourceMismatch, canonical, sha


def scan(settings, expected, maximum):
    def current():
        root = roots(settings).get(expected.alias)
        if not root or root.binding != expected.binding or root.physical != expected.physical:
            raise SourceMismatch("font_source_registration_changed")
        root.definition.require_access()
        if directory(root.path) != root.identity:
            raise SourceMismatch("font_source_root_identity_changed")
        return root

    root = current()
    fd = None
    try:
        fd = os.open(root.path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        before = os.fstat(fd)
        if (before.st_dev, before.st_ino) != root.identity:
            raise SourceMismatch("font_source_root_identity_changed")
        entries, visited, ignored, truncated = [], 0, 0, False
        with os.scandir(fd) as iterator:
            for entry in iterator:
                current()
                if visited == maximum:
                    truncated = True
                    break
                visited += 1
                if not PATTERN.fullmatch(entry.name):
                    ignored += 1
                    continue
                reason, size, size_text, attrs = None, None, None, None
                try:
                    info = entry.stat(follow_symlinks=False)
                    attrs = sha(
                        canonical(
                            [
                                info.st_dev,
                                info.st_ino,
                                info.st_size,
                                info.st_mtime_ns,
                                info.st_ctime_ns,
                                info.st_nlink,
                                info.st_mode,
                            ]
                        )
                    )
                    size = info.st_size if 0 <= info.st_size <= 9007199254740991 else None
                    size_text = str(info.st_size)
                    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_mode & 0o022:
                        reason = "not_safe_regular_original"
                    elif not 48 <= info.st_size <= 10485760:
                        reason = "font_size_not_supported"
                    elif len(entry.name) > 160:
                        reason = "original_id_not_supported"
                except OSError:
                    reason = "file_metadata_unavailable"
                entries.append(
                    {
                        "ordinal": len(entries),
                        "originalId": entry.name,
                        "filenameSha256": entry.name.split("-")[-1].split(".")[0],
                        "extension": entry.name.rsplit(".", 1)[1],
                        "size": size,
                        "sizeText": size_text,
                        "attributesSha256": attrs,
                        "metadataState": "blocked" if reason else "candidate",
                        "reason": reason,
                        "historicalUploaderVerified": False,
                        "contentVerified": False,
                    }
                )
        current()
        after = os.fstat(fd)
        changed = (before.st_dev, before.st_ino, before.st_mtime_ns, before.st_ctime_ns) != (
            after.st_dev,
            after.st_ino,
            after.st_mtime_ns,
            after.st_ctime_ns,
        )
        return {
            "format": "legacy-font-catalog/1",
            "namespace": "legacy_font_inventory",
            "sourceAlias": root.alias,
            "sourceInstance": root.definition.instance,
            "sourceBindingHash": definition_hash(root.definition),
            "rootBinding": root.binding,
            "rootIdentity": root.physical,
            "physicalIdentityHash": physical_identity_hash(root.definition),
            "observedAt": datetime.now(UTC).isoformat(),
            "maxEntries": maximum,
            "visited": visited,
            "ignored": ignored,
            "truncated": truncated,
            "changed": changed,
            "scanState": "changed" if changed else "truncated" if truncated else "sealed",
            "entries": entries,
            "contentVerified": False,
            "historicalUploaderVerified": False,
            "entireSourceComplete": False,
            "metadataNotFilesystemSnapshot": True,
        }
    except OSError:
        raise SourceMismatch("font_source_catalog_directory_unavailable") from None
    finally:
        if fd is not None:
            os.close(fd)


class FontSourceCatalog:
    def __init__(self, db, importer):
        self.db, self.importer = db, importer
        self.after_read = None

    @asynccontextmanager
    async def context(self, who, write=False):
        async with self.db.connection() as conn, conn.transaction():
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("identity-management:" + who.id,)
            )
            await lock_mutation_identity(conn, who, require_admin=True)
            user = await (
                await conn.execute("SELECT active,role FROM users WHERE id=%s FOR SHARE", (who.id,))
            ).fetchone()
            if not user or not user["active"] or user["role"] != "admin" or who.role != "admin":
                raise HTTPException(403, "需要当前管理员权限")
            if write:
                await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended('font-source-catalogs',0))")
            yield conn

    async def options(self, who):
        async with self.context(who):
            state = "configured" if self.db.settings.font_import_registry_path else "not_configured"
            try:
                configured = roots(self.db.settings)
            except SourceMismatch:
                configured, state = {}, "unavailable"
            return {
                "configuration": {"state": state},
                "items": [
                    {
                        "sourceAlias": root.alias,
                        "sourceInstance": root.definition.instance,
                        "window": root.definition.window_status(),
                    }
                    for root in configured.values()
                ],
                "maxEntries": 5000,
            }

    async def capture(self, who, data):
        request = data["requestId"]
        fingerprint = sha(canonical(data))
        async with self.context(who, True) as conn:
            old = await (
                await conn.execute(
                    "SELECT * FROM personal_font_source_catalog_operations WHERE request_id=%s", (request,)
                )
            ).fetchone()
            if old:
                if old["fingerprint"] != fingerprint and not old["result"].get("canceled"):
                    raise HTTPException(409, "原目录操作编号已用于其他读取")
                return old["result"]
            count = await (
                await conn.execute(
                    "SELECT count(*) n FROM personal_font_source_catalog_operations WHERE state='reading'"
                )
            ).fetchone()
            if count["n"] >= 4:
                raise HTTPException(409, "目录清单读取仍在处理中，请先核对原操作")
            try:
                root = roots(self.db.settings).get(data["sourceAlias"])
                if not root:
                    raise SourceMismatch("font_source_root_not_registered")
                root.definition.require_access()
            except SourceMismatch as error:
                raise HTTPException(409, str(error)) from None
            reading = {
                "requestId": request,
                "kind": "catalog",
                "state": "reading",
                "sourceAlias": root.alias,
                "httpStatus": 202,
                "entireSourceComplete": False,
            }
            await conn.execute(
                "INSERT INTO personal_font_source_catalog_operations(request_id,actor_id,platform_instance,fingerprint,state,result) VALUES(%s,%s,%s,%s,'reading',%s)",
                (request, who.id, self.db.settings.instance_id, fingerprint, Jsonb(reading)),
            )
        try:
            await verify_owner(root.definition, None)
            doc = await asyncio.to_thread(scan, self.db.settings, root, data["maxEntries"])
            await verify_owner(root.definition, None)
            if self.after_read:
                await self.after_read()
            async with self.context(who, True) as conn:
                old = await (
                    await conn.execute(
                        "SELECT * FROM personal_font_source_catalog_operations WHERE request_id=%s FOR UPDATE",
                        (request,),
                    )
                ).fetchone()
                if old["state"] != "reading":
                    return old["result"]
                current = roots(self.db.settings).get(root.alias)
                if not current or current.binding != root.binding or current.physical != root.physical:
                    raise SourceMismatch("font_source_registration_changed")
                current.definition.require_access()
                if directory(current.path) != current.identity:
                    raise SourceMismatch("font_source_root_identity_changed")
                raw = canonical(doc)
                if len(raw) > 8388608:
                    raise SourceMismatch("font_source_catalog_size_limit")
                await conn.execute(
                    "INSERT INTO personal_font_source_catalogs(id,actor_id,platform_instance,source_alias,source_instance,root_identity,root_binding,binding_hash,physical_identity_hash,manifest,sha256) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                    (
                        request,
                        who.id,
                        self.db.settings.instance_id,
                        root.alias,
                        root.definition.instance,
                        root.physical,
                        root.binding,
                        definition_hash(root.definition),
                        physical_identity_hash(root.definition),
                        raw,
                        sha(raw),
                    ),
                )
                result = {
                    "requestId": request,
                    "kind": "catalog",
                    "state": "completed",
                    "catalogId": request,
                    "sha256": sha(raw),
                    "scanState": doc["scanState"],
                    "truncated": doc["truncated"],
                    "changed": doc["changed"],
                    "knownItems": len(doc["entries"]),
                    "ignored": doc["ignored"],
                    "contentVerified": False,
                    "historicalUploaderVerified": False,
                    "entireSourceComplete": False,
                }
                await conn.execute(
                    "UPDATE personal_font_source_catalog_operations SET state='completed',result=%s WHERE request_id=%s",
                    (Jsonb(result), request),
                )
                await conn.execute(
                    "INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'font-source.cataloged',%s,%s)",
                    (who.id, request, request),
                )
                return result
        except Exception as error:  # noqa: BLE001 - accepted metadata reads receive a safe terminal receipt
            reason = str(error) if isinstance(error, SourceMismatch) else "font_source_catalog_failed"
            async with self.db.connection() as conn, conn.transaction():
                old = await (
                    await conn.execute(
                        "SELECT * FROM personal_font_source_catalog_operations WHERE request_id=%s FOR UPDATE",
                        (request,),
                    )
                ).fetchone()
                if old["state"] != "reading":
                    return old["result"]
                result = {
                    "requestId": request,
                    "kind": "catalog",
                    "state": "failed",
                    "httpStatus": 409,
                    "reason": reason,
                    "message": reason,
                    "entireSourceComplete": False,
                }
                await conn.execute(
                    "UPDATE personal_font_source_catalog_operations SET state='failed',result=%s WHERE request_id=%s",
                    (Jsonb(result), request),
                )
                return result

    async def row(self, conn, identifier):
        row = await (
            await conn.execute("SELECT * FROM personal_font_source_catalogs WHERE id=%s", (identifier,))
        ).fetchone()
        if not row:
            raise HTTPException(404, "目录清单不存在")
        raw = bytes(row["manifest"])
        if sha(raw) != row["sha256"]:
            raise HTTPException(409, "目录清单摘要不匹配")
        doc = json.loads(raw)
        if (
            doc["rootIdentity"] != row["root_identity"]
            or doc["rootBinding"] != row["root_binding"]
            or doc["sourceBindingHash"] != row["binding_hash"]
            or doc["physicalIdentityHash"] != row["physical_identity_hash"]
        ):
            raise HTTPException(409, "目录来源身份不匹配")
        return row, doc

    async def project(self, conn, row, doc):
        # Only platform PG joins. No source registry or filesystem stat on reads.
        claims = await (
            await conn.execute(
                "SELECT c.*,u.active owner_active,u.deleted_at,u.uid FROM personal_font_source_file_claims c JOIN users u ON u.id=c.owner_id WHERE c.original_id=ANY(%s) AND (c.root_identity=%s OR c.source_instance=%s OR c.physical_identity_hash=%s)",
                (
                    [e["originalId"] for e in doc["entries"]],
                    row["root_identity"],
                    row["source_instance"],
                    row["physical_identity_hash"],
                ),
            )
        ).fetchall()
        permissions = await (
            await conn.execute(
                "SELECT p.*,EXISTS(SELECT 1 FROM personal_font_source_captures c WHERE c.owner_id=p.owner_id AND c.permission_id=p.id) archived,EXISTS(SELECT 1 FROM personal_font_source_aliases a WHERE a.owner_id=p.owner_id AND a.permission_id=p.id) mapped FROM personal_font_source_permissions p WHERE p.root_identity=%s AND p.original_id=ANY(%s)",
                (row["root_identity"], [e["originalId"] for e in doc["entries"]]),
            )
        ).fetchall()
        history_gap = bool(
            await (
                await conn.execute(
                    "SELECT 1 FROM personal_font_source_history_gaps WHERE physical_identity_hash=%s",
                    (row["physical_identity_hash"],),
                )
            ).fetchone()
        )
        by_claim = {c["original_id"]: c for c in claims}
        by_permission = {p["original_id"]: p for p in permissions}
        entries = []
        counts = {
            "knownItems": len(doc["entries"]),
            "sourceBlocked": 0,
            "unassigned": 0,
            "pendingConfirmation": 0,
            "authorizedNotCaptured": 0,
            "archived": 0,
            "mapped": 0,
            "revoked": 0,
            "ownerClosed": 0,
            "ownerDisabled": 0,
            "historyGap": 0,
        }
        for original in doc["entries"]:
            p, claim = by_permission.get(original["originalId"]), by_claim.get(original["originalId"])
            if original["metadataState"] == "blocked":
                counts["sourceBlocked"] += 1
            if claim and claim["deleted_at"] is not None:
                state = "owner_closed"
                counts["ownerClosed"] += 1
            elif claim and not claim["owner_active"]:
                state = "owner_disabled"
                counts["ownerDisabled"] += 1
            elif history_gap and not claim:
                state = "history_gap"
                counts["historyGap"] += 1
            elif p:
                state = (
                    "mapped"
                    if p["mapped"]
                    else "archived"
                    if p["archived"]
                    else "pending_owner"
                    if p["state"] == "pending_owner"
                    else "revoked"
                    if p["state"] == "revoked"
                    else "authorized"
                )
                counts["archived"] += int(p["archived"])
                counts["mapped"] += int(p["mapped"])
                counts["pendingConfirmation"] += int(p["state"] == "pending_owner")
                counts["authorizedNotCaptured"] += int(p["state"] == "active" and not p["archived"])
                counts["revoked"] += int(p["state"] == "revoked")
            elif claim:
                state = "assignment_retained"
            else:
                state = "unassigned"
                counts["unassigned"] += 1
            entries.append(
                {
                    **original,
                    "assignmentState": state,
                    "permissionId": str(p["id"]) if p else None,
                    "ownerId": claim["owner_id"] if claim else p["owner_id"] if p else None,
                }
            )
        return {
            "id": str(row["id"]),
            "requestId": str(row["id"]),
            "sourceAlias": row["source_alias"],
            "sourceInstance": row["source_instance"],
            "sha256": row["sha256"],
            "scanState": doc["scanState"],
            "truncated": doc["truncated"],
            "changed": doc["changed"],
            "ignored": doc["ignored"],
            "visited": doc["visited"],
            "maxEntries": doc["maxEntries"],
            "counts": counts,
            "contentVerified": False,
            "historicalUploaderVerified": False,
            "entireSourceComplete": False,
            "instanceReenrollmentRequired": row["platform_instance"] != self.db.settings.instance_id,
        }, entries

    async def page(self, who, identifier, after=-1, limit=32):
        async with self.context(who) as conn:
            row, doc = await self.row(conn, identifier)
            summary, entries = await self.project(conn, row, doc)
            chosen = entries[after + 1 : after + 1 + limit]
            return {
                **summary,
                "items": chosen,
                "nextAfter": chosen[-1]["ordinal"]
                if chosen and chosen[-1]["ordinal"] + 1 < len(entries)
                else None,
            }

    async def history(self, who, after=None):
        async with self.context(who) as conn:
            cursor = await self.row(conn, after) if after else None
            values = await (
                await conn.execute(
                    "SELECT id FROM personal_font_source_catalogs WHERE (%s::timestamptz IS NULL OR (created_at,id)<(%s::timestamptz,%s::uuid)) ORDER BY created_at DESC,id DESC LIMIT 21",
                    (
                        cursor[0]["created_at"] if cursor else None,
                        cursor[0]["created_at"] if cursor else None,
                        after,
                    ),
                )
            ).fetchall()
            items = []
            for row in values[:20]:
                checked, doc = await self.row(conn, row["id"])
                summary, _ = await self.project(conn, checked, doc)
                items.append(summary)
            return {"items": items, "nextAfter": str(values[19]["id"]) if len(values) > 20 else None}

    async def operation(self, who, request):
        async with self.context(who) as conn:
            row = await (
                await conn.execute(
                    "SELECT result FROM personal_font_source_catalog_operations WHERE request_id=%s",
                    (request,),
                )
            ).fetchone()
            if not row:
                raise HTTPException(404, "尚未查到原目录操作")
            return row["result"]

    async def close(self, who, request):
        async with self.context(who, True) as conn:
            row = await (
                await conn.execute(
                    "SELECT * FROM personal_font_source_catalog_operations WHERE request_id=%s FOR UPDATE",
                    (request,),
                )
            ).fetchone()
            if row and row["state"] != "reading":
                return row["result"]
            result = {
                "requestId": str(request),
                "kind": "catalog",
                "state": "failed",
                "canceled": True,
                "entireSourceComplete": False,
            }
            if row:
                await conn.execute(
                    "UPDATE personal_font_source_catalog_operations SET state='failed',result=%s WHERE request_id=%s",
                    (Jsonb(result), request),
                )
            else:
                await conn.execute(
                    "INSERT INTO personal_font_source_catalog_operations(request_id,actor_id,platform_instance,fingerprint,state,result) VALUES(%s,%s,%s,%s,'failed',%s)",
                    (
                        request,
                        who.id,
                        self.db.settings.instance_id,
                        sha(canonical(["close-catalog"])),
                        Jsonb(result),
                    ),
                )
            return result

    async def register(self, who, identifier, ordinal, data):
        async with self.context(who) as conn:
            row, doc = await self.row(conn, identifier)
            if row["platform_instance"] != self.db.settings.instance_id:
                raise HTTPException(409, "恢复清单尚未在本实例重新登记取数权限")
            if ordinal >= len(doc["entries"]):
                raise HTTPException(404, "原目录项不存在")
            original = doc["entries"][ordinal]
            if original["metadataState"] != "candidate":
                raise HTTPException(409, "此原目录项元数据不安全，不能登记本人迁移")
            grant = await (
                await conn.execute("SELECT * FROM legacy_source_grants WHERE id=%s", (data["grantId"],))
            ).fetchone()
            if (
                not grant
                or grant["source_alias"] != row["source_alias"]
                or grant["source_instance"] != row["source_instance"]
                or grant["binding_hash"] != row["binding_hash"]
                or grant["physical_identity_hash"] != row["physical_identity_hash"]
            ):
                raise HTTPException(409, "目录项与已授权来源不是同一实例")
        return await self.importer.register(
            who,
            {
                **data,
                "originalId": original["originalId"],
                "evidenceRef": "catalog:" + str(identifier) + "/" + str(ordinal) + " " + data["evidenceRef"],
            },
            expected_root_binding=row["root_binding"],
        )
