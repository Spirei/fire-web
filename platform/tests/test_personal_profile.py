"""Personal-profile contracts through real create_app and numbered migration."""

import asyncio
import io
from uuid import uuid4

import pytest
from PIL import Image
from profile_test_support import private_profile_files  # noqa: F401 -- pytest autouse fixture
from test_legacy_devices import bearer, grant, register


async def setup(client, db):
    uid = await register(client)
    pair = await grant(db, uid, "portfolio.read profile.write")
    read = await grant(db, uid, "portfolio.read")
    return uid, pair, read


def data(response, version):
    return response.json()["data"] if version else response.json()


def base(version):
    return f"/api/v{version}/personal-profile" if version else "/api/client/personal-profile"


@pytest.mark.parametrize("version", [0, 1, 2])
async def test_fields_cas_failed_receipts_migration_and_graphemes(client, db, version):
    uid, pair, read = await setup(client, db)
    path = base(version)
    assert (await client.get(path)).status_code == 401
    initial = await client.get(path, headers=bearer(read))
    assert initial.status_code == 200
    assert data(initial, version)["revision"] == 0
    async with db.connection() as conn:
        assert not await (
            await conn.execute("SELECT 1 FROM user_profiles WHERE user_id=%s", (uid,))
        ).fetchone()
    request = {
        "requestId": str(uuid4()),
        "revision": 0,
        "changes": {"bio": "👨‍👩‍👧‍👦" * 160, "gender": "female"},
    }
    assert (await client.patch(path, headers=bearer(read), json=request)).status_code == 403
    result = await client.patch(path, headers=bearer(pair), json=request)
    assert result.status_code == 200, result.text
    assert data(result, version)["data"]["revision"] == 1
    assert (await client.patch(path, headers=bearer(pair), json=request)).status_code == 409
    assert (
        await client.get(path + "/operations/" + request["requestId"], headers=bearer(read))
    ).status_code == 200
    stale = {"requestId": str(uuid4()), "revision": 0, "changes": {"bio": "bad"}}
    assert (await client.patch(path, headers=bearer(pair), json=stale)).status_code == 409
    receipt = await client.get(path + "/operations/" + stale["requestId"], headers=bearer(read))
    assert data(receipt, version)["state"] == "failed"
    migration = {"requestId": str(uuid4()), "revision": 1, "migration": True, "changes": {"bio": ""}}
    assert (await client.patch(path, headers=bearer(pair), json=migration)).status_code == 409
    assert data(await client.get(path, headers=bearer(pair)), version)["bio"] == "👨‍👩‍👧‍👦" * 160


async def test_background_private_real_jpeg_and_owner_path_projection(client, db, settings):
    _uid, pair, _ = await setup(client, db)
    path = base(0)
    stream = io.BytesIO()
    Image.new("RGB", (32, 16), "white").save(stream, format="JPEG")
    rid = str(uuid4())
    form = {"requestId": rid, "revision": "0"}
    response = await client.post(
        path + "/background",
        data=form,
        files={"file": ("a.jpg", stream.getvalue(), "image/jpeg")},
        headers=bearer(pair),
    )
    assert response.status_code == 200, response.text
    profile = response.json()["data"]
    assert profile["background"]["path"] == path + "/background?sha256=" + profile["background"]["sha256"]
    result = await client.get(path + "/background", headers=bearer(pair))
    assert result.status_code == 200
    assert result.content[:3] == b"\xff\xd8\xff" and "no-store" in result.headers["cache-control"]
    old = await client.get("/api/v1/personal-profile/operations/" + rid, headers=bearer(pair))
    assert old.json()["data"]["data"]["background"]["path"] == "/api/v1/personal-profile/background"
    other = await register(client, "OtherPersonal")
    other_pair = await grant(db, other, "portfolio.read")
    assert (await client.get(path + "/background", headers=bearer(other_pair))).status_code == 404
    assert (await client.get(path + "/operations/" + rid, headers=bearer(other_pair))).status_code == 404
    assert len(list((settings.file_root / "profile-media").iterdir())) == 1
    clear = {"requestId": str(uuid4()), "revision": 1, "changes": {"background": None}}
    assert (await client.patch(path, headers=bearer(pair), json=clear)).status_code == 200
    assert (await client.get(path + "/background", headers=bearer(pair))).status_code == 404
    assert "background" in (await client.get(path, headers=bearer(pair))).json()["initializedFields"]


async def test_concurrent_same_uuid_exactly_once_and_audit_fault_rolls_back(client, db):
    _uid, pair, _ = await setup(client, db)
    path = base(0)
    request = {"requestId": str(uuid4()), "revision": 0, "changes": {"bio": "one"}}
    responses = await asyncio.gather(
        *(client.patch(path, headers=bearer(pair), json=request) for _ in range(2))
    )
    assert sorted(r.status_code for r in responses) == [200, 409]
    async with db.connection() as conn:
        await conn.execute(
            "CREATE FUNCTION reject_personal_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='profile.personal.updated' THEN RAISE EXCEPTION 'synthetic'; END IF; RETURN NEW; END $$"
        )
        await conn.execute(
            "CREATE TRIGGER reject_personal_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_personal_audit()"
        )
    failing = {"requestId": str(uuid4()), "revision": 1, "changes": {"bio": "lost"}}
    assert (await client.patch(path, headers=bearer(pair), json=failing)).status_code == 503
    assert (
        await client.get(path + "/operations/" + failing["requestId"], headers=bearer(pair))
    ).status_code == 404
    assert (await client.get(path, headers=bearer(pair))).json()["bio"] == "one"


