"""Official upgrade of a valid synthetic persisted 0066 permission fixture."""

import json
import shutil
from uuid import uuid4

import httpx
import psycopg
from alcor_api.cli import create_user
from alcor_api.config import ROOT
from alcor_api.font_source_files import roots
from alcor_api.font_source_owner import verify_owner
from alcor_api.main import create_app
from alcor_api.migrate import migrate
from alcor_api.source_registry import load_registry
from legacy_source.test_source_authority import authorized
from psycopg import sql
from pydantic import SecretStr


async def test_official_upgrade_backfills_only_consented_exact_f32_claim_not_pending(
    settings, pg, old_pg, source_file, tmp_path
):
    name = "alcor_test_font_upgrade_" + uuid4().hex
    with psycopg.connect(pg.get_uri(), autocommit=True) as conn:
        conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
    prefix = tmp_path / "before-70-migrations"
    prefix.mkdir()
    for path in (ROOT / "migrations").glob("*.sql"):
        if int(path.name.split("_", 1)[0]) < 70:
            shutil.copy2(path, prefix / path.name)
    private = tmp_path / "upgrade-registries"
    private.mkdir(mode=0o700)
    instance = uuid4()
    for field, filename in (
        ("legacy_source_registry_path", "sources.json"),
        ("font_import_registry_path", "fonts.json"),
    ):
        doc = json.loads(getattr(settings, field).read_bytes())
        doc["platformInstance"] = str(instance)
        path = private / filename
        path.write_text(json.dumps(doc))
        path.chmod(0o600)
    configured = settings.model_copy(
        update={
            "database_url": SecretStr(pg.get_uri(database=name)),
            "instance_id": instance,
            "migration_dir": prefix,
            "legacy_source_registry_path": private / "sources.json",
            "font_import_registry_path": private / "fonts.json",
        }
    )
    try:
        await migrate(configured, name, initialize_empty=True)
        owner = await create_user(configured, "Pre70FontOwner", "Synthetic9Pass")
        app = create_app(configured)
        async with (
            app.router.lifespan_context(app),
            httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
                base_url="http://testserver",
                headers={"origin": "http://testserver"},
            ) as client,
        ):
            logged = await client.post(
                "/api/session/login", json={"login": "Pre70FontOwner", "password": "Synthetic9Pass"}
            )
            client.headers["x-csrf-token"] = logged.json()["csrf"]
            g = await authorized(client, owner, old_pg)
            await verify_owner(load_registry(configured)[old_pg.alias], old_pg.owners[0])
            root = roots(configured)[old_pg.alias]
            async with app.state.db.connection() as conn, conn.transaction():
                grant = await (
                    await conn.execute("SELECT * FROM legacy_source_grants WHERE id=%s", (g["grantId"],))
                ).fetchone()
                await conn.execute(
                    "INSERT INTO legacy_source_owner_claims(source_instance,source_owner,owner_id,physical_identity_hash,first_grant_id,platform_instance) VALUES(%s,%s,%s,%s,%s,%s)",
                    (
                        grant["source_instance"],
                        grant["source_owner"],
                        owner,
                        grant["physical_identity_hash"],
                        grant["id"],
                        instance,
                    ),
                )
                # Prior valid persisted state, not HTTP approval acceptance.
                # The separate actual API/parser bridge covers current consent.
                for original, label, state in (
                    (source_file[1].name, "Historical approved", "active"),
                    ("custom-99-" + "b" * 64 + ".ttf", None, "pending_owner"),
                ):
                    await conn.execute(
                        "INSERT INTO personal_font_source_permissions(id,owner_id,grant_id,grant_revision,platform_instance,source_alias,source_instance,source_owner,binding_hash,physical_identity_hash,root_binding,root_identity,original_id,state,registered_by,evidence_ref,name) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                        (
                            uuid4(),
                            owner,
                            grant["id"],
                            grant["revision"],
                            instance,
                            grant["source_alias"],
                            grant["source_instance"],
                            grant["source_owner"],
                            grant["binding_hash"],
                            grant["physical_identity_hash"],
                            root.binding,
                            root.physical,
                            original,
                            state,
                            owner,
                            "Synthetic prior attestation",
                            label,
                        ),
                    )
        configured.migration_dir = ROOT / "migrations"
        await migrate(configured, name)
        await migrate(configured, name)
        with psycopg.connect(pg.get_uri(database=name)) as conn:
            assert conn.execute(
                "SELECT original_id,owner_id FROM personal_font_source_file_claims"
            ).fetchall() == [(source_file[1].name, owner)]
            assert conn.execute("SELECT count(*) FROM personal_font_source_permissions").fetchone()[0] == 2
    finally:
        with psycopg.connect(pg.get_uri(), autocommit=True) as conn:
            conn.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name)))


