import hashlib
import json
from uuid import uuid4

import httpx
import resource_import_fixtures as source_fixtures
from alcor_api.source_snapshot import canonical
from resource_import_fixtures import (
    CHILD_FOLDER,
    DELETE_ID,
    DELETED,
    DIGEST,
    FAILED_ID,
    OWNER,
    PENDING,
    PENDING_ID,
    RAW,
    READY,
    UPLOAD_ID,
    WHEN,
    authorize,
    claim,
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


async def test_actual_source_folders_original_bytes_deletion_and_uuid_without_financial_writes(
    client, admin, source, app
):
    consent = await authorize(client, admin, source)
    manifest, capture_uuid = await snapshot(client, consent)
    evidence = (await client.get(P + "/manifests/" + manifest)).json()
    assert evidence["manifest"]["metadataComplete"] and not evidence["targetImportCompleted"]
    assert not evidence["manifest"]["filesystemSnapshot"]
    assert not evidence["manifest"]["globalAttachmentsIncluded"]
    assert "MUST-NOT" not in json.dumps(evidence)
    assert "DO-NOT-EXPORT" not in json.dumps(evidence)
    assert str(source.root) not in json.dumps(evidence)
    assert str(source.definition.locator) not in json.dumps(evidence)
    result, command = await segment(client, manifest)
    assert result["targetImportCompleted"], result
    assert result["usage"]["usedBytes"] == len(RAW) and result["usage"]["fileCount"] == 1
    content = await client.get(R + "/files/" + READY + "/content")
    assert content.status_code == 200 and content.content == RAW
    assert (await client.get(R + "/files/" + DELETED)).status_code == 404
    file = (await client.get(R + "/files/" + READY)).json()
    assert file["name"] == "cafe\u0301.bin" and file["folderId"] == CHILD_FOLDER
    assert file["revision"] == 3 and file["sha256"] == DIGEST
    uploaded = (await client.get(R + "/operations/" + UPLOAD_ID)).json()
    assert uploaded["requestId"] == UPLOAD_ID and uploaded["result"]["revision"] == 1
    assert uploaded["result"]["name"] == "original.bin"
    assert uploaded["result"]["downloadPath"] == R + "/files/" + READY + "/content"
    assert uploaded["sourceEvidence"] and uploaded["targetImportCompleted"]
    deletion = (await client.get(R + "/operations/" + DELETE_ID)).json()
    assert deletion["result"]["usedBytes"] == 4321 and deletion["result"]["deletedAt"] == WHEN
    assert (await client.get(R + "/operations/" + FAILED_ID)).json()["state"] == "failed"
    repeated = await client.post(P + "/manifests/" + manifest + "/segments", json=command)
    assert repeated.json() == result
    assert (await client.get(P + "/operations/" + command["requestId"])).json() == result
    assert (await client.get(P + "/operations/" + capture_uuid)).json()["manifestId"] == manifest
    async with app.state.db.connection() as conn:
        rows = await (
            await conn.execute("SELECT id,sha256,object_sha256,deleted_at FROM resource_files ORDER BY id")
        ).fetchall()
        assert rows[0]["object_sha256"] == DIGEST and rows[1]["object_sha256"] is None
        assert rows[1]["deleted_at"] is not None
        assert (await (await conn.execute("SELECT count(*) n FROM resource_media_objects")).fetchone())[
            "n"
        ] == 1
        assert (await (await conn.execute("SELECT count(*) n FROM trade_ledger")).fetchone())["n"] == 0
        assert (await (await conn.execute("SELECT count(*) n FROM cash_ledger_entries")).fetchone())["n"] == 0


async def test_financial_grant_is_not_resource_scope_claim_is_permanent_and_password_required(
    client, admin, source, app
):
    payload = {
        "requestId": str(uuid4()),
        "sourceAlias": source.definition.alias,
        "sourceOwner": OWNER,
        "targetUserId": admin,
    }
    assert (await client.post(P + "/authorizations", json=payload)).status_code == 409
    financial = await claim(client, admin, source)
    assert (await client.get(P + "/authorizations")).json() == {"items": []}
    result = await client.post(P + "/authorizations", json={**payload, "requestId": str(uuid4())})
    assert result.status_code == 200, result.text
    identifier = result.json()["consentId"]
    capture_body = {"requestId": str(uuid4()), "revision": 1}
    assert (
        await client.post(P + "/authorizations/" + identifier + "/snapshots", json=capture_body)
    ).status_code == 409
    approval = {"requestId": str(uuid4()), "revision": 1, "password": "wrong", "code": "", "approve": True}
    assert (
        await client.post(P + "/authorizations/" + identifier + "/consent", json=approval)
    ).status_code == 403
    approval["password"] = "Synthetic9Pass"
    assert (
        await client.post(P + "/authorizations/" + identifier + "/consent", json=approval)
    ).status_code == 200
    # Financial revocation does not remove the permanent claim or silently revoke
    # an independently approved resource scope.
    revoked = await client.post(
        "/api/legacy-financial/authorizations/" + financial + "/consent",
        json={
            "requestId": str(uuid4()),
            "revision": 2,
            "password": "Synthetic9Pass",
            "code": "",
            "approve": False,
        },
    )
    assert revoked.status_code == 200, revoked.text
    manifest, _ = await snapshot(client, identifier)
    assert (await segment(client, manifest))[0]["targetImportCompleted"]
    async with app.state.db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) n FROM legacy_source_owner_claims")).fetchone())[
            "n"
        ] == 1


