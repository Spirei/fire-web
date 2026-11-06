"""Owner-encrypted provider revisions constrained by instance-installed targets."""

import hashlib
import json
import re
from dataclasses import asdict, dataclass
from uuid import UUID, uuid4

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .notification_provider_protocols import ProviderRejected, probe, recipient, secret
from .notification_provider_wire import Wire
from .notification_security import NotificationSecurity
from .notification_smtp import Smtp
from .security import lock_mutation_identity


@dataclass(frozen=True)
class ProviderTarget:
    id: str
    channel: str
    origins: dict
    approved_access: bool = False
    fixture: bool = False
    smtp: dict | None = None
    label: str | None = None
    public_discovery: dict | None = None

    def __post_init__(self):
        if self.label is not None and (not isinstance(self.label,str) or not self.label.strip()
            or len(self.label.encode('utf-16-le'))//2>80 or re.search(r'[\x00-\x1f\x7f]',self.label)):
            raise ValueError('notification_public_label_invalid')
        if self.public_discovery is not None and (self.channel!='webpush' or not isinstance(self.public_discovery,dict) or set(self.public_discovery)!={'enabled','configured'} or any(type(value)is not bool for value in self.public_discovery.values()) or self.public_discovery['configured'] and not self.public_discovery['enabled']):
            raise ValueError('notification_public_discovery_invalid')

    @property
    def fingerprint(self):
        values=asdict(self)
        if self.public_discovery is None:values.pop('public_discovery')
        if self.label is None:values.pop('label')  # preserve installed pre-label fingerprints
        return hashlib.sha256(
            json.dumps(values, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()


def credentials(channel, raw):
    fields = {
        "telegram": {"botToken", "botUsername"},
        "wechat": {"corpId", "agentId", "appSecret"},
        "feishu": {"appId", "appSecret"},
        "discord": {"botToken"},
        "qq": {"appId", "appSecret"},
        "email": {"username", "password", "fromEmail"},
    }
    if not isinstance(raw, dict) or channel not in fields or raw.keys() != fields[channel]:
        raise HTTPException(400, "通知提供商配置字段无效")
    for key, value in raw.items():
        if key == "agentId":
            if type(value) is not int or not 1 <= value <= 2147483647:
                raise HTTPException(400, "企业微信应用编号无效")
        elif channel == "email" and key in {"username", "password"}:
            if not isinstance(value, str) or len(value) > 4096 or "\r" in value or "\n" in value:
                raise HTTPException(400, "邮件认证字段无效")
        else:
            try:
                secret(value)
            except ValueError as exc:
                raise HTTPException(400, "通知配置字段无效") from exc
    if channel == "telegram" and (
        not re.fullmatch(r"\d{5,20}:[A-Za-z0-9_-]{20,128}", raw["botToken"])
        or not re.fullmatch(r"[A-Za-z0-9_]{5,32}", raw["botUsername"])
    ):
        raise HTTPException(400, "Telegram机器人配置无效")
    if channel=='qq' and not re.fullmatch(r'\d{4,20}',raw['appId']):
        raise HTTPException(400,'QQ应用编号无效')
    if channel == "email" and not recipient("email", raw["fromEmail"]):
        raise HTTPException(400, "邮件发件地址无效")
    return dict(raw)


class Providers:
    def __init__(self, db, targets=(), target_provider=None, wire_factory=None, smtp_factory=None):
        self.db, self.security = db, NotificationSecurity(db)
        self.targets = {target.id: target for target in targets}
        self.target_provider = target_provider
        self.wire_factory, self.smtp_factory = wire_factory, smtp_factory
        if (wire_factory or smtp_factory) and db.settings.environment != "test":
            raise ValueError("fixture_transport_outside_test")
        if len(self.targets) != len(targets):
            raise ValueError("duplicate_provider_target")

    def target(self, target_id, channel, fingerprint=None):
        current = (
            {target.id: target for target in self.target_provider()} if self.target_provider else self.targets
        )
        target = current.get(target_id)
        if (
            target is None
            or target.channel != channel
            or not target.approved_access
            or fingerprint is not None
            and target.fingerprint != fingerprint
            or target.fixture
            and self.db.settings.environment != "test"
        ):
            raise HTTPException(503, "此通知目标尚未获当前实例授权")
        if target.channel=='webpush':
            if target.public_discovery is None:raise HTTPException(503,'公开发现配置尚未核对')
            return target
        if not target.fixture:
            if target.channel == "email":
                if not target.smtp or target.smtp.get("mode") not in {"tls", "starttls"}:
                    raise HTTPException(503, "邮件目标必须明确配置TLS")
            elif not target.origins or any(
                origin.scheme != "https" or origin.allow_plaintext for origin in target.origins.values()
            ):
                raise HTTPException(503, "通知提供商目标必须使用HTTPS")
        return target

    def discovery(self, channel):
        installed=self.target_provider() if self.target_provider else self.targets.values()
        choices=[]
        for candidate in installed:
            if candidate.channel!=channel:continue
            try:target=self.target(candidate.id,channel,candidate.fingerprint)
            except HTTPException:continue
            if target.public_discovery is not None:choices.append(target)
        if len(choices)!=1:
            return {'enabled':None,'configured':None,'configurationKnown':False,'verificationState':'ambiguous' if choices else 'unknown'}
        target=choices[0]
        return {**target.public_discovery,'configurationKnown':True,'verificationState':'public_discovery_only',**({'name':target.label} if target.label else {})}

    async def configure(self, who, raw, proof):
        if not isinstance(raw, dict) or raw.keys() != {
            "requestId",
            "channel",
            "targetId",
            "expectedRevision",
            "credentials",
        }:
            raise HTTPException(400, "通知配置参数无效")
        try:
            request_id = UUID(raw["requestId"])
            expected = UUID(raw["expectedRevision"]) if raw["expectedRevision"] is not None else None
        except (ValueError, TypeError, AttributeError) as exc:
            raise HTTPException(400, "通知配置版本无效") from exc
        target = self.target(raw["targetId"], raw["channel"])
        values = credentials(target.channel, raw["credentials"])
        async with self.db.connection() as conn, conn.transaction():
            await lock_mutation_identity(conn, who, require_admin=False)
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("notification-provider:" + who.id,)
            )
            prior = await (
                await conn.execute(
                    "SELECT * FROM business_notification_provider_revisions WHERE owner_id=%s AND request_id=%s",
                    (who.id, request_id),
                )
            ).fetchone()
            if prior:
                if prior["operation_mac"] != self.security.mac(raw):
                    raise HTTPException(409, "请求编号已用于不同通知配置")
                return {"revision": str(prior["revision"]), "configured": True}
            previous = await self.latest(conn, who.id, target.channel)
            if (previous["revision"] if previous else None) != expected:
                raise HTTPException(409, "通知提供商版本已变化，请重新核对")
            await self.security.consume(conn, who, raw, proof)
            revision = uuid4()
            cipher = self.security.encrypt(
                json.dumps(values, ensure_ascii=False), "provider:" + str(revision)
            )
            config_stamp = self.security.mac([who.id, str(revision), target.fingerprint, values])
            await conn.execute(
                """INSERT INTO business_notification_provider_revisions(owner_id,revision,request_id,channel,target_id,
                target_fingerprint,previous_revision,config_stamp,credential_instance,ciphertext,operation_mac)
                VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (
                    who.id,
                    revision,
                    request_id,
                    target.channel,
                    target.id,
                    target.fingerprint,
                    expected,
                    config_stamp,
                    self.db.settings.instance_id,
                    cipher,
                    self.security.mac(raw),
                ),
            )
            await conn.execute(
                "UPDATE business_notification_bindings SET revoked_at=clock_timestamp() WHERE owner_id=%s AND channel=%s",
                (who.id, target.channel),
            )
            await conn.execute(
                "UPDATE business_notification_challenges SET state='cancelled',code_cipher=NULL WHERE owner_id=%s AND channel=%s AND state NOT IN ('confirmed','cancelled')",
                (who.id, target.channel),
            )
            await conn.execute(
                """UPDATE business_notification_deliveries SET state='cancelled',updated_at=clock_timestamp()
                WHERE owner_id=%s AND channel=%s AND state='queued'""",
                (who.id, target.channel),
            )
            await conn.execute(
                "INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'notification.provider.configured',%s,%s)",
                (who.id, str(revision), request_id),
            )
            return {
                "revision": str(revision),
                "configured": True,
                "connectionState": "untested",
                "policy": "pending_recipient_verification",
            }

    async def latest(self, conn, owner, channel):
        return await (
            await conn.execute(
                "SELECT * FROM business_notification_provider_revisions WHERE owner_id=%s AND channel=%s ORDER BY created_at DESC,revision DESC LIMIT 1",
                (owner, channel),
            )
        ).fetchone()

    async def current(self, conn, owner, channel):
        row = await self.latest(conn, owner, channel)
        if (
            row
            and await (
                await conn.execute(
                    "SELECT 1 FROM business_notification_provider_revocations WHERE owner_id=%s AND provider_revision=%s",
                    (owner, row["revision"]),
                )
            ).fetchone()
        ):
            return None
        return row

    def materialize(self, row):
        target = self.target(row["target_id"], row["channel"], row["target_fingerprint"])
        if str(row["credential_instance"]) != str(self.db.settings.instance_id):
            raise HTTPException(503, "恢复副本的通知配置需要重新确认")
        values = json.loads(self.security.decrypt(row["ciphertext"], "provider:" + str(row["revision"])))
        return target, credentials(row["channel"], values)

    def wire(self, target):
        return self.wire_factory(target) if self.wire_factory else Wire(target.origins)

    def smtp(self, target):
        return (
            self.smtp_factory(target)
            if self.smtp_factory
            else Smtp(target.smtp, fixture=target.fixture, environment=self.db.settings.environment)
        )

    async def last_check(self, conn, row):
        return await (
            await conn.execute(
                "SELECT * FROM business_notification_provider_checks WHERE owner_id=%s AND provider_revision=%s ORDER BY checked_at DESC LIMIT 1",
                (row["owner_id"], row["revision"]),
            )
        ).fetchone()

    async def checked(self, conn, row):
        last = await self.last_check(conn, row)
        return last if last and last["status"] == "verified" else None

    async def test(self, who, revision, request_id):
        try:
            revision, request_id = UUID(revision), UUID(request_id)
        except (ValueError, TypeError, AttributeError) as exc:
            raise HTTPException(400, "通知测试编号无效") from exc
        async with self.db.connection() as conn, conn.transaction():
            await lock_mutation_identity(conn, who, require_admin=False)
            previous = await (
                await conn.execute(
                    "SELECT * FROM business_notification_provider_checks WHERE owner_id=%s AND request_id=%s",
                    (who.id, request_id),
                )
            ).fetchone()
            if previous:
                if previous["provider_revision"] != revision:
                    raise HTTPException(409, "测试编号已用于其他配置")
                return {
                    "requestId": str(request_id),
                    "revision": str(revision),
                    "status": previous["status"],
                    "identity": previous["identity"],
                }
            admitted = await (
                await conn.execute(
                    "SELECT * FROM business_notification_provider_probe_admissions WHERE owner_id=%s AND request_id=%s",
                    (who.id, request_id),
                )
            ).fetchone()
            if admitted:
                if admitted["provider_revision"] != revision:
                    raise HTTPException(409, "测试编号已用于其他配置")
                return {
                    "requestId": str(request_id),
                    "revision": str(revision),
                    "status": "unknown",
                    "identity": {},
                    "willRetryAutomatically": False,
                }
            row = await (
                await conn.execute(
                    "SELECT * FROM business_notification_provider_revisions WHERE owner_id=%s AND revision=%s",
                    (who.id, revision),
                )
            ).fetchone()
            if not row:
                raise HTTPException(404, "本人通知配置不存在")
            current = await self.current(conn, who.id, row["channel"])
            if current is None or current["revision"] != revision:
                raise HTTPException(409, "通知配置已变化，请测试当前版本")
            from .fx_reference import external_delivery_blocked

            if await external_delivery_blocked(conn):
                raise HTTPException(503, "恢复副本的通知网络访问已隔离")
            target, values = self.materialize(row)
            admitted = await (
                await conn.execute(
                    """INSERT INTO business_notification_provider_probe_admissions(owner_id,request_id,provider_revision,origin_instance)
                VALUES(%s,%s,%s,%s) ON CONFLICT DO NOTHING RETURNING request_id""",
                    (who.id, request_id, revision, self.db.settings.instance_id),
                )
            ).fetchone()
            if not admitted:
                return {
                    "requestId": str(request_id),
                    "revision": str(revision),
                    "status": "unknown",
                    "identity": {},
                    "willRetryAutomatically": False,
                }
        try:
            identity = (
                await self.smtp(target).perform(values)
                if row["channel"] == "email"
                else await probe(row["channel"], values, self.wire(target))
            )
            status = "verified"
        except ProviderRejected:
            identity, status = {}, "failed"
        except Exception:  # noqa: BLE001 -- No vendor body, URL, credential or transport text enters receipts.
            identity, status = {}, "unknown"
        async with self.db.connection() as conn, conn.transaction():
            await lock_mutation_identity(conn, who, require_admin=False)
            current = await self.current(conn, who.id, row["channel"])
            self.target(row["target_id"], row["channel"], row["target_fingerprint"])
            if current is None or current["revision"] != revision:
                raise HTTPException(409, "测试期间通知配置已变化")
            await conn.execute(
                "INSERT INTO business_notification_provider_checks(owner_id,request_id,provider_revision,status,identity) VALUES(%s,%s,%s,%s,%s) ON CONFLICT(owner_id,request_id) DO NOTHING",
                (who.id, request_id, revision, status, Jsonb(identity)),
            )
            saved = await (
                await conn.execute(
                    "SELECT * FROM business_notification_provider_checks WHERE owner_id=%s AND request_id=%s",
                    (who.id, request_id),
                )
            ).fetchone()
            if saved["provider_revision"] != revision:
                raise HTTPException(409, "测试编号已用于其他配置")
            return {
                "requestId": str(request_id),
                "revision": str(revision),
                "status": saved["status"],
                "identity": saved["identity"],
            }

    async def revoke(self, who, revision, request_id, proof):
        operation = {"action": "provider_revoke", "revision": revision, "requestId": request_id}
        try:
            identifier, request = UUID(revision), UUID(request_id)
        except (TypeError, ValueError, AttributeError) as exc:
            raise HTTPException(400, "通知配置撤销编号无效") from exc
        async with self.db.connection() as conn, conn.transaction():
            await lock_mutation_identity(conn, who, require_admin=False)
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("price-alert-owner:" + who.id,)
            )
            existing = await (
                await conn.execute(
                    "SELECT * FROM business_notification_provider_revocations WHERE owner_id=%s AND request_id=%s",
                    (who.id, request),
                )
            ).fetchone()
            if existing:
                if existing["provider_revision"] != identifier:
                    raise HTTPException(409, "原编号已用于其他撤销")
                return {"requestId": request_id, "revision": revision, "revoked": True}
            row = await (
                await conn.execute(
                    "SELECT * FROM business_notification_provider_revisions WHERE owner_id=%s AND revision=%s",
                    (who.id, identifier),
                )
            ).fetchone()
            if row is None:
                raise HTTPException(404, "本人通知配置不存在")
            latest = await self.latest(conn, who.id, row["channel"])
            if latest["revision"] != identifier:
                raise HTTPException(409, "只能撤销当前通知配置")
            await self.security.consume(conn, who, operation, proof)
            await conn.execute(
                "INSERT INTO business_notification_provider_revocations(owner_id,provider_revision,request_id,operation_mac) VALUES(%s,%s,%s,%s)",
                (who.id, identifier, request, self.security.mac(operation)),
            )
            await conn.execute(
                "UPDATE business_notification_bindings SET revoked_at=clock_timestamp(),recipient_cipher='' WHERE owner_id=%s AND channel=%s",
                (who.id, row["channel"]),
            )
            await conn.execute(
                "UPDATE business_notification_challenges SET state='cancelled',code_cipher=NULL,code_mac=NULL,token_mac=NULL,recipient_cipher='' WHERE owner_id=%s AND channel=%s",
                (who.id, row["channel"]),
            )
            await conn.execute(
                "UPDATE business_notification_deliveries SET state='cancelled',updated_at=clock_timestamp() WHERE owner_id=%s AND channel=%s AND state='queued'",
                (who.id, row["channel"]),
            )
            await conn.execute(
                "INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'notification.provider.revoked',%s,%s)",
                (who.id, revision, request),
            )
            return {"requestId": request_id, "revision": revision, "revoked": True}
