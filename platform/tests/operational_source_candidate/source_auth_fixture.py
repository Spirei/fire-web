import time

from alcor_api.connections import Vault
from alcor_api.native_identity import totp_code


async def enable_totp(settings, db, user_id):
    secret = "JBSWY3DPEHPK3PXP"
    cipher = Vault(settings.connection_secret_dir).encrypt(secret, "totp:" + user_id, settings.instance_id)
    async with db.connection() as conn:
        await conn.execute(
            "INSERT INTO identity_security(user_id,totp_enabled,totp_secret_ciphertext) VALUES(%s,true,%s)",
            (user_id, cipher),
        )
    return secret


async def proof(secret, db, user_id):
    async with db.connection() as conn:
        await conn.execute("UPDATE identity_security SET totp_last_step=-1 WHERE user_id=%s", (user_id,))
    return totp_code(secret, int(time.time()))


def payload(alias, request_id, secret_code, **extra):
    return {
        "sourceAlias": alias,
        "requestId": str(request_id),
        "password": "Synthetic9Pass",
        "code": secret_code,
        **extra,
    }
