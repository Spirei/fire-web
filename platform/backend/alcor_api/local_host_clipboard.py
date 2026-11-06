"""Opt-in Darwin host PNG clipboard capability, distinct from any client device."""

import asyncio
import base64
import binascii
import hashlib
import io
import os
import platform
import tempfile
from uuid import UUID

from fastapi import HTTPException
from PIL import Image
from psycopg.types.json import Jsonb

from .security import lock_mutation_identity

LIMIT = 8 * 1024 * 1024
SCRIPT = 'on run argv\nset the clipboard to (read (POSIX file (item 1 of argv)) as «class PNGf»)\nreturn "ok"\nend run'


def png(raw):
    if not isinstance(raw, str):
        raise HTTPException(400, "缺少图片数据")
    value = raw.removeprefix("data:image/png;base64,")
    if len(value) > ((LIMIT + 2) // 3) * 4:
        raise HTTPException(400, "图片过大，最大8MiB")
    try:
        decoded = base64.b64decode(value, validate=True)
        if not 0 < len(decoded) <= LIMIT or decoded[:8] != b"\x89PNG\r\n\x1a\n":
            raise ValueError()
        with Image.open(io.BytesIO(decoded)) as image:
            if (
                image.format != "PNG"
                or getattr(image, "n_frames", 1) != 1
                or image.width * image.height > 25_000_000
            ):
                raise ValueError()
            image.verify()
    except (ValueError, binascii.Error, OSError, Image.DecompressionBombError) as exc:
        raise HTTPException(400, "仅支持有效单帧PNG，最大8MiB/2500万像素") from exc
    return decoded


class LocalHostClipboard:
    def __init__(self, db):
        self.db = db

    def installed(self, who):
        return (
            platform.system() == "Darwin"
            and who.id in self.db.settings.local_clipboard_users
            and os.path.isfile("/usr/bin/osascript")
        )

    async def lock(self, conn, who):
        await conn.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("identity-management:" + who.id,)
        )
        await lock_mutation_identity(conn, who, require_admin=False)

    async def capabilities(self, who):
        async with self.db.connection() as conn, conn.transaction():
            await self.lock(conn, who)
            from .fx_reference import external_delivery_blocked
            blocked = await external_delivery_blocked(conn)
            available = self.installed(who) and not blocked
            return {
                "browser": {
                    "clipboardApiRequiresSecureContext": True,
                    "hostCannotInspectClientCapability": True,
                },
                "host": {
                    "available": available,
                    "state": "available"
                    if available
                    else "restored_host_action_blocked"
                    if blocked
                    else "platform_unavailable"
                    if platform.system() != "Darwin"
                    else "not_installed",
                    "platform": "darwin" if platform.system() == "Darwin" else "other",
                    "explicitOwnerApprovalRequired": True,
                    "scope": "configured_server_host_clipboard",
                    "clientClipboardConfirmed": False,
                },
            }

    async def copy(self, who, rid, raw):
        rid = UUID(str(rid))
        image = await asyncio.to_thread(png, raw)
        digest = hashlib.sha256(image).hexdigest()
        async with self.db.connection() as conn, conn.transaction():
            await self.lock(conn, who)
            prior = await (
                await conn.execute(
                    "SELECT * FROM host_clipboard_operations WHERE owner_id=%s AND request_id=%s",
                    (who.id, rid),
                )
            ).fetchone()
            if prior:
                if prior["image_sha256"] != digest:
                    raise HTTPException(409, "原请求UUID用于不同PNG")
                return self.project(prior)
            if not self.installed(who):
                raise HTTPException(503, "此账号未获准使用配置Mac主机剪贴板，请在客户端复制或下载PNG")
            from .fx_reference import external_delivery_blocked

            if await external_delivery_blocked(conn):
                raise HTTPException(409, "恢复实例的主机副作用尚未重新授权")
            await conn.execute(
                "INSERT INTO host_clipboard_operations(owner_id,request_id,image_sha256,byte_length,origin_instance) VALUES(%s,%s,%s,%s,%s)",
                (who.id, rid, digest, len(image), self.db.settings.instance_id),
            )
        result = {
            "requestId": str(rid),
            "state": "unknown",
            "scope": "configured_server_host_clipboard",
            "hostClipboard": True,
            "clientClipboardConfirmed": False,
            "willRetryAutomatically": False,
        }
        path = None
        process = None
        authorization_failure = None
        try:
            with tempfile.NamedTemporaryFile(prefix="alcor-clipboard-", suffix=".png", delete=False) as file:
                path = file.name
                os.fchmod(file.fileno(), 0o600)
                file.write(image)
                file.flush()
                os.fsync(file.fileno())
            # Argument vector and a constant script; user text is never AppleScript source.
            # Recheck the current actor immediately before the one host admission.
            async with self.db.connection() as conn, conn.transaction():
                await self.lock(conn, who)
                if not self.installed(who):
                    raise HTTPException(409, "主机复制许可已撤销")
                if await external_delivery_blocked(conn):
                    raise HTTPException(409, "恢复实例的主机副作用尚未重新授权")
                process = await asyncio.create_subprocess_exec(
                    "/usr/bin/osascript",
                    "-e",
                    SCRIPT,
                    path,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.DEVNULL,
                )
            try:
                async with asyncio.timeout(10):
                    output, _ = await process.communicate()
            except TimeoutError:
                process.kill()
                await process.wait()
                output = b""
            if process.returncode == 0 and output.strip() == b"ok":
                result.update(state="completed", ok=True)
        except HTTPException as exc:
            authorization_failure = exc
            result.update(state="unavailable", reason="authorization_changed_before_host_call")
        except (OSError, ValueError):
            pass
        finally:
            if process is not None and process.returncode is None:
                process.kill()
                await process.wait()
            if path is not None:
                try:
                    os.unlink(path)
                except FileNotFoundError:
                    pass
        # Preserve the admitted UUID/outcome even if the actor changes during OS IO.
        async with self.db.connection() as conn, conn.transaction():
            await conn.execute(
                "UPDATE host_clipboard_operations SET result=%s WHERE owner_id=%s AND request_id=%s AND result IS NULL",
                (Jsonb(result), who.id, rid),
            )
        if authorization_failure is not None and authorization_failure.status_code in (401, 403):
            raise authorization_failure
        async with self.db.connection() as conn, conn.transaction():
            await self.lock(conn, who)
        return self.project({"result": result, "request_id": rid,
            "origin_instance": self.db.settings.instance_id})

    def project(self, row):
        result = row["result"] or {
            "requestId": str(row["request_id"]),
            "state": "unknown",
            "scope": "configured_server_host_clipboard",
            "hostClipboard": True,
            "clientClipboardConfirmed": False,
            "willRetryAutomatically": False,
        }

        return {**result, "originInstance": str(row["origin_instance"]),
            "currentInstanceMatches": str(row["origin_instance"]) == str(self.db.settings.instance_id),
            "currentHostEffectKnown": False,
            "effectAuthority": "recorded_os_call_result_not_current_clipboard_contents"}

    async def receipt(self, who, rid):
        async with self.db.connection() as conn, conn.transaction():
            await self.lock(conn, who)
            row = await (
                await conn.execute(
                    "SELECT * FROM host_clipboard_operations WHERE owner_id=%s AND request_id=%s",
                    (who.id, UUID(str(rid))),
                )
            ).fetchone()
            if not row:
                raise HTTPException(404, "原复制请求不存在")
            return self.project(row)
