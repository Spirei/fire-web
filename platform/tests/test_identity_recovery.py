"""Password recovery: isolated PG, fake transport only."""

import asyncio
import re
import time
from uuid import uuid4

import pytest
from alcor_api.native_app_auth import issue_grant
from alcor_api.native_identity import totp_code
from alcor_api.passwords import verify_password

PASSWORD = "SyntheticRecoveryPassword9"
NEW = "SyntheticRecoveredPassword7"


def base(version):
    return "/api/auth/password-reset" if version == 0 else f"/api/v{version}/auth/password-reset"


def payload(response, version):
    return response.json()["data"] if version else response.json()


async def prepare(client, app, settings, db, *, verified=True):
    settings.mail_enabled = True
    settings.mail_host = "smtp.example.invalid"
    settings.mail_sender = "sender@example.invalid"
    captured = []

    async def transport(message, identifier):
        captured.append(message)

    app.state.identity_email.mail.transport = transport
    response = await client.post(
        "/api/auth/register", json={"username": "RecoveryOwner", "password": PASSWORD}
    )
    assert response.status_code == 201, response.text
    uid = response.json()["user"]["id"]
    async with db.connection() as conn:
        await conn.execute("UPDATE users SET email='recovery@example.invalid' WHERE id=%s", (uid,))
        await conn.execute(
            "INSERT INTO identity_security(user_id,email_verified) VALUES(%s,%s)", (uid, verified)
        )
        user = await (await conn.execute("SELECT * FROM users WHERE id=%s", (uid,))).fetchone()
        pair = await issue_grant(conn, user, "portfolio.read", "Synthetic recovery phone")
    return uid, captured, pair


async def mail_code(client, app, captured, version=0):
    response = await client.post(base(version) + "/request", json={"login": "RecoveryOwner"})
    assert response.status_code == 200, response.text
    stage = payload(response, version)
    delivered = await app.state.identity_email.mail.deliver_one(uuid4())
    assert delivered["status"] == "sent"
    code = re.search(r"(?:验证码：|验证码\n\n)(\d{6})", captured[-1]["text"])[1]
    return stage["challenge"], code


@pytest.mark.parametrize("version", [0, 1, 2])
async def test_email_recovery_contract_single_use_and_all_sessions_revoked(
    client, app, settings, db, version
):
    uid, captured, pair = await prepare(client, app, settings, db)
    client.cookies.clear()
    missing = await client.post(base(version) + "/request", json={"login": "UnknownRecoveryOwner"})
    assert missing.status_code == 200
    assert captured == []
    challenge, code = await mail_code(client, app, captured, version)
    assert set(payload(missing, version)) == {"ok", "challenge", "retryAfter", "message"}
    assert set(payload(missing, version)) == set(
        payload(
            await client.post(
                base(version) + "/request", json={"login": "RecoveryOwner", "challenge": challenge}
            ),
            version,
        )
    )
    proof = await client.post(base(version) + "/verify", json={"challenge": challenge, "code": code})
    assert proof.status_code == 200, proof.text
    result = payload(proof, version)
    assert set(result) == ({"ok", "token", "expiresAt"} if version else {"ok", "token"})
    assert (
        await client.post(base(version) + "/verify", json={"challenge": challenge, "code": code})
    ).status_code == 400
    confirmed = await client.post(
        base(version) + "/confirm", json={"token": result["token"], "newPassword": NEW}
    )
    assert confirmed.status_code == 200, confirmed.text
    assert payload(confirmed, version) == (
        {"ok": True, "reauthenticationRequired": True} if version else {"ok": True}
    )
    assert (
        await client.post(base(version) + "/confirm", json={"token": result["token"], "newPassword": NEW})
    ).status_code == 400
    assert (
        await client.get("/api/v2/auth/me", headers={"authorization": "Bearer " + pair["access_token"]})
    ).status_code == 401
    async with db.connection() as conn:
        assert not await (await conn.execute("SELECT 1 FROM sessions WHERE user_id=%s", (uid,))).fetchone()
        assert not await (
            await conn.execute("SELECT 1 FROM identity_challenges WHERE user_id=%s", (uid,))
        ).fetchone()
        user = await (await conn.execute("SELECT password_hash FROM users WHERE id=%s", (uid,))).fetchone()
        assert verify_password(NEW, user["password_hash"])
    assert (
        await client.post("/api/auth/login", json={"username": "RecoveryOwner", "password": NEW})
    ).status_code == 200


async def test_wrong_codes_commit_attempts_and_do_not_reveal_unknown_account(client, app, settings, db):
    uid, captured, _ = await prepare(client, app, settings, db)
    client.cookies.clear()
    challenge, code = await mail_code(client, app, captured)
    bad = "000000" if code != "000000" else "111111"
    for _ in range(5):
        assert (
            await client.post(base(0) + "/verify", json={"challenge": challenge, "code": bad})
        ).status_code == 400
    assert (
        await client.post(base(2) + "/verify", json={"challenge": challenge, "code": code})
    ).status_code == 400
    async with db.connection() as conn:
        assert (
            await (
                await conn.execute(
                    "SELECT attempts FROM identity_challenges WHERE purpose='recovery-email' AND user_id=%s",
                    (uid,),
                )
            ).fetchone()
        )["attempts"] == 5
    assert (
        await client.post(base(0) + "/verify", json={"challenge": "a" * 43, "code": bad})
    ).status_code == 400


