import hashlib
from uuid import uuid4

import httpx
import psycopg
import pytest
from alcor_api.main import create_app
from legacy_source.test_source_authority import authorized
from source_archive_candidate.test_archive import expire, revoke
from test_watch_group_icons import native
from watch_group_import_candidate.test_watch_import import apply, capture, hashes, preview
from watch_group_source_icons_candidate.conftest import SVG


async def source(client, admin, old_pg):
    grant = await authorized(client, admin, old_pg); manifest, _ = await capture(client, grant)
    metadata, _ = await apply(client, manifest, await preview(client, manifest))
    return grant, manifest, metadata


async def icon_capture(client, manifest, rid=None):
    command = {'requestId': rid or str(uuid4()), 'originalGroupId': 'old-custom'}
    response = await client.post('/api/watch-group-import/manifests/'+manifest['manifestId']+'/icons/captures', json=command)
    assert response.status_code == 200, response.text
    return response.json(), command


async def icon_preview(client, captured, replace=False):
    response = await client.post('/api/watch-group-import/operations/'+captured['requestId']+'/icon-preview', json={'replaceCurrent': replace})
    assert response.status_code == 200, response.text
    return response.json()


async def icon_apply(client, captured, proof, rid=None):
    command = {'requestId': rid or str(uuid4()), 'expectedRevision': proof['groupRevision'], 'preview': proof['preview'], 'replaceCurrent': proof['replaceCurrent']}
    response = await client.post('/api/watch-group-import/operations/'+captured['requestId']+'/icon-operations', json=command)
    assert response.status_code == 200, response.text
    return response.json(), command


async def test_owned_original_capture_then_expired_unavailable_source_apply_restart_and_same_54_55_uuid_receipts(client, admin, old_pg, app, settings, icon_source):
    grant, manifest, _ = await source(client, admin, old_pg)
    _root, path, reference = icon_source; before = path.read_bytes()
    captured, command = await icon_capture(client, manifest)
    assert captured['captureState'] == 'captured' and captured['originalSha256'] == hashlib.sha256(SVG).hexdigest(), captured
    assert not captured['displayValidated'] and captured['sourceReference'] == reference
    assert path.read_bytes() == before
    raw = await client.get(captured['originalPath']); assert raw.content == SVG and raw.headers['content-type'] == 'application/octet-stream'
    assert (await client.post('/api/watch-group-import/manifests/'+manifest['manifestId']+'/icons/captures', json=command)).json() == captured
    expire(settings); path.unlink(); settings.watch_group_icon_import_registry_path.unlink()
    retired = settings.model_copy(update={'legacy_source_registry_path': None, 'watch_group_import_registry_path': None, 'watch_group_icon_import_registry_path': None})
    restarted = create_app(retired)
    async with restarted.router.lifespan_context(restarted), httpx.AsyncClient(transport=httpx.ASGITransport(app=restarted), base_url='http://testserver', headers=dict(client.headers), cookies=client.cookies) as active:
        proof = await icon_preview(active, captured); assert proof['ready'] and proof['beforeIcon'] == ''
        result, body = await icon_apply(active, captured, proof)
        assert result['state'] == 'completed' and result['sourceOriginalSha256'] == captured['originalSha256'], result
        assert result['icon']['sha256'] != captured['originalSha256']
        assert (await active.get(result['icon']['originalPath'])).content == SVG
        assert (await active.get(result['icon']['contentPath'])).content.startswith(b'<!-- by alcor -->\n<svg')
        assert (await active.get('/api/watch-group-import/operations/'+body['requestId'])).json() == result
        assert (await active.get('/api/watch-groups/operations/'+body['requestId'])).json()['icon']['version'] == result['icon']['version']
        assert (await active.post('/api/watch-group-import/operations/'+captured['requestId']+'/icon-operations', json=body)).json() == result
        assert (await active.get(captured['originalPath'])).content == SVG
        new = await active.post('/api/watch-group-import/manifests/'+manifest['manifestId']+'/icons/captures', json={**command, 'requestId': str(uuid4())})
        assert new.status_code == 409
        await revoke(active, grant)
        assert (await active.post('/api/watch-group-import/operations/'+captured['requestId']+'/icon-preview', json={})).status_code == 409
        assert (await active.get(captured['originalPath'])).content == SVG
    async with app.state.db.connection() as conn:
        assert (await (await conn.execute('SELECT count(*) n FROM watch_group_source_icon_links')).fetchone())['n'] == 1
        for table in ('legacy_source_heads', 'trade_ledger', 'cash_ledger_entries'):
            assert (await (await conn.execute('SELECT count(*) n FROM '+table)).fetchone())['n'] == 0


