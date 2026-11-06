"""Real PG row-lock and rollback checks with a synthetic signing key."""

import asyncio
import time
from uuid import uuid4

from alcor_api.cli import create_user
from alcor_api.native_identity import totp_code
from alcor_api.security import digest
from test_identity_passkeys import LOGIN, assertion, prepared


async def blocked_query(conn, pattern):
    async with asyncio.timeout(5):
        while not await (await conn.execute(
            "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE %s",
            (pattern,),
        )).fetchone():
            await asyncio.sleep(.01)


async def test_config_change_serializes_before_a_pending_assertion_and_invalidates_it(db, settings, app):
    _, private, client = await prepared(db, settings, app)
    async with client:
        issued = (await client.post(LOGIN, json={'action': 'login-options'})).json()
        body = {'action': 'login-verify', 'requestId': issued['requestId'], 'response': assertion(issued['options'], private)}
        async with db.connection() as holder:
            async with holder.transaction():
                await holder.execute('SELECT * FROM identity_passkey_config WHERE singleton=true FOR UPDATE')
                operation = asyncio.create_task(client.post(LOGIN, json=body))
                async with db.connection() as monitor:
                    await blocked_query(monitor, '%identity_passkey_config%FOR SHARE%')
                await holder.execute("UPDATE identity_passkey_config SET revision='synthetic-next-config'")
                await holder.execute("DELETE FROM identity_challenges WHERE purpose LIKE 'passkey-%'")
            result = await asyncio.wait_for(operation, 5)
        assert result.status_code == 403
    async with db.connection() as conn:
        assert (await (await conn.execute('SELECT counter FROM identity_passkeys')).fetchone())['counter'] == 7
        assert not await (await conn.execute('SELECT 1 FROM sessions')).fetchone()


async def test_login_waits_for_owner_before_locking_challenge_or_credential_that_removal_needs(db, settings, app):
    _, private, client = await prepared(db, settings, app)
    async with client:
        issued = (await client.post(LOGIN, json={'action': 'login-options'})).json()
        body = {'action': 'login-verify', 'requestId': issued['requestId'], 'response': assertion(issued['options'], private)}
        async with db.connection() as holder:
            async with holder.transaction():
                # Block login owner mutation while allowing independent FK key-share checks.
                await holder.execute("SELECT id FROM users WHERE id='source-user-001' FOR NO KEY UPDATE")
                operation = asyncio.create_task(client.post(LOGIN, json=body))
                async with db.connection() as remover:
                    await blocked_query(remover, '%FROM users%FOR UPDATE%')
                    async with remover.transaction():
                        await remover.execute('SELECT id FROM identity_challenges WHERE id=%s FOR UPDATE NOWAIT', (digest(issued['requestId']),))
                        await remover.execute('SELECT id FROM identity_passkeys FOR UPDATE NOWAIT')
                        await remover.execute('DELETE FROM identity_passkeys')
            result = await asyncio.wait_for(operation, 5)
        assert result.status_code == 403
    async with db.connection() as conn:
        assert not await (await conn.execute('SELECT 1 FROM sessions')).fetchone()


async def test_account_closure_waits_for_passkey_identity_lock_before_taking_user_share(
    db, settings, app, monkeypatch
):
    import alcor_api.identity_passkeys as passkey_module

    _, private, client = await prepared(db, settings, app)
    await create_user(settings, 'BackupAdmin', 'Synthetic9Pass', role='admin')
    share_held, release_share = asyncio.Event(), asyncio.Event()
    original = passkey_module.lock_mutation_identity

    async def pause_after_share(conn, who, **kwargs):
        await original(conn, who, **kwargs)
        if who.id == 'source-user-001':
            share_held.set()
            await release_share.wait()

    async with client:
        issued = (await client.post(LOGIN, json={'action': 'login-options'})).json()
        login = await client.post(LOGIN, json={
            'action': 'login-verify', 'requestId': issued['requestId'],
            'response': assertion(issued['options'], private),
        })
        assert login.status_code == 200, login.text
        client.headers['x-csrf-token'] = login.json()['csrf']
        revision = (await client.get('/api/account')).json()['revision']
        monkeypatch.setattr(passkey_module, 'lock_mutation_identity', pause_after_share)
        enrollment = asyncio.create_task(client.post('/api/account/passkeys', json={
            'action': 'register-options', 'password': 'SyntheticSource9',
            'code': totp_code('JBSWY3DPEHPK3PXP', int(time.time())),
        }))
        await asyncio.wait_for(share_held.wait(), 5)
        request_id = str(uuid4())
        closure = asyncio.create_task(client.post('/api/account/close', json={
            'request_id': request_id, 'revision': revision,
            'current_password': 'SyntheticSource9', 'code': 'ABCD-1234-5678-90EF',
        }))
        try:
            async with db.connection() as monitor:
                # The enrollment owns the per-identity advisory and user SHARE.
                # Closure must wait on that advisory rather than taking another
                # user SHARE and deadlocking when enrollment upgrades to UPDATE.
                await blocked_query(monitor, '%pg_advisory_xact_lock(hashtextextended%')
        finally:
            release_share.set()
            registered, closed = await asyncio.wait_for(asyncio.gather(enrollment, closure), 5)
        assert registered.status_code == 200, registered.text
        assert closed.status_code == 200, closed.text
        assert closed.json() == {'request_id': request_id, 'user_id': 'source-user-001', 'deleted': True}
        assert (await client.get('/api/session')).status_code == 401
    async with db.connection() as conn:
        assert not await (await conn.execute("SELECT 1 FROM identity_challenges WHERE user_id='source-user-001'")).fetchone()
        assert not await (await conn.execute("SELECT 1 FROM identity_passkeys WHERE user_id='source-user-001'")).fetchone()
        assert not await (await conn.execute("SELECT 1 FROM identity_security WHERE user_id='source-user-001'")).fetchone()
        assert (await (await conn.execute("SELECT result FROM account_actions WHERE owner_id='source-user-001' AND request_id=%s", (request_id,))).fetchone())['result'] == closed.json()


async def test_session_write_failure_rolls_back_credential_counter_but_consumes_the_assertion(db, settings, app):
    _, private, client = await prepared(db, settings, app)
    async with client:
        issued = (await client.post(LOGIN, json={'action': 'login-options'})).json()
        async with db.connection() as conn:
            await conn.execute("""CREATE FUNCTION synthetic_reject_session() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN RAISE EXCEPTION 'Synthetic session insertion failure'; END $$""")
            await conn.execute('CREATE TRIGGER synthetic_session_failure BEFORE INSERT ON sessions FOR EACH ROW EXECUTE FUNCTION synthetic_reject_session()')
        body = {'action': 'login-verify', 'requestId': issued['requestId'], 'response': assertion(issued['options'], private)}
        rejected = await client.post(LOGIN, json=body)
        assert rejected.status_code == 403
        async with db.connection() as conn:
            assert (await (await conn.execute('SELECT counter FROM identity_passkeys')).fetchone())['counter'] == 7
            assert not await (await conn.execute('SELECT 1 FROM sessions')).fetchone()
            assert not await (await conn.execute('SELECT 1 FROM identity_challenges WHERE id=%s', (digest(issued['requestId']),))).fetchone()
            await conn.execute('DROP TRIGGER synthetic_session_failure ON sessions')
        assert (await client.post(LOGIN, json=body)).status_code == 403
        fresh = (await client.post(LOGIN, json={'action': 'login-options'})).json()
        good = await client.post(LOGIN, json={'action': 'login-verify', 'requestId': fresh['requestId'], 'response': assertion(fresh['options'], private)})
        assert good.status_code == 200
