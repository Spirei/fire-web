"""Card sources and custom cards against identity-verified isolated PG and synthetic image bytes."""

import asyncio
import io
import json
from uuid import uuid4

import httpx
import pytest
from alcor_api.card_catalog_contract import clean, custom_input, han_map, search_key
from alcor_api.card_preferences import restore_json
from PIL import Image

PASSWORD = 'SyntheticCardPass9'
SOURCE = json.dumps({'regions': [{'label': 'Synthetic', 'banks': [{'name': '汇丰', 'cards': [{'name': '万事达', 'file': 'synthetic/mastercard.png'}]}]}], 'typeOrder': ['借记卡'], 'source': 'Synthetic fixture', 'generatedAt': '2026-01-01T00:00:00Z'}, ensure_ascii=False)


@pytest.fixture(autouse=True)
async def media_root(settings, tmp_path):
    settings.file_root = tmp_path / 'card-files'


@pytest.fixture
async def catalog(app):
    return app.state.card_catalog


async def sign_in(client, name='CardOwner'):
    registered = await client.post('/api/auth/register', json={'username': name, 'password': PASSWORD})
    assert registered.status_code == 201, registered.text
    login = await client.post('/api/session/login', json={'login': name, 'password': PASSWORD})
    assert login.status_code == 200, login.text
    client.headers['x-csrf-token'] = login.json()['csrf']
    return registered.json()['user']['id']


async def imported(client, text=SOURCE, rid=None, revision=None):
    preview = await client.post('/api/admin/card-catalog/preview', json={'manifestText': text, 'sourceLabel': 'Synthetic captured catalog'})
    assert preview.status_code == 200, preview.text
    data = {'manifestText': text, 'sourceLabel': 'Synthetic captured catalog', 'expectedDigest': preview.json()['sha256'], 'expectedRevision': revision if revision is not None else preview.json()['sourceRevision'], 'requestId': str(rid or uuid4())}
    return await client.post('/api/admin/card-catalog/imports', json=data), data


async def peer(app):
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app, raise_app_exceptions=False), base_url='http://testserver', headers={'origin': 'http://testserver'})


def card(**changes):
    return {'name': 'Private Card', 'bank': 'Synthetic Bank', 'image': '/uploads/asset/card/synthetic.png', 'type': '借记卡', 'currencyScope': 'single', **changes}


def test_frozen_complete_han_and_old_text_rules():
    # The old 3,080-column vectors contain one duplicate traditional key; last assignment wins.
    assert len(han_map()) == 3079
    assert search_key(' 滙豐 萬事達 ') == '汇丰万事达'
    assert clean('😀' * 5 + 'a😀', 12) == '😀' * 5 + 'a\ud83d'
    value = custom_input(card(type='unknown type', currencyScope=' MuLtI ', brand=None))
    assert value['type'] == '其他' and value['currencyScope'] == 'multi' and value['brand'] == ''


async def test_missing_source_preview_digest_cas_and_uuid_are_explicit(client, catalog, db):
    await sign_in(client)
    empty = await client.get('/api/account/card-catalog')
    assert empty.status_code == 200 and empty.json()['source'] is None
    missing = await client.post('/api/cards/custom', json=card())
    assert missing.status_code == 409 and '来源' in missing.json()['error']
    preview = await client.post('/api/admin/card-catalog/preview', json={'manifestText': SOURCE, 'sourceLabel': 'Synthetic captured catalog'})
    assert preview.json()['cardCount'] == 1 and not preview.json()['materialBytesImported']
    async with db.connection() as conn:
        assert (await (await conn.execute('SELECT count(*) AS n FROM card_catalog_sources')).fetchone())['n'] == 0
    identifier = uuid4()
    data = {'manifestText': SOURCE, 'sourceLabel': 'Synthetic captured catalog', 'expectedDigest': preview.json()['sha256'], 'expectedRevision': 0, 'requestId': str(identifier)}
    altered = await client.post('/api/admin/card-catalog/imports', json={**data, 'manifestText': SOURCE + ' '})
    assert altered.status_code == 409
    results = await asyncio.gather(*(client.post('/api/admin/card-catalog/imports', json=data) for _ in range(3)))
    assert all(result.status_code == 200 for result in results), [result.text for result in results]
    assert results[0].json() == results[1].json() == results[2].json()
    snapshot = (await client.get('/api/account/card-catalog')).json()
    assert snapshot['source']['manifest']['regions'] == json.loads(SOURCE)['regions'] and snapshot['sourceRevision'] == 1
    assert snapshot['source']['coverage'] == 'captured-metadata-only'
    original = await client.get('/api/admin/card-catalog/sources/' + snapshot['source']['id'] + '/original')
    assert original.content == SOURCE.encode('utf-8')
    assert original.headers['x-alcor-source-sha256'] == preview.json()['sha256']
    stale, _ = await imported(client, revision=0)
    assert stale.status_code == 409
    async with db.connection() as conn:
        assert (await (await conn.execute('SELECT count(*) AS n FROM card_catalog_sources')).fetchone())['n'] == 1
        assert (await (await conn.execute('SELECT count(*) AS n FROM card_catalog_operations')).fetchone())['n'] == 1