@pytest.mark.parametrize('reference', [None, 'https://unapproved.example.invalid/file.svg', '/uploads/asset/group/other-owner/old-custom/source.svg', '/uploads/asset/group/legacy-owner-A/old-custom/%2e%2e.svg', '/uploads/asset/group/legacy-owner-A/old-custom/%2fetc.svg', '/uploads/asset/shared.svg'])
async def test_unapproved_external_cross_owner_and_traversal_references_are_persisted_blocked_never_fetched(client, admin, old_pg, app, pg, reference):
    async with await psycopg.AsyncConnection.connect(pg.get_uri(database=old_pg.expected_database)) as conn:
        await conn.execute("UPDATE watch_groups SET icon=%s WHERE id='old-custom'", (reference,))
    _, manifest, _ = await source(client, admin, old_pg)
    captured, command = await icon_capture(client, manifest)
    assert captured['state'] == 'completed_with_blocked' and captured['captureState'] == 'blocked' and captured['originalSha256'] is None, captured
    assert not (await icon_preview(client, captured))['ready']
    assert (await client.post('/api/watch-group-import/manifests/'+manifest['manifestId']+'/icons/captures', json=command)).json() == captured
    async with app.state.db.connection() as conn:
        assert (await (await conn.execute('SELECT count(*) n FROM resource_media_objects')).fetchone())['n'] == 0


@pytest.mark.parametrize('failure', ['missing', 'symlink', 'hardlink', 'oversize'])
async def test_missing_unsafe_originals_do_not_borrow_shared_admin_assets(client, admin, old_pg, app, icon_source, failure):
    _, manifest, _ = await source(client, admin, old_pg)
    _, path, _ = icon_source
    if failure == 'missing': path.unlink()
    elif failure == 'symlink':
        original = path.with_name('private-real.svg'); path.rename(original); path.symlink_to(original)
    elif failure == 'hardlink': path.with_name('extra.svg').hardlink_to(path)
    else:
        path.chmod(0o600); path.write_bytes(b'x'*(2097152+1))
    captured, _ = await icon_capture(client, manifest)
    assert captured['captureState'] == 'blocked' and captured['originalSha256'] is None, captured


@pytest.mark.parametrize('stop', ['window_expiry', 'consent', 'close'])
async def test_mid_capture_permission_or_close_keeps_no_original_and_original_uuid_never_reads_again(client, admin, old_pg, app, settings, stop):
    grant, manifest, _ = await source(client, admin, old_pg); calls = []
    async def after():
        calls.append(True)
        if stop == 'window_expiry': expire(settings)
        elif stop == 'consent': await revoke(client, grant)
        else:
            closed = await client.post('/api/watch-group-import/operations/'+command['requestId']+'/close', json={})
            assert closed.status_code == 200 and closed.json()['state'] == 'unknown'
    command = {'requestId': str(uuid4()), 'originalGroupId': 'old-custom'}
    app.state.watch_group_source_icons.after_read = after
    path = '/api/watch-group-import/manifests/'+manifest['manifestId']+'/icons/captures'
    result = await client.post(path, json=command)
    assert result.status_code == 200, result.text
    value = result.json(); assert value['state'] == ('unknown' if stop == 'close' else 'failed'), value
    assert value['domain'] == 'source_icon' and value['manifestId'] == manifest['manifestId'] and value['originalGroupId'] == 'old-custom'
    assert (await client.post(path, json=command)).json() == value and calls == [True]
    async with app.state.db.connection() as conn:
        for table in ('resource_media_objects', 'watch_group_source_icon_captures', 'watch_group_source_icon_links'):
            assert (await (await conn.execute('SELECT count(*) n FROM '+table)).fetchone())['n'] == 0


