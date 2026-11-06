import asyncio
import hashlib
import os
import stat
from uuid import uuid4

import psycopg
import pytest
import resource_import_fixtures as source_fixtures
from resource_import_fixtures import (
    DELETED,
    DIGEST,
    OWNER,
    RAW,
    READY,
    UPLOAD_ID,
    authorize,
    segment,
    snapshot,
)

source = source_fixtures.source
settings = source_fixtures.settings
app = source_fixtures.app
client = source_fixtures.client
admin = source_fixtures.admin

P = "/api/resource-import"
R = "/api/resource-library"


async def test_parallel_segment_same_uuid_is_once_different_uuid_has_cas_conflict(client, admin, source, app):
    manifest, _ = await snapshot(client, await authorize(client, admin, source))
    preview = (await client.post(P + "/manifests/" + manifest + "/preview", json={"revision": 2})).json()
    command = {
        "requestId": str(uuid4()),
        "revision": 2,
        "preview": preview["preview"],
        "maxItems": 2,
        "retryBlocked": False,
    }
    path = P + "/manifests/" + manifest + "/segments"
    first, duplicate = await asyncio.gather(client.post(path, json=command), client.post(path, json=command))
    assert first.status_code == duplicate.status_code == 200, (first.text, duplicate.text)
    assert first.json() == duplicate.json()
    preview = (await client.post(P + "/manifests/" + manifest + "/preview", json={"revision": 2})).json()
    commands = [{**command, "requestId": str(uuid4()), "preview": preview["preview"]} for _ in range(2)]
    responses = await asyncio.gather(*(client.post(path, json=c) for c in commands))
    assert sorted(r.status_code for r in responses) == [200, 409], [r.text for r in responses]
    async with app.state.db.connection() as conn:
        assert (
            await (
                await conn.execute(
                    "SELECT count(*) n FROM audit_events WHERE action='resource-source.segment'"
                )
            ).fetchone()
        )["n"] == 2
        assert (await (await conn.execute("SELECT count(*) n FROM resource_files")).fetchone())["n"] == 2
        assert (await (await conn.execute("SELECT count(*) n FROM resource_media_objects")).fetchone())[
            "n"
        ] == 1


async def test_segment_audit_fault_rolls_back_files_quota_mapping_and_receipt_preserves_private_orphan(
    client, admin, source, app, settings
):
    manifest, _ = await snapshot(client, await authorize(client, admin, source))
    await segment(client, manifest, 2)  # Commit only directories first.
    async with app.state.db.connection() as conn:
        await conn.execute(
            "CREATE FUNCTION synthetic_resource_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.action='resource-source.segment' THEN RAISE EXCEPTION 'synthetic audit fault'; END IF; RETURN NEW; END $$"
        )
        await conn.execute(
            "CREATE TRIGGER synthetic_resource_audit_failure BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION synthetic_resource_audit_failure()"
        )
    preview = (await client.post(P + "/manifests/" + manifest + "/preview", json={"revision": 2})).json()
    command = {
        "requestId": str(uuid4()),
        "revision": 2,
        "preview": preview["preview"],
        "maxItems": 2,
        "retryBlocked": False,
    }
    result = await client.post(P + "/manifests/" + manifest + "/segments", json=command)
    assert result.status_code >= 500
    assert (await client.get(P + "/operations/" + command["requestId"])).status_code == 404
    assert (await client.get(R)).json()["usage"]["fileCount"] == 0
    async with app.state.db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) n FROM resource_media_objects")).fetchone())[
            "n"
        ] == 0
        assert (
            await (
                await conn.execute(
                    "SELECT count(*) n FROM resource_import_records WHERE kind='file' AND state='applied'"
                )
            ).fetchone()
        )["n"] == 0
        await conn.execute("DROP TRIGGER synthetic_resource_audit_failure ON audit_events")
        await conn.execute("DROP FUNCTION synthetic_resource_audit_failure()")
    assert (settings.file_root / "resource-media" / DIGEST).read_bytes() == RAW
    # Explicit user resubmission of the same not-committed command is safe; no
    # client automatic replay is introduced by the backend.
    retry = await client.post(P + "/manifests/" + manifest + "/segments", json=command)
    assert retry.status_code == 200, retry.text
    assert retry.json()["usage"]["fileCount"] == 1


