import asyncio
from uuid import uuid4

import httpx
import legacy_import_fixtures as fixtures
import pytest
from alcor_api.cli import create_user

source = fixtures.source
settings = fixtures.settings
app = fixtures.app
client = fixtures.client
admin = fixtures.admin
P = "/api/resource-import"


async def test_resource_claim_consent_capture_preview_one_segment_original_uuid_and_exact_retry(
    client, admin, source, app
):
    initial = (await client.get(P + "/registration-options")).json()
    assert initial["items"][0]["scope"] == "resources.migrate"
    assert initial["items"][0]["owners"] == []
    await fixtures.claim(client, admin, source)
    assert (await client.get(P + "/authorizations")).json()["items"] == []
    choices = (await client.get(P + "/registration-options")).json()["items"][0]
    assert choices["owners"][0]["targetUserId"] == admin
    assert str(source.root) not in str(choices) and "locator" not in str(choices)
    consent = await fixtures.authorize(client, admin, source, established=True)
    manifest, capture_id = await fixtures.snapshot(client, consent)
    before = (await client.get(P + "/manifests?limit=1")).json()["items"][0]
    assert before["state"] == "sealed" and before["remaining"] > 0 and not before["targetImportCompleted"]
    assert before["manifest"]["metadataComplete"] and before["manifest"]["rawBytes"] > 0
    result, command = await fixtures.segment(client, manifest, max_items=1)
    assert result["state"] == "completed" and not result["targetImportCompleted"]
    assert len(result["outcomes"]) == 1 and result["usage"]["fileCount"] == 0
    assert (await client.get(P + "/operations/" + command["requestId"])).json() == result
    assert (await client.post(P + "/manifests/" + manifest + "/segments", json=command)).json() == result
    after = (await client.get(P + "/manifests")).json()["items"][0]
    assert after["remaining"] == before["remaining"] - 1
    operations = (await client.get(P + "/operations?limit=1")).json()
    assert operations["nextCursor"]
    next_page = (await client.get(P + "/operations?limit=1&cursor=" + operations["nextCursor"])).json()
    assert next_page["items"][0]["requestId"] != operations["items"][0]["requestId"]
    original = (await client.get(P + "/operations/" + capture_id)).json()
    closed = await client.post(P + "/operations/" + capture_id + "/close", json={"expectedKind": "capture"})
    assert closed.json() == original  # Never report cancellation or undo a sealed capture.
    final, retry = await fixtures.segment(client, manifest, retry=True)
    assert retry["retryBlocked"] and final["targetImportCompleted"]


async def test_real_interrupted_capture_history_pending_close_and_no_empty_complete_projection(
    client, admin, source, app
):
    consent = await fixtures.authorize(client, admin, source)
    entered = asyncio.Event()
    hold = asyncio.Event()

    async def pause(table):
        if table == "resource_folders":
            entered.set()
            await hold.wait()

    app.state.resource_import.after_table = pause
    request = str(uuid4())
    task = asyncio.create_task(
        client.post(
            P + "/authorizations/" + consent + "/snapshots", json={"requestId": request, "revision": 2}
        )
    )
    try:
        await asyncio.wait_for(entered.wait(), 5)
        history = (await client.get(P + "/operations")).json()["items"]
        pending = next(o["result"] for o in history if o["requestId"] == request)
        assert pending["state"] == "pending"
        item = (await client.get(P + "/manifests")).json()["items"][0]
        assert item["state"] == "capturing" and item["remaining"] == 0 and not item["targetImportCompleted"]
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    finally:
        hold.set()
        if not task.done():
            task.cancel()
    app.state.resource_import.after_table = None
    original = await client.get(P + "/operations/" + request)
    assert original.status_code == 200 and original.json()["state"] == "pending"
    close = await client.post(P + "/operations/" + request + "/close", json={"expectedKind": "capture"})
    assert close.status_code == 200 and close.json()["reason"] == "explicitly_closed", close.text
    failed = (await client.get(P + "/manifests")).json()["items"][0]
    assert failed["state"] == "failed" and failed["remaining"] == 0 and not failed["targetImportCompleted"]


async def test_read_history_owner_cursor_cookie_scope_and_source_offline_do_not_write_or_probe(
    client, admin, source, app, settings
):
    consent = await fixtures.authorize(client, admin, source)
    manifest, request = await fixtures.snapshot(client, consent)
    before = (await client.get(P + "/manifests")).json()
    source.root.rename(source.root.with_name("offline-resource-root"))
    assert (await client.get(P + "/manifests")).json() == before
    assert (await client.get(P + "/registration-options")).status_code == 200
    await create_user(settings, "OtherResourceImport", "Synthetic9Pass", role="user")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
        base_url="http://testserver",
        headers={"origin": "http://testserver"},
    ) as other:
        login = await other.post(
            "/api/session/login", json={"login": "OtherResourceImport", "password": "Synthetic9Pass"}
        )
        other.headers["x-csrf-token"] = login.json()["csrf"]
        assert (await other.get(P + "/manifests")).json()["items"] == []
        assert (await other.get(P + "/operations")).json()["items"] == []
        assert (await other.get(P + "/registration-options")).status_code == 403
        assert (await other.get(P + "/manifests?cursor=" + manifest)).status_code == 400
        assert (await other.get(P + "/operations?cursor=" + request)).status_code == 400
    for path in (
        "/manifests?limit=1&limit=2",
        "/operations?path=/private",
        "/registration-options?path=/private",
    ):
        assert (await client.get(P + path)).status_code == 400
    assert (
        await client.get(P + "/manifests", headers={"authorization": "Bearer invalid"})
    ).status_code == 403
    async with app.state.db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) n FROM resource_files")).fetchone())["n"] == 0
        assert (await (await conn.execute("SELECT count(*) n FROM trade_ledger")).fetchone())["n"] == 0
