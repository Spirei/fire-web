import asyncio
import json
from uuid import UUID, uuid4

import httpx
import psycopg
import test_backups as backup_tests
from alcor_api.cli import create_user
from alcor_api.legacy_financing import legacy_payload_hash, legacy_revision
from alcor_api.main import create_app
from legacy_source.helpers import authorized, export
from legacy_source.synthetic_legacy import OWNER
from test_cash_ledger import account as cash_account
from test_cash_ledger import command as cash_command
from test_cash_ledger import submit as cash_submit
from test_legacy_trade_corrections import native_headers

P = '/api/financing/policy'
TABLES = (
    'financing_source_policy_claims',
    'financing_source_policy_mappings',
    'financing_source_policy_heads',
    'financing_source_policy_request_archives',
    'financing_policy_versions',
    'financing_policy_heads',
    'trade_operations',
)
configured = backup_tests.configured
backup_app = backup_tests.backup_app
bc = backup_tests.bc


def original_request():
    original_id = str(uuid4())
    old_policy = {'currency': 'USD', 'limit': '99', 'initialMargin': None, 'maintenanceMargin': None}
    old_result = {
        'version': 1,
        'accountId': OWNER,
        'revision': legacy_revision(old_policy),
        'policy': {'currency': 'USD', 'limit': 99, 'initialMargin': None, 'maintenanceMargin': None},
    }
    raw = json.dumps(old_result, separators=(',', ':'))
    return {
        'id': original_id,
        'payload': legacy_payload_hash(legacy_revision(None), old_policy),
        'raw': raw,
        'policy': old_policy,
        'result': old_result,
    }


async def seed(pg, old_pg, requests):
    policy = json.dumps({'currency': 'JPY', 'limit': 100, 'initialMargin': 20, 'maintenanceMargin': 10})
    async with await psycopg.AsyncConnection.connect(pg.get_uri(database=old_pg.expected_database), autocommit=True) as conn:
        await conn.execute('INSERT INTO account_financing_policy(user_id,value) VALUES(%s,%s)', (OWNER, policy))
        for item in requests:
            await conn.execute(
                'INSERT INTO account_financing_requests(user_id,request_id,payload,result) VALUES(%s,%s,%s,%s)',
                (OWNER, item['id'], item['payload'], item['raw']),
            )


async def imported(client, owner, snapshot, kind='real'):
    current = (await client.get(P, params={'accountKind': kind})).json()
    data = {
        'requestId': str(uuid4()),
        'manifestId': snapshot['manifestId'],
        'targetUserId': owner,
        'accountKind': kind,
        'revision': current['revision'],
        'sourcePolicyKindConfirmed': True,
    }
    proof = await client.post(P + '/preview', json=data)
    assert proof.status_code == 200, proof.text
    done = await client.post(P + '/operations', json={'data': data, 'preview': proof.json()['previewRevision']})
    assert done.status_code == 200 and done.json()['state'] == 'completed', done.text
    return data, proof.json(), done.json()


async def counts(db):
    async with db.connection() as conn:
        return {table: (await (await conn.execute('SELECT count(*) n FROM ' + table)).fetchone())['n'] for table in TABLES}


async def rows(db):
    async with db.connection() as conn:
        return {table: await (await conn.execute('SELECT * FROM ' + table + ' ORDER BY 1,2')).fetchall() for table in TABLES}


async def test_lost_response_replays_the_same_uuid_and_does_not_apply_policy_twice(client, admin, app, old_pg, pg):
    request = original_request()
    await seed(pg, old_pg, [request])
    grant = await authorized(client, admin, old_pg)
    snapshot, *_ = await export(client, grant)
    data, proof, done = await imported(client, admin, snapshot)
    after = await counts(app.state.db)
    lost = await client.post(P + '/operations', json={'data': data, 'preview': proof['previewRevision']})
    assert lost.status_code == 200 and lost.json() == done, lost.text
    assert await counts(app.state.db) == after
    assert (await client.get(P + '/operations/' + data['requestId'])).json() == done
    assert (await client.get(P + '/operations/' + request['id'])).json()['sourcePolicyArchive']
    current = (await client.get(P, params={'accountKind': 'real'})).json()
    assert current['policy']['currency'] == 'JPY' and current['policyRevision'] == 1


