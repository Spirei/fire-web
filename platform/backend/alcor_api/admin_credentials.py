"""Administrator recovery uses the same identity authority and durable account receipts."""

import asyncio
import hashlib
import hmac
from uuid import uuid4

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .account_action_receipts import require_open
from .connections import Vault, canonical
from .identity_passkeys import Passkeys
from .identity_service import IdentityService
from .passwords import hash_password, password_error
from .security import lock_mutation_identity


async def recover_credentials(db, who, target, data, action):
    password = data.new_password.get_secret_value() if data.new_password else None
    if action == "reset-password":
        if password is None or (error := password_error(password)):
            raise HTTPException(422, error if password is not None else "请输入新密码")
    elif password is not None:
        raise HTTPException(422, "停用二次验证不能同时修改密码")
    hashed = await asyncio.to_thread(hash_password, password) if password is not None else None
    fingerprint = hmac.new(
        Vault(db.settings.connection_secret_dir).key(),
        canonical(
            {
                "purpose": "admin-credentials-v1",
                "target": target,
                "action": action,
                "revision": str(data.revision),
                "new_password": password,
            }
        ).encode(),
        hashlib.sha256,
    ).hexdigest()
    factors = IdentityService(db.settings, db)
    passkeys = Passkeys(db.settings, db, factors)
    async with db.connection() as conn, conn.transaction():
        await conn.execute("SELECT pg_advisory_xact_lock(67132005)")
        for owner in sorted({who.id, target}):
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("identity-management:" + owner,)
            )
        await lock_mutation_identity(conn, who)
        previous = await (
            await conn.execute(
                "SELECT fingerprint,result,closed FROM account_actions WHERE owner_id=%s AND request_id=%s",
                (who.id, data.request_id),
            )
        ).fetchone()
        if previous:
            require_open(previous)
            if not hmac.compare_digest(previous["fingerprint"], fingerprint):
                raise HTTPException(409, "请求编号已用于其他操作")
            return previous["result"]
        # Password and the actor's enabled factor are checked for each new action.
        # A replay returns the immutable receipt without consuming a second backup code.
        await passkeys.step_up(conn, who, data.current_password.get_secret_value(), data.code)
        user = await (
            await conn.execute(
                "SELECT revision,deleted_at FROM users WHERE id=%s FOR UPDATE",
                (target,),
            )
        ).fetchone()
        if not user or user["deleted_at"]:
            raise HTTPException(404, "账号不存在")
        if user["revision"] != data.revision:
            raise HTTPException(409, "账号已更新，请重新读取")
        factor = await factors.factor(conn, target)
        if action == "disable-totp" and not (factor and factor["totp_enabled"]):
            raise HTTPException(409, "该用户未开启二次验证")
        await conn.execute(
            "UPDATE identity_security SET totp_enabled=false,totp_secret_ciphertext=NULL,"
            "totp_last_step=-1,backup_codes='[]'::jsonb,backup_key_ciphertext=NULL,"
            "device_name='',source_stamp=NULL WHERE user_id=%s",
            (target,),
        )
        if hashed is not None:
            await conn.execute("DELETE FROM identity_passkeys WHERE user_id=%s", (target,))
            await conn.execute("UPDATE users SET password_hash=%s WHERE id=%s", (hashed, target))
        revision = uuid4()
        await conn.execute(
            "UPDATE users SET session_version=session_version+1,revision=%s WHERE id=%s",
            (revision, target),
        )
        await conn.execute("DELETE FROM sessions WHERE user_id=%s", (target,))
        await conn.execute("DELETE FROM identity_challenges WHERE user_id=%s", (target,))
        for table, column in (("client_grants", "owner_id"), ("identity_app_grants", "user_id")):
            await conn.execute(
                "UPDATE "
                + table
                + " SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE "
                + column
                + "=%s",
                (target,),
            )
        result = {
            "request_id": str(data.request_id),
            "action": action,
            "target_id": target,
            "revision": str(revision),
            "ok": True,
            "totpDisabled": True,
            "passkeysRevoked": hashed is not None,
        }
        await conn.execute(
            "INSERT INTO account_actions(owner_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)",
            (who.id, data.request_id, fingerprint, Jsonb(result)),
        )
        await conn.execute(
            "INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,%s,%s,%s)",
            (who.id, "admin." + action, target, data.request_id),
        )
        return result
