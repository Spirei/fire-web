"""Direct group-overlay, UUID interpretation and private icon history boundaries."""
import json
from uuid import uuid4

from alcor_api.cli import create_user
from alcor_api.portfolio_records import PortfolioRecords
from test_legacy_portfolio import grant
from test_portfolio_records import create as create_record
from test_watch_group_icons import BASE, SVG, group, upload


async def test_group_overlay_moved_extra_members_have_exact_owned_pagination_and_display_cas(client,admin,db,settings):
    a=await group(client,'Overlay A');b=await group(client,'Overlay B')
    records=PortfolioRecords(db)
    rows=[]
    for index,base in enumerate((a,a,b,'','')):
        rows.append((await create_record(records,admin,code='OVR'+str(index),watchGroupId=base))['recordId'])
    other=await create_user(settings,'OtherOverlayOwner','Synthetic9Pass',role='user')
    foreign=(await create_record(records,other,code='FOREIGN'))['recordId']
    changes=[(['moved',rows[1]],b),(['moved',rows[2]],a),(['groups',a,rows[3]],True),
             (['moved',rows[4]],b),(['groups',a,rows[4]],True),(['groups',a,foreign],True),
             (['pinned',rows[0]],True),(['aliases',rows[0]],'Display alias'),(['notes',rows[0]],'Display note')]
    before={}
    async with db.connection() as conn:
        before['rows']=await(await conn.execute('SELECT id,revision,qty,cost,watch_group_id,note FROM portfolio_records WHERE owner_id=%s ORDER BY id',(admin,))).fetchall()
    payload={'requestId':str(uuid4()),'namespace':'watch','changes':[{'key':json.dumps(key,separators=(',',':')),'revision':0,'value':value} for key,value in changes]+[{'key':'historical-opaque-tombstone','revision':0,'value':None}]}
    saved=await client.post('/api/account/state',json=payload)
    assert saved.status_code==200,saved.text
    first=await client.get('/api/portfolio/records',params={'view':a,'pageSize':2,'page':1})
    assert first.status_code==200,first.text
    value=first.json();assert value['total']==4 and value['membershipBasis']=='watch_display_moved_and_extra_groups'
    params={'view':a,'pageSize':2,'page':2,'collectionRevision':value['collectionRevision'],'displayRevision':value['displayRevision']}
    second=await client.get('/api/portfolio/records',params=params)
    assert second.status_code==200,second.text
    got=[r['id'] for r in value['records']+second.json()['records']]
    assert len(got)==len(set(got))==4 and set(got)=={rows[0],rows[2],rows[3],rows[4]}
    changed=await client.post('/api/account/state',json={'requestId':str(uuid4()),'namespace':'watch','changes':[{'key':json.dumps(['moved',rows[2]],separators=(',',':')),'revision':1,'value':b}]})
    assert changed.status_code==200,changed.text
    assert (await client.get('/api/portfolio/records',params=params)).status_code==409
    current=(await client.get('/api/portfolio/records',params={'view':a})).json()
    assert current['total']==3 and current['collectionRevision']==value['collectionRevision']
    logged=await client.post('/api/session/login',json={'login':'OtherOverlayOwner','password':'Synthetic9Pass'})
    assert logged.status_code==200,logged.text
    client.headers['x-csrf-token']=logged.json()['csrf']
    assert (await client.get('/api/portfolio/records',params={'view':a})).status_code==404
    logged=await client.post('/api/session/login',json={'login':'AdminOne','password':'Synthetic9Pass'})
    client.headers['x-csrf-token']=logged.json()['csrf']
    async with db.connection() as conn:
        assert await(await conn.execute('SELECT id,revision,qty,cost,watch_group_id,note FROM portfolio_records WHERE owner_id=%s ORDER BY id',(admin,))).fetchall()==before['rows']
        assert not await(await conn.execute('SELECT 1 FROM trade_ledger')).fetchone()
        assert not await(await conn.execute('SELECT 1 FROM cash_ledger_entries')).fetchone()


async def test_same_uuid_cannot_exchange_legacy_id_interpretation_and_canonical_direct_id(client,admin,db):
    gid=await group(client,'UUID group');headers=await grant(db,admin)
    revision=(await client.get(BASE)).json()['revision'];rid=str(uuid4())
    data={'id':gid,'name':'Canonical rename'}
    canonical=await client.post(BASE+'/operations',json={'requestId':rid,'expectedRevision':revision,'action':'update','data':data})
    assert canonical.status_code==200,canonical.text
    old=await client.put('/api/v2/watch-groups/'+gid,json={'name':data['name']},headers={**headers,'x-alcor-request-id':rid,'x-alcor-expected-revision':str(revision)})
    assert old.status_code==409,old.text
    assert (await client.get(BASE+'/operations/'+rid)).json()==canonical.json()
    revision=(await client.get(BASE)).json()['revision'];rid2=str(uuid4());name='Legacy rename'
    original=await client.put('/api/v1/watch-groups/'+gid,json={'name':name},headers={**headers,'x-alcor-request-id':rid2,'x-alcor-expected-revision':str(revision)})
    assert original.status_code==200,original.text
    wrong=await client.post(BASE+'/operations',json={'requestId':rid2,'expectedRevision':revision,'action':'update','data':{'id':gid,'name':name}})
    assert wrong.status_code==409,wrong.text
    assert (await client.put('/api/v1/watch-groups/'+gid,json={'name':name},headers={**headers,'x-alcor-request-id':rid2,'x-alcor-expected-revision':str(revision)})).json()==original.json()


