"""Current-password/factor proofs, encrypted owner configurations and controlled deliveries."""

import json
import re
from uuid import uuid4

import pytest
from alcor_api.business_notification_worker import dispatch_one
from alcor_api.notification_bindings import Bindings
from alcor_api.notification_provider_protocols import ProviderReceipt
from alcor_api.notification_providers import Providers, ProviderTarget
from alcor_api.notification_sender import Sender

from .test_price_alerts import alert_settings, alerts, mutate

__all__ = ["alert_settings", "alerts"]

VALUES = {
    "wechat": {"corpId": "synthetic-corp", "agentId": 1, "appSecret": "synthetic-secret"},
    "feishu": {"appId": "synthetic-app", "appSecret": "synthetic-secret"},
    "discord": {"botToken": "synthetic-discord-token"},
    "telegram": {"botToken": "123456:" + "x" * 30, "botUsername": "FixtureAlertsBot"},
    "qq": {"appId": "12345678", "appSecret": "synthetic-secret"},
    "email": {
        "username": "synthetic-user",
        "password": "synthetic-secret",
        "fromEmail": "sender@example.test",
    },
}
DESTINATIONS = {"qq":"a"*20,"wechat": "SyntheticMember", "feishu": "ou_" + "a" * 20, "discord": "123456789012345678"}


class ControlledWire:
    def __init__(self):
        self.calls, self.messages, self.fail_message = [], [], False
        self.updates = []

    async def call(self, label, method, path, **kwargs):
        self.calls.append((label, method, path, kwargs))
        if path.endswith("/getMe"):
            return {"ok": True, "result": {"id": 123456, "is_bot": True, "username": "FixtureAlertsBot"}}
        if path.endswith("/getUpdates"):
            offset = kwargs["json_body"]["offset"]
            return {"ok": True, "result": [row for row in self.updates if row["update_id"] >= offset]}
        if path.endswith("/gettoken"):
            return {"errcode": 0, "access_token": "synthetic-access", "expires_in": 7200}
        if path.endswith("/tenant_access_token/internal"):
            return {"code": 0, "tenant_access_token": "synthetic-access", "expire": 7200}
        if path == "/api/v10/users/@me":
            return {"id": "123456789012345678", "bot": True}
        if path == "/api/v10/users/@me/channels":
            return {"id": "223456789012345678"}
        if path == "/app/getAppAccessToken":
            return {"access_token": "synthetic-access", "expires_in": "7200"}
        payload = kwargs["json_body"]
        text = payload.get("text")
        if isinstance(text, dict):
            text = text["content"]
        if text is None:
            text = payload.get("content")
            if isinstance(text, str) and text.startswith('{"text"'):
                text = json.loads(text)["text"]
        self.messages.append(text)
        if self.fail_message:
            raise TimeoutError("synthetic unknown provider acceptance")
        if path == "/cgi-bin/message/send":
            return {"errcode": 0, "msgid": "synthetic-wecom-receipt"}
        if path == "/open-apis/im/v1/messages":
            return {"code": 0, "data": {"message_id": "synthetic-feishu-receipt"}}
        if path.endswith("/sendMessage"):
            return {"ok": True, "result": {"message_id": 12}}
        return {"id": "323456789012345678"}


class ControlledSmtp:
    def __init__(self):
        self.messages = []

    async def perform(self, config, destination=None, content=None, authorize=None, request_id=None):
        if destination is None:
            return {"authenticated": True, "mode": "synthetic-auth-only"}
        assert await authorize()
        self.messages.append((destination, content, request_id))
        return ProviderReceipt(request_id, "smtp")


def install(service):
    wire, smtp = ControlledWire(), ControlledSmtp()
    targets = tuple(
        ProviderTarget("fixture-" + channel, channel, {}, approved_access=True, fixture=True)
        for channel in VALUES
    )
    providers = Providers(
        service.db, targets, wire_factory=lambda target: wire, smtp_factory=lambda target: smtp
    )
    service.providers, service.bindings = providers, Bindings(service, providers)
    return wire, smtp


async def proof(client, operation, password="Synthetic9Pass", code=""):
    result = await client.post(
        "/api/notifications/security/verify",
        json={"operation": operation, "currentPassword": password, "code": code},
    )
    assert result.status_code == 200, result.text
    return result.json()["proofId"]


