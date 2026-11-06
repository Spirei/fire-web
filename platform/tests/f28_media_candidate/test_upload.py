"""General upload uses real private bytes and the existing profile authority."""
import asyncio
import io
from uuid import uuid4

import httpx
import pytest_asyncio
from PIL import Image
from test_card_wallet import owner
from test_legacy_devices import bearer, grant


@pytest_asyncio.fixture(autouse=True)
async def files(settings,tmp_path):
    settings.file_root=tmp_path/'private-uploads'


def gif(color='red'):
    out=io.BytesIO()
    Image.new('RGB',(2,2),color).save(out,format='GIF',save_all=True,append_images=[Image.new('RGB',(2,2),'blue')],duration=100,loop=0)
    return out.getvalue()


async def upload(client,rid=None,raw=None,path='/api/upload',**extra):
    data={'kind':'avatar',**extra}
    if rid:data['requestId']=rid
    return await client.post(path,data=data,files={'file':('synthetic.gif',raw or gif(),'image/gif')})


async def test_original_uuid_concurrent_avatar_upload_immutable_history_cas_and_owner(client,app,db,settings):
    uid=await owner(client)
    rid=str(uuid4())
    results=await asyncio.gather(*(upload(client,rid) for _ in range(3)))
    assert all(r.status_code in (200,429) for r in results),[r.text for r in results]
    completed=[r for r in results if r.status_code==200]
    assert completed
    first=completed[0].json()
    assert all(r.json()==first for r in completed) and set(first)=={'url'}
    assert all(r.json()=={'error':'服务器正在接收文件，请稍后再试'} for r in results if r.status_code==429)
    assert completed[0].headers['x-alcor-legacy-client-idempotency']=='true'
    second=await upload(client,raw=gif('green'))
    assert second.status_code==200 and second.headers['x-alcor-legacy-client-idempotency']=='false'
    assert (await client.get(first['url'])).content==gif()
    assert (await client.get(second.json()['url'])).content==gif('green')
    assert (await upload(client,rid)).json()==first
    assert (await upload(client,rid,raw=gif('white'))).status_code==409
    stale=await upload(client,str(uuid4()),expectedRevision=first['url'].split('revision=')[1])
    assert stale.status_code==409
    wrong=await client.get('/api/auth/avatar',params={'revision':str(uuid4())})
    assert wrong.status_code==404
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver',headers={'origin':'http://testserver'}) as peer:
        await owner(peer,'ForeignUpload')
        assert (await peer.get(first['url'])).status_code==404
    async with db.connection() as conn:
        rows=await(await conn.execute('SELECT * FROM profile_media_objects WHERE owner_id=%s',(uid,))).fetchall()
        assert len(rows)==2
        stored=await(await conn.execute('SELECT result FROM profile_operation_receipts WHERE owner_id=%s AND request_id=%s',(uid,rid))).fetchone()
    path=settings.file_root/'profile-media'/stored['result']['avatarUpload']['objectId']
    raw=path.read_bytes();path.write_bytes(b'x'*len(raw))
    assert (await client.get(first['url'])).status_code==503
    path.write_bytes(raw)
    async with db.connection() as conn:
        await conn.execute("UPDATE profile_operation_receipts SET state='failed' WHERE owner_id=%s AND request_id=%s",(uid,rid))
    assert (await client.get(first['url'])).status_code==404
    assert (await upload(client,rid)).status_code==409


async def test_avatar_clear_retirement_survives_reupload_and_bad_headers_cannot_downgrade(client,db):
    uid=await owner(client)
    a=await upload(client,str(uuid4()))
    b=await upload(client,str(uuid4()),raw=gif('green'))
    assert a.status_code==b.status_code==200
    current=(await client.get('/api/profile')).json()
    cleared=await client.patch('/api/profile',json={'display_name':'Synthetic','revision':current['revision'],'avatar_data':None})
    assert cleared.status_code==200,cleared.text
    assert (await client.get(a.json()['url'])).status_code==404
    fresh=await upload(client,str(uuid4()),raw=gif('white'))
    assert fresh.status_code==200 and (await client.get(fresh.json()['url'])).content==gif('white')
    assert (await client.get(a.json()['url'])).status_code==404
    for headers in ({'authorization':''},{'authorization':'Bearer '},[('authorization','Bearer token'),('authorization','Bearer second')]):
        rejected=await client.post('/api/upload',headers=headers,files={'file':('synthetic.gif',gif(),'image/gif')})
        assert rejected.status_code==401,rejected.text
    async with db.connection() as conn:
        assert (await(await conn.execute("SELECT count(*) AS n FROM audit_events WHERE target_id=%s AND action='profile.avatar.history_retired'",(uid,))).fetchone())['n']==1


async def test_two_native_versions_exact_upload_envelopes_and_scopes(client,db):
    uid=await owner(client)
    read=await grant(db,uid,'portfolio.read')
    write=await grant(db,uid,'portfolio.read profile.write')
    for version in (1,2):
        rid=str(uuid4())
        response=await client.post(f'/api/v{version}/upload',headers=bearer(write),data={'requestId':rid,'kind':'avatar'},files={'file':('synthetic.gif',gif(),'image/gif')})
        assert response.status_code==200 and response.json()['code']==0,response.text
        value=response.json()['data']
        assert value['kind']=='avatar' and value['url'].startswith(f'/api/v{version}/auth/avatar?')
        image=await client.get(value['url'],headers=bearer(write))
        assert image.status_code==200 and image.content==gif()
        if version==2:
            denied=await client.post('/api/v2/upload',headers=bearer(read),files={'file':('synthetic.gif',gif(),'image/gif')})
            assert denied.status_code==403
        rejected=await client.post(f'/api/v{version}/upload',headers=bearer(write),data={'kind':'asset'},files={'file':('synthetic.gif',gif(),'image/gif')})
        assert rejected.status_code==403
