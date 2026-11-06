"""Email change contracts; isolated synthetic data and transport."""

import asyncio
import re
from uuid import uuid4

import pytest
from alcor_api.native_app_auth import issue_grant
from test_identity_recovery import PASSWORD, prepare


async def setup(client, app, settings, db):
    uid, captured, pair = await prepare(client, app, settings, db)
    async with db.connection() as conn, conn.transaction():
        user = await (await conn.execute("SELECT * FROM users WHERE id=%s", (uid,))).fetchone()
        privileged = await issue_grant(
            conn, user, "portfolio.read security.read security.write", "Synthetic security phone"
        )
    client.cookies.clear()
    return uid, captured, pair, privileged


def headers(pair):
    return {"authorization": "Bearer " + pair["access_token"]}


@pytest.mark.parametrize("version", [1, 2])
async def test_direct_requires_password_retains_grant_and_resets_verification(
    client, app, settings, db, version
):
    _uid, _, pair, _ = await setup(client, app, settings, db)
    path = f"/api/v{version}/auth/email"
    bad = await client.put(
        path, json={"email": "changed@example.invalid", "currentPassword": "wrong"}, headers=headers(pair)
    )
    assert bad.status_code == 403
    result = await client.put(
        path, json={"email": "changed@example.invalid", "currentPassword": PASSWORD}, headers=headers(pair)
    )
    assert result.status_code == 200, result.text
    assert result.json()["data"]["email"] == "changed@example.invalid"
    assert result.json()["data"]["emailVerified"] is False
    assert result.json()["data"]["role"] == "user"
    assert (await client.get("/api/v2/auth/me", headers=headers(pair))).status_code == 200
    assert (
        await client.post("/api/v2/auth/email-change/request", json={}, headers=headers(pair))
    ).status_code == 403


@pytest.mark.parametrize("version", [1, 2])
async def test_proof_same_grant_one_use_and_all_sessions_revoked(client, app, settings, db, version):
    uid, captured, pair, privileged = await setup(client, app, settings, db)
    base = f"/api/v{version}/auth/email-change"
    response = await client.post(base + "/request", json={}, headers=headers(privileged))
    assert response.status_code == 200, response.text
    challenge = response.json()["data"]["challenge"]
    assert (await app.state.identity_email.mail.deliver_one(uuid4()))["status"] == "sent"
    code = re.search(r"(?:验证码：|验证码\n\n)(\d{6})", captured[-1]["text"])[1]
    verified = await client.post(
        base + "/verify", json={"challenge": challenge, "code": code}, headers=headers(privileged)
    )
    assert verified.status_code == 200, verified.text
    proof = verified.json()["data"]["proof"]
    responses = await asyncio.gather(
        *(
            client.post(
                base + "/confirm",
                json={"proof": proof, "email": "new@example.invalid"},
                headers=headers(privileged),
            )
            for _ in range(2)
        )
    )
    assert sorted(r.status_code for r in responses) == [200, 401]
    assert (await client.get("/api/v2/auth/me", headers=headers(pair))).status_code == 401
    async with db.connection() as conn:
        row = await (await conn.execute("SELECT email FROM users WHERE id=%s", (uid,))).fetchone()
        assert row["email"] == "new@example.invalid"
        row = await (
            await conn.execute("SELECT email_verified FROM identity_security WHERE user_id=%s", (uid,))
        ).fetchone()
        assert row["email_verified"] is False


async def test_wrong_codes_are_durable_and_other_grant_cannot_consume(client, app, settings, db):
    uid, captured, _, privileged = await setup(client, app, settings, db)
    async with db.connection() as conn, conn.transaction():
        user = await (await conn.execute("SELECT * FROM users WHERE id=%s", (uid,))).fetchone()
        other = await issue_grant(
            conn, user, "portfolio.read security.read security.write", "Synthetic other phone"
        )
    base = "/api/v2/auth/email-change"
    response = await client.post(base + "/request", json={}, headers=headers(privileged))
    challenge = response.json()["data"]["challenge"]
    await app.state.identity_email.mail.deliver_one(uuid4())
    code = re.search(r"(?:验证码：|验证码\n\n)(\d{6})", captured[-1]["text"])[1]
    assert (
        await client.post(
            base + "/verify", json={"challenge": challenge, "code": code}, headers=headers(other)
        )
    ).status_code == 400
    bad = "000000" if code != "000000" else "111111"
    for _ in range(5):
        assert (
            await client.post(
                base + "/verify", json={"challenge": challenge, "code": bad}, headers=headers(privileged)
            )
        ).status_code == 400
    assert (
        await client.post(
            base + "/verify", json={"challenge": challenge, "code": code}, headers=headers(privileged)
        )
    ).status_code == 400
    async with db.connection() as conn:
        row = await (
            await conn.execute(
                "SELECT attempts FROM identity_challenges WHERE purpose='email-change-code' AND user_id=%s",
                (uid,),
            )
        ).fetchone()
        assert row["attempts"] == 5


