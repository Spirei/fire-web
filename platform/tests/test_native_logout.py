"""Old v1 logout shares native revocation and never logs out another client."""
from uuid import uuid4

import pytest

from alcor_api.legacy_identity import WEB_COOKIE
from alcor_api.native_app_auth import issue_grant
from alcor_api.security import digest


async def credentials(db,app,owner):
    async with db.connection() as conn,conn.transaction():
        user=await(await conn.execute('SELECT * FROM users WHERE id=%s',(owner,))).fetchone()
        legacy,_=await app.state.legacy_create_session(conn,user,str(uuid4()),v1=True)
        web,_=await app.state.legacy_create_session(conn,user,str(uuid4()))
        first=await issue_grant(conn,user,'portfolio.read','Synthetic logout A')
        other=await issue_grant(conn,user,'portfolio.read','Synthetic logout B')
    return legacy,web,first,other


@pytest.mark.parametrize('kind',['legacy','access_token','refresh_token'])
async def test_v1_logout_revokes_presented_family_once_and_preserves_other_clients(client,admin,db,app,kind):
    legacy,web,pair,other=await credentials(db,app,admin)
    client.cookies.set(WEB_COOKIE,web)
    token=legacy if kind=='legacy' else pair[kind]
    response=await client.post('/api/v1/auth/logout',headers={'authorization':'Bearer '+token})
    assert response.status_code==200 and response.json()=={'code':0,'message':'ok','data':{'loggedOut':True}}
    assert 'no-store' in response.headers['cache-control']
    assert (await client.post('/api/v1/auth/logout',headers={'authorization':'Bearer '+token})).status_code==200
    async with db.connection() as conn:
        assert await(await conn.execute('SELECT 1 FROM sessions WHERE token_hash=%s',(digest(web),))).fetchone()
        assert bool(await(await conn.execute('SELECT 1 FROM sessions WHERE token_hash=%s',(digest(legacy),))).fetchone())==(kind!='legacy')
        grants={r['id']:r['revoked_at'] for r in await(await conn.execute('SELECT id,revoked_at FROM identity_app_grants')).fetchall()}
        assert (grants[pair['grant_id']] is not None)==(kind!='legacy')
        assert grants[other['grant_id']] is None
        action='session.revoked' if kind=='legacy' else 'identity.app.revoked'
        assert (await(await conn.execute('SELECT count(*) n FROM audit_events WHERE action=%s',(action,))).fetchone())['n']==1
    assert (await client.get('/api/account')).status_code==200


async def test_cookie_logout_requires_origin_unknown_bearer_never_falls_back(client,admin,db,app):
    legacy,web,_,_=await credentials(db,app,admin)
    client.cookies.set(WEB_COOKIE,web)
    assert (await client.post('/api/v1/auth/logout',headers={'origin':'https://foreign.invalid'})).status_code==403
    assert (await client.post('/api/v1/auth/logout',headers={'authorization':'Bearer unknown-presented-token'})).status_code==200
    async with db.connection() as conn:
        assert (await(await conn.execute("SELECT count(*) n FROM sessions WHERE client_id IN ('legacy-v1','legacy-web')")).fetchone())['n']==2
    client.cookies.set(WEB_COOKIE,web)
    assert (await client.post('/api/v1/auth/logout')).json()['data']['loggedOut']
    async with db.connection() as conn:
        assert not await(await conn.execute('SELECT 1 FROM sessions WHERE token_hash=%s',(digest(web),))).fetchone()
        assert await(await conn.execute('SELECT 1 FROM sessions WHERE token_hash=%s',(digest(legacy),))).fetchone()
    assert (await client.get('/api/account')).status_code==200


@pytest.mark.parametrize('path',['/api/v1/auth/logout','/api/client/revoke'])
async def test_revocation_and_audit_rollback_together(client,admin,db,app,path):
    _,_,pair,_=await credentials(db,app,admin)
    async with db.connection() as conn:
        await conn.execute("CREATE FUNCTION synthetic_logout_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic audit failure'; END $$")
        await conn.execute("CREATE TRIGGER synthetic_logout_failure BEFORE INSERT ON audit_events FOR EACH ROW WHEN (NEW.action='identity.app.revoked') EXECUTE FUNCTION synthetic_logout_failure()")
    args={'headers':{'authorization':'Bearer '+pair['access_token']}} if path.endswith('logout') else {'json':{'client_id':'fire-ios','token':pair['access_token']}}
    response=await client.post(path,**args)
    assert response.status_code==503
    async with db.connection() as conn:
        assert (await(await conn.execute('SELECT revoked_at FROM identity_app_grants WHERE id=%s',(pair['grant_id'],))).fetchone())['revoked_at'] is None
        assert not await(await conn.execute("SELECT 1 FROM audit_events WHERE action='identity.app.revoked'")).fetchone()


@pytest.mark.parametrize('locked',['owner','grant','session'])
async def test_busy_revocation_returns_known_failure_without_waiting_or_partial_revoke(client,admin,db,app,locked):
    import asyncio
    legacy,_,pair,_=await credentials(db,app,admin)
    token=legacy if locked=='session' else pair['access_token']
    async with db.connection() as held,held.transaction():
        if locked=='owner':await held.execute('SELECT id FROM users WHERE id=%s FOR UPDATE',(admin,))
        elif locked=='grant':await held.execute('SELECT id FROM identity_app_grants WHERE id=%s FOR UPDATE',(pair['grant_id'],))
        else:await held.execute('SELECT token_hash FROM sessions WHERE token_hash=%s FOR UPDATE',(digest(legacy),))
        result=await asyncio.wait_for(client.post('/api/v1/auth/logout',headers={'authorization':'Bearer '+token}),timeout=2)
        assert result.status_code==503
        assert 'set-cookie' not in result.headers
    assert (await client.post('/api/v1/auth/logout',headers={'authorization':'Bearer '+token})).status_code==200


async def test_legacy_session_audit_failure_preserves_original_session(client,admin,db,app):
    legacy,_,_,_=await credentials(db,app,admin)
    async with db.connection() as conn:
        await conn.execute("CREATE FUNCTION synthetic_session_logout_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic session audit failure'; END $$")
        await conn.execute("CREATE TRIGGER synthetic_session_logout_failure BEFORE INSERT ON audit_events FOR EACH ROW WHEN (NEW.action='session.revoked') EXECUTE FUNCTION synthetic_session_logout_failure()")
    response=await client.post('/api/v1/auth/logout',headers={'authorization':'Bearer '+legacy})
    assert response.status_code==503
    async with db.connection() as conn:
        assert await(await conn.execute('SELECT 1 FROM sessions WHERE token_hash=%s',(digest(legacy),))).fetchone()


async def test_explicit_migrated_legacy_bearer_remains_revocable_without_platform_session_access(client,admin,db,app):
    legacy,web,_,_=await credentials(db,app,admin)
    response=await client.post('/api/v1/auth/logout',headers={'authorization':'Bearer '+web})
    assert response.status_code==200
    async with db.connection() as conn:
        assert not await(await conn.execute('SELECT 1 FROM sessions WHERE token_hash=%s',(digest(web),))).fetchone()
        assert await(await conn.execute('SELECT 1 FROM sessions WHERE token_hash=%s',(digest(legacy),))).fetchone()
    assert (await client.get('/api/account')).status_code==200