async def test_concurrent_same_uuid_returns_one_receipt(client, admin, app, old_pg, pg):
    await seed(pg, old_pg, [original_request()])
    grant = await authorized(client, admin, old_pg)
    snapshot, *_ = await export(client, grant)
    current = (await client.get(P, params={'accountKind': 'real'})).json()
    data = {
        'requestId': str(uuid4()),
        'manifestId': snapshot['manifestId'],
        'targetUserId': admin,
        'accountKind': 'real',
        'revision': current['revision'],
        'sourcePolicyKindConfirmed': True,
    }
    proof = await client.post(P + '/preview', json=data)
    assert proof.status_code == 200, proof.text
    body = {'data': data, 'preview': proof.json()['previewRevision']}
    first, second = await asyncio.gather(client.post(P + '/operations', json=body), client.post(P + '/operations', json=body))
    assert first.status_code == 200 and second.status_code == 200
    assert first.json() == second.json() and first.json()['state'] == 'completed'
    saved = await counts(app.state.db)
    assert saved['financing_source_policy_mappings'] == 1 and saved['financing_policy_versions'] == 1
    assert saved['financing_source_policy_request_archives'] == 1
    assert (await client.get(P + '/operations/' + data['requestId'])).json() == first.json()


async def test_concurrent_different_uuids_apply_one_policy_and_keep_the_other_failed_receipt(client, admin, app, old_pg, pg):
    await seed(pg, old_pg, [original_request()])
    grant = await authorized(client, admin, old_pg)
    snapshot, *_ = await export(client, grant)
    current = (await client.get(P, params={'accountKind': 'real'})).json()
    commands = []
    previews = []
    for _ in range(2):
        data = {
            'requestId': str(uuid4()),
            'manifestId': snapshot['manifestId'],
            'targetUserId': admin,
            'accountKind': 'real',
            'revision': current['revision'],
            'sourcePolicyKindConfirmed': True,
        }
        proof = await client.post(P + '/preview', json=data)
        assert proof.status_code == 200, proof.text
        commands.append(data)
        previews.append(proof.json()['previewRevision'])
    responses = await asyncio.gather(
        *(
            client.post(P + '/operations', json={'data': data, 'preview': preview})
            for data, preview in zip(commands, previews, strict=True)
        )
    )
    bodies = [response.json() for response in responses]
    assert [response.status_code for response in responses] == [200, 200]
    completed = [body for body in bodies if body['state'] == 'completed']
    failed = [body for body in bodies if body['state'] == 'failed']
    assert len(completed) == 1 and len(failed) == 1 and failed[0]['status'] == 409
    saved = await counts(app.state.db)
    assert saved['financing_policy_versions'] == 1 and saved['financing_source_policy_mappings'] == 1
    assert (await client.get(P + '/operations/' + completed[0]['requestId'])).json() == completed[0]
    assert (await client.get(P + '/operations/' + failed[0]['requestId'])).json() == failed[0]
    head = (await client.get(P, params={'accountKind': 'real'})).json()
    assert head['policyRevision'] == 1 and head['sourceImportRequestId'] == completed[0]['requestId']


async def test_moved_source_head_rejects_the_previewed_manifest_without_applying_it(client, admin, app, old_pg, pg):
    request = original_request()
    await seed(pg, old_pg, [request])
    grant = await authorized(client, admin, old_pg)
    snapshot, *_ = await export(client, grant)
    current = (await client.get(P, params={'accountKind': 'real'})).json()
    data = {
        'requestId': str(uuid4()),
        'manifestId': snapshot['manifestId'],
        'targetUserId': admin,
        'accountKind': 'real',
        'revision': current['revision'],
        'sourcePolicyKindConfirmed': True,
    }
    proof = await client.post(P + '/preview', json=data)
    assert proof.status_code == 200, proof.text
    extra = original_request()
    async with await psycopg.AsyncConnection.connect(pg.get_uri(database=old_pg.expected_database), autocommit=True) as conn:
        await conn.execute(
            'INSERT INTO account_financing_requests(user_id,request_id,payload,result) VALUES(%s,%s,%s,%s)',
            (OWNER, extra['id'], extra['payload'], extra['raw']),
        )
    advanced, *_ = await export(client, grant, predecessor=snapshot['manifestSha256'])
    assert advanced['headAdvanced'] and advanced['manifestId'] != snapshot['manifestId']
    stale = await client.post(P + '/operations', json={'data': data, 'preview': proof.json()['previewRevision']})
    assert stale.status_code == 200 and stale.json()['state'] == 'failed' and stale.json()['status'] == 409, stale.text
    assert await counts(app.state.db) == {
        **{table: 0 for table in TABLES if table != 'trade_operations'},
        'trade_operations': 1,
    }
    assert (await client.get(P + '/operations/' + data['requestId'])).json() == stale.json()
    assert (await client.get(P + '/operations/' + request['id'])).status_code == 404
    fresh, _, done = await imported(client, admin, advanced)
    assert done['originalReceiptCount'] == 2 and fresh['requestId'] != data['requestId']


