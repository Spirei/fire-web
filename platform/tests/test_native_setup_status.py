"""Public native setup status shares the permanent platform bootstrap claim."""


async def test_native_setup_status_never_reopens_claim_or_writes(client, db):
    async def snapshot():
        async with db.connection() as conn:
            return await (await conn.execute("SELECT (SELECT count(*) FROM users) users,(SELECT count(*) FROM sessions) sessions,(SELECT count(*) FROM audit_events) audits,bootstrap_completed FROM registration_state WHERE singleton")).fetchone()
    before=await snapshot()
    response=await client.get('/api/v1/auth/setup-status')
    assert response.status_code==200
    assert response.json()=={'code':0,'message':'ok','data':{'needsSetup':True}}
    assert 'no-store' in response.headers['cache-control']
    assert response.headers['x-alcor-api-version']=='1'
    assert await snapshot()==before
    registered=await client.post('/api/session/register',json={'username':'NativeSetupOwner','password':'SyntheticNativeSetup65!'})
    assert registered.status_code==201 and registered.json()['user']['role']=='admin'
    before=await snapshot()
    assert (await client.get('/api/v1/auth/setup-status')).json()['data']=={'needsSetup':False}
    assert await snapshot()==before
    async with db.connection() as conn,conn.transaction():
        await conn.execute('DELETE FROM sessions')
        await conn.execute('DELETE FROM audit_events')
        await conn.execute('DELETE FROM users')
    before=await snapshot()
    assert (await client.get('/api/v1/auth/setup-status')).json()['data']=={'needsSetup':False}
    assert await snapshot()==before
