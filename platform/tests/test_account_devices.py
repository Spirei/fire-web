"""Canonical owner device operations; all writes target isolated test PG."""

from alcor_api.native_app_auth import issue_grant


async def test_platform_devices_show_owner_without_credentials_and_revoke_app(client, admin, db, app):
    async with db.connection() as conn:
        user = await (await conn.execute("SELECT * FROM users WHERE id=%s", (admin,))).fetchone()
        pair = await issue_grant(conn, user, "portfolio.read", "Synthetic phone")
    listed = await client.get("/api/account/devices")
    assert listed.status_code == 200, listed.text
    rows = listed.json()["devices"]
    assert len(rows) == 2
    assert next(r for r in rows if r["kind"] == "web")["current"] is True
    assert pair["access_token"] not in listed.text and pair["refresh_token"] not in listed.text
    assert (
        await client.get("/api/account/devices", headers={"authorization": "Bearer " + pair["access_token"]})
    ).status_code in (401, 403)
    request = {"id": pair["grant_id"], "currentPassword": "wrong"}
    assert (await client.request("DELETE", "/api/account/devices", json=request)).status_code == 403
    request["currentPassword"] = "Synthetic9Pass"
    removed = await client.request("DELETE", "/api/account/devices", json=request)
    assert removed.status_code == 200, removed.text
    assert removed.json() == {"revoked": True, "reauthenticationRequired": False}
    assert (
        await client.get("/api/v2/auth/me", headers={"authorization": "Bearer " + pair["access_token"]})
    ).status_code == 401
    assert (await client.get("/api/account")).status_code == 200
    assert "delete" in app.openapi()["paths"]["/api/account/devices"]


async def test_platform_device_current_session_revocation_requires_csrf(client, admin):
    rows = (await client.get("/api/account/devices")).json()["devices"]
    current = next(row for row in rows if row["current"])
    request = {"id": current["id"], "currentPassword": "Synthetic9Pass"}
    csrf = client.headers.pop("x-csrf-token")
    assert (await client.request("DELETE", "/api/account/devices", json=request)).status_code == 403
    client.headers["x-csrf-token"] = csrf
    result = await client.request("DELETE", "/api/account/devices", json=request)
    assert result.status_code == 200, result.text
    assert result.json()["reauthenticationRequired"] is True
    assert (await client.get("/api/account")).status_code == 401


async def test_platform_devices_never_revoke_other_owner_or_unknown_device(client, admin, db, settings):
    from alcor_api.cli import create_user

    other = await create_user(
        settings, "OtherDeviceOwner", "Synthetic9Pass", email="other-device@example.invalid"
    )
    async with db.connection() as conn:
        user = await (await conn.execute("SELECT * FROM users WHERE id=%s", (other,))).fetchone()
        pair = await issue_grant(conn, user, "portfolio.read", "Synthetic other phone")
    for identifier in (pair["grant_id"], "web_missing"):
        result = await client.request(
            "DELETE", "/api/account/devices", json={"id": identifier, "currentPassword": "Synthetic9Pass"}
        )
        assert result.status_code == 404
    assert (
        await client.get("/api/v2/auth/me", headers={"authorization": "Bearer " + pair["access_token"]})
    ).status_code == 200
    async with db.connection() as conn:
        assert not await (
            await conn.execute(
                "SELECT 1 FROM audit_events WHERE actor_id=%s AND action='identity.device.revoked'", (admin,)
            )
        ).fetchone()


async def test_device_read_does_not_seed_consents_or_factor_state(client, admin, db):
    async with db.connection() as conn:
        assert not await (
            await conn.execute("SELECT 1 FROM identity_app_consents WHERE user_id=%s", (admin,))
        ).fetchone()
        assert not await (
            await conn.execute("SELECT 1 FROM identity_security WHERE user_id=%s", (admin,))
        ).fetchone()
    result = await client.get("/api/account/devices")
    assert result.status_code == 200, result.text
    assert result.json()["twoFactorEnabled"] is False
    async with db.connection() as conn:
        assert not await (
            await conn.execute("SELECT 1 FROM identity_app_consents WHERE user_id=%s", (admin,))
        ).fetchone()
        assert not await (
            await conn.execute("SELECT 1 FROM identity_security WHERE user_id=%s", (admin,))
        ).fetchone()


async def test_revoked_platform_session_cannot_read_old_devices(client, admin, db):
    assert (await client.get("/api/account/devices")).status_code == 200
    async with db.connection() as conn:
        await conn.execute("DELETE FROM sessions WHERE user_id=%s", (admin,))
    response = await client.get("/api/account/devices")
    assert response.status_code == 401
    assert "devices" not in response.json()
