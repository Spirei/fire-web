import asyncio
import base64
import io
from datetime import datetime, timezone
from uuid import uuid4

import pytest
from fastapi import HTTPException
from PIL import Image

from alcor_api.cli import create_user
from alcor_api.models import ProfileInput
from alcor_api.profiles import activity, update_profile
from alcor_api.security import COOKIE, Identity, csrf_token, digest

P = "/api"


def image_data(size=(64, 32)):
    image = Image.new("RGB", size, "#649b83")
    output = io.BytesIO()
    exif = Image.Exif()
    exif[315] = "Synthetic private metadata"
    image.save(output, "PNG", exif=exif)
    return "data:image/png;base64," + base64.b64encode(output.getvalue()).decode()


async def test_profile_requires_session_and_rejects_csrf_and_owner_injection(client, admin):
    data = {"display_name": "Name", "revision": None}
    assert (await client.patch(P + "/profile", json={**data, "user_id": "foreign"})).status_code == 422
    assert (await client.patch(P + "/profile", json=data, headers={"x-csrf-token": "invalid"})).status_code == 403
    assert (await client.patch(P + "/profile", json=data, headers={"origin": "https://foreign.invalid"})).status_code == 403
    client.cookies.clear()
    for path in ("/profile", "/profile/activity", f"/profile/avatar?revision={uuid4()}"):
        assert (await client.get(P + path)).status_code == 401


async def test_avatar_persists_normalized_and_private(client, admin, settings):
    profile = (await client.get(P + "/profile")).json()
    assert profile == {"username": "AdminOne", "display_name": "", "revision": None, "avatar_revision": None}
    saved = await client.patch(P + "/profile", json={"display_name": "  中文名字  ", "revision": None, "avatar_data": image_data()})
    assert saved.status_code == 200, saved.text
    profile = saved.json()
    assert profile["display_name"] == "中文名字"
    assert (await client.get(P + "/profile")).json() == profile
    path = P + "/profile/avatar?revision=" + profile["avatar_revision"]
    result = await client.get(path)
    assert result.headers["content-type"] == "image/jpeg"
    assert result.headers["cache-control"] == "no-store"
    with Image.open(io.BytesIO(result.content)) as image:
        assert image.size == (256, 256)
        assert not image.getexif()
    await create_user(settings, "other", "Synthetic9Pass", role="user")
    login = (await client.post(P + "/session/login", json={"login": "other", "password": "Synthetic9Pass"})).json()
    client.headers["x-csrf-token"] = login["csrf"]
    assert (await client.get(path)).status_code == 404
    assert (await client.get(P + "/profile")).json()["display_name"] == ""
    own = await client.patch(P + "/profile", json={"display_name": "User name", "revision": None})
    assert own.status_code == 200  # Self-owned profiles do not grant administration.
    assert (await client.get(P + "/system/overview")).status_code == 403


async def test_avatar_keep_remove_and_stale_revision(client, admin):
    first = (await client.patch(P + "/profile", json={"display_name": "First", "revision": None, "avatar_data": image_data()})).json()
    old_path = P + "/profile/avatar?revision=" + first["avatar_revision"]
    second = (await client.patch(P + "/profile", json={"display_name": "Second", "revision": first["revision"]})).json()
    assert second["avatar_revision"]
    assert (await client.get(P + "/profile/avatar?revision=" + second["avatar_revision"])).status_code == 200
    assert (await client.get(old_path)).status_code == 404
    assert (await client.patch(P + "/profile", json={"display_name": "Stale", "revision": first["revision"]})).status_code == 409
    removed = (await client.patch(P + "/profile", json={"display_name": "", "revision": second["revision"], "avatar_data": None})).json()
    assert removed["avatar_revision"] is None
    assert (await client.get(P + "/profile/avatar?revision=" + second["avatar_revision"])).status_code == 404


async def test_invalid_images_leave_profile_and_audit_unchanged(client, admin, db):
    for avatar in ("", "data:image/svg+xml;base64,PHN2Zz4=", "data:image/png;base64,bm90LWFuLWltYWdl", image_data((513, 16))):
        result = await client.patch(P + "/profile", json={"display_name": "Invalid", "revision": None, "avatar_data": avatar})
        assert result.status_code == 422
        assert avatar not in result.text or not avatar
    assert (await client.get(P + "/profile")).json()["revision"] is None
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) AS n FROM audit_events WHERE action='profile.updated'")).fetchone())["n"] == 0


async def test_concurrent_profile_creations_do_not_overwrite(client, admin, db):
    replies = await asyncio.gather(*(client.patch(P + "/profile", json={"display_name": name, "revision": None}) for name in ("First", "Second")))
    assert sorted(r.status_code for r in replies) == [200, 409]
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) AS n FROM audit_events WHERE action='profile.updated'")).fetchone())["n"] == 1


async def test_revoked_profile_identity_cannot_commit(client, admin, db):
    token = client.cookies[COOKIE]
    async with db.connection() as conn:
        row = await (await conn.execute("DELETE FROM sessions WHERE token_hash=%s RETURNING expires_at", (digest(token),))).fetchone()
    stale = Identity(admin, "AdminOne", "admin", digest(token), csrf_token(token), row["expires_at"])
    with pytest.raises(HTTPException) as rejected:
        await update_profile(db, stale, ProfileInput(display_name="stale", revision=None), None, uuid4())
    assert rejected.value.status_code == 401
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) AS n FROM user_profiles")).fetchone())["n"] == 0


async def test_activity_uses_own_events_beijing_midnight_and_bounded_coverage(client, admin, db, settings):
    other = await create_user(settings, "other", "Synthetic9Pass", role="user")
    async with db.connection() as conn:
        await conn.execute("DELETE FROM audit_events")
        await conn.execute("UPDATE users SET created_at='2026-10-28T00:00:00Z' WHERE id=%s", (admin,))
        for actor, action, stamp in [
            (admin, "session.created", "2026-10-28T15:59:59Z"),
            (admin, "task.submitted", "2026-10-28T16:00:00Z"),
            (admin, "task.cancel_requested", "2026-10-29T03:00:00Z"),
            (admin, "profile.updated", "2026-10-30T01:00:00Z"),
            (admin, "session.revoked", "2026-10-30T02:00:00Z"),
            (admin, "session.created", "2026-10-27T00:00:00Z"),
            (admin, "session.created", "2026-11-01T00:00:00Z"),
            (other, "profile.updated", "2026-10-30T01:00:00Z"),
        ]:
            await conn.execute("INSERT INTO audit_events (actor_id,action,created_at) VALUES (%s,%s,%s)", (actor, action, stamp))
    data = await activity(db, admin, datetime(2026, 10, 31, 8, tzinfo=timezone.utc))
    assert str(data["start"]) == "2025-11-01"
    assert str(data["observed_since"]) == "2026-10-28"
    assert [(str(d["date"]), d["login"], d["tasks"], d["profile"]) for d in data["days"]] == [
        ("2026-10-28", 1, 0, 0), ("2026-10-29", 0, 2, 0), ("2026-10-30", 0, 0, 1), ("2026-10-31", 0, 0, 0)]
    response = await client.get(P + "/profile/activity")
    assert response.status_code == 200 and response.json()["timezone"] == "Asia/Shanghai"
    assert response.headers["cache-control"] == "no-store"
