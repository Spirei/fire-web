"""Actual SEC projections use independent public licences, never personal captures."""
import json
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import httpx
import pytest
from alcor_api.public_reference import PublicReferencePolicy


@pytest.mark.parametrize('kind',['company-profile','financials'])
async def test_public_sec_original_uuid_scopes_private_isolation_and_revocation(client,app,admin,kind):
    service=app.state.public_reference;adapter=service.adapters[kind]
    target=adapter.domain.target_type('public-sec-test',('8.8.8.8',),('1.1.1.1',),'Synthetic contact@example.invalid')
    adapter.target_provider=lambda:(target,)
    now=datetime.now(UTC)
    policy=PublicReferencePolicy('public-sec-'+kind,kind,adapter.source_version,target.id,target.fingerprint,'synthetic-license','a'*64,
        str(app.state.db.settings.instance_id),(now-timedelta(days=1)).isoformat(),(now+timedelta(days=1)).isoformat(),('collect','display'),('US',),('ZZZX',))
    installed=[policy];service.policy_provider=lambda:installed
    directory=json.dumps({'0':{'ticker':'ZZZX','cik_str':1234567,'title':'Synthetic public corp'}}).encode()
    facts={'us-gaap':{'Revenues':{'units':{'USD':[{'val':123456789012345,'start':'2026-01-01','end':'2026-06-30','filed':'2026-08-01','form':'10-Q','fy':2026,'fp':'Q2','accn':'synthetic-original-filing'}]}}}}
    document=json.dumps({'cik':1234567,'tickers':['ZZZX'],'name':'Synthetic public corp','entityName':'Synthetic public corp','facts':facts,'exchanges':['NYSE']}).encode()
    class SEC:
        calls=0
        async def read(self,selected,cik=None):
            self.calls+=1
            return directory if cik is None else document
    transport=SEC();adapter.transport=transport
    installed_response=await client.post('/api/system/public-reference/install',json={'requestId':str(uuid4()),'policyId':policy.id,'password':'Synthetic9Pass'})
    assert installed_response.status_code==200,installed_response.text
    license_id=installed_response.json()['licenseId']
    command={'requestId':str(uuid4()),'licenseId':license_id,'query':{'market':'US','code':'ZZZX'},'password':'Synthetic9Pass'}
    captured=await client.post('/api/system/public-reference/collect',json=command)
    assert captured.status_code==200,captured.text
    assert captured.json()['state']=='observed',captured.text
    assert (await client.post('/api/system/public-reference/collect',json=command)).json()==captured.json()
    paths=['/api/company-profile','/api/v1/company-profile','/api/v2/company-profile'] if kind=='company-profile' else ['/api/financials']
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver',headers={'origin':'http://testserver'}) as public:
        for path in paths:
            for headers in ({},{'Cookie':'theme=dark'}):
                response=await public.get(path+'?market=US&code=ZZZX',headers=headers)
                assert response.status_code==200,response.text
                data=response.json()['data'] if '/v1/' in path or '/v2/' in path else response.json()
                assert data['company']=='Synthetic public corp'
                if kind=='financials':
                    assert data['metrics']['revenue']==[{'period':'2026-06-30','value':123456789012345,'fiscalYear':2026,'fiscalPeriod':'Q2'}]
                    observation=data['migration']['metricObservations']['revenue']
                    assert observation['selected'][0]['valueText']=='123456789012345'
                    assert observation['durationInterpretation']=='as_filed_no_ytd_to_quarter_conversion'
                assert data['migration']['authority']=='independently_licensed_public_sec'
                assert 'sourcePageId' not in json.dumps(data) and 'originalIds' not in json.dumps(data)
            assert (await public.get(path+'?market=US&code=ZZZX',headers={'Authorization':'Bearer fat_invalid'})).status_code==401
            assert (await public.get(path+'?market=US&code=ZZZX',headers={'Cookie':'alcor_session='})).status_code==401
        assert (await public.get(paths[0]+'?market=US&code=OTHER')).status_code==503
        installed[:]=[replace(policy,instance_id=str(uuid4()))]
        assert (await public.get(paths[0]+'?market=US&code=ZZZX')).status_code==503
        installed[:]=[policy]
        # Valid signed-in legacy URLs also select the independent public scope by default.
        assert (await client.get(paths[0]+'?market=US&code=ZZZX')).status_code==200
        for malformed in ('', 'not-bearer', 'Bearer '):
            assert (await client.get(paths[0]+'?market=US&code=ZZZX',headers={'Authorization':malformed})).status_code==401
        original_id=captured.json()['originalIds'][-1]
        assert (await public.post('/api/system/public-reference/originals/'+original_id,json={'requestId':str(uuid4()),'password':'Synthetic9Pass'})).status_code==401
        original=await client.post('/api/system/public-reference/originals/'+original_id,json={'requestId':str(uuid4()),'password':'Synthetic9Pass'})
        assert original.status_code==200 and original.content==document
        revoked=await client.post('/api/system/public-reference/revoke',json={'requestId':str(uuid4()),'licenseId':license_id,'password':'Synthetic9Pass'})
        assert revoked.status_code==200,revoked.text
        assert (await public.get(paths[0]+'?market=US&code=ZZZX')).status_code==503
        receipt=await client.get('/api/system/public-reference/operations/'+command['requestId'])
        assert receipt.status_code==200 and receipt.json()==captured.json()
    assert transport.calls==2
    async with app.state.db.connection() as conn:
        for table in ('market_source_configs','sec_company_receipts','sec_financial_receipts'):
            assert (await (await conn.execute('SELECT count(*) AS n FROM '+table)).fetchone())['n']==0


