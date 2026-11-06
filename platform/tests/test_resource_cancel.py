"""Explicit original-UUID fences through actual routes, PG locks and original receipts."""

import asyncio
import hashlib
from uuid import uuid4

import httpx
import pytest
from alcor_api.cli import create_user
from resource_test_support import resource_files  # noqa:F401 -- private storage fixture
from test_legacy_devices import bearer, grant, register

P = "/api/resource-library"


async def web(client, db, name="CancelOwner"):
    uid = await register(client, name)
    signed = await client.post(
        "/api/session/login", json={"login": name, "password": "SyntheticDevicePassword9"}
    )
    assert signed.status_code == 200, signed.text
    client.headers["x-csrf-token"] = signed.json()["csrf"]
    pair = await grant(db, uid, "portfolio.read resources.read resources.write")
    read = await grant(db, uid, "portfolio.read resources.read")
    return uid, pair, read


async def upload(client, rid=None, base=P, headers=None):
    return await client.post(
        base + "/files",
        headers=headers,
        data={"requestId": rid or str(uuid4()), "category": "components", "name": "original.txt"},
        files={"file": ("transport.bin", b"cancel original\r\n", "text/plain")},
    )


async def folder(client):
    response = await client.post(
        P + "/folders", json={"requestId": str(uuid4()), "category": "components", "name": "folder"}
    )
    assert response.status_code == 201, response.text
    return response.json()["result"]


@pytest.mark.parametrize(
    "kind", ["upload", "delete", "folder_create", "folder_delete", "folder_update", "file_update"]
)
async def test_cancel_unseen_uuid_repeated_get_and_late_original_cannot_commit(client, db, settings, kind):
    uid, _pair, _read = await web(client, db)
    rid = str(uuid4())
    assert (await client.get(P + "/operations/" + rid)).status_code == 404
    cancelled = await client.post(P + "/operations/" + rid + "/cancel", json={"expectedKind": kind})
    assert cancelled.status_code == 200, cancelled.text
    expected = cancelled.json()
    assert expected == {
        "requestId": rid,
        "kind": kind,
        "state": "failed",
        "fileId": "",
        "result": None,
        "code": 40901,
        "message": "原操作已取消",
        "cancelled": True,
    }
    assert not settings.file_root.exists()
    assert (
        await client.post(P + "/operations/" + rid + "/cancel", json={"expectedKind": kind})
    ).json() == expected
    for _ in range(2):
        assert (await client.get(P + "/operations/" + rid)).json() == expected
    if kind == "upload":
        late = await upload(client, rid)
    elif kind == "folder_create":
        late = await client.post(
            P + "/folders", json={"requestId": rid, "category": "components", "name": "late"}
        )
    else:
        target = "rld_" + uuid4().hex if kind.startswith("folder_") else "rlf_" + uuid4().hex
        method = "DELETE" if kind in ("delete", "folder_delete") else "PATCH"
        late = await client.request(
            method,
            P + ("/folders/" if kind.startswith("folder_") else "/files/") + target,
            json={"requestId": rid, "revision": 1, **({"name": "late"} if method == "PATCH" else {})},
        )
    assert late.status_code == 409, late.text
    assert (await client.get(P + "/operations/" + rid)).json() == expected
    async with db.connection() as conn:
        assert (
            await (
                await conn.execute(
                    "SELECT count(*) AS n FROM resource_operation_receipts WHERE owner_id=%s", (uid,)
                )
            ).fetchone()
        )["n"] == 1
        assert (
            await (
                await conn.execute(
                    "SELECT count(*) AS n FROM audit_events WHERE actor_id=%s AND action='resource.operation.cancelled'",
                    (uid,),
                )
            ).fetchone()
        )["n"] == 1
        for table in ("resource_files", "resource_folders", "resource_media_objects"):
            assert (
                await (
                    await conn.execute("SELECT count(*) AS n FROM " + table + " WHERE owner_id=%s", (uid,))
                ).fetchone()
            )["n"] == 0
    assert not settings.file_root.exists()


async def test_completed_upload_cancel_returns_original_receipt_and_never_deletes_bytes(client, db):
    uid, _pair, _read = await web(client, db)
    rid = str(uuid4())
    response = await upload(client, rid)
    assert response.status_code == 201, response.text
    original = response.json()
    file = original["result"]
    cancelled = await client.post(P + "/operations/" + rid + "/cancel", json={"expectedKind": "upload"})
    assert cancelled.status_code == 200 and cancelled.json() == original
    assert (await client.get(file["downloadPath"])).content == b"cancel original\r\n"
    wrong = await client.post(P + "/operations/" + rid + "/cancel", json={"expectedKind": "delete"})
    assert wrong.status_code == 409
    assert (await client.get(P + "/operations/" + rid)).json() == original
    async with db.connection() as conn:
        assert not await (
            await conn.execute(
                "SELECT 1 FROM audit_events WHERE actor_id=%s AND action='resource.operation.cancelled'",
                (uid,),
            )
        ).fetchone()
    assert (await client.get(P)).json()["usage"]["fileCount"] == 1