async def configure(client, channel, expected=None, request_id=None):
    operation = {
        "requestId": request_id or str(uuid4()),
        "channel": channel,
        "targetId": "fixture-" + channel,
        "expectedRevision": expected,
        "credentials": VALUES[channel],
    }
    ticket = await proof(client, operation)
    response = await client.post(
        "/api/notifications/providers", json=operation, headers={"x-alcor-notification-proof": ticket}
    )
    assert response.status_code == 200, response.text
    revision = response.json()["revision"]
    checked = await client.post(
        "/api/notifications/providers/" + revision + "/test", json={"requestId": str(uuid4())}
    )
    assert checked.status_code == 200 and checked.json()["status"] == "verified", checked.text
    return revision


async def binding_mutation(client, operation):
    ticket = await proof(client, operation)
    return await mutate(
        client,
        operation,
        headers={"x-alcor-notification-proof": ticket, "x-alcor-price-alerts": "messengers-v1"},
    )


@pytest.mark.parametrize("channel", ["wechat", "feishu", "discord"])
async def test_configured_recipient_binding_real_protocol_acceptance_and_revocation(alerts, channel):
    client, app, service, _ = alerts
    wire, _ = install(service)
    await configure(client, channel)
    response, _ = await binding_mutation(
        client, {"action": channel + "_start", "recipient": DESTINATIONS[channel], "revision": 0}
    )
    assert response.status_code == 200, response.text
    state = next(row for row in response.json()["snapshot"]["channels"] if row["channel"] == channel)
    assert state["configured"] and state["pendingConfirmation"] and not state["ready"]
    assert await dispatch_one(app.state.db, uuid4(), Sender(service.bindings)) == "accepted"
    code = re.search(r"验证码：(\d{6})", wire.messages[-1])[1]
    response, _ = await binding_mutation(
        client,
        {
            "action": channel + "_confirm",
            "challengeId": state["challengeId"],
            "verificationCode": code,
            "revision": 1,
            "enabled": True,
        },
    )
    assert response.status_code == 200, response.text
    current = next(row for row in response.json()["snapshot"]["channels"] if row["channel"] == channel)
    assert current["ready"] and current["enabled"] and not current["pendingConfirmation"]
    response, _ = await binding_mutation(client, {"action": "test", "channel": channel})
    assert response.status_code == 200, response.text
    assert await dispatch_one(app.state.db, uuid4(), Sender(service.bindings)) == "accepted"
    response, _ = await binding_mutation(client, {"action": channel + "_disconnect", "revision": 2})
    assert response.status_code == 200, response.text
    state = next(row for row in response.json()["snapshot"]["channels"] if row["channel"] == channel)
    assert not state["ready"] and not state["enabled"]
    async with app.state.db.connection() as conn:
        config = await (
            await conn.execute(
                "SELECT ciphertext FROM business_notification_provider_revisions WHERE channel=%s", (channel,)
            )
        ).fetchone()
        assert "synthetic" not in config["ciphertext"]
        challenge = await (
            await conn.execute(
                "SELECT code_cipher,recipient_cipher FROM business_notification_challenges WHERE channel=%s",
                (channel,),
            )
        ).fetchone()
        assert challenge["code_cipher"] is None and challenge["recipient_cipher"] == ""


async def test_wrong_binding_code_attempt_is_committed_and_original_uuid_receipt_is_queryable(alerts):
    client, app, service, _ = alerts
    wire, _ = install(service)
    await configure(client, "wechat")
    response, _ = await binding_mutation(
        client, {"action": "wechat_start", "recipient": "SyntheticMember", "revision": 0}
    )
    challenge = next(row for row in response.json()["snapshot"]["channels"] if row["channel"] == "wechat")[
        "challengeId"
    ]
    assert await dispatch_one(app.state.db, uuid4(), Sender(service.bindings)) == "accepted"
    true_code = re.search(r"验证码：(\d{6})", wire.messages[-1])[1]
    wrong = "100000" if true_code != "100000" else "100001"
    for attempt in range(6):
        response, uid = await binding_mutation(
            client,
            {"action": "wechat_confirm", "revision": 1, "challengeId": challenge, "verificationCode": wrong},
        )
        assert response.status_code == 400, response.text
        saved = await client.get("/api/price-alerts/operations/" + uid)
        assert saved.status_code == 200 and saved.json()["state"] == "failed"
    async with app.state.db.connection() as conn:
        row = await (
            await conn.execute(
                "SELECT attempts,state,code_mac,code_cipher FROM business_notification_challenges"
            )
        ).fetchone()
        assert row == {"attempts": 6, "state": "locked", "code_mac": None, "code_cipher": None}


