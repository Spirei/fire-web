"""Pure calendar source adapters and public projections over synthetic documents."""
import json
from types import SimpleNamespace

import pytest
from alcor_api.public_earnings_reference import PublicEarnings
from alcor_api.earnings_calendar_protocol import Target, PageFailure


def adapter():
    target=Target('public-calendar','nasdaq',('1.1.1.1',),True)
    service=PublicEarnings(lambda:[target])
    policy=SimpleNamespace(kind='earnings.calendar',source_version=service.source_version,target_id=target.id,
        target_fingerprint=target.fingerprint,markets=('US',),months=('2026-01',))
    return service,target,policy


def test_calendar_policy_explicit_month_and_market_never_expand_with_current_date():
    service,target,policy=adapter()
    query=service.normalize({'market':'US','month':'2026-01','pageKey':'2026-01-02'},collect=True)
    assert service.target(policy)==target
    service.validate(policy,target,query)
    assert service.scope(query)=={'market':'US','month':'2026-01'}
    with pytest.raises(ValueError):service.validate(policy,target,{**query,'month':'2026-02'})
    with pytest.raises(ValueError):service.normalize({**query,'sourceRevision':'private'},collect=True)
    with pytest.raises(ValueError):service.normalize({'market':'US','month':'2026-01'},collect=True)


async def test_calendar_archives_incomplete_http_bytes_without_treating_them_as_events(monkeypatch):
    import alcor_api.public_earnings_reference as module
    service,target,_policy=adapter()
    async def failed(*args):raise PageFailure(b'{"private":"synthetic-error"}',503,False)
    monkeypatch.setattr(module,'fetch',failed)
    query={'market':'US','month':'2026-01','pageKey':'2026-01-02'}
    pages=await service.acquire(target,query)
    assert pages==[{'kind':'calendar','raw':b'{"private":"synthetic-error"}','status':503,'complete':False}]
    with pytest.raises(ValueError):service.project(pages,query)


def test_calendar_same_page_revision_replaces_old_observation_and_missing_days_remain_unknown():
    service,_target,_policy=adapter()
    query={'market':'US','month':'2026-01','pageKey':'2026-01-02'}
    def observation(name,stamp):
        raw=json.dumps({'data':{'rows':[{'symbol':'AAPL','name':name,'time':'time-unknown','fiscalQuarterEnding':'2025-12','epsForecast':None,'noOfEsts':None,'marketCap':None}]}}).encode()
        payload=service.project([{'kind':'calendar','raw':raw,'status':200,'complete':True}],query)
        return {'query':query,'payload':payload,'observedAt':stamp,'licenseRevision':'synthetic-license'}
    result=service.combine([observation('Old','2026-01-01T00:00:00Z'),observation('New','2026-01-01T01:00:00Z')],service.scope(query))
    assert len(result['items'])==1 and result['items'][0]['name']=='New'
    assert result['items'][0]['epsForecast']=='' and result['items'][0]['ests'] is None
    assert result['updatedAt']=='2026-01-01T01:00:00Z'
    assert result['coverage']['complete'] is False and len(result['coverage']['missingDates'])==30
    assert result['automaticCollection'] is result['collectionOnRead'] is False
    assert result['sourcePageIds']==[] and result['sourceRevision'] is None