async def test_cancel_while_multipart_is_still_receiving_blocks_late_body_with_single_pool(
    settings, tmp_path
):
    from alcor_api.main import create_app

    settings.pool_size = 1
    settings.pool_min_size = 0
    settings.file_root = tmp_path / "cold-one-pool-files"
    app = create_app(settings)
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
            base_url="http://testserver",
            headers={"origin": "http://testserver"},
        ) as client,
    ):
        _uid, _pair, _read = await web(client, app.state.db)
        assert app.state.db.pool.max_size == 1 and app.state.db.pool.get_stats()["pool_size"] <= 1
        rid = str(uuid4())
        receiving = asyncio.Event()
        release = asyncio.Event()
        request = client.build_request(
            "POST",
            P + "/files",
            data={"requestId": rid, "category": "components", "name": "late.txt"},
            files={"file": ("transport.bin", b"late original", "text/plain")},
        )
        raw = request.read()

        class Delayed(httpx.AsyncByteStream):
            async def __aiter__(self):
                yield raw[:100]
                receiving.set()
                await release.wait()
                yield raw[100:]

        request.stream = Delayed()
        pending = asyncio.create_task(client.send(request))
        await asyncio.wait_for(receiving.wait(), 2)
        assert (await client.get(P + "/operations/" + rid)).status_code == 404
        cancelled = await asyncio.wait_for(
            client.post(P + "/operations/" + rid + "/cancel", json={"expectedKind": "upload"}), 2
        )
        assert cancelled.status_code == 200 and cancelled.json()["cancelled"] is True
        assert not pending.done() and not settings.file_root.exists()
        release.set()
        late = await asyncio.wait_for(pending, 2)
        assert late.status_code == 409, late.text
        assert (await client.get(P)).json()["usage"]["fileCount"] == 0
        assert not settings.file_root.exists()


