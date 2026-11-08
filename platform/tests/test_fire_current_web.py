"""Current Fire browser contracts on isolated PG, no real accounts or providers."""
import asyncio
import hashlib
import io
from datetime import datetime, timedelta
from uuid import uuid4

import pytest
from PIL import Image
from psycopg.types.json import Jsonb

from alcor_api.cli import create_user
from alcor_api.request_activity import ZONE
from test_fire_web import fire_login


async def test_personal_profile_atomic_cas_owner_background(client, admin, app, settings, tmp_path):
    await fire_login(client)
    settings.file_root = tmp_path / "private"
    settings.file_root.mkdir(mode=0o700)
    r = await client.get('/api/auth/personal-home')
    assert r.status_code == 200, r.text
    assert r.json()['profile']['revision'] == 0
    payload = dict(requestId=str(uuid4()), revision=0, nickname='中文昵称', bio='Hello', gender='female')
    r = await client.patch('/api/auth/personal-home', json=payload)
    assert r.status_code == 200, r.text
    assert r.json()['user']['nickname'] == '中文昵称'
    assert r.json()['profile']['bio'] == 'Hello'
    assert (await client.patch('/api/auth/personal-home', json=payload)).status_code == 409
    assert (await client.patch('/api/auth/personal-home', json={**payload, 'requestId': str(uuid4()), 'nickname':'stale'})).status_code == 409
    assert (await client.patch('/api/auth/personal-home', json={**payload,'revision':1,'requestId':str(uuid4()),'role':'admin'})).status_code == 400
    image=Image.new('RGB',(12,12),'red'); output=io.BytesIO(); image.save(output,'PNG')
    r = await client.post('/api/auth/personal-home', data={'requestId':str(uuid4()),'revision':'1'}, files={'file':('background.png',output.getvalue(),'image/png')})
    assert r.status_code == 200, r.text
    sha=r.json()['profile']['background']['sha256']
    raw=await client.get('/api/auth/personal-home?kind=background&v='+sha)
    assert raw.status_code == 200, raw.text
    assert hashlib.sha256(raw.content).hexdigest() == sha
    assert raw.headers['cache-control']=='private, no-store'
    assert (await client.post('/api/auth/personal-home',data={'requestId':str(uuid4()),'revision':'2'},files={'file':('bad.png',b'bad','image/png')})).status_code == 400
    assert (await client.get('/api/auth/personal-home')).json()['profile']['revision']==2
    await create_user(settings,'OtherProfile','Synthetic9Pass',role='user')
    await fire_login(client,'OtherProfile')
    assert (await client.get('/api/auth/personal-home?kind=background&v='+sha)).status_code==404
    assert (await client.get('/api/auth/personal-home')).json()['profile']['revision']==0


async def test_avatar_and_large_background_work_on_shared_nas_mount(client, admin, settings, tmp_path):
    import os
    await fire_login(client)
    settings.file_root = tmp_path / "shared-mount"
    settings.file_root.mkdir(mode=0o777)
    settings.file_root.chmod(0o777)
    image = Image.new("RGB", (4000, 3000), "blue")
    data = io.BytesIO(); image.save(data, "JPEG")
    response = await client.post('/api/upload', data={'kind':'avatar', 'requestId':str(uuid4())}, files={'file':('avatar.jpg',data.getvalue(),'image/jpeg')})
    assert response.status_code == 200, response.text
    assert (await client.get(response.json()['url'])).status_code == 200
    assert settings.file_root.stat().st_mode & 0o777 == 0o777
    child = settings.file_root / 'profile-media'
    assert child.stat().st_mode & 0o777 == 0o700
    assert child.stat().st_uid == os.getuid()
    profile = (await client.get('/api/auth/personal-home')).json()['profile']
    result = await client.post('/api/auth/personal-home', data={'requestId':str(uuid4()),'revision':str(profile['revision'])}, files={'file':('background.jpg',data.getvalue(),'image/jpeg')})
    assert result.status_code == 200, result.text
    background = await client.get('/api/auth/personal-home?kind=background&v='+result.json()['profile']['background']['sha256'])
    assert background.status_code == 200
    with Image.open(io.BytesIO(background.content)) as reduced:
        assert max(reduced.size) <= 2048
    assert all(path.stat().st_mode & 0o777 == 0o600 for path in child.iterdir())