@pytest.mark.parametrize('market,source,page_key,path',[
    ('US','nasdaq','2026-01-02','/api/v1/earnings'),
    ('CN','eastmoney','1','/api/v2/earnings'),
    ('HK','xueqiu','month','/api/earnings'),
])
async def test_public_calendar_real_http_independent_license_original_uuid_and_no_private_fallback(client,admin,app,settings,tmp_path,monkeypatch,market,source,page_key,path):
    from dataclasses import asdict
    from datetime import UTC,datetime,timedelta
    from uuid import uuid4
    import httpx
    import alcor_api.public_earnings_reference as module
    from alcor_api.public_reference import PublicReferencePolicy
    cookie=tmp_path/'synthetic-calendar-cookie'
    cookie.write_text('synthetic-cookie=fixture');cookie.chmod(0o600)
    target=Target('public-calendar-'+market,source,('1.1.1.1',),True,cookie_file=str(cookie) if market=='HK' else None)
    now=datetime.now(UTC)
    policy=PublicReferencePolicy('calendar-license-'+market,'earnings.calendar',module.SOURCE_VERSION,target.id,target.fingerprint,
        'synthetic-explicit-license','a'*64,str(settings.instance_id),(now-timedelta(days=1)).isoformat(),(now+timedelta(days=1)).isoformat(),('collect','display'),(market,),months=('2026-01',))
    settings.public_earnings_targets=[asdict(target)];settings.public_reference_policies=[asdict(policy)]
    if market=='US':body={'data':{'rows':[{'symbol':'AAPL','name':'Synthetic','time':'time-unknown'}]}}
    elif market=='CN':body={'success':True,'result':{'pages':1,'data':[{'SECURITY_CODE':'600000','SECURITY_NAME_ABBR':'Synthetic','FIRST_APPOINT_DATE':'2026-01-02','REPORT_TYPE_NAME':'Annual'}]}}
    else:body={'error_code':0,'data':{'items':[{'pre_hour':[{'symbol':'700','name':'Synthetic','report_date':int(datetime(2026,1,2,tzinfo=UTC).timestamp()*1000),'fiscal_year':2025,'report_type_name':'Annual'}]}]}}
    raw=json.dumps(body).encode();calls=[]
    async def controlled(t,m,month,key):
        calls.append((t.id,m,month,key));return raw
    monkeypatch.setattr(module,'fetch',controlled)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app,raise_app_exceptions=False),base_url='http://testserver') as anon:
        assert (await anon.get(path,params={'market':market,'month':'2026-01'})).status_code==503
        assert calls==[]
        installed=await client.post('/api/system/public-reference/install',json={'requestId':str(uuid4()),'policyId':policy.id,'password':'Synthetic9Pass'})
        assert installed.status_code==200,installed.text
        rid=str(uuid4());command={'requestId':rid,'licenseId':installed.json()['licenseId'],'query':{'market':market,'month':'2026-01','pageKey':page_key},'password':'Synthetic9Pass'}
        captured=await client.post('/api/system/public-reference/collect',json=command)
        assert captured.status_code==200 and captured.json()['state']=='observed',captured.text
        assert (await client.post('/api/system/public-reference/collect',json=command)).json()==captured.json()
        assert len(calls)==1
        original=await client.post('/api/system/public-reference/originals/'+captured.json()['originalIds'][0],json={'requestId':str(uuid4()),'password':'Synthetic9Pass'})
        assert original.content==raw,original.text
        observed=await anon.get(path,params={'market':market,'month':'2026-01'})
        assert observed.status_code==200,observed.text
        value=observed.json()['data'] if path.startswith('/api/v') else observed.json()
        assert len(value['items'])==1 and value['items'][0]['date']=='2026-01-02'
        assert value['coverage']['complete'] is False and value['collectionOnRead'] is False
        # Even a valid Web cookie must not rescue an explicitly malformed header.
        for malformed in ('','garbage','Bearer  bad'):
            denied=await client.get(path,params={'market':market,'month':'2026-01'},headers={'authorization':malformed})
            assert denied.status_code==401,denied.text
        client.cookies.set('fire_session','')
        assert (await client.get(path,params={'market':market,'month':'2026-01'})).status_code==401
        client.cookies.delete('fire_session')
        assert len(calls)==1 and not value['sourcePageIds']
        async with app.state.db.connection() as conn:
            for table in ('earnings_calendar_pages','earnings_calendar_admissions','market_source_configs'):
                assert not await(await conn.execute('SELECT 1 FROM '+table+' LIMIT 1')).fetchone()
        assert (await anon.get(path,params={'market':market,'month':'2026-01'},headers={'authorization':'Bearer invalid'})).status_code==401
        anon.cookies.set('fire_session','invalid')
        assert (await anon.get(path,params={'market':market,'month':'2026-01'})).status_code==401
        anon.cookies.clear()
        revoked=await client.post('/api/system/public-reference/revoke',json={'requestId':str(uuid4()),'licenseId':installed.json()['licenseId'],'password':'Synthetic9Pass'})
        assert revoked.status_code==200,revoked.text
        assert (await anon.get(path,params={'market':market,'month':'2026-01'})).status_code==503
        assert len(calls)==1
