"""Integration invariants: crossing writes, security, directory and real restore."""

import asyncio
import io
from uuid import UUID, uuid4

import httpx
import psycopg
import pytest
import test_backups as backup_tests
from alcor_api import backups
from alcor_api.identity_email_change import IdentityEmailChange
from alcor_api.main import create_app
from alcor_api.profile_media import ProfileMedia
from PIL import Image
from profile_test_support import private_profile_files  # noqa: F401 -- pytest autouse fixture
from test_legacy_devices import PASSWORD, bearer, grant, register

configured = backup_tests.configured
backup_app = backup_tests.backup_app
bc = backup_tests.bc


def jpeg():
    stream = io.BytesIO()
    Image.new("RGB", (12, 8), "white").save(stream, format="JPEG")
    return stream.getvalue()


async def test_combination_and_personal_crossing_locks_complete_without_partial_state(
    client, db, monkeypatch
):
    uid = await register(client)
    pair = await grant(db, uid, "portfolio.read profile.write")
    locked = asyncio.Event()
    release = asyncio.Event()
    original = IdentityEmailChange.owner

    async def pause_after_owner(self, conn, who):
        row = await original(self, conn, who)
        locked.set()
        await release.wait()
        return row

    monkeypatch.setattr(IdentityEmailChange, "owner", pause_after_owner)
    combination = asyncio.create_task(client.put("/api/auth/profile", json={"nickname": "Atomic alias"}))
    await asyncio.wait_for(locked.wait(), 1)
    personal = asyncio.create_task(
        client.patch(
            "/api/client/personal-profile",
            headers=bearer(pair),
            json={"requestId": str(uuid4()), "revision": 0, "changes": {"bio": "Atomic biography"}},
        )
    )
    # Force the former inversion: owner row is locked before the combination
    # reaches profile lock; the personal writer has started its own lock path.
    for _ in range(40):
        async with db.connection() as conn:
            row = await (
                await conn.execute(
                    "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND pid<>pg_backend_pid()"
                )
            ).fetchone()
        if row:
            break
        await asyncio.sleep(0.01)
    try:
        assert row, "both competing requests must actually reach their lock boundary"
    finally:
        release.set()
    replies = await asyncio.wait_for(asyncio.gather(combination, personal), 3)
    assert [response.status_code for response in replies] == [200, 200], [
        response.text for response in replies
    ]
    async with db.connection() as conn:
        row = await (
            await conn.execute(
                "SELECT display_name,bio,personal_revision FROM user_profiles WHERE user_id=%s", (uid,)
            )
        ).fetchone()
    assert row == {"display_name": "Atomic alias", "bio": "Atomic biography", "personal_revision": 1}


async def test_totp_rejection_projects_legacy_prompt_and_rolls_back_combined_changes(client, db):
    uid = await register(client)
    setup = await client.post("/api/auth/totp")
    assert setup.status_code == 200, setup.text
    import time

    from alcor_api.native_identity import totp_code

    enabled = await client.put(
        "/api/auth/totp", json={"code": totp_code(setup.json()["secret"], int(time.time()))}
    )
    assert enabled.status_code == 200, enabled.text
    codes = enabled.json()["backupCodes"]
    pair = await grant(db, uid, "portfolio.read profile.write")
    data = {
        "username": "AfterFactor",
        "nickname": "After",
        "email": "factor@example.invalid",
        "currentPassword": PASSWORD,
    }
    denied = await client.put("/api/auth/profile", json=data)
    assert denied.status_code == 403 and denied.json()["requiresSecondFactor"] is True
    native = await client.put("/api/v2/auth/profile", json=data, headers=bearer(pair))
    assert native.status_code == 403 and native.json()["code"] == 40104
    async with db.connection() as conn:
        await conn.execute(
            "CREATE FUNCTION profile_factor_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='profile.legacy.updated' THEN RAISE EXCEPTION 'synthetic fault'; END IF; RETURN NEW; END $$"
        )
        await conn.execute(
            "CREATE TRIGGER profile_factor_fault BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION profile_factor_fault()"
        )
    failed = await client.put("/api/v2/auth/profile", json=data | {"code": codes[0]}, headers=bearer(pair))
    assert failed.status_code == 503
    async with db.connection() as conn:
        user = await (await conn.execute("SELECT username,email FROM users WHERE id=%s", (uid,))).fetchone()
        assert user == {"username": "DeviceOwner", "email": ""}
        assert not await (
            await conn.execute("SELECT 1 FROM user_profiles WHERE user_id=%s", (uid,))
        ).fetchone()
        await conn.execute("DROP TRIGGER profile_factor_fault ON audit_events")
    # The same code succeeds after rollback; no factor was consumed by a lost profile transaction.
    accepted = await client.put("/api/v2/auth/profile", json=data | {"code": codes[0]}, headers=bearer(pair))
    assert accepted.status_code == 200, accepted.text
    assert (
        await client.put(
            "/api/v2/auth/profile",
            json=data | {"email": "next@example.invalid", "code": codes[0]},
            headers=bearer(pair),
        )
    ).status_code == 403


