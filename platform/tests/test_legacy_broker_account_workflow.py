"""Native old protocol commands exercise shared PG authority, never a broker transport."""

from uuid import uuid4

import pytest
from alcor_api.portfolio_records import PortfolioRecords
from test_cash_ledger import account
from test_legacy_devices import bearer, grant
from test_portfolio_records import create as create_record


@pytest.mark.parametrize('version', [1, 2])
async def test_old_binding_and_unbinding_keep_collection_cas_out_of_domain_body(client, admin, db, version):
    identifier = await account(client, name='Synthetic native binding')
    created = await create_record(PortfolioRecords(db), admin, code='SYNBIND', qty='0', cost='0')
    record_id = created['recordId']
    headers = bearer(await grant(db, admin, 'portfolio.read portfolio.write'))
    root = f'/api/v{version}/broker-accounts'
    state = await client.get(root+'/'+identifier, headers=headers)
    assert state.status_code == 200, state.text
    row = state.json()['data']
    raw = {'requestId': str(uuid4()), 'revision': row['revision'],
           'recordCollectionRevision': row['currencyUsage']['recordCollectionRevision'], 'recordIds': [record_id]}
    bound = await client.post(root+'/'+identifier+'/bindings', headers=headers, json=raw)
    assert bound.status_code == 200, bound.text
    first = bound.json()['data']
    assert first['state'] == 'completed' and first['kind'] == 'bind_records'
    assert (await client.get(root+'/operations/'+raw['requestId'], headers=headers)).json()['data'] == first
    rebound = await client.post(root+'/'+identifier+'/bindings', headers=headers, json=raw)
    assert rebound.status_code == 200 and rebound.json()['data'] == first
    state = (await client.get(root+'/'+identifier, headers=headers)).json()['data']
    unbind = {'requestId': str(uuid4()), 'revision': state['revision'],
              'recordCollectionRevision': state['currencyUsage']['recordCollectionRevision'], 'recordIds': [record_id]}
    removed = await client.post(root+'/'+identifier+'/unbindings', headers=headers, json=unbind)
    assert removed.status_code == 200, removed.text
    assert removed.json()['data']['kind'] == 'unbind_records'
    assert (await client.get(root+'/operations/'+unbind['requestId'], headers=headers)).json()['data'] == removed.json()['data']
    async with db.connection() as conn:
        record = await (await conn.execute('SELECT broker_account_id,qty,cost FROM portfolio_records WHERE owner_id=%s AND id=%s', (admin, record_id))).fetchone()
        assert record['broker_account_id'] is None and record['qty'] == 0 and record['cost'] == 0
        for table in ('trade_ledger', 'cash_ledger_entries'):
            assert not await (await conn.execute(f'SELECT 1 FROM {table} WHERE owner_id=%s', (admin,))).fetchone()


@pytest.mark.parametrize('version', [1, 2])
async def test_old_update_uuid_binds_raw_collection_cas_and_omitted_currency_replay(client, admin, db, version):
    identifier = await account(client, name='Synthetic original metadata')
    headers = bearer(await grant(db, admin, 'portfolio.read portfolio.write'))
    root = f'/api/v{version}/broker-accounts'
    original = (await client.get(root+'/'+identifier, headers=headers)).json()['data']
    raw = {'requestId': str(uuid4()), 'revision': original['revision'], 'name': 'Synthetic first update',
           'currency': 'USD', 'recordCollectionRevision': original['currencyUsage']['recordCollectionRevision']}
    changed = await client.put(root+'/'+identifier, headers=headers, json=raw)
    assert changed.status_code == 200, changed.text
    receipt = changed.json()['data']
    row = receipt['data']
    later = {**raw, 'requestId': str(uuid4()), 'revision': row['revision'], 'name': 'Synthetic later update',
             'currencies': ['USD', 'HKD', 'EUR'], 'recordCollectionRevision': row['currencyUsage']['recordCollectionRevision']}
    next_response = await client.put(root+'/'+identifier, headers=headers, json=later)
    assert next_response.status_code == 200, next_response.text
    replay = await client.put(root+'/'+identifier, headers=headers, json=raw)
    assert replay.status_code == 200 and replay.json()['data'] == receipt, replay.text
    changed_proof = await client.put(root+'/'+identifier, headers=headers,
                                    json={**raw, 'recordCollectionRevision': raw['recordCollectionRevision']+1})
    assert changed_proof.status_code == 409, changed_proof.text
    assert (await client.get(root+'/operations/'+raw['requestId'], headers=headers)).json()['data'] == receipt
    deleted = await client.request('DELETE', root+'/'+identifier, headers=headers,
                                   json={'requestId': str(uuid4()), 'revision': next_response.json()['data']['data']['revision']})
    assert deleted.status_code == 200, deleted.text
    archived_replay = await client.put(root+'/'+identifier, headers=headers, json=raw)
    assert archived_replay.status_code == 200 and archived_replay.json()['data'] == receipt


