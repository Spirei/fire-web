"""Real messenger request/acceptance contracts, exercised only with controlled transports.

No provider URL or credential is read at import. All provider actions require
explicit current installation, owner binding and an accepted provider receipt.
"""

import json
import math
import re
from dataclasses import dataclass


class ProviderRejected(Exception):
    """Conclusive rejection; no automatic job replay is implied."""


@dataclass(frozen=True)
class ProviderReceipt:
    id: str
    protocol: str


def recipient(channel, value):
    if not isinstance(value, str) or value != value.strip():
        return False
    patterns = {
        "wechat": r"[A-Za-z0-9_@.\-]{1,64}",
        "feishu": r"(?:ou_[A-Za-z0-9]{16,64}|[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,80}\.[A-Za-z]{2,24})",
        "discord": r"\d{17,20}",
        "qq": r"[A-Za-z0-9]{16,64}",
        "telegram": r"[1-9]\d{0,18}",
        "email": r"[A-Za-z0-9._%+\-]{1,64}@[A-Za-z0-9.\-]{1,190}\.[A-Za-z]{2,24}",
    }
    return (
        channel in patterns and re.fullmatch(patterns[channel], value) is not None and value.lower() != "@all"
    )


def secret(value, maximum=256):
    if not isinstance(value, str) or not 1 <= len(value) <= maximum or re.search(r"[\s\x00-\x1f\x7f]", value):
        raise ValueError("provider_secret_invalid")
    return value


async def permit(authorize):
    if not await authorize():
        raise ProviderRejected("authorization_revoked")


def token(value, key):
    if not isinstance(value, dict) or not isinstance(value.get(key), str) or not value[key]:
        raise ProviderRejected("provider_authentication_unconfirmed")
    return secret(value[key], 4096)


def receipt(value, key):
    result = value.get(key) if isinstance(value, dict) else None
    if not isinstance(result, str) or not 1 <= len(result) <= 128:
        raise ValueError("provider_acceptance_unconfirmed")
    return result


async def send(channel, config, destination, content, authorize, wire):
    if not recipient(channel, destination) or not isinstance(content, str) or not 1 <= len(content) <= 4000:
        raise ProviderRejected("recipient_or_content_invalid")
    await permit(authorize)
    if channel == "qq":
        auth=await wire.call('auth','POST','/app/getAppAccessToken',
            json_body={'appId':secret(config['appId']),'clientSecret':secret(config['appSecret'])})
        access=token(auth,'access_token')
        try:expires=float(auth.get('expires_in'))
        except (TypeError,ValueError):raise ProviderRejected('provider_authentication_unconfirmed') from None
        if not math.isfinite(expires) or expires<=120:raise ProviderRejected('provider_authentication_unconfirmed')
        await permit(authorize)
        # JS String.slice counts UTF-16 units, including a boundary surrogate.
        text=content.encode('utf-16-le',errors='surrogatepass')[:3600].decode('utf-16-le',errors='surrogatepass')
        result=await wire.call('api','POST','/v2/users/'+destination+'/messages',
            headers={'Authorization':'QQBot '+access,'X-Union-Appid':config['appId']},
            json_body={'content':text,'msg_type':0})
        if type(result.get('code')) in (int,float) and result['code']!=0:raise ProviderRejected('provider_rejected')
        return ProviderReceipt(receipt(result,'id'),'qq-bot-api-v2')
    if channel == "telegram":
        bot = secret(config["botToken"])
        if not re.fullmatch(r"\d{5,20}:[A-Za-z0-9_-]{20,128}", bot):
            raise ValueError("telegram_token_invalid")
        result = await wire.call(
            "api",
            "POST",
            f"/bot{bot}/sendMessage",
            json_body={
                "chat_id": destination,
                "text": content,
                "protect_content": True,
                "allow_paid_broadcast": False,
            },
        )
        if result.get("ok") is False:
            raise ProviderRejected("provider_rejected")
        message = result.get("result")
        if (
            result.get("ok") is not True
            or not isinstance(message, dict)
            or type(message.get("message_id")) is not int
            or message["message_id"] <= 0
        ):
            raise ValueError("provider_acceptance_unconfirmed")
        return ProviderReceipt(str(message["message_id"]), "telegram-bot-api")
    if channel == "wechat":
        auth = await wire.call(
            "api",
            "GET",
            "/cgi-bin/gettoken",
            query={"corpid": secret(config["corpId"]), "corpsecret": secret(config["appSecret"])},
        )
        if auth.get("errcode", 0) != 0:
            raise ProviderRejected("provider_authentication_rejected")
        access = token(auth, "access_token")
        await permit(authorize)
        agent = config.get("agentId")
        if type(agent) is not int or not 1 <= agent <= 2147483647:
            raise ValueError("wechat_agent_invalid")
        result = await wire.call(
            "api",
            "POST",
            "/cgi-bin/message/send",
            query={"access_token": access},
            json_body={
                "touser": destination,
                "msgtype": "text",
                "agentid": agent,
                "text": {"content": content},
                "safe": 1,
                "enable_duplicate_check": 1,
                "duplicate_check_interval": 1800,
            },
        )
        if result.get("errcode") != 0 or any(
            result.get(key) for key in ("invaliduser", "invalidparty", "invalidtag")
        ):
            raise ProviderRejected("provider_rejected")
        return ProviderReceipt(receipt(result, "msgid"), "wecom-application-message")
    if channel == "feishu":
        auth = await wire.call(
            "api",
            "POST",
            "/open-apis/auth/v3/tenant_access_token/internal",
            json_body={"app_id": secret(config["appId"]), "app_secret": secret(config["appSecret"])},
        )
        if auth.get("code") != 0:
            raise ProviderRejected("provider_authentication_rejected")
        access = token(auth, "tenant_access_token")
        await permit(authorize)
        result = await wire.call(
            "api",
            "POST",
            "/open-apis/im/v1/messages",
            query={"receive_id_type": "open_id" if destination.startswith("ou_") else "email"},
            headers={"Authorization": "Bearer " + access},
            json_body={
                "receive_id": destination,
                "msg_type": "text",
                "content": json.dumps({"text": content}, ensure_ascii=False),
            },
        )
        if result.get("code") != 0:
            raise ProviderRejected("provider_rejected")
        return ProviderReceipt(receipt(result.get("data"), "message_id"), "feishu-im-v1")
    if channel == "discord":
        headers = {
            "Authorization": "Bot " + secret(config["botToken"]),
            "User-Agent": "Alcor-Notifications/1",
        }
        opened = await wire.call(
            "api",
            "POST",
            "/api/v10/users/@me/channels",
            headers=headers,
            json_body={"recipient_id": destination},
        )
        dm = opened.get("id")
        if not isinstance(dm, str) or not re.fullmatch(r"\d{17,22}", dm):
            raise ProviderRejected("private_channel_unconfirmed")
        await permit(authorize)
        result = await wire.call(
            "api",
            "POST",
            "/api/v10/channels/" + dm + "/messages",
            headers=headers,
            json_body={"content": content, "allowed_mentions": {"parse": []}},
        )
        message = receipt(result, "id")
        if not re.fullmatch(r"\d{17,22}", message):
            raise ValueError("provider_acceptance_unconfirmed")
        return ProviderReceipt(message, "discord-api-v10")
    raise ProviderRejected("provider_not_configured")


