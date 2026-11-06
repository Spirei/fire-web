"""Fire never lets saved legacy connection settings override server environment."""

from uuid import uuid4

import httpx
import psycopg
import pytest
from alcor_api.cli import create_user
from alcor_api.connections import bootstrap_settings, current_config
from alcor_api.fire_web import FireConnectionInput
from alcor_api.main import create_app
from fastapi import HTTPException
from psycopg.types.json import Jsonb
from test_fire_web import fire_login


async def test_environment_is_authority_for_api_worker_bootstrap_and_test_receipts(settings):
    settings.connections_from_environment = True
    settings.connection_secret_dir.mkdir(mode=0o700)
    stale = settings.connection_secret_dir / ("bootstrap-" + str(settings.instance_id) + ".enc")
    stale.write_text("Synthetic stale encrypted configuration must never be read")
    stale.chmod(0o600)
    assert bootstrap_settings(settings) == (settings, None)
    config, _ = current_config(settings, "postgresql")
    old = config.model_copy(update={"host": "removed-database.example.invalid"})
    await create_user(settings, "EnvironmentAdmin", "Synthetic9Pass")
    with psycopg.connect(settings.database_url.get_secret_value()) as conn:
        owner = conn.execute("SELECT id FROM users WHERE username='EnvironmentAdmin'").fetchone()[0]
        conn.execute(
            "INSERT INTO connection_settings(kind,revision,config,password_ciphertext,updated_by) VALUES(%s,%s,%s,%s,%s)",
            ("postgresql", uuid4(), Jsonb(old.model_dump()), "Synthetic stale secret", owner),
        )
    app = create_app(settings)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
            base_url="http://testserver",
            headers={"origin": "http://testserver"},
        ) as client:
            await fire_login(client, "EnvironmentAdmin")
            view = (await client.get("/api/fire/connections/postgresql")).json()
            assert view["source"] == "environment" and view["effective"] == config.model_dump()
            assert view["revision"] is None and view["config"] is None
            body = {
                "request_id": str(uuid4()),
                "revision": None,
                "config": view["effective"],
                "password_mode": "keep",
                "reuse_current_password": True,
            }
            assert (await client.put("/api/fire/connections/postgresql", json=body)).status_code == 409
            checked = await client.post("/api/fire/connections/postgresql/test", json=body)
            assert checked.status_code == 200 and checked.json()["status"] == "passed", checked.text
            receipt = await client.get("/api/fire/connections/postgresql/receipts/" + body["request_id"])
            assert receipt.json() == checked.json()
            forged = body | {"request_id": str(uuid4()), "config": old.model_dump()}
            assert (
                await client.post("/api/fire/connections/postgresql/test", json=forged)
            ).status_code == 409
            with pytest.raises(HTTPException) as error:
                await app.state.connections.preflight(None, FireConnectionInput(**body), "save")
            assert error.value.status_code == 409
            await app.state.connections.refresh()
            overview = (await client.get("/api/fire/system/overview")).json()
            assert next(x for x in overview["services"] if x["id"] == "postgresql")["state"] == "up"
            assert app.state.db.settings.database_url == settings.database_url
            redis = (await client.get("/api/fire/connections/redis")).json()
            assert redis["source"] == "environment" and redis["effective"] is None
        async with app.state.db.connection() as conn:
            rows = await (
                await conn.execute("SELECT config,password_ciphertext FROM connection_settings")
            ).fetchall()
            assert (
                len(rows) == 1
                and rows[0]["config"] == old.model_dump()
                and rows[0]["password_ciphertext"] == "Synthetic stale secret"
            )
            assert (await (await conn.execute("SELECT count(*) n FROM connection_receipts")).fetchone())[
                "n"
            ] == 1
    assert stale.read_text() == "Synthetic stale encrypted configuration must never be read"
