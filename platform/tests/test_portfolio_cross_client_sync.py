"""Actual Web/App HTTP contracts share committed PG data and change watermarks.

All accounts, grants and writes use the identity-checked private PG fixtures.
This verifies wire protocols, not an installed App or production data migration.
"""

import json
from uuid import uuid4

import httpx
import pytest

from alcor_api.native_app_auth import issue_grant


async def native_headers(db, owner):
    async with db.connection() as conn:
        user = await (await conn.execute("SELECT * FROM users WHERE id=%s", (owner,))).fetchone()
        pair = await issue_grant(conn, user, "portfolio.read portfolio.write", "Synthetic cross-client reader")
    return {"authorization": "Bearer " + pair["access_token"]}


async def signals(client, headers=None):
    path = "/api/v2/account-sync" if headers else "/api/account/changes"
    response = await client.get(path, headers=headers)
    assert response.status_code == 200, response.text
    return response.json()["data"] if headers else response.json()


async def second_session(app):
    peer = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
        base_url="http://testserver",
        headers={"origin": "http://testserver"},
    )
    login = await peer.post("/api/session/login", json={"login": "AdminOne", "password": "Synthetic9Pass"})
    assert login.status_code == 200, login.text
    peer.headers["x-csrf-token"] = login.json()["csrf"]
    return peer


async def account(client):
    data = {"request_id": str(uuid4()), "name": "Synthetic account", "provider_id": "ibkr",
            "account_kind": "real", "currency": "USD", "currencies": ["USD", "HKD"]}
    body = await metadata_preview(client, "create", "", data)
    created = await client.post("/api/account/broker-metadata/operations", json=body)
    assert created.status_code == 200 and created.json()["state"] == "completed", created.text
    return body, created.json()["data"]


async def metadata_preview(client, kind, identifier, data):
    state = await client.get("/api/account/broker-metadata")
    assert state.status_code == 200, state.text
    command = {"kind": kind, "accountId": identifier, "data": data,
               "expectedCollectionRevision": state.json()["collectionRevision"],
               "expectedRecordCollectionRevision": state.json()["recordCollectionRevision"]}
    preview = await client.post("/api/account/broker-metadata/preview", json=command)
    assert preview.status_code == 200, preview.text
    return {"previewId": preview.json()["previewId"], "command": command}


@pytest.mark.parametrize("version", [1, 2])
async def test_web_account_create_app_edit_and_other_web_session_share_one_authority(client, admin, db, app, version):
    headers = await native_headers(db, admin)
    native_path = f"/api/v{version}/broker-accounts"
    before = await signals(client)
    native_before = await signals(client, headers)
    assert native_before["revisions"] == before["revisions"]
    body, created = await account(client)
    peer = await second_session(app)
    try:
        web_signal, app_signal = await signals(peer), await signals(client, headers)
        assert web_signal["revisions"]["brokers"] > before["revisions"]["brokers"]
        assert web_signal["revisions"] == app_signal["revisions"]
        # Different Web sessions have distinct credential contexts, the same data owner.
        assert web_signal["context"] != before["context"]
        assert web_signal["userId"] == app_signal["userId"] == admin
        native = await client.get(native_path, headers=headers)
        assert native.status_code == 200, native.text
        item = native.json()["data"]["items"][0]
        assert (item["id"], item["name"], item["accountKind"], item["currencies"]) == (
            created["id"], created["name"], "real", ["USD", "HKD"])
        assert item["holdingSource"] == "manual" and item["recordCount"] == 0
        stale = await metadata_preview(peer, "update", item["id"], {
            "request_id": str(uuid4()), "revision": created["revision"],
            "name": "Stale Web edit", "currency": "USD", "currencies": ["USD", "HKD"]})
        update = {"requestId": str(uuid4()), "revision": item["revision"],
                  "name": "Edited in App", "currency": "HKD",
                  "recordCollectionRevision": item["currencyUsage"]["recordCollectionRevision"]}
        changed = await client.put(native_path + "/" + item["id"], json=update, headers=headers)
        assert changed.status_code == 200, changed.text
        immutable = (await client.get(native_path + "/operations/" + update["requestId"], headers=headers)).json()
        fresh = await peer.get("/api/broker-accounts/" + item["id"])
        assert fresh.status_code == 200, fresh.text
        assert fresh.json()["name"] == "Edited in App" and fresh.json()["currency"] == "HKD"
        assert fresh.json()["currencies"] == ["USD", "HKD"]
        final_signal = await signals(peer)
        assert final_signal["revisions"] == (await signals(client, headers))["revisions"]
        # A stale second-session edit cannot overwrite the App's newer name/currency.
        rejected = await peer.post("/api/account/broker-metadata/operations", json=stale)
        assert rejected.status_code == 409, rejected.text
        assert (await client.post("/api/account/broker-metadata/operations", json=body)).status_code == 200
        replay = await client.put(native_path + "/" + item["id"], json=update, headers=headers)
        assert replay.json() == changed.json()
        assert (await signals(peer))["revisions"] == final_signal["revisions"]
        assert (await client.get(native_path + "/operations/" + update["requestId"], headers=headers)).json() == immutable
        assert (await peer.get("/api/broker-accounts/" + item["id"])).json()["name"] == "Edited in App"
    finally:
        await peer.aclose()