async def test_sql_cannot_forge_missing_deleted_bytes_wrong_owner_or_mutate_source_and_receipt(
    client, admin, source, app
):
    consent = await authorize(client, admin, source)
    manifest, _ = await snapshot(client, consent)
    result, _ = await segment(client, manifest)
    assert result["targetImportCompleted"]
    async with app.state.db.connection() as conn:
        with pytest.raises(psycopg.errors.RaiseException):
            async with conn.transaction():
                await conn.execute(
                    "UPDATE resource_source_consents SET revision=revision+2,state='revoked' WHERE id=%s",
                    (consent,),
                )
        with pytest.raises(psycopg.errors.RaiseException):
            async with conn.transaction():
                await conn.execute(
                    "UPDATE resource_import_records SET raw='{}' WHERE manifest_id=%s", (manifest,)
                )
        with pytest.raises(psycopg.errors.RaiseException):
            async with conn.transaction():
                await conn.execute(
                    "UPDATE resource_import_originals SET projection='{}' WHERE owner_id=%s", (admin,)
                )
        with pytest.raises(psycopg.errors.RaiseException):
            async with conn.transaction():
                await conn.execute("UPDATE resource_files SET deleted_at=NULL WHERE id=%s", (DELETED,))
        with pytest.raises(psycopg.errors.RaiseException):
            async with conn.transaction():
                await conn.execute("UPDATE resource_files SET object_sha256=NULL WHERE id=%s", (READY,))
        with pytest.raises(psycopg.errors.RaiseException):
            async with conn.transaction():
                await conn.execute(
                    "INSERT INTO resource_files(id,owner_id,category,name,kind,mime,size_bytes,sha256,deleted_at) VALUES(%s,%s,'components','forged.bin','other','application/octet-stream',10,%s,clock_timestamp())",
                    ("rlf_" + "e" * 32, admin, "e" * 64),
                )


@pytest.mark.parametrize("fault", ["hardlink", "symlink", "directory", "source_changing_bytes"])
async def test_source_file_unsafe_never_publishes_bytes_or_quota(client, admin, source, app, tmp_path, fault):
    manifest, _ = await snapshot(client, await authorize(client, admin, source))
    path = source.root / hashlib.sha256(OWNER.encode()).hexdigest() / READY
    if fault == "hardlink":
        os.link(path, tmp_path / "second-link")
    elif fault == "symlink":
        path.unlink()
        other = tmp_path / "not-a-resource"
        other.write_bytes(RAW)
        path.symlink_to(other)
    elif fault == "directory":
        path.unlink()
        path.mkdir(mode=0o700)
    else:
        path.write_bytes(b"x" * len(RAW))
    result, _ = await segment(client, manifest)
    assert not result["targetImportCompleted"] and result["usage"]["fileCount"] == 0
    assert (await client.get(R + "/files/" + READY + "/content")).status_code == 404
    async with app.state.db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) n FROM resource_media_objects")).fetchone())[
            "n"
        ] == 0


async def test_invalid_completed_original_is_fenced_unverified_never_replayed_or_made_success(
    client, admin, source, app
):
    await source.execute("UPDATE resource_operations SET result=NULL WHERE request_id=%s", (UPLOAD_ID,))
    manifest, _ = await snapshot(client, await authorize(client, admin, source))
    assert (await client.get(R + "/operations/" + UPLOAD_ID)).status_code == 409
    late = await client.post(
        R + "/files",
        data={"requestId": UPLOAD_ID, "category": "components", "name": "late.txt"},
        files={"file": ("transport.bin", RAW, "text/plain")},
    )
    assert late.status_code == 409
    result, _ = await segment(client, manifest)
    assert not result["targetImportCompleted"]
    evidence = (await client.get(P + "/manifests/" + manifest)).json()
    assert next(r for r in evidence["items"] if r["source_id"] == UPLOAD_ID)["normalized"] is None


async def test_capture_unknown_process_state_is_only_closed_by_explicit_post_and_old_scope_revocation_blocks_apply(
    client, admin, source, app
):
    consent = await authorize(client, admin, source)
    manifest, capture_id = await snapshot(client, consent)
    # A settled source capture close must return the original success unchanged.
    original = (await client.get(P + "/operations/" + capture_id)).json()
    closed = await client.post(P + "/operations/" + capture_id + "/close", json={"expectedKind": "capture"})
    assert closed.json() == original
    # Durable accepted state without a running process, as after a crash.
    unknown = str(uuid4())
    async with app.state.db.connection() as conn:
        await conn.execute(
            "INSERT INTO resource_import_manifests(id,owner_id,consent_id,request_id,fingerprint,consent_revision,platform_instance,state) SELECT %s,%s,%s,%s,%s,2,platform_instance,'capturing' FROM resource_source_consents WHERE id=%s",
            (uuid4(), admin, consent, unknown, "a" * 64, consent),
        )
    assert (await client.get(P + "/operations/" + unknown)).json()["state"] == "pending"
    assert (await client.get(P + "/operations/" + unknown)).json()["state"] == "pending"
    reused = await client.post(
        P + "/authorizations/" + consent + "/consent",
        json={
            "requestId": unknown,
            "revision": 2,
            "password": "Synthetic9Pass",
            "code": "",
            "approve": False,
        },
    )
    assert reused.status_code == 409
    assert (await client.get(P + "/operations/" + unknown)).json()["state"] == "pending"
    closed = await client.post(P + "/operations/" + unknown + "/close", json={"expectedKind": "capture"})
    assert closed.status_code == 200 and closed.json()["reason"] == "explicitly_closed", closed.text
    assert (await client.get(P + "/operations/" + unknown)).json() == closed.json()
    assert (
        await client.post(P + "/operations/" + unknown + "/close", json={"expectedKind": "capture"})
    ).json() == closed.json()
    preview = (await client.post(P + "/manifests/" + manifest + "/preview", json={"revision": 2})).json()
    revoked = await client.post(
        P + "/authorizations/" + consent + "/consent",
        json={
            "requestId": str(uuid4()),
            "revision": 2,
            "password": "Synthetic9Pass",
            "code": "",
            "approve": False,
        },
    )
    assert revoked.status_code == 200, revoked.text
    result = await client.post(
        P + "/manifests/" + manifest + "/segments",
        json={
            "requestId": str(uuid4()),
            "revision": 2,
            "preview": preview["preview"],
            "maxItems": 32,
            "retryBlocked": False,
        },
    )
    assert result.status_code == 409
    # Historical evidence stays readable to its owner, without rereading source.
    assert (await client.get(P + "/manifests/" + manifest)).status_code == 200


