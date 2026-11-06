"""Public reads use only explicit, independently licensed immutable observations."""
import json
from dataclasses import asdict, replace
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from uuid import uuid4

import pytest
from alcor_api.market_contract import Query
from alcor_api.market_worker import decode
from alcor_api.public_market_authority import PublicAuthority, PublicPolicy
from alcor_api.public_market_quotes import PublicQuotes
from alcor_api.security import Identity, digest
from fastapi import HTTPException
from psycopg.types.json import Jsonb


async def prepared(db, client, admin):
    token = client.cookies.get('alcor_session')
    async with db.connection() as conn:
        row = await (await conn.execute('SELECT u.username,u.role,s.expires_at FROM users u JOIN sessions s ON s.user_id=u.id WHERE u.id=%s AND s.token_hash=%s', (admin, digest(token)))).fetchone()
    who = Identity(id=admin, token_hash=digest(token), csrf=client.headers['x-csrf-token'], **row)
    now = datetime.now(UTC)
    policy = PublicPolicy('public-test', 'fixture', 'fixture-v1', 'synthetic-target', 'a'*64, 'license-1', 'b'*64, str(db.settings.instance_id), (now-timedelta(days=1)).isoformat(), (now+timedelta(days=1)).isoformat(), (('US','AAPL','equity','REGULAR'),), ('collect','display'), True)
    installed = [policy]
    authority = PublicAuthority(db, policy_provider=lambda: installed)
    return who, policy, installed, authority


async def publish(db, authority, who, policy):
    saved = await authority.install(who, uuid4(), policy.id, 'Synthetic9Pass')
    query = Query('latest', 'US', 'AAPL')
    queued = await authority.enqueue(who, uuid4(), saved['licenseId'], query, 'Synthetic9Pass')
    now = datetime.now(UTC)
    raw = json.dumps({'query': asdict(query), 'licenseRevision': policy.license_revision, 'facts': [{'at': now.isoformat(), 'currency':'USD', 'price':'123.4500', 'session':'REGULAR', 'cached':False, 'context': {'privateTarget':'not-public'}, 'snapshotMetricsVersion':1, 'fundValid':True, 'fundUnits':'2', 'underlyingSymbol':'US.MSFT', 'dayStatsExact':{'volume':'12.3400','sourcePageId':'private-page','task_id':'private-task','arbitrary':{'secret':'private-raw'}}}]}).encode()
    facts, _, _ = decode(policy, query, raw)
    page_id = uuid4()
    async with db.connection() as conn, conn.transaction():
        await conn.execute("UPDATE public_market_tasks SET status='running' WHERE id=%s", (queued['taskId'],))
        await conn.execute("INSERT INTO public_market_pages(id,task_id,raw_bytes,raw_sha256,representation,http_status,complete) VALUES(%s,%s,%s,%s,'raw',200,true)", (page_id,queued['taskId'],raw,sha256(raw).hexdigest()))
        await conn.execute('INSERT INTO public_market_facts(id,task_id,page_id,license_id,query,source_time,contents) VALUES(%s,%s,%s,%s,%s,%s,%s)', (uuid4(),queued['taskId'],page_id,saved['licenseId'],Jsonb(asdict(query)),now,Jsonb(facts[0])))
        await conn.execute("UPDATE public_market_tasks SET status='completed' WHERE id=%s", (queued['taskId'],))
    return saved


async def test_default_closed_and_anonymous_bad_credentials_never_downgrade(db, client, admin, app):
    _, _, _, authority = await prepared(db, client, admin)
    reader = PublicQuotes(authority)
    with pytest.raises(HTTPException) as absent:
        await reader.read([{'id':'a','market':'US','code':'AAPL'}])
    assert absent.value.status_code == 503
    app.state.public_market_quotes = reader
    body = {'items':[{'id':'a','market':'US','code':'AAPL'}]}
    client.cookies.clear()
    assert (await client.post('/api/quotes', json=body)).status_code == 503
    assert (await client.post('/api/v1/quotes', json=body)).status_code == 503
    assert (await client.post('/api/v2/quotes', json=body)).status_code == 401
    assert (await client.post('/api/quotes', json=body, headers={'Authorization':'Bearer invalid'})).status_code == 401
    assert (await client.post('/api/v1/quotes', json=body, headers={'Cookie':'alcor_session=expired'})).status_code == 401
    async with db.connection() as conn:
        assert not await (await conn.execute('SELECT 1 FROM public_market_tasks')).fetchone()


async def test_public_exact_original_projection_scope_revocation_and_expiry(db, client, admin):
    who, policy, installed, authority = await prepared(db, client, admin)
    saved = await publish(db, authority, who, policy)
    reader = PublicQuotes(authority)
    items = [{'id':'a','market':'US','code':'AAPL'}, {'id':'b','market':'US','code':'MSFT'}]
    result = await reader.read(items)
    assert result['quotes']['a']['price'] == 123.45
    assert result['quoteStates']['a']['priceExact'] == '123.4500'
    assert result['quoteStates']['b']['state'] == 'public_scope_unavailable'
    encoded = json.dumps(result)
    assert all(secret not in encoded for secret in ('privateTarget', 'sourcePageId', 'page_id', 'task_id', 'private-page', 'private-task', 'private-raw'))
    assert 'sourcePageId' not in result['quotes']['a']['fundMetrics']
    assert 'sourcePageId' not in result['quotes']['a']['snapshotMetrics']
    assert result['quotes']['a']['dayStatsExact'] == {'volume':'12.3400'}
    assert result['quotes']['a']['underlyingSymbol'] == 'US.MSFT'
    installed[:] = [replace(policy, valid_until=(datetime.now(UTC)-timedelta(seconds=1)).isoformat())]
    with pytest.raises(HTTPException):
        await reader.read(items)
    installed[:] = [policy]
    await authority.revoke(who, uuid4(), saved['licenseId'], 'Synthetic9Pass')
    with pytest.raises(HTTPException):
        await reader.read(items)
    async with db.connection() as conn:
        assert (await (await conn.execute('SELECT count(*) AS n FROM public_market_pages')).fetchone())['n'] == 1


async def test_overlapping_public_license_is_unknown_not_first_source(db, client, admin):
    who, policy, installed, authority = await prepared(db, client, admin)
    await publish(db, authority, who, policy)
    other = replace(policy, id='second-public-license', license_revision='license-2')
    installed.append(other)
    await authority.install(who, uuid4(), other.id, 'Synthetic9Pass')
    result = await PublicQuotes(authority).read([{'id':'a','market':'US','code':'AAPL'}])
    assert result == {'quotes':{}, 'quoteStates':{'a':{'state':'ambiguous_public_source'}}}
    async with db.connection() as conn:
        assert (await (await conn.execute('SELECT count(*) AS n FROM public_market_tasks')).fetchone())['n'] == 1