async def test_pre70_actual_capture_then_close_keeps_unknown_files_blocked_after_upgrade(
    settings, pg, old_pg, source_file, tmp_path, monkeypatch
):
    import importlib.util
    from pathlib import Path

    from alcor_api import font_source_api
    from personal_font_catalog_candidate.conftest import OTHER
    from personal_font_catalog_candidate.test_catalog import C, catalog
    from personal_font_source_candidate.test_source_fonts import P, ready
    from test_account_admin import body_for

    name = "alcor_test_font_upgrade_" + uuid4().hex
    with psycopg.connect(pg.get_uri(), autocommit=True) as conn:
        conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
    prefix = tmp_path / "before-70-migrations"
    prefix.mkdir()
    for path in (ROOT / "migrations").glob("*.sql"):
        if int(path.name.split("_", 1)[0]) < 70:
            shutil.copy2(path, prefix / path.name)
    private = tmp_path / "upgrade-registries"
    private.mkdir(mode=0o700)
    instance = uuid4()
    for field, filename in (
        ("legacy_source_registry_path", "sources.json"),
        ("font_import_registry_path", "fonts.json"),
    ):
        doc = json.loads(getattr(settings, field).read_bytes())
        doc["platformInstance"] = str(instance)
        path = private / filename
        path.write_text(json.dumps(doc))
        path.chmod(0o600)
    configured = settings.model_copy(
        update={
            "database_url": SecretStr(pg.get_uri(database=name)),
            "instance_id": instance,
            "migration_dir": prefix,
            "legacy_source_registry_path": private / "sources.json",
            "font_import_registry_path": private / "fonts.json",
        }
    )
    try:
        await migrate(configured, name, initialize_empty=True)
        owner = await create_user(configured, "Pre70FontOwner", "Synthetic9Pass")
        survivor = await create_user(configured, "Pre70Survivor", "Synthetic9Pass", role="admin")
        # Execute the saved pre-catalog implementation itself, not a mocked capture.
        old_module = Path(__file__).resolve().parents[1] / "fixtures/pre-catalog-font-source-import.py"
        assert (
            __import__("hashlib").sha256(old_module.read_bytes()).hexdigest()
            == "06edd07e75362756e2f41c2716af6646a21995ea0dae59c126c0bd99b02ec14e"
        )
        spec = importlib.util.spec_from_file_location("alcor_api._before_font_catalog", old_module)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with monkeypatch.context() as patch:
            patch.setattr(font_source_api, "FontSourceImport", module.FontSourceImport)
            app = create_app(configured)
        async with (
            app.router.lifespan_context(app),
            httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
                base_url="http://testserver",
                headers={"origin": "http://testserver"},
            ) as client,
        ):
            logged = await client.post(
                "/api/session/login", json={"login": "Pre70FontOwner", "password": "Synthetic9Pass"}
            )
            client.headers["x-csrf-token"] = logged.json()["csrf"]
            await ready(client, owner, old_pg, source_file)
            before = await body_for(client, owner)
            closed = await client.post(
                "/api/account/close",
                json={k: before[k] for k in ("request_id", "revision")}
                | {"current_password": "Synthetic9Pass"},
            )
            assert closed.status_code == 200, closed.text
            async with app.state.db.connection() as conn:
                for table in ("personal_font_source_permissions", "personal_font_source_captures"):
                    assert (await (await conn.execute("SELECT count(*) n FROM " + table)).fetchone())[
                        "n"
                    ] == 0
                assert (
                    await (await conn.execute("SELECT count(*) n FROM legacy_source_owner_claims")).fetchone()
                )["n"] == 1
        configured.migration_dir = ROOT / "migrations"
        await migrate(configured, name)
        app = create_app(configured)
        async with (
            app.router.lifespan_context(app),
            httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
                base_url="http://testserver",
                headers={"origin": "http://testserver"},
            ) as client,
        ):
            logged = await client.post(
                "/api/session/login", json={"login": "Pre70Survivor", "password": "Synthetic9Pass"}
            )
            client.headers["x-csrf-token"] = logged.json()["csrf"]
            registered = await client.post(
                "/api/legacy-financial/authorizations",
                json={
                    "requestId": str(uuid4()),
                    "sourceAlias": old_pg.alias,
                    "sourceOwner": OTHER,
                    "targetUserId": survivor,
                },
            )
            assert registered.status_code == 200, registered.text
            g = registered.json()
            approved = await client.post(
                "/api/legacy-financial/authorizations/" + g["grantId"] + "/consent",
                json={
                    "requestId": str(uuid4()),
                    "revision": g["grantRevision"],
                    "password": "Synthetic9Pass",
                    "code": "",
                    "approve": True,
                },
            )
            assert approved.status_code == 200, approved.text
            g = approved.json()
            blocked = await client.post(
                P + "/permissions",
                json={
                    "requestId": str(uuid4()),
                    "grantId": g["grantId"],
                    "grantRevision": g["grantRevision"],
                    "originalId": source_file[1].name,
                    "evidenceRef": "Synthetic later owner attestation",
                },
            )
            assert blocked.status_code == 409 and "history_gap" in blocked.text, blocked.text
            scan, _ = await catalog(client, old_pg)
            page = (await client.get(C + "/" + scan["catalogId"])).json()
            assert page["items"][0]["assignmentState"] == "history_gap"
            assert page["items"][0]["ownerId"] is None
            assert page["counts"]["historyGap"] == 1 and page["counts"]["unassigned"] == 0
    finally:
        with psycopg.connect(pg.get_uri(), autocommit=True) as conn:
            conn.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name)))
