"""Captured PG evidence survives source retirement; live platform consent does not."""

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

import httpx
import psycopg
from alcor_api.main import create_app
from legacy_source.test_financial_mapping import mapping_command
from legacy_source.test_source_authority import authorized, export, target
from watch_group_import_candidate.test_watch_import import apply, capture, preview


def expire(settings):
    path = Path(settings.legacy_source_registry_path)
    registry = json.loads(path.read_text())
    registry['sources'][0]['migrationWindow'].update(expiresAt=(datetime.now(UTC)-timedelta(seconds=1)).isoformat())
    path.write_text(json.dumps(registry))


async def revoke(client, grant):
    response = await client.post('/api/legacy-financial/authorizations/'+grant['grantId']+'/consent', json={'requestId': str(uuid4()), 'revision': grant['grantRevision'], 'password': 'Synthetic9Pass', 'code': '', 'approve': False})
    assert response.status_code == 200, response.text


async def test_financial_archive_import_and_mapping_work_after_expiry_source_registry_removed_and_restart(client, admin, old_pg, app, settings, pg):
    grant = await authorized(client, admin, old_pg); snapshot, _, _ = await export(client, grant)
    account, record = await target(client)
    data = {'requestId': str(uuid4()), 'sourceId': snapshot['sourceId'], 'sourceHash': snapshot['financialSha256'], 'confirmedSourceOwner': old_pg.owners[0], 'targetUserId': admin, 'accountMap': {'old-broker-1': account}, 'recordMap': {'old-record-1': record}, 'confirmedHistoricalOnly': True}
    expire(settings)
    failed = await client.post('/api/legacy-financial/authorizations/'+grant['grantId']+'/snapshots', json={'requestId': str(uuid4()), 'grantRevision': grant['grantRevision'], 'predecessorHash': snapshot['manifestSha256']})
    assert failed.status_code == 409 and '到期' in failed.text
    # Only this verified synthetic role/database is made unavailable.
    assert old_pg.expected_database.startswith('alcor_synthetic_legacy_') and old_pg.expected_role.startswith('alcor_source_reader_')
    async with await psycopg.AsyncConnection.connect(pg.get_uri(), autocommit=True) as conn:
        from psycopg import sql
        await conn.execute(sql.SQL('ALTER ROLE {} NOLOGIN').format(sql.Identifier(old_pg.expected_role)))
    import pytest
    with pytest.raises(psycopg.OperationalError, match='not permitted to log in'):
        await psycopg.AsyncConnection.connect(old_pg.locator)
    Path(settings.legacy_source_registry_path).rename(Path(settings.legacy_source_registry_path).with_suffix('.retired'))
    Path(settings.watch_group_import_registry_path).rename(Path(settings.watch_group_import_registry_path).with_suffix('.retired'))
    retired = settings.model_copy(update={'legacy_source_registry_path': None, 'watch_group_import_registry_path': None})
    restarted = create_app(retired)
    async with restarted.router.lifespan_context(restarted), httpx.AsyncClient(transport=httpx.ASGITransport(app=restarted), base_url='http://testserver', headers=dict(client.headers), cookies=client.cookies) as active:
        assert restarted.state.source_authority.registry == {}
        proof = await active.post('/api/financial-import/preview', json=data)
        assert proof.status_code == 200 and proof.json()['ready'], proof.text
        result = await active.post('/api/financial-import/operations', json={'data': data, 'preview': proof.json()['preview']})
        assert result.status_code == 200 and result.json()['financialApplied'], result.text
        assert (await active.get('/api/financial-import/operations/'+data['requestId'])).json() == result.json()
        mapping = mapping_command(admin, snapshot, data)
        p = await active.post('/api/legacy-financial/mappings/preview', json=mapping)
        assert p.status_code == 200 and p.json()['ready'], p.text
        mapped = await active.post('/api/legacy-financial/mappings/operations', json={'data': mapping, 'preview': p.json()['preview']})
        assert mapped.status_code == 200 and mapped.json()['state'] == 'completed', mapped.text
        assert not mapped.json()['financialApplied']
        blocked = await active.post('/api/legacy-financial/authorizations/'+grant['grantId']+'/snapshots', json={'requestId': str(uuid4()), 'grantRevision': grant['grantRevision'], 'predecessorHash': snapshot['manifestSha256']})
        assert blocked.status_code == 409
        await revoke(active, grant)
        again = await active.post('/api/financial-import/preview', json={**data, 'requestId': str(uuid4())})
        assert again.status_code == 409 and '撤销' in again.text
        assert (await active.get('/api/financial-import/operations/'+data['requestId'])).json() == result.json()
        assert (await active.post('/api/legacy-financial/mappings/preview', json={**mapping, 'requestId': str(uuid4()), 'expectedMappingRevision': 1})).status_code == 409