async def test_public_sec_partial_archive_unknown_no_retry_overlap_and_restore_quarantine(client,app,admin):
    service=app.state.public_reference;adapter=service.adapters['company-profile']
    target=adapter.domain.target_type('public-partial',('8.8.8.8',),('1.1.1.1',),'Synthetic contact@example.invalid')
    adapter.target_provider=lambda:(target,)
    now=datetime.now(UTC)
    policy=PublicReferencePolicy('partial-public','company-profile',adapter.source_version,target.id,target.fingerprint,'synthetic-license','a'*64,str(app.state.db.settings.instance_id),(now-timedelta(days=1)).isoformat(),(now+timedelta(days=1)).isoformat(),('collect','display'),('US',),('ZZZX',))
    policies=[policy];service.policy_provider=lambda:policies
    directory=json.dumps({'0':{'ticker':'ZZZX','cik_str':1234567,'title':'Synthetic Corp'}}).encode()
    class Interrupted:
        calls=0
        async def read(self,selected,cik=None):
            self.calls+=1
            if cik is not None:raise TimeoutError('synthetic response outcome unknown')
            return directory
    source=Interrupted();adapter.transport=source
    installed=await client.post('/api/system/public-reference/install',json={'requestId':str(uuid4()),'policyId':policy.id,'password':'Synthetic9Pass'})
    identifier=installed.json()['licenseId']
    command={'requestId':str(uuid4()),'licenseId':identifier,'query':{'market':'US','code':'ZZZX'},'password':'Synthetic9Pass'}
    failed=await client.post('/api/system/public-reference/collect',json=command)
    assert failed.status_code==200 and failed.json()['state']=='unknown',failed.text
    assert len(failed.json()['originalIds'])==1
    assert (await client.post('/api/system/public-reference/collect',json=command)).json()==failed.json()
    assert source.calls==2
    original=await client.post('/api/system/public-reference/originals/'+failed.json()['originalIds'][0],json={'requestId':str(uuid4()),'password':'Synthetic9Pass'})
    assert original.status_code==200 and original.content==directory
    second=replace(policy,id='overlapping-public');policies.append(second)
    assert (await client.post('/api/system/public-reference/install',json={'requestId':str(uuid4()),'policyId':second.id,'password':'Synthetic9Pass'})).status_code==200
    assert (await client.get('/api/company-profile?market=US&code=ZZZX')).status_code==409
    async with app.state.db.connection() as conn:
        await conn.execute("INSERT INTO restore_quarantine(category,payload) VALUES('external_delivery_disabled','{\"disabled\":true}')")
    blocked=await client.post('/api/system/public-reference/collect',json={**command,'requestId':str(uuid4())})
    assert blocked.status_code==403,blocked.text
    assert source.calls==2


