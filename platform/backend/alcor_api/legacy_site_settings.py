"""Partial old settings protocol: aggregate existing authorities, never invent private defaults.

Only the reviewed public patch is writable here. Provider/model/social settings
must keep their own authorization, destination binding, revisions and receipts.
"""

import re
from uuid import UUID

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from .connection_models import PostgresConfig
from .connections import config_model
from .legacy_admin_route import protocol_body
from .legacy_identity import OLD_COOKIE, WEB_COOKIE, legacy_me_mutation_trusted, web_identity
from .security import COOKIE, identity, lock_mutation_identity
from .site_private_projection import fx_schedule_metadata, mail_metadata
from .site_registration import installed
from .site_settings import DEFAULTS, public_projection
from .site_settings_layout import DEFAULTS as LAYOUT_DEFAULTS


async def member(request, db):
    authorization = request.headers.get("authorization")
    old = request.cookies.get(WEB_COOKIE) or request.cookies.get(OLD_COOKIE)
    if (request.headers.get("x-csrf-token") and authorization is None) or (
        request.cookies.get(COOKIE) and not old and authorization is None
    ):
        return await identity(request)
    if authorization is not None:
        token = authorization.removeprefix("Bearer ").strip() if authorization.startswith("Bearer ") else ""
        if not re.fullmatch("[a-fA-F0-9]{64}", token):
            raise HTTPException(401, "未登录")
    elif request.method not in {"GET", "HEAD", "OPTIONS"} and not legacy_me_mutation_trusted(request):
        raise HTTPException(401, "未登录")
    elif (
        request.cookies.get(WEB_COOKIE)
        and request.cookies.get(OLD_COOKIE)
        and request.cookies[WEB_COOKIE] != request.cookies[OLD_COOKIE]
    ):
        raise HTTPException(403, "网页登录身份不一致，请重新登录")
    return (
        await web_identity(request, db, allow_legacy_bearer=True, web_bearer_only=True, origin_checked=True)
    )[0]


async def aggregate(request, who, service):
    db = request.app.state.db
    async with db.connection() as conn, conn.transaction():
        await lock_mutation_identity(conn, who, require_admin=who.role == "admin")
        ready = await installed(conn)
        row = (
            await (await conn.execute("SELECT * FROM site_settings WHERE singleton")).fetchone()
            if ready
            else None
        )
        if ready and not row:
            raise HTTPException(503, "站点配置缺失")
        value = await public_projection(conn, row, service.mail.configured)
        from .site_settings_layout import project as layout_projection
        value.update(await layout_projection(conn,row))
        sources = {
            "public": {
                "state": "available",
                "authority": "platform",
                "revision": row["revision"] if row else None,
            }
        }
        if who.role == "admin":
            # No boot-time PG address is substituted for an explicit saved record.
            pg = await request.app.state.connections.row(conn, "postgresql")
            if pg:
                config = config_model(pg["config"])
                if not isinstance(config, PostgresConfig):
                    raise HTTPException(503, "已保存数据库配置类型不一致")
                value.update(
                    dbType="postgres",
                    pgHost=config.host,
                    pgPort=str(config.port),
                    pgDatabase=config.database,
                    pgUser=config.username,
                    pgPasswordConfigured=bool(pg["password_ciphertext"]),
                )
                sources["postgresql"] = {
                    "state": "saved",
                    "revision": str(pg["revision"]),
                    "authority": "/api/connections/postgresql",
                    "credentialState": "sealed_present" if pg["password_ciphertext"] else "not_set",
                    "connectionHealth": "not_checked",
                }
            else:
                sources["postgresql"] = {
                    "state": "unconfigured",
                    "authority": "/api/connections/postgresql",
                    "legacyCoverage": "unknown",
                }
            mail_fields, sources["smtp"] = mail_metadata(service.mail.settings, service.mail.configured)
            value.update(mail_fields)
            fx = await (
                await conn.execute(
                    "SELECT c.revision,c.enabled,c.provider_revision,p.config FROM fx_config c "
                    "LEFT JOIN fx_provider_revisions p ON p.id=c.provider_revision WHERE c.singleton"
                )
            ).fetchone()
            fx_fields, sources["fxSchedule"] = fx_schedule_metadata(fx)
            value.update(fx_fields)
            from .market_worker import Bound
            from .private_runtime_settings import PrivateRuntimeSettings

            private = await PrivateRuntimeSettings(Bound(conn, db.settings)).read_admin(who)
            value['modelServicesRevision'] = private['revision']
            from .legacy_settings_projection import project as private_projection
            value.update(private_projection(private['groups']))
            from .legacy_settings_projection import current_channels
            value.update(await current_channels(conn,db,who))
            for name,group in private['groups'].items():
                sources[name]={'state':group['state'],'revision':private['revision'],'secretState':group['secretState'],'authority':'/api/admin/private-runtime-settings'}
            directory=await(await conn.execute('SELECT groups FROM shared_broker_directory WHERE singleton')).fetchone()
            if directory:value['groups']=directory['groups']
        else:
            directory=await(await conn.execute('SELECT groups FROM shared_broker_directory WHERE singleton')).fetchone()
            if directory:value['groups']=directory['groups']
            sources["private"] = {"state": "redacted"}
        return {
            "settings": value,
            "revision": row["revision"] if row else None,
            **({'privateRevision': private['revision']} if who.role == 'admin' else {}),
            "migration": {
                "status": "partial",
                "sourceCoverage": "platform-only",
                "privateLegacyImport": "not_verified",
                "sources": sources,
                "pendingGroups": ["client-layout", "legacy-owner-bindings", "actual-provider-acceptance"],
                "writeFields": list(DEFAULTS) + ["allowRegister"],
            },
        }


