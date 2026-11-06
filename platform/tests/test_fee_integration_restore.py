from legacy_fee_source_fixture import old_pg
from actual_fee_test_support import actual_case,actual_operation
"""Actual migrations/create_app, shared budget, single receipt routing and encrypted recovery."""

from datetime import UTC, datetime
from uuid import UUID, uuid4

import httpx
import test_backups as backup_tests
from alcor_api.main import create_app
from alcor_api.native_app_auth import issue_grant
from fee_source_test_helpers import identity
from test_fee_plans import payload
from test_fee_repairs import operation, seed
from test_fee_repairs import request as repair_request

configured = backup_tests.configured
backup_app = backup_tests.backup_app
bc = backup_tests.bc


async def financial_state(db):
    tables = (
        "actual_fee_confirmations",
        "legacy_fee_baseline_bindings",
        "legacy_fee_source_account_bindings",
        "legacy_source_manifests",
        "legacy_source_view_bindings",
        "legacy_source_owner_claims",
        "trade_ledger",
        "cash_ledger_entries",
        "cash_ledger_collections",
        "cash_ledger_accounts",
        "portfolio_records",
        "portfolio_record_collections",
        "trade_fee_corrections",
        "trade_fee_projections",
        "trade_fee_details",
        "trade_operations",
        "fee_plan_heads",
        "fee_plan_revisions",
        "fee_plan_operations",
        "fee_legacy_inventory_heads",
        "fee_legacy_inventory_snapshots",
        "fee_legacy_inventory_orders",
        "trade_fee_import_evidence",
        "fee_legacy_inventory_receipts",
    )
    async with db.connection() as conn:
        return {
            name: await (await conn.execute("SELECT * FROM " + name + " ORDER BY 1,2")).fetchall()
            for name in tables
        }


async def test_real_migrations_single_shared_receipt_dispatch_and_shared_owner_budget(client, admin, db, app):
    paths = [getattr(route, "path", None) for route in app.routes]
    assert paths.count("/api/v{version}/account-assets/operations/{request_id}") == 1
    async with db.connection() as conn:
        migrations = await (await conn.execute("SELECT name FROM schema_migrations ORDER BY name")).fetchall()
        assert all(
            any(row["name"] == name for row in migrations)
            for name in ("0028_fee_plans.sql", "0029_fee_repairs.sql", "0030_fee_source_inventory.sql")
        )
        user = await (await conn.execute("SELECT * FROM users WHERE id=%s", (admin,))).fetchone()
        pair = await issue_grant(conn, user, "portfolio.read orders.write", "Budget fixture")
        await conn.execute(
            "INSERT INTO fee_rate_windows VALUES(%s,date_trunc('minute',clock_timestamp()),29)", (admin,)
        )
    # The canonical request consumes attempt30 even when its body is rejected.
    assert (await client.post("/api/fees/repairs/preview", json={})).status_code == 422
    for path, headers in (
        ("/api/v1/account-assets/fee-repairs/preview", {"authorization": "Bearer " + pair["access_token"]}),
        ("/api/v2/account-assets/fee-repairs/preview", {"authorization": "Bearer " + pair["access_token"]}),
        ("/api/fees/plans/preview", {}),
        ("/api/fees/source-attributions/preview", {}),
    ):
        result = await client.post(path, json={}, headers=headers)
        assert result.status_code == 429, (path, result.text)
        if "/api/v" in path:
            assert result.headers["x-alcor-api-version"] == ("1" if "/api/v1/" in path else "2")
    async with db.connection() as conn:
        assert not await (await conn.execute("SELECT 1 FROM trade_ledger")).fetchone()
        assert not await (await conn.execute("SELECT 1 FROM cash_ledger_entries")).fetchone()


