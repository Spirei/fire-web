"""Real encrypted capsule preserves raw history and coverage without reauthorizing collection."""

from uuid import UUID, uuid4

import httpx
import test_backups as support
from alcor_api.fx_reference import external_delivery_blocked
from alcor_api.main import create_app
from alcor_api.market_authority import Policy
from alcor_api.market_worker import claim, execute, schedule
from market_latest_candidate.test_market_history import History, query

configured = support.configured
backup_app = support.backup_app
bc = support.bc


async def snapshot(db):
    async with db.connection() as conn:
        result = {}
        for table in (
            "market_facts",
            "market_source_pages",
            "market_coverage_receipts",
            "market_data_operations",
            "market_source_revocations",
        ):
            result[table] = await (
                await conn.execute(
                    "SELECT count(*) AS n,md5(string_agg(row_to_json(r)::text,'' ORDER BY row_to_json(r)::text)) AS hash FROM "
                    + table
                    + " r"
                )
            ).fetchone()
        return result


async def test_real_encrypted_restore_keeps_history_pages_coverage_revoke_and_original_uuid(
    bc, backup_app, configured
):
    authority = backup_app.state.market_candidate
    authority.policy_provider = None
    async with backup_app.state.db.connection() as conn:
        owner = (await (await conn.execute("SELECT id FROM users WHERE username='BackupQA'")).fetchone())[
            "id"
        ]
    authority.policies = (
        Policy(
            "history-restore",
            "controlled_market",
            "controlled-v1",
            "fixture",
            "f" * 64,
            owner,
            "explicit-fixture-license",
            ("bars.day",),
            ("US",),
            fixture=True,
        ),
    )
    original_uuid = str(uuid4())
    source = await bc.post(
        "/api/market/sources", json={"request_id": original_uuid, "policy_id": "history-restore"}
    )
    assert source.status_code == 200, source.text
    revision = source.json()["revision"]
    from dataclasses import asdict

    demand_uuid = str(uuid4())
    registered = await bc.post(
        "/api/market/demands",
        json={
            "request_id": demand_uuid,
            "source_revision": revision,
            "query": asdict(query()),
            "expected_revision": 0,
        },
    )
    assert registered.status_code == 200, registered.text
    history = History()
    await schedule(authority)
    first = await claim(authority.db, uuid4(), kind="market.history")
    assert await execute(authority, first, history) == "more"
    second = await claim(authority.db, uuid4(), kind="market.history")
    assert await execute(authority, second, history) == "complete"
    revoke_uuid = str(uuid4())
    revoked = await bc.request("DELETE", "/api/market/sources/" + revision, json={"request_id": revoke_uuid})
    assert revoked.status_code == 200
    before = await snapshot(backup_app.state.db)
    assert before["market_facts"]["n"] == 3 and before["market_coverage_receipts"]["n"] == 1
    backup, _ = await support.create_capsule(bc, backup_app, configured)
    preview = await bc.get("/api/backups/" + backup + "/restore-preview", params={"target_id": "isolated-qa"})
    assert preview.status_code == 200, preview.text
    job, _ = await support.submit(
        bc,
        "backup.restore",
        backup_id=backup,
        target_id="isolated-qa",
        restore_ticket=preview.json()["restore_ticket"],
    )
    await support.execute(backup_app, configured, UUID(job["id"]))
    target = configured.restore_targets[0]
    settings = configured.model_copy(
        update={
            "database_url": target.database_url,
            "instance_id": target.instance_id,
            "environment": "test",
            "redis_url": None,
            "file_root": target.recovery_directory / "files",
            "connection_secret_dir": target.recovery_directory / "connection-secrets",
            "restore_targets": [],
        }
    )
    app = create_app(settings)
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client,
    ):
        assert await snapshot(app.state.db) == before
        async with app.state.db.connection() as conn:
            assert await external_delivery_blocked(conn)
            coverage = await (await conn.execute("SELECT * FROM market_coverage_receipts")).fetchone()
            assert coverage["point_count"] == 2 and len(coverage["page_ids"]) == 2
            assert coverage["assurance"] == "controlled_terminal_pages"
            for request_id in (original_uuid, demand_uuid, revoke_uuid):
                assert (
                    await (
                        await conn.execute(
                            "SELECT result FROM market_data_operations WHERE request_id=%s", (request_id,)
                        )
                    ).fetchone()
                )["result"]
        client.cookies.update(bc.cookies)
        assert (await client.get("/api/market/operations/" + demand_uuid)).status_code == 401