async def test_original_uuid_fenced_before_copy_and_segment_cas_duplicate_cannot_apply_twice(
    client, admin, source, app
):
    consent = await authorize(client, admin, source)
    manifest, _ = await snapshot(client, consent)
    old = (await client.get(R + "/operations/" + UPLOAD_ID)).json()
    assert old["state"] == "completed" and not old["targetImportCompleted"]
    assert (await client.get(old["result"]["downloadPath"])).status_code == 404
    late = await client.post(
        R + "/files",
        data={"requestId": UPLOAD_ID, "category": "components", "name": "late.txt"},
        files={"file": ("transport.bin", b"duplicate write", "text/plain")},
    )
    assert late.status_code == 409, late.text
    preview = (await client.post(P + "/manifests/" + manifest + "/preview", json={"revision": 2})).json()
    created = await client.post(
        R + "/folders", json={"requestId": str(uuid4()), "category": "components", "name": "new target state"}
    )
    assert created.status_code == 201, created.text
    stale = {
        "requestId": str(uuid4()),
        "revision": 2,
        "preview": preview["preview"],
        "maxItems": 1,
        "retryBlocked": False,
    }
    assert (await client.post(P + "/manifests/" + manifest + "/segments", json=stale)).status_code == 409
    first, command = await segment(client, manifest, 1)
    assert len(first["outcomes"]) == 1
    changed = {**command, "maxItems": 2}
    assert (await client.post(P + "/manifests/" + manifest + "/segments", json=changed)).status_code == 409
    assert (await client.post(P + "/manifests/" + manifest + "/segments", json=command)).json() == first
    final, _ = await segment(client, manifest)
    assert final["targetImportCompleted"]


async def test_missing_original_partial_readonly_get_exact_retry_and_historical_raw(
    client, admin, source, app
):
    consent = await authorize(client, admin, source)
    manifest, _ = await snapshot(client, consent)
    path = source.root / hashlib.sha256(OWNER.encode()).hexdigest() / READY
    path.unlink()
    first, _ = await segment(client, manifest)
    assert not first["targetImportCompleted"]
    assert any(o["reason"] == "source_original_missing_or_unsafe" for o in first["outcomes"])
    before = (await client.get(P + "/manifests/" + manifest)).json()
    assert (await client.get(P + "/manifests/" + manifest)).json() == before
    record = next(r for r in before["items"] if r["kind"] == "file" and r["source_id"] == READY)
    raw = (await client.get(P + "/manifests/" + manifest + "/records/" + str(record["seq"]))).json()
    assert hashlib.sha256(canonical(raw["raw"])).hexdigest() == raw["sha256"] == record["raw_sha256"]
    path.write_bytes(b"x" * len(RAW))
    path.chmod(0o600)
    wrong, _ = await segment(client, manifest, retry=True)
    assert not wrong["targetImportCompleted"] and wrong["usage"]["fileCount"] == 0
    path.write_bytes(RAW)
    path.chmod(0o600)
    recovered, _ = await segment(client, manifest, retry=True)
    assert recovered["targetImportCompleted"]
    assert (await client.get(R + "/files/" + READY + "/content")).content == RAW


