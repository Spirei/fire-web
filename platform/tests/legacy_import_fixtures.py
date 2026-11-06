from source_window_fixture import active_window
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4

import httpx
import psycopg
import pytest_asyncio
from alcor_api.config import ROOT, Settings
from alcor_api.main import create_app
from alcor_api.migrate import migrate
from alcor_api.resource_import_snapshot import TABLES, pg_schema
from alcor_api.source_snapshot import PgSnapshot, SourceDefinition,  schema_digest
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict, make_conninfo
from psycopg.rows import dict_row
from synthetic_resource_legacy import OWNER, seed_pg

ROOT_FOLDER = "rld_" + "a" * 32
CHILD_FOLDER = "rld_" + "b" * 32
READY = "rlf_" + "1" * 32
DELETED = "rlf_" + "2" * 32
PENDING = "rlf_" + "3" * 32
UPLOAD_ID = "11111111-1111-4111-8111-111111111111"
DELETE_ID = "22222222-2222-4222-8222-222222222222"
FAILED_ID = "33333333-3333-4333-8333-333333333333"
PENDING_ID = "44444444-4444-4444-8444-444444444444"
RAW = b"synthetic original resource bytes\n"
DIGEST = hashlib.sha256(RAW).hexdigest()
WHEN = "2026-01-01T09:00:00-05:00"


def resource_rows():
    files = [
        {
            "id": identifier,
            "user_id": OWNER,
            "category": "components",
            "folder_id": CHILD_FOLDER,
            "name": "cafe\u0301.bin",
            "kind": "other",
            "mime": "application/octet-stream",
            "size_bytes": len(RAW),
            "sha256": DIGEST,
            "revision": 3,
            "created_at": WHEN,
            "state": state,
        }
        for identifier, state in ((READY, "ready"), (DELETED, "deleted"))
    ]
    folders = [
        {
            "id": ROOT_FOLDER,
            "user_id": OWNER,
            "category": "components",
            "parent_id": "",
            "name": "旧资料",
            "revision": 5,
            "created_at": WHEN,
        },
        {
            "id": CHILD_FOLDER,
            "user_id": OWNER,
            "category": "components",
            "parent_id": ROOT_FOLDER,
            "name": "原目录",
            "revision": 2,
            "created_at": WHEN,
        },
    ]
    dto = {
        "id": READY,
        "category": "components",
        "folderId": CHILD_FOLDER,
        "name": "original.bin",
        "kind": "other",
        "mime": "application/octet-stream",
        "sizeBytes": len(RAW),
        "sha256": DIGEST,
        "revision": 1,
        "createdAt": WHEN,
        "state": "ready",
        "downloadPath": "/api/v1/resource-library/files/" + READY + "/content",
    }
    operations = [
        {
            "user_id": OWNER,
            "request_id": UPLOAD_ID,
            "type": "upload",
            "file_id": READY,
            "state": "completed",
            "result": json.dumps(dto),
            "created_at": WHEN,
        },
        {
            "user_id": OWNER,
            "request_id": DELETE_ID,
            "type": "delete",
            "file_id": DELETED,
            "state": "completed",
            "result": json.dumps(
                {
                    "deletedId": DELETED,
                    "fileDeleted": True,
                    "removedBytes": len(RAW),
                    "usedBytes": 4321,
                    "deletedAt": WHEN,
                }
            ),
            "created_at": WHEN,
        },
        {
            "user_id": OWNER,
            "request_id": FAILED_ID,
            "type": "upload",
            "file_id": "rlf_" + "f" * 32,
            "state": "failed",
            "result": None,
            "created_at": WHEN,
        },
    ]
    # Deliberately belongs to another source owner; neither rows nor files may enter capture.
    files.append(
        {**files[0], "id": "rlf_" + "9" * 32, "user_id": "other-source-owner", "name": "DO-NOT-EXPORT.bin"}
    )
    return {"resource_folders": folders, "resource_files": files, "resource_operations": operations}


@dataclass
class SyntheticSource:
    definition: SourceDefinition
    schema_hash: str
    root: Path
    admin_url: str | None
    path: Path | None

    async def execute(self, query, params=()):
        assert self.admin_url is not None
        async with await psycopg.AsyncConnection.connect(self.admin_url, autocommit=True) as conn:
            await conn.execute(query, params)


