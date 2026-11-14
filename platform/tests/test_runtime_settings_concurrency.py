"""Real encrypted PG settings never expose an intermediate installation default."""

import asyncio
from uuid import uuid4

import pytest

from alcor_api.market_authority import Authority, Policy
from alcor_api.private_runtime_settings import load_runtime_on_connection


async def install(client, db, owner):
    policy = dict(id='synthetic-current-source', source='controlled_market', source_version='captured-v1',
                  target_id='controlled-target', target_fingerprint='controlled-fingerprint', owner_id=owner,
                  license_revision='synthetic-current-license', purposes=['latest'], markets=['US'], fixture=True)
    saved = await client.post('/api/admin/private-runtime-settings', json={
        'requestId': str(uuid4()), 'expectedRevision': 0, 'group': 'sources',
        'patch': {'market_data_policies': [policy], 'quoteSource': 'auto',
                  'quoteSourceOrder': ['futu', 'tencent', 'eastmoney', 'yahoo']},
        'password': 'Synthetic9Pass',
    })
    assert saved.status_code == 200, saved.text
    async with db.connection():
        pass
    assert db.settings.market_data_policies == [policy]
    return policy


@pytest.mark.parametrize('cancel', [False, True])
async def test_source_configuration_remains_coherent_while_another_connection_revalidates(client, db, admin, cancel):
    policy = await install(client, db, admin)
    # Force the paused reader through the full decrypt path instead of the
    # steady-state signature fast path.
    object.__setattr__(db.settings, '_private_runtime_actors', None)
    entered, release = asyncio.Event(), asyncio.Event()

    class Paused:
        def __init__(self, conn): self.conn = conn
        async def execute(self, query, parameters=None):
            if str(query).startswith('SELECT id,active,role,deleted_at FROM users'):
                entered.set()
                await release.wait()
            return await self.conn.execute(query, parameters)

    async with db.pool.connection() as conn:
        loading = asyncio.create_task(load_runtime_on_connection(Paused(conn), db.settings))
        try:
            async with asyncio.timeout(3):
                await entered.wait()
            authority = Authority(db, policy_provider=lambda: tuple(Policy(**row) for row in db.settings.market_data_policies))
            # Reproduce the exact interleaving that previously made a valid
            # source temporarily disappear and propagate 403 to native clients.
            assert db.settings.market_data_policies == [policy]
            assert authority.policy(policy['id'], admin).license_revision == policy['license_revision']
            assert db.settings._legacy_quote_source == 'auto'
            if cancel:
                loading.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await loading
        finally:
            release.set()
            await asyncio.gather(loading, return_exceptions=True)
    assert db.settings.market_data_policies == [policy]


async def test_slow_older_configuration_cannot_replace_a_newer_saved_revision(client, db, admin):
    policy=await install(client,db,admin)
    object.__setattr__(db.settings, '_private_runtime_actors', None)
    entered,release=asyncio.Event(),asyncio.Event()

    class Paused:
        def __init__(self,conn):self.conn=conn
        async def execute(self,query,parameters=None):
            if str(query).startswith('SELECT id,active,role,deleted_at FROM users'):
                entered.set()
                await release.wait()
            return await self.conn.execute(query,parameters)

    async with db.pool.connection() as conn:
        loading=asyncio.create_task(load_runtime_on_connection(Paused(conn),db.settings))
        try:
            async with asyncio.timeout(3):await entered.wait()
            new_policy={**policy,'license_revision':'synthetic-new-license'}
            saved=await client.post('/api/admin/private-runtime-settings',json={
                'requestId':str(uuid4()),'expectedRevision':1,'group':'sources',
                'patch':{'market_data_policies':[new_policy]},'password':'Synthetic9Pass',
            })
            assert saved.status_code==200,saved.text
            async with db.connection():pass
            assert db.settings.market_data_policies==[new_policy]
        finally:
            release.set()
            await asyncio.gather(loading,return_exceptions=True)
    assert db.settings.market_data_policies==[new_policy]
    assert db.settings._private_runtime_revision==2


async def test_actual_approval_owner_revocation_still_disables_installed_sources(client,db,admin):
    await install(client,db,admin)
    async with db.pool.connection() as conn:
        await conn.execute('UPDATE users SET active=false WHERE id=%s',(admin,))
        result=await load_runtime_on_connection(conn,db.settings)
    assert result['unavailable']=={'sources':'unavailable_requires_current_instance_reapproval'}
    assert db.settings.market_data_policies==[]