async def test_profile_budget_is_shared_with_email_and_native_canonical(client, db):
    uid = await register(client)
    pair = await grant(db, uid, "portfolio.read profile.write")
    async with db.connection() as conn:
        await conn.execute(
            "INSERT INTO auth_rate_limits(bucket,window_start,attempts) VALUES(%s,clock_timestamp(),30)",
            ("profile-account:" + uid,),
        )
    for method, path, body in (
        ("PUT", "/api/auth/profile", {"nickname": "Nope"}),
        ("PUT", "/api/v2/auth/profile", {"nickname": "Nope"}),
        ("PUT", "/api/client/profile", {"nickname": "Nope"}),
        ("PATCH", "/api/client/profile", {"display_name": "Nope", "revision": None}),
        ("PUT", "/api/client/email", {"email": "next@example.invalid", "currentPassword": PASSWORD}),
    ):
        response = await client.request(
            method, path, json=body, headers={} if path == "/api/auth/profile" else bearer(pair)
        )
        assert response.status_code == 429, (path, response.text)
    async with db.connection() as conn:
        assert not await (
            await conn.execute("SELECT 1 FROM user_profiles WHERE user_id=%s", (uid,))
        ).fetchone()


async def test_directory_sees_original_media_and_deletion_erases_personal_payloads(client, app, db):
    await register(client)
    # A separate ordinary user supplies the avatar; all storage remains private.
    other = await register(client, "ProfileOrdinary")
    pair = await grant(db, other, "portfolio.read profile.write")
    raw = b"GIF89a" + bytes(120)
    uploaded = await client.post(
        "/api/client/profile/avatar", headers=bearer(pair), files={"file": ("a.gif", raw, "image/gif")}
    )
    assert uploaded.status_code == 200, uploaded.text
    changed = await client.patch(
        "/api/client/personal-profile",
        headers=bearer(pair),
        json={"requestId": str(uuid4()), "revision": 0, "changes": {"bio": "Delete this biography"}},
    )
    assert changed.status_code == 200
    # Switch to the existing administrator through the regular platform login.
    signed = await client.post("/api/session/login", json={"login": "DeviceOwner", "password": PASSWORD})
    assert signed.status_code == 200, signed.text
    client.headers["x-csrf-token"] = signed.json()["csrf"]
    listed = await client.get("/api/users")
    target = next(row for row in listed.json()["items"] if row["id"] == other)
    assert target["avatar_revision"]
    response = await client.get(f"/api/users/{other}/avatar", params={"revision": target["avatar_revision"]})
    assert (
        response.status_code == 200
        and response.content == raw
        and response.headers["content-type"] == "image/gif"
    )
    removed = await client.request(
        "DELETE", f"/api/users/{other}", json={"request_id": str(uuid4()), "revision": target["revision"], "current_password": PASSWORD}
    )
    assert removed.status_code == 200, removed.text
    async with db.connection() as conn:
        assert not await (
            await conn.execute("SELECT 1 FROM user_profiles WHERE user_id=%s", (other,))
        ).fetchone()
        assert not await (
            await conn.execute("SELECT 1 FROM profile_operation_receipts WHERE owner_id=%s", (other,))
        ).fetchone()
        assert not await (
            await conn.execute("SELECT 1 FROM profile_media_objects WHERE owner_id=%s", (other,))
        ).fetchone()
    assert (await client.get("/api/client/profile", headers=bearer(pair))).status_code == 401
    assert (
        await client.get(f"/api/users/{other}/avatar", params={"revision": target["avatar_revision"]})
    ).status_code == 404