async def test_lost_capture_and_apply_responses_recover_original_receipts_without_new_files_or_versions(client, admin, old_pg, app, icon_source):
    _, manifest, _ = await source(client, admin, old_pg)
    async def lose(_): raise RuntimeError('Synthetic lost response')
    service = app.state.watch_group_source_icons; service.after_commit = lose
    command = {'requestId': str(uuid4()), 'originalGroupId': 'old-custom'}
    route = '/api/watch-group-import/manifests/'+manifest['manifestId']+'/icons/captures'
    lost = await client.post(route, json=command); assert lost.status_code == 503
    captured = (await client.get('/api/watch-group-import/operations/'+command['requestId'])).json()
    assert captured['captureState'] == 'captured'
    icon_source[1].unlink()
    assert (await client.post(route, json=command)).json() == captured
    proof = await icon_preview(client, captured); assert proof['ready']
    body = {'requestId': str(uuid4()), 'expectedRevision': proof['groupRevision'], 'preview': proof['preview'], 'replaceCurrent': False}
    apply_route = '/api/watch-group-import/operations/'+command['requestId']+'/icon-operations'
    lost = await client.post(apply_route, json=body); assert lost.status_code == 503
    result = (await client.get('/api/watch-group-import/operations/'+body['requestId'])).json()
    assert result['state'] == 'completed'
    assert (await client.post(apply_route, json=body)).json() == result
    async with app.state.db.connection() as conn:
        assert (await (await conn.execute('SELECT count(*) n FROM watch_group_icon_versions')).fetchone())['n'] == 1
        assert (await (await conn.execute('SELECT count(*) n FROM watch_group_source_icon_links')).fetchone())['n'] == 1


async def test_old_original_id_setter_clear_upload_and_market_alias_use_same_owner_versions(client, admin, old_pg, app):
    _, manifest, metadata = await source(client, admin, old_pg)
    captured, _ = await icon_capture(client, manifest)
    result, _ = await icon_apply(client, captured, await icon_preview(client, captured))
    headers, _ = await native(app.state.db, admin)
    original = captured['sourceReference']
    for version in (1, 2):
        route = f'/api/v{version}/watch-groups/old-custom'
        setter = await client.put(route, headers=headers, json={'icon': original})
        assert setter.status_code == 200 and setter.json()['data']['group']['icon'] == result['icon']['url'], setter.text
        clear = await client.put(route, headers=headers, json={'icon': ''}); assert clear.status_code == 200
        uploaded = await client.post(route+'/icon', headers=headers, data={}, files={'file': ('again.svg', SVG)})
        assert uploaded.status_code == 200 and uploaded.json()['data']['group']['id'] == 'old-custom', uploaded.text
        assert uploaded.headers['x-alcor-request-id']
        # Actual old market ID maps to a different canonical ID, then its market
        # permission is rejected (400), instead of falsely reporting unknown404.
        assert metadata['groupMap']['old-market-US'] != 'old-market-US'
        market = await client.post(f'/api/v{version}/watch-groups/old-market-US/icon', headers=headers, files={'file': ('again.svg', SVG)})
        assert market.status_code == 400 and '市场' in market.text, market.text
    before = await hashes(app.state.db)
    assert (await client.get(captured['originalPath'])).content == SVG
    assert await hashes(app.state.db) == before


async def test_market_default_and_missing_registered_root_are_truthful_distinct_states(client, admin, old_pg, app, settings):
    _, manifest, _ = await source(client, admin, old_pg)
    market = await client.post('/api/watch-group-import/manifests/'+manifest['manifestId']+'/icons/captures', json={'requestId': str(uuid4()), 'originalGroupId': 'old-market-US'})
    assert market.status_code == 200 and market.json()['captureState'] == 'market_default' and market.json()['state'] == 'completed'
    assert market.json()['originalSha256'] is None
    settings.watch_group_icon_import_registry_path = None
    blocked, _ = await icon_capture(client, manifest)
    assert blocked['captureState'] == 'blocked' and blocked['reason'] == 'source_icon_root_not_registered'


async def test_foreign_owner_http_file_map_flags_and_revoked_consent_cannot_apply(client, admin, old_pg, app):
    grant, manifest, _ = await source(client, admin, old_pg)
    route = '/api/watch-group-import/manifests/'+manifest['manifestId']+'/icons/captures'
    forged = await client.post(route, json={'requestId': str(uuid4()), 'originalGroupId': 'old-custom', 'fileRoot': '/unapproved', 'verified': True})
    assert forged.status_code == 422
    captured, _ = await icon_capture(client, manifest); proof = await icon_preview(client, captured)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://testserver', headers={'origin': 'http://testserver'}) as other:
        registered = await other.post('/api/session/register', json={'username': 'OtherOriginalViewer', 'password': 'Synthetic9Pass'})
        other.headers['x-csrf-token'] = registered.json()['csrf']
        assert (await other.get(captured['originalPath'])).status_code == 404
        assert (await other.post('/api/watch-group-import/operations/'+captured['requestId']+'/icon-preview', json={})).status_code == 404
    await revoke(client, grant)
    denied = await client.post('/api/watch-group-import/operations/'+captured['requestId']+'/icon-operations', json={'requestId': str(uuid4()), 'expectedRevision': proof['groupRevision'], 'preview': proof['preview'], 'replaceCurrent': False})
    assert denied.status_code == 409
    assert (await client.get(captured['originalPath'])).content == SVG
    async with app.state.db.connection() as conn:
        assert (await (await conn.execute('SELECT count(*) n FROM watch_group_icon_versions')).fetchone())['n'] == 0


