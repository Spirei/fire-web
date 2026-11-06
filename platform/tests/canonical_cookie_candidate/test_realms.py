"""Real HTTP identity routing; stale compatibility cookies never select another owner."""
from uuid import uuid4

import httpx
from alcor_api.cli import create_user
from alcor_api.security import COOKIE, digest
from psycopg.types.json import Jsonb


async def setup(app,db,settings,admin):
    group=await app.state.watch_groups.mutate(admin,'create',{'name':'Platform owner'},uuid4(),0)
    gid=group['group']['id'];other=await create_user(settings,'RealmOther','Synthetic9Pass',role='user')
    await app.state.watch_groups.mutate(other,'create',{'name':'Legacy owner'},uuid4(),0)
    token='synthetic_legacy_'+uuid4().hex
    async with db.connection() as conn,conn.transaction():
        await conn.execute("INSERT INTO sessions(token_hash,user_id,client_id,session_version,expires_at) SELECT %s,id,'legacy-web',session_version,clock_timestamp()+interval '1 day' FROM users WHERE id=%s",(digest(token),other))
    market_id,flat_id=str(uuid4()),str(uuid4())
    async with db.connection() as conn,conn.transaction():
        for owner,marker in ((admin,'platform-only'),(other,'legacy-only')):
            result={'state':'completed','realmMarker':marker}
            await conn.execute('INSERT INTO market_data_operations(owner_id,request_id,fingerprint,result)VALUES(%s,%s,%s,%s)',(owner,market_id,'a'*64,Jsonb(result)))
            await conn.execute('INSERT INTO legacy_flat_order_operations(owner_id,request_id,fingerprint,result)VALUES(%s,%s,%s,%s)',(owner,flat_id,'b'*64,Jsonb(result)))
    return token,[('/api/watch-groups',200),('/api/watch-groups/'+gid+'/icon',200),
        ('/api/portfolio/record-imports/capabilities',200),('/api/request-logs',200),('/api/system/api-docs',200),
        ('/api/activities',200),('/api/market/operations/'+market_id,200),
        ('/api/trading/history/operations/'+flat_id,200),('/api/feed',200),('/api/activities/imported',200),('/api/activities/daily-summary',200),
        ('/api/portfolio/overview',200),('/api/personal-data-transfer/export',200),
        ('/api/portfolio/records/export',200),('/api/trading/history/export',200),
        ('/api/trading/history/import/operations/'+str(uuid4()),404),
        ('/api/trading/orders/observations/operations/'+str(uuid4()),404)]


def cookie(platform,legacy):
    return f'{COOKIE}={platform}; fire_session={legacy}; stocklog_session='


async def test_platform_cookie_wins_stale_and_other_owner_legacy_bare_reads_and_write(client,app,db,settings,admin):
    token,paths=await setup(app,db,settings,admin)
    platform=client.cookies.get(COOKIE)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app,raise_app_exceptions=False),base_url='http://testserver',headers={'origin':'http://testserver'}) as browser:
        for legacy in ('stale-legacy-cookie',token):
            for path,status in paths:
                response=await browser.get(path,headers={'cookie':cookie(platform,legacy)})
                assert response.status_code==status,(path,response.status_code,response.text)
                if path.startswith(('/api/market/operations/','/api/trading/history/operations/')):
                    assert response.json()['realmMarker']=='platform-only'
                if path=='/api/watch-groups':
                    names={row['name'] for row in response.json()['groups']}
                    assert 'Platform owner' in names and 'Legacy owner' not in names
        current=await browser.get('/api/watch-groups',headers={'cookie':cookie(platform,token)})
        current_revision=current.json()['revision']
        response=await browser.post('/api/watch-groups/operations',headers={'cookie':cookie(platform,token),'x-csrf-token':client.headers['x-csrf-token']},json={'requestId':str(uuid4()),'expectedRevision':current_revision,'action':'create','data':{'name':'Explicit platform write'}})
        assert response.status_code==200,response.text
        # Compatibility-only requests retain their separate old owner and protocol.
        old=await browser.get('/api/watch-groups',headers={'cookie':'fire_session='+token})
        assert old.status_code==200 and 'Legacy owner' in {r['name'] for r in old.json()['groups']}
        assert 'Platform owner' not in {r['name'] for r in old.json()['groups']}
        for version in (1,2):
            baseline=await browser.get(f'/api/v{version}/watch-groups',headers={'cookie':'fire_session='+token})
            unchanged=await browser.get(f'/api/v{version}/watch-groups',headers={'cookie':cookie(platform,token)})
            assert unchanged.status_code==baseline.status_code,(baseline.text,unchanged.text)
            if baseline.status_code==200:assert unchanged.json()==baseline.json()


async def test_bad_platform_or_explicit_credentials_never_fall_back(client,app,db,settings,admin):
    token,paths=await setup(app,db,settings,admin)
    platform=client.cookies.get(COOKIE)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app,raise_app_exceptions=False),base_url='http://testserver',headers={'origin':'http://testserver'}) as browser:
        for bad in ('','bad-platform-token'):
            for path,_ in paths:
                response=await browser.get(path,headers={'cookie':cookie(bad,token)})
                assert response.status_code in (401,403),(path,bad,response.status_code,response.text)
        for supplied in ([('authorization','')],[('authorization','Basic invalid')],[('authorization','Bearer ')],[('authorization','Bearer invalid')],[('authorization','Bearer invalid'),('authorization','Bearer another')]):
            for path,_ in paths:
                response=await browser.get(path,headers=[('cookie',cookie(platform,token)),('x-csrf-token',client.headers['x-csrf-token']),*supplied])
                assert response.status_code in (401,403),(path,supplied,response.status_code,response.text)