async def test_custom_rules_duplicate_han_owner_isolation_and_no_invented_holdings(client, catalog, app, db):
    owner = await sign_in(client)
    assert (await imported(client))[0].status_code == 200
    duplicated = await client.post('/api/cards/custom', json=card(name='萬 事 達', bank='滙 豐'))
    assert duplicated.status_code == 409 and '已经有' in duplicated.json()['error']
    identifier = uuid4()
    headers = {'x-alcor-request-id': str(identifier), 'x-alcor-cards-revision': '0'}
    values = await asyncio.gather(*(client.post('/api/cards/custom', json=card(), headers=headers) for _ in range(3)))
    assert all(value.status_code == 200 for value in values), [value.text for value in values]
    saved = values[0].json()['card']
    assert saved == values[1].json()['card']
    assert (await client.get('/api/cards/custom')).json() == {'cards': [saved]}
    assert (await client.get('/api/cards/holdings')).json() == {'holdings': []}
    snapshot = (await client.get('/api/account/card-catalog')).json()
    assert snapshot['customCards'][0]['materialState'] == 'unverified-reference'
    assert (await client.get('/api/cards/custom/operations/' + str(identifier))).json()['card'] == saved
    assert (await client.post('/api/cards/custom', json=card(name='Different'), headers=headers)).status_code == 409
    async with await peer(app) as other:
        other_id = await sign_in(other, 'CardOther')
        assert (await other.get('/api/cards/custom')).json() == {'cards': []}
        assert (await other.get('/api/cards/custom/operations/' + str(identifier))).status_code == 404
        assert (await other.delete('/api/cards/custom', params={'id': saved['id']})).status_code == 404
        assert (await other.post('/api/admin/card-catalog/preview', json={'manifestText': SOURCE, 'sourceLabel': 'Other'})).status_code == 403
        # Personal duplicates do not leak into another owner's duplicate namespace.
        assert (await other.post('/api/cards/custom', json=card())).status_code == 200
        async with db.connection() as conn:
            assert (await (await conn.execute('SELECT count(*) AS n FROM card_custom_records WHERE owner_id=%s', (other_id,))).fetchone())['n'] == 1
    async with db.connection() as conn:
        assert (await (await conn.execute('SELECT count(*) AS n FROM portfolio_records WHERE owner_id=%s', (owner,))).fetchone())['n'] == 0


