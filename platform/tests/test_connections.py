import asyncio
import os
import subprocess
import tempfile
from pathlib import Path
from uuid import uuid4

import httpx
import pytest
import pytest_asyncio
from pydantic import SecretStr
from redis.asyncio import Redis

from alcor_api.cli import create_user
from alcor_api.config import ROOT
from alcor_api.connection_models import ConnectionInput, RedisConfig
from alcor_api.connections import CacheHandle, Connections
from alcor_api.db import Database
from alcor_api.main import create_app
from alcor_api.migrate import migrate
from alcor_api.security import Identity, csrf_token, digest

P = "/api/connections/"
PASSWORD = "SyntheticConnection9"


async def values(client, kind="postgresql"):
    response = await client.get(P + kind)
    assert response.status_code == 200, response.text
    return response.json()


async def request_data(client, settings, kind="postgresql", **changes):
    current = await values(client, kind)
    from alcor_api.connections import current_config

    selected = current["config"]
    password = ""
    if selected is None:
        native, password = current_config(settings, kind)
        selected = native.model_dump()
    result = {"request_id": str(uuid4()), "revision": current["revision"], "config": selected | changes}
    if password:
        result |= {"password_mode": "replace", "password": password}
    return result


async def test_test_is_read_only_and_returns_private_durable_receipt(settings, client, admin, db):
    data = await request_data(client, settings)
    response = await client.post(P + "postgresql/test", json=data)
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "passed"
    assert (await client.get(P + "postgresql/receipts/" + data["request_id"])).json() == response.json()
    assert (await client.post(P + "postgresql/test", json=data)).json() == response.json()
    assert (await values(client))["revision"] is None
    assert (await values(client))["config"] is None
    overview = (await client.get("/api/system/overview")).json()
    assert next(service for service in overview["services"] if service["id"] == "postgresql")["state"] == "up"
    assert next(service for service in overview["services"] if service["id"] == "redis")["state"] == "unconfigured"
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) AS n FROM connection_settings")).fetchone())[
            "n"
        ] == 0
        assert (await (await conn.execute("SELECT count(*) AS n FROM connection_receipts")).fetchone())[
            "n"
        ] == 1
    assert response.headers["cache-control"] == "no-store"


async def test_postgres_save_rebuilds_api_and_worker_pools_and_survives_restart(client, admin, app, settings):
    data = await request_data(client, settings, pool_size=7, pool_min_size=1, max_lifetime=1200, max_idle=120)
    response = await client.put(P + "postgresql", json=data)
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "saved", response.text
    overview = (await client.get("/api/system/overview")).json()
    service = next(s for s in overview["services"] if s["id"] == "postgresql")
    assert service["configured"] is True and service["state"] == "up"
    assert app.state.db.pool.max_size == 7
    assert app.state.db.pool.min_size == 1
    assert app.state.db.pool.max_idle == 120
    assert app.state.db.pool.max_lifetime == 1200
    assert (await client.get("/api/session")).status_code == 200
    worker_db = Database(settings)
    await worker_db.open()
    cache = CacheHandle(settings)
    worker = Connections(settings, worker_db, cache, "worker")
    try:
        await worker.refresh()
        assert worker_db.pool.max_size == 7
        assert (await values(client))["worker_applied"] is True
    finally:
        await worker_db.close()
        await cache.aclose()
    restarted = create_app(settings)
    async with restarted.router.lifespan_context(restarted):
        await restarted.state.connections.refresh()
        assert restarted.state.db.pool.max_size == 7
        assert restarted.state.connections.applied["postgresql"]
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=restarted), base_url="http://testserver", cookies=client.cookies
        ) as existing_session:
            session = await existing_session.get("/api/session")
            assert session.status_code == 200 and session.json()["user"]["id"] == admin


