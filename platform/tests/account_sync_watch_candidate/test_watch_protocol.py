"""Original TS golden / real FastAPI and private PG; display prefs never post money."""

import asyncio
import hashlib
import json
import os
import subprocess
from pathlib import Path
from uuid import uuid4

import httpx
import pytest
from alcor_api.backups import tables_and_hashes
from alcor_api.cli import create_user
from alcor_api.native_app_auth import issue_grant
from psycopg.errors import CheckViolation
from request_telemetry_tables import REQUEST_TELEMETRY_TABLES

HERE = Path(__file__).parent


async def grants(db, owner, scope="portfolio.read portfolio.write"):
    async with db.connection() as conn:
        user = await (await conn.execute("SELECT * FROM users WHERE id=%s", (owner,))).fetchone()
        return await issue_grant(conn, user, scope, "Synthetic watch client")


def bearer(pair):
    return {"authorization": "Bearer " + pair["access_token"]}


def key(*values):
    return json.dumps(values, separators=(",", ":"), ensure_ascii=False)


def command(field, revision=0, value=True, request=None):
    return {"requestId": request or str(uuid4()), "namespace": "watch", "changes": [{"key": field, "revision": revision, "value": value}]}


async def hashes(db):
    async with db.connection() as conn, conn.transaction():
        return {name:value for name,value in (await tables_and_hashes(conn)).items() if name not in REQUEST_TELEMETRY_TABLES}


async def test_13_real_old_service_actions_match_pg_protocol_exactly(client, admin, db):
    root = os.environ.get("ALCOR_SYNC_LEGACY_ROOT")
    if not root:
        pytest.skip("Explicit read-only source required")
    evidence = json.loads((HERE / "source-evidence.json").read_text())
    for name, expected in evidence["source_sha256"].items():
        assert hashlib.sha256((Path(root) / name).read_bytes()).hexdigest() == expected
    old = json.loads(await asyncio.to_thread(subprocess.check_output, ["node", str(HERE / "run_old_watch.cjs"), root, str(HERE / "watch-golden-actions.json")], text=True))
    assert old["memoryOnly"] is True
    pair = await grants(db, admin)
    actions = json.loads((HERE / "watch-golden-actions.json").read_text())
    for action, expected in zip(actions, old["actions"], strict=True):
        expected = json.loads(json.dumps(expected).replace("synthetic-owner", admin))
        if action["kind"] == "submit":
            response = await client.post("/api/v2/app-state", json=action["body"], headers=bearer(pair))
        elif action["kind"] == "receipt":
            response = await client.get("/api/v2/app-state/operations/" + action["requestId"], headers=bearer(pair))
        else:
            response = await client.get("/api/v2/app-state", params={"namespace": "watch"}, headers=bearer(pair))
        assert response.status_code == expected["status"], response.text
        assert response.json() == expected["body"], (action, response.text, expected)
        assert response.headers["x-alcor-api-version"] == "2"
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) AS n FROM trade_ledger")).fetchone())["n"] == 0
        assert (await (await conn.execute("SELECT count(*) AS n FROM cash_ledger_entries")).fetchone())["n"] == 0
        assert (await (await conn.execute("SELECT count(*) AS n FROM portfolio_records")).fetchone())["n"] == 0


async def test_shared_web_native_authority_original_receipt_and_pure_get(client, admin, db):
    pair = await grants(db, admin)
    payload = command(key("notes", "opaque-symbol"), value="Shared")
    written = await client.post("/api/account/state", json=payload)
    assert written.status_code == 200, written.text
    snapshot = await client.get("/api/v2/app-state?namespace=watch", headers=bearer(pair))
    assert snapshot.json()["data"]["fields"][payload["changes"][0]["key"]]["value"] == "Shared"
    receipt = await client.get("/api/v2/app-state/operations/" + payload["requestId"], headers=bearer(pair))
    assert receipt.json()["data"] == written.json()
    repeat = await client.post("/api/client/account/state", json=payload, headers=bearer(pair))
    assert repeat.json() == written.json()
    before = await hashes(db)
    for path in ("/api/v2/app-state?namespace=watch", "/api/v2/app-state/operations/"+payload["requestId"]):
        assert (await client.get(path, headers=bearer(pair))).status_code == 200
    assert await hashes(db) == before


