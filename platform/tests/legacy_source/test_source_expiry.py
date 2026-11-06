import json
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import psycopg
import pytest
from alcor_api.main import create_app
from alcor_api.source_registry import load_registry
from alcor_api.source_snapshot import PgSnapshot, SourceDefinition,  schema_digest
from alcor_api.source_window import MigrationWindow, SourceWindowDenied, parse_window, window_state
from psycopg import sql
from source_window_fixture import active_window

from .synthetic_legacy import OWNER
from .test_source_authority import authorized, export


def update_window(settings, *, state="active", expired=False, future=False):
    document = json.loads(settings.legacy_source_registry_path.read_text())
    now = datetime.now(UTC)
    document["version"] = 2
    for item in document["sources"]:
        item["migrationWindow"] = MigrationWindow(
            now + timedelta(hours=1) if future else now - timedelta(hours=2),
            now - timedelta(hours=1) if expired else now + timedelta(hours=2),
            state,
        ).document()
    settings.legacy_source_registry_path.write_text(json.dumps(document))


@pytest.mark.parametrize(
    "raw",
    [
        None,
        {},
        {"notBefore": "2026-01-01", "expiresAt": "2026-01-02", "state": "active"},
        {"notBefore": "2026-01-01T00:00:00Z", "expiresAt": "2026-01-02T00:00:00Z", "state": "unknown"},
        {"notBefore": "2026-01-02T00:00:00Z", "expiresAt": "2026-01-01T00:00:00Z", "state": "active"},
    ],
)
def test_unknown_or_naive_or_invalid_window_has_no_implicit_allow(raw):
    assert parse_window(raw) is None


def test_exact_finite_boundary_and_revoked_state_do_not_slide_or_extend():
    start = datetime(2026, 1, 1, tzinfo=UTC)
    end = start + timedelta(days=1)
    window = MigrationWindow(start, end, "active")
    before = window.document()
    assert window_state(window, start - timedelta(microseconds=1)) == "not_started"
    assert window_state(window, start) == "active"
    assert window_state(window, end) == "expired"
    assert window_state(window, end + timedelta(days=10)) == "expired"
    assert window.document() == before
    assert window_state(replace(window, state="revoked"), start) == "revoked"


async def test_actual_pg_expiry_stops_new_export_while_old_uuid_manifest_and_raw_survive(
    client, admin, old_pg, settings, pg
):
    grant = await authorized(client, admin, old_pg)
    first, command, path = await export(client, grant)
    before = (await client.get("/api/legacy-financial/manifests/" + first["manifestId"] + "/raw")).content
    update_window(settings, expired=True)
    async with await psycopg.AsyncConnection.connect(pg.get_uri(), autocommit=True) as conn:
        await conn.execute(sql.SQL("ALTER ROLE {} NOLOGIN").format(sql.Identifier(old_pg.expected_role)))
    response = await client.post(
        path, json={**command, "requestId": str(uuid4()), "predecessorHash": first["manifestSha256"]}
    )
    assert response.status_code == 409 and "已到期" in response.text, response.text
    assert (await client.post(path, json=command)).json() == first
    assert (await client.get("/api/legacy-financial/operations/" + command["requestId"])).json() == first
    assert (
        await client.get("/api/legacy-financial/manifests/" + first["manifestId"] + "/raw")
    ).content == before
    assert (await client.get("/api/legacy-financial/authorizations")).json()["items"][0]["migrationWindow"][
        "state"
    ] == "expired"


async def test_runtime_operator_revoke_future_and_v1_unknown_never_reopen_source_without_restart(
    client, admin, old_pg, settings
):
    grant = await authorized(client, admin, old_pg)
    first, command, path = await export(client, grant)
    for opts, state in [({"state": "revoked"}, "revoked"), ({"future": True}, "not_started")]:
        update_window(settings, **opts)
        response = await client.post(
            path, json={**command, "requestId": str(uuid4()), "predecessorHash": first["manifestSha256"]}
        )
        assert response.status_code == 409, response.text
        assert (await client.get("/api/legacy-financial/authorizations")).json()["items"][0][
            "migrationWindow"
        ]["state"] == state
    document = json.loads(settings.legacy_source_registry_path.read_text())
    document["version"] = 1
    for item in document["sources"]:
        item.pop("migrationWindow")
    settings.legacy_source_registry_path.write_text(json.dumps(document))
    definition = load_registry(settings)[old_pg.alias]
    assert definition.window_status()["state"] == "unknown"
    with pytest.raises(SourceWindowDenied, match="unknown"):
        await PgSnapshot().export(definition, OWNER)
    # Legacy metadata can still mount for saved-evidence reads; it is not an unlimited permit.
    app = create_app(settings)
    assert app.state.source_authority.registry[old_pg.alias].window_status()["state"] == "unknown"
    # Missing or malformed v2 expiry is also metadata-only, never a startup permit.
    for marker in (None, {"state": "active"}):
        document["version"] = 2
        if marker is None:
            document["sources"][0].pop("migrationWindow", None)
        else:
            document["sources"][0]["migrationWindow"] = marker
        settings.legacy_source_registry_path.write_text(json.dumps(document))
        unavailable = load_registry(settings)[old_pg.alias]
        assert unavailable.window_status()["state"] == "unknown"
        with pytest.raises(SourceWindowDenied, match="unknown"):
            await PgSnapshot().export(unavailable, OWNER)
        assert (
            create_app(settings).state.source_authority.registry[old_pg.alias].window_status()["state"]
            == "unknown"
        )

    assert (await client.get("/api/legacy-financial/manifests/" + first["manifestId"])).status_code == 200






async def test_actual_pg_batch_fences_abort_if_operator_revokes_after_one_table(old_pg, tmp_path):
    # SourceDefinition is immutable; use a mutable operator callback only to create a
    # genuine policy change between real source table reads, never replace SQL.
    registry = tmp_path / "registry"
    registry.mkdir(mode=0o700)
    file = registry / "source.json"
    platform = uuid4()
    document = {
        "version": 2,
        "platformInstance": str(platform),
        "sources": [
            {
                "alias": old_pg.alias,
                "instance": old_pg.instance,
                "kind": "postgres",
                "owners": list(old_pg.owners),
                "timezone": old_pg.timezone,
                "schemaHash": old_pg.expected_schema_hash,
                "locator": old_pg.locator,
                "expectedDatabase": old_pg.expected_database,
                "expectedDataDirectory": str(old_pg.expected_data_directory),
                "expectedRole": old_pg.expected_role,
                "expectedFileIdentity": None,
                "expectedDatasetIdentity": old_pg.expected_dataset_identity,
                "migrationWindow": active_window().document(),
            }
        ],
    }
    file.write_text(json.dumps(document))
    file.chmod(0o600)
    from types import SimpleNamespace

    definition = load_registry(SimpleNamespace(legacy_source_registry_path=file, instance_id=platform))[
        old_pg.alias
    ]
    seen = []

    async def revoke(table):
        seen.append(table)
        document["sources"][0]["migrationWindow"]["state"] = "revoked"
        file.write_text(json.dumps(document))

    with pytest.raises(SourceWindowDenied, match="revoked"):
        await PgSnapshot().export(definition, OWNER, after_table=revoke)
    assert len(seen) == 1