async def test_mixed_public_reference_kinds_never_validate_or_read_other_kind(client,app,admin,monkeypatch):
    from alcor_api import public_earnings_reference as calendar
    from alcor_api.earnings_calendar_protocol import Target
    service=app.state.public_reference;policies=[];service.policy_provider=lambda:policies
    now=datetime.now(UTC);day=now.date().isoformat();month=day[:7]
    for kind in ('company-profile','financials','earnings.calendar'):
        adapter=service.adapters[kind]
        if kind=='earnings.calendar':
            target=Target('mixed-calendar','nasdaq',('8.8.8.8',),True)
            adapter.target_provider=lambda target=target:(target,)
            async def source(*args):return json.dumps({'data':{'rows':[{'symbol':'EARN','name':'Calendar only'}]}}).encode()
            monkeypatch.setattr(calendar,'fetch',source)
            query={'market':'US','month':month,'pageKey':day}
        else:
            target=adapter.domain.target_type('mixed-'+kind,('8.8.8.8',),('1.1.1.1',),'Synthetic contact@example.invalid')
            adapter.target_provider=lambda target=target:(target,)
            class SEC:
                async def read(self,target,cik=None):
                    return json.dumps({'0':{'ticker':'ZZZX','cik_str':1234567,'title':'Mixed'}} if cik is None else {'cik':1234567,'tickers':['ZZZX'],'name':'Company only','entityName':'Financial only','facts':{'us-gaap':{}}}).encode()
            adapter.transport=SEC();query={'market':'US','code':'ZZZX'}
        policy=PublicReferencePolicy('mixed-'+kind,kind,adapter.source_version,target.id,target.fingerprint,'mixed-license','a'*64,str(app.state.db.settings.instance_id),(now-timedelta(days=1)).isoformat(),(now+timedelta(days=1)).isoformat(),('collect','display'),('US',),('ZZZX',) if kind!='earnings.calendar' else (), (month,) if kind=='earnings.calendar' else ())
        policies.append(policy)
        installed=await client.post('/api/system/public-reference/install',json={'requestId':str(uuid4()),'policyId':policy.id,'password':'Synthetic9Pass'})
        assert installed.status_code==200,installed.text
        captured=await client.post('/api/system/public-reference/collect',json={'requestId':str(uuid4()),'licenseId':installed.json()['licenseId'],'query':query,'password':'Synthetic9Pass'})
        assert captured.status_code==200 and captured.json()['state']=='observed',captured.text
    company=await client.get('/api/company-profile?market=US&code=ZZZX')
    financial=await client.get('/api/financials?market=US&code=ZZZX')
    earnings=await client.get('/api/earnings?market=US&month='+month)
    assert company.status_code==financial.status_code==earnings.status_code==200,(company.text,financial.text,earnings.text)
    assert company.json()['company']=='Company only'
    assert financial.json()['company']=='Financial only'
    assert earnings.json()['items'][0]['name']=='Calendar only'
    assert 'Calendar only' not in company.text+financial.text
    assert 'Company only' not in earnings.text and 'Financial only' not in earnings.text


async def test_sec_revocation_after_directory_stops_second_request_and_keeps_prefix(client,app,admin):
    service=app.state.public_reference;adapter=service.adapters['company-profile']
    target=adapter.domain.target_type('revocation-between-pages',('8.8.8.8',),('1.1.1.1',),'Synthetic contact@example.invalid')
    adapter.target_provider=lambda:(target,)
    now=datetime.now(UTC)
    policy=PublicReferencePolicy('two-page-revoke','company-profile',adapter.source_version,target.id,target.fingerprint,'synthetic-license','a'*64,str(app.state.db.settings.instance_id),(now-timedelta(days=1)).isoformat(),(now+timedelta(days=1)).isoformat(),('collect','display'),('US',),('ZZZX',))
    service.policy_provider=lambda:[policy]
    installed=await client.post('/api/system/public-reference/install',json={'requestId':str(uuid4()),'policyId':policy.id,'password':'Synthetic9Pass'})
    identifier=installed.json()['licenseId']
    directory=json.dumps({'0':{'ticker':'ZZZX','cik_str':1234567,'title':'Synthetic'}}).encode()
    class RevokedDuringRead:
        calls=0
        async def read(self,selected,cik=None):
            self.calls+=1
            assert cik is None
            result=await client.post('/api/system/public-reference/revoke',json={'requestId':str(uuid4()),'licenseId':identifier,'password':'Synthetic9Pass'})
            assert result.status_code==200,result.text
            return directory
    source=RevokedDuringRead();adapter.transport=source
    command={'requestId':str(uuid4()),'licenseId':identifier,'query':{'market':'US','code':'ZZZX'},'password':'Synthetic9Pass'}
    result=await client.post('/api/system/public-reference/collect',json=command)
    assert result.status_code==200 and result.json()['state']=='retained_unavailable',result.text
    assert source.calls==1 and len(result.json()['originalIds'])==1
    original=await client.post('/api/system/public-reference/originals/'+result.json()['originalIds'][0],json={'requestId':str(uuid4()),'password':'Synthetic9Pass'})
    assert original.status_code==200 and original.content==directory
    assert (await client.get('/api/company-profile?market=US&code=ZZZX')).status_code==503
    receipt=await client.get('/api/system/public-reference/operations/'+command['requestId'])
    assert receipt.status_code==200 and receipt.json()==result.json()