@pytest_asyncio.fixture(params=["postgres"])
async def source(pg, tmp_path, request):
    root = tmp_path.resolve() / "source-resources"
    root.mkdir(mode=0o700)
    owner = root / hashlib.sha256(OWNER.encode()).hexdigest()
    owner.mkdir(mode=0o700)
    (owner / READY).write_bytes(RAW)
    (owner / READY).chmod(0o600)
    # A global F28 tree is deliberately outside the owner-indexed F26 root.
    shared = tmp_path / "attachments"
    shared.mkdir(mode=0o700)
    (shared / "global-private.txt").write_text("MUST-NOT-IMPORT-GLOBAL")
    rows = resource_rows()
    database = "alcor_legacy_resource_" + uuid4().hex
    role = "resource_reader_" + uuid4().hex
    async with await psycopg.AsyncConnection.connect(pg.get_uri(), autocommit=True) as conn:
        await conn.execute(
            sql.SQL("CREATE ROLE {} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION").format(
                sql.Identifier(role)
            )
        )
        await conn.execute(sql.SQL("GRANT pg_read_all_settings TO {}").format(sql.Identifier(role)))
        await conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(database)))
    admin_url = pg.get_uri(database=database)
    async with await psycopg.AsyncConnection.connect(
        admin_url, autocommit=True, row_factory=dict_row
    ) as conn:
        await seed_pg(conn)
        for table, (_, columns) in TABLES.items():
            await conn.execute(
                sql.SQL("CREATE TABLE {} ({})").format(
                    sql.Identifier(table),
                    sql.SQL(",").join(
                        sql.SQL("{} {}").format(
                            sql.Identifier(c),
                            sql.SQL("bigint" if c in ("revision", "size_bytes") else "text"),
                        )
                        for c in columns
                    ),
                )
            )
            for row in rows[table]:
                await conn.execute(
                    sql.SQL("INSERT INTO {} ({}) VALUES ({})").format(
                        sql.Identifier(table),
                        sql.SQL(",").join(map(sql.Identifier, columns)),
                        sql.SQL(",").join(sql.Placeholder() for _ in columns),
                    ),
                    tuple(row[c] for c in columns),
                )
        await conn.execute(sql.SQL("GRANT SELECT(id) ON users TO {}").format(sql.Identifier(role)))
        await conn.execute(
            sql.SQL("GRANT EXECUTE ON FUNCTION pg_control_system() TO {}").format(sql.Identifier(role))
        )
        from alcor_api.source_snapshot import TABLES as FINANCIAL_TABLES

        for table in (*FINANCIAL_TABLES, *TABLES):
            await conn.execute(
                sql.SQL("GRANT SELECT ON {} TO {}").format(sql.Identifier(table), sql.Identifier(role))
            )
        directory = Path((await (await conn.execute("SHOW data_directory")).fetchone())["data_directory"])
        dataset = await (
            await conn.execute(
                "SELECT system_identifier::text,(SELECT oid::text FROM pg_database WHERE datname=current_database()) database_oid FROM pg_control_system()"
            )
        ).fetchone()
        identity_schema = await PgSnapshot().schema(conn)
        resource_schema = await pg_schema(conn)
    info = conninfo_to_dict(admin_url)
    info["user"] = role
    definition = SourceDefinition(
        "synthetic-resources",
        "synthetic-old-instance",
        "postgres",
        (OWNER,),
        "America/New_York",
        schema_digest(identity_schema),
        make_conninfo(**info),
        database,
        directory,
        role,
        expected_dataset_identity={
            "kind": "postgres",
            "systemIdentifier": dataset["system_identifier"],
            "databaseOid": dataset["database_oid"],
        },
     migration_window=active_window())
    yield SyntheticSource(definition, schema_digest(resource_schema), root, admin_url, None)
    async with await psycopg.AsyncConnection.connect(pg.get_uri(), autocommit=True) as conn:
        await conn.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(database)))
        await conn.execute(sql.SQL("DROP ROLE {}").format(sql.Identifier(role)))