async def test_password_encrypted_not_returned_keep_clear_and_idempotency(client, admin, db, settings):
    data = await request_data(client, settings)
    data |= {"password_mode": "replace", "password": PASSWORD}
    response = await client.put(P + "postgresql", json=data)
    assert response.json()["status"] == "saved", response.text
    assert PASSWORD not in response.text
    current = await values(client)
    assert current["password_set"] is True and PASSWORD not in str(current)
    assert (await client.put(P + "postgresql", json=data)).json() == response.json()
    changed = dict(data, config=data["config"] | {"pool_size": 8})
    assert (await client.put(P + "postgresql", json=changed)).status_code == 409
    async with db.connection() as conn:
        row = await (await conn.execute("SELECT * FROM connection_settings")).fetchone()
    assert PASSWORD not in str(row)
    manager = Connections(settings, db, CacheHandle(settings))
    assert manager.values(row, "postgresql")[1] == PASSWORD
    key = settings.connection_secret_dir / "connections.key"
    assert key.stat().st_mode & 0o777 == 0o600
    keep = await request_data(client, settings, pool_size=6)
    assert (await client.put(P + "postgresql", json=keep)).json()["status"] == "saved"
    assert (await values(client))["password_set"] is True
    clear = await request_data(client, settings)
    clear["password_mode"] = "clear"
    assert (await client.put(P + "postgresql", json=clear)).json()["status"] == "saved"
    assert (await values(client))["password_set"] is False


async def test_saved_postgres_credentials_bootstrap_without_old_account(client, admin, settings):
    from psycopg.conninfo import conninfo_to_dict, make_conninfo

    data = await request_data(client, settings, pool_size=8)
    saved = await client.put(P + "postgresql", json=data)
    assert saved.json()["status"] == "saved", saved.text
    values = conninfo_to_dict(settings.database_url.get_secret_value())
    values["user"] = "missing_old_bootstrap_account"
    stale = settings.model_copy(update={"database_url": SecretStr(make_conninfo(**values))})
    restarted = create_app(stale)
    async with restarted.router.lifespan_context(restarted):
        async with restarted.state.db.connection() as conn:
            assert (await (await conn.execute("SELECT current_user AS name")).fetchone())[
                "name"
            ] != "missing_old_bootstrap_account"
        await restarted.state.connections.refresh()
        assert restarted.state.db.pool.max_size == 8


async def test_incomplete_postgres_role_cannot_replace_platform_connection(settings, client, admin, db):
    from psycopg import sql

    role = "limited_" + uuid4().hex
    async with db.connection() as conn:
        await conn.execute(sql.SQL("CREATE ROLE {} LOGIN").format(sql.Identifier(role)))
        await conn.execute(sql.SQL("GRANT USAGE ON SCHEMA public TO {}").format(sql.Identifier(role)))
        await conn.execute(
            sql.SQL("GRANT SELECT ON ALL TABLES IN SCHEMA public TO {}").format(sql.Identifier(role))
        )
        await conn.execute(
            sql.SQL("GRANT INSERT ON sessions,audit_events TO {}").format(sql.Identifier(role))
        )
        await conn.execute(sql.SQL("GRANT UPDATE ON tasks TO {}").format(sql.Identifier(role)))
    try:
        data = await request_data(client, settings, username=role)
        result = await client.put(P + "postgresql", json=data)
        assert result.json()["status"] == "failed"
        assert "权限" in result.json()["message"]
        assert (await values(client))["revision"] is None
        assert (await client.get("/api/session")).status_code == 200
    finally:
        async with db.connection() as conn:
            await conn.execute(sql.SQL("DROP OWNED BY {}").format(sql.Identifier(role)))
            await conn.execute(sql.SQL("DROP ROLE {}").format(sql.Identifier(role)))


async def test_conflicting_saves_and_revoked_admin_do_not_overwrite(settings, client, admin, app, db):
    first = await request_data(client, settings, pool_size=6)
    second = await request_data(client, settings, pool_size=7)
    responses = await asyncio.gather(
        client.put(P + "postgresql", json=first), client.put(P + "postgresql", json=second)
    )
    assert sorted(r.status_code for r in responses) == [200, 409]
    token = client.cookies["alcor_session"]
    async with db.connection() as conn:
        row = await (
            await conn.execute(
                "DELETE FROM sessions WHERE token_hash=%s RETURNING expires_at", (digest(token),)
            )
        ).fetchone()
        before = (await (await conn.execute("SELECT count(*) AS n FROM connection_probes")).fetchone())["n"]
    stale = Identity(admin, "AdminOne", "admin", digest(token), csrf_token(token), row["expires_at"])
    from fastapi import HTTPException

    with pytest.raises(HTTPException):
        await app.state.connections.operate(stale, ConnectionInput(**first), "save")
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) AS n FROM connection_probes")).fetchone())[
            "n"
        ] == before