@pytest.mark.parametrize('version', [1, 2])
async def test_old_create_unknown_kind_and_icon_original_receipts(client, admin, db, version):
    from io import BytesIO

    from PIL import Image

    headers = bearer(await grant(db, admin, 'portfolio.read portfolio.write'))
    root = f'/api/v{version}/broker-accounts'
    body = {'requestId': str(uuid4()), 'name': 'Synthetic old-created account', 'providerId': None,
            'currency': 'USD', 'currencies': ['USD', 'HKD']}
    response = await client.post(root, headers=headers, json=body)
    assert response.status_code == 201, response.text
    receipt = response.json()['data']
    row = receipt['data']
    assert row['accountKind'] == 'unknown' and receipt['migration']['accountKindInferred'] is False
    identifier = row['id']
    listed = await client.get(root+'/'+identifier, headers=headers)
    assert listed.status_code == 200 and listed.json()['data']['accountKind'] == 'unknown'
    image = BytesIO()
    Image.new('RGB', (16, 16), 'blue').save(image, format='PNG')
    icon_request = str(uuid4())
    uploaded = await client.post(root+'/'+identifier+'/icon', headers=headers,
        data={'requestId': icon_request, 'revision': str(row['revision'])},
        files={'file': ('synthetic.png', image.getvalue(), 'image/png')})
    assert uploaded.status_code == 200, uploaded.text
    icon_receipt = uploaded.json()['data']
    content = await client.get(root+'/'+identifier+'/icon', headers=headers)
    assert content.status_code == 200 and content.content.startswith(b'\x89PNG')
    assert (await client.get(root+'/operations/'+icon_request, headers=headers)).json()['data'] == icon_receipt
    reset = await client.request('DELETE', root+'/'+identifier+'/icon', headers=headers,
        json={'requestId': str(uuid4()), 'revision': icon_receipt['data']['revision']})
    assert reset.status_code == 200, reset.text
    assert (await client.get(root+'/'+identifier+'/icon', headers=headers)).status_code == 404
    assert (await client.get(root+'/operations/'+icon_request, headers=headers)).json()['data'] == icon_receipt
    async with db.connection() as conn:
        stored = await (await conn.execute('SELECT account_kind FROM broker_accounts WHERE owner_id=%s AND id=%s', (admin, identifier))).fetchone()
        assert stored['account_kind'] == 'unknown'
        assert not await (await conn.execute('SELECT 1 FROM trade_ledger WHERE owner_id=%s', (admin,))).fetchone()


async def test_old_shared_directory_read_write_delete_and_native_admin_noninheritance(client, admin, db):
    # The old cookie path is an explicit Web administrator; native grants may
    # only read this shared catalogue, even for the same underlying admin user.
    pair = bearer(await grant(db, admin, 'portfolio.read portfolio.write'))
    for version in (1, 2):
        read = await client.get(f'/api/v{version}/brokers', headers=pair)
        assert read.status_code == 200 and isinstance(read.json()['data'], list)
    denied = await client.post('/api/v1/brokers', headers=pair, json={'groups': []})
    assert denied.status_code == 403, denied.text
    current = await client.get('/api/admin/shared-brokers')
    assert current.status_code == 200, current.text
    groups = current.json()['groups']
    addition = {'id': 'synthetic-old-directory', 'name': 'Synthetic shared label', 'alias': 'Synthetic alias'}
    headers = {'x-alcor-request-id': str(uuid4()), 'x-alcor-directory-revision': str(current.json()['revision'])}
    saved = await client.post('/api/v1/brokers', headers=headers, json={'groups': [*groups, addition]})
    assert saved.status_code == 200, saved.text
    assert any(row['id'] == addition['id'] for row in saved.json()['data'])
    removed = await client.delete('/api/v1/brokers?id='+addition['id'], headers={
        'x-alcor-request-id': str(uuid4()), 'x-alcor-directory-revision': saved.headers['x-alcor-directory-revision']})
    assert removed.status_code == 200, removed.text
    assert all(row['id'] != addition['id'] for row in removed.json()['data'])
    async with db.connection() as conn:
        assert not await (await conn.execute('SELECT 1 FROM broker_accounts WHERE owner_id=%s', (admin,))).fetchone()


