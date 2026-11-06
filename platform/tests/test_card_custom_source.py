"""Execute frozen legacy TypeScript against SQLite :memory:, then compare the real PG adapter."""

import asyncio
import json
import subprocess
from pathlib import Path
from uuid import UUID

import httpx
from alcor_api.security import digest
from test_card_catalog import SOURCE, imported, sign_in


def semantic(value):
    if isinstance(value,dict):
        return {key:semantic(item) for key,item in value.items() if key not in ('id','createdAt')}
    if isinstance(value,list):
        return [semantic(item) for item in value]
    return value


async def test_frozen_custom_routes_match_user_admin_errors_normalization_and_global_side_effects(client,app,db):
    admin_id=await sign_in(client)
    assert (await imported(client))[0].status_code==200
    image='/uploads/asset/card/synthetic.png'
    base={'name':' Private Card ','bank':' Synthetic Bank ','image':image,'currencyScope':' MuLtI ','type':'unknown','brand':None,'level':123}
    admin_body={'name':'\u0085Admin Card\u0085','bank':'Public Bank','region':'\u0085HK\u0085','image':image,'type':'信用卡','currencyScope':'single'}
    steps=[
        {'name':'anonymous','method':'GET'},
        {'name':'empty','method':'GET','owner':'peer'},
        {'name':'no-name','method':'POST','owner':'peer','body':{'bank':'X','image':image}},
        {'name':'no-bank','method':'POST','owner':'peer','body':{'name':'X','image':image}},
        {'name':'bad-image','method':'POST','owner':'peer','body':{'name':'X','bank':'Y','image':'https://image.invalid/card.png'}},
        {'name':'han-duplicate','method':'POST','owner':'peer','body':{'name':'萬 事 達','bank':'滙 豐','image':image}},
        {'name':'create-peer','method':'POST','owner':'peer','body':base,'ref':'peer-card'},
        {'name':'get-peer','method':'GET','owner':'peer'},
        {'name':'hold-peer','method':'HOLD','owner':'peer','image':image},
        {'name':'create-admin','method':'POST','owner':'admin','body':admin_body,'ref':'admin-card'},
        {'name':'get-admin','method':'GET','owner':'admin'},
        {'name':'foreign-delete','method':'DELETE','owner':'peer','idRef':'admin-card'},
        {'name':'delete-admin-shared','method':'DELETE','owner':'admin','idRef':'admin-card'},
        {'name':'delete-peer-last-no-global-authority','method':'DELETE','owner':'peer','idRef':'peer-card'},
        {'name':'final-admin','method':'POST','owner':'admin','body':{**admin_body,'name':'Final Card'},'ref':'final-card'},
        {'name':'delete-last-admin','method':'DELETE','owner':'admin','idRef':'final-card'},
        {'name':'missing-id','method':'DELETE','owner':'peer'},
        {'name':'get-peer-end','method':'GET','owner':'peer'},
        {'name':'limited','method':'POST','owner':'peer','body':base,'limited':True},
    ]
    execution=await asyncio.to_thread(subprocess.run,['node',str(Path(__file__).with_name('card_custom_source.cjs'))],input=json.dumps({'manifest':json.loads(SOURCE),'steps':steps},ensure_ascii=True),text=True,capture_output=True,check=True)
    frozen=json.loads(execution.stdout)
    references={}; results=[]
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver',headers={'origin':'http://testserver'}) as peer,httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver') as anonymous:
        peer_id=await sign_in(peer,'GoldenCardPeer')
        for step in steps:
            target=client if step.get('owner')=='admin' else peer if step.get('owner')=='peer' else anonymous
            if step['method']=='HOLD':
                assert (await target.put('/api/cards/holdings',json={'cardKey':step['image'],'held':True})).status_code==200
                continue
            if step.get('limited'):
                bucket=digest('card-custom:'+peer_id+':127.0.0.1')
                async with db.connection() as conn:
                    await conn.execute('INSERT INTO auth_rate_limits(bucket,window_start,attempts) VALUES(%s,clock_timestamp(),60) ON CONFLICT(bucket) DO UPDATE SET window_start=excluded.window_start,attempts=60',(bucket,))
            response=await target.request(step['method'],'/api/cards/custom',**({'json':step['body']} if 'body' in step else {}),**({'params':{'id':references[step['idRef']]}} if 'idRef' in step else {}))
            value=response.json()
            if step.get('ref') and 'card' in value:
                references[step['ref']]=value['card']['id']
                UUID(value['card']['id'])
                assert value['card']['createdAt'].endswith('Z')
            results.append({'name':step['name'],'status':response.status_code,'body':value})
            if step['name']=='create-admin':
                published=(await client.get('/api/account/card-catalog')).json()['publishedAssets']
                assert len(published)==1 and published[0]['id']=='card:'+image
                assert published[0]['market']=='\u0085HK\u0085' and published[0]['code']=='\u0085ADMIN CARD\u0085'
                async with db.connection() as conn:
                    assert (await(await conn.execute('SELECT updated_by FROM card_catalog_public_index WHERE image_path=%s',(image,))).fetchone())['updated_by']==admin_id
            if step['name'] in ('delete-admin-shared','delete-peer-last-no-global-authority'):
                assert len((await client.get('/api/account/card-catalog')).json()['publishedAssets'])==1
            if step['name']=='delete-last-admin':
                assert (await client.get('/api/account/card-catalog')).json()['publishedAssets']==[]
        assert (await peer.get('/api/cards/holdings')).json()=={'holdings':[]}
    assert semantic(results)==semantic(frozen['results'])
    assert [call['kind'] for call in frozen['calls']]==['upsert','upsert','delete']
    assert frozen['calls'][-1]['id']=='card:'+image
    assert frozen['holdings']==[]