async def test_unknown_send_is_not_retried_but_received_code_can_confirm(alerts):
    client, app, service, _ = alerts
    wire, _ = install(service)
    await configure(client, "wechat")
    response, _ = await binding_mutation(
        client, {"action": "wechat_start", "recipient": "SyntheticMember", "revision": 0}
    )
    challenge = next(row for row in response.json()["snapshot"]["channels"] if row["channel"] == "wechat")[
        "challengeId"
    ]
    wire.fail_message = True
    assert await dispatch_one(app.state.db, uuid4(), Sender(service.bindings)) == "unknown"
    assert await dispatch_one(app.state.db, uuid4(), Sender(service.bindings)) == "idle"
    assert len(wire.messages) == 1
    code = re.search(r"验证码：(\d{6})", wire.messages[-1])[1]
    response, _ = await binding_mutation(
        client,
        {"action": "wechat_confirm", "revision": 1, "challengeId": challenge, "verificationCode": code},
    )
    assert response.status_code == 200, response.text


async def test_current_password_purpose_and_provider_target_are_not_client_assertions(alerts):
    client, app, service, _ = alerts
    install(service)
    raw = {
        "requestId": str(uuid4()),
        "channel": "discord",
        "targetId": "fixture-discord",
        "expectedRevision": None,
        "credentials": VALUES["discord"],
    }
    missing = await client.post("/api/notifications/providers", json=raw)
    assert missing.status_code == 428
    denied = await client.post(
        "/api/notifications/security/verify", json={"operation": raw, "currentPassword": "wrong", "code": ""}
    )
    assert denied.status_code == 403
    ticket = await proof(client, raw)
    changed = await client.post(
        "/api/notifications/providers",
        json={**raw, "credentials": {"botToken": "different-synthetic-token"}},
        headers={"x-alcor-notification-proof": ticket},
    )
    assert changed.status_code == 409
    accepted = await client.post(
        "/api/notifications/providers", json=raw, headers={"x-alcor-notification-proof": ticket}
    )
    assert accepted.status_code == 200
    rejected = await client.post(
        "/api/notifications/providers",
        json={**raw, "requestId": str(uuid4()), "targetId": "owner-added-arbitrary-host"},
        headers={"x-alcor-notification-proof": ticket},
    )
    assert rejected.status_code == 503
    async with app.state.db.connection() as conn:
        assert (
            await (
                await conn.execute("SELECT count(*) AS n FROM business_notification_provider_revisions")
            ).fetchone()
        )["n"] == 1


async def test_email_reuses_verified_current_owner_address_and_changes_cancel_delivery(alerts):
    client, app, service, _ = alerts
    _, smtp = install(service)
    await configure(client, "email")
    async with app.state.db.connection() as conn:
        user = await (await conn.execute("SELECT id FROM users")).fetchone()
        await conn.execute("UPDATE users SET email='owner@example.test' WHERE id=%s", (user["id"],))
        await conn.execute(
            "INSERT INTO identity_security(user_id,email_verified) VALUES(%s,true) ON CONFLICT(user_id) DO UPDATE SET email_verified=true",
            (user["id"],),
        )
    response, _ = await binding_mutation(
        client, {"action": "channel", "channel": "email", "enabled": True, "revision": 0}
    )
    assert response.status_code == 200, response.text
    response, _ = await binding_mutation(client, {"action": "test", "channel": "email"})
    assert response.status_code == 200
    async with app.state.db.connection() as conn:
        await conn.execute("UPDATE users SET email='changed@example.test'")
    assert await dispatch_one(app.state.db, uuid4(), Sender(service.bindings)) == "cancelled"
    assert smtp.messages == []


