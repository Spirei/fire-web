"""Actual create_app / private source PG; source display is never an event observation."""

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

import httpx
import psycopg
import pytest
from alcor_api.source_registry import load_registry
from alcor_api.source_snapshot import canonical, sha
from alcor_api.watch_group_source_display import aggregate, project
from legacy_source.test_source_authority import authorized
from request_telemetry_tables import business_table_hashes
from watch_group_import_candidate.test_watch_import import apply, capture, preview


async def imported(client, admin, old_pg):
    grant = await authorized(client, admin, old_pg)
    captured, _ = await capture(client, grant)
    result, _ = await apply(client, captured, await preview(client, captured))
    return grant, captured, result


async def hashes(db):
    async with db.connection() as conn, conn.transaction():
        return await business_table_hashes(conn)


async def test_source_creation_is_separate_from_actual_platform_creation_and_every_GET_is_read_only(client, admin, old_pg, app):
    _, captured, _ = await imported(client, admin, old_pg)
    before = await hashes(app.state.db)
    response = await client.get('/api/watch-groups/old-custom/source-display')
    assert response.status_code == 200, response.text
    value = response.json()
    assert value['state'] == 'known' and value['sourceCreatedAt'] == '2026-01-01T00:00:00+00:00'
    assert value['sourceCreatedAt'] != value['platformCreatedAt']
    assert value['sourceTimeUse'] == 'display_metadata_only' and not value['legacyDtoContainsCreatedAt']
    source = value['sources'][0]
    assert source['manifestId'] == captured['manifestId'] and source['sourceCreatedAtRaw'] == '2026-01-01T00:00:00Z'
    assert source['legacyOrderBy'] == ['sort', 'created_at'] and source['legacyOrderKey']['sort']['text'] == '9'
    assert source['sourceRowSha256'] and source['rawSha256'] == captured['rawSha256']
    assert 'no-store' in response.headers['cache-control']
    assert (await client.get('/api/watch-groups/old-custom/source-display')).json() == value
    assert await hashes(app.state.db) == before


async def test_new_capture_requires_explicit_apply_before_source_display_changes_without_financial_head(client, admin, old_pg, app, pg):
    grant, first, _ = await imported(client, admin, old_pg)
    old = (await client.get('/api/watch-groups/old-custom/source-display')).json()
    # Controlled source-fixture mutation only; production service has SELECT role.
    async with await psycopg.AsyncConnection.connect(pg.get_uri(database=old_pg.expected_database)) as conn:
        await conn.execute("UPDATE watch_groups SET created_at='2020-07-01T12:00:00+09:00' WHERE id='old-custom'")
    next_capture, _ = await capture(client, grant)
    assert next_capture['manifestId'] != first['manifestId']
    assert (await client.get('/api/watch-groups/old-custom/source-display')).json() == old
    applied, _ = await apply(client, next_capture, await preview(client, next_capture))
    new = (await client.get('/api/watch-groups/old-custom/source-display')).json()
    assert new['sourceCount'] == 1 and new['sourceCreatedAt'] == '2020-07-01T03:00:00+00:00'
    assert new['projectionRevision'] != old['projectionRevision']
    assert new['sources'][0]['appliedRequestId'] == applied['requestId'] and new['sources'][0]['sourceCreatedAtRaw'] == '2020-07-01T12:00:00+09:00'
    async with app.state.db.connection() as conn:
        for table in ('legacy_source_heads', 'trade_ledger', 'cash_ledger_entries'):
            assert (await (await conn.execute('SELECT count(*) n FROM '+table)).fetchone())['n'] == 0


async def test_expired_source_history_remains_readable_and_source_missing_time_is_explicit_unknown(client, admin, old_pg, app, settings, pg, monkeypatch):
    from alcor_api import watch_group_source_snapshot

    async with await psycopg.AsyncConnection.connect(pg.get_uri(database=old_pg.expected_database)) as conn:
        await conn.execute("UPDATE watch_groups SET created_at='not-a-time' WHERE id='old-custom'")
    _, _, _ = await imported(client, admin, old_pg)
    path = Path(settings.legacy_source_registry_path)
    registry = json.loads(path.read_text()); registry['sources'][0]['migrationWindow'].update(expiresAt=(datetime.now(UTC)-timedelta(seconds=1)).isoformat())
    path.write_text(json.dumps(registry))
    async def forbidden(*args, **kwargs):
        raise AssertionError('Source display must never read a source')
    monkeypatch.setattr(watch_group_source_snapshot, 'capture', forbidden)
    before = await hashes(app.state.db)
    value = (await client.get('/api/watch-groups/old-custom/source-display')).json()
    assert value['state'] == 'unknown' and value['sourceCreatedAt'] is None
    assert value['sources'][0]['sourceCreatedAtRaw'] == 'not-a-time' and value['sources'][0]['legacyOrderState'] == 'stored_keys'
    assert await hashes(app.state.db) == before