def response(value, status=200, headers=None):
    return JSONResponse(
        value,
        status_code=status,
        headers={
            **(headers or {}),
            "Cache-Control": "private, no-store",
            "X-Alcor-Settings-Coverage": "partial",
        },
    )


def mount_legacy_site_settings(app, settings, db, service):
    async def error_response(error):
        headers = dict(error.headers or {})
        if error.status_code == 401 or error.detail in {
            "需要管理员权限",
            "操作授权已变化，请重新登录核对",
            "网页登录身份不一致，请重新登录",
        }:
            headers["X-Alcor-Retire-Context"] = "true"
        return response({"error": str(error.detail)}, error.status_code, headers)

    @app.get("/api/settings", tags=["legacy-site-settings-partial"])
    async def read(request: Request):
        try:
            return response(await aggregate(request, await member(request, db), service))
        except HTTPException as error:
            return await error_response(error)

    @app.put("/api/settings", tags=["legacy-site-settings-partial"])
    async def save(request: Request):
        from .site_settings_api import SaveSiteSettings

        try:
            who = await member(request, db)
            if who.role != "admin":
                raise HTTPException(403, "需要管理员权限")
            raw = await protocol_body(request, 1024 * 1024)
            commands = {
                "request_id",
                "requestId",
                "revision",
                "expectedRevision",
                "currentPassword",
                "current_password",
                "password",
                "code",
                "privateRevision",
                "private_revision",
                "modelServicesRevision",
            }
            unsupported = set(raw) - (set(DEFAULTS) | set(LAYOUT_DEFAULTS) | {"allowRegister"} | commands)
            if unsupported or set(raw)&set(LAYOUT_DEFAULTS):
                from .legacy_private_settings_bridge import LegacySettingsBridge

                value = await LegacySettingsBridge(db,request.app).save(
                    who, raw, service, request.app.state.native_passkeys,
                    legacy=bool(getattr(who, 'legacy_client', False)),
                    header_id=request.headers.get('x-alcor-request-id'),
                )
                return response(value,status=value.get('httpStatus',200), headers={'X-Alcor-Request-Id': value['requestId']})
            translated = {}
            for target, aliases in (
                ("requestId", ("requestId", "request_id")),
                ("expectedRevision", ("expectedRevision", "revision")),
                ("password", ("password", "currentPassword", "current_password")),
            ):
                given = [name for name in aliases if name in raw]
                if len(given) != 1:
                    raise HTTPException(422, "保存须提供唯一原UUID、配置修订与管理员验证")
                translated[target] = raw[given[0]]
            translated["code"] = raw.get("code", "")
            translated["patch"] = {
                key: value for key, value in raw.items() if key in DEFAULTS or key == "allowRegister"
            }
            data = SaveSiteSettings.model_validate(translated)
            value = await service.save(
                who,
                data.requestId,
                data.expectedRevision,
                data.patch,
                data.password.get_secret_value(),
                data.code.get_secret_value(),
                request.app.state.native_passkeys,
            )
            # Immutable operation proof is returned as proof, not silently rebuilt
            # from a newer head or mixed with unknown private provider settings.
            return response(
                {
                    "settings": value["settings"],
                    "revision": value["revision"],
                    "requestId": value["requestId"],
                    "operation": value,
                    "migration": {
                        "status": "partial",
                        "writeScope": "public-brand-only",
                        "assetRepresentation": "registered-version-id",
                        "privateFieldsWritten": False,
                    },
                    "receiptUrl": "/api/settings/operations/" + value["requestId"],
                }
            )
        except ValidationError:
            return response({"error": "公开配置参数或原请求证明无效"}, 422)
        except HTTPException as error:
            return await error_response(error)

    @app.get("/api/settings/operations/{request_id}", tags=["legacy-site-settings-partial"])
    async def receipt(request_id: UUID, request: Request):
        try:
            who = await member(request, db)
            if who.role != "admin":
                raise HTTPException(403, "需要管理员权限")
            from .legacy_private_settings_bridge import LegacySettingsBridge

            try:
                return response(await LegacySettingsBridge(db).receipt(who, request_id))
            except HTTPException as exc:
                if exc.status_code != 404:
                    raise
            return response(await service.receipt(who, request_id))
        except HTTPException as error:
            return await error_response(error)
