"""Explicit public collection retains raw evidence without private-owner authority."""
from dataclasses import asdict, replace
from datetime import UTC, datetime
from hashlib import sha256
from uuid import uuid4

import pytest
from alcor_api.dividend_source_transport import ResponseFailure
from alcor_api.market_contract import Query, canonical
from alcor_api.public_market_authority import PublicAuthority
from alcor_api.public_market_quotes import PublicQuotes
from alcor_api.public_market_worker import claim, execute
from fastapi import HTTPException
from test_authority import setup


class Reply:
    def __init__(self, *, hook=None, failure=None, empty=False):
        self.calls, self.hook, self.failure, self.empty, self.raw = 0, hook, failure, empty, None

    async def read(self, policy, query, cursor):
        self.calls += 1
        assert cursor is None
        self.raw = b'' if self.empty else canonical({'query':asdict(query),
            'licenseRevision':policy.license_revision,'facts':[{'at':datetime.now(UTC).isoformat(),
            'currency':'USD','price':'123.450001','session':'REGULAR','cached':False}], 'nextCursor':None}).encode()
        if self.hook:
            await self.hook()
        if self.failure:
            raise self.failure
        return self.raw, 'controlled_http_response_body'


async def admitted(db, client, admin):
    who, policy = await setup(db, client, admin)
    authority = PublicAuthority(db, (policy,))
    installed = await authority.install(who, uuid4(), policy.id, 'Synthetic9Pass')
    query = Query('latest', 'US', 'AAPL')
    queued = await authority.enqueue(who, uuid4(), installed['licenseId'], query, 'Synthetic9Pass')
    task = await claim(authority, uuid4())
    assert str(task['id']) == queued['taskId'] and task['attempts'] == 1
    return authority, who, policy, installed, task


async def test_public_worker_exact_original_then_anonymous_read_never_enqueues_or_repeats(db, client, admin):
    authority, _who, _policy, _installed, task = await admitted(db, client, admin)
    transport = Reply()
    assert await execute(authority, task, transport) == 'completed'
    before = None
    async with db.connection() as conn:
        page = await (await conn.execute('SELECT * FROM public_market_pages WHERE task_id=%s', (task['id'],))).fetchone()
        assert bytes(page['raw_bytes']) == transport.raw and page['raw_sha256'] == sha256(transport.raw).hexdigest()
        assert page['http_status'] is None and page['complete']
        before = (await (await conn.execute('SELECT count(*) n FROM public_market_tasks')).fetchone())['n']
    result = await PublicQuotes(authority).read([{'id':'public','market':'US','code':'AAPL'}])
    assert result['quotes']['public']['price'] == 123.450001
    assert result['quoteStates']['public']['priceExact'] == '123.450001'
    assert await execute(authority, task, transport) == 'lost'
    assert await claim(authority, uuid4()) is None and transport.calls == 1
    async with db.connection() as conn:
        assert (await (await conn.execute('SELECT count(*) n FROM public_market_tasks')).fetchone())['n'] == before
        assert not await (await conn.execute('SELECT 1 FROM market_source_pages')).fetchone()
        assert not await (await conn.execute('SELECT 1 FROM trade_ledger')).fetchone()


@pytest.mark.parametrize('change', ['revoke', 'policy', 'restore'])
async def test_public_received_original_survives_late_permission_loss_without_publication(db, client, admin, change):
    authority, who, policy, installed, task = await admitted(db, client, admin)

    async def changed():
        if change == 'revoke':
            await authority.revoke(who, uuid4(), installed['licenseId'], 'Synthetic9Pass')
        elif change == 'policy':
            authority.policies = (replace(policy, license_revision='changed'),)
        else:
            async with db.connection() as conn:
                await conn.execute("INSERT INTO restore_quarantine(category,payload) VALUES('external_delivery_disabled','{\"disabled\":true}')")

    transport = Reply(hook=changed)
    assert await execute(authority, task, transport) == 'cancelled'
    async with db.connection() as conn:
        page = await (await conn.execute('SELECT * FROM public_market_pages WHERE task_id=%s', (task['id'],))).fetchone()
        assert bytes(page['raw_bytes']) == transport.raw and page['raw_sha256'] == sha256(transport.raw).hexdigest()
        assert not await (await conn.execute('SELECT 1 FROM public_market_facts')).fetchone()
    assert await execute(authority, task, transport) == 'lost'
    assert await claim(authority, uuid4()) is None and transport.calls == 1
    if change != 'restore':
        with pytest.raises(HTTPException):
            await PublicQuotes(authority).read([{'id':'a','market':'US','code':'AAPL'}])


