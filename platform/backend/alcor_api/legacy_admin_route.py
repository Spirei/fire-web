"""Thin old-Web account protocol negotiation over the native account authority."""

import json
import re
from uuid import UUID

from fastapi import HTTPException, Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from pydantic import ValidationError

from .legacy_identity import (
    OLD_COOKIE,
    WEB_COOKIE,
    assert_native_origin,
    legacy_me_mutation_trusted,
    public_profiles,
    web_identity,
)
from .passwords import js_length
from .profile_http import bounded_body
from .resource_api import no_duplicate_object
from .security import COOKIE


class AccountAdminRoute(APIRoute):
    def get_route_handler(self):
        native = super().get_route_handler()
        name = self.endpoint.__name__
        supported = {
            "users",
            "legacy_put_user",
            "update_user",
            "delete_user",
            "reset_managed_password",
            "disable_managed_totp",
            "action_receipt",
            "directory_avatar",
            "history",
            "close",
        }

        async def handler(request: Request):
            legacy = (
                bool(request.cookies.get(WEB_COOKIE) or request.cookies.get(OLD_COOKIE) or "authorization" in request.headers)
                and "x-csrf-token" not in request.headers
            )
            if name not in supported:
                return await native(request)
            if not legacy:
                if "authorization" in request.headers:
                    raise HTTPException(
                        403 if request.cookies.get(COOKIE) else 401, "请使用当前管理员网页会话"
                    )
                assert_native_origin(request, request.app.state.settings)
                return await native(request)
            try:
                authorization = request.headers.get("authorization")
                bearer = authorization.removeprefix("Bearer ").strip() if authorization and authorization.startswith("Bearer ") else None
                if authorization is not None and (len(request.headers.getlist("authorization")) != 1
                                                   or bearer is None or not re.fullmatch(r"[a-fA-F0-9]{64}", bearer)):
                    has_browser_identity = bool(request.cookies.get(WEB_COOKIE) or request.cookies.get(OLD_COOKIE) or request.cookies.get(COOKIE))
                    raise HTTPException(403 if has_browser_identity else 401, "请使用当前管理员网页会话" if has_browser_identity else "未登录")
                if not bearer and request.method not in {"GET", "HEAD", "OPTIONS"} and not legacy_me_mutation_trusted(request):
                    raise HTTPException(401, "未登录")
                if name == "update_user":
                    raise HTTPException(405, "旧客户端账号更新仅支持显式PUT请求")
                first, second = request.cookies.get(WEB_COOKIE), request.cookies.get(OLD_COOKIE)
                if not bearer and first and second and first != second:
                    raise HTTPException(403, "网页登录身份不一致，请重新登录")
                who, _, _ = await web_identity(request, request.app.state.db, allow_legacy_bearer=True, web_bearer_only=True, origin_checked=True)
                if who.role != "admin":
                    raise HTTPException(403, "需要管理员权限")
                from . import account_admin as accounts

                if name == "users":
                    if request.query_params:
                        raise HTTPException(422, "旧目录读取不接受隐式筛选或分页")
                    async def project_directory(conn, page):
                        if page["next_cursor"]:
                            raise HTTPException(409, "用户目录超过单次读取上限，需要更新客户端分页读取")
                        values = []
                        identifiers = [row["id"] for row in page["items"]]
                        profiles = await public_profiles(conn, identifiers)
                        online = {
                            row["user_id"]
                            for row in await (
                                await conn.execute(
                                    "SELECT DISTINCT s.user_id FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.id=ANY(%s) AND u.active AND s.session_version=u.session_version AND s.expires_at>clock_timestamp()",
                                    (identifiers,),
                                )
                            ).fetchall()
                        }
                        for row in page["items"]:
                            value = old_user(profiles[row["id"]])
                            # public_profile's own avatar path would otherwise show the actor.
                            value["avatar"] = (
                                (
                                    "/api/users/"
                                    + row["id"]
                                    + "/avatar?revision="
                                    + str(row["avatar_revision"])
                                )
                                if row["avatar_revision"]
                                else value["avatar"]
                            )
                            values.append(
                                value
                                | {
                                    "createdAt": row["created_at"],
                                    "recordsCount": row["records_count"],
                                    "online": row["id"] in online,
                                    "totpEnabled": row["two_factor_enabled"],
                                    "revision": row["revision"],
                                    "active": row["active"],
                                }
                            )
                        return {
                            "users": values,
                            "me": who.id,
                            "migration": {
                                "recordsCountKnown": False,
                                "directoryAuthority": "platform",
                                "legacyDirectoryCoverage": "not_verified",
                            },
                        }
                    return response(await accounts.user_directory(
                        request.app.state.db, who, limit=1000, project=project_directory
                    ))
                if name == "directory_avatar":
                    query(request, {"revision"})
                    return await self.endpoint(
                        user_id=request.path_params["user_id"],
                        revision=uuid_value(request.query_params.get("revision")),
                        request=request,
                        who=who,
                    )
                if name == "action_receipt":
                    query(request, set())
                    return response(
                        await self.endpoint(
                            request_id=uuid_value(request.path_params["request_id"]), request=request, who=who
                        )
                    )
                if name == "history":
                    query(request, {"after", "limit"})
                    limit = page_limit(request.query_params.get("limit", "20"))
                    return response(
                        await self.endpoint(
                            request=request,
                            who=who,
                            after=uuid_value(request.query_params["after"])
                            if "after" in request.query_params
                            else None,
                            limit=limit,
                        )
                    )
                query(request, set())
                if name == "delete_user" and request.path_params["user_id"] == who.id:
                    raise HTTPException(400, "不能删除自己的账号")
                raw = await protocol_body(
                    request, 4096 if name in {"delete_user", "disable_managed_totp"} else 8192
                )
                if name == "close":
                    from .account_action_receipts import CloseAccountAction

                    data = CloseAccountAction.model_validate(raw)
                    return response(
                        await self.endpoint(
                            request_id=uuid_value(request.path_params["request_id"]),
                            data=data,
                            request=request,
                            who=who,
                        )
                    )
                # UUID and CAS must be supplied by the caller. No generated UUID
                # or inferred revision; omitted patch fields remain untouched only
                # after the shared authority locks and validates the target CAS.
                translated = dict(raw)
                for old, new in (("currentPassword", "current_password"), ("newPassword", "new_password")):
                    if old in translated:
                        if new in translated:
                            raise HTTPException(422, "重复的管理员验证字段")
                        translated[new] = translated.pop(old)
                if name == "legacy_put_user":
                    data = accounts.UserChange.model_validate(translated)
                    who.require_admin_step_up = True
                    result = await accounts.update_user(request.path_params["user_id"], data, request, who)
                    # A replay must describe the original immutable result, never
                    # a second lookup of a subsequently edited/deleted target.
                    original = result["user"]
                    if result.get("profile") is not None:
                        value = old_user(result["profile"])
                        if value["avatar"].startswith("/api/auth/avatar?"):
                            value["avatar"] = value["avatar"].replace(
                                "/api/auth/avatar?", "/api/users/" + original["id"] + "/avatar?", 1
                            )
                    else:
                        # Older receipts did not record this metadata. Unknown
                        # stays unknown; a current lookup cannot repair history.
                        value = {key: original.get(key) for key in ("id", "username", "email", "role")}
                        value.update(
                            uid=original.get("uid") or "",
                            isTest=original.get("is_test"),
                            nickname=None,
                            avatar=None,
                            emailVerified=None,
                        )
                    return response(
                        {
                            "user": value,
                            "request_id": result["request_id"],
                            "changed": result["changed"],
                            "revision": result["user"].get("revision"),
                            **({key: result[key] for key in ("retired", "redacted", "snapshot_state")} if result.get("redacted") else {}),
                        }
                    )
                if name == "delete_user":
                    data = accounts.AccountRemoval.model_validate(translated)
                    result = await self.endpoint(request.path_params["user_id"], data, request, who)
                    return response(result | {"ok": True})
                if name == "reset_managed_password":
                    # Keep mandatory admission proof distinct from the old
                    # password contract, including its UTF-16 length semantics.
                    uuid_value(translated.get("request_id"))
                    uuid_value(translated.get("revision"))
                    password = translated.get("new_password", "")
                    if not isinstance(password, str):
                        raise HTTPException(400, "密码格式不正确")
                    length = js_length(password)
                    if length < 8:
                        raise HTTPException(400, "密码至少 8 位")
                    if length > 128:
                        raise HTTPException(400, "密码最多 128 位")
                    from .passwords import password_error

                    if password_error(password):
                        raise HTTPException(400, "密码需同时包含字母和数字")
                data = accounts.ManagedCredentials.model_validate(translated)
                result = await self.endpoint(request.path_params["user_id"], data, request, who)
                return response(result)
            except ValidationError as error:
                fields = {issue["loc"][0] for issue in error.errors(include_input=False) if issue["loc"]}
                if fields == {"current_password"}:
                    return response({"error": "管理员密码不正确"}, 403)
                if fields == {"username"}:
                    return response({"error": "用户名需为 3-20 位字母、数字、下划线或中文"}, 400)
                if fields == {"email"}:
                    return response({"error": "邮箱格式不正确"}, 400)
                if fields == {"role"} and all(issue["type"] != "missing" for issue in error.errors(include_input=False)):
                    return response({"error": "角色不正确"}, 400)
                return response({"error": "请求参数无效；写入必须提供原请求编号和账号版本"}, 422)
            except HTTPException as error:
                status, message = error.status_code, str(error.detail)
                if status == 403 and message in {"当前密码不正确", "请核对当前管理员密码"}:
                    message = "管理员密码不正确"
                elif status == 403 and message in {"二次验证码或备用码不正确", "二次验证失败"}:
                    message = "管理员二次验证失败"
                elif name == "disable_managed_totp" and status == 409 and message == "该用户未开启二次验证":
                    status = 400
                headers = dict(error.headers or {})
                if status == 401 or message in {"需要管理员权限", "操作授权已变化，请重新登录核对", "网页登录身份不一致，请重新登录", "请使用当前管理员网页会话"}:
                    headers["X-Alcor-Retire-Context"] = "true"
                return response({"error": message}, status, headers)

        return handler


def query(request, allowed):
    if set(request.query_params) - allowed or any(
        len(request.query_params.getlist(key)) != 1 for key in request.query_params
    ):
        raise HTTPException(422, "查询字段无效")


def response(value, status=200, headers=None):
    return JSONResponse(
        jsonable_encoder(value), status_code=status, headers={**(headers or {}), "Cache-Control": "private, no-store"}
    )


def old_user(value):
    return {
        key: value[key]
        for key in ("id", "username", "nickname", "uid", "email", "emailVerified", "avatar", "role")
    } | {"isTest": value["is_test"]}


async def protocol_body(request, limit):
    try:
        raw = json.loads(await bounded_body(request, limit), object_pairs_hook=no_duplicate_object)
        if not isinstance(raw, dict):
            raise TypeError()
        return raw
    except (ValueError, TypeError, UnicodeError):
        raise HTTPException(422, "请求参数无效") from None


def uuid_value(value):
    try:
        return UUID(value)
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(422, "原请求编号或账号版本无效") from None


def page_limit(value):
    if not value.isascii() or not value.isdigit() or not 1 <= len(value) <= 2 or not 1 <= int(value) <= 50:
        raise HTTPException(422, "分页数量无效")
    return int(value)
