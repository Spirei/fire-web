"""Legacy Web passkey contracts over the platform's common PG services."""

import re
import secrets
from types import SimpleNamespace

from fastapi import HTTPException, Request, Response

from .identity_passkeys import Passkeys
from .identity_passkey_management import PasskeyManagement
from .security import digest, trusted_origin

PATH = "/api/auth/passkeys"
CHALLENGE_COOKIE = "fire_passkey_challenge"
CLIENT_COOKIE = "fire_passkey_client"
ACTIONS = {"login-options", "login-verify", "register-options", "register-verify"}


def text(data, key, *, default="", maximum=128, minimum=0, trim=False, label=False):
    value = data.get(key, default)
    if not isinstance(value, str):
        raise HTTPException(400, "请求参数无效")
    if trim:
        value = value.strip()
    if not minimum <= len(value.encode("utf-16-le")) // 2 <= maximum:
        raise HTTPException(400, "请求参数无效")
    if label and any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise HTTPException(400, "名称不能包含控制字符")
    return value


def action_input(data):
    action = data.get("action")
    if not isinstance(action, str) or action not in ACTIONS:
        raise HTTPException(400, "不支持的操作")
    credential = data.get("response", {})
    if not isinstance(credential, dict):
        raise HTTPException(400, "请求参数无效")
    return SimpleNamespace(
        action=action,
        requestId=text(data, "requestId"),
        response=credential,
        password=text(data, "password"),
        code=text(data, "code", maximum=32),
        name=text(data, "name", default="通行密钥", maximum=64, minimum=1, trim=True, label=True),
    )


def public_config(value):
    return {key: value[key] for key in ("enabled", "origin", "name", "revision")}