async def test_two_distinct_physical_sources_for_same_market_keep_creation_conflict_instead_of_picking_one(client, admin, old_pg, app, settings, pg):
    from psycopg import sql
    from psycopg.conninfo import conninfo_to_dict, make_conninfo

    grant, _, first = await imported(client, admin, old_pg)
    market = first['groupMap']['old-market-US']
    # Permanent claims forbid relabeling one physical dataset as a second source.
    # Use a distinct generated DB/OID and explicitly revoke the first PG consent.
    revoked = await client.post('/api/legacy-financial/authorizations/'+grant['grantId']+'/consent', json={'requestId': str(uuid4()), 'revision': grant['grantRevision'], 'password': 'Synthetic9Pass', 'code': '', 'approve': False})
    assert revoked.status_code == 200, revoked.text
    name = 'alcor_synthetic_legacy_'+uuid4().hex
    assert old_pg.expected_database.startswith('alcor_synthetic_legacy_')
    async with await psycopg.AsyncConnection.connect(pg.get_uri(), autocommit=True) as conn:
        await conn.execute(sql.SQL('CREATE DATABASE {} TEMPLATE {}').format(sql.Identifier(name), sql.Identifier(old_pg.expected_database)))
    try:
        async with await psycopg.AsyncConnection.connect(pg.get_uri(database=name)) as conn:
            await conn.execute("UPDATE watch_groups SET created_at='2021-05-02T01:00:00Z' WHERE id='old-market-US'")
            oid = (await (await conn.execute('SELECT oid::text FROM pg_database WHERE datname=current_database()')).fetchone())[0]
        path = Path(settings.legacy_source_registry_path); registry = json.loads(path.read_text()); second = dict(registry['sources'][0]); second.update(alias='second-watch-source', instance='second-explicit-synthetic-instance', expectedDatabase=name, locator=make_conninfo(**{**conninfo_to_dict(old_pg.locator), 'dbname': name}), expectedDatasetIdentity={**old_pg.expected_dataset_identity, 'databaseOid': oid}); registry['sources'].append(second); path.write_text(json.dumps(registry))
        path = Path(settings.watch_group_import_registry_path); watch = json.loads(path.read_text()); watch['watchGroups'].append({**watch['watchGroups'][0], 'sourceAlias': second['alias']}); path.write_text(json.dumps(watch))
        app.state.source_authority.registry = load_registry(settings)
        definition = app.state.source_authority.registry[second['alias']]
        await imported(client, admin, definition)
        before = await hashes(app.state.db)
        response = await client.get('/api/watch-groups/' + market + '/source-display')
        assert response.status_code == 200, response.text
        value = response.json()
        assert value['state'] == 'conflict' and value['sourceCreatedAt'] is None and value['sourceCount'] == 2
        assert {r['sourceCreatedAt'] for r in value['sources']} == {'2026-01-01T00:00:00+00:00', '2021-05-02T01:00:00+00:00'}
        assert await hashes(app.state.db) == before
    finally:
        async with await psycopg.AsyncConnection.connect(pg.get_uri(), autocommit=True) as conn:
            await conn.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(name)))


async def test_owner_scope_and_native_current_grant_are_required_and_native_groups_have_no_invented_source(client, admin, old_pg, app):
    from alcor_api.native_app_auth import issue_grant

    await imported(client, admin, old_pg)
    async with app.state.db.connection() as conn:
        user = await (await conn.execute('SELECT * FROM users WHERE id=%s', (admin,))).fetchone()
        good = await issue_grant(conn, user, 'portfolio.read', 'Synthetic display reader')
        from fastapi import HTTPException
        with pytest.raises(HTTPException, match='授权范围'):
            await issue_grant(conn, user, 'profile.write', 'Synthetic wrong scope')
    read = {'authorization': 'Bearer '+good['access_token']}
    assert (await client.get('/api/watch-groups/old-custom/source-display', headers=read)).status_code == 200
    async with app.state.db.connection() as conn:
        await conn.execute("UPDATE identity_app_grants SET revoked_at=clock_timestamp() WHERE id=%s", (good['grant_id'],))
    assert (await client.get('/api/watch-groups/old-custom/source-display', headers=read)).status_code == 401
    revision = (await client.get('/api/watch-groups')).json()['revision']
    created = await client.post('/api/watch-groups/operations', json={'requestId': str(uuid4()), 'expectedRevision': revision, 'action': 'create', 'data': {'name': 'Native display'}})
    gid = created.json()['group']['id']
    value = (await client.get('/api/watch-groups/'+gid+'/source-display')).json()
    assert value['state'] == 'not_imported' and value['sourceCreatedAt'] is None and value['platformCreatedAt']
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://testserver', headers={'origin': 'http://testserver'}) as other:
        registered = await other.post('/api/session/register', json={'username': 'OtherSourceViewer', 'password': 'Synthetic9Pass'})
        other.headers['x-csrf-token'] = registered.json()['csrf']
        assert (await other.get('/api/watch-groups/old-custom/source-display')).status_code == 404