async def test_pending_source_original_stays_unknown_get_does_not_settle_explicit_cancel_fences(
    client, admin, source, app
):
    await source.execute(
        "INSERT INTO resource_files(id,user_id,category,folder_id,name,kind,mime,size_bytes,sha256,revision,created_at,state) VALUES(%s,%s,'components','','pending.bin','other','application/octet-stream',%s,%s,1,%s,'uploading')",
        (PENDING, OWNER, len(RAW), DIGEST, WHEN),
    )
    await source.execute(
        "INSERT INTO resource_operations(user_id,request_id,type,file_id,state,result,created_at) VALUES(%s,%s,'upload',%s,'pending',NULL,%s)",
        (OWNER, PENDING_ID, PENDING, WHEN),
    )
    manifest, _ = await snapshot(client, await authorize(client, admin, source))
    original = (await client.get(R + "/operations/" + PENDING_ID)).json()
    assert original["state"] == "pending" and original["result"] is None
    assert (await client.get(R + "/operations/" + PENDING_ID)).json() == original
    first, _ = await segment(client, manifest)
    assert not first["targetImportCompleted"]
    cancel = await client.post(R + "/operations/" + PENDING_ID + "/cancel", json={"expectedKind": "upload"})
    assert cancel.status_code == 200 and cancel.json()["cancelled"], cancel.text
    assert (await client.get(R + "/operations/" + PENDING_ID)).json() == cancel.json()
    after, _ = await segment(client, manifest, retry=True)
    assert not after["targetImportCompleted"] and after["remaining"] == 1
    assert any(o["kind"] == "operation" and o["state"] == "applied" for o in after["outcomes"])
    late = await client.post(
        R + "/files",
        data={"requestId": PENDING_ID, "category": "components", "name": "late.txt"},
        files={"file": ("transport.bin", RAW, "text/plain")},
    )
    assert late.status_code == 409


async def test_same_metadata_snapshot_under_source_edit_and_private_root_not_read_by_get(
    client, admin, source, app
):
    consent = await authorize(client, admin, source)
    modified = False

    async def after_table(table):
        nonlocal modified
        if table == "resource_folders" and not modified:
            modified = True
            await source.execute(
                "UPDATE resource_files SET name='changed-after-snapshot.bin' WHERE id=%s", (READY,)
            )

    app.state.resource_import.after_table = after_table
    manifest, _ = await snapshot(client, consent)
    evidence = (await client.get(P + "/manifests/" + manifest)).json()
    file = next(r for r in evidence["items"] if r["source_id"] == READY)
    assert file["normalized"]["name"] == "cafe\u0301.bin"
    app.state.resource_import.after_table = None
    parked = source.root.with_name("parked-source-resources")
    source.root.rename(parked)
    # Metadata and original receipts are platform reads, never source probes.
    assert (await client.get(P + "/manifests/" + manifest)).json() == evidence
    assert (await client.get(R + "/operations/" + UPLOAD_ID)).json()["state"] == "completed"
    result = await client.post(P + "/manifests/" + manifest + "/preview", json={"revision": 2})
    assert result.status_code in (409, 503)
    assert not source.root.exists()


async def test_cookie_csrf_duplicate_fields_paths_scope_and_other_owner_are_not_source_authority(
    client, admin, source, app, settings
):
    consent = await authorize(client, admin, source)
    manifest, _ = await snapshot(client, consent)
    command = {"requestId": str(uuid4()), "revision": 2, "path": str(source.root)}
    assert (
        await client.post(P + "/authorizations/" + consent + "/snapshots", json=command)
    ).status_code == 422
    assert (await client.get(P + "/manifests/" + manifest + "?after=0&after=0")).status_code == 400
    assert (
        await client.get(P + "/manifests/" + manifest, headers={"authorization": "Bearer ignored"})
    ).status_code == 403
    assert (
        await client.post(
            P + "/manifests/" + manifest + "/preview",
            content='{"revision":2,"revision":2}',
            headers={"content-type": "application/json"},
        )
    ).status_code == 422
    assert (
        await client.post(
            P + "/manifests/" + manifest + "/preview",
            json={"revision": 2},
            headers={"origin": "http://evil.invalid"},
        )
    ).status_code == 403
    assert (
        await client.post(
            P + "/manifests/" + manifest + "/preview", json={"revision": 2}, headers={"x-csrf-token": "bad"}
        )
    ).status_code == 403
    from alcor_api.cli import create_user

    other_id = await create_user(settings, "OtherResourceOwner", "Synthetic9Pass")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
        base_url="http://testserver",
        headers={"origin": "http://testserver"},
    ) as other:
        login = await other.post(
            "/api/session/login", json={"login": "OtherResourceOwner", "password": "Synthetic9Pass"}
        )
        other.headers["x-csrf-token"] = login.json()["csrf"]
        assert (await other.get(P + "/manifests/" + manifest)).status_code == 404
        assert (await other.get(R + "/operations/" + UPLOAD_ID)).status_code == 404
        moved = await client.post(
            P + "/authorizations",
            json={
                "requestId": str(uuid4()),
                "sourceAlias": source.definition.alias,
                "sourceOwner": OWNER,
                "targetUserId": other_id,
            },
        )
        assert moved.status_code == 409
