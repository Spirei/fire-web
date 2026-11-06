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