async def test_parallel_CAS_single_winner_immutable_conflict_and_tombstone(client, admin, db):
    pair = await grants(db, admin)
    field = key("aliases", "US.A")
    first, second = command(field, value="One"), command(field, value="Two")
    a, b = await asyncio.gather(*(client.post("/api/v2/app-state", json=payload, headers=bearer(pair)) for payload in (first, second)))
    assert a.status_code == b.status_code == 200
    assert sorted(response.json()["data"]["state"] for response in (a,b)) == ["completed", "conflict"]
    winner, loser = (first, second) if a.json()["data"]["state"] == "completed" else (second, first)
    conflict = b.json()["data"] if winner is first else a.json()["data"]
    deleted = await client.post("/api/v2/app-state", json=command(field, 1, None), headers=bearer(pair))
    assert deleted.json()["data"]["data"]["fields"][field] == {"revision": 2, "value": None}
    replay = await client.post("/api/v2/app-state", json=loser, headers=bearer(pair))
    assert replay.json()["data"] == conflict
    stale = await client.post("/api/v2/app-state", json=command(field, 0, "Resurrect"), headers=bearer(pair))
    assert stale.json()["data"]["state"] == "conflict"


async def test_receipt_failure_rolls_back_fields_and_change_events(client, admin, db):
    pair = await grants(db, admin)
    before = (await client.get("/api/account/changes")).json()["revisions"]["watch"]
    async with db.connection() as conn:
        await conn.execute("CREATE FUNCTION fail_watch_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic receipt failure'; END $$")
        await conn.execute("CREATE TRIGGER fail_watch_receipt BEFORE INSERT ON watch_display_operations FOR EACH ROW EXECUTE FUNCTION fail_watch_receipt()")
    payload = command(key("pinned", "US.A"))
    result = await client.post("/api/v2/app-state", json=payload, headers=bearer(pair))
    assert result.status_code == 503
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) AS n FROM watch_display_fields")).fetchone())["n"] == 0
        assert (await (await conn.execute("SELECT count(*) AS n FROM watch_display_operations")).fetchone())["n"] == 0
        await conn.execute("DROP TRIGGER fail_watch_receipt ON watch_display_operations")
    assert (await client.get("/api/account/changes")).json()["revisions"]["watch"] == before
    assert (await client.get("/api/v2/app-state/operations/" + payload["requestId"], headers=bearer(pair))).status_code == 404


async def test_scope_owner_expiry_and_no_web_cookie_legacy_fallback(client, admin, db, app, settings):
    read = await grants(db, admin, "portfolio.read")
    assert (await client.get("/api/v2/app-state?namespace=watch")).status_code == 401
    assert (await client.post("/api/v2/app-state", json=command(key("pinned", "US.A")), headers=bearer(read))).status_code == 403
    full = await grants(db, admin)
    payload = command(key("pinned", "US.A"))
    assert (await client.post("/api/v2/app-state", json=payload, headers=bearer(full))).status_code == 200
    other = await create_user(settings, "OtherWatchOwner", "SyntheticOtherWatch9")
    second = await grants(db, other)
    assert (await client.get("/api/v2/app-state/operations/"+payload["requestId"], headers=bearer(second))).status_code == 404
    assert (await client.get("/api/v2/app-state?namespace=watch", headers=bearer(second))).json()["data"]["fields"] == {}
    async with db.connection() as conn:
        await conn.execute("UPDATE identity_app_grants SET expires_at=clock_timestamp()-interval '1 second' WHERE id=%s", (full["grant_id"],))
    expired = await client.get("/api/v2/app-state?namespace=watch", headers=bearer(full))
    assert expired.status_code == 401 and expired.headers["x-alcor-retire-context"] == "true"


async def test_legacy_sync_distinguishes_missing_token_40101_from_unknown_token_40102(client):
    missing = await client.get("/api/v2/account-sync")
    assert missing.status_code == 401 and missing.json() == {"code": 40101, "message": "需要有效的 App 连接"}
    headers = {"authorization": "Bearer fat_" + "a" * 43}
    body = command(key("pinned", "US.A"))
    responses = [
        await client.get("/api/v2/account-sync", headers=headers),
        await client.get("/api/v2/app-state", params={"namespace": "watch"}, headers=headers),
        await client.post("/api/v2/app-state", json=body, headers=headers),
    ]
    assert [response.status_code for response in responses] == [401, 401, 401]
    assert [response.json() for response in responses] == [{"code": 40102, "message": "连接已失效，请重新连接"}] * 3


