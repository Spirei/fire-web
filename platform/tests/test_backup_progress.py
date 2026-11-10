"""Long read phases must keep the owned lease and stop on revocation or deadline."""
import asyncio
from types import SimpleNamespace
import pytest
from alcor_api import backup_stream_jobs as jobs, backups


async def test_source_scan_keeps_guard_and_last_progress(monkeypatch):
    checkpoints=[]
    async def guard(db,task,progress=None):checkpoints.append(dict(progress))
    async def scan(settings,db,task,report):
        report('backup_sources',7,None,'objects')
        await asyncio.sleep(.26)
        return {'message':'sealed'}
    monkeypatch.setattr(backups,'guard',guard);monkeypatch.setattr(jobs,'_create_stream_backup',scan)
    result=await jobs.create_stream_backup(SimpleNamespace(lease_seconds=.2,backup_stream_seconds=5),None,{})
    assert result=={'message':'sealed'} and len(checkpoints)>=3
    assert all(p['phase']=='backup_sources' and p['processed']==7 for p in checkpoints)


async def test_revoked_scan_stops_without_publishing(monkeypatch):
    stopped=asyncio.Event();published=[]
    async def guard(*args):raise backups.BackupFailure('任务已取消')
    async def scan(settings,db,task,report):
        try:
            await asyncio.sleep(5);published.append(True)
        finally:stopped.set()
    monkeypatch.setattr(backups,'guard',guard);monkeypatch.setattr(jobs,'_create_stream_backup',scan)
    with pytest.raises(backups.BackupFailure,match='任务已取消'):
        await jobs.create_stream_backup(SimpleNamespace(lease_seconds=.2,backup_stream_seconds=5),None,{})
    assert stopped.is_set() and not published


async def test_whole_backup_deadline_includes_source_scanning(monkeypatch):
    stopped=asyncio.Event()
    async def guard(*args):pass
    async def scan(settings,db,task,report):
        try:await asyncio.sleep(5)
        finally:stopped.set()
    monkeypatch.setattr(backups,'guard',guard);monkeypatch.setattr(jobs,'_create_stream_backup',scan)
    with pytest.raises(backups.BackupFailure,match='时间预算'):
        await jobs.create_stream_backup(SimpleNamespace(lease_seconds=.2,backup_stream_seconds=.08),None,{})
    assert stopped.is_set()