async def test_another_owner_cannot_copy_the_claim_or_read_the_archived_receipt(client, admin, app, settings, old_pg, pg):
    request = original_request()
    await seed(pg, old_pg, [request])
    grant = await authorized(client, admin, old_pg)
    snapshot, *_ = await export(client, grant)
    data, _, done = await imported(client, admin, snapshot)
    other = await create_user(settings, 'OtherFinancingOwner', 'Synthetic9Pass')
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
        base_url='http://testserver',
        headers={'origin': 'http://testserver'},
    ) as second:
        login = await second.post('/api/session/login', json={'login': 'OtherFinancingOwner', 'password': 'Synthetic9Pass'})
        assert login.status_code == 200, login.text
        second.headers['x-csrf-token'] = login.json()['csrf']
        denied = await second.post(
            '/api/legacy-financial/authorizations',
            json={'requestId': str(uuid4()), 'sourceAlias': old_pg.alias, 'sourceOwner': OWNER, 'targetUserId': other},
        )
        assert denied.status_code == 409, denied.text
        assert (await second.get(P + '/operations/' + data['requestId'])).status_code == 404
        assert (await second.get(P + '/operations/' + request['id'])).status_code == 404
        foreign = await second.get(P, params={'accountKind': 'real'})
        assert foreign.status_code == 200, foreign.text
        isolated = foreign.json()
        assert isolated['policy'] is None and isolated['policyKnown'] and isolated['policyOrigin'] == 'unconfigured'
        assert isolated['policyRevision'] == 0 and isolated['sourceImportRequestId'] is None and not isolated['sourcePolicyPending']
        copied = await second.post(
            P + '/preview',
            json={**data, 'requestId': str(uuid4()), 'targetUserId': other, 'revision': isolated['revision']},
        )
        assert copied.status_code == 409, copied.text
    assert (await client.get(P + '/operations/' + data['requestId'])).json() == done
    assert (await client.get(P, params={'accountKind': 'real'})).json()['policy']['limit'] == '100'


async def test_existing_cash_uuid_blocks_import_and_archived_uuid_blocks_later_cash(client, admin, app, old_pg, pg):
    blocked = original_request()
    await seed(pg, old_pg, [blocked])
    identifier = await cash_account(client, name='Financing UUID collision')
    cash, _ = await cash_submit(client, cash_command(identifier, amount='25', requestId=blocked['id']))
    assert cash['state'] == 'completed'
    grant = await authorized(client, admin, old_pg)
    snapshot, *_ = await export(client, grant)
    current = (await client.get(P, params={'accountKind': 'real'})).json()
    data = {
        'requestId': str(uuid4()),
        'manifestId': snapshot['manifestId'],
        'targetUserId': admin,
        'accountKind': 'real',
        'revision': current['revision'],
        'sourcePolicyKindConfirmed': True,
    }
    rejected = await client.post(P + '/preview', json=data)
    assert rejected.status_code == 409, rejected.text
    assert (await counts(app.state.db))['financing_source_policy_request_archives'] == 0
    assert (await client.get(P, params={'accountKind': 'real'})).json()['policyKnown'] is False


