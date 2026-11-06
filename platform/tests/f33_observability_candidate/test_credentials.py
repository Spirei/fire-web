"""Legacy credentials select their original realm and cannot borrow cookie authority."""
import httpx
from activity_read_candidate.test_legacy_activity_cookie import legacy_client


async def test_bearer_only_original_reads_and_supplied_bad_credentials(app, db, settings):
    old, token = await legacy_client(app,db,settings,role='admin',name='F33Bearer',cookie='fire_session')
    async with old, httpx.AsyncClient(transport=httpx.ASGITransport(app=app,raise_app_exceptions=False),base_url='http://testserver',headers={'authorization':'Bearer '+token,'accept':'application/json'}) as bearer:
        saved=await bearer.post('/api/api-docs',json={'content':'Synthetic F33 reference'})
        assert saved.status_code==200,saved.text
        for path in ['/api/activities','/api/api-docs','/api/request-logs']:
            response=await bearer.get(path)
            assert response.status_code==200,(path,response.text)
            for headers in [[('authorization','Bearer nope')],[('authorization','')],[('authorization','Bearer '+token),('authorization','Bearer '+token)]]:
                rejected=await old.post(path,json={'content':'Must not save'},headers=headers) if path=='/api/api-docs' else await old.get(path,headers=headers)
                assert rejected.status_code==401,(path,rejected.text)
        activity=(await bearer.get('/api/activities')).json()
        assert any(row['detail']=='F33Bearer-only' for row in activity['userLogs'])