async def test_profile_media_constraints_reject_cross_owner_reference(client, db):
    first = await register(client)
    second = await register(client, "ForeignMedia")
    media = ProfileMedia(db.settings)
    async with db.connection() as conn, conn.transaction():
        identifier, sha = await media.stage(conn, first, jpeg(), "image/jpeg")
    async with db.connection() as conn:
        with pytest.raises(psycopg.errors.ForeignKeyViolation):
            await conn.execute(
                "INSERT INTO user_profiles(user_id,revision,avatar_object_id) VALUES(%s,%s,%s)",
                (second, uuid4(), identifier),
            )
        with pytest.raises(psycopg.errors.CheckViolation):
            await conn.execute(
                "INSERT INTO user_profiles(user_id,revision,background_sha256) VALUES(%s,%s,%s)",
                (second, uuid4(), sha),
            )


@pytest.mark.parametrize("version", [1, 2])
async def test_discovery_advertises_exact_implemented_profile_paths(client, version):
    old = await client.get(f"/api/v{version}/auth/config")
    assert old.status_code == 200
    value = old.json()["data"]["personal_profile"]
    assert value["path"] == f"/api/v{version}/personal-profile" and value["bio_max_graphemes"] == 160
    canonical = await client.get("/api/client/config")
    value = canonical.json()
    assert (
        value["profile_path"] == "/api/client/profile"
        and value["upload_path"] == "/api/client/profile/avatar"
    )
    assert (
        value["personal_profile"]["operation_path"] == "/api/client/personal-profile/operations/{requestId}"
    )


async def test_missing_or_corrupt_profile_file_prevents_successful_backup(bc, backup_app, configured):
    owner = (await bc.get("/api/account")).json()["id"]
    media = ProfileMedia(configured)
    async with backup_app.state.db.connection() as conn, conn.transaction():
        identifier, _ = await media.stage(conn, owner, jpeg(), "image/jpeg")
    path = configured.file_root / "profile-media" / str(identifier)
    path.write_bytes(b"corrupt")
    job, _ = await backup_tests.submit(bc)
    from alcor_api.worker import claim

    task = await claim(backup_app.state.db, uuid4())
    assert str(task["id"]) == job["id"]
    with pytest.raises(backups.BackupFailure, match="个人资料文件"):
        await backups.run_job(configured, backup_app.state.db, task)
    async with backup_app.state.db.connection() as conn:
        assert not await (await conn.execute("SELECT 1 FROM backups WHERE id=%s", (task["id"],))).fetchone()
    assert not (configured.backup_dir / (job["id"] + ".enc")).exists()
    # A failed snapshot must release its session pin so Worker maintenance resumes.
    async with backup_app.state.db.connection() as conn, conn.transaction():
        assert (
            await (
                await conn.execute(
                    "SELECT pg_try_advisory_xact_lock(hashtextextended('profile-media-lifecycle',0)) AS ok"
                )
            ).fetchone()
        )["ok"]