@pytest.mark.parametrize("mutation", ["email", "version", "disabled", "expired", "origin"])
async def test_proof_revalidates_identity_and_expiry_before_any_password_write(
    client, app, settings, db, mutation
):
    uid, captured, _ = await prepare(client, app, settings, db)
    challenge, code = await mail_code(client, app, captured)
    token = (await client.post(base(0) + "/verify", json={"challenge": challenge, "code": code})).json()[
        "token"
    ]
    async with db.connection() as conn:
        if mutation == "email":
            await conn.execute("UPDATE users SET email='changed@example.invalid' WHERE id=%s", (uid,))
        elif mutation == "version":
            await conn.execute("UPDATE users SET session_version=session_version+1 WHERE id=%s", (uid,))
        elif mutation == "disabled":
            await conn.execute("UPDATE users SET active=false WHERE id=%s", (uid,))
        elif mutation == "expired":
            await conn.execute(
                "UPDATE identity_challenges SET expires_at=clock_timestamp()-interval '1 second' WHERE purpose='recovery-proof'"
            )
        else:
            await conn.execute(
                "UPDATE identity_challenges SET binding='https://other.example.invalid' WHERE purpose='recovery-proof'"
            )
    rejected = await client.post(base(0) + "/confirm", json={"token": token, "newPassword": NEW})
    assert rejected.status_code == 400
    async with db.connection() as conn:
        user = await (await conn.execute("SELECT password_hash FROM users WHERE id=%s", (uid,))).fetchone()
        assert verify_password(PASSWORD, user["password_hash"])


async def test_concurrent_confirm_commits_one_password_audit_and_one_receipt(client, app, settings, db):
    uid, captured, _ = await prepare(client, app, settings, db)
    challenge, code = await mail_code(client, app, captured)
    proof = (await client.post(base(0) + "/verify", json={"challenge": challenge, "code": code})).json()[
        "token"
    ]
    results = await asyncio.gather(
        *(client.post(base(0) + "/confirm", json={"token": proof, "newPassword": NEW}) for _ in range(2))
    )
    assert sorted(r.status_code for r in results) == [200, 400]
    async with db.connection() as conn:
        assert (
            await (
                await conn.execute(
                    "SELECT count(*) AS n FROM audit_events WHERE actor_id=%s AND action='account.password.changed'",
                    (uid,),
                )
            ).fetchone()
        )["n"] == 1


async def test_confirm_audit_failure_rolls_back_password_grants_and_proof(client, app, settings, db):
    uid, captured, pair = await prepare(client, app, settings, db)
    challenge, code = await mail_code(client, app, captured)
    proof = (await client.post(base(0) + "/verify", json={"challenge": challenge, "code": code})).json()[
        "token"
    ]
    async with db.connection() as conn:
        await conn.execute(
            "CREATE FUNCTION reject_recovery_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='account.password.changed' THEN RAISE EXCEPTION 'synthetic fault'; END IF; RETURN NEW; END $$"
        )
        await conn.execute(
            "CREATE TRIGGER reject_recovery_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_recovery_audit()"
        )
    assert (
        await client.post(base(0) + "/confirm", json={"token": proof, "newPassword": NEW})
    ).status_code == 503
    assert (
        await client.get("/api/v2/auth/me", headers={"authorization": "Bearer " + pair["access_token"]})
    ).status_code == 200
    async with db.connection() as conn:
        await conn.execute("DROP TRIGGER reject_recovery_audit ON audit_events")
        user = await (await conn.execute("SELECT password_hash FROM users WHERE id=%s", (uid,))).fetchone()
        assert verify_password(PASSWORD, user["password_hash"])
    assert (
        await client.post(base(0) + "/confirm", json={"token": proof, "newPassword": NEW})
    ).status_code == 200


async def test_totp_recovery_backup_is_single_use_and_proof_failure_rolls_it_back(client, app, settings, db):
    uid, _, _ = await prepare(client, app, settings, db)
    setup = (await client.post("/api/auth/totp")).json()
    enabled = await client.put("/api/auth/totp", json={"code": totp_code(setup["secret"], int(time.time()))})
    backup = enabled.json()["backupCodes"][0]
    challenge = (
        await client.post(base(0) + "/request", json={"login": "RecoveryOwner", "method": "totp"})
    ).json()["challenge"]
    async with db.connection() as conn:
        await conn.execute(
            "CREATE FUNCTION reject_recovery_proof() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.purpose='recovery-proof' THEN RAISE EXCEPTION 'synthetic fault'; END IF; RETURN NEW; END $$"
        )
        await conn.execute(
            "CREATE TRIGGER reject_recovery_proof BEFORE INSERT ON identity_challenges FOR EACH ROW EXECUTE FUNCTION reject_recovery_proof()"
        )
    request = {"challenge": challenge, "code": backup, "method": "totp"}
    assert (await client.post(base(0) + "/verify", json=request)).status_code == 503
    async with db.connection() as conn:
        await conn.execute("DROP TRIGGER reject_recovery_proof ON identity_challenges")
        assert (
            len(
                (
                    await (
                        await conn.execute(
                            "SELECT backup_codes FROM identity_security WHERE user_id=%s", (uid,)
                        )
                    ).fetchone()
                )["backup_codes"]
            )
            == 8
        )
    verified = await client.post(base(0) + "/verify", json=request)
    assert verified.status_code == 200, verified.text
    assert (await client.post(base(0) + "/verify", json=request)).status_code == 400
    assert (
        await client.post(base(0) + "/confirm", json={"token": verified.json()["token"], "newPassword": NEW})
    ).status_code == 200
    async with db.connection() as conn:
        assert (
            len(
                (
                    await (
                        await conn.execute(
                            "SELECT backup_codes FROM identity_security WHERE user_id=%s", (uid,)
                        )
                    ).fetchone()
                )["backup_codes"]
            )
            == 7
        )


