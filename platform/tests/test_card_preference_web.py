"""Actual new Web preference commands and unknown-request closure on private PG."""

import asyncio
from uuid import uuid4

import httpx

PATH = '/api/account/card-preferences'


def command(identifier=None, **changes):
    return {'requestId': str(identifier or uuid4()), 'expectedRevision': 0, 'kind': 'tags', 'cardKey': 'Synthetic/A.png', 'value': ['Travel'], **changes}


async def test_actual_roundtrip_same_uuid_concurrency_and_revision(client, admin, db):
    data = command()
    replies = await asyncio.gather(*(client.put(PATH, json=data) for _ in range(4)))
    assert all(r.status_code == 200 and r.json() == replies[0].json() for r in replies)
    assert (await client.get(PATH)).json() == {'revision': 1, 'tags': {'Synthetic/A.png': ['Travel']}, 'holdings': []}
    stale = await client.put(PATH, json=command(kind='holdings', value=True))
    assert stale.status_code == 409
    held = await client.put(PATH, json=command(expectedRevision=1, kind='holdings', value=True))
    assert held.status_code == 200 and held.json()['revision'] == 2
    receipt = PATH + '/operations/' + data['requestId']
    assert (await client.get(receipt)).json() == replies[0].json()
    assert (await client.post(receipt + '/close', json={})).json() == replies[0].json()
    async with db.connection() as conn:
        assert (await (await conn.execute('SELECT count(*) n FROM card_preference_operations')).fetchone())['n'] == 2
        for table in ('trade_ledger', 'cash_ledger_entries', 'portfolio_records'):
            assert not await (await conn.execute('SELECT 1 FROM ' + table)).fetchone()


async def test_unknown_original_uuid_closed_before_late_delivery(client, admin, db):
    data = command()
    receipt = PATH + '/operations/' + data['requestId']
    assert (await client.get(receipt)).status_code == 404
    closed = await client.post(receipt + '/close', json={})
    assert closed.status_code == 200 and closed.json() == {'requestId': data['requestId'], 'state': 'closed', 'executed': False}
    assert (await client.put(PATH, json=data)).status_code == 409
    assert (await client.get(receipt)).json() == closed.json()
    assert (await client.get(PATH)).json() == {'revision': 0, 'tags': {}, 'holdings': []}
    async with db.connection() as conn:
        assert (await (await conn.execute('SELECT count(*) n FROM card_preference_operations')).fetchone())['n'] == 1


async def test_close_and_accept_race_has_one_durable_outcome(client, admin, db):
    data = command()
    receipt = PATH + '/operations/' + data['requestId']
    save, close = await asyncio.gather(client.put(PATH, json=data), client.post(receipt + '/close', json={}))
    final = (await client.get(receipt)).json()
    if save.status_code == 200:
        assert close.json() == final == save.json()
    else:
        assert save.status_code == 409 and final == close.json() and final['state'] == 'closed'
    async with db.connection() as conn:
        assert (await (await conn.execute('SELECT count(*) n FROM card_preference_operations')).fetchone())['n'] == 1


async def test_session_owner_and_csrf_boundaries(client, admin, db, app):
    data = command()
    assert (await client.put(PATH, json=data, headers={'x-csrf-token': ''})).status_code == 403
    assert (await client.put(PATH, json=data, headers={'authorization': 'Bearer invalid'})).status_code == 403
    assert (await client.put(PATH, json=data)).status_code == 200
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://testserver', headers={'origin': 'http://testserver'}) as peer:
        registered = await peer.post('/api/session/register', json={'username': 'OtherCardUser', 'password': 'SyntheticOther9Pass'})
        assert registered.status_code == 201
        assert (await peer.get(PATH + '/operations/' + data['requestId'])).status_code == 404
    async with db.connection() as conn:
        await conn.execute('DELETE FROM sessions WHERE user_id=%s', (admin,))
    assert (await client.get(PATH)).status_code == 401


async def test_strict_canonical_fields_do_not_create_preference_rows(client, admin, db):
    for data in (command(expectedRevision=True), command(kind=[]), command(kind='holdings', value=1), command(requestId='invalid'), {**command(), 'unknown': True}):
        assert (await client.put(PATH, json=data)).status_code == 400
    async with db.connection() as conn:
        assert not await (await conn.execute('SELECT 1 FROM card_preference_operations')).fetchone()