async def test_search_history_cas_limit_dedup_owner_and_clear(client, admin, settings, app):
    await fire_login(client)
    url='/api/auth/search-history'
    async def get():
        r=await client.get(url); assert r.status_code==200,r.text; return r.json()
    async def record(q, rev=None):
        version=(await get())['revision'] if rev is None else rev
        return await client.post(url,json={'action':'record','query':q,'revision':version})
    assert (await get())['revision']==0
    assert (await record('  ＰＧ   搜索  ')).status_code==200
    assert (await record('pg 搜索')).json()['items'][0]['query']=='pg 搜索'
    assert len((await get())['items'])==1
    for i in range(23): assert (await record('item '+str(i))).status_code==200
    state=await get(); assert len(state['items'])==20 and state['items'][0]['query']=='item 22'
    rev=state['revision']
    both=await asyncio.gather(record('one',rev),record('two',rev))
    assert sorted(r.status_code for r in both)==[200,409]
    state=await get(); rev=state['revision']
    assert (await client.request('DELETE',url,json={'action':'clear','revision':rev})).status_code==200
    stale=await record('delayed',rev); assert stale.status_code==409 and stale.json()['items']==[]
    assert (await client.post(url,json={'action':'record','query':'x'*81,'revision':0})).status_code==400
    assert (await client.request('DELETE',url,json={'action':'clear','revision':0,'userId':'other'})).status_code==400
    assert (await client.post(url,json={'action':'record','query':'ok','revision':True})).status_code==400
    assert (await client.post(url,json={'action':'record','query':'ok','revision':0},headers={'origin':'https://outside.invalid'})).status_code==403
    assert (await client.get(url,headers={'authorization':'Bearer anything'})).status_code==403
    assert (await get())['items']==[]
    await create_user(settings,'HistoryOther','Synthetic9Pass',role='user')
    await fire_login(client,'HistoryOther')
    assert (await record('other')).status_code==200
    await fire_login(client)
    assert (await get())['items']==[]


async def seed_asset(app, aid, kind='broker', market='OTHER'):
    async with app.state.db.connection() as conn:
        owner = (await (await conn.execute("SELECT id FROM users WHERE role='admin' LIMIT 1")).fetchone())["id"]
        sid = uuid4()
        await conn.execute("INSERT INTO asset_catalog_sources(id,actor_id,source_label,sha256,original_text,manifest,result) VALUES(%s,%s,'Synthetic public metadata',%s,'{}','{}','{}')", (sid, owner, 'a'*64))
        await conn.execute("INSERT INTO asset_catalog_entries(id,type,market,code,name,source_id,material_state) VALUES(%s,%s,%s,%s,%s,%s,%s)",(aid,kind,market,aid.split(':')[-1],aid,sid,Jsonb({})))


