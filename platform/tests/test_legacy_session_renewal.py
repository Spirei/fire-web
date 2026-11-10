"""Legacy active-session checks renew only the current browser authority."""
from datetime import timedelta

import pytest

from alcor_api.legacy_identity import WEB_COOKIE
from alcor_api.security import digest
from test_legacy_identity import prepare


async def login(client, db, settings):
    await prepare(db, settings)
    result = await client.post('/api/auth/login', json={'username':'sourceadmin','password':'SyntheticSource9'})
    result = await client.post('/api/auth/login/totp', json={'ticket':result.json()['ticket'],'code':'ABCD-1234-5678-90EF'})
    assert result.status_code == 200
    return digest(client.cookies[WEB_COOKIE])


async def test_get_is_pure_post_renews_once_and_rejects_foreign_origin(client, db, settings):
    token = await login(client, db, settings)
    async with db.connection() as conn:
        old = (await (await conn.execute("UPDATE sessions SET expires_at=clock_timestamp()+interval '2 days' WHERE token_hash=%s RETURNING expires_at",(token,))).fetchone())['expires_at']
    response = await client.get('/api/auth/me')
    assert response.status_code == 200 and 'no-store' in response.headers['cache-control']
    assert 'set-cookie' not in response.headers
    async with db.connection() as conn:
        assert (await (await conn.execute('SELECT expires_at FROM sessions WHERE token_hash=%s',(token,))).fetchone())['expires_at'] == old
    assert (await client.post('/api/auth/me',headers={'Origin':'https://foreign.invalid'})).status_code == 403
    response = await client.post('/api/auth/me')
    assert response.status_code == 200 and 'set-cookie' in response.headers
    async with db.connection() as conn:
        expires = (await (await conn.execute('SELECT expires_at FROM sessions WHERE token_hash=%s',(token,))).fetchone())['expires_at']
    assert expires > old + timedelta(days=4)
    assert 'set-cookie' not in (await client.post('/api/auth/me')).headers


@pytest.mark.parametrize('change',['disable','revoke'])
async def test_identity_change_between_check_and_renewal_cannot_extend_session(client, db, settings, monkeypatch, change):
    import alcor_api.legacy_identity as module
    token = await login(client, db, settings)
    async with db.connection() as conn:
        await conn.execute("UPDATE sessions SET expires_at=clock_timestamp()+interval '2 days' WHERE token_hash=%s",(token,))
    original=module.web_identity
    async def raced(*args,**kwargs):
        result=await original(*args,**kwargs)
        async with db.connection() as conn:
            if change=='disable':await conn.execute('UPDATE users SET active=false WHERE id=%s',(result[0].id,))
            else:await conn.execute('DELETE FROM sessions WHERE token_hash=%s',(token,))
        return result
    monkeypatch.setattr(module,'web_identity',raced)
    response=await client.post('/api/auth/me')
    assert response.status_code == 401
    assert 'set-cookie' not in response.headers


async def test_post_keeps_old_origin_login_and_bearer_rules(client, db, settings):
    foreign = await client.post("/api/auth/me", headers={"Origin": "https://foreign.invalid"})
    assert foreign.status_code == 403 and foreign.json() == {"error": "请求来源不受信任"}
    assert "set-cookie" not in foreign.headers
    missing = await client.post("/api/auth/me", headers={"origin": ""})
    assert missing.status_code == 401 and missing.json() == {"error": "未登录"}
    cross = await client.post("/api/auth/me", headers={"origin": "", "sec-fetch-site": "cross-site"})
    assert cross.status_code == 403 and cross.json() == {"error": "请求来源不受信任"}

    token = await login(client, db, settings)
    raw = client.cookies[WEB_COOKIE]
    assert (await client.get("/api/auth/me", headers={"Authorization": "Bearer " + raw})).status_code == 403
    async with db.connection() as conn:
        old = (await (await conn.execute(
            "UPDATE sessions SET expires_at=clock_timestamp()+interval '2 days' WHERE token_hash=%s RETURNING expires_at",
            (token,),
        )).fetchone())["expires_at"]
    fat = "fat_" + "a" * 43
    denied = await client.post("/api/auth/me", headers={"Authorization": "Bearer " + fat})
    assert denied.status_code == 401 and denied.json() == {"error": "未登录"}
    assert "set-cookie" not in denied.headers
    carried = await client.post("/api/auth/me", headers={"Authorization": "Bearer " + raw})
    current = await client.get("/api/auth/me")
    assert carried.status_code == 200 and carried.json()["user"] == current.json()["user"]
    assert "set-cookie" not in carried.headers
    async with db.connection() as conn:
        assert (await (await conn.execute(
            "SELECT expires_at FROM sessions WHERE token_hash=%s", (token,),
        )).fetchone())["expires_at"] == old

    response = await client.post("/api/auth/me", headers={"origin": ""})
    assert response.status_code == 200 and "no-store" in response.headers["cache-control"]
    cookies = response.headers.get_list("set-cookie")
    assert any(item.startswith("fire_session=") for item in cookies)
    assert any(item.startswith("stocklog_session=") and "max-age=0" in item.lower() for item in cookies)


async def test_concurrent_renewals_have_one_cookie_extension(client, db, settings):
    import asyncio
    token=await login(client,db,settings)
    async with db.connection() as conn:
        await conn.execute("UPDATE sessions SET expires_at=clock_timestamp()+interval '2 days' WHERE token_hash=%s",(token,))
    responses=await asyncio.wait_for(asyncio.gather(client.post('/api/auth/me'),client.post('/api/auth/me')),timeout=10)
    assert [r.status_code for r in responses]==[200,200]
    assert sum('set-cookie' in r.headers for r in responses)==1


async def test_fresh_session_navigation_does_not_compete_with_migration_read_authority(client,db,settings):
    import asyncio
    token=await login(client,db,settings)
    async with db.connection() as conn,conn.transaction():
        await conn.execute('SELECT u.id FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=%s FOR SHARE OF u,s',(token,))
        response=await asyncio.wait_for(client.post('/api/auth/me'),1)
        assert response.status_code==200,response.text
        assert 'set-cookie' not in response.headers