async def test_watch_archive_preview_and_apply_do_not_probe_expired_removed_registry_but_PG_revoke_still_denies(client, admin, old_pg, app, settings):
    grant = await authorized(client, admin, old_pg); captured, _ = await capture(client, grant)
    expire(settings)
    Path(settings.legacy_source_registry_path).unlink(); Path(settings.watch_group_import_registry_path).unlink()
    app.state.source_authority.registry = {}
    proof = await preview(client, captured)
    result, _ = await apply(client, captured, proof)
    assert result['groupMap']['old-custom'] == 'old-custom' and not result['financialHeadAdvanced']
    new = await client.post('/api/watch-group-import/authorizations/'+grant['grantId']+'/snapshots', json={'requestId': str(uuid4()), 'grantRevision': grant['grantRevision']})
    assert new.status_code == 409
    next_proof = await preview(client, captured)
    await revoke(client, grant)
    denied = await client.post('/api/watch-group-import/manifests/'+captured['manifestId']+'/preview', json={})
    assert denied.status_code == 409 and '撤销' in denied.text
    denied = await client.post('/api/watch-group-import/manifests/'+captured['manifestId']+'/operations', json={'requestId': str(uuid4()), 'preview': next_proof['preview'], 'expectedGroupRevision': next_proof['groupRevision'], 'expectedRecordRevision': next_proof['recordRevision']})
    assert denied.status_code == 409
    assert (await client.get('/api/watch-group-import/manifests/'+captured['manifestId']+'/raw')).status_code == 200
    assert (await client.get('/api/watch-group-import/operations/'+result['requestId'])).json() == result


async def test_unaccepted_archive_manifest_foreign_owner_and_instance_cannot_borrow_active_grant(client, admin, old_pg, app):
    from types import SimpleNamespace

    import pytest
    from fastapi import HTTPException

    grant = await authorized(client, admin, old_pg)
    async with app.state.db.connection() as conn, conn.transaction():
        with pytest.raises(HTTPException, match='永久'):
            await app.state.source_authority.archive_grant(conn, SimpleNamespace(id=admin), grant['grantId'], grant['grantRevision'], manifest_id=uuid4())
    captured, _ = await capture(client, grant)
    async with app.state.db.connection() as conn, conn.transaction():
        who = SimpleNamespace(id=admin)
        with pytest.raises(HTTPException, match='清单不存在'):
            await app.state.source_authority.archive_grant(conn, who, grant['grantId'], grant['grantRevision'], manifest_id=uuid4(), archive_kind='watch_groups')
        with pytest.raises(HTTPException, match='撤销或版本'):
            await app.state.source_authority.archive_grant(conn, SimpleNamespace(id='foreign'), grant['grantId'], grant['grantRevision'], manifest_id=captured['manifestId'], archive_kind='watch_groups')
        # Even matching raw bytes and a current claim are not a capture receipt.
        fake = uuid4()
        await conn.execute('INSERT INTO watch_group_source_manifests(owner_id,id,request_id,grant_id,grant_revision,source_instance,source_owner,physical_identity_hash,binding_hash,metadata_binding_hash,schema_hash,raw,raw_sha256,manifest) SELECT owner_id,%s,%s,grant_id,grant_revision,source_instance,source_owner,physical_identity_hash,binding_hash,metadata_binding_hash,schema_hash,raw,raw_sha256,manifest FROM watch_group_source_manifests WHERE owner_id=%s AND id=%s', (fake, uuid4(), admin, captured['manifestId']))
        with pytest.raises(HTTPException, match='捕获回执'):
            await app.state.source_authority.archive_grant(conn, who, grant['grantId'], grant['grantRevision'], manifest_id=fake, archive_kind='watch_groups')
        original = app.state.db.settings.instance_id; app.state.db.settings.instance_id = uuid4()
        try:
            with pytest.raises(HTTPException, match='撤销或版本'):
                await app.state.source_authority.archive_grant(conn, who, grant['grantId'], grant['grantRevision'], manifest_id=captured['manifestId'], archive_kind='watch_groups')
        finally:
            app.state.db.settings.instance_id = original
