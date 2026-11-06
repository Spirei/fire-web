"""Attested legacy font capture and CAS application into the single PersonalFonts service."""

import asyncio
import json
import sqlite3
from uuid import uuid4

import psycopg
from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .font_codec import font_name, validate_font
from .font_source_files import read as read_source
from .font_source_files import registered, roots
from .font_source_owner import verify_owner
from .personal_fonts import PATTERN, PersonalFonts
from .source_snapshot import SourceMismatch, canonical, sha
from .source_window import access_error_message


def public_permission(row):
    return {
        "id": str(row["id"]),
        "grantId": str(row["grant_id"]),
        "ownerId": row["owner_id"],
        "sourceAlias": row["source_alias"],
        "sourceOwner": row["source_owner"],
        "sourceInstance": row["source_instance"],
        "originalId": row["original_id"],
        "scope": row["scope"],
        "state": row["state"],
        "revision": row["revision"],
        "name": row["name"],
        "evidenceRef": row["evidence_ref"],
        "ownershipEvidence": "admin-and-owner-attested",
        "historicalUploaderVerified": False,
    }


class FontSourceImport:
    def __init__(self, db, authority):
        self.db, self.authority = db, authority
        self.fonts = PersonalFonts(db)
        self.after_read = None
        self.after_store = None

    async def prior(self, conn, who, request, kind=None, fingerprint=None):
        if await (
            await conn.execute(
                "SELECT 1 FROM personal_font_operations WHERE owner_id=%s AND request_id=%s",
                (who.id, request),
            )
        ).fetchone():
            raise HTTPException(409, "原UUID已用于字体上传，请查询原上传回执")
        row = await (
            await conn.execute(
                "SELECT * FROM personal_font_source_operations WHERE owner_id=%s AND request_id=%s",
                (who.id, request),
            )
        ).fetchone()
        if row and (
            kind
            and row["kind"] != kind
            or fingerprint
            and row["fingerprint"] != fingerprint
            and not row["result"].get("canceled")
        ):
            raise HTTPException(409, "原UUID已用于不同字体来源操作")
        return row

    async def record(self, conn, who, request, kind, fingerprint, result):
        await conn.execute(
            "INSERT INTO personal_font_source_operations(owner_id,request_id,kind,fingerprint,state,result) VALUES(%s,%s,%s,%s,%s,%s)",
            (who.id, request, kind, fingerprint, result["state"], Jsonb(result)),
        )
        await conn.execute(
            "INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,%s,%s,%s)",
            (who.id, "font-source." + kind, result.get("permissionId", who.id), request),
        )

    async def grant(self, conn, who, permission, *, live):
        row = await (
            await conn.execute(
                "SELECT g.* FROM legacy_source_grants g JOIN alcor_instance i ON i.instance_id=g.platform_instance WHERE g.id=%s AND g.owner_id=%s AND g.state='active' FOR SHARE OF g",
                (permission["grant_id"], who.id),
            )
        ).fetchone()
        if (
            not row
            or row["revision"] != permission["grant_revision"]
            or row["platform_instance"] != self.db.settings.instance_id
            or row["binding_hash"] != permission["binding_hash"]
            or row["physical_identity_hash"] != permission["physical_identity_hash"]
        ):
            raise HTTPException(409, "平台字体来源授权已撤销、实例或修订已变化")
        claims = await self.authority.check_claim(
            conn, row["source_instance"], row["source_owner"], who.id, row["physical_identity_hash"]
        )
        if claims and any(c["platform_instance"] != row["platform_instance"] for c in claims):
            raise HTTPException(409, "来源归属尚未在本实例核对")
        if live:
            try:
                registered(self.db.settings, permission, live=True)
            except SourceMismatch as error:
                raise HTTPException(409, access_error_message(error)) from None
        return row, claims

    async def permission(self, conn, who, identifier, revision=None, *, active=False, live=False):
        row = await (
            await conn.execute(
                "SELECT * FROM personal_font_source_permissions WHERE owner_id=%s AND id=%s FOR SHARE",
                (who.id, identifier),
            )
        ).fetchone()
        if not row:
            raise HTTPException(404, "本人字体来源许可不存在")
        if revision is not None and row["revision"] != revision:
            raise HTTPException(409, "字体迁移许可修订已变化")
        if active and row["state"] != "active":
            raise HTTPException(409, "字体迁移尚未获得本人明确同意或已撤销")
        grant, claims = await self.grant(conn, who, row, live=live)
        if active and len(claims) != 1:
            raise HTTPException(409, "缺少永久来源账号归属，不能应用字体")
        return row, grant

    async def options(self, who):
        async with self.fonts.context(who) as (conn, user):
            if user["role"] != "admin":
                raise HTTPException(403, "需要管理员权限")
            configuration = "configured" if self.db.settings.font_import_registry_path else "not_configured"
            try:
                available = roots(self.db.settings)
            except SourceMismatch:
                available = {}
                configuration = "unavailable"
            grants = await (
                await conn.execute(
                    "SELECT g.*,u.username,u.uid FROM legacy_source_grants g JOIN users u ON u.id=g.owner_id WHERE g.state='active' AND u.active AND g.platform_instance=%s ORDER BY g.created_at,g.id LIMIT 200",
                    (self.db.settings.instance_id,),
                )
            ).fetchall()
            return {
                "configuration": {"state": configuration},
                "items": [
                    {
                        "grantId": str(g["id"]),
                        "grantRevision": g["revision"],
                        "ownerId": g["owner_id"],
                        "username": g["username"],
                        "publicUid": g["uid"],
                        "sourceAlias": g["source_alias"],
                        "sourceOwner": g["source_owner"],
                        "window": available[g["source_alias"]].definition.window_status(),
                        "ownershipEvidence": "admin-and-owner-attested",
                    }
                    for g in grants
                    if g["source_alias"] in available
                ]
            }

    async def register(self, who, data):
        request = data["requestId"]
        fingerprint = sha(canonical(["register", data]))
        async with self.fonts.context(who, True) as (conn, user):
            if user["role"] != "admin":
                raise HTTPException(403, "需要管理员权限")
            old = await self.prior(conn, who, request, "register", fingerprint)
            if old:
                return old["result"]
            grant = await (
                await conn.execute(
                    "SELECT g.* FROM legacy_source_grants g JOIN users u ON u.id=g.owner_id WHERE g.id=%s AND g.state='active' AND u.active AND g.platform_instance=%s FOR SHARE OF g,u",
                    (data["grantId"], self.db.settings.instance_id),
                )
            ).fetchone()
            if not grant or grant["revision"] != data["grantRevision"]:
                raise HTTPException(409, "已核对的来源授权不存在或已变化")
            try:
                root = roots(self.db.settings).get(grant["source_alias"])
                if not root:
                    raise SourceMismatch("font_source_root_not_registered")
                root.definition.require_access(grant["source_owner"])
                from .source_authority import definition_hash

                if definition_hash(root.definition) != grant["binding_hash"]:
                    raise SourceMismatch("font_source_registration_changed")
            except SourceMismatch as error:
                raise HTTPException(409, access_error_message(error)) from None
            if not PATTERN.fullmatch(data["originalId"]):
                raise HTTPException(422, "旧字体编号无效")
            await self.authority.check_claim(
                conn,
                grant["source_instance"],
                grant["source_owner"],
                grant["owner_id"],
                grant["physical_identity_hash"],
            )
            count = await (
                await conn.execute(
                    "SELECT count(*) n FROM personal_font_source_permissions WHERE owner_id=%s",
                    (grant["owner_id"],),
                )
            ).fetchone()
            if count["n"] >= 100:
                raise HTTPException(409, "本人字体来源登记已达 100 项限额")
            if await (
                await conn.execute(
                    "SELECT 1 FROM personal_font_source_permissions WHERE root_identity=%s AND original_id=%s",
                    (root.physical, data["originalId"]),
                )
            ).fetchone():
                raise HTTPException(409, "此原文件已有不可变目标登记，不能另分配归属")
            identifier = uuid4()
            row = await (
                await conn.execute(
                    "INSERT INTO personal_font_source_permissions(id,owner_id,grant_id,grant_revision,platform_instance,source_alias,source_instance,source_owner,binding_hash,physical_identity_hash,root_binding,root_identity,original_id,state,registered_by,evidence_ref) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'pending_owner',%s,%s) ON CONFLICT(root_identity,original_id) DO NOTHING RETURNING *",
                    (
                        identifier,
                        grant["owner_id"],
                        grant["id"],
                        grant["revision"],
                        grant["platform_instance"],
                        grant["source_alias"],
                        grant["source_instance"],
                        grant["source_owner"],
                        grant["binding_hash"],
                        grant["physical_identity_hash"],
                        root.binding,
                        root.physical,
                        data["originalId"],
                        who.id,
                        data["evidenceRef"],
                    ),
                )
            ).fetchone()
            if not row:
                raise HTTPException(409, "此原文件已有不可变目标登记，不能另分配归属")
            result = {
                "requestId": request,
                "kind": "register",
                "state": "completed",
                "permissionId": str(identifier),
                "permission": public_permission(row),
            }
            await self.record(conn, who, request, "register", fingerprint, result)
            return result

    async def consent(self, who, identifier, data):
        request = data["requestId"]
        # Secrets never enter any fingerprint, receipt, log or persistent row.
        fingerprint = sha(
            canonical(
                ["consent", str(identifier), {k: v for k, v in data.items() if k not in ("password", "code")}]
            )
        )
        async with self.fonts.context(who, True) as (conn, _):
            old = await self.prior(conn, who, request, "consent", fingerprint)
            if old:
                return old["result"]
            await self.authority.passkeys.step_up(conn, who, data["password"], data["code"])
            row = await (
                await conn.execute(
                    "SELECT * FROM personal_font_source_permissions WHERE owner_id=%s AND id=%s FOR UPDATE",
                    (who.id, identifier),
                )
            ).fetchone()
            if not row or row["revision"] != data["revision"] or row["state"] == "revoked":
                raise HTTPException(409, "本人字体迁移许可已变化或已撤销")
            name = row["name"]
            if data["approve"] and row["state"] != "pending_owner":
                raise HTTPException(409, "字体迁移确认已完成；原许可不可改贴名称或归属")
            if data["approve"]:
                if not data["acknowledgeUnverifiedUploader"]:
                    raise HTTPException(422, "需明确确认旧上传者不可由文件名证明")
                _, name = font_name(data["name"] + ".ttf")
                if name != data["name"]:
                    raise HTTPException(422, "字体名称无效")
                grant, claims = await self.grant(conn, who, row, live=True)
                try:
                    root = registered(self.db.settings, row, live=True)
                    if not claims:
                        await verify_owner(root.definition, row["source_owner"])
                        registered(self.db.settings, row, live=True)
                        await conn.execute(
                            "INSERT INTO legacy_source_owner_claims(source_instance,source_owner,owner_id,physical_identity_hash,first_grant_id,platform_instance) VALUES(%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING",
                            (
                                grant["source_instance"],
                                grant["source_owner"],
                                who.id,
                                grant["physical_identity_hash"],
                                grant["id"],
                                grant["platform_instance"],
                            ),
                        )
                        claims = await self.authority.check_claim(
                            conn,
                            grant["source_instance"],
                            grant["source_owner"],
                            who.id,
                            grant["physical_identity_hash"],
                        )
                        if len(claims) != 1:
                            raise SourceMismatch("font_source_owner_not_verified")
                except SourceMismatch as error:
                    raise HTTPException(409, access_error_message(error)) from None
                except (psycopg.Error, sqlite3.Error, OSError):
                    raise HTTPException(409, "旧来源账号身份暂不能核验；未建立归属或读取字体") from None
            updated = await (
                await conn.execute(
                    "UPDATE personal_font_source_permissions SET state=%s,revision=revision+1,name=%s WHERE owner_id=%s AND id=%s RETURNING *",
                    ("active" if data["approve"] else "revoked", name, who.id, identifier),
                )
            ).fetchone()
            result = {
                "requestId": request,
                "kind": "consent",
                "state": "completed",
                "permissionId": str(identifier),
                "permission": public_permission(updated),
            }
            await self.record(conn, who, request, "consent", fingerprint, result)
            return result

    async def listing(self, who):
        async with self.fonts.context(who) as (conn, _):
            rows = await (
                await conn.execute(
                    "SELECT * FROM personal_font_source_permissions WHERE owner_id=%s OR registered_by=%s ORDER BY created_at DESC,id DESC LIMIT 100",
                    (who.id, who.id),
                )
            ).fetchall()
            try:
                available = roots(self.db.settings)
            except SourceMismatch:
                available = {}
            captures = await (
                await conn.execute(
                    "SELECT id,request_id,permission_id,permission_revision,sha256,byte_length,evidence_sha256 FROM personal_font_source_captures WHERE owner_id=%s ORDER BY created_at DESC,id DESC LIMIT 100",
                    (who.id,),
                )
            ).fetchall()
            return {
                "items": [
                    {
                        **public_permission(row),
                        "window": available[row["source_alias"]].definition.window_status()
                        if row["source_alias"] in available
                        else {"state": "unknown"},
                    }
                    for row in rows
                ],
                "captures": [self.project_capture(row) for row in captures],
                "entireSourceComplete": False,
                "limit": 100,
                "maxPermissions": 100,
            }

    def project_capture(self, row):
        return {
            "id": str(row["id"]),
            "requestId": str(row["request_id"]),
            "permissionId": str(row["permission_id"]),
            "permissionRevision": row["permission_revision"],
            "sha256": row["sha256"],
            "size": row["byte_length"],
            "evidenceSha256": row["evidence_sha256"],
            "originalPath": "/api/personal-font-import/captures/" + str(row["id"]) + "/original",
            "historicalUploaderVerified": False,
            "entireSourceComplete": False,
        }

    async def capture(self, who, data):
        request = data["requestId"]
        fingerprint = sha(canonical(["capture", data]))
        async with self.fonts.context(who, True) as (conn, _):
            old = await self.prior(conn, who, request, "capture", fingerprint)
            if old:
                return old["result"]
            permission, _ = await self.permission(
                conn, who, data["permissionId"], data["permissionRevision"], active=True, live=True
            )
            existing = await (
                await conn.execute(
                    "SELECT 1 FROM personal_font_source_captures WHERE owner_id=%s AND permission_id=%s",
                    (who.id, permission["id"]),
                )
            ).fetchone()
            if existing:
                raise HTTPException(409, "此许可原件已归档，请使用已有清单；不能自动重新捕获")
            pending = {
                "requestId": request,
                "kind": "capture",
                "state": "reading",
                "httpStatus": 202,
                "permissionId": str(permission["id"]),
                "entireSourceComplete": False,
            }
            await self.record(conn, who, request, "capture", fingerprint, pending)
        try:
            raw, evidence = await asyncio.to_thread(read_source, self.db.settings, permission)
            await validate_font(raw, permission["original_id"].rsplit(".", 1)[1])
            if self.after_read:
                await self.after_read()
            async with self.fonts.context(who, True) as (conn, _):
                operation = await self.prior(conn, who, request, "capture", fingerprint)
                if operation["state"] != "reading":
                    return operation["result"]
                current, _ = await self.permission(
                    conn, who, data["permissionId"], data["permissionRevision"], active=True, live=True
                )
                async with conn.transaction():
                    await self.fonts.media.stage(conn, who.id, raw)
                    identifier = uuid4()
                    document = {
                        **evidence,
                        "permissionId": str(current["id"]),
                        "permissionRevision": current["revision"],
                        "originalId": current["original_id"],
                        "sha256": sha(raw),
                        "size": len(raw),
                        "rootBinding": current["root_binding"],
                        "sourceInstance": current["source_instance"],
                        "sourceOwner": current["source_owner"],
                        "platformInstance": str(current["platform_instance"]),
                        "name": current["name"],
                        "ownershipEvidence": "admin-and-owner-attested",
                    }
                    encoded = canonical(document)
                    row = await (
                        await conn.execute(
                            "INSERT INTO personal_font_source_captures(owner_id,id,request_id,permission_id,permission_revision,sha256,byte_length,evidence,evidence_sha256) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *",
                            (
                                who.id,
                                identifier,
                                request,
                                current["id"],
                                current["revision"],
                                sha(raw),
                                len(raw),
                                encoded,
                                sha(encoded),
                            ),
                        )
                    ).fetchone()
                    result = {
                        "requestId": request,
                        "kind": "capture",
                        "state": "completed",
                        "capture": self.project_capture(row),
                        "entireSourceComplete": False,
                    }
                    await conn.execute(
                        "UPDATE personal_font_source_operations SET state='completed',result=%s WHERE owner_id=%s AND request_id=%s",
                        (Jsonb(result), who.id, request),
                    )
                    await conn.execute(
                        "INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'font-source.captured',%s,%s)",
                        (who.id, str(identifier), request),
                    )
                return result
        except Exception as error:  # noqa: BLE001 - accepted capture must become a safe terminal receipt
            reason = (
                str(error)
                if isinstance(error, SourceMismatch)
                else str(error.detail)
                if isinstance(error, HTTPException)
                else "font_source_capture_failed"
            )
            async with self.db.connection() as conn, conn.transaction():
                old = await (
                    await conn.execute(
                        "SELECT * FROM personal_font_source_operations WHERE owner_id=%s AND request_id=%s FOR UPDATE",
                        (who.id, request),
                    )
                ).fetchone()
                if not old:
                    raise HTTPException(403, "原字体捕获身份已关闭") from None
                if old["state"] != "reading":
                    return old["result"]
                result = {
                    "requestId": request,
                    "kind": "capture",
                    "state": "failed",
                    "httpStatus": 409,
                    "reason": reason,
                    "entireSourceComplete": False,
                }
                await conn.execute(
                    "UPDATE personal_font_source_operations SET state='failed',result=%s WHERE owner_id=%s AND request_id=%s",
                    (Jsonb(result), who.id, request),
                )
                return result

    async def archive(self, conn, who, identifier, *, authorize=False):
        row = await (
            await conn.execute(
                "SELECT * FROM personal_font_source_captures WHERE owner_id=%s AND id=%s",
                (who.id, identifier),
            )
        ).fetchone()
        if not row:
            raise HTTPException(404, "本人已归档字体不存在")
        evidence = bytes(row["evidence"])
        if sha(evidence) != row["evidence_sha256"]:
            raise HTTPException(409, "字体归档证据摘要不匹配")
        doc = json.loads(evidence)
        permission = await (
            await conn.execute(
                "SELECT * FROM personal_font_source_permissions WHERE owner_id=%s AND id=%s",
                (who.id, row["permission_id"]),
            )
        ).fetchone()
        if (
            not permission
            or doc["permissionId"] != str(permission["id"])
            or doc["originalId"] != permission["original_id"]
            or doc["rootBinding"] != permission["root_binding"]
            or doc["sha256"] != row["sha256"]
            or doc["size"] != row["byte_length"]
        ):
            raise HTTPException(409, "字体归档来源或原件身份不匹配")
        completed = await (
            await conn.execute(
                "SELECT result FROM personal_font_source_operations WHERE owner_id=%s AND request_id=%s AND kind='capture' AND state='completed'",
                (who.id, row["request_id"]),
            )
        ).fetchone()
        if (
            not completed
            or completed["result"].get("capture", {}).get("id") != str(row["id"])
            or completed["result"].get("capture", {}).get("evidenceSha256") != row["evidence_sha256"]
            or doc.get("sourceInstance") != permission["source_instance"]
            or doc.get("sourceOwner") != permission["source_owner"]
            or doc.get("platformInstance") != str(permission["platform_instance"])
        ):
            raise HTTPException(409, "字体归档与原捕获回执不匹配")
        if authorize:
            permission, _ = await self.permission(
                conn, who, permission["id"], row["permission_revision"], active=True, live=False
            )
        return row, permission, doc

    async def plan(self, conn, who, capture):
        row, permission, _ = await self.archive(conn, who, capture, authorize=True)
        revision = await self.fonts.revision(conn, who.id)
        alias = await (
            await conn.execute(
                "SELECT target_id FROM personal_font_source_aliases WHERE owner_id=%s AND permission_id=%s",
                (who.id, permission["id"]),
            )
        ).fetchone()
        plan = {
            "captureId": str(row["id"]),
            "permissionId": str(permission["id"]),
            "permissionRevision": permission["revision"],
            "expectedRevision": revision,
            "sha256": row["sha256"],
            "size": row["byte_length"],
            "name": permission["name"],
            "originalId": permission["original_id"],
            "evidenceSha256": row["evidence_sha256"],
            "action": "already_mapped" if alias else "import",
            "targetId": alias["target_id"] if alias else None,
            "historicalUploaderVerified": False,
            "entireSourceComplete": False,
        }
        return plan, row, permission

    async def preview(self, who, capture):
        async with self.fonts.context(who) as (conn, _):
            plan, _, _ = await self.plan(conn, who, capture)
            return {"plan": plan, "preview": sha(canonical(plan))}

    async def apply(self, who, data):
        request = data["requestId"]
        fingerprint = sha(canonical(["apply", data]))
        async with self.fonts.context(who, True) as (conn, user):
            old = await self.prior(conn, who, request, "apply", fingerprint)
            if old:
                return old["result"]
            result = None
            try:
                async with conn.transaction():
                    plan, row, permission = await self.plan(conn, who, data["captureId"])
                    if (
                        plan["expectedRevision"] != data["expectedRevision"]
                        or plan["permissionRevision"] != data["permissionRevision"]
                        or sha(canonical(plan)) != data["preview"]
                    ):
                        raise HTTPException(409, "字体目标、许可或预览已变化，请重新核对")
                    stream = await self.fonts.media.open(conn, who.id, row["sha256"])
                    try:
                        raw = stream.read()
                    finally:
                        stream.close()
                    if sha(raw) != row["sha256"] or len(raw) != row["byte_length"]:
                        raise HTTPException(409, "归档字体原件不完整")
                    stored, changed = await self.fonts.store(
                        conn,
                        who.id,
                        user,
                        plan["expectedRevision"],
                        permission["name"] + "." + permission["original_id"].rsplit(".", 1)[1],
                        raw,
                    )
                    if plan["targetId"] is not None and plan["targetId"] != stored["font"]["id"]:
                        raise HTTPException(409, "已登记字体目标不匹配")
                    result = {
                        "requestId": request,
                        "kind": "apply",
                        "state": "completed",
                        **stored,
                        "captureId": str(row["id"]),
                        "permissionId": str(permission["id"]),
                        "revision": plan["expectedRevision"] + int(changed),
                        "originalId": permission["original_id"],
                        "historicalUploaderVerified": False,
                        "entireSourceComplete": False,
                    }
                    await self.record(conn, who, request, "apply", fingerprint, result)
                    if plan["action"] != "already_mapped":
                        await conn.execute(
                            "INSERT INTO personal_font_source_aliases(owner_id,permission_id,capture_id,request_id,original_id,target_id) VALUES(%s,%s,%s,%s,%s,%s)",
                            (
                                who.id,
                                permission["id"],
                                row["id"],
                                request,
                                permission["original_id"],
                                stored["font"]["id"],
                            ),
                        )
                    if self.after_store:
                        await self.after_store()
            except HTTPException as error:
                result = {
                    "requestId": request,
                    "kind": "apply",
                    "state": "failed",
                    "httpStatus": error.status_code,
                    "message": str(error.detail),
                    "entireSourceComplete": False,
                }
                await self.record(conn, who, request, "apply", fingerprint, result)
            return result

    async def operation(self, who, request):
        async with self.fonts.context(who) as (conn, _):
            row = await self.prior(conn, who, request)
            if not row:
                raise HTTPException(404, "尚未查到本人原字体来源操作")
            return row["result"]

    async def close(self, who, request, kind):
        async with self.fonts.context(who, True) as (conn, _):
            row = await self.prior(conn, who, request, kind)
            if row and row["state"] != "reading":
                return row["result"]
            result = {
                "requestId": str(request),
                "kind": kind,
                "state": "failed",
                "httpStatus": 409,
                "canceled": True,
                "entireSourceComplete": False,
            }
            if row:
                await conn.execute(
                    "UPDATE personal_font_source_operations SET state='failed',result=%s WHERE owner_id=%s AND request_id=%s",
                    (Jsonb(result), who.id, request),
                )
            else:
                await self.record(conn, who, request, kind, sha(canonical(["close", kind])), result)
            return result

    async def original(self, who, capture):
        async with self.fonts.context(who) as (conn, _):
            row, permission, _ = await self.archive(conn, who, capture)
            return {
                "sha256": row["sha256"],
                "byte_length": row["byte_length"],
                "original_name": permission["original_id"],
                "media_type": "application/octet-stream",
            }, await self.fonts.media.open(conn, who.id, row["sha256"])