async def test_background_bounds_malformed_form_and_immutable_storage(client, db, settings):
    _uid, pair, _ = await setup(client, db)
    path = base(0)
    for size in [(2049, 1), (1, 2049)]:
        stream = io.BytesIO()
        Image.new("RGB", size, "white").save(stream, format="JPEG")
        result = await client.post(
            path + "/background",
            data={"requestId": str(uuid4()), "revision": "0"},
            files={"file": ("a.jpg", stream.getvalue(), "image/jpeg")},
            headers=bearer(pair),
        )
        assert result.status_code == 400
    result = await client.post(
        path + "/background",
        data={"requestId": str(uuid4()), "revision": "00"},
        files={"file": ("a.jpg", b"\xff\xd8\xffbad", "image/jpeg")},
        headers=bearer(pair),
    )
    assert result.status_code == 400
    assert (await client.get(path + "?userId=other", headers=bearer(pair))).status_code == 400
    stream = io.BytesIO()
    Image.new("RGB", (2048, 1), "white").save(stream, format="JPEG")
    result = await client.post(
        path + "/background",
        data={"requestId": str(uuid4()), "revision": "0"},
        files={"file": ("a.jpg", stream.getvalue(), "image/jpeg")},
        headers=bearer(pair),
    )
    assert result.status_code == 200, result.text
    target = next((settings.file_root / "profile-media").iterdir())
    assert target.stat().st_mode & 0o077 == 0
    target.write_bytes(b"corrupted")
    assert (await client.get(path + "/background", headers=bearer(pair))).status_code == 503


async def test_background_failed_commit_keeps_unreachable_private_orphan(client, db, settings):
    _uid, pair, _ = await setup(client, db)
    path = base(0)
    async with db.connection() as conn:
        await conn.execute(
            "CREATE FUNCTION reject_media_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='profile.personal.updated' THEN RAISE EXCEPTION 'synthetic'; END IF; RETURN NEW; END $$"
        )
        await conn.execute(
            "CREATE TRIGGER reject_media_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_media_audit()"
        )
    stream = io.BytesIO()
    Image.new("RGB", (8, 8), "white").save(stream, format="JPEG")
    rid = str(uuid4())
    result = await client.post(
        path + "/background",
        data={"requestId": rid, "revision": "0"},
        files={"file": ("a.jpg", stream.getvalue(), "image/jpeg")},
        headers=bearer(pair),
    )
    assert result.status_code == 503
    assert (await client.get(path + "/background", headers=bearer(pair))).status_code == 404
    assert (await client.get(path + "/operations/" + rid, headers=bearer(pair))).status_code == 404
    async with db.connection() as conn:
        assert not await (await conn.execute("SELECT 1 FROM profile_media_objects")).fetchone()
    assert len(list((settings.file_root / "profile-media").iterdir())) == 1


async def test_quarantined_orphan_cleanup_never_removes_committed_file(client, db, settings):
    import os
    import time

    from alcor_api.profile_media import ProfileMedia

    uid, _pair, _ = await setup(client, db)
    media = ProfileMedia(settings)
    async with db.connection() as conn, conn.transaction():
        committed, _ = await media.stage(conn, uid, b"synthetic committed bytes", "image/jpeg")
    root = settings.file_root / "profile-media"
    orphan = root / str(uuid4())
    orphan.write_bytes(b"synthetic orphan")
    old = time.time() - 172800
    os.utime(orphan, (old, old))
    os.utime(root / str(committed), (old, old))
    async with db.connection() as conn, conn.transaction():
        assert await media.reconcile_orphans(conn) == 1
    assert not orphan.exists() and (root / str(committed)).exists()


async def test_grapheme_boundary_uuid_case_and_foreign_receipt(client, db):
    _uid, pair, _ = await setup(client, db)
    path = base(0)
    rid = str(uuid4())
    body = {"requestId": rid, "revision": 0, "changes": {"bio": "👨‍👩‍👧‍👦" * 160}}
    result = await client.patch(path, json=body, headers=bearer(pair))
    assert result.status_code == 200, result.text
    invalid = body | {"requestId": str(uuid4()), "revision": 1, "changes": {"bio": "👨‍👩‍👧‍👦" * 161}}
    assert (await client.patch(path, json=invalid, headers=bearer(pair))).status_code == 400
    assert (await client.get(path + "/operations/" + rid.upper(), headers=bearer(pair))).status_code == 400
    other = await register(client, "OtherReceipt")
    other_pair = await grant(db, other, "portfolio.read")
    assert (await client.get(path + "/operations/" + rid, headers=bearer(other_pair))).status_code == 404
