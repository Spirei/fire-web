"""Every checkout rechecks all approval owners without per-group round trips."""
from types import SimpleNamespace
from uuid import uuid4

import pytest


@pytest.mark.parametrize('invalid', ['missing', 'inactive', 'demoted', 'deleted'])
@pytest.mark.parametrize('mixed', [False, True])
async def test_runtime_groups_batch_actor_reads_but_recheck_every_checkout(monkeypatch, invalid, mixed):
    from alcor_api import private_runtime_settings as runtime

    owner = str(uuid4())
    other = str(uuid4())
    rows = [{'actor_id': other if mixed and index % 2 else owner, 'group_name': group, 'managed_fields': [], 'managed_targets': []} for index, group in enumerate(runtime.GROUP_FIELDS)]
    states = [{'id': actor, 'active': True, 'role': 'admin', 'deleted_at': None} for actor in ([owner, other] if mixed else [owner])]
    calls, decrypted, applied, disabled, validated = [], [], [], [], []
    settings = SimpleNamespace()

    async def read_rows(self, conn):
        return 7, rows, {}

    def decrypt(self, row):
        decrypted.append(row['group_name'])
        return {}

    monkeypatch.setattr(runtime.PrivateRuntimeSettings, 'rows', read_rows)
    monkeypatch.setattr(runtime.PrivateRuntimeSettings, 'decrypt', decrypt)
    monkeypatch.setattr(runtime, 'base_snapshot', lambda settings: {group: {} for group in runtime.GROUP_FIELDS})
    monkeypatch.setattr(runtime, 'apply_group', lambda settings, group, values: applied.append(group))
    monkeypatch.setattr(runtime, 'validate_group', lambda group, values, actor, settings: validated.append((group, actor.id)))
    monkeypatch.setattr(runtime, 'disable_group', lambda settings, group, *args: disabled.append(group))

    class Result:
        async def fetchall(self):
            return states

    class Connection:
        async def execute(self, statement, params):
            assert statement == 'SELECT id,active,role,deleted_at FROM users WHERE id=ANY(%s)'
            assert params == ([owner, other] if mixed else [owner],), 'deduplicate actors across all six groups'
            calls.append(statement)
            return Result()

    result = await runtime.load_runtime_on_connection(Connection(), settings)
    assert not result['unavailable']
    assert len(calls) == 1 and len(decrypted) == len(runtime.GROUP_FIELDS)
    assert len(validated) == len(runtime.GROUP_FIELDS), 'keep all per-group validation'
    decrypted.clear()
    if invalid == 'missing':
        states.pop(0)
    else:
        states[0].update({'active': False} if invalid == 'inactive' else {'role': 'user'} if invalid == 'demoted' else {'deleted_at': 'synthetic-deletion'})
    result = await runtime.load_runtime_on_connection(Connection(), settings)
    assert len(calls) == 2, 'no authorization snapshot is reused across checkouts'
    affected = {row['group_name'] for row in rows if row['actor_id'] == owner}
    assert set(decrypted) == set(runtime.GROUP_FIELDS) - affected, 'only currently authorized actors may decrypt their groups'
    assert set(result['unavailable']) == affected
    assert set(disabled) == affected


async def test_real_runtime_overlay_stops_after_actor_demotion_and_recovers(client, db, admin):
    saved = await client.post('/api/admin/private-runtime-settings', json={
        'requestId': str(uuid4()), 'expectedRevision': 0, 'group': 'scheduling',
        'patch': {'worker_poll_seconds': 2, 'lease_seconds': 60},
        'password': 'Synthetic9Pass',
    })
    assert saved.status_code == 200, saved.text
    async with db.connection() as conn:
        assert db.settings.worker_poll_seconds == 2 and db.settings.lease_seconds == 60
        await conn.execute("UPDATE users SET role='user' WHERE id=%s", (admin,))
    async with db.connection() as conn:
        assert db.settings.worker_poll_seconds == 1 and db.settings.lease_seconds == 30
        assert 'scheduling' in db.settings._private_runtime_unavailable
        await conn.execute("UPDATE users SET role='admin' WHERE id=%s", (admin,))
    async with db.connection():
        assert db.settings.worker_poll_seconds == 2 and db.settings.lease_seconds == 60
        assert not db.settings._private_runtime_unavailable