async def test_server_local_destinations_and_bad_inputs_never_connect(settings, client, admin, monkeypatch):
    import alcor_api.connections as module

    async def forbidden(*args, **kwargs):
        raise AssertionError("An unregistered target reached a network client")

    data = await request_data(client, settings, host="169.254.169.254")
    with monkeypatch.context() as patch:
        patch.setattr(module.psycopg.AsyncConnection, "connect", forbidden)
        response = await client.post(P + "postgresql/test", json=data)
    assert response.json()["status"] == "failed"
    assert "未发起连接" in response.json()["message"]
    for change in (
        {"host": "http://foreign.invalid"},
        {"host": "127.0.0.1\npassword=x"},
        {"port": 0},
        {"port": 65536},
        {"pool_size": 21},
        {"pool_min_size": 10, "pool_size": 2},
        {"schema_name": "foreign"},
    ):
        bad = data | {"request_id": str(uuid4()), "config": data["config"] | change}
        assert (await client.put(P + "postgresql", json=bad)).status_code == 422
    assert (await values(client))["revision"] is None


async def test_other_marked_database_cannot_become_the_current_database(client, admin, db, settings, pg, app):
    from psycopg import sql
    import psycopg

    name = "alcor_test_" + uuid4().hex
    with psycopg.connect(pg.get_uri(), autocommit=True) as conn:
        conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
    candidate = settings.model_copy(update={"database_url": SecretStr(pg.get_uri(database=name))})
    await migrate(
        candidate, name, initialize_empty=True
    )  # Even copying the same instance UUID is insufficient.
    original, _ = app.state.connections.values(None, "postgresql")
    app.state.connections.base.connection_targets.append(
        {"kind": "postgresql", "host": original.host, "port": original.port, "database": name}
    )
    try:
        data = await request_data(client, settings, database=name)
        test = await client.post(P + "postgresql/test", json=data)
        assert test.json()["status"] == "passed"
        data["request_id"] = str(uuid4())
        result = await client.put(P + "postgresql", json=data)
        assert result.json()["status"] == "failed" and "当前平台数据库" in result.json()["message"]
        assert (await values(client))["revision"] is None
    finally:
        with psycopg.connect(pg.get_uri(), autocommit=True) as conn:
            conn.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name)))


async def test_roles_csrf_receipt_ownership_and_error_redaction(client, admin, settings):
    data = await request_data(client, settings)
    for method, path in [("POST", "postgresql/test"), ("PUT", "postgresql")]:
        assert (
            await client.request(method, P + path, json=data, headers={"x-csrf-token": "wrong"})
        ).status_code == 403
        assert (
            await client.request(method, P + path, json=data, headers={"origin": "https://foreign.invalid"})
        ).status_code == 403
    assert (await client.put(P + "postgresql", json=data | {"user_id": "another"})).status_code == 422
    response = await client.post(P + "postgresql/test", json=data)
    await create_user(settings, "SecondAdmin", "Synthetic9Pass")
    login = (
        await client.post(
            "/api/session/login", json={"login": "SecondAdmin", "password": "Synthetic9Pass"}
        )
    ).json()
    client.headers["x-csrf-token"] = login["csrf"]
    assert (await client.get(P + "postgresql/receipts/" + data["request_id"])).status_code == 404
    await create_user(settings, "Ordinary", "Synthetic9Pass", role="user")
    await client.post("/api/session/login", json={"login": "Ordinary", "password": "Synthetic9Pass"})
    assert (await client.get(P + "postgresql")).status_code == 403
    assert PASSWORD not in response.text


@pytest_asyncio.fixture
async def private_redis(tmp_path):
    binary = Path(os.environ.get("FIRE_TEST_REDIS_BINARY", ROOT / ".local/tooling/redis-7.4.12/src/redis-server"))
    assert binary.is_file(), "Run the owned Redis bootstrap before integration checks"
    directory = Path(tempfile.mkdtemp(prefix="alcor-redis-", dir=os.environ.get("ALCOR_TEST_TMP", tempfile.gettempdir())))
    directory.chmod(0o700)
    path = directory / "cache.sock"
    config = directory / "redis.conf"
    config.write_text(
        f'port 0\nunixsocket {path}\nunixsocketperm 700\nsave ""\nappendonly no\nrequirepass {PASSWORD}\n'
    )
    config.chmod(0o600)
    process = subprocess.Popen(
        [str(binary), str(config)], cwd=directory, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    )
    client = Redis(unix_socket_path=str(path), password=PASSWORD)
    try:
        for _ in range(200):
            try:
                await client.ping()
                break
            except Exception:
                await asyncio.sleep(0.05)
        else:
            raise RuntimeError("Owned isolated Redis did not start")
        assert path.parent == directory and process.poll() is None and path.stat().st_uid == os.getuid()
        await client.execute_command(
            "ACL", "SETUSER", "cache-user", "on", ">" + PASSWORD, "~*", "+ping", "+select", "+client|setinfo"
        )
        yield path
    finally:
        await client.aclose()
        process.terminate()
        process.wait(timeout=10)