async def test_interrupted_multipart_404_is_explicitly_closed_not_implicitly_replayed(client, db, settings):
    _uid, _pair, _read = await web(client, db)
    rid = str(uuid4())
    request = client.build_request(
        "POST",
        P + "/files",
        data={"requestId": rid, "category": "components", "name": "broken.txt"},
        files={"file": ("transport.bin", b"synthetic", "text/plain")},
    )
    raw = request.read()

    class Interrupted(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield raw[:100]
            raise httpx.ReadError("synthetic upload interruption")

    request.stream = Interrupted()
    try:
        response = await client.send(request)
    except httpx.ReadError:
        response = None
    assert response is None or response.status_code >= 500
    assert (await client.get(P + "/operations/" + rid)).status_code == 404
    assert (await client.post(P + "/operations/" + rid + "/cancel", json={"expectedKind": "upload"})).json()[
        "cancelled"
    ] is True
    assert (await upload(client, rid)).status_code == 409
    assert not settings.file_root.exists()


@pytest.mark.parametrize("rollback", [False, True])
async def test_original_fsync_before_commit_cancel_waits_then_preserves_exact_winner(
    client, db, settings, rollback
):
    uid, _pair, _read = await web(client, db)
    rid = str(uuid4())
    barrier = 71973461
    async with db.connection() as conn:
        await conn.execute(
            """CREATE FUNCTION delay_original_upload() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
            IF NEW.action='resource.upload' THEN PERFORM pg_advisory_xact_lock(71973461);"""
            + (" RAISE EXCEPTION 'synthetic rollback';" if rollback else "")
            + """ END IF; RETURN NEW; END $$"""
        )
        await conn.execute(
            "CREATE TRIGGER delay_original_upload BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION delay_original_upload()"
        )
    async with db.connection() as blocker, blocker.transaction():
        await blocker.execute("SELECT pg_advisory_xact_lock(%s)", (barrier,))
        original = asyncio.create_task(upload(client, rid))
        blocked = False
        for _ in range(100):
            async with db.connection() as conn:
                row = await (
                    await conn.execute(
                        "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'INSERT INTO audit_events%%' AND pid<>pg_backend_pid() LIMIT 1"
                    )
                ).fetchone()
            if row:
                blocked = True
                break
            await asyncio.sleep(0.01)
        assert blocked and not original.done()
        paths = list((settings.file_root / "resource-media").iterdir())
        assert len(paths) == 1 and paths[0].read_bytes() == b"cancel original\r\n"
        cancellation = asyncio.create_task(
            client.post(P + "/operations/" + rid + "/cancel", json={"expectedKind": "upload"})
        )
        await asyncio.sleep(0.04)
        assert not cancellation.done()
    original_result, cancelled = await asyncio.gather(original, cancellation)
    assert cancelled.status_code == 200, cancelled.text
    receipt = cancelled.json()
    if rollback:
        assert original_result.status_code == 503 and receipt["cancelled"] is True
        assert (await client.get(P)).json()["usage"]["fileCount"] == 0
        async with db.connection() as conn:
            assert not await (
                await conn.execute("SELECT 1 FROM resource_media_objects WHERE owner_id=%s", (uid,))
            ).fetchone()
    else:
        assert original_result.status_code == 201 and receipt == original_result.json()
        assert (await client.get(receipt["result"]["downloadPath"])).content == b"cancel original\r\n"
        assert (await client.get(P)).json()["usage"]["fileCount"] == 1
    assert (await client.get(P + "/operations/" + rid)).json() == receipt
    assert hashlib.sha256(paths[0].read_bytes()).hexdigest() == paths[0].name


async def test_cancel_audit_failure_is_atomic_and_cannot_pretend_to_fence_original(client, db):
    _uid, _pair, _read = await web(client, db)
    rid = str(uuid4())
    async with db.connection() as conn:
        await conn.execute(
            "CREATE FUNCTION reject_cancel_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='resource.operation.cancelled' THEN RAISE EXCEPTION 'synthetic'; END IF; RETURN NEW; END $$"
        )
        await conn.execute(
            "CREATE TRIGGER reject_cancel_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_cancel_audit()"
        )
    response = await client.post(P + "/operations/" + rid + "/cancel", json={"expectedKind": "upload"})
    assert response.status_code == 503
    assert (await client.get(P + "/operations/" + rid)).status_code == 404
    async with db.connection() as conn:
        await conn.execute("DROP TRIGGER reject_cancel_audit ON audit_events")
    assert (await upload(client, rid)).status_code == 201


async def test_owner_scope_csrf_strict_shape_legacy_paths_and_get_never_write(client, db, settings):
    _uid, pair, read = await web(client, db)
    rid = str(uuid4())
    path = P + "/operations/" + rid + "/cancel"
    for body in [
        {},
        {"expectedKind": "fee_plan"},
        {"expectedKind": None},
        {"expectedKind": []},
        {"expectedKind": "upload", "requestId": rid},
    ]:
        assert (await client.post(path, json=body)).status_code == 400
    assert (await client.post(path + "?unexpected=1", json={"expectedKind": "upload"})).status_code == 400
    assert (
        await client.post(
            path,
            content='{"expectedKind":"upload","expectedKind":"delete"}',
            headers={"content-type": "application/json"},
        )
    ).status_code == 400
    assert (
        await client.post(path, content="x" * 4097, headers={"content-type": "application/json"})
    ).status_code == 413
    assert (
        await client.post(path, json={"expectedKind": "upload"}, headers={"x-csrf-token": "wrong"})
    ).status_code == 403
    assert (
        await client.post(path, json={"expectedKind": "upload"}, headers={"origin": "https://other.invalid"})
    ).status_code == 403
    assert (await client.post(path, json={"expectedKind": "upload"}, headers=bearer(pair))).status_code == 403
    assert (await client.get(path)).status_code == 404
    for version in [1, 2]:
        assert (
            await client.post(
                f"/api/v{version}/resource-library/operations/{rid}/cancel",
                json={"expectedKind": "upload"},
                headers=bearer(pair),
            )
        ).status_code == 404
    native = "/api/client/resource-library/operations/" + rid + "/cancel"
    assert (await client.post(native, json={"expectedKind": "upload"})).status_code == 401
    assert (
        await client.post(native, json={"expectedKind": "upload"}, headers=bearer(read))
    ).status_code == 403
    assert (await client.get(P + "/operations/" + rid)).status_code == 404
    assert not settings.file_root.exists()
    other = await create_user(settings, "OtherCanceller", "Synthetic9Pass", role="user")
    other_pair = await grant(db, other, "portfolio.read resources.read resources.write")
    theirs = await client.post(native, json={"expectedKind": "upload"}, headers=bearer(other_pair))
    assert theirs.status_code == 200 and theirs.json()["cancelled"]
    assert (await client.get(P + "/operations/" + rid)).status_code == 404
    assert (await upload(client, rid)).status_code == 201
    assert (
        await client.get("/api/client/resource-library/operations/" + rid, headers=bearer(other_pair))
    ).json() == theirs.json()
    assert (await client.post(native, json={"expectedKind": "upload"}, headers=bearer(pair))).json()[
        "state"
    ] == "completed"


async def test_native_grant_revoked_while_cancel_body_arrives_writes_no_tombstone(client, db, settings):
    _uid, pair, _read = await web(client, db)
    rid = str(uuid4())
    base = "/api/client/resource-library"
    request = client.build_request(
        "POST", base + "/operations/" + rid + "/cancel", json={"expectedKind": "upload"}, headers=bearer(pair)
    )
    raw = request.read()

    class Revoked(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield raw[:5]
            async with db.connection() as conn:
                await conn.execute(
                    "UPDATE identity_app_grants SET revoked_at=clock_timestamp() WHERE id=%s",
                    (pair["grant_id"],),
                )
            yield raw[5:]

    request.stream = Revoked()
    assert (await client.send(request)).status_code == 401
    assert (await client.get(P + "/operations/" + rid)).status_code == 404
    assert not settings.file_root.exists()
