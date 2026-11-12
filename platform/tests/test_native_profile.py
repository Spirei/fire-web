"""Native profile adapters assembled by real create_app with numbered migration."""

import base64
import io

from PIL import Image
from profile_test_support import private_profile_files  # noqa: F401 -- pytest autouse fixture
from test_legacy_devices import bearer, grant, register


async def test_canonical_profile_uses_existing_row_and_native_scope_cas(client, db):
    uid = await register(client)
    read = await grant(db, uid, "portfolio.read")
    write = await grant(db, uid, "portfolio.read profile.write")
    path = "/api/client/profile"
    assert (await client.get(path)).status_code == 401
    profile = (await client.get(path, headers=bearer(read))).json()
    assert profile["revision"] is None
    async with db.connection() as conn:
        assert not await (
            await conn.execute("SELECT 1 FROM user_profiles WHERE user_id=%s", (uid,))
        ).fetchone()
    data = {"display_name": "Synthetic alias", "revision": None}
    assert (await client.patch(path, json=data, headers=bearer(read))).status_code == 403
    response = await client.patch(path, json=data, headers=bearer(write))
    assert response.status_code == 200, response.text
    assert (await client.patch(path, json=data, headers=bearer(write))).status_code == 409
    async with db.connection() as conn:
        row = await (
            await conn.execute("SELECT display_name FROM user_profiles WHERE user_id=%s", (uid,))
        ).fetchone()
        assert row["display_name"] == "Synthetic alias"
    assert (await client.patch(path, json=data | {"role": "admin"}, headers=bearer(write))).status_code == 422


async def test_native_avatar_sanitized_owner_revision_bound_and_revocation_checked(client, db):
    uid = await register(client)
    pair = await grant(db, uid, "portfolio.read profile.write")
    image = Image.new("RGB", (8, 8), "white")
    stream = io.BytesIO()
    image.save(stream, format="PNG")
    encoded = "data:image/png;base64," + base64.b64encode(stream.getvalue()).decode()
    response = await client.patch(
        "/api/client/profile",
        json={"display_name": "Image owner", "revision": None, "avatar_data": encoded},
        headers=bearer(pair),
    )
    assert response.status_code == 200, response.text
    revision = response.json()["avatar_revision"]
    result = await client.get(
        "/api/client/profile/avatar", params={"revision": revision}, headers=bearer(pair)
    )
    assert result.status_code == 200
    assert result.headers["content-type"] == "image/jpeg"
    assert result.headers["x-content-type-options"] == "nosniff"
    assert result.content[:3] == b"\xff\xd8\xff"
    # The existing native self-avatar transport needs only portfolio.read,
    # accepts the old cache-busting query and returns the same original image.
    read = await grant(db, uid, "portfolio.read")
    for version in (1, 2):
        picture = await client.get(
            f"/api/v{version}/auth/avatar", params={"revision": revision, "avatarVersion": "1"},
            headers=bearer(read),
        )
        assert picture.status_code == 200, picture.text
        assert picture.content == result.content
        assert picture.headers["content-type"] == "image/jpeg"
        assert "no-store" in picture.headers["cache-control"]
    assert (await client.get("/api/v2/auth/avatar", params={"revision": revision})).status_code == 401
    other = await register(client, "OtherProfile")
    other_pair = await grant(db, other, "portfolio.read")
    assert (
        await client.get(
            "/api/client/profile/avatar", params={"revision": revision}, headers=bearer(other_pair)
        )
    ).status_code == 404
    async with db.connection() as conn:
        await conn.execute(
            "UPDATE identity_app_grants SET revoked_at=clock_timestamp() WHERE user_id=%s", (uid,)
        )
    assert (
        await client.get("/api/client/profile/avatar", params={"revision": revision}, headers=bearer(pair))
    ).status_code == 401
