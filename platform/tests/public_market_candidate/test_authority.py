"""Public licenses never inherit personal grants or collect during anonymous reads."""
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from alcor_api.market_contract import Query
from alcor_api.public_market_authority import PublicAuthority, PublicPolicy
from alcor_api.security import Identity, digest
from fastapi import HTTPException
from psycopg import errors


async def setup(db, client, admin):
    token = client.cookies.get('alcor_session')
    async with db.connection() as conn:
        row = await (await conn.execute('SELECT u.username,u.role,s.expires_at FROM users u JOIN sessions s ON s.user_id=u.id WHERE u.id=%s AND s.token_hash=%s',(admin,digest(token)))).fetchone()
    who = Identity(id=admin,token_hash=digest(token),csrf=client.headers['x-csrf-token'],**row)
    now = datetime.now(UTC)
    policy = PublicPolicy('public-synthetic','fixture','fixture-v1','synthetic-target','a'*64,'license-1','b'*64,str(db.settings.instance_id),(now-timedelta(days=1)).isoformat(),(now+timedelta(days=1)).isoformat(),(('US','AAPL','equity','REGULAR'),),('collect','display'),True)
    return who, policy


async def test_public_install_uuid_current_whitelist_and_revoke(db, client, admin):
    who, policy = await setup(db,client,admin)
    authority = PublicAuthority(db,(policy,))
    rid = str(uuid4())
    saved = await authority.install(who,rid,policy.id,'Synthetic9Pass')
    assert await authority.install(who,rid,policy.id,'') == saved
    with pytest.raises(HTTPException) as conflict:
        await authority.enqueue(who,rid,saved['licenseId'],Query('latest','US','AAPL'),'Synthetic9Pass')
    assert conflict.value.status_code == 409
    async with db.connection() as conn, conn.transaction():
        _, active = await authority.current(conn,saved['licenseId'],'display',Query('latest','US','AAPL'))
        assert active.fingerprint == policy.fingerprint
        with pytest.raises(HTTPException) as outside:
            await authority.current(conn,saved['licenseId'],'display',Query('latest','US','MSFT'))
        assert outside.value.status_code == 403
        with pytest.raises(HTTPException) as bars:
            await authority.current(conn,saved['licenseId'],'collect',Query('bars','US','AAPL',frame='day',start='2026-01-01',through='2026-01-02'))
        assert bars.value.status_code == 403
        assert not await (await conn.execute('SELECT 1 FROM public_market_tasks')).fetchone()
    task = await authority.enqueue(who,str(uuid4()),saved['licenseId'],Query('latest','US','AAPL'),'Synthetic9Pass')
    assert task['state'] == 'queued'
    await authority.revoke(who,str(uuid4()),saved['licenseId'],'Synthetic9Pass')
    async with db.connection() as conn, conn.transaction():
        with pytest.raises(HTTPException) as revoked:
            await authority.current(conn,saved['licenseId'],'display')
        assert revoked.value.status_code == 403
    assert await authority.receipt(who,rid) == saved


async def test_public_policy_change_expiry_instance_restore_and_current_admin(db, client, admin):
    who, policy = await setup(db,client,admin)
    installed = [policy]
    authority = PublicAuthority(db,policy_provider=lambda:installed)
    saved = await authority.install(who,str(uuid4()),policy.id,'Synthetic9Pass')
    installed[:] = [replace(policy,target_fingerprint='c'*64)]
    async with db.connection() as conn, conn.transaction():
        with pytest.raises(HTTPException): await authority.current(conn,saved['licenseId'],'display')
    installed[:] = [policy]
    async with db.connection() as conn:
        await conn.execute("INSERT INTO restore_quarantine(category,payload) VALUES('external_delivery_disabled','{\"disabled\":true}')")
    async with db.connection() as conn, conn.transaction():
        with pytest.raises(HTTPException): await authority.current(conn,saved['licenseId'],'collect')
        await authority.current(conn,saved['licenseId'],'display')
    installed[:] = [replace(policy,instance_id=str(uuid4()))]
    async with db.connection() as conn, conn.transaction():
        with pytest.raises(HTTPException): await authority.current(conn,saved['licenseId'],'display')
    installed[:] = [replace(policy,valid_until=(datetime.now(UTC)-timedelta(seconds=1)).isoformat())]
    async with db.connection() as conn, conn.transaction():
        with pytest.raises(HTTPException): await authority.current(conn,saved['licenseId'],'display')
    async with db.connection() as conn:
        await conn.execute("UPDATE users SET role='user' WHERE id=%s",(admin,))
    with pytest.raises(HTTPException): await authority.receipt(who,saved['requestId'])


async def test_public_sql_original_hash_and_task_immutability(db, client, admin):
    who, policy = await setup(db,client,admin)
    authority = PublicAuthority(db,(policy,))
    saved = await authority.install(who,str(uuid4()),policy.id,'Synthetic9Pass')
    queued = await authority.enqueue(who,str(uuid4()),saved['licenseId'],Query('latest','US','AAPL'),'Synthetic9Pass')
    async with db.connection() as conn:
        with pytest.raises(errors.RaiseException):
            async with conn.transaction():
                await conn.execute("UPDATE public_market_tasks SET query='{}' WHERE id=%s",(queued['taskId'],))
        with pytest.raises(errors.CheckViolation):
            async with conn.transaction():
                await conn.execute("INSERT INTO public_market_pages(id,task_id,raw_bytes,raw_sha256,representation,complete) VALUES(%s,%s,%s,%s,'raw',true)",(uuid4(),queued['taskId'],b'original','0'*64))
        assert not await (await conn.execute('SELECT 1 FROM public_market_facts')).fetchone()