async def test_confirm_conflict_and_audit_failure_preserve_proof_and_mail_identity(client, app, settings, db):
    uid, captured, _, privileged = await setup(client, app, settings, db)
    response = await client.post(
        "/api/auth/register", json={"username": "OtherEmailOwner", "password": PASSWORD}
    )
    assert response.status_code == 201
    other = response.json()["user"]["id"]
    client.cookies.clear()
    async with db.connection() as conn:
        await conn.execute("UPDATE users SET email='taken@example.invalid' WHERE id=%s", (other,))
    base = "/api/v2/auth/email-change"
    response = await client.post(base + "/request", json={}, headers=headers(privileged))
    challenge = response.json()["data"]["challenge"]
    await app.state.identity_email.mail.deliver_one(uuid4())
    code = re.search(r"(?:验证码：|验证码\n\n)(\d{6})", captured[-1]["text"])[1]
    response = await client.post(
        base + "/verify", json={"challenge": challenge, "code": code}, headers=headers(privileged)
    )
    proof = response.json()["data"]["proof"]
    assert (
        await client.post(
            base + "/confirm",
            json={"proof": proof, "email": "TAKEN@example.invalid"},
            headers=headers(privileged),
        )
    ).status_code == 409
    async with db.connection() as conn:
        await conn.execute(
            "CREATE FUNCTION fail_email_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='account.email.changed' THEN RAISE EXCEPTION 'synthetic'; END IF; RETURN NEW; END $$"
        )
        await conn.execute(
            "CREATE TRIGGER fail_email_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_email_audit()"
        )
    assert (
        await client.post(
            base + "/confirm",
            json={"proof": proof, "email": "changed@example.invalid"},
            headers=headers(privileged),
        )
    ).status_code == 503
    async with db.connection() as conn:
        await conn.execute("DROP TRIGGER fail_email_audit ON audit_events")
        row = await (await conn.execute("SELECT email FROM users WHERE id=%s", (uid,))).fetchone()
        assert row["email"] != "changed@example.invalid"
    assert (
        await client.post(
            base + "/confirm",
            json={"proof": proof, "email": "changed@example.invalid"},
            headers=headers(privileged),
        )
    ).status_code == 200


@pytest.mark.parametrize("mutation", ["email", "stamp", "expired", "revoked"])
async def test_proof_rechecks_identity_and_grant_at_commit(client, app, settings, db, mutation):
    uid, captured, _, privileged = await setup(client, app, settings, db)
    base = "/api/v2/auth/email-change"
    response = await client.post(base + "/request", json={}, headers=headers(privileged))
    challenge = response.json()["data"]["challenge"]
    await app.state.identity_email.mail.deliver_one(uuid4())
    code = re.search(r"(?:验证码：|验证码\n\n)(\d{6})", captured[-1]["text"])[1]
    response = await client.post(
        base + "/verify", json={"challenge": challenge, "code": code}, headers=headers(privileged)
    )
    proof = response.json()["data"]["proof"]
    async with db.connection() as conn:
        if mutation == "email":
            await conn.execute("UPDATE users SET email='external@example.invalid' WHERE id=%s", (uid,))
        elif mutation == "stamp":
            await conn.execute("UPDATE users SET password_hash='invalidated-synthetic' WHERE id=%s", (uid,))
        elif mutation == "expired":
            await conn.execute(
                "UPDATE identity_challenges SET expires_at=clock_timestamp()-interval '1 second' WHERE purpose='email-change-proof'"
            )
        else:
            await conn.execute(
                "UPDATE identity_app_grants SET revoked_at=clock_timestamp() WHERE user_id=%s", (uid,)
            )
    result = await client.post(
        base + "/confirm",
        json={"proof": proof, "email": "final@example.invalid"},
        headers=headers(privileged),
    )
    assert result.status_code in (400, 401), result.text
    async with db.connection() as conn:
        row = await (await conn.execute("SELECT email FROM users WHERE id=%s", (uid,))).fetchone()
        assert row["email"] != "final@example.invalid"


