"""Synthetic owned card preferences in the fixture's verified isolated PostgreSQL."""

import asyncio
import json
import subprocess
from uuid import uuid4

import httpx
import pytest
from alcor_api.card_preferences import CardPreferences, card_key, card_tags
from alcor_api.security import digest
from fastapi import HTTPException


@pytest.fixture
async def cards(app):
    return app.state.card_preferences


async def owner(client):
    result = await client.post('/api/auth/register', json={'username': 'CardOwner', 'password': 'SyntheticCardPass9'})
    assert result.status_code == 201, result.text
    return result.json()['user']['id']


def test_key_and_tag_legacy_normalization():
    assert card_key(' 银行/Gold%20Card.png ') == '%E9%93%B6%E8%A1%8C/Gold%20Card.png'
    assert card_key('%ZZ/%FF') == '%25ZZ/%25FF'
    assert card_key(card_key('银行/a%2Fb.png')) == card_key('银行/a%2Fb.png')
    assert card_tags(['  Travel ', 'Travel', None, 0, False, 'x' * 20]) == ['Travel', '0', 'false', 'x' * 12]
    assert len(card_tags([str(i) for i in range(15)])) == 10
    assert card_tags(['\ufefftag\ufeff', '\u0085tag\u0085']) == ['tag', '\u0085tag\u0085']
    assert card_key('\ufeffcard\ufeff') == 'card'
    assert card_tags(['😀' * 7]) == ['😀' * 6]
    assert card_tags(['😀' * 5 + 'a😀', {}, [], [None, 1, {}], 1.0, 1e-7, 1e21]) == ['😀' * 5 + 'a\ud83d', '[object Obje', ',1,[object O', '1', '1e-7', '1e+21']
    with pytest.raises(HTTPException):
        card_key('x' * 601)
    with pytest.raises(HTTPException):
        card_tags('tag')


async def test_legacy_roundtrip_and_platform_only_empty(client, cards):
    await owner(client)
    empty = await client.get('/api/cards/tags')
    assert empty.json() == {'tags': {}}
    assert empty.headers['x-alcor-source-coverage'] == 'platform-only'
    assert (await client.get('/api/cards/holdings')).json() == {'holdings': []}
    saved = await client.put('/api/cards/tags', json={'cardKey': '银行/A.png', 'tags': [' Travel ', 'Travel', 'VIP']})
    assert saved.status_code == 200, saved.text
    key = '%E9%93%B6%E8%A1%8C/A.png'
    assert saved.json() == {'cardKey': key, 'tags': ['Travel', 'VIP']}
    assert saved.headers['x-alcor-request-id-mode'] == 'generated_legacy'
    assert (await client.get('/api/cards/tags')).json() == {'tags': {key: ['Travel', 'VIP']}}
    held = await client.put('/api/cards/holdings', json={'cardKey': key, 'held': True})
    assert held.json() == {'cardKey': key, 'held': True}
    assert (await client.get('/api/cards/holdings')).json() == {'holdings': [key]}
    assert (await client.put('/api/cards/holdings', json={'cardKey': key, 'held': 'true'})).json()['held'] is False
    assert (await client.get('/api/cards/holdings')).json() == {'holdings': []}
    assert (await client.put('/api/cards/tags', json={'cardKey': key, 'tags': []})).status_code == 200
    assert (await client.get('/api/cards/tags')).json() == {'tags': {}}


async def test_uuid_concurrency_revision_receipts_and_no_financial_rows(client, cards, db):
    user = await owner(client)
    identifier = uuid4()
    headers = {'x-alcor-request-id': str(identifier), 'x-alcor-cards-revision': '0'}
    writes = await asyncio.gather(*(client.put('/api/cards/tags', json={'cardKey': 'a', 'tags': ['one']}, headers=headers) for _ in range(4)))
    assert all(r.status_code == 200 and r.headers['x-alcor-cards-revision'] == '1' for r in writes)
    receipt = await client.get('/api/cards/operations/' + str(identifier))
    assert receipt.json() == {'requestId': str(identifier), 'revision': 1, 'data': {'cardKey': 'a', 'tags': ['one']}}
    assert (await client.put('/api/cards/tags', json={'cardKey': 'b', 'tags': []}, headers=headers)).status_code == 409
    assert (await client.put('/api/cards/holdings', json={'cardKey': 'a', 'held': True}, headers={'x-alcor-cards-revision': '0'})).status_code == 409
    async with db.connection() as conn:
        assert (await (await conn.execute('SELECT count(*) AS n FROM card_preference_operations WHERE owner_id=%s', (user,))).fetchone())['n'] == 1
        assert (await (await conn.execute("SELECT count(*) AS n FROM audit_events WHERE actor_id=%s AND action='cards.tags.updated'", (user,))).fetchone())['n'] == 1
        # This slice stores only preferences and does not create financial records.
        assert (await (await conn.execute('SELECT count(*) AS n FROM portfolio_records WHERE owner_id=%s', (user,))).fetchone())['n'] == 0


