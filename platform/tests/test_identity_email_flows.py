"""Email flow contracts with fake transport and private PostgreSQL only."""

import re
from uuid import uuid4

import pytest
from alcor_api.native_app_auth import issue_grant

PASSWORD = "SyntheticMailPassword9"


def enable(app, settings):
    settings.mail_enabled = True
    settings.mail_host = "smtp.example.invalid"
    settings.mail_sender = "sender@example.invalid"
    captured = []

    async def transport(payload, identifier):
        captured.append(payload)

    app.state.identity_email.mail.transport = transport
    return captured


async def deliver(app):
    result = await app.state.identity_email.mail.deliver_one(uuid4())
    assert result["status"] == "sent"


async def request(client, email):
    response = await client.post("/api/auth/register/email/request", json={"email": email})
    assert response.status_code == 200, response.text
    return response.json()


def code(captured):
    return re.search(r"(?:验证码：|验证码\n\n)(\d{6})", captured[-1]["text"])[1]


async def test_first_email_registration_is_atomic_admin_then_user_and_private(client, app, settings, db):
    captured = enable(app, settings)
    stage = await request(client, "first@example.invalid")
    assert captured == []
    async with db.connection() as conn:
        assert not await (await conn.execute("SELECT 1 FROM users")).fetchone()
        rows = await (
            await conn.execute("SELECT payload FROM identity_challenges WHERE purpose='email-registration'")
        ).fetchall()
        assert "first@example.invalid" not in str(rows)
    await deliver(app)
    payload = {
        "email": "first@example.invalid",
        "challenge": stage["challenge"],
        "code": code(captured),
        "password": PASSWORD,
    }
    registered = await client.post("/api/auth/register/email/confirm", json=payload)
    assert registered.status_code == 201, registered.text
    assert registered.json()["user"]["role"] == "admin"
    assert registered.json()["user"]["emailVerified"] is True
    assert registered.json()["user"]["username"].startswith("user_")
    assert "first" not in registered.json()["user"]["username"]
    assert (await client.post("/api/auth/register/email/confirm", json=payload)).status_code == 400
    second = await request(client, "second@example.invalid")
    await deliver(app)
    registered = await client.post(
        "/api/auth/register/email/confirm",
        json={
            **payload,
            "email": "second@example.invalid",
            "challenge": second["challenge"],
            "code": code(captured),
        },
    )
    assert registered.status_code == 201 and registered.json()["user"]["role"] == "user"
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) AS n FROM users WHERE role='admin'")).fetchone())[
            "n"
        ] == 1


async def test_registration_invalid_attempts_are_durable_and_existing_email_neutral(
    client, app, settings, db
):
    captured = enable(app, settings)
    stage = await request(client, "attempt@example.invalid")
    await deliver(app)
    right = code(captured)
    wrong = "000000" if right != "000000" else "111111"
    payload = {
        "email": "attempt@example.invalid",
        "challenge": stage["challenge"],
        "code": wrong,
        "password": PASSWORD,
    }
    for _ in range(5):
        assert (await client.post("/api/auth/register/email/confirm", json=payload)).status_code == 400
    assert (
        await client.post("/api/auth/register/email/confirm", json={**payload, "code": right})
    ).status_code == 400
    async with db.connection() as conn:
        assert (
            await (
                await conn.execute(
                    "SELECT attempts FROM identity_challenges WHERE purpose='email-registration'"
                )
            ).fetchone()
        )["attempts"] == 5
        assert not await (await conn.execute("SELECT 1 FROM users")).fetchone()
    assert (
        await client.post("/api/auth/register/email/request", json={"email": "attempt@example.invalid"})
    ).status_code == 429


async def test_email_registration_failed_delivery_never_creates_account(client, app, settings, db):
    enable(app, settings)

    async def unknown(payload, identifier):
        raise TimeoutError()

    app.state.identity_email.mail.transport = unknown
    stage = await request(client, "failure@example.invalid")
    result = await app.state.identity_email.mail.deliver_one(uuid4())
    assert result["status"] == "unknown"
    async with db.connection() as conn:
        assert not await (await conn.execute("SELECT 1 FROM users")).fetchone()
        assert not await (
            await conn.execute("SELECT 1 FROM identity_challenges WHERE purpose='email-registration'")
        ).fetchone()
    assert (
        await client.post(
            "/api/auth/register/email/confirm",
            json={
                "email": "failure@example.invalid",
                "challenge": stage["challenge"],
                "code": "123456",
                "password": PASSWORD,
            },
        )
    ).status_code == 400


