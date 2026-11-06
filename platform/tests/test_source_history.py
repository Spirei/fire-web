import json
from uuid import uuid4

import httpx
import legacy_import_fixtures as source_fixtures
from alcor_api.cli import create_user

source = source_fixtures.source
settings = source_fixtures.settings
app = source_fixtures.app
client = source_fixtures.client
admin = source_fixtures.admin
claim = source_fixtures.claim
P = "/api/legacy-financial"


async def test_own_manifest_operation_keyset_head_original_download_and_no_financial_write(
    client, admin, source, app
):
    grant = await claim(client, admin, source)
    first = await client.get(P + "/manifests?limit=1")
    assert first.status_code == 200, first.text
    assert len(first.json()["items"]) == 1
    old = first.json()["items"][0]
    assert old["confirmedFinancialReceipts"] == 0 and old["isHead"]
    head = first.json()["head"]["manifestSha256"]
    for _ in range(2):
        result = await client.post(
            P + "/authorizations/" + grant + "/snapshots",
            json={"requestId": str(uuid4()), "grantRevision": 2, "predecessorHash": head},
        )
        assert result.status_code == 200 and result.json()["state"] == "completed", result.text
        head = result.json()["manifestSha256"]
    newest = (await client.get(P + "/manifests?limit=1")).json()
    assert newest["head"]["manifestSha256"] == head and newest["items"][0]["isHead"]
    second = (await client.get(P + "/manifests?limit=1&cursor=" + newest["nextCursor"])).json()
    third = (await client.get(P + "/manifests?limit=1&cursor=" + second["nextCursor"])).json()
    assert third["items"][0]["id"] == old["id"] and not third["nextCursor"]
    assert third["head"] == newest["head"] and not third["items"][0]["isHead"]
    assert len({p["items"][0]["id"] for p in (newest, second, third)}) == 3
    raw = await client.get(P + "/manifests/" + old["id"] + "/raw")
    assert raw.status_code == 200 and raw.headers["etag"] == '"' + old["rawSha256"] + '"'
    assert int(raw.headers["content-length"]) == len(raw.content)
    assert "MUST-NOT-EXPORT" not in raw.text
    assert str(source.root) not in json.dumps(newest)
    operations = (await client.get(P + "/operations?limit=2")).json()
    assert len(operations["items"]) == 2 and operations["nextCursor"]
    following = (await client.get(P + "/operations?limit=2&cursor=" + operations["nextCursor"])).json()
    assert not {r["requestId"] for r in operations["items"]} & {r["requestId"] for r in following["items"]}
    assert all(r["result"].get("financialApplied") is False for r in operations["items"])
    async with app.state.db.connection() as conn:
        before = await (
            await conn.execute(
                "SELECT (SELECT count(*) FROM legacy_source_operations) operations,(SELECT count(*) FROM legacy_source_manifests) manifests,(SELECT count(*) FROM trade_ledger) trades,(SELECT count(*) FROM cash_ledger_entries) cash,(SELECT count(*) FROM audit_events) audits"
            )
        ).fetchone()
    for _ in range(2):
        assert (await client.get(P + "/manifests")).status_code == 200
        assert (await client.get(P + "/operations")).status_code == 200
        assert (await client.get(P + "/registration-options")).status_code == 200
    async with app.state.db.connection() as conn:
        after = await (
            await conn.execute(
                "SELECT (SELECT count(*) FROM legacy_source_operations) operations,(SELECT count(*) FROM legacy_source_manifests) manifests,(SELECT count(*) FROM trade_ledger) trades,(SELECT count(*) FROM cash_ledger_entries) cash,(SELECT count(*) FROM audit_events) audits"
            )
        ).fetchone()
    assert before == after and after["trades"] == after["cash"] == 0


async def test_private_registration_options_owner_boundary_and_cursor_cannot_expose_other_evidence(
    client, admin, source, app, settings
):
    await claim(client, admin, source)
    manifest = (await client.get(P + "/manifests")).json()["items"][0]
    operation = (await client.get(P + "/operations")).json()["items"][0]
    options = await client.get(P + "/registration-options")
    assert options.status_code == 200 and options.json()["items"][0]["owners"] == [source_fixtures.OWNER]
    assert all(word not in options.text for word in ("locator", "root", "password", str(source.root)))
    await create_user(settings, "SourceHistoryUser", "Synthetic9Pass", role="user")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
        base_url="http://testserver",
        headers={"origin": "http://testserver"},
    ) as other:
        login = await other.post(
            "/api/session/login", json={"login": "SourceHistoryUser", "password": "Synthetic9Pass"}
        )
        other.headers["x-csrf-token"] = login.json()["csrf"]
        assert (await other.get(P + "/registration-options")).status_code == 403
        assert (await other.get(P + "/manifests")).json()["items"] == []
        assert (await other.get(P + "/operations")).json()["items"] == []
        assert (await other.get(P + "/manifests?cursor=" + manifest["id"])).status_code == 400
        assert (await other.get(P + "/operations?cursor=" + operation["requestId"])).status_code == 400
        assert (await other.get(P + "/manifests/" + manifest["id"] + "/raw")).status_code == 404
    for query in (
        "?limit=0",
        "?limit=51",
        "?limit=1&limit=2",
        "?cursor=../../private",
        "?path=/private",
        "?limit=01&cursor=" + str(uuid4()),
    ):
        assert (await client.get(P + "/manifests" + query)).status_code == 400
    assert (
        await client.get(P + "/manifests", headers={"authorization": "Bearer must-not-fallback-to-cookie"})
    ).status_code == 403
    assert (await client.get(P + "/operations", headers={"x-csrf-token": "stale"})).status_code == 403


async def test_history_survives_revocation_and_source_absence_without_probe_or_false_connection_label(
    client, admin, source, app
):
    grant = await claim(client, admin, source)
    before = (await client.get(P + "/manifests")).json()
    source.root.rename(source.root.with_name("offline-root"))
    app.state.source_authority.registry.clear()
    assert (await client.get(P + "/manifests")).json() == before
    assert (await client.get(P + "/registration-options")).json() == {"items": []}
    own = (await client.get(P + "/authorizations")).json()
    assert own["items"][0]["effectiveState"] == "source_registry_unavailable_or_changed"
    assert not source.root.exists()
    revoke = await client.post(
        P + "/authorizations/" + grant + "/consent",
        json={
            "requestId": str(uuid4()),
            "revision": 2,
            "password": "Synthetic9Pass",
            "code": "",
            "approve": False,
        },
    )
    assert revoke.status_code == 200
    assert (await client.get(P + "/manifests")).json() == before
