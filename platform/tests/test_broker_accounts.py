"""Private PostgreSQL HTTP proofs for stable accounts; no supplier or production connections."""

import asyncio
from uuid import uuid4

import httpx
import pytest
import pytest_asyncio
from alcor_api.cli import create_user
from psycopg.errors import CheckViolation


@pytest_asyncio.fixture
async def brokers(app, client, admin):
    return client


def create_body(**overrides):
    return {
        "request_id": str(uuid4()),
        "name": "Personal account",
        "provider_id": "ibkr",
        "account_kind": "real",
        "currency": "USD",
        "currencies": ["USD", "HKD"],
        **overrides,
    }


async def create(brokers, **overrides):
    result = await brokers.post("/api/broker-accounts", json=create_body(**overrides))
    assert result.status_code == 201, result.text
    return result.json()["data"]


@pytest.mark.asyncio
async def test_owner_session_csrf_and_explicit_account_identity(brokers, app, settings, admin):
    body = create_body()
    created = await brokers.post("/api/broker-accounts", json=body)
    assert created.status_code == 201
    row = created.json()["data"]
    assert row["owner_id"] == admin and row["account_kind"] == "real" and row["holding_source"] == "manual"
    assert row["currency_usage"] == {"complete": True, "used_currencies": [], "reference_count": 0}
    assert (await brokers.get("/api/broker-accounts")).json()["collection_revision"] == 1
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as other:
        assert (await other.get("/api/broker-accounts")).status_code == 401
        await create_user(settings, "OtherBrokerUser", "Synthetic9Pass")
        login = await other.post(
            "/api/session/login",
            json={"login": "OtherBrokerUser", "password": "Synthetic9Pass"},
            headers={"origin": "http://testserver"},
        )
        other.headers.update({"origin": "http://testserver", "x-csrf-token": login.json()["csrf"]})
        assert (await other.get("/api/broker-accounts")).json()["items"] == []
        assert (await other.get("/api/broker-accounts/" + row["id"])).status_code == 404
        assert (await other.get("/api/broker-accounts/operations/" + body["request_id"])).status_code == 404
        assert (
            await other.put(
                "/api/broker-accounts/" + row["id"],
                json={
                    "request_id": str(uuid4()),
                    "revision": 1,
                    "name": "Stolen",
                    "currency": "USD",
                    "currencies": ["USD"],
                },
            )
        ).status_code == 404
        assert (await other.post("/api/broker-accounts", json=create_body())).status_code == 201
    for extra in (
        {"owner_id": admin},
        {"holding_source": "official"},
        {"account_kind": "unknown"},
        {"provider_id": "invalid"},
    ):
        assert (await brokers.post("/api/broker-accounts", json=create_body(**extra))).status_code == 422
    assert (
        await brokers.post(
            "/api/broker-accounts", json=create_body(), headers={"origin": "https://foreign.invalid"}
        )
    ).status_code == 403
    assert (
        await brokers.post("/api/broker-accounts", json=create_body(), headers={"x-csrf-token": ""})
    ).status_code == 403