async def test_redis_acl_credentials_apply_and_failed_save_preserves_current(
    client, admin, app, private_redis, settings
):
    app.state.connections.base.connection_targets.append(
        {"kind": "redis", "host": str(private_redis), "port": 6379, "database": 0}
    )
    cfg = RedisConfig(host=str(private_redis), username="cache-user").model_dump()
    data = {
        "request_id": str(uuid4()),
        "revision": None,
        "config": cfg,
        "password_mode": "replace",
        "password": PASSWORD,
    }
    failed = await client.post(P + "redis/test", json=data | {"password": "WrongSynthetic9"})
    assert failed.json()["status"] == "failed"
    assert "Redis认证失败" in failed.json()["message"]
    assert "WrongSynthetic9" not in failed.text and PASSWORD not in failed.text
    data["request_id"] = str(uuid4())
    tested = await client.post(P + "redis/test", json=data)
    assert tested.json()["status"] == "passed", tested.text
    assert not app.state.cache
    data["request_id"] = str(uuid4())
    saved = await client.put(P + "redis", json=data)
    assert saved.json()["status"] == "saved", saved.text
    assert await app.state.cache.ping()

    current = await values(client, "redis")
    assert current["password_set"] and PASSWORD not in str(current)
    bad = data | {"request_id": str(uuid4()), "revision": current["revision"], "password": "WrongSynthetic9"}
    result = await client.put(P + "redis", json=bad)
    assert result.json()["status"] == "failed"
    assert (await values(client, "redis"))["revision"] == current["revision"]
    assert await app.state.cache.ping()


async def test_redis_acl_without_ping_is_distinguished_from_bad_password(client, admin, app, private_redis):
    app.state.connections.base.connection_targets.append(
        {"kind": "redis", "host": str(private_redis), "port": 6379, "database": 0}
    )
    control = Redis(unix_socket_path=str(private_redis), password=PASSWORD)
    try:
        await control.execute_command("ACL", "SETUSER", "no-ping-user", "on", ">" + PASSWORD, "~*", "+select", "+client|setinfo")
        response = await client.post(P + "redis/test", json={
            "request_id": str(uuid4()), "revision": None,
            "config": RedisConfig(host=str(private_redis), username="no-ping-user").model_dump(),
            "password_mode": "replace", "password": PASSWORD,
        })
        assert response.status_code == 200 and response.json()["status"] == "failed"
        assert "ACL拒绝" in response.json()["message"] and PASSWORD not in response.text
        assert await control.dbsize() == 0
        assert not app.state.cache
        assert (await values(client, "redis"))["config"] is None
    finally:
        await control.aclose()


async def test_delayed_apply_keeps_current_cache_and_recovers_receipt(
    client, admin, app, private_redis, monkeypatch
):
    app.state.connections.base.connection_targets.append(
        {"kind": "redis", "host": str(private_redis), "port": 6379, "database": 0}
    )
    cfg = RedisConfig(host=str(private_redis), username="cache-user").model_dump()
    data = {
        "request_id": str(uuid4()),
        "revision": None,
        "config": cfg,
        "password_mode": "replace",
        "password": PASSWORD,
    }

    async def failed_replace(client):
        await client.aclose()
        raise RuntimeError("Synthetic interrupted application")

    with monkeypatch.context() as patch:
        patch.setattr(app.state.cache, "replace", failed_replace)
        saved = await client.put(P + "redis", json=data)
    assert saved.json()["status"] == "pending"
    assert not app.state.cache
    assert (await values(client, "redis"))["state"] == "pending"
    overview = (await client.get("/api/system/overview")).json()
    service = next(s for s in overview["services"] if s["id"] == "redis")
    assert service["configured"] is True and service["state"] == "pending"
    await app.state.connections.refresh()
    assert await app.state.cache.ping()
    receipt = await client.get(P + "redis/receipts/" + data["request_id"])
    assert receipt.json()["status"] == "saved"
    assert (await values(client, "redis"))["state"] == "applied"


