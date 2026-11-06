import hashlib
import json
from dataclasses import replace
from uuid import uuid4

import httpx
import pytest
from psycopg.errors import CheckViolation

from alcor_api.cli import create_user
from .test_source_authority import authorized,export
from .test_source_concurrency import ready


@pytest.mark.asyncio
async def test_non_admin_register_cannot_enumerate_source_alias_or_owner(client,admin,old_pg,app,settings):
    await create_user(settings,'OrdinarySourceUser','Synthetic9Pass',role='user')
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver',headers={'origin':'http://testserver'}) as other:
        login=await other.post('/api/session/login',json={'login':'OrdinarySourceUser','password':'Synthetic9Pass'});other.headers['x-csrf-token']=login.json()['csrf']
        responses=[]
        for alias,owner in ((old_pg.alias,old_pg.owners[0]),('nonexistent-source','nonexistent-owner')):
            response=await other.post('/api/legacy-financial/authorizations',json={'requestId':str(uuid4()),'sourceAlias':alias,'sourceOwner':owner,'targetUserId':admin})
            assert response.status_code==403,response.text
            responses.append(response.json()['error'])
        assert responses[0]==responses[1]


@pytest.mark.asyncio
async def test_import_revoke_then_other_user_or_renamed_same_pg_cannot_claim_same_source(client,admin,old_pg,app,settings):
    grant,source,data,proof=await ready(client,admin,old_pg)
    posted=await client.post('/api/financial-import/operations',json={'data':data,'preview':proof});assert posted.status_code==200 and posted.json()['financialApplied'],posted.text
    raw_path='/api/legacy-financial/manifests/'+source['manifestId']+'/raw'
    before_raw=await client.get(raw_path);assert before_raw.status_code==200
    revoked=await client.post('/api/legacy-financial/authorizations/'+grant['grantId']+'/consent',json={'requestId':str(uuid4()),'revision':grant['grantRevision'],'password':'Synthetic9Pass','code':'','approve':False});assert revoked.status_code==200
    assert (await client.get('/api/financial-import/operations/'+data['requestId'])).json()==posted.json()
    assert (await client.get(raw_path)).content==before_raw.content
    assert (await client.get('/api/legacy-financial/manifests/'+source['manifestId'])).status_code==200
    assert (await client.post('/api/financial-import/preview',json={**data,'requestId':str(uuid4())})).status_code==409
    other=await create_user(settings,'AnotherSourceOwner','Synthetic9Pass',role='user')
    for definition in (old_pg,replace(old_pg,alias='renamed-same-pg',instance='new-label-same-pg')):
        app.state.source_authority.registry[definition.alias]=definition
        response=await client.post('/api/legacy-financial/authorizations',json={'requestId':str(uuid4()),'sourceAlias':definition.alias,'sourceOwner':definition.owners[0],'targetUserId':other})
        assert response.status_code==409 and '归属' in response.text,response.text
    async with app.state.db.connection() as conn:
        claim=await(await conn.execute('SELECT * FROM legacy_source_owner_claims')).fetchone()
        assert claim['owner_id']==admin
        with pytest.raises(CheckViolation):
            async with conn.transaction():await conn.execute('UPDATE legacy_source_owner_claims SET owner_id=%s',(other,))
        assert (await(await conn.execute('SELECT count(*) n FROM trade_ledger')).fetchone())['n']==2
    # The same internal account can explicitly reauthorize; revocation did not move its book.
    renewed=await authorized(client,admin,old_pg)
    result,*_=await export(client,renewed,predecessor=source['manifestSha256'])
    assert result['state']=='completed' and result['financialReady']
