"""Owned device inventory and atomic revocation backed by PostgreSQL."""

from fastapi import HTTPException

from .native_app_auth import active_grant
from .security import digest, lock_mutation_identity


def milliseconds(value):
    return int(value.timestamp() * 1000) if value else None


def web_device_id(token_hash):
    return "web_" + digest("security-device:" + token_hash)


class IdentityDevices:
    def __init__(self, db, passkeys):
        self.db, self.passkeys = db, passkeys

    async def app_devices(self, conn, user_id):
        rows = await (
            await conn.execute(
                "SELECT id FROM identity_app_grants WHERE user_id=%s AND revoked_at IS NULL ORDER BY created_at DESC,id DESC",
                (user_id,),
            )
        ).fetchall()
        devices = []
        for row in rows:
            grant = await active_grant(conn, row["id"])
            if grant:
                devices.append(
                    {
                        "id": grant["id"],
                        "name": grant["device_name"],
                        "scope": grant["scope"],
                        "createdAt": milliseconds(grant["created_at"]),
                        "lastUsedAt": milliseconds(grant["last_used_at"]),
                        "expiresAt": milliseconds(grant["expires_at"]),
                    }
                )
        return devices

    async def list(self, who, *, apps_only=False):
        async with self.db.connection() as conn, conn.transaction():
            # Hold the currently authenticated actor while projecting private devices.
            # The earlier HTTP identity check can precede a concurrent revocation.
            await lock_mutation_identity(conn, who, require_admin=False)
            apps = await self.app_devices(conn, who.id)
            if apps_only:
                return {"devices": apps}
            rows = await (
                await conn.execute(
                    "SELECT s.token_hash,s.expires_at,s.created_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.user_id=%s AND s.expires_at>clock_timestamp() AND s.session_version=u.session_version AND u.active ORDER BY s.expires_at DESC,s.token_hash",
                    (who.id,),
                )
            ).fetchall()
        return {
            "devices": [
                dict(device, kind="app", current=device["id"] == getattr(who, "grant_id", None))
                for device in apps
            ]
            + [
                {
                    "id": web_device_id(row["token_hash"]),
                    "kind": "web",
                    "name": "网页登录",
                    "createdAt": milliseconds(row["created_at"]),
                    "lastUsedAt": None,
                    "expiresAt": milliseconds(row["expires_at"]),
                    "current": row["token_hash"] == who.token_hash,
                }
                for row in rows
            ]
        }

    async def remove(self, who, device_id, password, code, request_id, *, apps_only=False):
        async with self.db.connection() as conn, conn.transaction():
            await self.passkeys.serialize(conn, who)
            await lock_mutation_identity(conn, who, require_admin=False)
            # All mutations lock the user before credential/session records.
            await conn.execute("SELECT id FROM users WHERE id=%s FOR UPDATE", (who.id,))
            app = next((row for row in await self.app_devices(conn, who.id) if row["id"] == device_id), None)
            web = None
            if not apps_only:
                rows = await (
                    await conn.execute(
                        "SELECT token_hash FROM sessions WHERE user_id=%s AND expires_at>clock_timestamp()",
                        (who.id,),
                    )
                ).fetchall()
                web = next((row for row in rows if web_device_id(row["token_hash"]) == device_id), None)
                if not web and not app:
                    raise HTTPException(404, "登录设备不存在")
                await self.passkeys.step_up(conn, who, password, code)
            if web:
                await conn.execute(
                    "DELETE FROM sessions WHERE token_hash=%s AND user_id=%s", (web["token_hash"], who.id)
                )
            if app:
                await conn.execute(
                    "UPDATE identity_app_grants SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE id=%s AND user_id=%s",
                    (app["id"], who.id),
                )
            if web or app:
                from .broker_position_transfers import purge_broker_position_transfer_previews
                await purge_broker_position_transfer_previews(conn, who.id)
                from .fund_sources import purge_fund_source_previews
                await purge_fund_source_previews(conn, who.id)
                await conn.execute(
                    "INSERT INTO audit_events(actor_id,action,request_id) VALUES(%s,'identity.device.revoked',%s)",
                    (who.id, request_id),
                )
            return {
                "revoked": True,
                "reauthenticationRequired": bool(
                    (web and web["token_hash"] == who.token_hash)
                    or (app and app["id"] == getattr(who, "grant_id", None))
                ),
            }
