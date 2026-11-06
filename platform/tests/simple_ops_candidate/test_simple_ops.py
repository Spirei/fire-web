"""Synthetic owner ledger and in-process maintenance; no provider or Redis IO."""

import json
from types import SimpleNamespace
from uuid import uuid4

import httpx

from alcor_api.cli import create_user
from alcor_api.source_registry import load_registry
from alcor_api.source_window import cache_snapshot, clear_instance_cache, current_definition

LEDGER = "/api/account/simple-ledger"
OPS = "/api/admin/system-operations"
FINANCIAL_TABLES = (
    "broker_accounts", "portfolio_records", "cash_ledger_entries", "trade_ledger",
    "internal_orders", "fund_sources", "trade_amendments", "broker_position_transfers",
)


async def financial_counts(db):
    # Names are fixed test-owned schema identifiers, never request data.
    async with db.connection() as conn:
        return {
            table: (await (await conn.execute(f"SELECT count(*) AS n FROM {table}")).fetchone())["n"]
            for table in FINANCIAL_TABLES
        }


async def test_independent_ledger_exact_history_roundtrip_and_stale_cas(client, admin, db):
    before = await financial_counts(db)
    initial = await client.get(LEDGER)
    assert initial.status_code == 200, initial.text
    assert initial.json()["revision"] == 0
    assert initial.json()["scope"] == "independent_personal_ledger"
    assert initial.json()["brokerLedgerLinked"] is False
    original_id = str(uuid4())
    exact = "9007199254740993.1234567890123456789"
    history = [{"d": "2020-01-01", "v": "0"}, {"d": "2020-01-02", "v": exact}]
    ledger = {
        "hide": False, "excludeFixed": False, "displayCur": "USD",
        "fx": {"USD": "1", "CNY": None, "HKD": None},
        "cash": [{"id": "synthetic-cash", "cur": "USD", "amount": "NUMERIC_LEXEME"}],
        "fixed": [], "receivable": [{"id": "synthetic-unknown", "amount": None}], "debt": [],
        "invest": [{"id": "synthetic-invest", "name": "Synthetic", "cur": "USD", "amount": None, "hist": history, "market": None}],
        "cashflow": {"stable": None, "flex": "0", "income": None},
        "snaps": [{"date": "2001-01-01", "values": {"USD": "0", "EUR": None}}],
        "logs": [{"id": "synthetic-history", "text": "original independent declaration"}],
        "members": [{"id": "synthetic-member", "name": "Synthetic"}],
    }
    raw = json.dumps({"requestId": original_id, "expectedRevision": 0, "ledger": ledger}).replace('"NUMERIC_LEXEME"', exact)
    saved = await client.put(LEDGER, content=raw, headers={"content-type": "application/json"})
    assert saved.status_code == 200, saved.text
    first = saved.json()
    assert first["state"] == "completed" and first["revision"] == 1
    assert first["ledger"]["cash"][0]["amount"] == exact
    assert first["ledger"]["invest"][0]["hist"] == history
    assert first["ledger"]["receivable"][0]["amount"] is None
    assert first["ledger"]["cashflow"] == ledger["cashflow"]
    assert first["ledger"]["fx"]["CNY"] is None
    replay = await client.put(LEDGER, content=raw, headers={"content-type": "application/json"})
    assert replay.status_code == 200 and replay.json() == first
    assert (await client.get(LEDGER + "/operations/" + original_id)).json() == first

    stale_id = str(uuid4())
    stale = await client.put(LEDGER, json={"requestId": stale_id, "expectedRevision": 0, "ledger": first["ledger"]})
    assert stale.status_code == 409, stale.text
    assert (await client.get(LEDGER + "/operations/" + stale_id)).status_code == 404
    changed = {**first["ledger"], "hide": True}
    second = await client.put(LEDGER, json={"requestId": str(uuid4()), "expectedRevision": 1, "ledger": changed})
    assert second.status_code == 200, second.text
    read = await client.get(LEDGER)
    assert read.json()["revision"] == 2 and read.json()["ledger"] == changed
    async with db.connection() as conn:
        rows = await (await conn.execute("SELECT revision,value FROM simple_ledger_versions WHERE owner_id=%s ORDER BY revision", (admin,))).fetchall()
    assert len(rows) == 2 and rows[0]["value"] == first["ledger"]
    assert rows[0]["value"]["snaps"] == ledger["snaps"] and rows[0]["value"]["logs"] == ledger["logs"]
    assert await financial_counts(db) == before