async def test_actual_encrypted_restore_keeps_original_fee_correction_receipts_and_source_evidence(bc,backup_app,configured,old_pg,pg,tmp_path):
    db = backup_app.state.db
    who = await identity(bc, db)
    manual_aid,last=await seed(bc,db,legacy=False,explicit_zero=True)
    async with actual_case(bc,who.id,backup_app,old_pg,pg,tmp_path,fee="1.03",opening_at="2026-09-01T12:00:00Z") as (bc,source_app,grant,exported,aid,fill,data):
        plan_data=payload(aid)
        plan=await operation(bc,'/api/fees/plans',plan_data)
        # Plans change the preview dependencies. Read a new actual-fee snapshot.
        snapshot=(await bc.get('/api/fees/confirmations',params={'brokerAccountId':aid})).json()
        data={**data,'snapshotRevision':snapshot['snapshotRevision']}
        corrected,preview=await actual_operation(bc,data)
        assert corrected['state']=='completed' and corrected['authority']=='owner_recorded'
        body={'data':data,'preview':preview['previewRevision']}
        current=fill['record']
        pending_data = payload(aid)
        pending_preview = await bc.post("/api/fees/plans/preview", json=pending_data)
        assert pending_preview.status_code == 200, pending_preview.text
        before = await financial_state(db)
        backup_id, _ = await backup_tests.create_capsule(bc, backup_app, configured)
        restore_preview = await bc.get(
            "/api/backups/" + backup_id + "/restore-preview", params={"target_id": "isolated-qa"}
        )
        assert restore_preview.status_code == 200, restore_preview.text
        task, _ = await backup_tests.submit(
            bc,
            "backup.restore",
            backup_id=backup_id,
            target_id="isolated-qa",
            restore_ticket=restore_preview.json()["restore_ticket"],
        )
        restored_result = await backup_tests.execute(backup_app, configured, UUID(task["id"]))
        assert restored_result["sessions_revoked"]
        target = configured.restore_targets[0]
        restored_settings = configured.model_copy(
            update={
                "database_url": target.database_url,
                "instance_id": target.instance_id,
                "environment": "test",
                "redis_url": None,
                "file_root": target.recovery_directory / "files",
                "connection_secret_dir": target.recovery_directory / "connection-secrets",
                "legacy_source_registry_path": None,
            }
        )
        recovered = create_app(restored_settings)
        async with (
            recovered.router.lifespan_context(recovered),
            httpx.AsyncClient(
                transport=httpx.ASGITransport(app=recovered, raise_app_exceptions=False),
                base_url="http://testserver",
                headers={"origin": "http://testserver"},
            ) as client,
        ):
            assert await financial_state(recovered.state.db) == before
            signed = await client.post(
                "/api/session/login", json={"login": "BackupQA", "password": "Synthetic9Pass"}
            )
            assert signed.status_code == 200, signed.text
            client.headers["x-csrf-token"] = signed.json()["csrf"]
            for path, expected in (
                ("/api/fees/confirmations/operations/" + data["requestId"], corrected),
                ("/api/fees/plans/operations/" + plan_data["requestId"], plan),
                ("/api/trading/operations/" + last["requestId"], last),
            ):
                response = await client.get(path)
                assert response.status_code == 200 and response.json() == expected, (path, response.text)
            listings = await client.get("/api/trading/fills", params={"recordId": current["id"]})
            assert listings.status_code == 200, listings.text
            by_id = {row["id"]: row for row in listings.json()["items"]}
            old = by_id[fill["tradeId"]]
            assert (
                old["originalFees"] == "0" and old["fees"] == "1.03" and old["feeSource"] == "owner_recorded" and old["actualFeeKnown"]
            )
            manual_read=await client.get('/api/trading/fills',params={'recordId':last['recordId']})
            manual_row=manual_read.json()['items'][0]
            assert manual_row['fees']=='0' and manual_row['feeDetail']['source']=='owner_recorded'
            source = await client.get("/api/fees/repairs", params={"brokerAccountId": aid})
            assert source.status_code == 200 and source.json()["legacyCoverage"]["sourceDigest"]
            # Reusing an original UUID returns its prior result without a second posting.
            assert (await client.post("/api/fees/confirmations/operations", json=body)).json() == corrected
            stale = await client.post(
                "/api/fees/plans/operations",
                json={"data": pending_data, "preview": pending_preview.json()["preview"]},
            )
            assert stale.status_code == 409
            assert await financial_state(recovered.state.db) == before