@pytest_asyncio.fixture
async def settings(pg, tmp_path, source):
    database = "alcor_test_resource_import_" + uuid4().hex
    with psycopg.connect(pg.get_uri(), autocommit=True) as conn:
        conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(database)))
    settings = Settings(
        database_url=pg.get_uri(database=database),
        instance_id=uuid4(),
        environment="local",
        public_origin="http://testserver",
        redis_url=None,
        connection_targets=[],
        connection_secret_dir=tmp_path / "secrets",
        backup_dir=None,
        backup_secret_dir=None,
        file_root=tmp_path.resolve() / "target-files",
        restore_targets=[],
    )
    assert settings.migration_dir.resolve() == (ROOT / "migrations").resolve()
    await migrate(settings, database, initialize_empty=True)
    private = tmp_path.resolve() / "operator-registry"
    private.mkdir(mode=0o700)
    definition = source.definition
    sources = private / "sources.json"
    sources.write_text(
        json.dumps(
            {
                "version": 2,
                "platformInstance": str(settings.instance_id),
                "sources": [
                    {
                        "alias": definition.alias,
                        "instance": definition.instance,
                        "kind": definition.kind,
                        "owners": list(definition.owners),
                        "timezone": definition.timezone,
                        "schemaHash": definition.expected_schema_hash,
                        "locator": definition.locator,
                        "expectedDatabase": definition.expected_database,
                        "expectedDataDirectory": str(definition.expected_data_directory)
                        if definition.expected_data_directory
                        else None,
                        "expectedRole": definition.expected_role,
                        "expectedFileIdentity": definition.expected_file_identity,
                        "expectedDatasetIdentity": definition.expected_dataset_identity,
                     "migrationWindow": active_window().document()}
                ],
            }
        )
    )
    sources.chmod(0o600)
    resources = private / "resources.json"
    info = source.root.stat()
    resources.write_text(
        json.dumps(
            {
                "version": 1,
                "platformInstance": str(settings.instance_id),
                "resources": [
                    {
                        "sourceAlias": definition.alias,
                        "resourceSchemaHash": source.schema_hash,
                        "root": str(source.root),
                        "rootIdentity": [info.st_dev, info.st_ino],
                        "layout": "owner-sha256-fileid-v1",
                    }
                ],
            }
        )
    )
    resources.chmod(0o600)
    settings.legacy_source_registry_path = sources
    settings.resource_import_registry_path = resources
    yield settings
    with psycopg.connect(pg.get_uri(), autocommit=True) as conn:
        conn.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(database)))


@pytest_asyncio.fixture
async def app(settings):
    app = create_app(settings)
    async with app.router.lifespan_context(app):
        yield app


@pytest_asyncio.fixture
async def client(app):
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
        base_url="http://testserver",
        headers={"origin": "http://testserver"},
    ) as client:
        yield client


@pytest_asyncio.fixture
async def admin(settings, client):
    from alcor_api.cli import create_user

    owner = await create_user(settings, "ResourceAdmin", "Synthetic9Pass")
    result = await client.post(
        "/api/session/login", json={"login": "ResourceAdmin", "password": "Synthetic9Pass"}
    )
    assert result.status_code == 200, result.text
    client.headers["x-csrf-token"] = result.json()["csrf"]
    return owner


async def claim(client, owner, source):
    result = await client.post(
        "/api/legacy-financial/authorizations",
        json={
            "requestId": str(uuid4()),
            "sourceAlias": source.definition.alias,
            "sourceOwner": OWNER,
            "targetUserId": owner,
        },
    )
    assert result.status_code == 200, result.text
    identifier = result.json()["grantId"]
    result = await client.post(
        "/api/legacy-financial/authorizations/" + identifier + "/consent",
        json={
            "requestId": str(uuid4()),
            "revision": 1,
            "password": "Synthetic9Pass",
            "code": "",
            "approve": True,
        },
    )
    assert result.status_code == 200, result.text
    result = await client.post(
        "/api/legacy-financial/authorizations/" + identifier + "/snapshots",
        json={"requestId": str(uuid4()), "grantRevision": 2, "predecessorHash": None},
    )
    assert result.status_code == 200 and result.json()["state"] == "completed", result.text
    return identifier


async def authorize(client, owner, source, established=False):
    if not established:
        await claim(client, owner, source)
    result = await client.post(
        "/api/resource-import/authorizations",
        json={
            "requestId": str(uuid4()),
            "sourceAlias": source.definition.alias,
            "sourceOwner": OWNER,
            "targetUserId": owner,
        },
    )
    assert result.status_code == 200, result.text
    identifier = result.json()["consentId"]
    result = await client.post(
        "/api/resource-import/authorizations/" + identifier + "/consent",
        json={
            "requestId": str(uuid4()),
            "revision": 1,
            "password": "Synthetic9Pass",
            "code": "",
            "approve": True,
        },
    )
    assert result.status_code == 200, result.text
    return identifier


async def snapshot(client, identifier):
    request = str(uuid4())
    result = await client.post(
        "/api/resource-import/authorizations/" + identifier + "/snapshots",
        json={"requestId": request, "revision": 2},
    )
    assert result.status_code == 200 and result.json()["state"] == "completed", result.text
    return result.json()["manifestId"], request


async def segment(client, manifest, max_items=32, retry=False):
    result = await client.post(
        "/api/resource-import/manifests/" + manifest + "/preview", json={"revision": 2}
    )
    assert result.status_code == 200, result.text
    command = {
        "requestId": str(uuid4()),
        "revision": 2,
        "preview": result.json()["preview"],
        "maxItems": max_items,
        "retryBlocked": retry,
    }
    result = await client.post("/api/resource-import/manifests/" + manifest + "/segments", json=command)
    assert result.status_code == 200, result.text
    return result.json(), command