@pytest.mark.parametrize("version", [1, 2])
async def test_record_preview_app_edit_watch_change_and_stale_preview_do_not_split_data(client, admin, db, app, version):
    headers = await native_headers(db, admin)
    native_path = f"/api/v{version}/records"
    _, broker = await account(client)
    peer = await second_session(app)
    try:
        before = await signals(peer)
        fields = {"name": "Synthetic security", "code": "SYN", "market": "US", "qty": "0",
                  "cost": "0", "price": None, "group": broker["name"], "note": "Web note",
                  "brokerAccountId": broker["id"]}
        preview = await client.post("/api/portfolio/records/preview", json={"kind": "create", "data": fields})
        assert preview.status_code == 200, preview.text
        # Merely opening/reading a preview cannot publish a business change.
        assert (await signals(peer))["revisions"] == before["revisions"]
        original = str(uuid4())
        commit = await client.post("/api/portfolio/records/confirm", json={"requestId": original, "previewId": preview.json()["previewId"]})
        assert commit.status_code == 200, commit.text
        created = commit.json()["record"]
        native = await client.get(native_path + "/" + created["id"], headers=headers)
        assert native.status_code == 200, native.text
        app_row = native.json()["data"]
        assert app_row["brokerAccountId"] == broker["id"] and app_row["qty"] == 0 and app_row["cost"] == 0
        assert app_row["price"] == ""  # Missing remains missing in the frozen App wire format.
        committed = await signals(peer)
        assert committed["revisions"]["portfolio"] > before["revisions"]["portfolio"]
        assert committed["revisions"] == (await signals(client, headers))["revisions"]
        stale = await peer.post("/api/portfolio/records/preview", json={"kind": "update", "recordId": created["id"],
                               "revision": created["revision"], "data": {**fields, "note": "Older Web draft"}})
        assert stale.status_code == 200, stale.text
        native_body = {**fields, "qty": 0, "cost": 0, "revision": app_row["revision"],
                       "requestId": str(uuid4()), "note": "App note"}
        changed = await client.put(native_path + "/" + created["id"], json=native_body, headers=headers)
        assert changed.status_code == 200, changed.text
        read = await peer.get("/api/portfolio/records/" + created["id"])
        assert read.status_code == 200, read.text
        assert read.json()["record"]["note"] == "App note" and read.json()["record"]["price"] is None
        refuse = await peer.post("/api/portfolio/records/confirm", json={"requestId": str(uuid4()), "previewId": stale.json()["previewId"]})
        assert refuse.status_code == 409, refuse.text
        field = json.dumps(["hidden", created["id"]], separators=(",", ":"))
        hidden = {"requestId": str(uuid4()), "namespace": "watch", "changes": [{"key": field, "revision": 0, "value": True}]}
        watched = await client.post("/api/v2/app-state", json=hidden, headers=headers)
        assert watched.status_code == 200, watched.text
        filtered = await peer.get("/api/portfolio/records?displayMode=watch")
        assert filtered.status_code == 200 and filtered.json()["records"] == [], filtered.text
        all_rows = await peer.get("/api/portfolio/records?displayMode=all")
        assert all_rows.status_code == 200 and [r["id"] for r in all_rows.json()["records"]] == [created["id"]]
        final = await signals(peer)
        assert final["revisions"]["watch"] > committed["revisions"]["watch"]
        assert final["revisions"] == (await signals(client, headers))["revisions"]
        # Querying the first original UUID after later App changes keeps its immutable snapshot.
        receipt = await client.get(native_path + "/operations/" + original, headers=headers)
        assert receipt.status_code == 200 and receipt.json()["data"]["record"]["note"] == "Web note"
        async with db.connection() as conn:
            assert (await (await conn.execute("SELECT count(*) AS n FROM trade_ledger WHERE owner_id=%s", (admin,))).fetchone())["n"] == 0
            assert (await (await conn.execute("SELECT count(*) AS n FROM cash_ledger_entries WHERE owner_id=%s", (admin,))).fetchone())["n"] == 0
    finally:
        await peer.aclose()