async def test_icon_history_keyset_is_group_owner_bound_and_survives_clear_delete(client,admin,db,settings,tmp_path):
    settings.file_root=tmp_path/'private-icons'
    gid=await group(client,'Icon history');other_group=await group(client,'Other icon history')
    one,_=await upload(client,gid,SVG,'first.svg');assert one.status_code==200,one.text
    two,_=await upload(client,gid,SVG.replace(b'M0 0',b'M1 1'),'second.svg');assert two.status_code==200,two.text
    other,_=await upload(client,other_group,SVG,'other.svg');assert other.status_code==200,other.text
    first=await client.get(BASE+'/'+gid+'/icons?limit=1');assert first.status_code==200,first.text
    page=first.json();assert len(page['items'])==1 and page['nextCursor']
    next_page=await client.get(BASE+'/'+gid+'/icons',params={'limit':1,'after':page['nextCursor']})
    assert next_page.status_code==200,next_page.text
    assert {r['version'] for r in page['items']+next_page.json()['items']}=={one.json()['icon']['version'],two.json()['icon']['version']}
    assert next_page.json()['nextCursor'] is None
    invalid=await client.get(BASE+'/'+gid+'/icons',params={'after':other.json()['icon']['version']})
    assert invalid.status_code==409,invalid.text
    user=await create_user(settings,'OtherHistoryOwner','Synthetic9Pass',role='user');foreign=await grant(db,user)
    assert (await client.get(BASE+'/'+gid+'/icons',headers=foreign)).status_code==404
    assert (await client.get(one.json()['icon']['originalPath'],headers=foreign)).status_code==404
    for action,data in [('update',{'id':gid,'icon':''}),('delete',{'id':gid})]:
        revision=(await client.get(BASE)).json()['revision']
        result=await client.post(BASE+'/operations',json={'requestId':str(uuid4()),'expectedRevision':revision,'action':action,'data':data})
        assert result.status_code==200,result.text
    history=await client.get(BASE+'/'+gid+'/icons')
    assert history.status_code==200 and history.json()['groupDeleted'] and history.json()['originalsRetained']
    assert len(history.json()['items'])==2 and not any(row['current'] for row in history.json()['items'])
    assert (await client.get(one.json()['icon']['originalPath'])).content==SVG
    assert (await client.get(two.json()['icon']['originalPath'])).content==SVG.replace(b'M0 0',b'M1 1')


async def test_watch_display_filters_and_pin_manual_order_before_paging_without_changing_all_records(client,admin,db):
    records=PortfolioRecords(db);ids=[]
    for index in range(7):ids.append((await create_record(records,admin,code='PAGE'+str(index)))['recordId'])
    original=(await client.get('/api/portfolio/records')).json()
    assert [r['id'] for r in original['records']]==ids[::-1]
    changes=[(['hidden',ids[6]],True),(['hidden',ids[5]],True),(['pinned',ids[0]],True),
             (['orders','ALL'],[ids[3],ids[1],ids[4],ids[2],ids[0],ids[5],ids[6]])]
    saved=await client.post('/api/account/state',json={'requestId':str(uuid4()),'namespace':'watch','changes':[{'key':json.dumps(key,separators=(',',':')),'revision':0,'value':value} for key,value in changes]})
    assert saved.status_code==200,saved.text
    first=(await client.get('/api/portfolio/records',params={'displayMode':'watch','pageSize':2})).json()
    assert first['total']==5 and first['displayMode']=='watch'
    assert [r['id'] for r in first['records']]==[ids[0],ids[3]]
    params={'displayMode':'watch','pageSize':2,'page':2,'collectionRevision':first['collectionRevision'],'displayRevision':first['displayRevision']}
    second=await client.get('/api/portfolio/records',params=params);assert second.status_code==200,second.text
    assert [r['id'] for r in second.json()['records']]==[ids[1],ids[4]]
    third=await client.get('/api/portfolio/records',params={**params,'page':3})
    assert [r['id'] for r in third.json()['records']]==[ids[2]]
    assert (await client.get('/api/portfolio/records',params={'displayMode':'watch','page':2})).status_code==409
    unchanged=(await client.get('/api/portfolio/records')).json()
    assert unchanged['records']==original['records'] and unchanged['total']==original['total']==7
    changed=await client.post('/api/account/state',json={'requestId':str(uuid4()),'namespace':'watch','changes':[{'key':json.dumps(['pinned',ids[0]],separators=(',',':')),'revision':1,'value':None}]})
    assert changed.status_code==200,changed.text
    assert (await client.get('/api/portfolio/records',params=params)).status_code==409
    current=(await client.get('/api/portfolio/records',params={'displayMode':'watch','pageSize':2})).json()
    assert [r['id'] for r in current['records']]==[ids[3],ids[1]]
    async with db.connection() as conn:
        assert not await(await conn.execute('SELECT 1 FROM trade_ledger')).fetchone()
        assert not await(await conn.execute('SELECT 1 FROM cash_ledger_entries')).fetchone()