async def test_catalog_batch_atomic_receipts_classification_order_restore(client, admin, app, settings):
    await fire_login(client)
    for aid in ['broker:AAA','broker:BBB','broker:CCC','broker:DDD']:
        await seed_asset(app,aid)
    await seed_asset(app,'stock:US:TEST','stock','US')
    url='/api/assets/catalog'
    async def listing(kind='broker', **query):
        r=await client.get(url,params={'type':kind,**query}); assert r.status_code==200,r.text; return r.json()
    async def mutate(action, ids, **extra):
        state=await listing(); return await client.post(url,json={'action':action,'ids':ids,'revision':state['revision'],'requestId':str(uuid4()),**extra})
    assert (await listing())['pageSize']==10
    assert (await mutate('order',['broker:AAA','broker:BBB','broker:CCC','broker:DDD'])).status_code==200
    assert (await mutate('order',['broker:BBB','broker:AAA'])).status_code==200
    assert [r['id'] for r in (await listing())['assets']]==['broker:BBB','broker:AAA','broker:CCC','broker:DDD']
    r=await mutate('classify',['broker:AAA'],markets=['JP','US']); assert r.status_code==200,r.text
    assert [r['id'] for r in (await listing(market='JP'))['assets']]==['broker:AAA']
    assert (await mutate('classify',['stock:US:TEST'],markets=['US'])).status_code==400
    assert (await mutate('classify',['broker:AAA'],markets=['FAKE'])).status_code==400
    r=await mutate('rename',['broker:AAA'], name='New broker', markets=['AU','JP']); assert r.status_code==200,r.text
    renamed=(await listing(market='AU'))['assets']; assert renamed[0]['name']=='New broker'
    assert not any(k in renamed[0] for k in ['price','changePct','marketCap','quote'])
    state=await listing()
    r=await mutate('remove',['broker:AAA','missing']); assert r.status_code==409,r.text
    assert (await listing())['revision']==state['revision']
    raw={'action':'remove','ids':['broker:AAA'],'revision':state['revision'],'requestId':str(uuid4())}
    r=await client.post(url,json=raw); assert r.status_code==200,r.text
    assert (await client.post(url,json=raw)).json()==r.json()
    assert (await client.post(url,json={**raw,'ids':['broker:BBB']})).status_code==409
    assert (await listing())['removedCount']==1
    assert [r['id'] for r in (await listing(removed='1'))['assets']]==['broker:AAA']
    assert (await mutate('restore',['broker:AAA'])).status_code==200
    assert (await listing())['removedCount']==0
    async with app.state.db.connection() as conn:
        assert (await (await conn.execute('SELECT count(*) AS n FROM asset_catalog_entries')).fetchone())['n']==5
    await create_user(settings,'CatalogMember','Synthetic9Pass',role='user');await fire_login(client,'CatalogMember')
    assert (await client.get(url)).status_code==403
    assert (await client.post(url,json=raw)).status_code==403


async def test_catalog_stock_counts_are_registered_images_independent_of_search(client, admin, app):
    await fire_login(client)
    await seed_asset(app,'stock:US:EMPTY','stock','US')
    r=await client.get('/api/assets/catalog?type=stock&q=nothing')
    assert r.status_code==200,r.text
    assert r.json()['marketCounts']=={} and r.json()['total']==0
    assert (await client.get('/api/assets/catalog?type=group')).status_code==400


async def test_personal_activity_owner_only_same_source_streak_and_no_self_count(client, admin, app, settings):
    await fire_login(client)
    await app.state.request_activity.flush()
    today=datetime.now(ZONE).date()
    async with app.state.db.connection() as conn:
        await conn.execute('DELETE FROM account_request_activity')
        for delta,count in [(0,2),(1,1),(2,1),(5,1)]:
            await conn.execute('INSERT INTO account_request_activity(user_id,day,requests) VALUES(%s,%s,%s)',(admin,today-timedelta(days=delta),count))
    app.state.request_activity.pending.clear()
    r=await client.get('/api/auth/personal-activity');assert r.status_code==200,r.text
    data=r.json();assert (data['total'],data['activeDays'],data['longest'],data['current'])==(5,4,3,3)
    assert sum(data['days'].values())==5
    assert not app.state.request_activity.pending
    await create_user(settings,'ActivityOther','Synthetic9Pass',role='user');await fire_login(client,'ActivityOther')
    assert (await client.get('/api/auth/personal-activity')).json()['total']==0


async def test_passkey_admin_metadata_no_secrets(client, admin, settings, app):
    target=await create_user(settings,'PasskeyOther','Synthetic9Pass',role='user')
    await fire_login(client)
    r=await client.get('/api/users/'+target+'/passkeys');assert r.status_code==200,r.text
    assert r.json()=={'keys':[]}
    assert (await client.get('/api/users/absent/passkeys')).status_code==404
    await fire_login(client,'PasskeyOther')
    assert (await client.get('/api/users/'+target+'/passkeys')).status_code==403