@pytest.mark.parametrize('kind', ['non200', 'truncated', 'empty', 'lost'])
async def test_public_error_originals_and_unknown_outcome_are_not_quotes_or_retries(db, client, admin, kind):
    authority, _who, _policy, _installed, task = await admitted(db, client, admin)
    failure = (ResponseFailure(b'synthetic provider response', 503, kind != 'truncated')
               if kind in ('non200','truncated') else RuntimeError('source response lost') if kind == 'lost' else None)
    transport = Reply(failure=failure, empty=kind == 'empty')
    assert await execute(authority, task, transport) == ('unknown' if kind == 'lost' else 'failed')
    async with db.connection() as conn:
        page = await (await conn.execute('SELECT * FROM public_market_pages WHERE task_id=%s', (task['id'],))).fetchone()
        if kind == 'lost':
            assert page is None
        else:
            raw = b'synthetic provider response' if failure else b''
            assert bytes(page['raw_bytes']) == raw and page['raw_sha256'] == sha256(raw).hexdigest()
            assert page['complete'] is (kind != 'truncated')
            assert page['http_status'] == (503 if failure else None)
        assert not await (await conn.execute('SELECT 1 FROM public_market_facts')).fetchone()
    assert await claim(authority, uuid4()) is None and transport.calls == 1


async def test_public_expired_claim_becomes_unknown_and_cannot_recollect(db, client, admin):
    authority, _who, _policy, _installed, task = await admitted(db, client, admin)
    async with db.connection() as conn:
        await conn.execute("UPDATE public_market_tasks SET lease_until=clock_timestamp()-interval '1 second' WHERE id=%s", (task['id'],))
    assert await claim(authority, uuid4()) is None
    transport = Reply()
    assert await execute(authority, task, transport) == 'lost' and transport.calls == 0
    async with db.connection() as conn:
        row = await (await conn.execute('SELECT * FROM public_market_tasks WHERE id=%s', (task['id'],))).fetchone()
        assert row['status'] == 'unknown' and row['attempts'] == 1