async def test_archived_original_uuid_cannot_be_reused_for_cash(client, admin, app, old_pg, pg):
    request = original_request()
    await seed(pg, old_pg, [request])
    grant = await authorized(client, admin, old_pg)
    snapshot, *_ = await export(client, grant)
    _, _, done = await imported(client, admin, snapshot)
    identifier = await cash_account(client, name='Archived financing UUID')
    before = (await client.get('/api/cash/accounts/' + identifier)).json()
    opening = cash_command(identifier, amount='25', requestId=request['id'])
    preview = await client.post('/api/cash/preview', json=opening)
    assert preview.status_code == 200, preview.text
    denied = await client.post('/api/cash/operations', json={'data': opening, 'preview': preview.json()['preview']})
    assert denied.status_code == 409, denied.text
    assert (await client.get('/api/cash/accounts/' + identifier)).json() == before
    assert (await client.get(P + '/operations/' + request['id'])).json()['sourcePolicyArchive']
    assert (await client.get(P, params={'accountKind': 'real'})).json()['sourceImportRequestId'] == done['requestId']
    async with app.state.db.connection() as conn:
        entry = await (
            await conn.execute('SELECT 1 FROM cash_ledger_entries WHERE owner_id=%s AND request_id=%s', (admin, request['id']))
        ).fetchone()
    assert entry is None


async def test_encrypted_restore_keeps_source_policy_archive_without_the_live_source(bc, backup_app, configured, old_pg, pg):
    request = original_request()
    await seed(pg, old_pg, [request])
    async with backup_app.state.db.connection() as conn:
        owner = (await (await conn.execute("SELECT id FROM users WHERE username='BackupQA'")).fetchone())['id']
    grant = await authorized(bc, owner, old_pg)
    snapshot, *_ = await export(bc, grant)
    data, _, done = await imported(bc, owner, snapshot)
    before = await rows(backup_app.state.db)
    backup_id, _ = await backup_tests.create_capsule(bc, backup_app, configured)
    preview = await bc.get('/api/backups/' + backup_id + '/restore-preview', params={'target_id': 'isolated-qa'})
    assert preview.status_code == 200, preview.text
    task, _ = await backup_tests.submit(
        bc, 'backup.restore', backup_id=backup_id, target_id='isolated-qa', restore_ticket=preview.json()['restore_ticket']
    )
    restored = await backup_tests.execute(backup_app, configured, UUID(task['id']))
    assert restored['sessions_revoked']
    target = configured.restore_targets[0]
    settings = configured.model_copy(
        update={
            'database_url': target.database_url,
            'instance_id': target.instance_id,
            'environment': 'test',
            'redis_url': None,
            'file_root': target.recovery_directory / 'files',
            'connection_secret_dir': target.recovery_directory / 'connection-secrets',
            'legacy_source_registry_path': None,
        }
    )
    recovered = create_app(settings)
    async with recovered.router.lifespan_context(recovered), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=recovered, raise_app_exceptions=False),
        base_url='http://testserver',
        headers={'origin': 'http://testserver'},
    ) as client:
        assert await rows(recovered.state.db) == before
        login = await client.post('/api/session/login', json={'login': 'BackupQA', 'password': 'Synthetic9Pass'})
        assert login.status_code == 200, login.text
        client.headers['x-csrf-token'] = login.json()['csrf']
        async with recovered.state.db.connection() as conn:
            owner = (await (await conn.execute("SELECT id FROM users WHERE username='BackupQA'")).fetchone())['id']
        receipt = await client.get(P + '/operations/' + request['id'])
        assert receipt.status_code == 200 and receipt.json()['sourcePolicyArchive'], receipt.text
        assert receipt.json()['policy'] == request['policy']
        current = (await client.get(P, params={'accountKind': 'real'})).json()
        assert current['policy']['currency'] == 'JPY' and current['sourceImportRequestId'] == data['requestId']
        replay = await client.post(P + '/operations', json={'data': data, 'preview': 'stale-after-restore'})
        assert replay.status_code == 200 and replay.json() == done, replay.text
        headers = await native_headers(recovered.state.db, owner, 'portfolio.read portfolio.write orders.read')
        body = {'requestId': request['id'], 'revision': legacy_revision(None), 'policy': request['result']['policy']}
        for version in (1, 2):
            legacy = await client.post(f'/api/v{version}/account-assets/financing-policy', json=body, headers=headers)
            assert legacy.status_code == 200 and legacy.json()['data']['policy'] == request['result']['policy'], legacy.text
        assert (await client.get(P, params={'accountKind': 'real'})).json()['policy']['limit'] == '100'
        source = await client.get(P + '/source', params={'accountKind': 'real'})
        assert source.status_code == 200 and source.json()['state'] == 'blocked', source.text
