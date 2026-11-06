from alcor_api.security import COOKIE, digest

PREFIX = "/api/reference/rates/provider"


async def age(db, token):
    async with db.connection() as conn:
        await conn.execute(
            "UPDATE sessions SET created_at=clock_timestamp()-interval '1 hour' WHERE token_hash=%s",
            (digest(token),),
        )


async def test_reference_admin_can_verify_in_place_and_proof_does_not_cross_scope(client, admin, db):
    await age(db, client.cookies[COOKIE])
    before = (await client.get(PREFIX)).json()
    payload = {"enabled": False, "dailyBudget": 7, "revision": before["revision"]}
    denied = await client.put(PREFIX, json=payload)
    assert denied.status_code == 403
    assert denied.headers["X-Alcor-Reauthentication"] == "required"
    assert (await client.get(PREFIX)).json() == before
    wrong = await client.post(
        PREFIX + "/reauthenticate", json={"password": "WrongSyntheticPassword9", "code": ""}
    )
    assert wrong.status_code == 403
    deployment = await client.post(
        "/api/deployment/reauthenticate", json={"password": "Synthetic9Pass", "code": ""}
    )
    assert deployment.status_code == 204
    assert (await client.put(PREFIX, json=payload)).status_code == 403
    proof = await client.post(PREFIX + "/reauthenticate", json={"password": "Synthetic9Pass", "code": ""})
    assert proof.status_code == 204
    accepted = await client.put(PREFIX, json=payload)
    assert accepted.status_code == 200, accepted.text
    assert (await client.get(PREFIX)).json()["daily_budget"] == 7
    # Sensitive proof remains a server-side session-bound row, never a client token.
    assert not proof.content


async def test_reference_verification_requires_csrf_and_is_rejected_after_revocation(client, admin, db):
    await age(db, client.cookies[COOKIE])
    data = {"password": "Synthetic9Pass", "code": ""}
    assert (
        await client.post(PREFIX + "/reauthenticate", json=data, headers={"X-CSRF-Token": "invalid"})
    ).status_code == 403
    assert (await client.post(PREFIX + "/reauthenticate", json=data)).status_code == 204
    async with db.connection() as conn:
        await conn.execute("UPDATE users SET session_version=session_version+1 WHERE id=%s", (admin,))
    result = await client.put(PREFIX, json={"enabled": False, "dailyBudget": 8, "revision": 1})
    assert result.status_code == 401
    async with db.connection() as conn:
        row = await (await conn.execute("SELECT daily_budget,revision FROM fx_config")).fetchone()
        assert row["daily_budget"] == 12 and row["revision"] == 1