async def test_real_http_install_collect_worker_anonymous_and_password_original_revoke(app, db, settings, client, admin):
    import httpx

    _who, policy = await setup(db, client, admin)
    settings.public_market_data_policies = [asdict(policy)]
    base = '/api/system/public-market'
    request_id = str(uuid4())
    installed = await client.post(base+'/licenses/install', json={
        'requestId':request_id,'policyId':policy.id,'password':'Synthetic9Pass'})
    assert installed.status_code == 200, installed.text
    license_id = installed.json()['licenseId']
    operation = str(uuid4())
    queued = await client.post(base+'/collect', json={
        'requestId':operation,'licenseId':license_id,'query':asdict(Query('latest','US','AAPL')),
        'password':'Synthetic9Pass'})
    assert queued.status_code == 200, queued.text
    authority = app.state.public_market_authority
    task = await claim(authority, uuid4())
    transport = Reply()
    assert await execute(authority, task, transport) == 'completed'
    async with db.connection() as conn:
        page = await (await conn.execute('SELECT id FROM public_market_pages WHERE task_id=%s',(task['id'],))).fetchone()
    original_path = base+'/originals/'+str(page['id'])
    assert (await client.get(original_path)).status_code == 404
    wrong = await client.post(original_path,json={'requestId':str(uuid4()),'password':'WrongSynthetic9'})
    assert wrong.status_code == 403, wrong.text
    original = await client.post(original_path,json={'requestId':str(uuid4()),'password':'Synthetic9Pass'})
    assert original.status_code == 200 and original.content == transport.raw
    assert 'no-store' in original.headers['cache-control']
    payload = {'items':[{'id':'public','market':'US','code':'AAPL'}]}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver') as anonymous:
        for path in ['/api/quotes','/api/v1/quotes']:
            response = await anonymous.post(path,json=payload)
            assert response.status_code == 200, response.text
            data = response.json()['data'] if '/v1/' in path else response.json()
            assert data['quotes']['public']['price'] == 123.450001
            assert str(page['id']) not in response.text and admin not in response.text
        preference=await anonymous.post('/api/quotes',json=payload,headers={'Cookie':'appearance=dark'})
        assert preference.status_code == 200 and preference.json()['quotes']['public']['price'] == 123.450001
        assert (await anonymous.post('/api/quotes',json=payload,headers={'Cookie':'fire_session='})).status_code == 401
        assert (await anonymous.post(original_path,json={'requestId':str(uuid4()),'password':'Synthetic9Pass'})).status_code == 401
        revoked = await client.post(base+'/licenses/revoke',json={
            'requestId':str(uuid4()),'licenseId':license_id,'password':'Synthetic9Pass'})
        assert revoked.status_code == 200, revoked.text
        assert (await anonymous.post('/api/quotes',json=payload)).status_code == 503
    receipt = (await client.get(base+'/operations/'+operation)).json()
    assert {k:v for k,v in receipt.items() if k!='execution'} == queued.json()
    assert receipt['execution']['state']=='completed' and receipt['execution']['willRetryAutomatically'] is False
    assert receipt['execution']['sourceSha256']==sha256(transport.raw).hexdigest()
    assert transport.calls == 1
    async with db.connection() as conn:
        assert (await (await conn.execute('SELECT count(*) n FROM public_market_tasks')).fetchone())['n'] == 1
        assert (await (await conn.execute('SELECT count(*) n FROM public_market_pages')).fetchone())['n'] == 1


async def test_public_real_fixed_yahoo_adapter_uses_public_targets_and_latest_purpose(db, settings, client, admin, monkeypatch):
    import json

    from alcor_api.dividend_sources import Target
    from alcor_api.market_transport import Transport

    who, fixture = await setup(db, client, admin)
    target = Target('public-yahoo','yahoo','query1.finance.yahoo.com',443,('8.8.8.8',),approved_access=True)
    policy = replace(fixture,source='yahoo',source_version='yahoo-chart-history-v1',fixture=False,
                     target_id=target.id,target_fingerprint=target.fingerprint)
    settings.public_market_source_targets = [asdict(target)]
    # A private target with the same security is deliberately irrelevant.
    settings.dividend_source_targets = []
    authority = PublicAuthority(db,(policy,))
    installed = await authority.install(who,uuid4(),policy.id,'Synthetic9Pass')
    await authority.enqueue(who,uuid4(),installed['licenseId'],Query('latest','US','AAPL'),'Synthetic9Pass')
    stamp = int(datetime.now(UTC).timestamp())
    raw = json.dumps({'chart':{'error':None,'result':[{'meta':{
        'symbol':'AAPL','instrumentType':'EQUITY','currency':'USD',
        'regularMarketPrice':123.45,'regularMarketTime':stamp}}]}}).encode()
    calls=[]
    async def source(url, approval):
        calls.append(url)
        assert url.startswith('https://query1.finance.yahoo.com/v8/finance/chart/AAPL?')
        return raw
    monkeypatch.setattr('alcor_api.market_yahoo_history.fetch_page',source)
    task = await claim(authority,uuid4())
    assert task and await execute(authority,task,Transport(db,[target])) == 'completed'
    result = await PublicQuotes(authority).read([{'id':'p','market':'US','code':'AAPL'}])
    assert result['quotes']['p']['price'] == 123.45 and len(calls) == 1
    assert result['quotes']['p']['time'] == datetime.fromtimestamp(stamp,UTC).isoformat()
    async with db.connection() as conn:
        page = await (await conn.execute('SELECT * FROM public_market_pages WHERE task_id=%s',(task['id'],))).fetchone()
        assert bytes(page['raw_bytes']) == raw and page['raw_sha256'] == sha256(raw).hexdigest()