async def test_shared_registered_image_admin_index_and_cross_owner_preservation(client, catalog, app, db):
    admin_id = await sign_in(client)
    assert (await imported(client))[0].status_code == 200
    stream = io.BytesIO()
    Image.new('RGB', (2, 2), '#447799').save(stream, 'PNG')
    upload = await client.post('/api/admin/shared-assets/upload', data={'kind': 'asset', 'folder': 'card', 'name': 'Synthetic image', 'requestId': str(uuid4()), 'expectedRevision': '0'}, files={'file': ('synthetic.png', stream.getvalue(), 'image/png')})
    assert upload.status_code == 200, upload.text
    image = upload.json()['legacyUrl']
    created = await client.post('/api/cards/custom', json=card(image=image))
    assert created.status_code == 200, created.text
    mine = created.json()['card']
    async with await peer(app) as other:
        await sign_in(other, 'ImageOther')
        theirs = await other.post('/api/cards/custom', json=card(image=image, name='Other private descriptor', bank='Other private bank'))
        assert theirs.status_code == 200
        # Ordinary owners cannot publish/overwrite shared card metadata.
        async with db.connection() as conn:
            index = await (await conn.execute('SELECT updated_by,deleted_at,image_version,metadata FROM card_catalog_public_index WHERE image_path=%s', (image,))).fetchone()
            assert index['image_version'] is not None and index['deleted_at'] is None
            assert index['updated_by'] == admin_id and restore_json(index['metadata'])['name'] == 'Private Card'
        assert (await other.get('/api/account/card-catalog')).json()['publishedAssets'][0]['name'] == 'Private Card'
        assert (await client.delete('/api/cards/custom', params={'id': mine['id']})).status_code == 200
        async with db.connection() as conn:
            assert (await (await conn.execute('SELECT deleted_at FROM card_catalog_public_index WHERE image_path=%s', (image,))).fetchone())['deleted_at'] is None
        deleted = await other.delete('/api/cards/custom', params={'id': theirs.json()['card']['id']})
        assert deleted.status_code == 200
        async with db.connection() as conn:
            # An ordinary account does not gain global cleanup authority even when last to remove its association.
            assert (await (await conn.execute('SELECT deleted_at FROM card_catalog_public_index WHERE image_path=%s', (image,))).fetchone())['deleted_at'] is None
        assert (await other.get(image)).status_code == 200
    assert (await client.get('/api/account/card-catalog')).json()['customCards'] == []


async def test_delete_removes_only_owned_holdings_keeps_labels_and_uuid_tombstone(client, catalog, db):
    await sign_in(client)
    assert (await imported(client))[0].status_code == 200
    created = (await client.post('/api/cards/custom', json=card())).json()['card']
    image = created['image']
    await client.put('/api/cards/holdings', json={'cardKey': image, 'held': True})
    await client.put('/api/cards/tags', json={'cardKey': image, 'tags': ['Retained']})
    identifier = uuid4()
    response = await client.delete('/api/cards/custom', params={'id': created['id']}, headers={'x-alcor-request-id': str(identifier)})
    assert response.json() == {'ok': True}
    repeated = await client.delete('/api/cards/custom', params={'id': created['id']}, headers={'x-alcor-request-id': str(identifier)})
    assert repeated.json() == response.json()
    assert (await client.get('/api/cards/holdings')).json() == {'holdings': []}
    assert (await client.get('/api/cards/tags')).json()['tags'][image] == ['Retained']
    async with db.connection() as conn:
        assert (await (await conn.execute('SELECT deleted_at FROM card_custom_records WHERE id=%s', (created['id'],))).fetchone())['deleted_at'] is not None
        assert (await (await conn.execute('SELECT held FROM card_preference_holdings WHERE card_key=%s', (image,))).fetchone())['held'] is False
        result = (await (await conn.execute('SELECT result FROM card_catalog_operations WHERE request_id=%s', (identifier,))).fetchone())['result']
        assert restore_json(result)['ok'] is True