async def test_unknown_mail_preserves_cooldown_and_cannot_be_verified(client, app, settings, db):
    uid, _, _, privileged = await setup(client, app, settings, db)

    async def unknown(message, identifier):
        raise TimeoutError("synthetic")

    app.state.identity_email.mail.transport = unknown
    response = await client.post("/api/v2/auth/email-change/request", json={}, headers=headers(privileged))
    assert response.status_code == 200
    assert (await app.state.identity_email.mail.deliver_one(uuid4()))["status"] == "unknown"
    assert (
        await client.post("/api/v2/auth/email-change/request", json={}, headers=headers(privileged))
    ).status_code == 429
    async with db.connection() as conn:
        assert not await (
            await conn.execute(
                "SELECT 1 FROM identity_challenges WHERE user_id=%s AND purpose='email-change-code'", (uid,)
            )
        ).fetchone()


@pytest.mark.parametrize("path", ["/api/v2/auth/email", "/api/client/email"])
async def test_direct_email_requires_enabled_factor_and_consumes_backup_once(client, app, settings, db, path):
    import time

    from alcor_api.native_identity import totp_code

    uid, _, _ = await prepare(client, app, settings, db)
    setup_response = (await client.post("/api/auth/totp")).json()
    enabled = await client.put(
        "/api/auth/totp", json={"code": totp_code(setup_response["secret"], int(time.time()))}
    )
    backup = enabled.json()["backupCodes"][0]
    async with db.connection() as conn, conn.transaction():
        user = await (await conn.execute("SELECT * FROM users WHERE id=%s", (uid,))).fetchone()
        pair = await issue_grant(conn, user, "portfolio.read", "Synthetic factor phone")
    client.cookies.clear()
    request = {"email": "factor@example.invalid", "currentPassword": PASSWORD}
    assert (await client.put(path, json=request, headers=headers(pair))).status_code == 403
    request["code"] = backup
    assert (await client.put(path, json=request, headers=headers(pair))).status_code == 200
    request["email"] = "again@example.invalid"
    assert (await client.put(path, json=request, headers=headers(pair))).status_code == 403


async def test_rotated_access_keeps_same_grant_proof(client, app, settings, db):
    from alcor_api.native_app_auth import CLIENT

    _uid, captured, _, privileged = await setup(client, app, settings, db)
    base = "/api/v2/auth/email-change"
    response = await client.post(base + "/request", json={}, headers=headers(privileged))
    challenge = response.json()["data"]["challenge"]
    await app.state.identity_email.mail.deliver_one(uuid4())
    code = re.search(r"(?:验证码：|验证码\n\n)(\d{6})", captured[-1]["text"])[1]
    rotated = await client.post(
        "/api/v2/auth/token",
        json={
            "grant_type": "refresh_token",
            "client_id": CLIENT,
            "refresh_token": privileged["refresh_token"],
        },
    )
    assert rotated.status_code == 200, rotated.text
    pair = rotated.json()["data"]
    response = await client.post(
        base + "/verify", json={"challenge": challenge, "code": code}, headers=headers(pair)
    )
    assert response.status_code == 200, response.text
    proof = response.json()["data"]["proof"]
    assert (
        await client.post(
            base + "/confirm",
            json={"proof": proof, "email": "rotated@example.invalid"},
            headers=headers(pair),
        )
    ).status_code == 200