async def test_all_api_versions_share_request_budget(client):
    for i in range(5):
        assert (
            await client.post(base(i % 3) + "/request", json={"login": "UnknownRecoveryOwner"})
        ).status_code == 200
    assert (
        await client.post(base(2) + "/request", json={"login": "UnknownRecoveryOwner"})
    ).status_code == 429


async def test_unknown_failed_mail_keeps_response_neutral_and_durable_cooldown(client, app, settings, db):
    uid, _captured, _ = await prepare(client, app, settings, db)
    client.cookies.clear()

    async def transport(message, identifier):
        raise TimeoutError()

    app.state.identity_email.mail.transport = transport
    request = await client.post(base(2) + "/request", json={"login": "RecoveryOwner"})
    assert request.status_code == 200
    assert (await app.state.identity_email.mail.deliver_one(uuid4()))["status"] == "unknown"
    again = await client.post(base(1) + "/request", json={"login": "recovery@example.invalid"})
    unknown = await client.post(base(0) + "/request", json={"login": "UnknownRecoveryOwner"})
    assert again.status_code == unknown.status_code == 200
    async with db.connection() as conn:
        assert (
            await (
                await conn.execute(
                    "SELECT count(*) AS n FROM identity_mail_outbox WHERE user_id=%s AND kind='password-reset'",
                    (uid,),
                )
            ).fetchone()
        )["n"] == 1
        assert not await (
            await conn.execute("SELECT 1 FROM identity_challenges WHERE purpose='recovery-email'")
        ).fetchone()


async def test_missing_mail_key_is_not_an_account_oracle(client, app, settings, db):
    await prepare(client, app, settings, db)
    client.cookies.clear()
    app.state.identity_email.mail.vault.directory = None
    existing = await client.post(base(0) + "/request", json={"login": "RecoveryOwner"})
    missing = await client.post(base(0) + "/request", json={"login": "UnknownRecoveryOwner"})
    assert existing.status_code == missing.status_code == 200
    assert set(existing.json()) == set(missing.json())
    async with db.connection() as conn:
        assert not await (
            await conn.execute("SELECT 1 FROM identity_challenges WHERE purpose='recovery-email'")
        ).fetchone()
        assert not await (await conn.execute("SELECT 1 FROM identity_mail_outbox")).fetchone()


async def test_recovery_challenge_and_proof_survive_service_recreation(client, app, settings, db):
    from alcor_api.identity_recovery import IdentityRecovery

    uid, captured, _ = await prepare(client, app, settings, db)
    client.cookies.clear()
    challenge, code = await mail_code(client, app, captured)
    fresh = IdentityRecovery(settings, db, app.state.identity_email.mail, app.state.rate_limit)
    proof = await fresh.verify(challenge, code)
    restarted = IdentityRecovery(settings, db, app.state.identity_email.mail, app.state.rate_limit)
    assert (await restarted.confirm(proof["token"], NEW, str(uuid4())))["ok"]
    async with db.connection() as conn:
        user = await (await conn.execute("SELECT password_hash FROM users WHERE id=%s", (uid,))).fetchone()
        assert verify_password(NEW, user["password_hash"])


@pytest.mark.parametrize("login", ["RecoveryOwner", "UnknownRecoveryOwner"])
async def test_unverified_email_and_unknown_account_have_same_public_result(client, app, settings, db, login):
    await prepare(client, app, settings, db, verified=False)
    client.cookies.clear()
    response = await client.post(base(0) + "/request", json={"login": login})
    assert response.status_code == 200
    assert set(response.json()) == {"ok", "challenge", "retryAfter", "message"}
    assert len(response.json()["challenge"]) == 43
    async with db.connection() as conn:
        assert not await (await conn.execute("SELECT 1 FROM identity_mail_outbox")).fetchone()


def test_recovery_web_operations_are_exact_openapi_paths(app):
    paths = app.openapi()["paths"]
    assert "/api/auth/password-reset/{action}" not in paths
    for action in ("request", "verify", "confirm"):
        assert "post" in paths[f"/api/auth/password-reset/{action}"]
