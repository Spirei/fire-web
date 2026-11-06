import asyncio
from uuid import uuid4

import httpx
import psycopg
import pytest

from alcor_api.cli import create_user
from alcor_api.config import Settings
from alcor_api.db import Database, TargetMismatch
from alcor_api.main import create_app
from alcor_api.migrate import migrate
from alcor_api.security import COOKIE
from alcor_api.worker import checkpoint, claim, diagnose, finish

P = "/api"


async def submit(client, request_id=None):
    r = await client.post(
        P + "/tasks", json={"request_id": str(request_id or uuid4()), "kind": "system.diagnostics"}
    )
    assert r.status_code == 202, r.text
    return r.json()


async def test_target_guard_rejects_wrong_instance(settings):
    bad = settings.model_copy(update={"instance_id": uuid4()})
    db = Database(bad)
    await db.open()
    try:
        with pytest.raises(TargetMismatch):
            async with db.connection():
                pass
    finally:
        await db.close()


async def test_migrations_confirm_name_and_checksum(settings, db, pg):
    with pytest.raises(TargetMismatch):
        await migrate(settings, "another_database")
    name = psycopg.conninfo.conninfo_to_dict(settings.database_url.get_secret_value())["dbname"]
    await migrate(settings, name)
    async with db.connection() as conn:
        await conn.execute("UPDATE schema_migrations SET sha256='tampered'")
    with pytest.raises(TargetMismatch):
        await migrate(settings, name)
    # An unrelated cluster/database is never initialized by guessing from an environment name.
    foreign = settings.model_copy(update={"database_url": type(settings.database_url)(pg.get_uri())})
    with psycopg.connect(pg.get_uri(), autocommit=True) as conn:
        conn.execute("CREATE TABLE unrelated_guard_test (id integer)")
    try:
        with pytest.raises(TargetMismatch):
            await migrate(foreign, "postgres", initialize_empty=True)
    finally:
        with psycopg.connect(pg.get_uri(), autocommit=True) as conn:
            conn.execute("DROP TABLE unrelated_guard_test")


async def test_public_and_unimplemented_api(client):
    assert (await client.get("/health/live")).status_code == 200
    assert (await client.get("/health/ready")).status_code == 200
    assert (await client.get(P + "/system/overview")).status_code == 401
    # The migrated native orders endpoint requires its own authorized connection.
    r = await client.get("/api/v2/orders")
    assert r.status_code == 401 and r.headers["content-type"].startswith("application/json")
    assert (await client.get(P + "/meta")).headers["cache-control"] == "no-store"


async def test_login_cookie_and_digest_not_credential(client, admin, db):
    token = client.cookies[COOKIE]
    async with db.connection() as conn:
        hashed = (await (await conn.execute("SELECT token_hash FROM sessions")).fetchone())["token_hash"]
    assert token != hashed
    assert (await client.get(P + "/session", headers={"cookie": f"{COOKIE}={hashed}"})).status_code == 401
    assert (await client.get(P + "/session")).json()["user"]["id"] == admin
    r = await client.post(
        P + "/session/login", json={"login": "ADMIN@EXAMPLE.INVALID", "password": "Synthetic9Pass"}
    )
    assert r.status_code == 200
    cookie = r.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=strict" in cookie


async def test_csrf_origin_and_unknown_fields(client, admin):
    payload = {"request_id": str(uuid4())}
    assert (
        await client.post(P + "/tasks", json=payload, headers={"origin": "https://foreign.invalid"})
    ).status_code == 403
    assert (await client.post(P + "/tasks", json=payload, headers={"x-csrf-token": "bad"})).status_code == 403
    assert (await client.post(P + "/tasks", json={**payload, "user_id": "another"})).status_code == 422
    assert (await client.post(P + "/tasks", json={"request_id": "not-a-uuid"})).status_code == 422


async def test_logout_revocation_and_session_version(client, admin, db):
    async with db.connection() as conn:
        await conn.execute("UPDATE users SET session_version=session_version+1 WHERE id=%s", (admin,))
    assert (await client.get(P + "/session")).status_code == 401
    r = await client.post(P + "/session/login", json={"login": "AdminOne", "password": "Synthetic9Pass"})
    client.headers["x-csrf-token"] = r.json()["csrf"]
    assert (await client.post(P + "/session/logout")).status_code == 204
    assert (await client.get(P + "/session")).status_code == 401


async def test_role_is_not_client_supplied(client, settings):
    await create_user(settings, "ordinary", "Synthetic9Pass", role="user")
    r = await client.post(P + "/session/login", json={"login": "ordinary", "password": "Synthetic9Pass"})
    client.headers["x-csrf-token"] = r.json()["csrf"]
    assert (await client.get(P + "/system/overview")).status_code == 403
    assert (await client.post(P + "/tasks", json={"request_id": str(uuid4())})).status_code == 403


async def test_login_limit_and_validation_redaction(client, settings):
    await create_user(settings, "rate-user", "Synthetic9Pass")
    for _ in range(12):
        assert (
            await client.post(P + "/session/login", json={"login": "rate-user", "password": "Wrong9Pass"})
        ).status_code == 401
    r = await client.post(
        P + "/session/login",
        json={"login": "rate-user", "password": "Synthetic9Pass"},
        headers={"x-forwarded-for": "1.2.3.4"},
    )
    assert r.status_code == 429
    secret = "DoNotEcho9" * 40
    r = await client.post(P + "/session/login", json={"login": "x", "password": secret})
    assert r.status_code == 422 and secret not in r.text


