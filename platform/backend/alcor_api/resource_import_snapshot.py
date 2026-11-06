"""Actual read-only source rows, bounded streaming into one sealed PG manifest."""

import asyncio
import stat
from pathlib import Path

import psycopg
from psycopg import sql
from psycopg.rows import dict_row

from .resource_import_registry import ResourceSourceError
from .source_snapshot import PgSnapshot, canonical, pg_cell, schema_digest

TABLES = {
    "resource_folders": (
        "folder",
        ["id", "user_id", "category", "parent_id", "name", "revision", "created_at"],
    ),
    "resource_files": (
        "file",
        [
            "id",
            "user_id",
            "category",
            "folder_id",
            "name",
            "kind",
            "mime",
            "size_bytes",
            "sha256",
            "revision",
            "created_at",
            "state",
        ],
    ),
    "resource_operations": (
        "operation",
        ["user_id", "request_id", "type", "file_id", "state", "result", "created_at"],
    ),
}
MAX_ROW = 2 * 1024 * 1024
MAX_METADATA = 128 * 1024 * 1024
MAX_ROWS = 200000


async def pg_schema(conn, check=None):
    if check:
        check()
    rows = await (
        await conn.execute(
            "SELECT table_name,column_name,data_type,udt_name,is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name=ANY(%s) ORDER BY table_name,ordinal_position",
            (list(TABLES),),
        )
    ).fetchall()
    return {
        table: [
            {
                "name": r["column_name"],
                "type": r["data_type"],
                "nativeType": r["udt_name"],
                "nullable": r["is_nullable"] == "YES",
            }
            for r in rows
            if r["table_name"] == table
        ]
        for table in TABLES
    }




def check_schema(schema, registered):
    if schema_digest(schema) != registered.schema_hash:
        raise ResourceSourceError("source_resource_schema_changed")
    for table, (_, columns) in TABLES.items():
        if schema[table] and {c["name"] for c in schema[table]} != set(columns):
            raise ResourceSourceError("source_resource_schema_not_supported")
    present = [bool(schema[t]) for t in TABLES]
    if any(present) and not all(present):
        raise ResourceSourceError("source_resource_schema_incomplete")


async def capture(definition, resource, owner, consume, after_table=None):
    definition.require_access(owner)
    if owner not in definition.owners:
        raise ResourceSourceError("source_owner_not_allowlisted")
    resource.check()
    total = 0
    counts = {}

    async def append(table, raw):
        nonlocal total
        size = len(canonical(raw))
        if size > MAX_ROW or total + size > MAX_METADATA or sum(counts.values()) >= MAX_ROWS:
            raise ResourceSourceError("source_metadata_exceeds_explicit_capture_budget")
        total += size
        counts[table] += 1
        await consume(TABLES[table][0], raw)

    if definition.kind != "postgres":
        raise ResourceSourceError("source_backend_not_supported")
    if definition.kind == "postgres":
        async with await psycopg.AsyncConnection.connect(
            definition.locator,
            autocommit=True,
            row_factory=dict_row,
            connect_timeout=5,
            options="-c statement_timeout=30000 -c lock_timeout=2000 -c idle_in_transaction_session_timeout=120000",
        ) as conn:

            async def execute(*args, **kwargs):
                definition.require_access(owner)
                return await conn.execute(*args, **kwargs)

            await execute("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
            try:
                actual = await (
                    await execute(
                        "SELECT current_database() database,current_user role,current_setting('data_directory') directory,current_setting('transaction_read_only') ro,current_setting('transaction_isolation') isolation,current_setting('server_encoding') encoding,pg_current_snapshot()::text snapshot,(SELECT oid::text FROM pg_database WHERE datname=current_database()) database_oid,system_identifier::text FROM pg_control_system()"
                    )
                ).fetchone()
                dataset = {
                    "kind": "postgres",
                    "systemIdentifier": actual["system_identifier"],
                    "databaseOid": actual["database_oid"],
                }
                if (
                    actual["database"] != definition.expected_database
                    or actual["role"] != definition.expected_role
                    or Path(actual["directory"]).resolve() != definition.expected_data_directory.resolve()
                    or actual["ro"] != "on"
                    or actual["isolation"] != "repeatable read"
                    or actual["encoding"] != "UTF8"
                    or definition.expected_dataset_identity != dataset
                ):
                    raise ResourceSourceError("source_persistent_identity_not_verified")
                if (
                    schema_digest(
                        await PgSnapshot().schema(conn, check=lambda: definition.require_access(owner))
                    )
                    != definition.expected_schema_hash
                ):
                    raise ResourceSourceError("source_identity_schema_changed")
                found = await (await execute("SELECT id FROM users WHERE id=%s LIMIT 2", (owner,))).fetchall()
                if len(found) != 1:
                    raise ResourceSourceError("source_owner_not_verified")
                schema = await pg_schema(conn, check=lambda: definition.require_access(owner))
                check_schema(schema, resource)
                for table, (_, columns) in TABLES.items():
                    counts[table] = 0
                    if not schema[table]:
                        continue
                    expressions = []
                    for i, column in enumerate(columns):
                        expressions.append(
                            sql.SQL(
                                "CASE WHEN octet_length({}::text)>%s THEN NULL ELSE {}::text END AS {}"
                            ).format(
                                sql.Identifier(column), sql.Identifier(column), sql.Identifier("v" + str(i))
                            )
                        )
                        expressions.append(
                            sql.SQL("octet_length({}::text)>%s AS {}").format(
                                sql.Identifier(column), sql.Identifier("large" + str(i))
                            )
                        )
                    identifier = "request_id" if table == "resource_operations" else "id"
                    query = sql.SQL(
                        'SELECT {} FROM {} WHERE user_id=%s ORDER BY {}::text COLLATE "C"'
                    ).format(
                        sql.SQL(",").join(expressions), sql.Identifier(table), sql.Identifier(identifier)
                    )
                    async with conn.cursor(name="resource_source_" + table) as cursor:
                        cursor.itersize = 4
                        definition.require_access(owner)
                        await cursor.execute(query, tuple([MAX_ROW, MAX_ROW] * len(columns) + [owner]))
                        while True:
                            definition.require_access(owner)
                            batch = await cursor.fetchmany(4)
                            if not batch:
                                break
                            for row in batch:
                                if any(row["large" + str(i)] for i in range(len(columns))):
                                    raise ResourceSourceError("source_resource_field_too_large")
                                raw = {
                                    c: pg_cell(
                                        row["v" + str(i)],
                                        next(v["type"] for v in schema[table] if v["name"] == c),
                                        server_encoding=actual["encoding"],
                                    )
                                    for i, c in enumerate(columns)
                                }
                                await append(table, raw)
                    if after_table:
                        await after_table(table)
                return {
                    "format": "legacy-resource-index/1",
                    "kind": "postgres",
                    "datasetIdentity": dataset,
                    "ownerVerified": True,
                    "snapshotToken": actual["snapshot"],
                    "readOnly": True,
                    "isolation": "repeatable read",
                    "schema": schema,
                    "counts": counts,
                    "rawBytes": total,
                    "metadataComplete": True,
                    "fileBytesVerified": False,
                    "filesystemSnapshot": False,
                    "globalAttachmentsIncluded": False,
                }
            finally:
                await conn.execute("ROLLBACK")