@pytest.mark.parametrize('stored', [None, 'bad-date', '2026-11-01T01:30:00', '2026-03-08T02:30:00'])
def test_missing_or_DST_ambiguous_source_creation_never_uses_platform_applied_time(stored):
    raw = canonical({'source': {'instance': 'synthetic-instance', 'owner': 'synthetic-owner', 'timezone': 'America/New_York', 'kind': 'sqlite'}, 'tables': {'watch_groups': [{'id': {'text': 'g'}, 'user_id': {'text': 'synthetic-owner'}, 'sort': {'text': '0', 'storageType': 'integer'}, 'created_at': {'text': stored, 'null': stored is None}}]}})
    source = {'source_instance': 'synthetic-instance', 'source_owner': 'synthetic-owner', 'id': uuid4(), 'raw_sha256': sha(raw), 'applied_request_id': uuid4(), 'applied_at': datetime.now(UTC)}
    result = project(source, raw, 'g')
    assert result['state'] == 'unknown' and result['sourceCreatedAt'] is None and result['sourceCreatedAtRaw'] == stored
    assert aggregate([result]) == {'state': 'unknown', 'sourceCreatedAt': None}
    assert aggregate([], truncated=True)['state'] == 'unknown_truncated_sources'


def test_actual_old_store_preserves_TEXT_sort_keys_even_when_source_instants_have_opposite_order():
    import hashlib
    import subprocess

    from frozen_legacy import source_root

    root = str(source_root('ALCOR_WATCH_LEGACY_ROOT', ['lib/watchGroupsStore.ts']))
    here = Path(__file__).parent
    evidence = json.loads((here.parent/'native_watch_groups_candidate/source-evidence.json').read_text())
    assert hashlib.sha256((Path(root)/'lib/watchGroupsStore.ts').read_bytes()).hexdigest() == evidence['source_sha256']['lib/watchGroupsStore.ts']
    rows = [{'id': 'a', 'sort': 9, 'created_at': '2026-01-01T01:00:00+14:00'}, {'id': 'b', 'sort': 9, 'created_at': '2025-12-31T23:00:00-02:00'}]
    result = json.loads(subprocess.check_output(['node', '--experimental-vm-modules', str(here/'run_old_order.cjs'), root], input=json.dumps(rows), text=True))
    assert result['memoryOnly'] and [g['dto']['id'] for g in result['groups']] == ['b', 'a']
    assert all(set(g['dto']) == {'id', 'name', 'icon', 'sort', 'visible', 'kind', 'market'} for g in result['groups'])
    raw = canonical({'source': {'instance': 's', 'owner': 'synthetic-owner', 'timezone': 'America/New_York', 'kind': 'sqlite'}, 'tables': {'watch_groups': [{'id': {'text': r['id']}, 'user_id': {'text': 'synthetic-owner'}, 'sort': {'text': str(r['sort']), 'storageType': 'integer'}, 'created_at': {'text': r['created_at'], 'storageType': 'text'}} for r in rows]}})
    source = {'source_instance': 's', 'source_owner': 'synthetic-owner', 'id': uuid4(), 'raw_sha256': sha(raw), 'applied_request_id': uuid4(), 'applied_at': datetime.now(UTC)}
    projections = [project(source, raw, r['id']) for r in rows]
    by_id = {p['originalGroupId']: p for p in projections}
    assert [p['originalGroupId'] for p in sorted(projections, key=lambda p: p['sourceCreatedAt'])] == ['a', 'b']
    for g in result['groups']:
        assert by_id[g['dto']['id']]['legacyOrderKey']['created_at']['text'] == g['raw']['created_at']
        assert by_id[g['dto']['id']]['legacyOrderBy'] == ['sort', 'created_at']