async def test_task_concurrent_idempotency_and_receipt(client, admin, db):
    request_id = uuid4()
    rows = await asyncio.gather(*[submit(client, request_id) for _ in range(12)])
    assert len({x["id"] for x in rows}) == 1
    r = await client.get(P + "/tasks/receipts/" + str(request_id))
    assert r.status_code == 200 and r.json()["id"] == rows[0]["id"]
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) AS n FROM tasks")).fetchone())["n"] == 1
        assert (
            await (
                await conn.execute("SELECT count(*) AS n FROM audit_events WHERE action='task.submitted'")
            ).fetchone()
        )["n"] == 1
        await conn.execute("UPDATE tasks SET fingerprint='different-content'")
    r = await client.post(P + "/tasks", json={"request_id": str(request_id)})
    assert r.status_code == 409


async def test_task_ownership(client, admin, settings):
    row = await submit(client)
    await create_user(settings, "second-admin", "Synthetic9Pass")
    r = await client.post(P + "/session/login", json={"login": "second-admin", "password": "Synthetic9Pass"})
    client.headers["x-csrf-token"] = r.json()["csrf"]
    assert (await client.get(P + "/tasks/" + row["id"])).status_code == 404
    assert (await client.get(P + "/tasks/receipts/" + row["request_id"])).status_code == 404
    assert (await client.post(P + "/tasks/" + row["id"] + "/cancel")).status_code == 404
    assert not (await client.get(P + "/tasks")).json()["items"]


async def test_task_pagination_and_cancel(client, admin):
    rows = [await submit(client) for _ in range(4)]
    first = (await client.get(P + "/tasks?limit=2")).json()
    second = (await client.get(P + "/tasks?limit=2&cursor=" + first["next_cursor"])).json()
    assert not set(x["id"] for x in first["items"]) & set(x["id"] for x in second["items"])
    assert second["next_cursor"] is None
    assert (await client.get(P + "/tasks?limit=101")).status_code == 422
    assert (await client.get(P + "/tasks?cursor=invalid")).status_code == 422
    assert (await client.get(P + "/tasks?status=unknown")).status_code == 422
    for _ in range(2):
        r = await client.post(P + "/tasks/" + rows[0]["id"] + "/cancel")
        assert r.status_code == 200 and r.json()["status"] == "cancelled"


async def test_worker_single_claim_and_fencing(client, admin, db):
    row = await submit(client)
    claimed = await asyncio.gather(claim(db, uuid4()), claim(db, uuid4()))
    assert sum(x is not None for x in claimed) == 1
    old = next(x for x in claimed if x)
    async with db.connection() as conn:
        await conn.execute(
            "UPDATE tasks SET lease_until=clock_timestamp()-interval '1 second' WHERE id=%s", (row["id"],)
        )
    new = await claim(db, uuid4())
    assert new["lease_version"] > old["lease_version"] and new["attempts"] == 2
    assert not await checkpoint(db, old, "late-write")
    assert not await finish(db, old, {"fake": "old"})
    assert await finish(db, new, {"new": "actual"})
    assert not await finish(db, old, {"fake": "overwrite"})
    detail = (await client.get(P + "/tasks/" + row["id"])).json()
    assert detail["status"] == "succeeded" and detail["result"] == {"new": "actual"}


async def test_cancel_running_and_expired_attempt_budget(client, admin, db):
    row = await submit(client)
    task = await claim(db, uuid4())
    r = await client.post(P + "/tasks/" + row["id"] + "/cancel")
    assert r.json()["status"] == "cancel_requested"
    assert not await checkpoint(db, task, "should-not-run")
    assert (await client.get(P + "/tasks/" + row["id"])).json()["status"] == "cancelled"
    second = await submit(client)
    for _ in range(3):
        assert await claim(db, uuid4())
        async with db.connection() as conn:
            await conn.execute(
                "UPDATE tasks SET lease_until=clock_timestamp()-interval '1 second' WHERE id=%s",
                (second["id"],),
            )
    assert await claim(db, uuid4()) is None
    detail = (await client.get(P + "/tasks/" + second["id"])).json()
    assert detail["status"] == "failed" and detail["error_code"] == "retry_budget_exhausted"


async def test_diagnostic_reports_actual_missing_cache(client, admin, db):
    row = await submit(client)
    task = await claim(db, uuid4())
    await diagnose(db, None, task)
    detail = (await client.get(P + "/tasks/" + row["id"])).json()
    assert detail["status"] == "succeeded"
    assert detail["result"]["healthy"] is False
    assert detail["result"]["scope"] == "runtime"
    assert {"id": "redis", "state": "unconfigured"} in detail["result"]["components"]
    phases = [x["phase"] for x in detail["events"]]
    assert phases == [
        "queued",
        "running",
        "checking_database",
        "checking_cache",
        "recording_receipt",
        "succeeded",
    ]


async def test_disabled_capabilities_and_inventory(client, admin):
    overview = (await client.get(P + "/system/overview")).json()
    assert not any(overview["compatibility"].values())
    data = (await client.get(P + "/system/migration")).json()
    assert data["summary"]["domains"] == 42
    assert data["summary"]["accepted_operations"] == 0
    assert len(data["operations"]) == data["summary"]["method_bindings"]
    assert len({x["method"] + " " + x["path"] for x in data["operations"]}) == len(data["operations"])


async def test_no_database_is_not_ready():
    app = create_app(Settings())
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app, raise_app_exceptions=False), base_url="http://testserver"
        ) as client:
            assert (await client.get("/health/live")).status_code == 200
            assert (await client.get("/health/ready")).status_code == 503
            assert (await client.get(P + "/system/overview")).status_code == 401
