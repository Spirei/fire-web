"""Aggregate source projection keeps metadata authority separate from private card backs."""
from uuid import uuid4

from test_card_catalog import SOURCE, imported
from test_card_wallet import KEY, ROOT, apply


async def test_aggregate_registered_source_exact_preferences_unknown_amount_and_masked_back(client,admin,db):
    missing=await client.get('/api/cards')
    assert missing.status_code==200 and missing.json()['sourceState']=='unavailable'
    result,_=await imported(client)
    assert result.status_code==200,result.text
    for kind,value in (('tags',['Synthetic']),('holdings',True)):
        revision=(await client.get('/api/account/card-preferences')).json()['revision']
        saved=await client.put('/api/account/card-preferences',json={'requestId':str(uuid4()),'expectedRevision':revision,'kind':kind,'cardKey':KEY,'value':value})
        assert saved.status_code==200,saved.text
    saved=await client.patch(ROOT+'/details',json={'requestId':str(uuid4()),'expectedRevision':0,'cardKey':KEY,'changes':{'number':'4111111111111111','cvv':'987','expiry':'12/2099'}})
    assert saved.status_code==200,saved.text
    read=await client.get('/api/cards')
    assert read.status_code==200,read.text
    data=read.json()
    import json
    assert data['regions']==json.loads(SOURCE)['regions']
    assert data['sourceState']=='available' and data['amounts']==[]
    assert data['tags'][KEY]==['Synthetic'] and data['holdings']==[KEY]
    assert data['collectionOnRead'] is False and data['secretFields']=='masked'
    def assert_masked(value):
        if isinstance(value, dict):
            for item in value.values():
                assert_masked(item)
        elif isinstance(value, list):
            for item in value:
                assert_masked(item)
        elif isinstance(value, str):
            assert value not in {'4111111111111111', '12/2099', '987'}
    assert_masked(data)
    assert '4111111111111111' not in read.text and '12/2099' not in read.text
    await apply(client,'set_amount','0',currency=None)
    actual=(await client.get('/api/cards')).json()['amounts'][0]
    assert actual['amount']==0 and actual['amountKnown'] is True and actual['currency'] is None
    async with db.connection() as conn:
        assert (await(await conn.execute('SELECT count(*) AS n FROM cash_ledger_entries WHERE owner_id=%s',(admin,))).fetchone())['n']==0