def mount_legacy_passkeys(
    app, settings, db, factors, rate_limit, web_identity, read_body, create_session
):
    passkeys = Passkeys(
        settings, db, factors, client_id="legacy-web", cookie_name=CHALLENGE_COOKIE, cookie_path=PATH
    )
    management = PasskeyManagement(settings, db, passkeys)
    app.state.legacy_passkeys = passkeys
    app.state.legacy_passkey_management = management

    async def member(request, action=None, maximum=15):
        who, _, _ = await web_identity(request)
        if action:
            shared = await rate_limit(db, digest("identity-manage:" + who.id), 20)
            own = await rate_limit(db, digest("legacy-passkey-" + action + ":" + who.id), maximum)
            if not shared or not own:
                raise HTTPException(429, "操作过于频繁，请稍后再试")
        return who

    async def anonymous_budget(request, response, *, options):
        address = request.client.host if request.client else "unknown"
        if not await rate_limit(db, digest("legacy-passkey-ip:" + address), 100, window_seconds=60):
            raise HTTPException(429, "尝试过于频繁，请稍后再试")
        if not options:
            return
        token = request.cookies.get(CLIENT_COOKIE, "")
        async with db.connection() as conn, conn.transaction():
            known = None
            if re.fullmatch(r"[A-Za-z0-9_-]{43}", token):
                known = await (
                    await conn.execute(
                        "SELECT 1 FROM identity_challenges WHERE id=%s AND purpose='legacy-passkey-browser' AND expires_at>clock_timestamp()",
                        (digest("legacy-passkey-browser:" + token),),
                    )
                ).fetchone()
            if not known:
                token = secrets.token_urlsafe(32)
                await conn.execute(
                    "DELETE FROM identity_challenges WHERE purpose='legacy-passkey-browser' AND expires_at<=clock_timestamp()"
                )
                await conn.execute(
                    "INSERT INTO identity_challenges(id,purpose,binding,payload,expires_at) VALUES(%s,'legacy-passkey-browser','','{}',clock_timestamp()+interval '15 minutes')",
                    (digest("legacy-passkey-browser:" + token),),
                )
        if not await rate_limit(db, digest("legacy-passkey-options-browser:" + token), 30):
            raise HTTPException(429, "尝试过于频繁，请稍后再试")
        response.set_cookie(
            CLIENT_COOKIE, token, httponly=True, secure=settings.secure_cookie,
            samesite="strict", max_age=900, path=PATH,
        )
        return token

    @app.get(PATH + "/config", tags=["legacy-web-identity"])
    async def config():
        return public_config(await management.config())

    @app.put(PATH + "/config", tags=["legacy-web-identity"])
    async def configure(request: Request):
        who = await member(request, "config", 10)
        if who.role != "admin":
            raise HTTPException(403, "需要管理员权限")
        raw = await read_body(
            request, ("enabled", "origin", "name", "revision", "expectedRevision", "currentPassword", "code"),
            limit=8192,
        )
        if type(raw.get("enabled")) is not bool:
            raise HTTPException(400, "请选择是否启用通行密钥")
        revision = raw.get("expectedRevision")
        if "expectedRevision" in raw and not isinstance(revision, str):
            raise HTTPException(400, "登录设置版本无效，请刷新页面")
        if revision is not None and len(revision) > 128:
            raise HTTPException(400, "登录设置版本无效，请刷新页面")
        data = SimpleNamespace(
            enabled=raw["enabled"], origin=text(raw, "origin", maximum=1024, trim=True),
            name=text(raw, "name", default="Alcor", maximum=64, minimum=1, trim=True, label=True),
            revision=revision, password=text(raw, "currentPassword"), code=text(raw, "code", maximum=32),
        )
        try:
            result = await management.configure(data, who, expected_optional=True)
        except HTTPException as exc:
            if exc.status_code == 422:
                raise HTTPException(400, str(exc.detail)) from None
            raise
        return public_config(result)

    @app.get(PATH, tags=["legacy-web-identity"])
    async def list_keys(request: Request):
        return await management.list(await member(request))

    @app.post(PATH, tags=["legacy-web-identity"])
    async def action(request: Request, response: Response):
        trusted_origin(request)
        if request.headers.get("authorization"):
            raise HTTPException(403, "请使用网页登录会话")
        raw = await read_body(
            request, ("action", "requestId", "response", "password", "code", "name"), limit=32768
        )
        data = action_input(raw)
        who = None
        browser_nonce = None
        if data.action.startswith("login-"):
            browser_nonce = await anonymous_budget(request, response, options=data.action == "login-options")
        else:
            who = await member(request, "enroll", 10)
        try:
            if data.action == "login-options":
                return await passkeys.login_options(request, response, browser_nonce=browser_nonce)
            if data.action == "login-verify":
                _, token, _ = await passkeys.login_verify(data, request, response, create_session)
                response.set_cookie(
                    "fire_session", token, httponly=True, secure=settings.secure_cookie,
                    samesite="lax", max_age=604800, path="/",
                )
                return {"ok": True}
            if data.action == "register-options":
                return await passkeys.register_options(data, request, response, who)
            return await passkeys.register_verify(data, request, who)
        except HTTPException as exc:
            if exc.status_code in {403, 409}:
                raise HTTPException(400, str(exc.detail)) from None
            raise

    @app.patch(PATH, tags=["legacy-web-identity"])
    async def rename(request: Request):
        who = await member(request, "manage")
        raw = await read_body(request, ("id", "name"), limit=8192)
        try:
            data = SimpleNamespace(
                id=text(raw, "id", maximum=2048, minimum=1),
                name=text(raw, "name", maximum=64, minimum=1, trim=True, label=True),
            )
        except HTTPException as exc:
            raise HTTPException(403, str(exc.detail)) from None
        return await management.rename(data, who)

    @app.delete(PATH, tags=["legacy-web-identity"])
    async def remove(request: Request):
        who = await member(request, "manage")
        raw = await read_body(request, ("id", "password", "code"), limit=8192)
        data = SimpleNamespace(
            id=text(raw, "id", maximum=2048, minimum=1), password=text(raw, "password"),
            code=text(raw, "code", maximum=32),
        )
        return await management.remove(data, who)
