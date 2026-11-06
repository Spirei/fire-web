"""Legacy profile patch and avatar subcontracts, plus canonical native adapters."""

import hashlib
import json
from datetime import datetime
from uuid import UUID, uuid4

from fastapi import HTTPException, Request, Response
from fastapi.responses import JSONResponse
from psycopg.types.json import Jsonb
from starlette.datastructures import UploadFile

from .legacy_identity import (
    LegacyError,
    assert_native_origin,
    envelope,
    native_identity,
    native_version,
    public_profile,
    web_identity,
)
from .legacy_optional_credentials import credentials_present
from .profile_http import bounded_body, profile_limits
from .profile_media import ProfileMedia, validate_legacy_avatar
from .profile_update import ProfileUpdate
from .security import digest, identity, lock_mutation_identity


def mount_profile_compatibility(app, settings, db, rate_limit):
    service = ProfileUpdate(settings, db, app.state.identity_email.mail)
    media = ProfileMedia(settings)

    async def member(request, write=True, version=None, platform=False):
        credentials_present(request)
        authorization = request.headers.get("authorization", "")
        if version is None and "authorization" in request.headers:
            raise HTTPException(403, "请使用当前网页登录会话")
        if version == 1 and "authorization" in request.headers and not authorization.startswith("Bearer "):
            raise HTTPException(401, "需要有效的连接")
        if platform:
            if "authorization" in request.headers:
                raise HTTPException(403, "请使用当前网页登录会话")
            return await identity(request), None
        if version is None or (
            version == 1 and not request.headers.get("authorization", "").startswith("Bearer fat_")
        ):
            who, _, _ = await web_identity(request, db, allow_v1_bearer=version == 1)
            return who, None
        assert_native_origin(request, settings)
        return await native_identity(request, db, "profile.write" if write else "portfolio.read")

    async def save(request, version=None, canonical=False, platform=False):
        who, grant = await member(request, version=2 if canonical else version, platform=platform)
        await profile_limits(request, db, who, rate_limit)
        await bounded_body(request, 16384)
        try:
            raw = json.loads(await request.body())
            if not isinstance(raw, dict):
                raise TypeError()
        except (TypeError, ValueError, UnicodeError):
            raise LegacyError(400, 40001, "请求参数无效") from None
        try:
            await service.save(
                who, raw, request.state.request_id, strict=version is not None or canonical or platform
            )
        except HTTPException as exc:
            code = exc.status_code * 100 + 1
            if exc.detail == "修改邮箱需要验证当前密码":
                code = 40103
            elif exc.detail == "二次验证失败":
                code = 40104
            raise LegacyError(exc.status_code, code, str(exc.detail)) from None
        async with db.connection() as conn:
            result = await public_profile(
                conn, who.id, scope=grant["scope"] if grant else None, settings=settings
            )
            if canonical and result.get("avatar", "").startswith("/api/v2/auth/avatar?"):
                result["avatar"] = result["avatar"].replace(
                    "/api/v2/auth/avatar?", "/api/client/profile/avatar?", 1
                )
            return result

    @app.put("/api/auth/profile")
    async def web_profile(request: Request):
        try:
            if "authorization" in request.headers:
                raise HTTPException(403, "请使用当前网页登录会话")
            return {"user": await save(request)}
        except LegacyError as exc:
            payload = {"error": str(exc.detail)}
            if exc.business_code == 40104:
                payload["requiresSecondFactor"] = True
            return JSONResponse(payload, status_code=exc.status_code, headers={"Cache-Control": "no-store"})

    @app.put("/api/v{version}/auth/profile")
    async def native_profile(version: int, request: Request, response: Response):
        native_version(request)
        return envelope(await save(request, version), request, response)

    @app.put("/api/client/profile")
    async def canonical_profile(request: Request):
        return await save(request, canonical=True)

    async def upload(request, version=None, canonical=False):
        who, _ = await member(request, version=2 if canonical else version)
        address = request.client.host if request.client else "unknown"
        for key, maximum in ((digest("upload:" + address + ":" + who.id), 60), ("upload-global", 600)):
            if not await rate_limit(db, key, maximum, window_seconds=3600):
                raise HTTPException(429, "上传过于频繁")
        await bounded_body(
            request, 21 * 1024 * 1024 if version is None and not canonical else 5 * 1024 * 1024 + 65536
        )
        form = await request.form(max_files=1, max_fields=12 if version is None and not canonical else 6)
        if len(form.getlist("file")) != 1 or len(form.getlist("kind")) > 1:
            raise HTTPException(400, "表单无效")
        kind = form.get("kind", "avatar")
        if kind != "avatar":
            if (
                version is not None
                or canonical
                or getattr(who, "native_client", False)
                or who.role != "admin"
            ):
                raise HTTPException(403, "仅可上传自己的头像")
            return await app.state.system_asset_form(who, form, request)
        file = form.get("file")
        if not isinstance(file, UploadFile):
            raise HTTPException(400, "请选择要上传的文件")
        raw, mimetype = validate_legacy_avatar(await file.read(), (file.filename or "").rsplit(".", 1)[-1])
        if any(len(form.getlist(key)) > 1 for key in ("requestId", "expectedRevision")) or len(request.headers.getlist("x-alcor-request-id")) > 1:
            raise HTTPException(400, "上传请求编号或版本重复")
        supplied = form["requestId"] if "requestId" in form else request.headers.get("x-alcor-request-id")
        if form.get("requestId") and request.headers.get("x-alcor-request-id") and form["requestId"] != request.headers["x-alcor-request-id"]:
            raise HTTPException(400, "上传请求编号不一致")
        try:
            rid = UUID(str(supplied)) if supplied is not None else uuid4()
            if supplied is not None and str(rid) != supplied:
                raise ValueError()
            expected = UUID(form["expectedRevision"]) if form.get("expectedRevision") not in (None, "null") else None
        except (TypeError, ValueError, AttributeError):
            raise HTTPException(400, "上传请求编号或版本无效") from None
        sha = hashlib.sha256(raw).hexdigest()
        fingerprint = hashlib.sha256(json.dumps({"path": request.url.path, "sha256": sha,
            "mediaType": mimetype, "expectedRevision": str(expected) if expected else None,
            "checkRevision": "expectedRevision" in form}, sort_keys=True).encode()).hexdigest()
        request.state.upload_receipt_headers = {"X-Alcor-Operation": str(rid),
            "X-Alcor-Legacy-Client-Idempotency": "true" if supplied is not None else "false",
            "Cache-Control": "no-store, private"}
        async with db.connection() as conn, conn.transaction():
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("identity-management:" + who.id,)
            )
            await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("profile:" + who.id,))
            await lock_mutation_identity(conn, who, require_admin=False)
            prior = await (await conn.execute("SELECT state,result FROM profile_operation_receipts WHERE owner_id=%s AND request_id=%s", (who.id, rid))).fetchone()
            if prior:
                binding=prior["result"].get("avatarUpload", {})
                if binding.get("fingerprint") != fingerprint:
                    raise HTTPException(409, "原UUID已用于其他资料操作")
                if prior["state"] != "completed" or prior["result"].get("state") != "completed":
                    raise HTTPException(409, "原头像操作已关闭或退役")
                retired=await(await conn.execute("SELECT 1 FROM audit_events WHERE target_id=%s AND action='profile.avatar.history_retired' AND created_at>=%s LIMIT 1",(who.id,datetime.fromisoformat(binding["admittedAt"])))).fetchone()
                if retired:
                    raise HTTPException(409, "原头像操作已明确退役，请查询原回执")
                return prior["result"]["data"]
            current = await (await conn.execute("SELECT revision FROM user_profiles WHERE user_id=%s", (who.id,))).fetchone()
            if "expectedRevision" in form and (current["revision"] if current else None) != expected:
                raise HTTPException(409, "头像版本已变化，请重新读取")
            object_id, _ = await media.stage(conn, who.id, raw, mimetype)
            revision = uuid4()
            await conn.execute(
                """INSERT INTO user_profiles(user_id,display_name,revision,avatar_object_id) VALUES(%s,'',%s,%s) ON CONFLICT(user_id) DO UPDATE SET revision=excluded.revision,avatar=NULL,avatar_object_id=excluded.avatar_object_id,updated_at=clock_timestamp()""",
                (who.id, revision, object_id),
            )
            await conn.execute(
                "UPDATE identity_source_profiles SET metadata=jsonb_set(metadata,'{avatar}','\"\"'::jsonb) WHERE user_id=%s",
                (who.id,),
            )
            await conn.execute(
                "INSERT INTO audit_events(actor_id,action,request_id) VALUES(%s,'profile.avatar.updated',%s)",
                (who.id, request.state.request_id),
            )
            prefix = (
                "/api/client/profile/avatar" if canonical
                else f"/api/v{version}/auth/avatar" if version else "/api/auth/avatar"
            )
            result = {"url": prefix + "?revision=" + str(revision), "kind": "avatar"}
            admitted = (await (await conn.execute("SELECT clock_timestamp() AS at")).fetchone())["at"]
            receipt = {"requestId": str(rid), "kind": "update_profile", "state": "completed",
                "code": 0, "message": "ok", "userId": who.id, "data": result,
                "avatarUpload": {"fingerprint": fingerprint, "revision": str(revision),
                    "objectId": str(object_id), "sha256": sha, "mediaType": mimetype,
                    "originInstance": str(settings.instance_id), "admittedAt": admitted.isoformat()}}
            await conn.execute("INSERT INTO profile_operation_receipts(owner_id,request_id,actor_client,kind,state,result) VALUES(%s,%s,%s,'update_profile','completed',%s)",
                (who.id,rid,"native" if version is not None or canonical else "web",Jsonb(receipt)))
        return result

    @app.post("/api/upload")
    async def web_upload(request: Request):
        await member(request)
        async with app.state.resource_library.upload_slot():
            try:
                result = await upload(request)
                return result if isinstance(result, Response) else JSONResponse({"url": result["url"]}, headers=request.state.upload_receipt_headers)
            finally:
                if request._form is not None:
                    await request._form.close()

    @app.post("/api/v{version}/upload")
    async def native_upload(version: int, request: Request, response: Response):
        native_version(request)
        try:
            result = await upload(request, version)
            response.headers.update(getattr(request.state, "upload_receipt_headers", {}))
            return envelope(result, request, response)
        finally:
            if request._form is not None:
                await request._form.close()

    @app.post("/api/client/profile/avatar")
    async def canonical_upload(request: Request, response: Response):
        try:
            result = await upload(request, canonical=True)
            response.headers.update(getattr(request.state, "upload_receipt_headers", {}))
            return result
        finally:
            if request._form is not None:
                await request._form.close()

    async def avatar(request, revision, version=None, canonical=False, platform=False):
        who, _ = await member(request, False, 2 if canonical else version, platform)
        async with db.connection() as conn, conn.transaction():
            await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("identity-management:" + who.id,))
            await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("profile:" + who.id,))
            await lock_mutation_identity(conn, who, require_admin=False)
            row = await (await conn.execute("SELECT avatar,avatar_object_id,revision FROM user_profiles WHERE user_id=%s", (who.id,))).fetchone()
            if not row or not row["avatar_object_id"] and not row["avatar"]:
                raise HTTPException(404, "头像不存在")
            if row["revision"] == revision:
                if row["avatar_object_id"]:
                    raw, kind = await media.read(conn, who.id, row["avatar_object_id"])
                else:
                    raw, kind = bytes(row["avatar"]), "image/jpeg"
            else:
                originals = await (await conn.execute("""SELECT result FROM profile_operation_receipts
                    WHERE owner_id=%s AND kind='update_profile' AND state='completed'
                     AND result->>'state'='completed' AND result->'avatarUpload'->>'revision'=%s LIMIT 2""", (who.id,str(revision)))).fetchall()
                if not originals:
                    raise HTTPException(404, "头像历史版本不存在或已关闭")
                if len(originals) != 1:
                    raise HTTPException(409, "头像历史版本来源不唯一")
                binding = originals[0]["result"]["avatarUpload"]
                try:
                    admitted = datetime.fromisoformat(binding["admittedAt"])
                    object_id = UUID(binding["objectId"])
                    if admitted.tzinfo is None:
                        raise ValueError()
                except (ValueError,TypeError,KeyError):
                    raise HTTPException(503, "头像历史原件绑定无效") from None
                retired = await (await conn.execute("SELECT 1 FROM audit_events WHERE target_id=%s AND action='profile.avatar.history_retired' AND created_at>=%s LIMIT 1", (who.id,admitted))).fetchone()
                if retired:
                    raise HTTPException(404, "头像历史版本已明确退役")
                raw, kind = await media.read(conn,who.id,object_id)
                if hashlib.sha256(raw).hexdigest() != binding.get("sha256") or kind != binding.get("mediaType"):
                    raise HTTPException(503, "头像历史原件摘要不一致")
        return Response(
            raw,
            media_type=kind,
            headers={
                "Cache-Control": "no-store, private",
                "X-Content-Type-Options": "nosniff",
                "Content-Disposition": "inline",
            },
        )

    @app.get("/api/auth/avatar")
    async def web_avatar(request: Request, revision: UUID):
        return await avatar(request, revision)

    @app.get("/api/v{version}/auth/avatar")
    async def native_avatar(version: int, request: Request, revision: UUID):
        native_version(request)
        return await avatar(request, revision, version)

    @app.get("/api/client/profile/avatar")
    async def canonical_avatar(request: Request, revision: UUID):
        return await avatar(request, revision, canonical=True)

    app.state.read_profile_avatar = lambda request, revision: avatar(request, revision, platform=True)

    @app.put("/api/account/profile")
    async def platform_profile(request: Request):
        return await save(request, platform=True)
