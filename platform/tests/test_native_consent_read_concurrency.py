"""Consent reads share current asset authorization; mutation/bootstrap stay serial."""
import asyncio

import pytest

from test_legacy_devices import bearer, grant
from source_pure_read_candidate.test_reads import snapshot


@pytest.mark.parametrize('path',['/api/v2/auth/consent','/api/client/consent'])
async def test_existing_consent_reads_finish_beside_asset_proof_but_post_waits(client,db,admin,path):
    pair=await grant(db,admin,'portfolio.read portfolio.write cash.read')
    headers=bearer(pair)
    first=await client.get(path,headers=headers)
    assert first.status_code==200,first.text
    value=first.json()['data'] if path.startswith('/api/v2') else first.json()
    before=await snapshot(db)
    async with db.connection() as conn,conn.transaction():
        await conn.execute('SELECT id FROM users WHERE id=%s FOR SHARE',(admin,))
        await conn.execute('SELECT id FROM identity_app_grants WHERE id=%s FOR SHARE',(pair['grant_id'],))
        reads=await asyncio.wait_for(asyncio.gather(*(client.get(path,headers=headers) for _ in range(2))),1)
        assert all(r.status_code==200 for r in reads)
        assert all((r.json()['data'] if path.startswith('/api/v2') else r.json())==value for r in reads)
        pending=asyncio.create_task(client.post(path,headers=headers,json={'client_id':'fire-ios','revision':value['revision']}))
        with pytest.raises(TimeoutError):await asyncio.wait_for(asyncio.shield(pending),.1)
    saved=await pending
    assert saved.status_code==200,saved.text
    data=saved.json()['data'] if path.startswith('/api/v2') else saved.json()
    assert data['status']=='unchanged'
    assert await snapshot(db)==before
    async with db.connection() as conn:
        await conn.execute('UPDATE identity_app_grants SET revoked_at=clock_timestamp() WHERE id=%s',(pair['grant_id'],))
    assert (await client.get(path,headers=headers)).status_code==401


async def test_missing_old_consent_bootstrap_releases_read_locks_before_serializing(client,db,admin):
    pair=await grant(db,admin,'portfolio.read portfolio.write cash.read')
    async with db.connection() as conn:
        await conn.execute('DELETE FROM identity_app_consents WHERE user_id=%s',(admin,))
    results=await asyncio.wait_for(asyncio.gather(*(client.get('/api/v2/auth/consent',headers=bearer(pair)) for _ in range(2))),3)
    assert all(r.status_code==200 for r in results),[r.text for r in results]
    assert results[0].json()['data']==results[1].json()['data']
    async with db.connection() as conn:
        assert (await(await conn.execute('SELECT count(*) AS n FROM identity_app_consents WHERE user_id=%s',(admin,))).fetchone())['n']==1
