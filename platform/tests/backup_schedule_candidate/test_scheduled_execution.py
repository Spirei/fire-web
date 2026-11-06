"""Actual encrypted scheduled output and bounded retention over disposable files."""
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

from alcor_api import backup_schedule
from alcor_api.worker import claim
from test_backups import backup_app, bc, configured, create_capsule, execute  # noqa: F401
from test_backups import submit as task_submit


async def test_due_schedule_and_verified_retention_do_not_touch_unregistered_file(bc, backup_app, configured):  # noqa: F811
    previous = []
    for _ in range(2):
        identifier, _ = await create_capsule(bc, backup_app, configured)
        job, _ = await task_submit(bc, 'backup.verify', backup_id=identifier)
        await execute(backup_app, configured, UUID(job['id']))
        previous.append(identifier)
    untouched = configured.backup_dir/'unregistered-original.enc'
    untouched.write_bytes(b'Unregistered original must remain')
    assert (await bc.post('/api/auth/login',json={'username':'BackupQA','password':'Synthetic9Pass'})).status_code == 200
    enabled = await bc.put('/api/backup',json={'requestId':str(uuid4()),'enabled':True,'intervalHours':1,'keep':1,'password':'Synthetic9Pass'})
    assert enabled.status_code == 200, enabled.text
    database = backup_app.state.db

    # Only the scheduler's single due-time observation moves forward; database
    # rows, authorization clocks, leases and immutable config remain unchanged.
    class FutureResult:
        async def fetchone(self):
            return {'at':datetime.now(UTC)+timedelta(hours=2)}
    class FutureConnection:
        def __init__(self, conn):self.conn=conn
        def __getattr__(self, name):return getattr(self.conn,name)
        async def execute(self, statement, *args, **kwargs):
            if statement == 'SELECT clock_timestamp() AS at':return FutureResult()
            return await self.conn.execute(statement,*args,**kwargs)
    class FutureDatabase:
        settings=database.settings
        @asynccontextmanager
        async def connection(self):
            async with database.connection() as conn:yield FutureConnection(conn)
    scheduler = backup_schedule.BackupSchedule(FutureDatabase())
    assert await scheduler.schedule_tick() == 1
    assert await scheduler.schedule_tick() == 0
    async with database.connection() as conn:
        admitted = await (await conn.execute("SELECT task_id FROM backup_schedule_admissions WHERE kind='scheduled'")).fetchall()
    assert len(admitted) == 1
    await execute(backup_app, configured, admitted[0]['task_id'])
    newest = str(admitted[0]['task_id'])
    assert (configured.backup_dir/(newest+'.enc')).is_file()
    verify, _ = await task_submit(bc,'backup.verify',backup_id=newest)
    await execute(backup_app,configured,UUID(verify['id']))
    assert await backup_app.state.backup_schedule.schedule_tick() == 1
    await backup_app.state.backup_schedule.schedule_tick()
    task = await claim(database,uuid4())
    assert task['kind'] == 'backup.retention'
    assert await backup_app.state.backup_schedule.execute_retention(task)
    async with database.connection() as conn:
        receipts = await (await conn.execute('SELECT backup_id,state FROM backup_retention_results')).fetchall()
        count = (await (await conn.execute("SELECT count(*) n FROM tasks WHERE kind='backup.retention'")).fetchone())['n']
    assert count == 1 and len(receipts) == 1 and receipts[0]['state'] == 'deleted'
    removed = str(receipts[0]['backup_id'])
    assert removed in previous and not (configured.backup_dir/(removed+'.enc')).exists()
    assert untouched.read_bytes() == b'Unregistered original must remain'
    assert (configured.backup_dir/(newest+'.enc')).is_file()
