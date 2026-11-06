"""Atomic legacy account/profile patch over shared account, email and profile writers."""

import re
from types import SimpleNamespace
from uuid import uuid4

from fastapi import HTTPException

from . import profiles
from .identity_email_change import IdentityEmailChange, email_value


def units(text):
    try:
        text.encode("utf-8")
        return len(text.encode("utf-16-le")) // 2
    except UnicodeError:
        raise HTTPException(400, "资料包含无效字符") from None


class ProfileUpdate:
    def __init__(self, settings, db, mail):
        self.db = db
        self.email = IdentityEmailChange(settings, db, mail)

    async def save(self, who, raw, request_id, strict=True):
        allowed = {"username", "nickname", "email", "currentPassword", "code"}
        if not isinstance(raw, dict) or (strict and set(raw) - allowed):
            raise HTTPException(400, "包含不支持修改的字段")
        patch = {}
        for key in ("username", "nickname", "email"):
            if key in raw:
                if not isinstance(raw[key], str):
                    raise HTTPException(400, "资料字段必须为文字")
                units(raw[key])
                patch[key] = raw[key].strip()
        if strict and not patch:
            raise HTTPException(400, "请选择要修改的资料")
        if "username" in patch and not re.fullmatch(r"[a-zA-Z0-9_\u4e00-\u9fa5]{3,20}", patch["username"]):
            raise HTTPException(400, "用户名需为3-20位字母、数字、下划线或中文")
        if "nickname" in patch and units(patch["nickname"]) > 20:
            raise HTTPException(400, "昵称最多20个字符")
        if "email" in patch:
            patch["email"] = email_value(patch["email"])
        if "code" in raw and (not isinstance(raw["code"], str) or units(raw["code"]) > 64):
            raise HTTPException(400, "验证码格式不正确")
        async with self.db.connection() as conn, conn.transaction():
            user = await self.email.owner(conn, who)
            await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("profile:" + who.id,))
            if "username" in patch:
                conflict = await (
                    await conn.execute(
                        "SELECT 1 FROM users WHERE id<>%s AND (lower(username)=lower(%s) OR lower(email)=lower(%s))",
                        (who.id, patch["username"], patch["username"]),
                    )
                ).fetchone()
                if conflict:
                    raise HTTPException(409, "用户名已被使用")
            if "email" in patch and patch["email"].lower() != user["email"].strip().lower():
                password = raw.get("currentPassword", "")
                if not isinstance(password, str) or units(password) > 512:
                    raise HTTPException(403, "修改邮箱需要验证当前密码")
                await self.email.direct_locked(
                    conn, who, user, patch["email"], password, raw.get("code", ""), request_id
                )
            elif "email" in patch:
                await conn.execute(
                    "UPDATE users SET email=%s,revision=%s WHERE id=%s", (patch["email"], uuid4(), who.id)
                )
            if "username" in patch:
                await conn.execute(
                    "UPDATE users SET username=%s,revision=%s WHERE id=%s",
                    (patch["username"], uuid4(), who.id),
                )
            if "nickname" in patch:
                current = await profiles.read_profile(conn, who.id)
                data = SimpleNamespace(
                    display_name=patch["nickname"],
                    revision=current["revision"],
                    model_fields_set={"display_name"},
                )
                await profiles.write_profile_locked(conn, who, data, None, request_id)
            await conn.execute(
                "INSERT INTO audit_events(actor_id,action,request_id) VALUES(%s,'profile.legacy.updated',%s)",
                (who.id, request_id),
            )
