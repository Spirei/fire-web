"""The only business outbound adapter; reads current owner/provider proofs before every send."""

from fastapi import HTTPException

from .business_notification_worker import Acceptance, Rejected
from .notification_provider_protocols import ProviderRejected, send


def content(payload):
    if payload.get("kind") == "test":
        return "Alcor 通知测试\n这是一条由你主动发起的测试通知。"
    session = {"PRE": "盘前", "REGULAR": "盘中", "AFTER": "盘后", "OVERNIGHT": "夜盘"}.get(
        payload.get("session"), "时段未知"
    )
    return f"{payload['name']} ({payload['code']})\n{'涨至' if payload['direction'] == 'above' else '跌至'} {payload['target']} {payload['currency']}\n触达价格 {payload.get('priceExact', payload['price'])} · {session}\n行情时间 {payload['quoteTime']}"


class Sender:
    def __init__(self, bindings):
        self.bindings, self.providers, self.db = bindings, bindings.providers, bindings.db
        self.fixture = bool(self.providers.targets) and all(
            target.fixture for target in self.providers.targets.values()
        )
        self.approved_external_access = bool(self.providers.targets) and all(
            target.approved_access for target in self.providers.targets.values()
        )

    async def load(self, row):
        async with self.db.connection() as conn:
            provider = await self.bindings.provider(conn, row["owner_id"], row["channel"])
            target, values = self.providers.materialize(provider)
            if row["kind"] == "notification.binding":
                challenge = await (
                    await conn.execute(
                        "SELECT *,expires_at>clock_timestamp() AS valid FROM business_notification_challenges WHERE owner_id=%s AND id=%s",
                        (row["owner_id"], row["payload"]["challengeId"]),
                    )
                ).fetchone()
                if (
                    not challenge
                    or not challenge["valid"]
                    or challenge["provider_revision"] != provider["revision"]
                    or not challenge["code_cipher"]
                    or challenge["state"] not in {"queued", "sending"}
                ):
                    raise HTTPException(409, "通知验证请求已变化")
                destination = self.providers.security.decrypt(
                    challenge["recipient_cipher"], "challenge-recipient:" + str(challenge["id"])
                )
                code = self.providers.security.decrypt(
                    challenge["code_cipher"], "challenge-code:" + str(challenge["id"])
                )
                message = (
                    "Alcor 绑定验证码：" + code + "。5分钟内有效。仅在本人主动绑定时输入，请勿向他人提供。"
                )
            else:
                if not (await self.bindings.state(conn, row["owner_id"], row["channel"]))["ready"]:
                    raise HTTPException(409, "通知绑定已失效")
                binding = await (
                    await conn.execute(
                        "SELECT * FROM business_notification_bindings WHERE owner_id=%s AND channel=%s",
                        (row["owner_id"], row["channel"]),
                    )
                ).fetchone()
                if binding["config_stamp"] != provider["config_stamp"]:
                    raise HTTPException(409, "通知配置已变化")
                destination = self.providers.security.decrypt(
                    binding["recipient_cipher"], "recipient:" + row["owner_id"] + ":" + row["channel"]
                )
                message = content(row["payload"])
            return target, values, destination, message

    async def ready(self, row):
        try:
            await self.load(row)
            return True
        except (HTTPException, ValueError, TypeError, KeyError):
            return False

    async def send(self, row, authorize):
        try:
            target, values, destination, message = await self.load(row)
            if row["channel"] == "email":
                result = await self.providers.smtp(target).perform(
                    values, destination, message, authorize, str(row["id"])
                )
            else:
                result = await send(
                    row["channel"], values, destination, message, authorize, self.providers.wire(target)
                )
            return Acceptance(result.id, result.protocol)
        except (HTTPException, ProviderRejected) as exc:
            raise Rejected() from exc
