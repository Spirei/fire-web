"""The completed legacy amount read is compared with frozen TS reading a separate memory SQLite DB."""

import asyncio
import json
import subprocess
from pathlib import Path

import httpx
from test_card_wallet import apply, owner


async def test_legacy_amount_get_matches_frozen_source_zero_missing_currency_precision_order_and_owner(client,app,db):
    await owner(client)
    await apply(client,'set_amount','987',key='admin.png',currency='EUR')
    seed=[{'owner':'peer','cardKey':'zero.png','amount':'0','currency':'','note':'Synthetic zero','updatedAt':'2020-01-01T00:00:00.000Z'},
          {'owner':'peer','cardKey':'fraction.png','amount':'0.123456789123456789','currency':'USD','note':'Synthetic precision','updatedAt':'2020-01-02T00:00:00.000Z'},
          {'owner':'admin','cardKey':'admin.png','amount':'987','currency':'EUR','note':'','updatedAt':'2020-01-03T00:00:00.000Z'}]
    steps=[{'name':'anonymous','method':'GET'},{'name':'peer','method':'GET','owner':'peer'},{'name':'admin','method':'GET','owner':'admin'}]
    run=await asyncio.to_thread(subprocess.run,['node',str(Path(__file__).with_name('card_custom_source.cjs'))],input=json.dumps({'route':'amounts','amounts':seed,'steps':steps}),text=True,capture_output=True,check=True)
    golden=json.loads(run.stdout)['results']
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver',headers={'origin':'http://testserver'}) as peer,httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver') as anonymous:
        uid=await owner(peer,'AmountReadPeer')
        # A visible held card does not fabricate an amount row.
        assert (await peer.put('/api/cards/holdings',json={'cardKey':'not-an-amount.png','held':True})).status_code==200
        assert (await peer.get('/api/cards/amounts')).json()=={'amounts':[]}
        await apply(peer,'set_amount','0',key='zero.png',currency=None,note='Synthetic zero')
        await apply(peer,'set_amount','0.123456789123456789',key='fraction.png',currency='USD',note='Synthetic precision')
        actual=[]
        for step,target in zip(steps,(anonymous,peer,client),strict=True):
            response=await target.get('/api/cards/amounts')
            assert response.headers['cache-control']=='no-store'
            value=response.json()
            for item in value.get('amounts',[]):
                assert item['updatedAt'].endswith('Z') and len(item['updatedAt'].split('.')[-1])==4
                item.pop('updatedAt')
            actual.append({'name':step['name'],'status':response.status_code,'body':value})
        for result in golden:
            for item in result['body'].get('amounts',[]):
                item.pop('updatedAt')
        assert actual==golden
        async with db.connection() as conn:
            assert (await(await conn.execute('SELECT count(*) AS n FROM cash_ledger_entries WHERE owner_id=%s',(uid,))).fetchone())['n']==0
