"""Pending integrated verification: private PG and fake mail, never real SMTP."""

from alcor_api.security import digest
from test_identity_email_flows import PASSWORD, code, deliver, enable

ROOT = "/api/session/register/email"


async def test_email_signup_creates_only_canonical_session_with_verified_email(client, app, settings, db):
    captured = enable(app, settings)
    requested = await client.post(ROOT + "/request", json={"email": "canonical@example.invalid"})
    assert requested.status_code == 200 and captured == [], requested.text
    await deliver(app)
    body = {
        "email": requested.json()["email"],
        "challenge": requested.json()["challenge"],
        "code": code(captured),
        "password": PASSWORD,
    }
    confirmed = await client.post(ROOT + "/confirm", json=body)
    assert confirmed.status_code == 201 and confirmed.json()["user"]["role"] == "admin", confirmed.text
    assert client.cookies.get("alcor_session") and not client.cookies.get("fire_session")
    assert (await client.get("/api/session")).json()["user"]["id"] == confirmed.json()["user"]["id"]
    assert (await client.post(ROOT + "/confirm", json=body)).status_code == 400
    async with db.connection() as conn:
        row = await (
            await conn.execute(
                "SELECT client_id FROM sessions WHERE token_hash=%s",
                (digest(client.cookies["alcor_session"]),),
            )
        ).fetchone()
        assert row["client_id"] == "new-web"
        assert (
            await (
                await conn.execute(
                    "SELECT email_verified FROM identity_security WHERE user_id=%s",
                    (confirmed.json()["user"]["id"],),
                )
            ).fetchone()
        )["email_verified"]


async def test_legacy_and_new_email_request_share_recipient_budget_and_no_role_input(
    client, app, settings, db
):
    enable(app, settings)
    assert (
        await client.post(ROOT + "/request", json={"email": "shared-budget@example.invalid"})
    ).status_code == 200
    assert (
        await client.post("/api/auth/register/email/request", json={"email": "SHARED-BUDGET@example.invalid"})
    ).status_code == 429
    assert (
        await client.post(ROOT + "/request", json={"email": "other@example.invalid", "role": "admin"})
    ).status_code == 422
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) AS n FROM identity_mail_outbox")).fetchone())[
            "n"
        ] == 1
        assert not await (await conn.execute("SELECT 1 FROM users")).fetchone()


async def test_current_registration_gate_rechecked_at_email_confirm_without_consuming_proof(
    client, app, settings, db
):
    captured = enable(app, settings)
    stage = (await client.post(ROOT + "/request", json={"email": "closed-gate@example.invalid"})).json()
    await deliver(app)
    body = {
        "email": stage["email"],
        "challenge": stage["challenge"],
        "code": code(captured),
        "password": PASSWORD,
    }
    async with db.connection() as conn:
        await conn.execute(
            "UPDATE site_settings SET allow_register=false,revision=revision+1 WHERE singleton"
        )
    denied = await client.post(ROOT + "/confirm", json=body)
    assert denied.status_code == 403, denied.text
    async with db.connection() as conn:
        assert not await (await conn.execute("SELECT 1 FROM users")).fetchone()
        assert (
            await (
                await conn.execute(
                    "SELECT attempts FROM identity_challenges WHERE id=%s", (digest(stage["challenge"]),)
                )
            ).fetchone()
        )["attempts"] == 0
        await conn.execute("UPDATE site_settings SET allow_register=true,revision=revision+1 WHERE singleton")
    assert (await client.post(ROOT + "/confirm", json=body)).status_code == 201


async def test_email_registration_origin_and_duplicate_secret_fields_rejected_before_mutation(
    client, app, settings, db
):
    enable(app, settings)
    assert (
        await client.post(
            ROOT + "/request",
            json={"email": "cross@example.invalid"},
            headers={"origin": "https://other.example.invalid"},
        )
    ).status_code == 403
    duplicate = '{"email":"duplicate@example.invalid","challenge":"SyntheticChallenge","code":"123456","password":"SyntheticNeverEcho9","password":"OtherSynthetic9"}'
    response = await client.post(
        ROOT + "/confirm", content=duplicate, headers={"content-type": "application/json"}
    )
    assert response.status_code == 422 and "SyntheticNeverEcho9" not in response.text
    async with db.connection() as conn:
        assert not await (await conn.execute("SELECT 1 FROM users")).fetchone()
        assert not await (await conn.execute("SELECT 1 FROM identity_mail_outbox")).fetchone()
