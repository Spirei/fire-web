"""Old backup controls use the encrypted queue; GET never runs a backup."""
import hashlib
from uuid import UUID, uuid4

from alcor_api import backups
from test_backups import backup_app, bc, configured, execute  # noqa: F401


async def test_legacy_backup_read_and_explicit_credentials(client, admin, app, db):
    login = await client.post('/api/auth/login',json={'username':'AdminOne','password':'Synthetic9Pass'})
    assert login.status_code == 200, login.text
    read = await client.get('/api/backup')
    assert read.status_code == 200, read.text
    assert read.json()['config']['enabled'] is False and read.json()['backups'] == []
    token = client.cookies['fire_session']
    for header in ({'authorization':''}, {'authorization':'Bearer '}, [('authorization','Bearer '+token),('authorization','Bearer '+('0'*64))]):
        for method in ('GET','POST','PUT'):
            denied = await client.request(method,'/api/backup',headers=header,**({'json':{}} if method!='GET' else {}))
            assert denied.status_code == 401, denied.text
    async with db.connection() as conn:
        for table in ('backup_schedule_versions','backup_schedule_admissions','tasks','backups'):
            assert (await (await conn.execute('SELECT count(*) n FROM '+table)).fetchone())['n'] == 0


async def test_legacy_backup_create_actual_encrypted_capsule_and_config_uuid(bc, backup_app, configured, monkeypatch):  # noqa: F811
    configured.backup_dir.mkdir(mode=0o700)
    backups.backup_key(configured)
    login = await bc.post('/api/auth/login',json={'username':'BackupQA','password':'Synthetic9Pass'})
    assert login.status_code == 200, login.text
    rid = str(uuid4())
    admitted = await bc.post('/api/backup',json={'requestId':rid})
    assert admitted.status_code == 202, admitted.text
    value = admitted.json()
    assert value['pending'] is True and value['ok'] is False and value['legacyClientIdempotency'] is True
    assert (await bc.post('/api/backup',json={'requestId':rid})).json() == value
    await execute(backup_app, configured, UUID(value['taskId']))
    raw = (configured.backup_dir/(value['taskId']+'.enc')).read_bytes()
    listed = (await bc.get('/api/backup')).json()
    row = next(item for item in listed['backups'] if item['id']==value['taskId'])
    assert row['sha256'] == hashlib.sha256(raw).hexdigest() and row['bytes'] == len(raw)
    assert b'BackupQA' not in raw and b'Owned immutable' not in raw
    command = {'requestId':str(uuid4()),'enabled':True,'intervalHours':1,'keep':1,'password':'Synthetic9Pass'}
    enabled = await bc.put('/api/backup',json=command)
    assert enabled.status_code == 200, enabled.text
    assert enabled.json()['config']['enabled'] is True
    assert enabled.json()['automaticBackupCreated'] is False
    assert (await bc.put('/api/backup',json=command)).json() == enabled.json()
    stale = await bc.put('/api/backup',json={**command,'requestId':str(uuid4()),'expectedRevision':0})
    assert stale.status_code == 409, stale.text
    disabled = await bc.put('/api/backup',json={'requestId':str(uuid4()),'enabled':False,'intervalHours':1,'keep':1})
    assert disabled.status_code == 200, disabled.text
    assert await backup_app.state.backup_schedule.schedule_tick() == 0
    from alcor_api import backup_schedule
    def unavailable(_):raise OSError('synthetic unavailable storage')
    monkeypatch.setattr(backup_schedule,'storage',unavailable)
    recovered = await bc.post('/api/backup',json={'requestId':rid})
    assert recovered.status_code == 202, recovered.text
    assert recovered.json()['taskId'] == value['taskId'] and recovered.json()['state'] == 'succeeded'
    assert recovered.json()['ok'] is True and recovered.json()['pending'] is False
    rejected = await bc.post('/api/backup',json={'requestId':str(uuid4())})
    assert rejected.status_code == 409, rejected.text


async def test_backup_catalog_rechecks_revoked_actor_before_read(client, admin, db, monkeypatch):
    from alcor_api import backup_schedule_api
    assert (await client.post('/api/auth/login',json={'username':'AdminOne','password':'Synthetic9Pass'})).status_code == 200
    original = backup_schedule_api.card_member
    async def revoke_after_admission(request, database):
        who = await original(request, database)
        async with db.connection() as conn:
            await conn.execute('DELETE FROM sessions WHERE token_hash=%s',(who.token_hash,))
        return who
    monkeypatch.setattr(backup_schedule_api,'card_member',revoke_after_admission)
    response = await client.get('/api/backup')
    assert response.status_code == 401, response.text
    assert 'backups' not in response.json()