async def test_recent_authentication_and_persistent_operation_limit(settings, client, admin, db):
    data = await request_data(client, settings, host="169.254.169.254")
    async with db.connection() as conn:
        await conn.execute("UPDATE sessions SET created_at=clock_timestamp()-interval '16 minutes'")
    assert (await client.post(P + "postgresql/test", json=data)).status_code == 200
    assert (await client.put(P + "postgresql", json=data)).status_code == 403
    async with db.connection() as conn:
        await conn.execute("UPDATE sessions SET created_at=clock_timestamp()")
    for _ in range(19):
        data["request_id"] = str(uuid4())
        response = await client.post(P + "postgresql/test", json=data)
        assert response.status_code == 200 and response.json()["status"] == "failed"
    data["request_id"] = str(uuid4())
    assert (await client.post(P + "postgresql/test", json=data)).status_code == 429


async def test_running_bootstrap_services_do_not_appear_as_user_configurations(
    client, admin, settings, private_redis
):
    configured = settings.model_copy(
        update={"redis_url": SecretStr(f"unix://:{PASSWORD}@{private_redis}?db=0")}
    )
    runtime = create_app(configured)
    async with runtime.router.lifespan_context(runtime):
        assert await runtime.state.cache.ping()
        async with runtime.state.db.connection() as conn:
            assert (await (await conn.execute("SELECT 1 AS ok")).fetchone())["ok"] == 1
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=runtime),
            base_url="http://testserver",
            headers={"origin": "http://testserver"},
        ) as browser:
            login = await browser.post(
                "/api/session/login", json={"login": "AdminOne", "password": "Synthetic9Pass"}
            )
            browser.headers["x-csrf-token"] = login.json()["csrf"]
            for kind in ("postgresql", "redis"):
                data = (await browser.get(P + kind)).json()
                assert data == {
                    "source": "managed",
                    "config": None,
                    "effective": None,
                    "revision": None,
                    "password_set": False,
                    "saved_at": None,
                    "state": "unconfigured",
                    "worker_applied": False,
                }
            data = (await browser.get("/api/system/overview")).json()
            for service in data["services"]:
                if service["id"] in {"postgresql", "redis"}:
                    assert service["configured"] is True and service["state"] == "up"
                    assert service["observed_at"] is not None
            from alcor_api.connections import current_config

            native, _ = current_config(configured, "redis")
            response = await browser.post(
                P + "redis/test",
                json={"request_id": str(uuid4()), "revision": None, "config": native.model_dump()},
            )
            assert response.json()["status"] == "failed"
            assert await runtime.state.cache.ping()


async def test_first_form_does_not_reuse_a_hidden_bootstrap_password(client, admin, settings, app):
    native, _ = app.state.connections.values(None, "postgresql")
    original = app.state.connections.base
    from psycopg.conninfo import conninfo_to_dict, make_conninfo

    info = conninfo_to_dict(settings.database_url.get_secret_value())
    info["password"] = "BootstrapOnlySynthetic9"
    app.state.connections.base = original.model_copy(
        update={"database_url": SecretStr(make_conninfo(**info))}
    )
    state = await values(client)
    assert state["password_set"] is False and state["config"] is None
    data = ConnectionInput(request_id=uuid4(), revision=None, config=native)
    assert app.state.connections.resolved_password(data, None) == ""


async def test_admin_target_address_needs_no_enrollment(settings, db):
    from alcor_api.connection_models import PostgresConfig
    connections = Connections(settings, db, CacheHandle(settings))
    target = PostgresConfig(host="192.0.2.77", port=15432, database="qa", username="qa")
    assert await connections.address(target) == "192.0.2.77"
    for host in ["::ffff:169.254.169.254", "127.0.0.1", "0.0.0.0", "::ffff:127.0.0.1"]:
        with pytest.raises(Exception) as error:
            await connections.address(target.model_copy(update={"host":host}))
        assert getattr(error.value, "status_code", None) == 422
