"""Synthetic persistent backup grants; never touch backup files or run a backup."""
from uuid import uuid4

from psycopg.types.json import Jsonb

from alcor_api import backup_schedule


async def test_read_and_tick_do_not_enable_or_enqueue_backup(client, admin, app, db):
    response = await client.get('/api/backups/schedule')
    assert response.status_code == 200, response.text
    assert response.json()['config']['enabled'] is False
    assert await app.state.backup_schedule.schedule_tick() == 0
    async with db.connection() as conn:
        for table in ('backup_schedule_versions', 'backup_schedule_admissions', 'tasks'):
            assert (await (await conn.execute('SELECT count(*) AS n FROM '+table)).fetchone())['n'] == 0


async def test_persistent_grant_survives_browser_logout_but_not_revocation(settings, db, client, admin, monkeypatch):
    identity = {'device': 123, 'inode': 456, 'pathDigest': 'synthetic'}
    key = 'synthetic-key-fingerprint'
    monkeypatch.setattr(backup_schedule, 'storage', lambda _: (identity, key))
    async with db.connection() as conn, conn.transaction():
        version = (await (await conn.execute('SELECT session_version FROM users WHERE id=%s', (admin,))).fetchone())['session_version']
        await conn.execute('INSERT INTO backup_schedule_versions(revision,actor_id,request_id,enabled,interval_hours,keep,origin_instance,session_version,storage_identity,key_fingerprint) VALUES(1,%s,%s,true,24,3,%s,%s,%s,%s)', (admin,uuid4(),settings.instance_id,version,Jsonb(identity),key))
        admission = {'origin_instance': settings.instance_id, 'actor_id': admin, 'session_version': version, 'config_revision': 1, 'storage_identity': identity, 'key_fingerprint': key}
        assert await backup_schedule.authorization(conn, admission, settings)
        await conn.execute('DELETE FROM sessions WHERE user_id=%s', (admin,))
        assert await backup_schedule.authorization(conn, admission, settings)
        monkeypatch.setattr(backup_schedule, 'storage', lambda _: (identity, 'different-key'))
        assert not await backup_schedule.authorization(conn, admission, settings)
        monkeypatch.setattr(backup_schedule, 'storage', lambda _: (identity, key))
        await conn.execute('UPDATE users SET session_version=session_version+1 WHERE id=%s', (admin,))
        assert not await backup_schedule.authorization(conn, admission, settings)
