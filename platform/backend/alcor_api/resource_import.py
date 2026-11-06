"""One explicit source resource permission, immutable index, resumable PG commits."""
from .source_window import access_error_message


import asyncio
import hashlib
import json
import re
import unicodedata
from datetime import UTC, datetime
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo

import psycopg
from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .resource_contract import classify, name
from .resource_import_registry import ResourceSourceError
from .resource_import_snapshot import capture
from .resource_library import ResourceLibrary, project
from .security import lock_mutation_identity
from .source_authority import physical_identity_hash
from .source_snapshot import SourceMismatch, canonical, sha

BASE = "/api/resource-library"


def uid(value):
    try:
        text = str(UUID(str(value)))
        if text != str(value):
            raise ValueError()
        return text
    except (TypeError, ValueError):
        raise HTTPException(422, "请求UUID无效") from None


def object_pairs(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError()
        value[key] = item
    return value


def instant(value, timezone):
    if not isinstance(value, str):
        raise TypeError()
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        if not timezone:
            raise ValueError()
        zone = ZoneInfo(timezone)
        candidates = {
            parsed.replace(tzinfo=zone, fold=fold).astimezone(UTC)
            for fold in (0, 1)
            if parsed.replace(tzinfo=zone, fold=fold).astimezone(UTC).astimezone(zone).replace(tzinfo=None)
            == parsed
        }
        if len(candidates) != 1:
            raise ValueError("source_local_time_ambiguous_or_nonexistent")
        parsed = next(iter(candidates))
    return parsed.isoformat()


def normalize(kind, raw, owner, timezone):
    values = {}
    for key, cell in raw.items():
        if cell.get("null"):
            values[key] = None
        elif "text" in cell and isinstance(cell["text"], str):
            values[key] = cell["text"]
        else:
            raise ValueError("source_storage_type_not_supported")
    if values["user_id"] != owner:
        raise ValueError("source_owner_index_mismatch")
    values.pop("user_id")
    values["created_at"] = instant(values["created_at"], timezone)
    if kind == "operation":
        uid(values["request_id"])
        if (
            values["type"] not in ("upload", "delete")
            or values["state"] not in ("pending", "completed", "failed")
            or not re.fullmatch(r"rlf_[0-9a-f]{32}", values["file_id"])
        ):
            raise ValueError("source_operation_invalid")
        result = (
            None
            if values["result"] is None
            else json.loads(
                values["result"],
                object_pairs_hook=object_pairs,
                parse_constant=lambda _: (_ for _ in ()).throw(ValueError()),
            )
        )
        if values["state"] == "completed":
            if not isinstance(result, dict):
                raise ValueError("source_completed_receipt_missing")
            if values["type"] == "upload" and (
                result.get("id") != values["file_id"]
                or not re.fullmatch(r"[a-f0-9]{64}", str(result.get("sha256", "")))
            ):
                raise ValueError("source_completed_receipt_invalid")
            if values["type"] == "upload":
                needed = {
                    "id",
                    "category",
                    "folderId",
                    "name",
                    "kind",
                    "mime",
                    "sizeBytes",
                    "sha256",
                    "revision",
                    "createdAt",
                    "state",
                    "downloadPath",
                }
                if (
                    not needed <= set(result)
                    or name(result["name"]) != result["name"]
                    or result["category"] not in ("components", "media")
                    or result["state"] != "ready"
                    or type(result["sizeBytes"]) is not int
                    or not 1 <= result["sizeBytes"] <= 52428800
                    or type(result["revision"]) is not int
                    or not 1 <= result["revision"] <= 9007199254740991
                    or result["kind"] not in ("image", "video", "audio", "document", "archive", "other")
                    or not isinstance(result["mime"], str)
                    or not 1 <= len(result["mime"]) <= 200
                    or result["folderId"] is not None
                    and not re.fullmatch(r"rld_[a-f0-9]{32}", str(result["folderId"]))
                    or result["downloadPath"]
                    not in (
                        f"/api/v1/resource-library/files/{values['file_id']}/content",
                        f"/api/v2/resource-library/files/{values['file_id']}/content",
                    )
                ):
                    raise ValueError("source_completed_receipt_invalid")
                instant(result["createdAt"], timezone)
            if values["type"] == "delete" and (
                result.get("deletedId") != values["file_id"]
                or result.get("fileDeleted") is not True
                or type(result.get("removedBytes")) is not int
                or not 1 <= result["removedBytes"] <= 52428800
                or type(result.get("usedBytes")) is not int
                or result["usedBytes"] < 0
            ):
                raise ValueError("source_completed_receipt_invalid")
            if values["type"] == "delete":
                instant(result["deletedAt"], timezone)
        elif result is not None:
            raise ValueError("source_unsettled_result_not_null")
        values["projection"] = {
            "requestId": values["request_id"],
            "kind": values["type"],
            "state": values["state"],
            "fileId": values["file_id"],
            "result": result,
            "code": 40901 if values["state"] == "failed" else 0,
            "message": "原来源操作失败" if values["state"] == "failed" else "ok",
            "sourceEvidence": True,
            "targetImportCompleted": False,
        }
        return values
    prefix = "rld_" if kind == "folder" else "rlf_"
    if not re.fullmatch(prefix + r"[0-9a-f]{32}", values["id"]) or values["category"] not in (
        "components",
        "media",
    ):
        raise ValueError("source_resource_identity_invalid")
    integer_keys = ("revision",) if kind == "folder" else ("revision", "size_bytes")
    for key in integer_keys:
        if not re.fullmatch(r"[1-9][0-9]{0,15}", values[key]) or int(values[key]) > 9007199254740991:
            raise ValueError("source_integer_invalid")
        values[key] = int(values[key])
    parent = "parent_id" if kind == "folder" else "folder_id"
    if values[parent] == "":
        values[parent] = None
    elif values[parent] is None or not re.fullmatch(r"rld_[0-9a-f]{32}", values[parent]):
        raise ValueError("source_parent_invalid")
    if kind == "folder":
        n = values["name"]
        if (
            not isinstance(n, str)
            or not 1 <= len(n) <= 240
            or len(n.encode()) > 480
            or n in (".", "..")
            or n != n.strip()
            or any(ord(c) < 32 or ord(c) == 127 or c in "/\\" for c in n)
            or unicodedata.normalize("NFC", n) != n
        ):
            raise ValueError("source_folder_name_invalid")
    else:
        if (
            name(values["name"]) != values["name"]
            or values["state"] not in ("uploading", "ready", "deleting", "deleted")
            or not 1 <= values["size_bytes"] <= 52428800
            or not re.fullmatch(r"[a-f0-9]{64}", values["sha256"])
            or values["kind"] not in ("image", "video", "audio", "document", "archive", "other")
            or not isinstance(values["mime"], str)
            or not 1 <= len(values["mime"]) <= 200
        ):
            raise ValueError("source_file_metadata_invalid")
    return values


async def source_receipt(conn, owner, request):
    row = await (
        await conn.execute(
            "SELECT kind,projection FROM resource_import_originals WHERE owner_id=%s AND request_id=%s",
            (owner, request),
        )
    ).fetchone()
    if row and row["projection"].get("state") == "unverified":
        raise HTTPException(409, "原UUID证据不完整，请核对资源迁移清单")
    return {"kind": row["kind"], "result": row["projection"]} if row else None


class ResourceImport:
    def __init__(self, db, authority, resources, passkeys):
        self.db = db
        self.authority = authority
        self.resources = resources
        self.passkeys = passkeys
        self.library = ResourceLibrary(db)
        self.after_table = None

    async def lock(self, conn, who, admin=False):
        await conn.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("identity-management:" + who.id,)
        )
        await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("resources:" + who.id,))
        await lock_mutation_identity(conn, who, require_admin=admin)

    def definitions(self, consent):
        definition = self.authority.registry.get(consent["source_alias"])
        resource = self.resources.get(consent["source_alias"])
        if definition:
            try:
                definition.require_access(consent["source_owner"])
            except SourceMismatch as error:
                raise HTTPException(409, access_error_message(error)) from None
        if (
            not definition
            or not resource
            or definition.instance != consent["source_instance"]
            or consent["source_owner"] not in definition.owners
            or resource.binding(definition) != consent["binding_hash"]
            or physical_identity_hash(definition) != consent["physical_identity_hash"]
        ):
            raise HTTPException(409, "资源来源登记身份或结构已变化，请重新授权")
        resource.check()
        return definition, resource

    async def consent(self, conn, who, identifier, revision):
        row = await (
            await conn.execute(
                "SELECT * FROM resource_source_consents WHERE id=%s AND owner_id=%s FOR SHARE",
                (identifier, who.id),
            )
        ).fetchone()
        if (
            not row
            or row["scope"] != "resources.migrate"
            or row["state"] != "active"
            or row["revision"] != revision
            or row["platform_instance"] != self.db.settings.instance_id
        ):
            raise HTTPException(409, "资源迁移授权未生效、已撤销或修订已变化")
        claims = await self.authority.check_claim(
            conn, row["source_instance"], row["source_owner"], who.id, row["physical_identity_hash"]
        )
        if len(claims) != 1:
            raise HTTPException(409, "来源尚未建立可核验的永久账号归属")
        self.definitions(row)
        return row

    async def prior(self, conn, who, request, fingerprint):
        row = await (
            await conn.execute(
                "SELECT fingerprint,result FROM resource_import_operations WHERE owner_id=%s AND request_id=%s",
                (who.id, request),
            )
        ).fetchone()
        if row:
            if row["fingerprint"] != fingerprint:
                raise HTTPException(409, "原UUID已用于另一操作，请查询原UUID")
            return row["result"]
        accepted = await (
            await conn.execute(
                "SELECT fingerprint FROM resource_import_manifests WHERE owner_id=%s AND request_id=%s",
                (who.id, request),
            )
        ).fetchone()
        if accepted and accepted["fingerprint"] != fingerprint:
            raise HTTPException(409, "原UUID已有未确认的来源捕获，请查询原UUID")

    async def operation(self, conn, who, request, fingerprint, result, action):
        await conn.execute(
            "INSERT INTO resource_import_operations(owner_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)",
            (who.id, request, fingerprint, Jsonb(result)),
        )
        await conn.execute(
            "INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,%s,%s,%s)",
            (who.id, action, result.get("manifestId", result.get("consentId", request)), request),
        )
        return result

    async def register(self, who, data):
        request = uid(data["requestId"])
        fingerprint = sha(canonical({"kind": "resource-register", **data}))
        async with self.db.connection() as conn, conn.transaction():
            await self.lock(conn, who, admin=True)
            prior = await self.prior(conn, who, request, fingerprint)
            if prior:
                return prior
            definition = self.authority.registry.get(data["sourceAlias"])
            resource = self.resources.get(data["sourceAlias"])
            if not definition or not resource or data["sourceOwner"] not in definition.owners:
                raise HTTPException(403, "此资源来源或原账号未由操作员登记")
            try:
                definition.require_access(data["sourceOwner"])
            except SourceMismatch as error:
                raise HTTPException(409, access_error_message(error)) from None
            resource.check()
            rows = await self.authority.check_claim(
                conn,
                definition.instance,
                data["sourceOwner"],
                data["targetUserId"],
                physical_identity_hash(definition),
            )
            if len(rows) != 1:
                raise HTTPException(409, "先通过共享来源核验建立不可变账号归属")
            target = await (
                await conn.execute(
                    "SELECT id FROM users WHERE id=%s AND active FOR SHARE", (data["targetUserId"],)
                )
            ).fetchone()
            if not target:
                raise HTTPException(404, "目标账号不存在或已停用")
            if await (
                await conn.execute(
                    "SELECT 1 FROM resource_source_consents WHERE source_instance=%s AND source_owner=%s AND state<>'revoked'",
                    (definition.instance, data["sourceOwner"]),
                )
            ).fetchone():
                raise HTTPException(409, "该来源已有待确认或有效的资源授权")
            identifier = uuid4()
            await conn.execute(
                "INSERT INTO resource_source_consents(id,owner_id,platform_instance,source_alias,source_instance,source_owner,physical_identity_hash,binding_hash,scope,state,registered_by) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,'resources.migrate','pending_owner',%s)",
                (
                    identifier,
                    target["id"],
                    self.db.settings.instance_id,
                    definition.alias,
                    definition.instance,
                    data["sourceOwner"],
                    physical_identity_hash(definition),
                    resource.binding(definition),
                    who.id,
                ),
            )
            return await self.operation(
                conn,
                who,
                request,
                fingerprint,
                {
                    "requestId": request,
                    "state": "completed",
                    "consentId": str(identifier),
                    "revision": 1,
                    "permissionState": "pending_owner",
                    "scope": "resources.migrate",
                },
                "resource-source.register",
            )

    async def approve(self, who, identifier, data):
        request = uid(data["requestId"])
        fingerprint = sha(
            canonical(
                {
                    "kind": "resource-consent",
                    "consentId": str(identifier),
                    "revision": data["revision"],
                    "approve": data["approve"],
                }
            )
        )
        async with self.db.connection() as conn, conn.transaction():
            await self.lock(conn, who)
            prior = await self.prior(conn, who, request, fingerprint)
            if prior:
                return prior
            await self.passkeys.step_up(conn, who, data["password"], data["code"])
            row = await (
                await conn.execute(
                    "SELECT * FROM resource_source_consents WHERE id=%s AND owner_id=%s FOR UPDATE",
                    (identifier, who.id),
                )
            ).fetchone()
            if not row:
                raise HTTPException(404, "本人资源授权不存在")
            if (
                row["revision"] != data["revision"]
                or row["state"] == "revoked"
                or row["revision"] >= 9007199254740991
            ):
                raise HTTPException(409, "授权修订已变化")
            if data["approve"]:
                self.definitions(row)
                if row["state"] != "pending_owner":
                    raise HTTPException(409, "此资源授权已确认")
            state = "active" if data["approve"] else "revoked"
            await conn.execute(
                "UPDATE resource_source_consents SET state=%s,revision=revision+1,approved_at=CASE WHEN %s='active' THEN clock_timestamp() ELSE approved_at END,revoked_at=CASE WHEN %s='revoked' THEN clock_timestamp() ELSE NULL END WHERE id=%s",
                (state, state, state, identifier),
            )
            return await self.operation(
                conn,
                who,
                request,
                fingerprint,
                {
                    "requestId": request,
                    "state": "completed",
                    "consentId": str(identifier),
                    "revision": row["revision"] + 1,
                    "permissionState": state,
                    "scope": "resources.migrate",
                },
                "resource-source.consent",
            )

    async def grants(self, who):
        async with self.db.connection() as conn, conn.transaction():
            await lock_mutation_identity(conn, who, require_admin=False)
            rows = await (
                await conn.execute(
                    "SELECT * FROM resource_source_consents WHERE owner_id=%s ORDER BY created_at,id",
                    (who.id,),
                )
            ).fetchall()
            return {
                "items": [
                    {
                        "id": str(r["id"]),
                        "sourceAlias": r["source_alias"],
                        "sourceInstance": r["source_instance"],
                        "sourceOwner": r["source_owner"],
                        "scope": r["scope"],
                        "migrationWindow": self.authority.registry[r["source_alias"]].window_status()
                        if r["source_alias"] in self.authority.registry
                        else {"state": "unavailable"},
                        "revision": r["revision"],
                        "state": r["state"],
                        "effective": r["state"] == "active"
                        and r["platform_instance"] == self.db.settings.instance_id
                        and self.binding_valid(r),
                    }
                    for r in rows
                ]
            }

    def binding_valid(self, row):
        # Listing never probes source databases or reads originals.
        definition = self.authority.registry.get(row["source_alias"])
        resource = self.resources.get(row["source_alias"])
        if definition and definition.window_status()["state"] != "active":
            return False
        return bool(
            definition
            and resource
            and definition.instance == row["source_instance"]
            and resource.binding(definition) == row["binding_hash"]
        )

    async def snapshot(self, who, identifier, data):
        request = uid(data["requestId"])
        fingerprint = sha(canonical({"kind": "resource-capture", "consentId": str(identifier), **data}))
        manifest_id = uuid4()
        async with self.db.connection() as conn, conn.transaction():
            await self.lock(conn, who)
            prior = await self.prior(conn, who, request, fingerprint)
            if prior:
                return prior
            grant = await self.consent(conn, who, identifier, data["revision"])
            prior = await (
                await conn.execute(
                    "SELECT id,fingerprint,state FROM resource_import_manifests WHERE owner_id=%s AND request_id=%s",
                    (who.id, request),
                )
            ).fetchone()
            if prior:
                if prior["fingerprint"] != fingerprint:
                    raise HTTPException(409, "原UUID已用于其他来源快照")
                return {
                    "requestId": request,
                    "manifestId": str(prior["id"]),
                    "state": "pending" if prior["state"] == "capturing" else prior["state"],
                }
            if await (
                await conn.execute(
                    "SELECT 1 FROM resource_import_manifests WHERE owner_id=%s AND state='capturing'",
                    (who.id,),
                )
            ).fetchone():
                raise HTTPException(409, "已有未确认的来源捕获，请查询原UUID或显式关闭")
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended('resource-source-capture-budget',0))"
            )
            budget = await (
                await conn.execute(
                    "SELECT coalesce(sum(CASE WHEN state='capturing' THEN 134217728 ELSE coalesce((manifest->>'rawBytes')::bigint,0)*4 END) FILTER(WHERE owner_id=%s),0) owner_bytes,coalesce(sum(CASE WHEN state='capturing' THEN 134217728 ELSE coalesce((manifest->>'rawBytes')::bigint,0)*4 END),0) instance_bytes,count(*) FILTER(WHERE state='capturing') pending FROM resource_import_manifests",
                    (who.id,),
                )
            ).fetchone()
            if (
                budget["owner_bytes"] + 134217728 > 268435456
                or budget["instance_bytes"] + 134217728 > 1073741824
                or budget["pending"] >= 2
            ):
                raise HTTPException(409, "资源来源捕获预算不足，未读取来源；既有证据不会自动清除")
            await conn.execute(
                "INSERT INTO resource_import_manifests(id,owner_id,consent_id,request_id,fingerprint,consent_revision,platform_instance,state) VALUES(%s,%s,%s,%s,%s,%s,%s,'capturing')",
                (
                    manifest_id,
                    who.id,
                    identifier,
                    request,
                    fingerprint,
                    grant["revision"],
                    self.db.settings.instance_id,
                ),
            )
        try:
            async with self.db.connection() as conn, conn.transaction():
                await self.lock(conn, who)
                grant = await self.consent(conn, who, identifier, data["revision"])
                row = await (
                    await conn.execute(
                        "SELECT state FROM resource_import_manifests WHERE id=%s FOR UPDATE", (manifest_id,)
                    )
                ).fetchone()
                if row["state"] != "capturing":
                    raise HTTPException(409, "来源捕获已关闭，请查询原UUID")
                definition, resource = self.definitions(grant)
                hashed = hashlib.sha256()
                seq = 0

                async def consume(kind, raw):
                    nonlocal seq
                    seq += 1
                    raw_bytes = canonical(raw)
                    digest = sha(raw_bytes)
                    hashed.update(canonical([seq, kind, digest]) + b"\n")
                    reason = None
                    try:
                        normalized = normalize(kind, raw, grant["source_owner"], definition.timezone)
                    except (ValueError, TypeError, KeyError, HTTPException):
                        normalized = None
                        reason = "source_record_validation_required"
                    key = "request_id" if kind == "operation" else "id"
                    source_id = raw.get(key, {}).get("text")
                    if not isinstance(source_id, str) or not source_id or len(source_id) > 200:
                        source_id = "unresolved-record-" + str(seq)
                    await conn.execute(
                        "INSERT INTO resource_import_records(manifest_id,seq,kind,source_id,raw,raw_sha256,normalized,state,reason) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                        (
                            manifest_id,
                            seq,
                            kind,
                            source_id,
                            Jsonb(raw),
                            digest,
                            Jsonb(normalized) if normalized else None,
                            "blocked" if reason else "pending",
                            reason,
                        ),
                    )

                metadata = await capture(
                    definition, resource, grant["source_owner"], consume, self.after_table
                )
                metadata.update(
                    {
                        "sourceInstance": grant["source_instance"],
                        "sourceOwner": grant["source_owner"],
                        "resourceScope": "resources.migrate",
                        "recordsDigest": hashed.hexdigest(),
                        "recordCount": seq,
                        "coverage": {"F26": "owner-indexed-only", "F28": "not-included"},
                        "financialApplied": False,
                    }
                )
                digest = sha(canonical(metadata))
                await conn.execute(
                    "UPDATE resource_import_manifests SET state='sealed',manifest=%s,digest=%s,sealed_at=clock_timestamp() WHERE id=%s",
                    (Jsonb(metadata), digest, manifest_id),
                )
                # All known original UUIDs are fenced in the same commit as the
                # sealed metadata, even if source bytes are missing/pending.
                async with conn.cursor(name="resource_originals_to_fence") as cursor:
                    cursor.itersize = 4
                    await cursor.execute(
                        "SELECT seq,source_id,normalized,raw_sha256,raw FROM resource_import_records WHERE manifest_id=%s AND kind='operation' ORDER BY seq",
                        (manifest_id,),
                    )
                    async for record in cursor:
                        await self.fence_original(conn, who, manifest_id, record)
                result = {
                    "requestId": request,
                    "manifestId": str(manifest_id),
                    "state": "completed",
                    "metadataComplete": True,
                    "targetImportCompleted": False,
                    "digest": digest,
                }
                return await self.operation(
                    conn, who, request, fingerprint, result, "resource-source.captured"
                )
        except (
            ResourceSourceError,
            OSError,
            ValueError,
            HTTPException,
            psycopg.errors.InsufficientPrivilege,
        ) as error:
            code = str(error) if isinstance(error, ResourceSourceError) else "source_capture_not_confirmed"
            async with self.db.connection() as conn, conn.transaction():
                await self.lock(conn, who)
                row = await (
                    await conn.execute(
                        "SELECT state FROM resource_import_manifests WHERE id=%s FOR UPDATE", (manifest_id,)
                    )
                ).fetchone()
                if row["state"] == "capturing":
                    await conn.execute(
                        "UPDATE resource_import_manifests SET state='failed' WHERE id=%s", (manifest_id,)
                    )
                    return await self.operation(
                        conn,
                        who,
                        request,
                        fingerprint,
                        {
                            "requestId": request,
                            "manifestId": str(manifest_id),
                            "state": "failed",
                            "reason": code,
                            "targetImportCompleted": False,
                        },
                        "resource-source.capture-failed",
                    )
            raise

    async def fence_original(self, conn, who, manifest_id, record):
        normalized = record["normalized"]
        if not normalized:
            try:
                rid = uid(record["source_id"])
            except HTTPException:
                return
            kind = record["raw"].get("type", {}).get("text")
            kind = kind if kind in ("upload", "delete") else "unverified"
            projection = {
                "requestId": rid,
                "kind": kind,
                "state": "unverified",
                "sourceEvidence": True,
                "targetImportCompleted": False,
            }
        else:
            rid, kind, projection = normalized["request_id"], normalized["type"], normalized["projection"]
        previous = await (
            await conn.execute(
                "SELECT o.*,r.raw_sha256 FROM resource_import_originals o JOIN resource_import_records r ON r.manifest_id=o.manifest_id AND r.seq=o.record_seq WHERE o.owner_id=%s AND o.request_id=%s",
                (who.id, rid),
            )
        ).fetchone()
        if previous:
            if previous["raw_sha256"] != record["raw_sha256"]:
                await conn.execute(
                    "UPDATE resource_import_records SET state='blocked',reason='original_uuid_history_changed' WHERE manifest_id=%s AND seq=%s",
                    (manifest_id, record["seq"]),
                )
            return
        if await (
            await conn.execute(
                "SELECT 1 FROM resource_operation_receipts WHERE owner_id=%s AND request_id=%s", (who.id, rid)
            )
        ).fetchone():
            await conn.execute(
                "UPDATE resource_import_records SET state='blocked',reason='original_uuid_target_collision' WHERE manifest_id=%s AND seq=%s",
                (manifest_id, record["seq"]),
            )
            return
        await conn.execute(
            "INSERT INTO resource_import_originals(owner_id,request_id,manifest_id,record_seq,kind,projection) VALUES(%s,%s,%s,%s,%s,%s)",
            (who.id, rid, manifest_id, record["seq"], kind, Jsonb(projection)),
        )

    async def close_capture(self, who, original):
        original = uid(original)
        async with self.db.connection() as conn, conn.transaction():
            await self.lock(conn, who)
            row = await (
                await conn.execute(
                    "SELECT * FROM resource_import_manifests WHERE owner_id=%s AND request_id=%s FOR UPDATE",
                    (who.id, original),
                )
            ).fetchone()
            if not row:
                raise HTTPException(404, "本人资源捕获操作不存在")
            prior = await self.prior(conn, who, original, row["fingerprint"])
            if prior:
                return prior
            if row["state"] != "capturing":
                raise HTTPException(409, "捕获已终结，请查询原UUID")
            await conn.execute(
                "UPDATE resource_import_manifests SET state='failed' WHERE id=%s", (row["id"],)
            )
            return await self.operation(
                conn,
                who,
                original,
                row["fingerprint"],
                {
                    "requestId": original,
                    "manifestId": str(row["id"]),
                    "state": "failed",
                    "reason": "explicitly_closed",
                    "targetImportCompleted": False,
                },
                "resource-source.capture-closed",
            )

    async def manifest(self, conn, who, identifier):
        row = await (
            await conn.execute(
                "SELECT * FROM resource_import_manifests WHERE id=%s AND owner_id=%s", (identifier, who.id)
            )
        ).fetchone()
        if not row:
            raise HTTPException(404, "本人资源来源清单不存在")
        return row

    async def summary(self, conn, identifier):
        counts = await (
            await conn.execute(
                "SELECT kind,state,count(*) n FROM resource_import_records WHERE manifest_id=%s GROUP BY kind,state ORDER BY kind,state",
                (identifier,),
            )
        ).fetchall()
        remaining = sum(r["n"] for r in counts if r["state"] != "applied")
        manifest = await (await conn.execute(
            "SELECT state FROM resource_import_manifests WHERE id=%s", (identifier,)
        )).fetchone()
        return {
            "counts": [{"kind": r["kind"], "state": r["state"], "count": r["n"]} for r in counts],
            "remaining": remaining,
            "targetImportCompleted": bool(manifest and manifest["state"] == "sealed" and remaining == 0),
        }

    async def read_manifest(self, who, identifier, after=0):
        async with self.db.connection() as conn, conn.transaction():
            await lock_mutation_identity(conn, who, require_admin=False)
            row = await self.manifest(conn, who, identifier)
            records = await (
                await conn.execute(
                    "SELECT seq,kind,source_id,raw_sha256,normalized,state,reason,attempts FROM resource_import_records WHERE manifest_id=%s AND seq>%s ORDER BY seq LIMIT 101",
                    (identifier, after),
                )
            ).fetchall()
            return {
                "id": str(identifier),
                "state": row["state"],
                "digest": row["digest"],
                "manifest": row["manifest"],
                **await self.summary(conn, identifier),
                "items": records[:100],
                "nextAfter": records[99]["seq"] if len(records) > 100 else None,
            }

    async def raw(self, who, identifier, sequence):
        async with self.db.connection() as conn, conn.transaction():
            await lock_mutation_identity(conn, who, require_admin=False)
            await self.manifest(conn, who, identifier)
            row = await (
                await conn.execute(
                    "SELECT raw,raw_sha256 FROM resource_import_records WHERE manifest_id=%s AND seq=%s",
                    (identifier, sequence),
                )
            ).fetchone()
            if not row:
                raise HTTPException(404, "原记录不存在")
            return {"raw": row["raw"], "sha256": row["raw_sha256"]}

    async def target_token(self, conn, who, manifest):
        hashed = hashlib.sha256(
            canonical(
                [
                    who.id,
                    str(self.db.settings.instance_id),
                    str(manifest["id"]),
                    manifest["digest"],
                    manifest["consent_revision"],
                ]
            )
        )
        for table, columns, where, params in (
            (
                "resource_folders",
                "id,category,parent_id,name,revision,created_at,deleted_at",
                "owner_id=%s",
                (who.id,),
            ),
            (
                "resource_files",
                "id,category,folder_id,name,sha256,revision,created_at,deleted_at",
                "owner_id=%s",
                (who.id,),
            ),
            ("resource_operation_receipts", "request_id,kind,result", "owner_id=%s", (who.id,)),
            ("resource_import_records", "seq,state,reason,attempts", "manifest_id=%s", (manifest["id"],)),
        ):
            order = (
                "request_id"
                if table == "resource_operation_receipts"
                else "seq"
                if table == "resource_import_records"
                else "id"
            )
            # Literal names above are a fixed private allowlist, never HTTP text.
            async with conn.cursor(name="resource_target_" + table) as cursor:
                cursor.itersize = 32
                await cursor.execute(
                    "SELECT row_to_json(t)::text raw FROM (SELECT "
                    + columns
                    + " FROM "
                    + table
                    + " WHERE "
                    + where
                    + " ORDER BY "
                    + order
                    + ") t",
                    params,
                )
                async for row in cursor:
                    hashed.update(table.encode() + b":" + row["raw"].encode() + b"\n")
        return hashed.hexdigest()

    async def preview(self, who, identifier, revision):
        async with self.db.connection() as conn, conn.transaction():
            await self.lock(conn, who)
            row = await self.manifest(conn, who, identifier)
            await self.consent(conn, who, row["consent_id"], revision)
            if row["state"] != "sealed" or row["consent_revision"] != revision:
                raise HTTPException(409, "清单或授权修订不匹配")
            return {
                "manifestId": str(identifier),
                "preview": await self.target_token(conn, who, row),
                "revision": revision,
                **await self.summary(conn, identifier),
                "usage": await self.library.usage(conn, who.id),
            }

    async def segment(self, who, identifier, data):
        request = uid(data["requestId"])
        fingerprint = sha(canonical({"kind": "resource-segment", "manifestId": str(identifier), **data}))
        async with self.db.connection() as conn, conn.transaction():
            await self.lock(conn, who)
            prior = await self.prior(conn, who, request, fingerprint)
            if prior:
                return prior
            manifest = await self.manifest(conn, who, identifier)
            grant = await self.consent(conn, who, manifest["consent_id"], data["revision"])
            if (
                manifest["state"] != "sealed"
                or manifest["consent_revision"] != data["revision"]
                or data["preview"] != await self.target_token(conn, who, manifest)
            ):
                raise HTTPException(409, "来源清单、资源目标或授权版本已变化，请重新预览")
            _, resource = self.definitions(grant)
            rows = await (
                await conn.execute(
                    "SELECT * FROM resource_import_records WHERE manifest_id=%s AND state<>'applied' AND (state='pending' OR %s) ORDER BY CASE kind WHEN 'folder' THEN 0 WHEN 'file' THEN 1 ELSE 2 END,seq LIMIT %s",
                    (identifier, data["retryBlocked"], data["maxItems"]),
                )
            ).fetchall()
            outcomes = []
            for row in rows:
                reason = None
                try:
                    async with conn.transaction():
                        await self.apply_record(conn, who, manifest, grant, resource, row)
                except (HTTPException, ResourceSourceError, ValueError) as error:
                    reason = (
                        str(error)
                        if isinstance(error, ResourceSourceError)
                        else str(error.detail)
                        if isinstance(error, HTTPException)
                        else "source_record_requires_review"
                    )
                except (psycopg.IntegrityError, psycopg.errors.RaiseException):
                    reason = "target_constraints_conflict"
                except OSError:
                    reason = "private_storage_not_durable"
                await conn.execute(
                    "UPDATE resource_import_records SET state=%s,reason=%s,attempts=attempts+1 WHERE manifest_id=%s AND seq=%s",
                    ("blocked" if reason else "applied", reason, identifier, row["seq"]),
                )
                outcomes.append(
                    {
                        "seq": row["seq"],
                        "kind": row["kind"],
                        "state": "blocked" if reason else "applied",
                        "reason": reason,
                    }
                )
            result = {
                "requestId": request,
                "state": "completed",
                "manifestId": str(identifier),
                "outcomes": outcomes,
                **await self.summary(conn, identifier),
                "usage": await self.library.usage(conn, who.id),
            }
            return await self.operation(conn, who, request, fingerprint, result, "resource-source.segment")

    async def apply_record(self, conn, who, manifest, grant, resource, row):
        value = row["normalized"]
        if not value:
            raise ValueError()
        if row["reason"] in ("original_uuid_history_changed", "original_uuid_target_collision"):
            raise HTTPException(409, row["reason"])
        identifier = value.get("id")
        if row["kind"] == "folder":
            existing = await (
                await conn.execute("SELECT * FROM resource_folders WHERE id=%s", (identifier,))
            ).fetchone()
            if existing:
                raise HTTPException(409, "target_folder_id_collision")
            if value["parent_id"]:
                parent = await self.library.folder(conn, who.id, value["parent_id"])
                if parent["category"] != value["category"]:
                    raise HTTPException(409, "source_parent_category_mismatch")
            if await (
                await conn.execute(
                    "SELECT 1 FROM resource_folders WHERE owner_id=%s AND category=%s AND parent_id IS NOT DISTINCT FROM %s AND name=%s AND deleted_at IS NULL",
                    (who.id, value["category"], value["parent_id"], value["name"]),
                )
            ).fetchone():
                raise HTTPException(409, "target_folder_name_collision")
            # Native PG guards enforce total folders, cycle and full subtree depth.
            await conn.execute(
                "INSERT INTO resource_folders(id,owner_id,category,parent_id,name,revision,created_at) VALUES(%s,%s,%s,%s,%s,%s,%s)",
                (
                    identifier,
                    who.id,
                    value["category"],
                    value["parent_id"],
                    value["name"],
                    value["revision"],
                    value["created_at"],
                ),
            )
            await self.library.bump(conn, who.id, (value["parent_id"],))
            return
        if row["kind"] == "file":
            conflict = await (
                await conn.execute(
                    "SELECT 1 FROM resource_import_records WHERE manifest_id=%s AND kind='operation' AND normalized->>'file_id'=%s AND reason IN ('original_uuid_target_collision','original_uuid_history_changed') LIMIT 1",
                    (manifest["id"], identifier),
                )
            ).fetchone()
            if conflict:
                raise HTTPException(409, "source_file_original_uuid_conflict")
            if value["state"] in ("uploading", "deleting"):
                raise HTTPException(409, "source_operation_unsettled_explicit_resolution_required")
            existing = await (
                await conn.execute(
                    "SELECT import_manifest_id,import_record_seq FROM resource_files WHERE id=%s",
                    (identifier,),
                )
            ).fetchone()
            if existing:
                if (
                    existing["import_manifest_id"] == manifest["id"]
                    and existing["import_record_seq"] == row["seq"]
                ):
                    return
                raise HTTPException(409, "target_file_id_collision")
            deleted = value["state"] == "deleted"
            folder = value["folder_id"]
            if folder:
                parent = await (
                    await conn.execute(
                        "SELECT owner_id,category,deleted_at FROM resource_folders WHERE id=%s", (folder,)
                    )
                ).fetchone()
                if (
                    not parent
                    or parent["owner_id"] != who.id
                    or parent["category"] != value["category"]
                    or parent["deleted_at"]
                ):
                    if not deleted:
                        raise HTTPException(409, "source_parent_not_available")
                    folder = None  # Original deleted parent remains exact in sealed raw.
            if not deleted:
                usage = await self.library.usage(conn, who.id)
                if (
                    usage["usedBytes"] + value["size_bytes"] > usage["quotaBytes"]
                    or usage["fileCount"] >= 5000
                ):
                    raise HTTPException(409, "target_resource_quota_exceeded")
                raw = await asyncio.to_thread(
                    resource.read_original,
                    grant["source_owner"],
                    identifier,
                    value["size_bytes"],
                    value["sha256"],
                )
                if classify(raw, value["name"], value["category"]) != (value["kind"], value["mime"]):
                    raise HTTPException(409, "source_format_metadata_mismatch")
                if value["category"] == "media" and value["kind"] not in ("image", "video", "audio"):
                    raise HTTPException(409, "source_media_category_invalid")
                await self.library.media.stage(conn, who.id, raw)
            await conn.execute(
                "INSERT INTO resource_files(id,owner_id,category,folder_id,name,kind,mime,size_bytes,sha256,object_sha256,revision,created_at,deleted_at,import_manifest_id,import_record_seq) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,CASE WHEN %s THEN clock_timestamp() ELSE NULL END,%s,%s)",
                (
                    identifier,
                    who.id,
                    value["category"],
                    folder,
                    value["name"],
                    value["kind"],
                    value["mime"],
                    value["size_bytes"],
                    value["sha256"],
                    None if deleted else value["sha256"],
                    value["revision"],
                    value["created_at"],
                    deleted,
                    manifest["id"],
                    row["seq"],
                ),
            )
            if not deleted:
                await self.library.bump(conn, who.id, (folder,))
            return
        # Keep the exact old result and original UUID; never compute old usedBytes
        # from today's target usage and never settle unknown operations on GET.
        projection = value["projection"]
        original = await (
            await conn.execute(
                "SELECT manifest_id,record_seq FROM resource_import_originals WHERE owner_id=%s AND request_id=%s",
                (who.id, value["request_id"]),
            )
        ).fetchone()
        if not original or (original["manifest_id"], original["record_seq"]) != (manifest["id"], row["seq"]):
            raise HTTPException(409, "original_uuid_provenance_conflict")
        canonical_receipt = await (
            await conn.execute(
                "SELECT result,kind FROM resource_operation_receipts WHERE owner_id=%s AND request_id=%s",
                (who.id, value["request_id"]),
            )
        ).fetchone()
        if canonical_receipt:
            if (
                projection["state"] == "pending"
                and canonical_receipt["result"].get("cancelled")
                and canonical_receipt["kind"] == value["type"]
            ):
                return
            raise HTTPException(409, "original_uuid_target_collision")
        if projection["state"] == "pending":
            raise HTTPException(409, "source_operation_unsettled_explicit_resolution_required")
        if projection["state"] == "completed":
            file = await (
                await conn.execute(
                    "SELECT * FROM resource_files WHERE id=%s AND owner_id=%s", (value["file_id"], who.id)
                )
            ).fetchone()
            if not file:
                raise HTTPException(409, "source_receipt_file_not_imported")
            result = projection["result"]
            if value["type"] == "upload":
                if (
                    result.get("sha256") != file["sha256"]
                    or result.get("sizeBytes") != file["size_bytes"]
                    or result.get("kind") != file["kind"]
                    or result.get("mime") != file["mime"]
                    or result.get("category") != file["category"]
                    or datetime.fromisoformat(result["createdAt"]) != file["created_at"]
                    or result["revision"] > file["revision"]
                ):
                    raise HTTPException(409, "source_receipt_original_mismatch")
            elif not file["deleted_at"] or result["removedBytes"] != file["size_bytes"]:
                raise HTTPException(409, "source_deletion_receipt_mismatch")
        result = {**projection, "targetImportCompleted": True}
        await conn.execute(
            "INSERT INTO resource_operation_receipts(owner_id,request_id,kind,result) VALUES(%s,%s,%s,%s)",
            (who.id, value["request_id"], value["type"], Jsonb(result)),
        )

    async def receipt(self, who, request):
        async with self.db.connection() as conn, conn.transaction():
            await lock_mutation_identity(conn, who, require_admin=False)
            row = await (
                await conn.execute(
                    "SELECT result FROM resource_import_operations WHERE owner_id=%s AND request_id=%s",
                    (who.id, request),
                )
            ).fetchone()
            if row:
                return project(row["result"], BASE)
            row = await (
                await conn.execute(
                    "SELECT id,state FROM resource_import_manifests WHERE owner_id=%s AND request_id=%s",
                    (who.id, request),
                )
            ).fetchone()
            if row:
                return {
                    "requestId": str(request),
                    "manifestId": str(row["id"]),
                    "state": "pending" if row["state"] == "capturing" else "failed",
                    "targetImportCompleted": False,
                }
            raise HTTPException(404, "本人资源迁移操作不存在")