async def test_explicit_replacement_CAS_and_same_old_reference_with_different_originals_never_guess_latest(client, admin, old_pg, app, icon_source):
    _, manifest, _ = await source(client, admin, old_pg)
    first, _ = await icon_capture(client, manifest); one, _ = await icon_apply(client, first, await icon_preview(client, first))
    path = icon_source[1]; path.chmod(0o600); path.write_bytes(SVG.replace(b'M0 0', b'M1 1')); path.chmod(0o444)
    second, _ = await icon_capture(client, manifest)
    blocked = await icon_preview(client, second)
    assert not blocked['ready'] and blocked['blocker'] == 'current_icon_requires_explicit_replacement'
    proof = await icon_preview(client, second, True)
    change = await client.post('/api/watch-groups/operations', json={'requestId': str(uuid4()), 'expectedRevision': proof['groupRevision'], 'action': 'update', 'data': {'id': 'old-custom', 'name': 'Renamed explicitly'}})
    assert change.status_code == 200
    stale = await client.post('/api/watch-group-import/operations/'+second['requestId']+'/icon-operations', json={'requestId': str(uuid4()), 'expectedRevision': proof['groupRevision'], 'preview': proof['preview'], 'replaceCurrent': True})
    assert stale.status_code == 409
    two, _ = await icon_apply(client, second, await icon_preview(client, second, True))
    assert two['icon']['originalSha256'] != one['icon']['originalSha256']
    headers, _ = await native(app.state.db, admin)
    ambiguous = await client.put('/api/v1/watch-groups/old-custom', headers=headers, json={'icon': second['sourceReference']})
    assert ambiguous.status_code == 409 and '不同原件' in ambiguous.text
    explicit = await client.put('/api/v1/watch-groups/old-custom', headers=headers, json={'icon': two['icon']['url']})
    assert explicit.status_code == 200


async def test_unsafe_source_original_is_retained_as_attachment_but_55_never_publishes_it(client, admin, old_pg, app, icon_source):
    path = icon_source[1]; unsafe = b'<svg><script>alert(1)</script></svg>'
    path.chmod(0o600); path.write_bytes(unsafe); path.chmod(0o444)
    _, manifest, _ = await source(client, admin, old_pg)
    captured, _ = await icon_capture(client, manifest)
    assert captured['captureState'] == 'captured' and not captured['displayValidated']
    original = await client.get(captured['originalPath'])
    assert original.content == unsafe and original.headers['content-type'] == 'application/octet-stream' and original.headers['content-disposition'] == 'attachment'
    result, command = await icon_apply(client, captured, await icon_preview(client, captured))
    assert result['state'] == 'failed' and result['httpStatus'] == 400
    assert (await client.post('/api/watch-group-import/operations/'+captured['requestId']+'/icon-operations', json=command)).json() == result
    async with app.state.db.connection() as conn:
        assert (await (await conn.execute('SELECT count(*) n FROM watch_group_icon_versions')).fetchone())['n'] == 0
        assert (await (await conn.execute('SELECT count(*) n FROM watch_group_source_icon_links')).fetchone())['n'] == 0


async def test_PG_links_cannot_use_same_owner_same_bytes_from_a_different_group_and_capture_is_immutable(client, admin, old_pg, app):
    from psycopg.errors import RaiseException
    from test_watch_group_icons import group, upload

    _, manifest, _ = await source(client, admin, old_pg)
    captured, _ = await icon_capture(client, manifest)
    other = await group(client, 'Other owned group')
    response, _ = await upload(client, other, SVG, 'same.svg'); assert response.status_code == 200
    version = response.json()['icon']['version']
    async with app.state.db.connection() as conn:
        with pytest.raises(RaiseException, match='exact owner/group'):
            async with conn.transaction():
                await conn.execute('INSERT INTO watch_group_source_icon_links(owner_id,request_id,capture_request_id,target_group_id,version_id) VALUES(%s,%s,%s,%s,%s)', (admin, uuid4(), captured['requestId'], other, version))
        with pytest.raises(RaiseException, match='immutable'):
            async with conn.transaction():
                await conn.execute('DELETE FROM watch_group_source_icon_captures WHERE owner_id=%s AND request_id=%s', (admin, captured['requestId']))
