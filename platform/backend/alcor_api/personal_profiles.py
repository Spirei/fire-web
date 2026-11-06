"""Personal fields extend user_profiles; receipts and CAS are PG authoritative."""

import asyncio
import re
from datetime import UTC, datetime
from uuid import UUID, uuid4

import regex
from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .profile_media import ProfileMedia, normalize_background
from .security import lock_mutation_identity


def identifier(value):
    if not isinstance(value, str):
        raise HTTPException(400, "请求编号无效")
    try:
        parsed = UUID(value)
        if str(parsed) != value:
            raise ValueError()
        return parsed
    except ValueError:
        raise HTTPException(400, "请求编号无效") from None


def project(value, path):
    result = dict(value)
    if isinstance(result.get("data"), dict):
        result["data"] = project(result["data"], path)
    if result.get("background"):
        # Legacy iOS validates this field against the exact bare discovery path.
        # Canonical clients bind the URL to the immutable bytes named by the SHA.
        immutable = path in {
            "/api/account/personal-profile/background",
            "/api/client/personal-profile/background",
        }
        target = path + "?sha256=" + result["background"]["sha256"] if immutable else path
        result["background"] = {**result["background"], "path": target}
    return result


class PersonalProfiles:
    def __init__(self, db):
        self.db = db
        self.media = ProfileMedia(db.settings)

    async def current(self, conn, owner):
        row = await (await conn.execute("SELECT * FROM user_profiles WHERE user_id=%s", (owner,))).fetchone()
        return {
            "userId": owner,
            "revision": row["personal_revision"] if row else 0,
            "bio": row["bio"] if row else "",
            "gender": row["gender"] if row else "unspecified",
            "background": {"sha256": row["background_sha256"]}
            if row and row["background_object_id"]
            else None,
            "initializedFields": row["initialized_fields"] if row else [],
        }

    async def read(self, who, path):
        async with self.db.connection() as conn:
            return project(await self.current(conn, who.id), path)

    async def receipt(self, who, request_id, path):
        rid = identifier(request_id)
        async with self.db.connection() as conn:
            row = await (
                await conn.execute(
                    "SELECT result FROM profile_operation_receipts WHERE owner_id=%s AND request_id=%s",
                    (who.id, rid),
                )
            ).fetchone()
        if not row:
            raise HTTPException(404, "回执不存在")
        return project(row["result"], path)

    async def background(self, who, sha256=None):
        if sha256 is not None and (not isinstance(sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", sha256)):
            raise HTTPException(400, "背景图摘要无效")
        async with self.db.connection() as conn:
            if sha256 is not None:
                row = await (
                    await conn.execute(
                        "SELECT id AS background_object_id FROM profile_media_objects "
                        "WHERE owner_id=%s AND sha256=%s AND media_type='image/jpeg' "
                        "ORDER BY created_at,id LIMIT 1",
                        (who.id, sha256),
                    )
                ).fetchone()
            else:
                row = await (
                    await conn.execute(
                        "SELECT background_object_id FROM user_profiles WHERE user_id=%s", (who.id,)
                    )
                ).fetchone()
            if not row or not row["background_object_id"]:
                raise HTTPException(404, "背景图不存在")
            return await self.media.read(conn, who.id, row["background_object_id"])

    async def mutate(self, who, raw, path, request_id, background=None):
        if not isinstance(raw, dict) or set(raw) - {"requestId", "revision", "changes", "migration"}:
            raise HTTPException(400, "请求无效")
        rid = identifier(raw.get("requestId"))
        revision = raw.get("revision")
        migration = raw.get("migration", False)
        if type(revision) is not int or not 0 <= revision <= 9007199254740991 or type(migration) is not bool:
            raise HTTPException(400, "版本或迁移参数无效")
        patch = {"background": True} if background is not None else raw.get("changes")
        if not isinstance(patch, dict) or not patch or set(patch) - {"bio", "gender", "background"}:
            raise HTTPException(400, "资料字段无效")
        if "bio" in patch and isinstance(patch["bio"], str):
            try:
                patch["bio"].encode("utf-8")
            except UnicodeError:
                raise HTTPException(400, "简介包含无效字符") from None
        if "bio" in patch and (
            not isinstance(patch["bio"], str)
            or len(regex.findall(r"\X", patch["bio"])) > 160
            or regex.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", patch["bio"])
        ):
            raise HTTPException(400, "简介最多160个字符")
        if "gender" in patch and patch["gender"] not in ("unspecified", "male", "female"):
            raise HTTPException(400, "性别值无效")
        if background is None and patch.get("background") is not None:
            raise HTTPException(400, "背景图须通过上传接口保存")
        clean = await asyncio.to_thread(normalize_background, background) if background is not None else None
        failure = None
        async with self.db.connection() as conn, conn.transaction():
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("identity-management:" + who.id,)
            )
            await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("profile:" + who.id,))
            await lock_mutation_identity(conn, who, require_admin=False)
            prior = await (
                await conn.execute(
                    "SELECT 1 FROM profile_operation_receipts WHERE owner_id=%s AND request_id=%s",
                    (who.id, rid),
                )
            ).fetchone()
            if prior:
                raise HTTPException(409, "重复请求，请查询原回执")
            data = None
            try:
                async with conn.transaction():
                    old = await self.current(conn, who.id)
                    if revision == 9007199254740991:
                        raise HTTPException(409, "资料版本已达上限，请联系管理员")
                    if old["revision"] != revision:
                        raise HTTPException(409, "资料已在其他设备修改，请重新读取")
                    if migration and set(patch) & set(old["initializedFields"]):
                        raise HTTPException(409, "远端已有资料，请保留本机副本并选择")
                    row = await (
                        await conn.execute(
                            "SELECT background_object_id,background_sha256 FROM user_profiles WHERE user_id=%s",
                            (who.id,),
                        )
                    ).fetchone()
                    media_id = row["background_object_id"] if row else None
                    sha = row["background_sha256"] if row else None
                    if "background" in patch:
                        media_id, sha = (
                            await self.media.stage(conn, who.id, clean, "image/jpeg")
                            if clean is not None
                            else (None, None)
                        )
                    initialized = sorted(set(old["initializedFields"]) | set(patch))
                    await conn.execute(
                        """INSERT INTO user_profiles(user_id,display_name,revision,personal_revision,bio,gender,background_object_id,background_sha256,initialized_fields)
                    VALUES(%s,'',%s,%s,%s,%s,%s,%s,%s) ON CONFLICT(user_id) DO UPDATE SET revision=excluded.revision,personal_revision=excluded.personal_revision,bio=excluded.bio,gender=excluded.gender,background_object_id=excluded.background_object_id,background_sha256=excluded.background_sha256,initialized_fields=excluded.initialized_fields,updated_at=clock_timestamp()""",
                        (
                            who.id,
                            uuid4(),
                            revision + 1,
                            patch.get("bio", old["bio"]),
                            patch.get("gender", old["gender"]),
                            media_id,
                            sha,
                            initialized,
                        ),
                    )
                    data = await self.current(conn, who.id)
                    await conn.execute(
                        "INSERT INTO audit_events(actor_id,action,request_id) VALUES(%s,'profile.personal.updated',%s)",
                        (who.id, request_id),
                    )
            except HTTPException as exc:
                failure = exc
            result = {
                "requestId": str(rid),
                "kind": "upload_background" if background is not None else "update_profile",
                "userId": who.id,
                "state": "failed" if failure else "completed",
                "code": 40902
                if failure and failure.status_code == 409
                else failure.status_code * 100 + 1
                if failure
                else 0,
                "message": str(failure.detail) if failure else "ok",
                "completedAt": datetime.now(UTC).isoformat(),
                "data": data,
            }
            await conn.execute(
                "INSERT INTO profile_operation_receipts(owner_id,request_id,actor_client,kind,state,result) VALUES(%s,%s,%s,%s,%s,%s)",
                (
                    who.id,
                    rid,
                    "native" if getattr(who, "native_client", False) else "web",
                    result["kind"],
                    result["state"],
                    Jsonb(result),
                ),
            )
        return project(result, path), failure


def personal_discovery(base):
    return {
        "version": 1,
        "path": base,
        "background_path": base + "/background",
        "operation_path": base + "/operations/{requestId}",
        "read_scope": "portfolio.read",
        "write_scope": "profile.write",
        "bio_max_graphemes": 160,
        "background": {"content_types": ["image/jpeg"], "max_bytes": 8388608, "max_dimension": 2048},
        "patch_only": True,
        "automatic_mutation_replay": False,
    }