@pytest.mark.asyncio
async def test_idempotent_creation_conflict_stable_fields_and_tombstones(brokers, db, admin):
    body = create_body()
    first = await brokers.post("/api/broker-accounts", json=body)
    retry = await brokers.post("/api/broker-accounts", json=body)
    assert retry.json() == first.json()
    assert (await brokers.post("/api/broker-accounts", json={**body, "name": "Changed"})).status_code == 409
    row = first.json()["data"]
    path = "/api/broker-accounts/" + row["id"]
    update = {
        "request_id": str(uuid4()),
        "revision": 1,
        "name": "Renamed",
        "currency": "HKD",
        "currencies": ["HKD", "USD"],
    }
    changed = await brokers.put(path, json=update)
    assert changed.status_code == 200
    assert changed.json()["data"]["id"] == row["id"]
    assert changed.json()["data"]["provider_id"] == "ibkr"
    assert changed.json()["data"]["currencies"] == ["USD", "HKD"]
    assert (
        await brokers.put(path, json={**update, "request_id": str(uuid4()), "provider_id": None})
    ).status_code == 422
    deletion = {"request_id": str(uuid4()), "revision": 2}
    deleted = await brokers.request("DELETE", path, json=deletion)
    assert deleted.status_code == 200 and deleted.json()["data"]["deleted_at"]
    assert (await brokers.request("DELETE", path, json=deletion)).json() == deleted.json()
    assert (await brokers.get(path)).status_code == 404
    assert (await brokers.get("/api/broker-accounts")).json()["items"] == []
    replacement = await create(brokers, name="Renamed")
    assert replacement["id"] != row["id"]
    async with db.connection() as conn:
        for sql, args in [
            ("UPDATE broker_accounts SET deleted_at=NULL WHERE id=%s", (row["id"],)),
            ("DELETE FROM broker_accounts WHERE id=%s", (row["id"],)),
            ("UPDATE broker_accounts SET account_kind=%s WHERE id=%s", ("simulated", replacement["id"])),
            ("UPDATE broker_accounts SET provider_id=%s WHERE id=%s", ("futu", replacement["id"])),
        ]:
            with pytest.raises(CheckViolation):
                async with conn.transaction():
                    await conn.execute(sql, args)
        assert (
            await (
                await conn.execute(
                    "SELECT count(*) n FROM broker_account_operations WHERE owner_id=%s", (admin,)
                )
            ).fetchone()
        )["n"] == 4


@pytest.mark.asyncio
async def test_references_currency_unknown_and_official_boundary(brokers, db, admin):
    row = await create(brokers)
    path = "/api/broker-accounts/" + row["id"]
    async with db.connection() as conn:
        await conn.execute(
            "INSERT INTO broker_account_references VALUES(%s,%s,%s,%s,%s)",
            (admin, row["id"], "cash", "cash-hkd", "HKD"),
        )
    change = {
        "request_id": str(uuid4()),
        "revision": 1,
        "name": "Keep identity",
        "currency": "USD",
        "currencies": ["USD"],
    }
    failed = await brokers.put(path, json=change)
    assert failed.status_code == 409 and failed.json()["state"] == "failed"
    assert (
        await brokers.get("/api/broker-accounts/operations/" + change["request_id"])
    ).json() == failed.json()
    assert (await brokers.put(path, json=change)).json() == failed.json()
    assert (
        await brokers.request("DELETE", path, json={"request_id": str(uuid4()), "revision": 1})
    ).status_code == 409
    async with db.connection() as conn:
        await conn.execute(
            "UPDATE broker_account_references SET currency=NULL WHERE account_id=%s", (row["id"],)
        )
    assert (await brokers.get(path)).json()["currency_usage"]["complete"] is False
    assert (await brokers.put(path, json={**change, "request_id": str(uuid4())})).status_code == 409
    # Supported additions are permitted; an unknown currency never authorizes removing another one.
    changed = await brokers.put(
        path, json={**change, "request_id": str(uuid4()), "currencies": ["USD", "HKD", "EUR"]}
    )
    assert changed.status_code == 200
    async with db.connection() as conn:
        await conn.execute("DELETE FROM broker_account_references WHERE account_id=%s", (row["id"],))
        await conn.execute("UPDATE broker_accounts SET holding_source='official' WHERE id=%s", (row["id"],))
    assert (
        await brokers.request("DELETE", path, json={"request_id": str(uuid4()), "revision": 2})
    ).status_code == 409
    # Directory display edits do not change official source or create financial effects.
    result = await brokers.put(
        path, json={**change, "request_id": str(uuid4()), "revision": 2, "currencies": ["USD", "HKD", "EUR"]}
    )
    assert result.status_code == 200 and result.json()["data"]["holding_source"] == "official"


