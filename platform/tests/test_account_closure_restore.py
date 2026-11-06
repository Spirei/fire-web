"""Actual encrypted restore preserves closure evidence without reusing capabilities."""

from uuid import UUID

import httpx
import test_backups as support
from alcor_api.cli import create_user
from alcor_api.main import create_app
from test_account_admin import login
from test_account_closure_receipts import PASSWORD, ROOT, command, confirm

configured = support.configured
backup_app = support.backup_app
bc = support.bc


async def test_encrypted_restore_preserves_prepared_closed_completed_but_revokes_instance_capability(
    bc, backup_app, configured
):
    completed_owner = await create_user(configured, "CompletedClosure", PASSWORD, role="user")
    await create_user(configured, "PreparedClosure", PASSWORD, role="user")
    await create_user(configured, "ClosedClosure", PASSWORD, role="user")
    completed = await login(backup_app, "CompletedClosure")
    prepared = await login(backup_app, "PreparedClosure")
    closed = await login(backup_app, "ClosedClosure")
    commands = {}
    try:
        async with backup_app.state.db.connection() as conn:
            await conn.execute(
                "INSERT INTO portfolio_records(owner_id,id,name,code,market,qty,cost) VALUES(%s,'restore-preserved','Synthetic preserved holding','SYN','US',3,21)",
                (completed_owner,),
            )
        for name, peer in [("completed", completed), ("prepared", prepared), ("closed", closed)]:
            commands[name] = await command(peer)
            assert (await peer.post(ROOT + "/prepare", json=commands[name])).status_code == 200
        assert (await confirm(completed, commands["completed"])).status_code == 200
        assert (await closed.post(ROOT + "/abort", json=commands["closed"])).status_code == 200
        async with backup_app.state.db.connection() as conn:
            evidence = await (
                await conn.execute("SELECT * FROM account_closure_intents ORDER BY owner_id,request_id")
            ).fetchall()
            actions = await (
                await conn.execute("SELECT * FROM account_actions ORDER BY owner_id,request_id")
            ).fetchall()
            finance = await (
                await conn.execute("SELECT * FROM portfolio_records WHERE owner_id=%s", (completed_owner,))
            ).fetchone()
        backup_id, _ = await support.create_capsule(bc, backup_app, configured)
        preview = await bc.get(
            "/api/backups/" + backup_id + "/restore-preview", params={"target_id": "isolated-qa"}
        )
        assert preview.status_code == 200, preview.text
        job, _ = await support.submit(
            bc,
            "backup.restore",
            backup_id=backup_id,
            target_id="isolated-qa",
            restore_ticket=preview.json()["restore_ticket"],
        )
        result = await support.execute(backup_app, configured, UUID(job["id"]))
        assert result["sessions_revoked"]
        target = configured.restore_targets[0]
        recovered = configured.model_copy(
            update={
                "database_url": target.database_url,
                "instance_id": target.instance_id,
                "environment": "test",
                "redis_url": None,
                "restore_targets": [],
                "file_root": target.recovery_directory / "files",
                "connection_secret_dir": target.recovery_directory / "connection-secrets",
            }
        )
        restored = create_app(recovered)
        async with restored.router.lifespan_context(restored):
            async with restored.state.db.connection() as conn:
                assert (
                    await (
                        await conn.execute(
                            "SELECT * FROM account_closure_intents ORDER BY owner_id,request_id"
                        )
                    ).fetchall()
                    == evidence
                )
                assert (
                    await (
                        await conn.execute("SELECT * FROM account_actions ORDER BY owner_id,request_id")
                    ).fetchall()
                    == actions
                )
                assert (
                    await (
                        await conn.execute(
                            "SELECT * FROM portfolio_records WHERE owner_id=%s", (completed_owner,)
                        )
                    ).fetchone()
                    == finance
                )
                assert not await (await conn.execute("SELECT 1 FROM sessions")).fetchone()
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=restored, raise_app_exceptions=False),
                base_url="http://testserver",
                headers={"origin": "http://testserver"},
            ) as observer:
                config = await observer.get(ROOT + "/config")
                assert config.json()["instance_id"] == str(target.instance_id) != str(configured.instance_id)
                for data in commands.values():
                    for suffix in ("receipt", "close"):
                        denied = await observer.post(
                            ROOT + "/" + data["request_id"] + "/" + suffix,
                            json={"receipt_token": data["receipt_token"]},
                        )
                        assert denied.status_code == 404, denied.text
            later = await login(restored, "PreparedClosure")
            try:
                assert (await confirm(later, commands["prepared"])).status_code == 404
                assert (await later.post(ROOT + "/abort", json=commands["prepared"])).status_code == 409
                fresh = await command(later)
                assert (await later.post(ROOT + "/prepare", json=fresh)).status_code == 200
                assert (await later.post(ROOT + "/abort", json=fresh)).status_code == 200
            finally:
                await later.aclose()
        # Restore is isolated: source capability/evidence remains usable and unchanged.
        assert (
            await prepared.post(
                ROOT + "/" + commands["prepared"]["request_id"] + "/receipt",
                json={"receipt_token": commands["prepared"]["receipt_token"]},
            )
        ).json()["state"] == "prepared"
        async with backup_app.state.db.connection() as conn:
            assert (
                await (
                    await conn.execute("SELECT * FROM account_closure_intents ORDER BY owner_id,request_id")
                ).fetchall()
                == evidence
            )
    finally:
        await completed.aclose()
        await prepared.aclose()
        await closed.aclose()
