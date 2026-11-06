"""Combined profile and media through real create_app, with no route/schema monkeypatch."""

import io

import pytest
from PIL import Image
from profile_test_support import private_profile_files  # noqa: F401 -- pytest autouse fixture
from test_legacy_devices import PASSWORD, bearer, grant, register


@pytest.mark.parametrize("version", [0, 1, 2])
async def test_combined_fields_email_rollback_and_no_native_admin(client, db, version):
    uid = await register(client)
    pair = await grant(db, uid, "portfolio.read profile.write")
    path = "/api/auth/profile" if version == 0 else f"/api/v{version}/auth/profile"
    headers = {} if version == 0 else bearer(pair)
    request = {
        "username": "ChangedOwner",
        "nickname": "New nickname",
        "email": "changed@example.invalid",
        "currentPassword": "wrong",
    }
    assert (await client.put(path, json=request, headers=headers)).status_code == 403
    async with db.connection() as conn:
        row = await (await conn.execute("SELECT username,email FROM users WHERE id=%s", (uid,))).fetchone()
        assert row["username"] == "DeviceOwner" and row["email"] == ""
    request["currentPassword"] = PASSWORD
    result = await client.put(path, json=request, headers=headers)
    assert result.status_code == 200, result.text
    profile = result.json()["user"] if version == 0 else result.json()["data"]
    assert profile["username"] == "ChangedOwner" and profile["nickname"] == "New nickname"
    assert profile["email"] == "changed@example.invalid"
    if version:
        assert profile["role"] == "user"
    async with db.connection() as conn:
        await conn.execute(
            "CREATE FUNCTION reject_profile_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='profile.legacy.updated' THEN RAISE EXCEPTION 'synthetic'; END IF; RETURN NEW; END $$"
        )
        await conn.execute(
            "CREATE TRIGGER reject_profile_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_profile_audit()"
        )
    request.update(username="FailedOwner", nickname="Failed", email="failed@example.invalid")
    assert (await client.put(path, json=request, headers=headers)).status_code == 503
    async with db.connection() as conn:
        row = await (
            await conn.execute(
                "SELECT u.username,u.email,p.display_name FROM users u JOIN user_profiles p ON p.user_id=u.id WHERE u.id=%s",
                (uid,),
            )
        ).fetchone()
        assert (
            row["username"] == "ChangedOwner"
            and row["email"] == "changed@example.invalid"
            and row["display_name"] == "New nickname"
        )


async def test_native_upload_retains_animated_gif_and_private_owner_revision(client, db):
    uid = await register(client)
    write = await grant(db, uid, "portfolio.read profile.write")
    read = await grant(db, uid, "portfolio.read")
    stream = io.BytesIO()
    Image.new("RGB", (600, 600), "white").save(
        stream,
        format="GIF",
        save_all=True,
        append_images=[Image.new("RGB", (600, 600), "black")],
        duration=100,
        loop=0,
    )
    raw = stream.getvalue()
    assert (
        await client.post("/api/v2/upload", files={"file": ("a.gif", raw, "image/gif")}, headers=bearer(read))
    ).status_code == 403
    response = await client.post(
        "/api/v2/upload", files={"file": ("a.gif", raw, "image/gif")}, headers=bearer(write)
    )
    assert response.status_code == 200, response.text
    url = response.json()["data"]["url"]
    result = await client.get(url, headers=bearer(read))
    assert result.status_code == 200 and result.content == raw
    assert result.headers["content-type"] == "image/gif"
    other = await register(client, "OtherAvatar")
    other_pair = await grant(db, other, "portfolio.read")
    assert (await client.get(url, headers=bearer(other_pair))).status_code == 404
    assert (
        await client.post(
            "/api/v2/upload",
            data={"kind": "asset"},
            files={"file": ("a.gif", raw, "image/gif")},
            headers=bearer(write),
        )
    ).status_code == 403


async def test_web_unknown_fields_ignored_native_rejected_and_avatar_limit(client, db):
    uid = await register(client)
    pair = await grant(db, uid, "portfolio.read profile.write")
    assert (
        await client.put("/api/auth/profile", json={"nickname": "Alias", "ignored": "value"})
    ).status_code == 200
    assert (
        await client.put(
            "/api/client/profile", json={"nickname": "Alias", "ignored": "value"}, headers=bearer(pair)
        )
    ).status_code == 400
    path = "/api/client/profile/avatar"
    raw = b"GIF89a" + bytes(5 * 1024 * 1024 - 6)
    result = await client.post(path, files={"file": ("a.gif", raw, "image/gif")}, headers=bearer(pair))
    assert result.status_code == 200, result.text
    profile = await client.put("/api/client/profile", json={"nickname": "After avatar"}, headers=bearer(pair))
    assert profile.status_code == 200 and profile.json()["avatar"].startswith("/api/client/profile/avatar?")
    result = await client.post(path, files={"file": ("a.gif", raw + b"x", "image/gif")}, headers=bearer(pair))
    assert result.status_code == 400
    # Platform cookie may never rescue a supplied invalid native credential.
    assert (
        await client.put(
            "/api/account/profile", json={"nickname": "Other"}, headers={"Authorization": "Bearer invalid"}
        )
    ).status_code == 403
