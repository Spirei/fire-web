"""An idle heartbeat retains real migration backup progress and verified archives."""
import threading
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock
from types import SimpleNamespace
from uuid import uuid4
from pydantic import SecretStr
from alcor_api import database_migration_completion as completion
from alcor_api.backups import private_dir,write_private
from alcor_api.connections import Vault
from alcor_api.database_migration_capture import sha


async def test_backup_progress_does_not_reset_without_new_event_and_reuses_receipt(tmp_path,monkeypatch):
    settings=SimpleNamespace(backup_dir=tmp_path/'backups',connection_secret_dir=tmp_path/'keys',instance_id=uuid4(),database_url=SecretStr('postgresql://synthetic@localhost/never-used'),backup_stream_max_bytes=1024**2,backup_stream_max_objects=100,backup_stream_disk_reserve_bytes=0,backup_stream_seconds=5)
    Vault(private_dir(settings.connection_secret_dir)).key()
    @asynccontextmanager
    async def connection():
        yield SimpleNamespace(execute=AsyncMock(return_value=SimpleNamespace(fetchall=AsyncMock(return_value=[]))))
    db=SimpleNamespace(settings=settings,connection=connection);task={'id':uuid4(),'owner_id':'synthetic-owner','attempts':1,'payload':{'conversion_id':str(uuid4()),'_archive':{'identities':{'target':'synthetic'}}}}
    release=threading.Event();values=[];captures=[]
    def capture(settings,dsn,root,label,budget,cancel,progress,**kwargs):
        captures.append(True);folder=private_dir(root/label);write_private(folder/'database.dump',b'controlled archive')
        progress({'phase':'target_rows','processed':7,'total':9,'unit':'tables'})
        release.wait(3)
        return {'archive_sha256':sha(b'controlled archive')}
    async def guard(db,task,progress=None):
        values.append(dict(progress))
        if sum(v['processed']==7 for v in values)>=2:release.set()
    monkeypatch.setattr(completion,'capture_database',capture);monkeypatch.setattr(completion,'guard',guard)
    result=await completion.backup_target(db,task)
    assert sum(v['processed']==7 for v in values)>=2
    first=next(i for i,v in enumerate(values) if v['processed']==7)
    assert all(v['processed']==7 and v['total']==9 for v in values[first:])
    assert await completion.backup_target(db,task)==result and len(captures)==1