async def test_deferred_db_guard_rejects_null_source_fee_even_with_stale_application_policy(client,admin,db,app,old_pg,pg,tmp_path,monkeypatch):
    from alcor_api.actual_fee_confirmations import ActualFeeConfirmations,parse_actual
    import psycopg
    async with actual_case(client,admin,app,old_pg,pg,tmp_path,fee='1.03') as (client,source_app,grant,exported,aid,fill,data):
        preview=(await client.post('/api/fees/confirmations/preview',json=data)).json()
        who=await identity(client,db);service=source_app.state.actual_fee_confirmations
        async with db.connection() as conn:cached=await service.calculate(conn,who,parse_actual(data))
        # This is a real second authorized read-only snapshot, not an unbound
        # inventory INSERT. Raw registered fee NULL cannot borrow the old zero
        # baseline, even if application policy retains its old calculation.
        assert old_pg.expected_database.startswith('alcor_synthetic_legacy_')
        async with await psycopg.AsyncConnection.connect(pg.get_uri(database=old_pg.expected_database)) as conn:
            await conn.execute('UPDATE trade_orders SET fees=NULL WHERE id=%s',(data['confirmations'][0]['originalOrderId'],))
        read=await client.post('/api/legacy-financial/authorizations/'+grant['grantId']+'/snapshots',json={'requestId':str(uuid4()),'grantRevision':grant['grantRevision'],'predecessorHash':exported['manifestSha256']})
        assert read.status_code==200 and read.json()['state']=='completed' and not read.json()['headAdvanced'],read.text
        null_manifest=read.json()['manifestId']
        original=await client.get('/api/legacy-financial/manifests/'+null_manifest+'/raw')
        assert original.json()['tables']['trade_orders']['rows'][0]['fees']['null']
        before=await financial_state(db)
        async def stale(*args):return cached
        before_post=ActualFeeConfirmations.before_post
        async def stale_source(self,conn,who,data,state,value):
            await before_post(self,conn,who,{**data,'manifestId':null_manifest},state,value)
        with monkeypatch.context() as patch:
            patch.setattr(ActualFeeConfirmations,'calculate',stale)
            patch.setattr(ActualFeeConfirmations,'before_post',stale_source)
            result=await client.post('/api/fees/confirmations/operations',json={'data':data,'preview':preview['previewRevision']})
        assert result.status_code==200 and result.json()['state']=='failed',result.text
        after=await financial_state(db)
        assert len(after['trade_operations'])==len(before['trade_operations'])+1
        after['trade_operations']=before['trade_operations'];assert after==before
        async with db.connection() as conn:
            assert not await(await conn.execute('SELECT 1 FROM actual_fee_confirmations')).fetchone()
            assert not await(await conn.execute('SELECT 1 FROM trade_fee_corrections')).fetchone()
        assert (await client.get('/api/fees/confirmations/operations/'+data['requestId'])).json()==result.json()


async def test_fee_selection_keeps_legacy_128k_budget_without_widening_other_routes(client,admin,db,app,old_pg,pg,tmp_path):
    import json
    async with actual_case(client,admin,app,old_pg,pg,tmp_path,fee='1.03') as (client,source_app,grant,exported,aid,fill,data):
        body=json.dumps(data).encode()+b' '*70000
        async with db.connection() as conn:
            user=await(await conn.execute('SELECT * FROM users WHERE id=%s',(admin,))).fetchone()
            native=await issue_grant(conn,user,'portfolio.read orders.write','Synthetic actual fee budget')
        for path,headers in (
            ('/api/fees/confirmations/preview',{}),
            ('/api/v1/account-assets/fee-repairs/preview',{'authorization':'Bearer '+native['access_token']}),
            ('/api/v2/account-assets/fee-repairs/preview',{'authorization':'Bearer '+native['access_token']}),
        ):
            result=await client.post(path,content=body,headers={'content-type':'application/json',**headers})
            assert result.status_code==200,(path,result.text)
            result=await client.post(path,content=body+b' '*131072,headers={'content-type':'application/json',**headers})
            assert result.status_code==413,(path,result.text)
        # The older rate-only shape still receives its own schema validation,
        # rather than a widened global budget or an implicit actual confirmation.
        old=await client.post('/api/fees/repairs/preview',content=b'{}'+b' '*70000,headers={'content-type':'application/json'})
        assert old.status_code==422,old.text
        unrelated=await client.post('/api/trading/preview',content=b'{}'+b' '*70000,headers={'content-type':'application/json'})
        assert unrelated.status_code==413,unrelated.text