@pytest.mark.asyncio
async def test_parallel_cas_and_duplicate_name_have_one_winner(brokers, db, admin):
    results = await asyncio.gather(
        *(
            brokers.post("/api/broker-accounts", json=create_body(name=name))
            for name in ("Personal", "PERSONAL")
        )
    )
    assert sorted(r.status_code for r in results) == [201, 409]
    row = next(r.json()["data"] for r in results if r.status_code == 201)
    updates = [
        {
            "request_id": str(uuid4()),
            "revision": 1,
            "name": name,
            "currency": "USD",
            "currencies": ["USD", "HKD"],
        }
        for name in ("First", "Second")
    ]
    results = await asyncio.gather(
        *(brokers.put("/api/broker-accounts/" + row["id"], json=b) for b in updates)
    )
    assert sorted(r.status_code for r in results) == [200, 409]
    assert (await brokers.get("/api/broker-accounts/" + row["id"])).json()["revision"] == 2
    async with db.connection() as conn:
        assert (
            await (
                await conn.execute(
                    "SELECT count(*) n FROM broker_account_operations WHERE owner_id=%s", (admin,)
                )
            ).fetchone()
        )["n"] == 4


@pytest.mark.asyncio
async def test_failed_receipt_write_rolls_back_account_and_audit(brokers, db, admin):
    async with db.connection() as conn:
        await conn.execute("""CREATE FUNCTION fail_broker_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'injected receipt failure'; END $$""")
        await conn.execute(
            "CREATE TRIGGER fail_receipt BEFORE INSERT ON broker_account_operations "
            "FOR EACH ROW EXECUTE FUNCTION fail_broker_receipt()"
        )
    body = create_body()
    assert (await brokers.post("/api/broker-accounts", json=body)).status_code == 503
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) n FROM broker_accounts")).fetchone())["n"] == 0
        assert (
            await (
                await conn.execute("SELECT count(*) n FROM audit_events WHERE action='broker.create'")
            ).fetchone()
        )["n"] == 0
        assert (await (await conn.execute("SELECT count(*) n FROM broker_account_collections")).fetchone())[
            "n"
        ] == 0
        await conn.execute("DROP TRIGGER fail_receipt ON broker_account_operations")
    assert (await brokers.get("/api/broker-accounts/operations/" + body["request_id"])).status_code == 404
    assert (await brokers.post("/api/broker-accounts", json=body)).status_code == 201


@pytest.mark.asyncio
async def test_revocation_while_waiting_for_owner_lock_does_not_write(brokers, db, admin):
    body = create_body()
    async with db.connection() as blocker, blocker.transaction():
        await blocker.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("broker-accounts:" + admin,)
        )
        pending = asyncio.create_task(brokers.post("/api/broker-accounts", json=body))
        # Observe the actual blocked HTTP transaction before revoking its previously validated session.
        async with db.connection() as observer:
            waiting = False
            for _ in range(100):
                row = await (
                    await observer.execute(
                        "SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() "
                        "AND wait_event_type='Lock' AND wait_event='advisory'"
                    )
                ).fetchone()
                if row["n"]:
                    waiting = True
                    break
                await asyncio.sleep(0.01)
            assert waiting
            await observer.execute("DELETE FROM sessions WHERE user_id=%s", (admin,))
    result = await pending
    assert result.status_code == 401
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) n FROM broker_accounts")).fetchone())["n"] == 0
        assert (await (await conn.execute("SELECT count(*) n FROM broker_account_operations")).fetchone())[
            "n"
        ] == 0


@pytest.mark.asyncio
async def test_database_reference_cannot_cross_owner_or_attach_to_tombstone(brokers, db, settings, admin):
    row = await create(brokers)
    other = await create_user(settings, "BrokerOtherOwner", "Synthetic9Pass")
    async with db.connection() as conn:
        with pytest.raises(CheckViolation):
            async with conn.transaction():
                await conn.execute(
                    "INSERT INTO broker_account_references VALUES(%s,%s,%s,%s,%s)",
                    (other, row["id"], "cash", "foreign", "USD"),
                )
    deleted = await brokers.request(
        "DELETE", "/api/broker-accounts/" + row["id"], json={"request_id": str(uuid4()), "revision": 1}
    )
    assert deleted.status_code == 200
    async with db.connection() as conn:
        with pytest.raises(CheckViolation):
            async with conn.transaction():
                await conn.execute(
                    "INSERT INTO broker_account_references VALUES(%s,%s,%s,%s,%s)",
                    (admin, row["id"], "cash", "late", "USD"),
                )