async def test_actual_fsync_failure_commits_only_blocked_evidence_then_exact_retry(
    client, admin, source, app, monkeypatch
):
    from alcor_api import resource_media

    manifest, _ = await snapshot(client, await authorize(client, admin, source))
    original = resource_media.os.fsync
    failed = False

    def fsync(descriptor):
        nonlocal failed
        if not failed and stat.S_ISREG(os.fstat(descriptor).st_mode):
            failed = True
            raise OSError("synthetic fsync failure")
        return original(descriptor)

    monkeypatch.setattr(resource_media.os, "fsync", fsync)
    result, _ = await segment(client, manifest)
    assert failed and not result["targetImportCompleted"] and result["usage"]["fileCount"] == 0
    assert any(o["reason"] == "private_storage_not_durable" for o in result["outcomes"])
    async with app.state.db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) n FROM resource_media_objects")).fetchone())[
            "n"
        ] == 0
    monkeypatch.setattr(resource_media.os, "fsync", original)
    recovered, _ = await segment(client, manifest, retry=True)
    assert recovered["targetImportCompleted"]
    assert (await client.get(R + "/files/" + READY + "/content")).content == RAW


async def test_source_schema_change_fails_capture_atomically_and_original_uuid_is_queryable(
    client, admin, source, app
):
    consent = await authorize(client, admin, source)
    await source.execute("ALTER TABLE resource_files ADD COLUMN unknown_private_field text")
    request = str(uuid4())
    result = await client.post(
        P + "/authorizations/" + consent + "/snapshots", json={"requestId": request, "revision": 2}
    )
    assert result.status_code == 200 and result.json()["state"] == "failed", result.text
    assert result.json()["reason"] == "source_resource_schema_changed"
    visible = await client.get(P + "/manifests/" + result.json()["manifestId"])
    assert visible.status_code == 200 and visible.json()["state"] == "failed"
    assert visible.json()["remaining"] == 0
    assert visible.json()["targetImportCompleted"] is False
    assert (await client.get(P + "/operations/" + request)).json() == result.json()
    async with app.state.db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) n FROM resource_import_records")).fetchone())[
            "n"
        ] == 0
        assert (await (await conn.execute("SELECT count(*) n FROM resource_import_originals")).fetchone())[
            "n"
        ] == 0
        assert (await (await conn.execute("SELECT count(*) n FROM resource_files")).fetchone())["n"] == 0


async def test_actual_disconnected_import_json_creates_no_consent_or_receipt(client, admin, app):
    from alcor_api.security import COOKIE

    messages = [
        {"type": "http.request", "body": b'{"requestId":', "more_body": True},
        {"type": "http.disconnect"},
    ]
    sent = []
    never = asyncio.Event()

    async def receive():
        if messages:
            return messages.pop(0)
        await never.wait()

    async def send(message):
        sent.append(message)

    path = P + "/authorizations"
    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.4"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "root_path": "",
        "query_string": b"",
        "server": ("testserver", 80),
        "client": ("127.0.0.1", 12345),
        "headers": [
            (b"host", b"testserver"),
            (b"origin", b"http://testserver"),
            (b"content-type", b"application/json"),
            (b"cookie", f"{COOKIE}={client.cookies[COOKIE]}".encode()),
            (b"x-csrf-token", client.headers["x-csrf-token"].encode()),
        ],
    }
    await asyncio.wait_for(app(scope, receive, send), 5)
    starts = [item for item in sent if item["type"] == "http.response.start"]
    assert starts[0]["status"] == 499
    async with app.state.db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) n FROM resource_source_consents")).fetchone())[
            "n"
        ] == 0
        assert (await (await conn.execute("SELECT count(*) n FROM resource_import_operations")).fetchone())[
            "n"
        ] == 0