async def probe(channel, config, wire):
    """Credential-only probe. No messages, consent, paid calls or synthetic success."""
    if channel == "telegram":
        bot = secret(config["botToken"])
        if not re.fullmatch(r"\d{5,20}:[A-Za-z0-9_-]{20,128}", bot):
            raise ValueError("telegram_token_invalid")
        result = await wire.call("api", "GET", f"/bot{bot}/getMe")
        user = result.get("result")
        if (
            result.get("ok") is not True
            or not isinstance(user, dict)
            or type(user.get("id")) is not int
            or user["id"] <= 0
            or user.get("is_bot") is not True
            or user.get("username", "").lower() != config["botUsername"].lower()
        ):
            raise ProviderRejected("provider_identity_unconfirmed")
        return {"channel": channel, "identity": str(user.get("id")), "botUsername": user["username"]}
    if channel == "wechat":
        result = await wire.call(
            "api",
            "GET",
            "/cgi-bin/gettoken",
            query={"corpid": secret(config["corpId"]), "corpsecret": secret(config["appSecret"])},
        )
        if result.get("errcode", 0) != 0:
            raise ProviderRejected("provider_authentication_rejected")
        token(result, "access_token")
        return {"channel": channel, "identity": config["corpId"] + ":" + str(config["agentId"])}
    if channel == "feishu":
        result = await wire.call(
            "api",
            "POST",
            "/open-apis/auth/v3/tenant_access_token/internal",
            json_body={"app_id": secret(config["appId"]), "app_secret": secret(config["appSecret"])},
        )
        if result.get("code") != 0:
            raise ProviderRejected("provider_authentication_rejected")
        token(result, "tenant_access_token")
        return {"channel": channel, "identity": config["appId"]}
    if channel == "discord":
        result = await wire.call(
            "api", "GET", "/api/v10/users/@me", headers={"Authorization": "Bot " + secret(config["botToken"])}
        )
        identifier = receipt(result, "id")
        if not re.fullmatch(r"\d{17,22}", identifier) or result.get("bot") is not True:
            raise ProviderRejected("provider_identity_unconfirmed")
        return {"channel": channel, "identity": identifier}
    if channel == "qq":
        result = await wire.call(
            "auth",
            "POST",
            "/app/getAppAccessToken",
            json_body={"appId": secret(config["appId"]), "clientSecret": secret(config["appSecret"])},
        )
        token(result, "access_token")
        try:expires=float(result.get('expires_in'))
        except (TypeError,ValueError):raise ProviderRejected('provider_identity_unconfirmed') from None
        if not math.isfinite(expires) or expires<=120:raise ProviderRejected('provider_identity_unconfirmed')
        return {"channel": channel, "identity": config["appId"]}
    raise ProviderRejected("provider_not_configured")