async def test_authentication_owner_isolation_and_revocation(client, app, cards, db):
    await owner(client)
    written = await client.put('/api/cards/tags', json={'cardKey': 'private', 'tags': ['Only Me']})
    identifier = written.headers['x-alcor-request-id']
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://testserver', headers={'origin': 'http://testserver'}) as peer:
        assert (await peer.get('/api/cards/tags')).status_code == 401
        assert (await peer.post('/api/auth/register', json={'username': 'CardOther', 'password': 'SyntheticCardPass9'})).status_code == 201
        assert (await peer.get('/api/cards/tags')).json() == {'tags': {}}
        assert (await peer.get('/api/cards/operations/' + identifier)).status_code == 404
    assert (await client.put('/api/cards/tags', json={'cardKey': 'x', 'tags': []}, headers={'origin': 'http://other.invalid'})).status_code == 401
    assert (await client.get('/api/cards/tags', headers={'authorization': 'Bearer unwanted'})).status_code == 401
    token = client.cookies['fire_session']
    async with db.connection() as conn:
        await conn.execute('DELETE FROM sessions WHERE token_hash=%s', (digest(token),))
    expired = await client.get('/api/cards/tags')
    assert expired.status_code == 401 and expired.headers['x-alcor-retire-context'] == 'true'


async def test_late_authorization_and_durable_reload(client, cards, app, db):
    await owner(client)
    # Capture an authorized identity before its session is revoked.
    from alcor_api.security import Identity
    token = client.cookies['fire_session']
    async with db.connection() as conn:
        row = await (await conn.execute('SELECT u.id,u.username,u.role,s.expires_at FROM users u JOIN sessions s ON s.user_id=u.id WHERE token_hash=%s', (digest(token),))).fetchone()
    who = Identity(**row, token_hash=digest(token), csrf='')
    who.legacy_client = True
    result = await cards.mutate(who, 'holdings', 'kept', True, uuid4())
    assert (await CardPreferences(db).read(who))['holdings'] == ['kept']
    async with db.connection() as conn:
        await conn.execute('DELETE FROM sessions WHERE token_hash=%s', (digest(token),))
    with pytest.raises(HTTPException) as exc:
        await cards.mutate(who, 'holdings', 'foreign', True, uuid4())
    assert exc.value.status_code == 401
    async with db.connection() as conn:
        rows = await (await conn.execute('SELECT result FROM card_preference_operations')).fetchall()
    assert [r['result'] for r in rows] == [result]


async def test_invalid_bodies_and_proof_headers_do_not_write(client, cards, db):
    await owner(client)
    for payload in ('null', '[]', '{"cardKey":"x","tags":[NaN]}', '{invalid'):
        response = await client.put('/api/cards/tags', content=payload, headers={'content-type': 'application/json'})
        assert response.status_code == 400, response.text
    for header in ({'x-alcor-request-id': 'invalid'}, {'x-alcor-cards-revision': '-1'}, {'x-alcor-cards-revision': '9007199254740992'}):
        response = await client.put('/api/cards/tags', json={'cardKey': 'x', 'tags': []}, headers=header)
        assert response.status_code == 400
    response = await client.put('/api/cards/tags', content='x' * 65537)
    assert response.status_code == 400
    async with db.connection() as conn:
        assert (await (await conn.execute('SELECT count(*) AS n FROM card_preference_operations')).fetchone())['n'] == 0


async def test_replacing_tags_moves_card_after_other_updated_cards(client, cards):
    await owner(client)
    for key in ('first', 'second', 'first'):
        assert (await client.put('/api/cards/tags', json={'cardKey': key, 'tags': ['label']})).status_code == 200
    assert list((await client.get('/api/cards/tags')).json()['tags']) == ['second', 'first']


async def test_bearer_priority_cookie_fallback_old_cookie_origin_and_exact_auth_errors(client, cards, app):
    await owner(client)
    token = client.cookies['fire_session']
    body = {'cardKey': 'session', 'tags': ['session tag']}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://testserver') as peer:
        # Session bearer is explicit, ignores unrelated/stale cookies and does not require Origin.
        saved = await peer.put('/api/cards/tags', json=body, headers={'authorization': 'Bearer   ' + token + '  ', 'cookie': 'fire_session=stale'})
        assert saved.status_code == 200, saved.text
        read = await peer.get('/api/cards/tags', headers={'authorization': 'Bearer ' + token})
        assert read.json() == {'tags': {'session': ['session tag']}}
        for authorization in ('Bearer stale', 'Bearer fat_' + 'x' * 43):
            result = await peer.get('/api/cards/tags', headers={'authorization': authorization, 'cookie': 'fire_session=' + token})
            assert result.status_code == 401 and result.json() == {'error': '未登录'}
        for authorization in ('Basic stale', 'Bearer    ', ''):
            result = await peer.get('/api/cards/tags', headers={'authorization': authorization, 'cookie': 'fire_session=' + token})
            assert result.status_code == 200
        assert (await peer.get('/api/cards/tags', headers={'cookie': 'stocklog_session=' + token})).status_code == 200
        # An invalid primary cookie never falls through to the secondary cookie.
        assert (await peer.get('/api/cards/tags', headers={'cookie': 'fire_session=stale; stocklog_session=' + token})).status_code == 401
        missing_origin = await peer.put('/api/cards/holdings', json={'cardKey': 'x', 'held': True}, headers={'cookie': 'fire_session=' + token})
        assert missing_origin.status_code == 200
        cross_site = await peer.put('/api/cards/holdings', json={'cardKey': 'x'}, headers={'cookie': 'fire_session=' + token, 'sec-fetch-site': 'cross-site'})
        assert cross_site.status_code == 401 and cross_site.json() == {'error': '未登录'}
    assert (await client.get('/api/cards/tags', headers={'cookie': 'fire_session=' + token.replace(token[0], '%' + format(ord(token[0]), '02x'), 1)})).status_code == 200