async def test_real_restore_preserves_media_owner_receipt_and_initialized_clear(bc, backup_app, configured):
    owner = (await bc.get("/api/account")).json()["id"]
    pair = await grant(backup_app.state.db, owner, "portfolio.read profile.write")
    avatar = b"GIF89a" + bytes(20)
    response = await bc.post(
        "/api/client/profile/avatar", headers=bearer(pair), files={"file": ("a.gif", avatar, "image/gif")}
    )
    assert response.status_code == 200, response.text
    bg_id = str(uuid4())
    response = await bc.post(
        "/api/client/personal-profile/background",
        headers=bearer(pair),
        data={"requestId": bg_id, "revision": "0"},
        files={"file": ("bg.jpg", jpeg(), "image/jpeg")},
    )
    assert response.status_code == 200, response.text
    original_bg = await bc.get("/api/client/personal-profile/background", headers=bearer(pair))
    clear_id = str(uuid4())
    response = await bc.patch(
        "/api/client/personal-profile",
        headers=bearer(pair),
        json={"requestId": clear_id, "revision": 1, "changes": {"bio": ""}},
    )
    assert response.status_code == 200, response.text
    async with backup_app.state.db.connection() as conn:
        before_profile = await (
            await conn.execute("SELECT * FROM user_profiles WHERE user_id=%s", (owner,))
        ).fetchone()
        before_receipts = await (
            await conn.execute(
                "SELECT * FROM profile_operation_receipts WHERE owner_id=%s ORDER BY request_id", (owner,)
            )
        ).fetchall()
        before_media = await (
            await conn.execute("SELECT * FROM profile_media_objects WHERE owner_id=%s ORDER BY id", (owner,))
        ).fetchall()
    # Proven orphan bytes have no metadata and must never enter an archive.
    orphan = configured.file_root / "profile-media" / str(uuid4())
    orphan.write_bytes(b"uncommitted synthetic private orphan")
    orphan.chmod(0o600)
    backup_id, _ = await backup_tests.create_capsule(bc, backup_app, configured)
    row = await backups.row_for(backup_app.state.db, UUID(backup_id))
    manifest, entries = backups.unpack(configured, row)
    assert len([name for name in entries if name.startswith("profile-media/")]) == 2
    assert "profile-media/" + orphan.name not in entries
    assert manifest["media_contract"] == "immutable-sha256+profile-uuid-v1"
    preview = await bc.get(
        "/api/backups/" + backup_id + "/restore-preview", params={"target_id": "isolated-qa"}
    )
    assert preview.status_code == 200, preview.text
    job, _ = await backup_tests.submit(
        bc,
        "backup.restore",
        backup_id=backup_id,
        target_id="isolated-qa",
        restore_ticket=preview.json()["restore_ticket"],
    )
    result = await backup_tests.execute(backup_app, configured, UUID(job["id"]))
    assert result["files_verified"] == 3
    target = configured.restore_targets[0]
    recovered_settings = configured.model_copy(
        update={
            "database_url": target.database_url,
            "instance_id": target.instance_id,
            "environment": "test",
            "file_root": target.recovery_directory / "files",
            "redis_url": None,
            "connection_secret_dir": target.recovery_directory / "connection-secrets",
        }
    )
    recovered = create_app(recovered_settings)
    async with (
        recovered.router.lifespan_context(recovered),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=recovered, raise_app_exceptions=False),
            base_url="http://testserver",
            headers={"origin": "http://testserver"},
        ) as new,
    ):
        async with recovered.state.db.connection() as conn:
            assert (
                await (
                    await conn.execute("SELECT * FROM user_profiles WHERE user_id=%s", (owner,))
                ).fetchone()
                == before_profile
            )
            assert (
                await (
                    await conn.execute(
                        "SELECT * FROM profile_operation_receipts WHERE owner_id=%s ORDER BY request_id",
                        (owner,),
                    )
                ).fetchall()
                == before_receipts
            )
            assert (
                await (
                    await conn.execute(
                        "SELECT * FROM profile_media_objects WHERE owner_id=%s ORDER BY id", (owner,)
                    )
                ).fetchall()
                == before_media
            )
            assert not await (await conn.execute("SELECT 1 FROM sessions")).fetchone()
        signed = await new.post(
            "/api/session/login", json={"login": "BackupQA", "password": "Synthetic9Pass"}
        )
        assert signed.status_code == 200, signed.text
        new.headers["x-csrf-token"] = signed.json()["csrf"]
        profile = (await new.get("/api/profile")).json()
        media = await new.get("/api/profile/avatar", params={"revision": profile["avatar_revision"]})
        assert (
            media.status_code == 200
            and media.content == avatar
            and media.headers["content-type"] == "image/gif"
        )
        background = await new.get("/api/account/personal-profile/background")
        assert background.status_code == 200 and background.content == original_bg.content
        original = await new.get("/api/account/personal-profile/operations/" + bg_id)
        assert original.status_code == 200 and original.json()["requestId"] == bg_id
        migrated = await new.patch(
            "/api/account/personal-profile",
            json={
                "requestId": str(uuid4()),
                "revision": 2,
                "migration": True,
                "changes": {"bio": "overwrite explicit clear"},
            },
        )
        assert migrated.status_code == 409
        data = await new.get("/api/account/personal-profile")
        assert data.json()["bio"] == "" and data.json()["initializedFields"] == ["background", "bio"]