async def test_account_closure_purges_private_cards_receipts_but_preserves_shared_catalog(client, catalog, app, db):
    admin_id = await sign_in(client)
    assert (await imported(client))[0].status_code == 200
    assert (await client.post('/api/cards/custom', json=card(name='Admin public descriptor'))).status_code == 200
    async with await peer(app) as other:
        owner = await sign_in(other, 'ClosureCardOwner')
        created = await other.post('/api/cards/custom', json=card(name='Private closure descriptor'))
        assert created.status_code == 200
        receipt_id = created.headers['x-alcor-request-id']
        closed = await other.post('/api/v1/auth/delete-account', json={'password': PASSWORD})
        assert closed.status_code == 200, closed.text
        assert (await other.get('/api/cards/custom')).status_code == 401
        async with db.connection() as conn:
            for table in ('card_custom_records', 'card_catalog_operations'):
                assert (await (await conn.execute('SELECT count(*) AS n FROM ' + table + ' WHERE owner_id=%s', (owner,))).fetchone())['n'] == 0
            assert (await (await conn.execute('SELECT count(*) AS n FROM card_custom_records WHERE owner_id=%s', (admin_id,))).fetchone())['n'] == 1
            assert (await (await conn.execute('SELECT count(*) AS n FROM card_catalog_public_index WHERE deleted_at IS NULL')).fetchone())['n'] == 1
            assert (await (await conn.execute('SELECT count(*) AS n FROM card_catalog_sources')).fetchone())['n'] == 1
        assert (await other.get('/api/cards/custom/operations/' + receipt_id)).status_code == 401


async def test_current_catalog_schema_fault_rolls_back_closure_and_private_data(client, catalog, app, db):
    await sign_in(client)
    assert (await imported(client))[0].status_code == 200
    async with await peer(app) as other:
        owner = await sign_in(other, 'FaultCardOwner')
        assert (await other.post('/api/cards/custom', json=card())).status_code == 200
        async with db.connection() as conn:
            await conn.execute('ALTER TABLE card_catalog_operations RENAME TO hidden_card_catalog_operations')
        try:
            closed = await other.post('/api/v1/auth/delete-account', json={'password': PASSWORD})
            assert closed.status_code == 500
            async with db.connection() as conn:
                assert (await (await conn.execute('SELECT active FROM users WHERE id=%s', (owner,))).fetchone())['active'] is True
                assert (await (await conn.execute('SELECT count(*) AS n FROM card_custom_records WHERE owner_id=%s', (owner,))).fetchone())['n'] == 1
                assert (await (await conn.execute('SELECT count(*) AS n FROM audit_events WHERE actor_id=%s AND action=\'account.closed\'', (owner,))).fetchone())['n'] == 0
        finally:
            async with db.connection() as conn:
                await conn.execute('ALTER TABLE hidden_card_catalog_operations RENAME TO card_catalog_operations')


async def test_close_unknown_uuid_serializes_with_late_writes_and_is_queryable(client, catalog, db):
    await sign_in(client)
    assert (await imported(client))[0].status_code == 200
    identifier = uuid4()
    path = '/api/account/card-catalog/operations/' + str(identifier)
    assert (await client.get(path)).status_code == 404
    closed = await client.post(path + '/close', json={'kind': 'custom_create'})
    assert closed.status_code == 200 and closed.json() == {'requestId': str(identifier), 'kind': 'custom_create', 'state': 'closed'}
    late = await client.post('/api/cards/custom', json=card(), headers={'x-alcor-request-id': str(identifier)})
    assert late.status_code == 409
    assert (await client.get(path)).json() == closed.json()
    async with db.connection() as conn:
        assert (await (await conn.execute('SELECT count(*) AS n FROM card_custom_records')).fetchone())['n'] == 0
        assert (await (await conn.execute("SELECT count(*) AS n FROM audit_events WHERE action='cards.custom.created'")).fetchone())['n'] == 0


async def test_close_racing_create_returns_existing_completion_or_prevents_creation(client, catalog, db):
    await sign_in(client)
    assert (await imported(client))[0].status_code == 200
    for number in range(4):
        identifier = uuid4()
        create, closed = await asyncio.gather(
            client.post('/api/cards/custom', json=card(name='Concurrent ' + str(number)), headers={'x-alcor-request-id': str(identifier)}),
            client.post('/api/account/card-catalog/operations/' + str(identifier) + '/close', json={'kind': 'custom_create'}),
        )
        assert closed.status_code == 200
        if create.status_code == 200:
            assert closed.json()['state'] == 'completed' and closed.json()['card'] == create.json()['card']
        else:
            assert create.status_code == 409 and closed.json()['state'] == 'closed'
        async with db.connection() as conn:
            rows = await (await conn.execute('SELECT result FROM card_catalog_operations WHERE request_id=%s', (identifier,))).fetchall()
            assert len(rows) == 1 and restore_json(rows[0]['result']) == closed.json()


