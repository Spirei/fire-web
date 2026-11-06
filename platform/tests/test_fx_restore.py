"""Real isolated restore cannot turn copied reference tasks into provider requests."""

from datetime import UTC, datetime
from uuid import UUID, uuid4

import psycopg
import pytest
import test_backups as backup_tests
from alcor_api.fx_reference import PROVIDER, persist
from psycopg.rows import dict_row
from test_fx_reference import RAW

backup_app = backup_tests.backup_app
bc = backup_tests.bc
configured = backup_tests.configured


@pytest.mark.asyncio
async def test_restore_disables_provider_and_preserves_original_request_results(bc, backup_app, configured):
    import hashlib

    identifiers = {state: uuid4() for state in ("queued", "running", "completed", "failed")}
    requests = {state: uuid4() for state in identifiers}
    principal = hashlib.sha256(b"public:isolated-restore").hexdigest()
    async with backup_app.state.db.connection() as conn, conn.transaction():
        await conn.execute("UPDATE fx_config SET enabled=true,revision=7")
        observed = await persist(conn, RAW, datetime.now(UTC), uuid4())
        for state, identifier in identifiers.items():
            await conn.execute(
                "INSERT INTO fx_refresh_tasks(id,provider,state,started_at,completed_at,observation_id,error_code) "
                "VALUES(%s,%s,%s,CASE WHEN %s='queued' THEN NULL ELSE clock_timestamp() END,"
                "CASE WHEN %s IN ('completed','failed') THEN clock_timestamp() ELSE NULL END,%s,%s)",
                (
                    identifier,
                    PROVIDER,
                    state,
                    state,
                    state,
                    observed if state == "completed" else None,
                    "provider_unavailable" if state == "failed" else None,
                ),
            )
            await conn.execute(
                "INSERT INTO fx_requests VALUES(%s,%s,%s)", (requests[state], principal, identifier)
            )
        previous = await (
            await conn.execute(
                "SELECT * FROM fx_refresh_tasks WHERE state IN ('completed','failed') ORDER BY id"
            )
        ).fetchall()
        original_requests = await (
            await conn.execute("SELECT * FROM fx_requests ORDER BY request_id")
        ).fetchall()
    backup_id, _ = await backup_tests.create_capsule(bc, backup_app, configured)
    preview = await bc.get(
        "/api/backups/" + backup_id + "/restore-preview", params={"target_id": "isolated-qa"}
    )
    assert preview.status_code == 200, preview.text
    job, _ = await backup_tests.submit(
        bc,
        "backup.restore",
        backup_id=backup_id,
        target_id="isolated-qa",
        restore_ticket=preview.json()["restore_ticket"],
    )
    result = await backup_tests.execute(backup_app, configured, UUID(job["id"]))
    assert result["sessions_revoked"]
    async with await psycopg.AsyncConnection.connect(
        configured.restore_targets[0].database_url.get_secret_value(), row_factory=dict_row
    ) as conn:
        config = await (await conn.execute("SELECT * FROM fx_config")).fetchone()
        assert config["enabled"] is False and config["revision"] == 8
        rows = await (await conn.execute("SELECT * FROM fx_refresh_tasks ORDER BY id")).fetchall()
        by_id = {row["id"]: row for row in rows}
        assert by_id[identifiers["queued"]]["state"] == "failed"
        assert by_id[identifiers["queued"]]["started_at"] is None
        assert by_id[identifiers["running"]]["state"] == "interrupted"
        for state in ("queued", "running"):
            assert by_id[identifiers[state]]["error_code"] == "restore_requires_review"
            assert by_id[identifiers[state]]["observation_id"] is None
        assert [
            row for row in rows if row["id"] in {identifiers["completed"], identifiers["failed"]}
        ] == previous
        assert (
            await (await conn.execute("SELECT * FROM fx_requests ORDER BY request_id")).fetchall()
            == original_requests
        )
        assert (
            await (
                await conn.execute(
                    "SELECT payload FROM restore_quarantine WHERE category='external_delivery_disabled'"
                )
            ).fetchone()
        )["payload"] == {"disabled": True}
        assert (await (await conn.execute("SELECT count(*) AS n FROM fx_observations")).fetchone())["n"] == 1


@pytest.mark.asyncio
async def test_custom_vault_key_survives_encrypted_restore_disabled(bc, backup_app, configured):
    from pathlib import Path

    from alcor_api.connections import Vault
    from alcor_api.fx_custom import kind, vault
    from psycopg.types.json import Jsonb

    identifier = uuid4()
    cipher = vault(backup_app.state.db).encrypt(
        "synthetic-query-secret", kind(identifier), configured.instance_id
    )
    async with backup_app.state.db.connection() as conn:
        await conn.execute(
            "INSERT INTO fx_provider_revisions(id,config,secret_cipher,credential_instance) VALUES(%s,%s,%s,%s)",
            (identifier, Jsonb({"url": "https://provider.example/rates"}), cipher, configured.instance_id),
        )
        await conn.execute("UPDATE fx_config SET provider_revision=%s,enabled=true", (identifier,))
    backup_id, _ = await backup_tests.create_capsule(bc, backup_app, configured)
    preview = await bc.get(
        "/api/backups/" + backup_id + "/restore-preview", params={"target_id": "isolated-qa"}
    )
    job, _ = await backup_tests.submit(
        bc,
        "backup.restore",
        backup_id=backup_id,
        target_id="isolated-qa",
        restore_ticket=preview.json()["restore_ticket"],
    )
    await backup_tests.execute(backup_app, configured, UUID(job["id"]))
    restored_vault = Vault(
        Path(configured.restore_targets[0].recovery_directory) / "connection-secrets" / "fx-providers"
    )
    assert (
        restored_vault.decrypt(cipher, kind(identifier), configured.instance_id) == "synthetic-query-secret"
    )
    async with await psycopg.AsyncConnection.connect(
        configured.restore_targets[0].database_url.get_secret_value(), row_factory=dict_row
    ) as conn:
        config = await (await conn.execute("SELECT enabled,provider_revision FROM fx_config")).fetchone()
        assert config == {"enabled": False, "provider_revision": identifier}
        row = await (
            await conn.execute("SELECT secret_cipher,credential_instance FROM fx_provider_revisions")
        ).fetchone()
        assert row["secret_cipher"] == cipher and row["credential_instance"] == configured.instance_id