async def test_snapshot_media_capture_excludes_later_committed_object(client, db, settings):
    from alcor_api.profile_backup import capture_profile_media
    from psycopg.rows import dict_row

    owner = await register(client)
    media = ProfileMedia(settings)
    async with db.connection() as conn, conn.transaction():
        first, _ = await media.stage(conn, owner, jpeg(), "image/jpeg")
    async with (
        await psycopg.AsyncConnection.connect(
            settings.database_url.get_secret_value(), row_factory=dict_row
        ) as snapshot,
        snapshot.transaction(),
    ):
        await snapshot.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        await snapshot.execute("SELECT pg_export_snapshot()")
        async with db.connection() as conn, conn.transaction():
            later, _ = await media.stage(conn, owner, b"GIF89a" + bytes(8), "image/gif")
        entries = {}
        await capture_profile_media(snapshot, settings, entries)
        assert list(entries) == ["profile-media/" + str(first)]
        assert "profile-media/" + str(later) not in entries


async def test_invalid_unicode_and_exhausted_safe_revision_leave_state_intact(client, db):
    owner = await register(client)
    pair = await grant(db, owner, "portfolio.read profile.write")
    path = "/api/client/personal-profile"
    raw = ('{"requestId":"' + str(uuid4()) + '","revision":0,"changes":{"bio":"\\ud800"}}').encode()
    response = await client.patch(
        path, content=raw, headers=bearer(pair) | {"content-type": "application/json"}
    )
    assert response.status_code == 400
    async with db.connection() as conn:
        assert not await (
            await conn.execute("SELECT 1 FROM user_profiles WHERE user_id=%s", (owner,))
        ).fetchone()
        await conn.execute(
            "INSERT INTO user_profiles(user_id,revision,personal_revision) VALUES(%s,%s,9007199254740991)",
            (owner, uuid4()),
        )
    rid = str(uuid4())
    response = await client.patch(
        path,
        json={
            "requestId": rid,
            "revision": 9007199254740991,
            "changes": {"bio": "unrepresentable next revision"},
        },
        headers=bearer(pair),
    )
    assert response.status_code == 409
    result = await client.get(path + "/operations/" + rid, headers=bearer(pair))
    assert result.status_code == 200 and result.json()["state"] == "failed"
    assert (await client.get(path, headers=bearer(pair))).json()["revision"] == 9007199254740991


