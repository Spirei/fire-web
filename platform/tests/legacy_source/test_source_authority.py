import copy
import json
from dataclasses import replace
from uuid import uuid4

import httpx
import psycopg
import pytest
from psycopg.errors import CheckViolation
from psycopg.types.json import Jsonb

from alcor_api.source_snapshot import canonical,sha
from .synthetic_legacy import OWNER


async def authorized(client,owner,definition):
    response=await client.post('/api/legacy-financial/authorizations',json={'requestId':str(uuid4()),'sourceAlias':definition.alias,'sourceOwner':OWNER,'targetUserId':owner})
    assert response.status_code==200,response.text
    grant=response.json()
    pending=await client.get('/api/legacy-financial/authorizations')
    assert pending.status_code==200 and pending.json()['items'][0]['source_owner']==OWNER
    response=await client.post('/api/legacy-financial/authorizations/'+grant['grantId']+'/consent',json={'requestId':str(uuid4()),'revision':grant['grantRevision'],'password':'Synthetic9Pass','code':'','approve':True})
    assert response.status_code==200,response.text
    return response.json()


async def export(client,grant,*,predecessor=None):
    command={'requestId':str(uuid4()),'grantRevision':grant['grantRevision'],'predecessorHash':predecessor}
    path='/api/legacy-financial/authorizations/'+grant['grantId']+'/snapshots'
    response=await client.post(path,json=command)
    assert response.status_code==200,response.text
    return response.json(),command,path


async def target(client):
    response=await client.post('/api/broker-accounts',json={'request_id':str(uuid4()),'name':'Synthetic migrated account','provider_id':'longbridge','account_kind':'real','currency':'USD','currencies':['USD']})
    assert response.status_code==201,response.text
    account=response.json()['data']['id']
    response=await client.post('/api/portfolio/records/preview',json={'kind':'create','data':{'name':'Synthetic migrated stock','code':'AAPL','market':'US','price':None,'qty':'0','cost':'0','group':'','note':'','brokerAccountId':account}})
    assert response.status_code==200,response.text
    response=await client.post('/api/portfolio/records/confirm',json={'previewId':response.json()['previewId'],'requestId':str(uuid4())});assert response.status_code==200,response.text
    return account,response.json()['record']['id']


@pytest.mark.asyncio
async def test_product_enabled_explicit_source_grant_single_manifest_to_real_financial_and_fee_ledgers(client,admin,old_pg,app,settings):
    assert settings.environment=='local'  # capability is not tied to test-mode mounting
    grant=await authorized(client,admin,old_pg)
    result,command,path=await export(client,grant)
    assert result['state']=='completed' and result['financialReady'],result
    assert not result['financialApplied'] and result['coverage']['complete']
    response=await client.get('/api/legacy-financial/manifests/'+result['manifestId']);manifest=response.json()['manifest']
    assert manifest['financialSha256']==result['financialSha256'] and manifest['feeInventorySha256']==result['feeInventorySha256']
    async with app.state.db.connection() as conn:
        financial=await(await conn.execute('SELECT source_manifest_id,sha256 FROM financial_import_sources WHERE id=%s',(result['sourceId'],))).fetchone()
        fee=await(await conn.execute('SELECT source_manifest_id,complete FROM fee_legacy_inventory_snapshots WHERE owner_id=%s AND source_digest=%s',(admin,result['feeInventorySha256']))).fetchone()
        assert financial['source_manifest_id']==fee['source_manifest_id'] and str(fee['source_manifest_id'])==result['manifestId']
        assert fee['complete']==manifest['coverage']['complete']
    # A caller cannot replace the source with uploaded evidence.kind/complete labels.
    assert (await client.post('/api/financial-import/sources',json={'complete':True,'kind':'broker_fee'})).status_code==404
    account,record=await target(client)
    data={'requestId':str(uuid4()),'sourceId':result['sourceId'],'sourceHash':result['financialSha256'],'confirmedSourceOwner':OWNER,'targetUserId':admin,'accountMap':{'old-broker-1':account},'recordMap':{'old-record-1':record},'confirmedHistoricalOnly':True}
    response=await client.post('/api/financial-import/preview',json=data)
    assert response.status_code==200 and response.json()['ready'],response.text
    response=await client.post('/api/financial-import/operations',json={'data':data,'preview':response.json()['preview']})
    assert response.status_code==200 and response.json()['financialApplied'],response.text
    async with app.state.db.connection() as conn:
        rows=await(await conn.execute('SELECT amount FROM cash_ledger_entries WHERE owner_id=%s',(admin,))).fetchall()
        assert len(rows)==3 and sum(row['amount'] for row in rows)==__import__('decimal').Decimal('922.5')
        assert (await(await conn.execute('SELECT count(*) n FROM trade_ledger WHERE owner_id=%s',(admin,))).fetchone())['n']==2
    repeated=await client.post(path,json=command);assert repeated.json()==result