@pytest.mark.parametrize('version', [1, 2])
async def test_old_connection_config_state_and_disable_never_fetch_or_disclose_credentials(
    client, admin, db, settings, version, monkeypatch
):
    from alcor_api.broker_flex_transport import Transport

    async def forbidden(*args, **kwargs):
        raise AssertionError('Connection metadata must not contact a broker')

    monkeypatch.setattr(Transport, 'request', forbidden)
    identifier = await account(client, name='Synthetic old connection')
    settings.broker_statement_targets = [{'owner_id': admin, 'purposes': ['statement.fetch'],
        'license_revision': 'synthetic-f07-v1', 'valid_until': '2099-01-01T00:00:00+00:00',
        'addresses': ['8.8.8.8'], 'id': 'synthetic-f07'}]
    headers = bearer(await grant(db, admin, 'portfolio.read portfolio.write'))
    root = f'/api/v{version}/broker-accounts'
    path = root+'/'+identifier+'/connection'
    initial = await client.get(path, headers=headers)
    assert initial.status_code == 200 and initial.json()['data']['configured'] is False
    request = str(uuid4())
    configured = await client.put(path, headers=headers, json={'requestId': request, 'revision': 1,
        'externalAccount': 'SYNTHETIC-F07', 'queryId': '987654', 'token': 'SYNTHETICF07TOKEN999'})
    assert configured.status_code == 200, configured.text
    state = await client.get(path, headers=headers)
    assert state.status_code == 200 and state.json()['data']['configured'] is True
    assert 'SYNTHETICF07TOKEN999' not in state.text and '987654' not in state.text
    current = state.json()['data']['migration']
    disabled = await client.request('DELETE', path, headers=headers,
        json={'requestId': str(uuid4()), 'revision': current['accountRevision']})
    assert disabled.status_code == 200, disabled.text
    final = await client.get(path, headers=headers)
    assert final.status_code == 200 and final.json()['data']['configured'] is False
    async with db.connection() as conn:
        assert not await (await conn.execute("SELECT 1 FROM broker_statement_source_attempts WHERE owner_id=%s AND kind='fetch'", (admin,))).fetchone()
        assert not await (await conn.execute('SELECT 1 FROM broker_statement_imports WHERE owner_id=%s', (admin,))).fetchone()


@pytest.mark.parametrize('version', [1, 2])
async def test_old_holding_source_preserves_original_snapshot_and_uuid(client, admin, db, version):
    from test_broker_statement_integration import BASE, XML

    identifier = await account(client, name='Synthetic old source switch')
    headers = bearer(await grant(db, admin, 'portfolio.read portfolio.write'))
    root = f'/api/v{version}/broker-accounts'
    row = (await client.get(root+'/'+identifier, headers=headers)).json()['data']
    statement = await client.post(BASE+'/preview', json={
        'requestId': str(uuid4()), 'accountId': identifier, 'accountKind': 'real',
        'revision': row['revision'], 'externalAccount': 'SYNTHETIC', 'xml': XML,
    })
    assert statement.status_code == 200, statement.text
    statement = statement.json()
    imported = await client.post(BASE+'/imports', json={
        'requestId': str(uuid4()), 'previewId': statement['previewId'],
        'confirmExternalAccount': 'SYNTHETIC', 'takeOverOfficial': True, 'acknowledgeUnassigned': True,
    })
    assert imported.status_code == 200, imported.text
    row = (await client.get(root+'/'+identifier, headers=headers)).json()['data']
    async with db.connection() as conn:
        before = {}
        for table in ('trade_ledger', 'cash_ledger_entries'):
            before[table] = (await (await conn.execute(f'SELECT count(*) AS n FROM {table} WHERE owner_id=%s', (admin,))).fetchone())['n']
    raw = {'requestId': str(uuid4()), 'revision': row['revision'],
           'recordCollectionRevision': row['currencyUsage']['recordCollectionRevision'], 'source': 'manual'}
    changed = await client.put(root+'/'+identifier+'/holding-source', headers=headers, json=raw)
    assert changed.status_code == 200, changed.text
    receipt = changed.json()['data']
    assert receipt['state'] == 'completed' and receipt['kind'] == 'set_holding_source'
    assert (await client.get(root+'/operations/'+raw['requestId'], headers=headers)).json()['data'] == receipt
    replay = await client.put(root+'/'+identifier+'/holding-source', headers=headers, json=raw)
    assert replay.status_code == 200 and replay.json()['data'] == receipt
    conflicting = await client.put(root+'/'+identifier+'/holding-source', headers=headers,
                                   json={**raw, 'recordCollectionRevision': raw['recordCollectionRevision']+1})
    assert conflicting.status_code == 409
    original = await client.get(BASE+'/originals/'+statement['originalId'])
    assert original.status_code == 200 and original.content == XML.encode()
    async with db.connection() as conn:
        row = await (await conn.execute('SELECT holding_source FROM broker_accounts WHERE owner_id=%s AND id=%s', (admin, identifier))).fetchone()
        assert row['holding_source'] == 'manual'
        for table, count in before.items():
            after = await (await conn.execute(f'SELECT count(*) AS n FROM {table} WHERE owner_id=%s', (admin,))).fetchone()
            assert after['n'] == count
        records = await (await conn.execute('SELECT qty,cost FROM portfolio_records WHERE owner_id=%s AND broker_account_id=%s AND deleted_at IS NULL', (admin, identifier))).fetchall()
        assert records and all(record['qty'] is None and record['cost'] is None for record in records)