def old_javascript_tags(values):
    # Golden algorithm from the old card-tags route + cardAmounts.saveCardTags.
    program = r"""
const fs=require('node:fs');
const raw=JSON.parse(fs.readFileSync(0,'utf8'));
const input=raw.map(tag=>String(tag??''));
const tags=[...new Set(input.map(tag=>String(tag||'').trim().slice(0,12)).filter(Boolean))].slice(0,10);
process.stdout.write(JSON.stringify({tags,stored:tags.map(value=>Buffer.from(value,'utf8').toString('utf8'))}));
"""
    result = subprocess.run(['node', '-e', program], input=json.dumps(values, ensure_ascii=True), text=True, capture_output=True, check=True)
    return json.loads(result.stdout)


async def test_old_js_golden_surrogate_and_nul_response_receipt_and_storage(client, cards):
    await owner(client)
    values = ['😀' * 5 + 'a😀', '\udc00', 'a\x00b', None, False, 0, {}, [None, 1, {}], '\ufefftrim\ufeff', '\u0085keep\u0085']
    golden = old_javascript_tags(values)
    assert card_tags(values) == golden['tags']
    identifier = uuid4()
    headers = {'x-alcor-request-id': str(identifier)}
    # httpx's default UTF-8 JSON encoder cannot encode isolated surrogates; JSON.stringify escapes them.
    content = json.dumps({'cardKey': 'unicode', 'tags': values}, ensure_ascii=True)
    saved = await client.put('/api/cards/tags', content=content, headers=headers)
    assert saved.status_code == 200, saved.text
    assert saved.json()['tags'] == golden['tags']
    assert '\\ud83d' in saved.text and '\\udc00' in saved.text
    receipt = await client.get('/api/cards/operations/' + str(identifier))
    assert receipt.json()['data'] == saved.json()
    repeated = await client.put('/api/cards/tags', content=content, headers=headers)
    assert repeated.json() == saved.json()
    assert (await client.get('/api/cards/tags')).json()['tags']['unicode'] == golden['stored']


async def test_legacy_errors_and_body_limit_match_old_routes(client, cards):
    await owner(client)
    for body, message in ((None, '无效请求'), ([], '卡面标识无效'), ({}, '卡面标识无效'), ({'cardKey': 'x'}, '标签格式无效')):
        response = await client.put('/api/cards/tags', content=json.dumps(body))
        assert response.status_code == 400 and response.json() == {'error': message}
    # The old route accepts bounded JSON larger than the default platform 64KiB budget.
    valid = {'cardKey': 'large', 'tags': ['tag'], 'ignored': 'x' * 70000}
    assert (await client.put('/api/cards/tags', json=valid)).status_code == 200
    too_large = await client.put('/api/cards/tags', content=b' ' * (10 * 1024 * 1024 + 2))
    assert too_large.status_code == 400 and too_large.json() == {'error': '无效请求'}
    assert (await client.get('/api/cards/tags')).json()['tags'] == {'large': ['tag']}


async def test_numeric_keys_follow_javascript_object_enumeration(client, cards):
    await owner(client)
    for key in ('b', '20', '2', 'a', '01'):
        assert (await client.put('/api/cards/tags', json={'cardKey': key, 'tags': ['tag']})).status_code == 200
    assert list((await client.get('/api/cards/tags')).json()['tags']) == ['2', '20', 'b', 'a', '01']


async def test_sqlite_utf8_collision_does_not_replace_prior_preferences(client, cards):
    await owner(client)
    assert (await client.put('/api/cards/tags', json={'cardKey': 'same', 'tags': ['original']})).status_code == 200
    content = json.dumps({'cardKey': 'same', 'tags': ['\ud800', '\ud801']}, ensure_ascii=True)
    failed = await client.put('/api/cards/tags', content=content)
    assert failed.status_code == 500
    assert (await client.get('/api/cards/tags')).json()['tags']['same'] == ['original']