async def test_qq_credentials_require_explicit_recipient_confirmation_not_a_policy_stub(alerts):
    client,app,service,_=alerts
    wire,_=install(service)
    await configure(client,'qq')
    response,_=await binding_mutation(client,{'action':'qq_start','recipient':'a'*20,'revision':0})
    assert response.status_code==200,response.text
    assert await dispatch_one(app.state.db,uuid4(),Sender(service.bindings))=='accepted'
    state=next(row for row in response.json()['snapshot']['channels']if row['channel']=='qq')
    code=re.search(r'验证码：(\d{6})',wire.messages[-1])[1]
    response,_=await binding_mutation(client,{'action':'qq_confirm','challengeId':state['challengeId'],'verificationCode':code,'revision':1,'enabled':True})
    assert response.status_code==200,response.text
    qq=next(row for row in response.json()['snapshot']['channels']if row['channel']=='qq')
    assert qq['configured'] and qq['ready'] and len(wire.messages)==1


async def test_telegram_private_incoming_nonce_explicit_confirmation_send_and_disconnect(alerts):
    from urllib.parse import parse_qs, urlsplit

    from alcor_api.notification_telegram import poll

    client, app, service, _ = alerts
    wire, _ = install(service)
    await configure(client, "telegram")
    ticket = await proof(client, {"action": "telegram_link"})
    response = await client.post(
        "/api/price-alerts/telegram-link", json={}, headers={"x-alcor-notification-proof": ticket}
    )
    assert response.status_code == 200, response.text
    link = urlsplit(response.json()["url"])
    nonce = parse_qs(link.query)["start"][0]
    assert link.hostname == "t.me" and link.path == "/FixtureAlertsBot" and len(nonce) == 43
    wire.updates = [
        {
            "update_id": 1,
            "message": {
                "text": "/start " + nonce,
                "chat": {"type": "group", "id": -123},
                "from": {"id": 456},
            },
        },
        {
            "update_id": 2,
            "message": {
                "text": "/start " + nonce,
                "chat": {"type": "private", "id": 456},
                "from": {"id": 456, "is_bot": False},
            },
        },
    ]
    result = await poll(service.providers, uuid4())
    assert result["received"] == 1
    snapshot = (await client.get("/api/price-alerts")).json()
    channel = next(row for row in snapshot["channels"] if row["channel"] == "telegram")
    assert channel["pendingConfirmation"] and not channel["ready"] and "456" in channel["destination"]
    response, _ = await binding_mutation(
        client, {"action": "telegram_confirm", "revision": 1, "enabled": True}
    )
    assert response.status_code == 200, response.text
    response, _ = await binding_mutation(client, {"action": "test", "channel": "telegram"})
    assert response.status_code == 200
    assert await dispatch_one(app.state.db, uuid4(), Sender(service.bindings)) == "accepted"
    response, _ = await binding_mutation(client, {"action": "telegram_disconnect", "revision": 2})
    assert response.status_code == 200
    async with app.state.db.connection() as conn:
        incoming = await (await conn.execute("SELECT * FROM business_notification_incoming")).fetchall()
        assert len(incoming) == 1 and incoming[0]["external_id"] == "2"
        state = await (
            await conn.execute("SELECT next_offset FROM business_notification_telegram_state")
        ).fetchone()
        assert state["next_offset"] == 3


async def test_smtp_current_owner_verification_actual_controlled_acceptance(alerts):
    client, app, service, _ = alerts
    _, smtp = install(service)
    await configure(client, "email")
    async with app.state.db.connection() as conn:
        user = await (await conn.execute("SELECT id FROM users")).fetchone()
        await conn.execute("UPDATE users SET email='owner@example.test' WHERE id=%s", (user["id"],))
        await conn.execute(
            "INSERT INTO identity_security(user_id,email_verified) VALUES(%s,true) ON CONFLICT(user_id) DO UPDATE SET email_verified=true",
            (user["id"],),
        )
    response, _ = await binding_mutation(
        client, {"action": "channel", "channel": "email", "enabled": True, "revision": 0}
    )
    assert response.status_code == 200
    response, _ = await binding_mutation(client, {"action": "test", "channel": "email"})
    assert response.status_code == 200
    assert await dispatch_one(app.state.db, uuid4(), Sender(service.bindings)) == "accepted"
    assert len(smtp.messages) == 1 and smtp.messages[0][0] == "owner@example.test"