async def test_backup_pins_media_before_snapshot_until_retirement_cleanup_can_finish(
    bc, backup_app, configured, monkeypatch
):
    import os
    import time

    from alcor_api.cli import create_user

    owner = await create_user(configured, "MediaRetirement", "Synthetic9Pass", role="user")
    media = ProfileMedia(configured)
    raw = jpeg()
    async with backup_app.state.db.connection() as conn, conn.transaction():
        identifier, _ = await media.stage(conn, owner, raw, "image/jpeg")
        await conn.execute(
            "INSERT INTO user_profiles(user_id,revision,avatar_object_id) VALUES(%s,%s,%s)",
            (owner, uuid4(), identifier),
        )
    target_path = configured.file_root / "profile-media" / str(identifier)
    old = time.time() - 172800
    os.utime(target_path, (old, old))
    snapshot_reached = asyncio.Event()
    allow_snapshot = asyncio.Event()
    original_verify = backups.verify_identity

    async def pause_snapshot(connection, settings):
        await original_verify(connection, settings)
        snapshot_reached.set()
        await allow_snapshot.wait()

    monkeypatch.setattr(backups, "verify_identity", pause_snapshot)
    building = asyncio.create_task(backup_tests.create_capsule(bc, backup_app, configured))
    await asyncio.wait_for(snapshot_reached.wait(), 2)
    listing = await bc.get("/api/users")
    row = next(item for item in listing.json()["items"] if item["id"] == owner)
    deleted = await bc.request(
        "DELETE", "/api/users/" + owner, json={"request_id": str(uuid4()), "revision": row["revision"], "current_password": "Synthetic9Pass"}
    )
    assert deleted.status_code == 200, deleted.text

    async def reclaim():
        async with backup_app.state.db.connection() as conn, conn.transaction():
            return await media.reconcile_orphans(conn)

    cleanup = asyncio.create_task(reclaim())
    try:
        blocked = False
        for _ in range(40):
            async with backup_app.state.db.connection() as conn:
                waiting = await (
                    await conn.execute(
                        "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%%profile-media-lifecycle%%' AND pid<>pg_backend_pid()"
                    )
                ).fetchone()
            if waiting:
                blocked = True
                break
            if cleanup.done():
                break
            await asyncio.sleep(0.01)
        assert blocked and not cleanup.done(), (
            "cleanup must be blocked by a lock acquired before the RR snapshot"
        )
        assert target_path.read_bytes() == raw
    finally:
        allow_snapshot.set()
        if not blocked:
            await asyncio.gather(building, cleanup, return_exceptions=True)
    # Completion depends on the real retained-table snapshot, not a four-second
    # timing assumption under concurrent isolated database shards. Lock and bytes
    # assertions above/below remain the actual safety contract.
    backup_id, _ = await asyncio.wait_for(building, 30)
    assert await asyncio.wait_for(cleanup, 3) == 1
    assert not target_path.exists()
    archived = await backups.row_for(backup_app.state.db, UUID(backup_id))
    manifest, entries = backups.unpack(configured, archived)
    assert entries["profile-media/" + str(identifier)] == raw
    assert manifest["tables"]["profile_media_objects"]["rows"] == 1
    # Current source is retired; archived bytes and rows are the earlier snapshot.
    async with backup_app.state.db.connection() as conn:
        assert not await (
            await conn.execute("SELECT 1 FROM profile_media_objects WHERE id=%s", (identifier,))
        ).fetchone()
        assert (await (await conn.execute("SELECT deleted_at FROM users WHERE id=%s", (owner,))).fetchone())[
            "deleted_at"
        ]


async def test_cookie_cannot_rescue_supplied_invalid_authorization_on_profile_adapters(client, db):
    await register(client)
    for authorization in ("", "invalid"):
        denied = await client.put(
            "/api/auth/profile", json={"nickname": "must not save"}, headers={"authorization": authorization}
        )
        assert denied.status_code == 403
        denied = await client.put(
            "/api/v1/auth/profile",
            json={"nickname": "must not save"},
            headers={"authorization": authorization},
        )
        assert denied.status_code == 401
    async with db.connection() as conn:
        assert not await (await conn.execute("SELECT 1 FROM user_profiles")).fetchone()
