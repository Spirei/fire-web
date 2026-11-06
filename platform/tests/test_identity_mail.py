"""Durable delivery state tests use an injected transport, never SMTP/network."""

import asyncio
from uuid import uuid4

import pytest
from alcor_api.identity_mail import DeliveryRejected, IdentityMail
from psycopg.types.json import Jsonb


async def mailer(settings, db, transport):
    configured = settings.model_copy(
        update={
            "mail_enabled": True,
            "mail_host": "smtp.example.invalid",
            "mail_sender": "sender@example.invalid",
        }
    )
    return IdentityMail(configured, db, transport=transport)


async def queued(service, db):
    challenge = "synthetic-mail-" + uuid4().hex
    async with db.connection() as conn, conn.transaction():
        expiry = await (
            await conn.execute(
                "INSERT INTO identity_challenges(id,purpose,binding,payload,expires_at) VALUES(%s,'test-mail','test',%s,clock_timestamp()+interval '5 minutes') RETURNING expires_at",
                (challenge, Jsonb({})),
            )
        ).fetchone()
        identifier = await service.enqueue(
            conn,
            user_id=None,
            challenge_id=challenge,
            kind="email-registration",
            recipient="recipient@example.invalid",
            text="Synthetic secret code 123456",
            expires_at=expiry["expires_at"],
        )
    return identifier, challenge


async def test_mail_is_encrypted_and_single_claim_then_durable_receipt(db, settings):
    calls = []

    async def deliver(payload, identifier):
        calls.append((payload, identifier))
        await asyncio.sleep(0.02)

    service = await mailer(settings, db, deliver)
    identifier, _ = await queued(service, db)
    async with db.connection() as conn:
        row = await (
            await conn.execute("SELECT * FROM identity_mail_outbox WHERE id=%s", (identifier,))
        ).fetchone()
        assert "recipient@example.invalid" not in str(row) and "123456" not in str(row)
    await asyncio.gather(service.deliver_one(uuid4()), service.deliver_one(uuid4()))
    assert len(calls) == 1 and calls[0][0]["recipient"] == "recipient@example.invalid"
    rebuilt = await mailer(settings, db, deliver)
    assert await rebuilt.deliver_one(uuid4()) is None
    async with db.connection() as conn:
        row = await (
            await conn.execute(
                "SELECT status,ciphertext FROM identity_mail_outbox WHERE id=%s", (identifier,)
            )
        ).fetchone()
        assert row == {"status": "sent", "ciphertext": None}


@pytest.mark.parametrize("exception,expected", [(DeliveryRejected, "failed"), (TimeoutError, "unknown")])
async def test_rejected_or_unknown_mail_revokes_challenge_and_never_retries(
    db, settings, exception, expected
):
    calls = []

    async def deliver(payload, identifier):
        calls.append(identifier)
        raise exception()

    service = await mailer(settings, db, deliver)
    identifier, challenge = await queued(service, db)
    assert (await service.deliver_one(uuid4()))["status"] == expected
    assert await service.deliver_one(uuid4()) is None and len(calls) == 1
    async with db.connection() as conn:
        assert not await (
            await conn.execute("SELECT 1 FROM identity_challenges WHERE id=%s", (challenge,))
        ).fetchone()
        assert (
            await (
                await conn.execute("SELECT ciphertext FROM identity_mail_outbox WHERE id=%s", (identifier,))
            ).fetchone()
        )["ciphertext"] is None


async def test_interrupted_send_is_unknown_after_restart_not_resent(db, settings):
    called = asyncio.Event()

    async def interrupted(payload, identifier):
        called.set()
        await asyncio.Event().wait()

    service = await mailer(settings, db, interrupted)
    identifier, challenge = await queued(service, db)
    task = asyncio.create_task(service.deliver_one(uuid4()))
    await asyncio.wait_for(called.wait(), 2)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    async with db.connection() as conn:
        await conn.execute(
            "UPDATE identity_mail_outbox SET lease_until=clock_timestamp()-interval '1 second' WHERE id=%s",
            (identifier,),
        )
    calls = []

    async def unexpected(payload, identifier):
        calls.append(identifier)

    rebuilt = await mailer(settings, db, unexpected)
    assert await rebuilt.deliver_one(uuid4()) is None and calls == []
    async with db.connection() as conn:
        assert not await (
            await conn.execute("SELECT 1 FROM identity_challenges WHERE id=%s", (challenge,))
        ).fetchone()
        assert (
            await (
                await conn.execute("SELECT status FROM identity_mail_outbox WHERE id=%s", (identifier,))
            ).fetchone()
        )["status"] == "unknown"


async def test_disabled_or_revoked_challenge_never_sends(db, settings):
    calls = []

    async def deliver(payload, identifier):
        calls.append(identifier)

    service = await mailer(settings, db, deliver)
    identifier, challenge = await queued(service, db)
    disabled = IdentityMail(settings, db, transport=deliver)
    assert not disabled.configured
    assert await disabled.deliver_one(uuid4()) is None
    async with db.connection() as conn:
        await conn.execute("DELETE FROM identity_challenges WHERE id=%s", (challenge,))
    assert await service.deliver_one(uuid4()) is None and calls == []
    async with db.connection() as conn:
        assert (
            await (
                await conn.execute("SELECT status FROM identity_mail_outbox WHERE id=%s", (identifier,))
            ).fetchone()
        )["status"] == "cancelled"


async def test_claim_skips_challenge_being_revoked_in_another_transaction(db, settings):
    calls = []

    async def deliver(payload, identifier):
        calls.append(identifier)

    service = await mailer(settings, db, deliver)
    identifier, challenge = await queued(service, db)
    async with db.connection() as held, held.transaction():
        await held.execute("DELETE FROM identity_challenges WHERE id=%s", (challenge,))
        assert await asyncio.wait_for(service.deliver_one(uuid4()), 2) is None
    assert await service.deliver_one(uuid4()) is None
    assert calls == []
    async with db.connection() as conn:
        assert (
            await (
                await conn.execute("SELECT status FROM identity_mail_outbox WHERE id=%s", (identifier,))
            ).fetchone()
        )["status"] == "cancelled"
