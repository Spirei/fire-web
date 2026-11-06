"""Owner recipient proof, encrypted challenge state and shared delivery creation."""

import hmac
import secrets
from datetime import UTC, datetime
from uuid import uuid4

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .business_notifications import append
from .native_app_auth import active_grant
from .notification_provider_protocols import recipient
from .notification_security import principal
from .security import lock_mutation_identity


async def subject_alive(conn, row):
    user = await (await conn.execute("SELECT * FROM users WHERE id=%s", (row["owner_id"],))).fetchone()
    if not user or not user["active"] or user["session_version"] != row["session_version"]:
        return False
    if row["native_grant_id"]:
        grant = await active_grant(conn, row["native_grant_id"])
        return bool(
            grant and grant["user_id"] == row["owner_id"] and "portfolio.write" in grant["scope"].split()
        )
    return bool(
        await (
            await conn.execute(
                """SELECT 1 FROM sessions WHERE user_id=%s AND token_hash=%s
        AND client_id='new-web' AND session_version=%s AND expires_at>clock_timestamp()""",
                (row["owner_id"], row["principal"].removeprefix("web:"), row["session_version"]),
            )
        ).fetchone()
    )


class Bindings:
    def __init__(self, service, providers):
        self.service, self.db, self.providers = service, service.db, providers
        self.security = providers.security

    async def provider(self, conn, owner, channel, *, require_probe=True):
        row = await self.providers.current(conn, owner, channel)
        if row is None:
            raise HTTPException(503, "通知通道尚未配置")
        self.providers.materialize(row)
        if require_probe and not await self.providers.checked(conn, row):
            raise HTTPException(503, "请先通过当前通知配置的连接测试")
        return row

    async def state(self, conn, owner, channel):
        result = {
            "channel": channel,
            "ready": False,
            "configured": False,
            "destination": "",
            "pendingConfirmation": False,
        }
        provider = await self.providers.current(conn, owner, channel)
        if provider is None:
            return result
        try:
            self.providers.materialize(provider)
            result["configured"] = True
        except HTTPException:
            return {**result, "verificationState": "configuration_unavailable"}
        checked = await self.providers.checked(conn, provider)
        binding = await (
            await conn.execute(
                """SELECT b.* FROM business_notification_bindings b JOIN users u ON u.id=b.owner_id
            WHERE b.owner_id=%s AND b.channel=%s AND b.revoked_at IS NULL AND b.verified_at IS NOT NULL
            AND b.config_stamp=%s AND b.origin_instance=%s AND b.session_version=u.session_version AND u.active""",
                (owner, channel, provider["config_stamp"], self.db.settings.instance_id),
            )
        ).fetchone()
        if binding and checked and await subject_alive(conn, binding):
            try:
                destination = self.security.decrypt(
                    binding["recipient_cipher"], "recipient:" + owner + ":" + channel
                )
                if channel == "email" and not await self.email_matches(conn, owner, destination):
                    binding = None
                else:
                    result.update(
                        ready=True,
                        destination=destination[-4:]
                        if channel != "email"
                        else destination[:2] + "***@" + destination.split("@")[-1],
                        lastVerifiedAt=int(checked["checked_at"].timestamp() * 1000),
                    )
            except HTTPException:
                binding = None
        pending = await self.challenge(conn, owner, channel)
        if (
            pending
            and pending["valid"]
            and pending["attempts"] < 6
            and pending["provider_revision"] == provider["revision"]
            and pending["state"]
            in ({"received"} if channel == "telegram" else {"queued", "sending", "accepted", "unknown"})
        ):
            result.update(
                pendingConfirmation=True,
                challengeId=str(pending["id"]),
                verificationState=pending["state"],
                verificationExpiresAt=int(pending["expires_at"].timestamp() * 1000),
            )
            if not result["ready"] and pending["recipient_cipher"]:
                destination = self.security.decrypt(
                    pending["recipient_cipher"], "challenge-recipient:" + str(pending["id"])
                )
                result["destination"] = "待确认 · " + destination[-4:]
        elif not result["ready"] and not checked:
            last = await self.providers.last_check(conn, provider)
            result["verificationState"] = "provider_" + last["status"] if last else "provider_untested"
        return result

    async def challenge(self, conn, owner, channel):
        return await (
            await conn.execute(
                """SELECT *,expires_at>clock_timestamp() AS valid FROM business_notification_challenges
            WHERE owner_id=%s AND channel=%s ORDER BY created_at DESC,id DESC LIMIT 1""",
                (owner, channel),
            )
        ).fetchone()

    async def email_matches(self, conn, owner, destination):
        return bool(
            await (
                await conn.execute(
                    "SELECT 1 FROM users u JOIN identity_security s ON s.user_id=u.id WHERE u.id=%s AND lower(u.email)=lower(%s) AND s.email_verified AND u.active",
                    (owner, destination),
                )
            ).fetchone()
        )

    async def bind(self, conn, who, provider, destination):
        user = await (
            await conn.execute("SELECT session_version FROM users WHERE id=%s", (who.id,))
        ).fetchone()
        cipher = self.security.encrypt(destination, "recipient:" + who.id + ":" + provider["channel"])
        await conn.execute(
            """INSERT INTO business_notification_bindings(owner_id,channel,origin_instance,config_stamp,recipient_cipher,
            verified_at,provider_revision,principal,native_grant_id,session_version)
            VALUES(%s,%s,%s,%s,%s,clock_timestamp(),%s,%s,%s,%s) ON CONFLICT(owner_id,channel) DO UPDATE SET
            origin_instance=excluded.origin_instance,config_stamp=excluded.config_stamp,recipient_cipher=excluded.recipient_cipher,
            verified_at=excluded.verified_at,revoked_at=NULL,provider_revision=excluded.provider_revision,principal=excluded.principal,
            native_grant_id=excluded.native_grant_id,session_version=excluded.session_version""",
            (
                who.id,
                provider["channel"],
                self.db.settings.instance_id,
                provider["config_stamp"],
                cipher,
                provider["revision"],
                principal(who),
                getattr(who, "grant_id", None),
                user["session_version"],
            ),
        )

    async def apply(self, conn, who, raw, proof, *, legacy=False):
        action = raw["action"]
        channel = raw.get("channel") if action in {"channel", "test"} else action.split("_", 1)[0]
        if channel not in {"email", "telegram", "wechat", "feishu", "discord", "qq"}:
            raise HTTPException(400, "通知通道无效")
        provider = None if action.endswith("_disconnect") else await self.provider(conn, who.id, channel)
        if action != "test":
            preference = await (
                await conn.execute(
                    "SELECT channel_revision FROM price_alert_collections WHERE owner_id=%s", (who.id,)
                )
            ).fetchone()
            if type(raw.get("revision")) is not int or raw["revision"] != preference["channel_revision"]:
                raise HTTPException(409, "通知设置已变化，请刷新后核对")
        if legacy:
            # Exact old native routes already represented explicit connection
            # consent. Keep that protocol; never grant this to cookie/Web callers.
            grant = await active_grant(conn, getattr(who, 'grant_id', None)) if getattr(who, 'native_client', False) else None
            if not grant or grant['user_id']!=who.id or 'portfolio.write' not in grant['scope'].split():
                raise HTTPException(403, '需要有效的 App 写入授权')
        else:
            await self.security.consume(conn, who, raw, proof)
        if action.endswith("_start"):
            destination = raw.get("recipient")
            if not recipient(channel, destination):
                raise HTTPException(400, "请填写单个有效的本人接收账号")
            from .main import rate_limit

            if not await rate_limit(
                self.db, self.security.mac(["binding-owner", channel, who.id]), 5, window_seconds=3600
            ) or not await rate_limit(
                self.db,
                self.security.mac(
                    ["binding-recipient", channel, provider["config_stamp"], destination.lower()]
                ),
                5,
                window_seconds=3600,
            ):
                raise HTTPException(429, "验证码发送过于频繁，请稍后再试")
            identifier, code = uuid4(), str(secrets.randbelow(900000) + 100000)
            user = await (
                await conn.execute("SELECT session_version FROM users WHERE id=%s", (who.id,))
            ).fetchone()
            await conn.execute(
                "UPDATE business_notification_challenges SET state='cancelled',code_cipher=NULL WHERE owner_id=%s AND channel=%s AND state NOT IN ('confirmed','cancelled')",
                (who.id, channel),
            )
            await conn.execute(
                """INSERT INTO business_notification_challenges(owner_id,id,channel,provider_revision,principal,native_grant_id,
                session_version,recipient_cipher,code_cipher,code_mac,expires_at,state)
                VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,clock_timestamp()+interval '5 minutes','queued')""",
                (
                    who.id,
                    identifier,
                    channel,
                    provider["revision"],
                    principal(who),
                    getattr(who, "grant_id", None),
                    user["session_version"],
                    self.security.encrypt(destination, "challenge-recipient:" + str(identifier)),
                    self.security.encrypt(code, "challenge-code:" + str(identifier)),
                    self.security.mac([str(identifier), code]),
                ),
            )
            event_id = await append(
                conn,
                who.id,
                "notification.binding",
                "notification-binding:" + str(identifier),
                {"challengeId": str(identifier), "channel": channel},
                channels=(channel,),
            )
            await conn.execute(
                "UPDATE business_notification_challenges SET event_id=%s WHERE owner_id=%s AND id=%s",
                (event_id, who.id, identifier),
            )
        elif action.endswith("_confirm"):
            row = await self.challenge(conn, who.id, channel)
            if (
                not row
                or not row["valid"]
                or row["attempts"] >= 6
                or row["provider_revision"] != provider["revision"]
                or row["principal"] != principal(who)
                or not await subject_alive(conn, row)
                or row["state"]
                not in ({"received"} if channel == "telegram" else {"sending", "accepted", "unknown"})
            ):
                raise HTTPException(409, "验证码已失效、未发送或不属于当前授权")
            if channel != "telegram":
                await conn.execute(
                    "UPDATE business_notification_challenges SET attempts=attempts+1 WHERE owner_id=%s AND id=%s",
                    (who.id, row["id"]),
                )
                value = raw.get("verificationCode")
                if (
                    raw.get("challengeId") != str(row["id"])
                    or not isinstance(value, str)
                    or not hmac.compare_digest(
                        row["code_mac"] or "", self.security.mac([str(row["id"]), value])
                    )
                ):
                    if row["attempts"] >= 5:
                        await conn.execute(
                            "UPDATE business_notification_challenges SET state='locked',code_mac=NULL,code_cipher=NULL,recipient_cipher='' WHERE owner_id=%s AND id=%s",
                            (who.id, row["id"]),
                        )
                    return "binding_code_incorrect"
            destination = self.security.decrypt(
                row["recipient_cipher"], "challenge-recipient:" + str(row["id"])
            )
            await self.bind(conn, who, provider, destination)
            await conn.execute(
                "UPDATE business_notification_challenges SET state='confirmed',code_cipher=NULL,code_mac=NULL,token_mac=NULL WHERE owner_id=%s AND id=%s",
                (who.id, row["id"]),
            )
            if raw.get("enabled") is not None and type(raw["enabled"]) is not bool:
                raise HTTPException(400, "启用状态无效")
            await conn.execute(
                "UPDATE price_alert_collections SET preferences=preferences||%s WHERE owner_id=%s",
                (Jsonb({channel: raw.get("enabled") is True}), who.id),
            )
        elif action.endswith("_disconnect"):
            await conn.execute(
                "UPDATE business_notification_bindings SET revoked_at=clock_timestamp(),recipient_cipher='' WHERE owner_id=%s AND channel=%s",
                (who.id, channel),
            )
            await conn.execute(
                "UPDATE business_notification_challenges SET state='cancelled',code_cipher=NULL,recipient_cipher='',code_mac=NULL,token_mac=NULL WHERE owner_id=%s AND channel=%s",
                (who.id, channel),
            )
            await conn.execute(
                "UPDATE business_notification_deliveries SET state='cancelled',updated_at=clock_timestamp() WHERE owner_id=%s AND channel=%s AND state='queued'",
                (who.id, channel),
            )
            await conn.execute(
                "UPDATE price_alert_collections SET preferences=preferences||%s WHERE owner_id=%s",
                (Jsonb({channel: False}), who.id),
            )
        elif action == "channel":
            if type(raw.get("enabled")) is not bool:
                raise HTTPException(400, "启用状态无效")
            if channel == "email" and raw["enabled"]:
                user = await (await conn.execute("SELECT email FROM users WHERE id=%s", (who.id,))).fetchone()
                if not await self.email_matches(conn, who.id, user["email"]):
                    raise HTTPException(409, "请先完成当前本人邮箱验证")
                await self.bind(conn, who, provider, user["email"])
            elif raw["enabled"] and not (await self.state(conn, who.id, channel))["ready"]:
                raise HTTPException(409, "请先完成本人通知方式绑定")
            await conn.execute(
                "UPDATE price_alert_collections SET preferences=preferences||%s WHERE owner_id=%s",
                (Jsonb({channel: raw["enabled"]}), who.id),
            )
        else:
            if not (await self.state(conn, who.id, channel))["ready"]:
                raise HTTPException(409, "通知方式未完成本人绑定")
            now = datetime.now(UTC)
            await append(
                conn,
                who.id,
                "price.alert.test",
                "price-alert-external-test:" + str(uuid4()),
                {
                    "kind": "test",
                    "ruleId": "",
                    "name": "Alcor",
                    "code": "",
                    "market": "",
                    "currency": "",
                    "direction": "above",
                    "target": "0",
                    "price": 0,
                    "session": "",
                    "quoteTime": "",
                    "createdAt": int(now.timestamp() * 1000),
                    "principal": principal(who),
                    "nativeGrantId": getattr(who, "grant_id", None),
                    "sessionVersion": (
                        await (
                            await conn.execute("SELECT session_version FROM users WHERE id=%s", (who.id,))
                        ).fetchone()
                    )["session_version"],
                },
                channels=(channel,),
                created_at=now,
            )
        if action != "test":
            await conn.execute(
                "UPDATE price_alert_collections SET channel_revision=channel_revision+1 WHERE owner_id=%s",
                (who.id,),
            )
        return None

    async def begin_telegram(self, who, proof, *, request_id=None, legacy=False):
        async with self.db.connection() as conn, conn.transaction():
            await lock_mutation_identity(conn, who, require_admin=False)
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("price-alert-owner:" + who.id,)
            )
            from uuid import UUID

            generated = request_id is None
            try:
                request_id = UUID(str(request_id)) if request_id else uuid4()
            except (ValueError, TypeError) as exc:
                raise HTTPException(400, "请求编号无效") from exc
            prior = await (
                await conn.execute(
                    "SELECT * FROM business_notification_telegram_link_operations WHERE owner_id=%s AND request_id=%s",
                    (who.id, request_id),
                )
            ).fetchone()
            if prior:
                return await self.link_result(conn, who, prior)
            provider = await self.provider(conn, who.id, "telegram")
            _, values = self.providers.materialize(provider)
            if legacy:
                if not getattr(who, "grant_id", None):
                    raise HTTPException(403, "需要有效的 App 写入授权")
                grant = await active_grant(conn, who.grant_id)
                if not grant or grant["user_id"] != who.id or "portfolio.write" not in grant["scope"].split():
                    raise HTTPException(403, "需要有效的 App 写入授权")
            else:
                await self.security.consume(conn, who, {"action": "telegram_link"}, proof)
            from .main import rate_limit

            if not await rate_limit(
                self.db, self.security.mac(["telegram-link", who.id]), 5, window_seconds=60
            ):
                raise HTTPException(429, "绑定过于频繁，请稍后再试")
            identifier, token = uuid4(), secrets.token_urlsafe(32)
            user = await (
                await conn.execute("SELECT session_version FROM users WHERE id=%s", (who.id,))
            ).fetchone()
            await conn.execute(
                "INSERT INTO price_alert_collections(owner_id) VALUES(%s) ON CONFLICT DO NOTHING", (who.id,)
            )
            await conn.execute(
                "UPDATE business_notification_challenges SET state='cancelled',token_mac=NULL WHERE owner_id=%s AND channel='telegram' AND state NOT IN ('confirmed','cancelled')",
                (who.id,),
            )
            row = await (
                await conn.execute(
                    """INSERT INTO business_notification_challenges(owner_id,id,channel,provider_revision,principal,native_grant_id,
                session_version,token_mac,expires_at,state) VALUES(%s,%s,'telegram',%s,%s,%s,%s,%s,clock_timestamp()+interval '5 minutes','queued') RETURNING expires_at""",
                    (
                        who.id,
                        identifier,
                        provider["revision"],
                        principal(who),
                        getattr(who, "grant_id", None),
                        user["session_version"],
                        self.security.mac(["telegram-start", token]),
                    ),
                )
            ).fetchone()
            url = "https://t.me/" + values["botUsername"] + "?start=" + token
            saved = await (
                await conn.execute(
                    """INSERT INTO business_notification_telegram_link_operations
                (owner_id,request_id,challenge_id,origin_instance,principal,session_version,url_cipher,expires_at,generated)
                VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *""",
                    (
                        who.id,
                        request_id,
                        identifier,
                        self.db.settings.instance_id,
                        principal(who),
                        user["session_version"],
                        self.security.encrypt(url, "telegram-link:" + str(request_id)),
                        row["expires_at"],
                        generated,
                    ),
                )
            ).fetchone()
            return await self.link_result(conn, who, saved)

    async def link_result(self, conn, who, row):
        if str(row["origin_instance"]) != str(self.db.settings.instance_id) or row["principal"] != principal(
            who
        ):
            raise HTTPException(403, "绑定回执不属于当前会话")
        challenge = await (
            await conn.execute(
                "SELECT * FROM business_notification_challenges WHERE owner_id=%s AND id=%s",
                (who.id, row["challenge_id"]),
            )
        ).fetchone()
        state, url = "unavailable", None
        if challenge and await subject_alive(conn, challenge):
            current = await self.providers.current(conn, who.id, "telegram")
            if current and current["revision"] == challenge["provider_revision"]:
                try:
                    self.providers.materialize(current)
                    state = challenge["state"]
                    if row["expires_at"] <= datetime.now(UTC):
                        state = "expired"
                    elif state == "queued":
                        url = self.security.decrypt(
                            row["url_cipher"], "telegram-link:" + str(row["request_id"])
                        )
                        state = "pending"
                except HTTPException:
                    state = "unavailable"
        return {
            "requestId": str(row["request_id"]),
            "receiptId": str(row["request_id"]),
            "challengeId": str(row["challenge_id"]),
            "url": url,
            "state": state,
            "expiresAt": int(row["expires_at"].timestamp() * 1000),
            "legacyClientIdempotency": not row["generated"],
        }

    async def link_receipt(self, who, request_id):
        from uuid import UUID

        try:
            request_id = UUID(str(request_id))
        except ValueError as exc:
            raise HTTPException(400, "请求编号无效") from exc
        async with self.db.connection() as conn, conn.transaction():
            await lock_mutation_identity(conn, who, require_admin=False)
            row = await (
                await conn.execute(
                    "SELECT * FROM business_notification_telegram_link_operations WHERE owner_id=%s AND request_id=%s",
                    (who.id, request_id),
                )
            ).fetchone()
            if not row:
                raise HTTPException(404, "绑定回执不存在")
            return await self.link_result(conn, who, row)