@pytest.mark.asyncio
async def test_no_owner_consent_bad_source_or_revocation_cannot_read_or_spend_old_financial_proof(client,admin,old_pg,app):
    registered=await client.post('/api/legacy-financial/authorizations',json={'requestId':str(uuid4()),'sourceAlias':old_pg.alias,'sourceOwner':OWNER,'targetUserId':admin});g=registered.json()
    response=await client.post('/api/legacy-financial/authorizations/'+g['grantId']+'/snapshots',json={'requestId':str(uuid4()),'grantRevision':1,'predecessorHash':None})
    assert response.status_code==409
    response=await client.post('/api/legacy-financial/authorizations/'+g['grantId']+'/consent',json={'requestId':str(uuid4()),'revision':1,'password':'wrong','code':'','approve':True});assert response.status_code==403
    response=await client.post('/api/legacy-financial/authorizations/'+g['grantId']+'/consent',json={'requestId':str(uuid4()),'revision':1,'password':'Synthetic9Pass','code':'','approve':True});grant=response.json()
    result,*_=await export(client,grant);account,record=await target(client)
    data={'requestId':str(uuid4()),'sourceId':result['sourceId'],'sourceHash':result['financialSha256'],'confirmedSourceOwner':OWNER,'targetUserId':admin,'accountMap':{'old-broker-1':account},'recordMap':{'old-record-1':record},'confirmedHistoricalOnly':True}
    response=await client.post('/api/financial-import/preview',json=data);assert response.json()['ready'];proof=response.json()['preview']
    response=await client.post('/api/legacy-financial/authorizations/'+grant['grantId']+'/consent',json={'requestId':str(uuid4()),'revision':grant['grantRevision'],'password':'Synthetic9Pass','code':'','approve':False});assert response.status_code==200
    response=await client.post('/api/financial-import/operations',json={'data':data,'preview':proof});assert response.status_code==409
    async with app.state.db.connection() as conn:assert (await(await conn.execute('SELECT count(*) n FROM trade_ledger')).fetchone())['n']==0


@pytest.mark.asyncio
async def test_prefix_manifest_cas_and_changed_old_order_stays_conflict_evidence(client,admin,old_pg,app,pg):
    grant=await authorized(client,admin,old_pg);first,*_=await export(client,grant)
    response=await client.post('/api/legacy-financial/authorizations/'+grant['grantId']+'/snapshots',json={'requestId':str(uuid4()),'grantRevision':grant['grantRevision'],'predecessorHash':None});assert response.status_code==409
    second,*_=await export(client,grant,predecessor=first['manifestSha256'])
    assert second['headAdvanced'] and second['financialReady']
    manifest=(await client.get('/api/legacy-financial/manifests/'+second['manifestId'])).json()['manifest']
    assert manifest['prefixCheck']['appendOnlyPrefixVerified'] and manifest['predecessorHash']==first['manifestSha256']
    async with await psycopg.AsyncConnection.connect(pg.get_uri(database=old_pg.expected_database),autocommit=True) as conn:
        await conn.execute("UPDATE trade_orders SET fees=9 WHERE id='old-order-1'")
    third,*_=await export(client,grant,predecessor=second['manifestSha256'])
    assert not third['headAdvanced'] and not third['financialReady'] and any(b['code']=='source_prefix_conflict' for b in third['normalizationBlockers'])


@pytest.mark.asyncio
async def test_source_owner_internal_user_id_and_public_numeric_uid_are_separate(client,admin,old_pg,app):
    async with app.state.db.connection() as conn:
        user=await(await conn.execute('SELECT id,uid FROM users WHERE id=%s',(admin,))).fetchone()
    assert user['uid'].isdigit() and len({OWNER,user['id'],user['uid']})==3
    registration={'requestId':str(uuid4()),'sourceAlias':old_pg.alias,'sourceOwner':OWNER,'targetUserId':user['id']}
    bad=await client.post('/api/legacy-financial/authorizations',json={**registration,'targetUserId':user['uid']})
    assert bad.status_code==404 and '内部账号标识' in bad.text
    bad=await client.post('/api/legacy-financial/authorizations',json={**registration,'targetUid':registration['targetUserId']})
    assert bad.status_code==422
    good=await client.post('/api/legacy-financial/authorizations',json=registration)
    assert good.status_code==200,good.text
    assert good.json()['targetUserId']==user['id'] and good.json()['targetPublicUid']==user['uid'] and good.json()['sourceOwner']==OWNER
    grant=good.json()
    response=await client.post('/api/legacy-financial/authorizations/'+grant['grantId']+'/consent',json={'requestId':str(uuid4()),'revision':grant['grantRevision'],'password':'Synthetic9Pass','code':'','approve':True});grant=response.json()
    snapshot,*_=await export(client,grant);account,record=await target(client)
    command={'requestId':str(uuid4()),'sourceId':snapshot['sourceId'],'sourceHash':snapshot['financialSha256'],'confirmedSourceOwner':OWNER,'targetUserId':user['id'],'accountMap':{'old-broker-1':account},'recordMap':{'old-record-1':record},'confirmedHistoricalOnly':True}
    response=await client.post('/api/financial-import/preview',json=command)
    assert response.status_code==200 and response.json()['ready'],response.text
    assert response.json()['targetUserId']==user['id'] and response.json()['targetPublicUid']==user['uid'] and 'targetUid' not in response.json()
    response=await client.post('/api/financial-import/preview',json={**command,'targetUserId':user['uid']});assert response.status_code==409
    response=await client.post('/api/financial-import/preview',json={**command,'targetUid':user['uid']});assert response.status_code==422