@pytest.mark.parametrize("native", [0, 1, 2])
async def test_verification_is_owner_email_bound_and_one_time(client, app, settings, db, native):
    captured = enable(app, settings)
    response = await client.post("/api/auth/register", json={"username": "MailOwner", "password": PASSWORD})
    uid = response.json()["user"]["id"]
    async with db.connection() as conn:
        await conn.execute("UPDATE users SET email='verify@example.invalid' WHERE id=%s", (uid,))
        user = await (await conn.execute("SELECT * FROM users WHERE id=%s", (uid,))).fetchone()
        pair = await issue_grant(conn, user, "portfolio.read security.read security.write", "Synthetic phone")
    headers = {"authorization": "Bearer " + pair["access_token"]} if native else {}
    base = f"/api/v{native}/auth/email-verification" if native else "/api/auth/email-verification"
    if native:
        status = await client.get(base, headers=headers)
        assert status.status_code == 200 and status.json()["data"]["canRequest"] is True
    queued = await client.post(base + "/request", json={}, headers=headers)
    assert queued.status_code == 200, queued.text
    if not native:
        assert queued.json()["deliveryStatus"] == "queued"
    assert captured == []
    await deliver(app)
    assert "/verify-email#token=" in captured[-1]["text"]
    assert "?token=" not in captured[-1]["text"]
    token = captured[-1]["text"].split("#token=")[1].splitlines()[0]
    confirmed = await client.post(base + "/confirm", json={"token": token}, headers=headers)
    assert confirmed.status_code == 200, confirmed.text
    assert (await client.post(base + "/confirm", json={"token": token}, headers=headers)).status_code == 400
    assert (await client.get("/api/auth/me")).json()["user"]["emailVerified"] is True
    if native:
        status = (await client.get(base, headers=headers)).json()["data"]
        assert status["verified"] is True and status["canRequest"] is False


async def test_mail_unconfigured_and_restored_copy_never_queues(client, app, settings, db):
    assert (
        await client.post("/api/auth/register/email/request", json={"email": "blocked@example.invalid"})
    ).status_code == 503
    enable(app, settings)
    async with db.connection() as conn:
        await conn.execute(
            "INSERT INTO restore_quarantine(category,payload) VALUES('external_delivery_disabled','{\"disabled\":true}'::jsonb)"
        )
    response = await client.post(
        "/api/auth/register/email/request", json={"email": "restored@example.invalid"}
    )
    assert response.status_code >= 500
    async with db.connection() as conn:
        assert not await (await conn.execute("SELECT 1 FROM identity_mail_outbox")).fetchone()


async def test_existing_email_request_has_same_shape_and_cooldown_without_mail(client, app, settings, db):
    captured = enable(app, settings)
    response = await client.post(
        "/api/auth/register", json={"username": "ExistingMailOwner", "password": PASSWORD}
    )
    uid = response.json()["user"]["id"]
    async with db.connection() as conn:
        await conn.execute("UPDATE users SET email='existing@example.invalid' WHERE id=%s", (uid,))
    result = await request(client, "existing@example.invalid")
    assert set(result) == {"challenge", "email", "expires_in", "retry_after"}
    assert captured == []
    async with db.connection() as conn:
        assert not await (await conn.execute("SELECT 1 FROM identity_mail_outbox")).fetchone()
    assert (
        await client.post("/api/auth/register/email/request", json={"email": "existing@example.invalid"})
    ).status_code == 429


@pytest.mark.parametrize("outcome", ["failed", "unknown"])
async def test_verification_cooldown_survives_failed_or_unknown_delivery(client, app, settings, db, outcome):
    from alcor_api.identity_mail import DeliveryRejected

    enable(app, settings)
    response = await client.post(
        "/api/auth/register", json={"username": "MailCooldownOwner", "password": PASSWORD}
    )
    uid = response.json()["user"]["id"]
    async with db.connection() as conn:
        await conn.execute("UPDATE users SET email='cooldown@example.invalid' WHERE id=%s", (uid,))

    async def transport(payload, identifier):
        if outcome == "failed":
            raise DeliveryRejected()
        raise TimeoutError()

    app.state.identity_email.mail.transport = transport
    path = "/api/auth/email-verification/request"
    assert (await client.post(path, json={})).status_code == 200
    result = await app.state.identity_email.mail.deliver_one(uuid4())
    assert result["status"] == outcome
    async with db.connection() as conn:
        assert not await (
            await conn.execute("SELECT 1 FROM identity_challenges WHERE purpose='email-verification'")
        ).fetchone()
    assert (await client.post(path, json={})).status_code == 429
    async with db.connection() as conn:
        assert (
            await (
                await conn.execute(
                    "SELECT count(*) AS n FROM identity_mail_outbox WHERE kind='email-verification'"
                )
            ).fetchone()
        )["n"] == 1


async def test_verification_landing_response_never_sends_referrer(client):
    response = await client.get("/verify-email")
    assert response.headers["referrer-policy"] == "no-referrer"
