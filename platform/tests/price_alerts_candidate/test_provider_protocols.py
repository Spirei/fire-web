"""Actual request builders and controlled receipts, no real provider transports."""

import pytest
from alcor_api.notification_provider_protocols import (
    ProviderRejected,
    recipient,
    send,
)


class Wire:
    def __init__(self, replies):
        self.replies, self.calls = list(replies), []

    async def call(self, label, method, path, **kwargs):
        self.calls.append((label, method, path, kwargs))
        value = self.replies.pop(0)
        if isinstance(value, Exception):
            raise value
        return value


async def allowed():
    return True


@pytest.mark.parametrize(
    "channel,config,destination,replies,protocol",
    [
        (
            "telegram",
            {"botToken": "123456:" + "x" * 30},
            "123456",
            [{"ok": True, "result": {"message_id": 12}}],
            "telegram-bot-api",
        ),
        (
            "wechat",
            {"corpId": "synthetic-corp", "appSecret": "synthetic-secret", "agentId": 1},
            "SyntheticMember",
            [{"access_token": "synthetic-access", "errcode": 0}, {"errcode": 0, "msgid": "fixture-id"}],
            "wecom-application-message",
        ),
        (
            "feishu",
            {"appId": "synthetic-app", "appSecret": "synthetic-secret"},
            "ou_" + "a" * 20,
            [
                {"code": 0, "tenant_access_token": "synthetic-access"},
                {"code": 0, "data": {"message_id": "fixture-id"}},
            ],
            "feishu-im-v1",
        ),
        (
            "discord",
            {"botToken": "synthetic-bot-token"},
            "123456789012345678",
            [{"id": "223456789012345678"}, {"id": "323456789012345678"}],
            "discord-api-v10",
        ),
    ],
)
async def test_real_protocol_construction_and_acceptance(channel, config, destination, replies, protocol):
    wire = Wire(replies)
    outcome = await send(channel, config, destination, "Controlled source notification", allowed, wire)
    assert outcome.protocol == protocol and wire.calls
    if channel == "telegram":
        assert wire.calls[0][3]["json_body"]["allow_paid_broadcast"] is False
    if channel == "discord":
        assert wire.calls[-1][3]["json_body"]["allowed_mentions"] == {"parse": []}


async def test_revoke_between_provider_auth_and_actual_message_does_not_send():
    wire = Wire([{"code": 0, "tenant_access_token": "synthetic-access"}])
    count = 0

    async def permit():
        nonlocal count
        count += 1
        return count == 1

    with pytest.raises(ProviderRejected):
        await send(
            "feishu",
            {"appId": "synthetic", "appSecret": "synthetic"},
            "ou_" + "a" * 20,
            "fixture",
            permit,
            wire,
        )
    assert len(wire.calls) == 1


async def test_qq_real_token_then_message_receipt_and_unknown_is_not_acceptance():
    wire=Wire([{'access_token':'synthetic-access','expires_in':'3600'},{'id':'synthetic-qq-receipt'}])
    result=await send('qq',{'appId':'12345678','appSecret':'synthetic-secret'},'a'*20,'Synthetic',allowed,wire)
    assert result.id=='synthetic-qq-receipt' and result.protocol=='qq-bot-api-v2'
    assert [(c[0],c[1],c[2])for c in wire.calls]==[('auth','POST','/app/getAppAccessToken'),('api','POST','/v2/users/'+('a'*20)+'/messages')]
    lost=Wire([{'access_token':'synthetic-access','expires_in':3600},{}])
    with pytest.raises(ValueError,match='acceptance_unconfirmed'):
        await send('qq',{'appId':'12345678','appSecret':'synthetic-secret'},'a'*20,'Synthetic',allowed,lost)
    assert len(lost.calls)==2


@pytest.mark.parametrize(
    "channel,value",
    [
        ("wechat", "@all"),
        ("discord", "@everyone"),
        ("feishu", "arbitrary"),
        ("telegram", "-12345"),
        ("qq", "a/b"),
        ("email", "x\r\nBcc:a@example.test"),
    ],
)
def test_single_private_recipient_constraints(channel, value):
    assert not recipient(channel, value)


async def test_missing_acceptance_stays_unknown_not_success():
    wire = Wire([{"ok": True, "result": {}}])
    with pytest.raises(ValueError, match="unconfirmed"):
        await send("telegram", {"botToken": "123456:" + "x" * 30}, "12345", "fixture", allowed, wire)