async def test_strict_legacy_signal_reports_missing_source_not_fake_zero(client, admin, db):
    # Feed is implemented now. Deliberately remove one registration to exercise an actual missing source.
    async with db.connection() as conn:
        await conn.execute("DELETE FROM account_change_sources WHERE domain='feed' AND source_table='feed_groups'")
    pair = await grants(db, admin, "portfolio.read portfolio.write resources.read feed.read security.read")
    response = await client.get("/api/v2/account-sync", headers=bearer(pair))
    assert response.status_code == 503 and response.json()["code"] == 50001
    states = (await client.get("/api/account/changes")).json()["domains"]
    unavailable = [name for name, state in states.items() if state["state"] in ("unavailable", "partial")]
    assert "feed" in unavailable
    assert response.json()["message"].split("：", 1)[1].split(",") == unavailable
    # The combined notification slice installs actual alerts change sources.
    assert states["alerts"]["state"] == "observed"
    # Independent watch read/write works while the unrepresentable nine-domain response is blocked.
    assert (await client.post("/api/v2/app-state", json=command(key("pinned", "US.A")), headers=bearer(pair))).status_code == 200
    assert (await client.get("/api/v2/app-state?namespace=watch", headers=bearer(pair))).status_code == 200


async def test_invalid_fee_source_rejected_without_financial_plan_or_ledger_writes(client, admin, db):
    pair = await grants(db, admin)
    before = await hashes(db)
    get = await client.get("/api/v2/app-state?namespace=fees", headers=bearer(pair))
    payload = command("plan/" + str(uuid4()), value="aW52YWxpZA==")
    payload["namespace"] = "fees"
    put = await client.post("/api/v2/app-state", json=payload, headers=bearer(pair))
    assert get.status_code == 200 and get.json()["data"]["fields"] == {}
    assert put.status_code == 400
    after = await hashes(db)
    for table in ("fee_plan_heads", "fee_plan_revisions", "fee_plan_operations", "fee_plan_previews", "trade_ledger", "cash_ledger_entries", "portfolio_records", "watch_display_fields", "watch_display_operations"):
        assert before[table] == after[table]


async def test_tombstones_and_receipts_are_not_deletable_or_overwritable(client, admin, db):
    pair = await grants(db, admin)
    payload = command("old-opaque-tombstone", value=None)
    assert (await client.post("/api/v2/app-state", json=payload, headers=bearer(pair))).status_code == 200
    async with db.connection() as conn:
        with pytest.raises(CheckViolation):
            await conn.execute("DELETE FROM watch_display_fields")
        with pytest.raises(CheckViolation):
            await conn.execute("UPDATE watch_display_operations SET result='{}'")


async def test_old_one_megabyte_body_budget_preserved_without_expanding_other_routes(client, admin, db):
    pair = await grants(db, admin)
    payload = {"requestId": str(uuid4()), "namespace": "watch", "changes": [{"key": key("notes", str(n)), "revision": 0, "value": "a"*10000} for n in range(9)]}
    assert 65536 < len(json.dumps(payload).encode()) < 1024*1024
    response = await client.post("/api/v2/app-state", json=payload, headers=bearer(pair))
    assert response.status_code == 200, response.text[:500]
    too_large = {**payload, "changes": payload["changes"]*12}
    denied = await client.post("/api/v2/app-state", json=too_large, headers=bearer(pair))
    assert denied.status_code == 413


async def test_lost_acknowledgement_queries_original_uuid_without_resubmitting(client, admin, db, app):
    pair = await grants(db, admin)
    payload = command(key("notes", "US.A"), value="Accepted once")
    class LostAck(httpx.AsyncBaseTransport):
        def __init__(self):
            self.inner = httpx.ASGITransport(app=app)
            self.calls = 0
        async def handle_async_request(self, request):
            self.calls += 1
            response = await self.inner.handle_async_request(request)
            await response.aread()
            raise httpx.ReadError("synthetic acknowledgement lost", request=request)
    transport = LostAck()
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver", headers={"origin":"http://testserver", **bearer(pair)}) as disconnected:
        with pytest.raises(httpx.ReadError):
            await disconnected.post("/api/v2/app-state", json=payload)
    assert transport.calls == 1
    receipt = await client.get("/api/v2/app-state/operations/"+payload["requestId"], headers=bearer(pair))
    assert receipt.status_code == 200 and receipt.json()["data"]["state"] == "completed"
    async with db.connection() as conn:
        row = await (await conn.execute("SELECT revision,value FROM watch_display_fields WHERE owner_id=%s", (admin,))).fetchone()
        assert row == {"revision": 1, "value": "Accepted once"}
