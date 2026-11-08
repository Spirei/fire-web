from uuid import uuid4

import pytest
from alcor_api.cli import create_user


async def fire_login(client, username="AdminOne", password="Synthetic9Pass"):
    client.headers.pop("x-csrf-token", None)
    result = await client.post("/api/auth/login", json={"username": username, "password": password})
    assert result.status_code == 200, result.text
    result = await client.get("/api/fire/session")
    assert result.status_code == 200, result.text
    client.headers["x-csrf-token"] = result.json()["csrf"]
    return result.json()


async def test_fire_requires_explicit_web_session_and_admin(client, admin, settings):
    assert (await client.get("/api/fire/system/overview")).status_code == 401
    identity = await fire_login(client)
    assert identity["user"]["role"] == "admin"
    assert identity["instance_id"] == str(settings.instance_id)
    assert (await client.get("/api/fire/system/overview")).status_code == 200
    assert (
        await client.get("/api/fire/system/overview", headers={"authorization": "Bearer unrelated"})
    ).status_code == 403
    await create_user(settings, "FireMember", "Synthetic9Pass", role="user")
    await fire_login(client, "FireMember")
    assert (await client.get("/api/fire/system/overview")).status_code == 403
    assert (await client.get("/api/fire/tasks")).status_code == 403


async def test_fire_task_csrf_uuid_receipts_and_cancel(client, admin, db):
    await fire_login(client)
    payload = {"request_id": str(uuid4()), "kind": "system.diagnostics"}
    csrf = client.headers.pop("x-csrf-token")
    assert (await client.post("/api/fire/tasks", json=payload)).status_code == 403
    client.headers["x-csrf-token"] = "wrong"
    assert (await client.post("/api/fire/tasks", json=payload)).status_code == 403
    client.headers["x-csrf-token"] = csrf
    assert (
        await client.post("/api/fire/tasks", json=payload, headers={"origin": "http://other.example"})
    ).status_code == 403
    first = await client.post("/api/fire/tasks", json=payload)
    assert first.status_code == 202, first.text
    again = await client.post("/api/fire/tasks", json=payload)
    assert again.json()["id"] == first.json()["id"]
    receipt = await client.get("/api/fire/tasks/receipts/" + payload["request_id"])
    assert receipt.json()["id"] == first.json()["id"]
    listing = await client.get("/api/fire/tasks")
    assert first.json()["id"] in str(listing.json())
    cancelled = await client.post("/api/fire/tasks/" + first.json()["id"] + "/cancel")
    assert cancelled.status_code == 200, cancelled.text
    assert cancelled.json()["status"] == "cancelled"
    assert receipt.headers["cache-control"] == "no-store"
    async with db.connection() as conn:
        row = await (
            await conn.execute(
                "SELECT count(*) AS n FROM tasks WHERE request_id=%s", (payload["request_id"],)
            )
        ).fetchone()
    assert row["n"] == 1


async def test_fire_progress_uses_method_catalog_and_real_routes(client, admin):
    await fire_login(client)
    response = await client.get("/api/fire/system/api-migration")
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["summary"]["total"] == len(data["items"])
    assert any(
        item["path"] == "/api/records" and item["method"] == "GET" and item["backend_available"]
        for item in data["items"]
    )
    assert all(item["backend_available"] for item in data["items"] if item["path"].startswith("/api/fire/"))
    assert all(item["client_acceptance"] == "pending" for item in data["items"])
    assert not any("[[..." in item["path"] for item in data["items"])
    assert not any("516" in key for key in data)
    assert (await client.get("/api/fire/connections/postgresql")).json()["state"] == "unconfigured"


async def test_fire_catalogue_conditional_reads_still_require_current_admin(client, admin, settings):
    await fire_login(client)
    first = await client.get('/api/fire/system/api-migration')
    assert first.status_code == 200
    etag = first.headers['etag']
    assert etag == first.json()['etag']
    for value in (etag, etag.removeprefix('W/'), '"unrelated", ' + etag):
        again = await client.get('/api/fire/system/api-migration', headers={'if-none-match':value})
        assert again.status_code == 304 and not again.content
        assert again.headers['etag'] == etag
        assert 'no-store' in again.headers['cache-control']
    changed = await client.get('/api/fire/system/api-migration', headers={'if-none-match':'"old-contract"'})
    assert changed.status_code == 200 and changed.content == first.content
    await create_user(settings, 'CatalogueMember', 'Synthetic9Pass', role='user')
    await fire_login(client, 'CatalogueMember')
    assert (await client.get('/api/fire/system/api-migration', headers={'if-none-match':etag})).status_code == 403
    client.cookies.clear()
    assert (await client.get('/api/fire/system/api-migration', headers={'if-none-match':etag})).status_code == 401


def test_fire_has_no_sqlite_runtime_driver():
    import ast
    from pathlib import Path

    from alcor_api import source_snapshot

    root = Path(source_snapshot.__file__).parent
    for file in root.glob("*.py"):
        tree = ast.parse(file.read_text())
        assert not any(
            isinstance(node, ast.Import)
            and any(alias.name == "sqlite3" for alias in node.names)
            or isinstance(node, ast.ImportFrom)
            and node.module == "sqlite3"
            for node in ast.walk(tree)
        ), file.name
    with pytest.raises(ValueError, match="source_backend_not_supported"):
        source_snapshot.SourceDefinition("removed", "synthetic", "sqlite", (), None, "", "")


async def test_fire_bootstrap_credentials_are_explicit_bound_and_never_returned(client, admin, app, settings):
    from alcor_api.connection_models import ConnectionInput
    from alcor_api.fire_web import FireConnectionInput
    from fastapi import HTTPException
    from psycopg.conninfo import conninfo_to_dict, make_conninfo
    from pydantic import SecretStr

    await fire_login(client)
    config, _ = app.state.connections.values(None, "postgresql")
    info = conninfo_to_dict(settings.database_url.get_secret_value())
    info["password"] = "SyntheticBootstrapOnly9"
    app.state.connections.base = settings.model_copy(
        update={"database_url": SecretStr(make_conninfo(**info))}
    )
    ordinary = ConnectionInput(request_id=uuid4(), config=config, revision=None)
    assert app.state.connections.resolved_password(ordinary, None) == ""
    explicit = FireConnectionInput(**ordinary.model_dump(), reuse_current_password=True)
    assert app.state.connections.resolved_password(explicit, None) == info["password"]
    with pytest.raises(HTTPException):
        app.state.connections.resolved_password(
            explicit.model_copy(
                update={"config": config.model_copy(update={"host": "other.example.invalid"})}
            ),
            None,
        )
    assert (
        app.state.connections.resolved_password(explicit.model_copy(update={"password_mode": "clear"}), None)
        == ""
    )
    response = await client.get("/api/fire/connections/postgresql")
    assert info["password"] not in response.text
    assert response.json()["effective"] is not None
    overview = (await client.get("/api/fire/system/overview")).json()
    assert next(item for item in overview["services"] if item["id"] == "postgresql")["state"] == "up"