async def test_independent_workbook_and_uuid_are_owner_private(client, admin, settings, app, db):
    before = await financial_counts(db)
    identifier = str(uuid4())
    saved = await client.put(LEDGER, json={"requestId": identifier, "expectedRevision": 0, "ledger": {"logs": [{"id": "private-source", "note": "synthetic-private-marker"}]}})
    assert saved.status_code == 200, saved.text
    workbook = await client.post(LEDGER + "/tool/export", json={"invest": [{"name": "Synthetic wallet", "cur": "USD", "bucket": "长期", "hist": [{"d": "2026-01-01", "v": "0"}, {"d": "2026-01-02", "v": "10.000000000000000001"}]}]})
    assert workbook.status_code == 200, workbook.text
    parsed_id = str(uuid4())
    parsed = await client.post(LEDGER + "/tool/import", data={"requestId": parsed_id}, files={"file": ("synthetic.xlsx", workbook.content, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    assert parsed.status_code == 200, parsed.text
    assert parsed.json()["state"] == "parsed" and parsed.json()["applied"] is False
    original = await client.get(LEDGER + "/originals/" + parsed_id)
    assert original.status_code == 200 and original.content == workbook.content
    assert (await client.get(LEDGER + "/operations/" + parsed_id)).json()["sourceSha256"] == parsed.json()["sourceSha256"]
    assert (await client.get(LEDGER)).json()["revision"] == 1

    await create_user(settings, "SimplePeer", "Synthetic9Pass")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app, raise_app_exceptions=False), base_url="http://testserver", headers={"origin": "http://testserver"}) as peer:
        login = await peer.post("/api/session/login", json={"login": "SimplePeer", "password": "Synthetic9Pass"})
        assert login.status_code == 200, login.text
        peer.headers["x-csrf-token"] = login.json()["csrf"]
        for path in ("/operations/" + identifier, "/operations/" + parsed_id, "/originals/" + parsed_id):
            denied = await peer.get(LEDGER + path)
            assert denied.status_code == 404, denied.text
            assert "synthetic-private-marker" not in denied.text
        own = await peer.get(LEDGER)
        assert own.status_code == 200 and own.json()["revision"] == 0
    assert await financial_counts(db) == before


def registered_cache(tmp_path, instance, owner, name):
    directory = tmp_path / name
    directory.mkdir(mode=0o700)
    source = directory / "synthetic.identity"
    source.write_bytes(b"")
    source.chmod(0o600)
    info = source.stat()
    path = directory / "registry.json"
    path.write_text(json.dumps({"version": 2, "platformInstance": str(instance), "sources": [{
        "alias": "synthetic-source", "instance": "synthetic-source-instance", "kind": "postgres", "owners": [owner],
        "timezone": "UTC", "schemaHash": "a" * 64, "locator": "postgresql://readonly@source.example.invalid/ledger", "expectedDatabase": "ledger",
        "expectedDataDirectory": str(directory / "pg"), "expectedRole": "readonly", "expectedFileIdentity": None,
        "expectedDatasetIdentity": None, "migrationWindow": {"notBefore": "2020-01-01T00:00:00+00:00", "expiresAt": "2099-01-01T00:00:00+00:00", "state": "active"},
    }]}))
    path.chmod(0o600)
    definition = load_registry(SimpleNamespace(legacy_source_registry_path=path, instance_id=instance))["synthetic-source"]
    assert current_definition(definition).alias == definition.alias
    return definition


async def test_cache_clear_is_instance_process_cas_scoped_and_durable(client, admin, db, settings, tmp_path):
    instance, other = settings.instance_id, uuid4()
    target = registered_cache(tmp_path, instance, admin, "current")
    registered_cache(tmp_path, other, admin, "other")
    try:
        state = await client.get(OPS)
        assert state.status_code == 200, state.text
        head = state.json()
        assert head["cache"]["entries"] == 1
        assert head["cache"]["workerAffected"] is False and head["cache"]["redisAffected"] is False
        assert head["recovery"]["completeRecoveryVerified"] is None
        assert head["recovery"]["coverage"] == "registered_platform_capsules_and_tasks_only"
        for process, revision in ((str(uuid4()), head["cache"]["revision"]), (head["cache"]["processId"], head["cache"]["revision"] + 1)):
            denied = await client.post(OPS + "/cache/clear", json={"requestId": str(uuid4()), "processId": process, "revision": revision})
            assert denied.status_code == 409, denied.text
        assert cache_snapshot(instance)["entries"] == 1 and cache_snapshot(other)["entries"] == 1
        async with db.connection() as conn:
            assert (await (await conn.execute("SELECT count(*) AS n FROM system_cache_operations")).fetchone())["n"] == 0
        body = {"requestId": str(uuid4()), "processId": head["cache"]["processId"], "revision": head["cache"]["revision"]}
        cleared = await client.post(OPS + "/cache/clear", json=body)
        assert cleared.status_code == 200, cleared.text
        receipt = cleared.json()
        assert receipt["state"] == "completed" and receipt["cache"]["removed"] == 1
        assert receipt["cache"]["entries"] == 0 and cache_snapshot(other)["entries"] == 1
        assert receipt["cache"]["scope"] == "current_api_process_current_instance_registry_parse"
        assert current_definition(target).alias == target.alias
        fresh = cache_snapshot(instance)
        assert fresh["entries"] == 1
        assert (await client.post(OPS + "/cache/clear", json=body)).json() == receipt
        assert cache_snapshot(instance) == fresh
        assert (await client.get(OPS + "/operations/" + body["requestId"])).json() == receipt
        conflict = await client.post(OPS + "/cache/clear", json={**body, "revision": fresh["revision"]})
        assert conflict.status_code == 409 and cache_snapshot(instance) == fresh
        async with db.connection() as conn, conn.transaction():
            await conn.execute("INSERT INTO restore_quarantine(category,payload) VALUES('synthetic-validation-quarantine','{}'::jsonb)")
        recovery = (await client.get(OPS)).json()["recovery"]
        assert recovery["quarantined"] is True and recovery["completeRecoveryVerified"] is None
        assert recovery["state"] == "observed_registration_only"
        async with db.connection() as conn:
            assert (await (await conn.execute("SELECT count(*) AS n FROM system_cache_operations")).fetchone())["n"] == 1
    finally:
        for identifier in (instance, other):
            value = cache_snapshot(identifier)
            clear_instance_cache(identifier, value["processId"], value["revision"])