async def test_close_source_uuid_blocks_late_import_and_cross_owner_close_is_isolated(client, catalog, app):
    await sign_in(client)
    identifier = uuid4()
    closed = await client.post('/api/account/card-catalog/operations/' + str(identifier) + '/close', json={'kind': 'source_import'})
    assert closed.status_code == 200 and closed.json()['state'] == 'closed'
    late, _ = await imported(client, rid=identifier)
    assert late.status_code == 409
    assert (await client.get('/api/account/card-catalog')).json()['source'] is None
    async with await peer(app) as other:
        await sign_in(other, 'CloseOther')
        path = '/api/account/card-catalog/operations/' + str(identifier)
        assert (await other.get(path)).status_code == 404
        own = await other.post(path + '/close', json={'kind': 'custom_delete'})
        assert own.json()['kind'] == 'custom_delete'
        assert (await client.get(path)).json()['kind'] == 'source_import'


async def test_unknown_source_fields_and_source_label_never_become_shared_by_import(client, catalog, app):
    await sign_in(client)
    value = json.loads(SOURCE)
    value['private_notes'] = 'PRIVATE-SNAPSHOT-ONLY'
    value['regions'][0]['banks'][0]['internal_memo'] = 'PRIVATE-BANK-MEMO'
    value['regions'][0]['banks'][0]['cards'][0]['internal_memo'] = 'PRIVATE-CARD-MEMO'
    text = '\ufeff' + json.dumps(value)
    imported_result, _ = await imported(client, text=text)
    assert imported_result.status_code == 200
    source_id = imported_result.json()['sourceId']
    async with await peer(app) as other:
        await sign_in(other, 'ProjectionOwner')
        response = await other.get('/api/account/card-catalog')
        assert response.status_code == 200
        assert 'PRIVATE-' not in response.text and 'Synthetic captured catalog' not in response.text
        assert response.json()['source']['sourceLabel'] is None
        assert response.json()['source']['manifest']['regions'][0]['banks'][0]['cards'][0]['name'] == '万事达'
        original = await other.get('/api/admin/card-catalog/sources/' + source_id + '/original')
        assert original.status_code == 403
    original = await client.get('/api/admin/card-catalog/sources/' + source_id + '/original')
    assert original.content == text.encode() and 'PRIVATE-SNAPSHOT-ONLY' in original.text


async def test_native_legacy_session_owned_cards_never_inherit_shared_publication_privileges(client,catalog,app,db):
    from alcor_api.security import digest
    uid=await sign_in(client)
    assert (await imported(client))[0].status_code==200
    token='synthetic-native-card-session'
    async with db.connection() as conn:
        await conn.execute("INSERT INTO sessions(token_hash,user_id,client_id,session_version,expires_at) SELECT %s,id,'legacy-v1',session_version,clock_timestamp()+interval '1 day' FROM users WHERE id=%s",(digest(token),uid))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver',headers={'authorization':'Bearer '+token}) as native:
        private=await native.post('/api/cards/custom',json=card(name='Native private association'))
        assert private.status_code==200,private.text
        async with db.connection() as conn:
            assert (await(await conn.execute('SELECT count(*) AS n FROM card_catalog_public_index')).fetchone())['n']==0
        public=await client.post('/api/cards/custom',json=card(name='Published Web association'))
        assert public.status_code==200
        assert (await client.delete('/api/cards/custom',params={'id':public.json()['card']['id']})).status_code==200
        assert (await native.delete('/api/cards/custom',params={'id':private.json()['card']['id']})).status_code==200
        async with db.connection() as conn:
            assert (await(await conn.execute('SELECT deleted_at FROM card_catalog_public_index')).fetchone())['deleted_at'] is None
        assert (await native.get('/api/cards/custom')).json()=={'cards':[]}
