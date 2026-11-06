"""Old Web TOTP contract over the same PG-backed factor management service."""

from types import SimpleNamespace

from fastapi import HTTPException, Request, Response

from .security import digest

SETUP_COOKIE = "alcor_web_totp_setup"
SETUP_PATH = "/api/auth/totp"


def factor_input(data):
    password, code, name = data.get("password", ""), data.get("code", ""), data.get("name", "身份验证应用")
    if (
        not isinstance(password, str)
        or len(password.encode("utf-16-le")) // 2 > 128
        or not isinstance(code, str)
        or not 1 <= len(code) <= 32
        or not isinstance(name, str)
    ):
        raise HTTPException(400, "请求参数无效")
    name = name.strip()
    if not name or len(name.encode("utf-16-le")) // 2 > 64 or any(ord(c) < 32 or ord(c) == 127 for c in name):
        raise HTTPException(400, "名称需为1至64个字符")
    return SimpleNamespace(password=password, code=code, name=name)


def mount_legacy_totp(app, settings, db, management, rate_limit, web_identity, read_body):
    async def member(request, action=None):
        who, _, _ = await web_identity(request)
        if action:
            shared = await rate_limit(db, digest("identity-manage:" + who.id), 20)
            own = await rate_limit(
                db, digest("legacy-totp-" + action + ":" + who.id), 8 if action == "setup" else 20
            )
            if not shared or not own:
                raise HTTPException(429, "尝试过于频繁，请稍后再试")
        return who

    @app.get(SETUP_PATH, tags=["legacy-web-identity"])
    async def status(request: Request):
        who = await member(request)
        value = await management.status(who)
        return {
            "enabled": value["enabled"],
            "name": (value["name"] or "身份验证应用") if value["enabled"] else "",
        }

    @app.post(SETUP_PATH, tags=["legacy-web-identity"])
    async def begin(request: Request, response: Response):
        who = await member(request, "setup")
        value = await management.setup(SimpleNamespace(password="", code=""), who, stage_only=True)
        response.set_cookie(
            SETUP_COOKIE,
            value["challengeId"],
            path=SETUP_PATH,
            httponly=True,
            secure=settings.secure_cookie,
            samesite="strict",
            max_age=600,
        )
        return {key: value[key] for key in ("secret", "otpauthUrl", "qrPng")}

    @app.put(SETUP_PATH, tags=["legacy-web-identity"])
    async def confirm(request: Request, response: Response):
        who = await member(request, "confirm")
        data = factor_input(await read_body(request, ("password", "code", "name"), limit=4096))
        data.challengeId = request.cookies.get(SETUP_COOKIE, "")
        if not data.challengeId or len(data.challengeId) > 64:
            raise HTTPException(400, "设置已过期，请重新开始")
        result = await management.confirm(data, who, recent_allowed=True)
        response.delete_cookie(SETUP_COOKIE, path=SETUP_PATH)
        return {"ok": True, "backupCodes": result["backupCodes"]}

    @app.delete(SETUP_PATH, tags=["legacy-web-identity"])
    async def disable(request: Request, response: Response):
        who = await member(request, "disable")
        data = factor_input(await read_body(request, ("password", "code"), limit=4096))
        try:
            await management.disable(data, who)
        except HTTPException as exc:
            if exc.status_code in {403, 409}:
                raise HTTPException(400, "密码或验证码不正确，或尚未开启二次验证") from None
            raise
        response.delete_cookie(SETUP_COOKIE, path=SETUP_PATH)
        return {"ok": True}