async def test_platform_email_uses_own_session_csrf_and_shared_mail_verification(
    client, admin, settings, app, db
):
    captured = []

    async def transport(message, identifier):
        captured.append(message)

    settings.mail_enabled = True
    settings.mail_host = "smtp.example.invalid"
    settings.mail_sender = "sender@example.invalid"
    app.state.identity_email.mail.transport = transport
    read = await client.get("/api/account/email")
    assert read.status_code == 200
    assert read.json() == {"email": "admin@example.invalid", "verified": False, "twoFactorEnabled": False}
    saved = await client.put(
        "/api/account/email", json={"email": "platform@example.invalid", "currentPassword": "Synthetic9Pass"}
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["email"] == "platform@example.invalid"
    queued = await client.post("/api/account/email/verification")
    assert queued.status_code == 200, queued.text
    assert queued.json()["deliveryStatus"] == "queued"
    assert captured == []
    assert (await app.state.identity_email.mail.deliver_one(uuid4()))["status"] == "sent"
    assert "platform@example.invalid" == captured[-1]["recipient"]
    token = re.search(r"#token=([A-Za-z0-9_-]{43})", captured[-1]["text"])[1]
    assert (
        await client.post("/api/auth/email-verification/confirm", json={"token": token})
    ).status_code == 200
    assert (await client.get("/api/account/email")).json()["verified"] is True
    csrf = client.headers.pop("x-csrf-token")
    denied = await client.put(
        "/api/account/email", json={"email": "bad@example.invalid", "currentPassword": "Synthetic9Pass"}
    )
    assert denied.status_code == 403
    client.headers["x-csrf-token"] = csrf
    assert (await client.get("/api/account/email")).json()["email"] == "platform@example.invalid"


async def test_platform_email_does_not_accept_native_grant_or_unknown_fields(client, app, settings, db):
    _, _, pair, _ = await setup(client, app, settings, db)
    result = await client.put(
        "/api/account/email",
        json={"email": "bad@example.invalid", "currentPassword": PASSWORD},
        headers=headers(pair),
    )
    assert result.status_code in (401, 403)
    result = await client.put(
        "/api/v2/auth/email",
        json={"email": "bad@example.invalid", "currentPassword": PASSWORD, "role": "admin"},
        headers=headers(pair),
    )
    assert result.status_code == 400


async def test_canonical_email_proof_paths_enforce_grant_scope_binding_and_origin(client, app, settings, db):
    uid, captured, pair, privileged = await setup(client, app, settings, db)
    base = "/api/client/email-change"
    for action in ("request", "verify", "confirm"):
        assert "post" in app.openapi()["paths"][base + "/" + action]
        assert (await client.post(base + "/" + action, json={})).status_code == 401
        assert (await client.post(base + "/" + action, json={}, headers=headers(pair))).status_code == 403
    response = await client.post(
        base + "/request", json={}, headers={**headers(privileged), "origin": "https://other.example.invalid"}
    )
    assert response.status_code == 403
    response = await client.post(base + "/request", json={}, headers=headers(privileged))
    assert response.status_code == 200, response.text
    assert "data" not in response.json()
    challenge = response.json()["challenge"]
    await app.state.identity_email.mail.deliver_one(uuid4())
    code = re.search(r"(?:验证码：|验证码\n\n)(\d{6})", captured[-1]["text"])[1]
    async with db.connection() as conn, conn.transaction():
        user = await (await conn.execute("SELECT * FROM users WHERE id=%s", (uid,))).fetchone()
        other = await issue_grant(
            conn, user, "portfolio.read security.read security.write", "Synthetic other client"
        )
    assert (
        await client.post(
            base + "/verify", json={"challenge": challenge, "code": code}, headers=headers(other)
        )
    ).status_code == 400
    verified = await client.post(
        base + "/verify", json={"challenge": challenge, "code": code}, headers=headers(privileged)
    )
    assert verified.status_code == 200, verified.text
    proof = verified.json()["proof"]
    assert (
        await client.post(
            base + "/confirm",
            json={"proof": proof, "email": "canonical@example.invalid"},
            headers=headers(other),
        )
    ).status_code == 400
    result = await client.post(
        base + "/confirm",
        json={"proof": proof, "email": "canonical@example.invalid"},
        headers=headers(privileged),
    )
    assert result.status_code == 200, result.text
    assert result.json() == {"ok": True, "reauthenticationRequired": True}
    assert (await client.get("/api/v2/auth/me", headers=headers(privileged))).status_code == 401


async def test_platform_cookie_cannot_enter_native_canonical_email_proof(client, admin):
    for action in ("request", "verify", "confirm"):
        assert (await client.post("/api/client/email-change/" + action, json={})).status_code == 401


async def test_canonical_direct_email_has_exact_path_and_requires_password(client, app, settings, db):
    _, _, pair, _ = await setup(client, app, settings, db)
    assert "put" in app.openapi()["paths"]["/api/client/email"]
    request = {"email": "direct@example.invalid", "currentPassword": "wrong"}
    assert (await client.put("/api/client/email", json=request, headers=headers(pair))).status_code == 403
    request["currentPassword"] = PASSWORD
    denied = await client.put(
        "/api/client/email",
        json=request,
        headers={**headers(pair), "origin": "https://other.example.invalid"},
    )
    assert denied.status_code == 403
    result = await client.put("/api/client/email", json=request, headers=headers(pair))
    assert result.status_code == 200, result.text
    assert result.json()["email"] == "direct@example.invalid"
    assert result.json()["role"] == "user"
    assert "data" not in result.json()
    assert (await client.get("/api/v2/auth/me", headers=headers(pair))).status_code == 200


async def test_platform_cookie_cannot_use_canonical_direct_email(client, admin):
    result = await client.put(
        "/api/client/email", json={"email": "bad@example.invalid", "currentPassword": "Synthetic9Pass"}
    )
    assert result.status_code == 401
