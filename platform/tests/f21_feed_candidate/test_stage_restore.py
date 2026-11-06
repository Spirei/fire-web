"""Populated stage inputs, raw pages and predecessors survive actual encrypted restore."""
from uuid import UUID

from alcor_api.db import Database
from alcor_api.feed_worker import FeedWorker
from alcor_api.feed_transport import FeedTransport
from alcor_api.feed_model import FeedModel
from fastapi import HTTPException
from test_backups import backup_app, bc, configured, create_capsule, execute  # noqa: F401
from test_backups import submit as backup_submit
from test_feed_workflow import test_plan_search_article_review_originals_and_replay as seed_news

TABLES=('feed_source_jobs','feed_source_admissions','feed_source_pages','feed_source_results','feed_posts','feed_post_marks','feed_operations')

async def snapshot(db, owner):
    async with db.connection() as conn:
        return {table:await(await conn.execute('SELECT * FROM '+table+' WHERE owner_id=%s ORDER BY 1,2,3',(owner,))).fetchall() for table in TABLES}

async def test_encrypted_restore_preserves_populated_stages_and_cannot_resume_source_io(bc,backup_app,configured,monkeypatch):  # noqa: F811
    db=backup_app.state.db
    async with db.connection() as conn:
        owner=(await(await conn.execute("SELECT id FROM users WHERE username='BackupQA'")).fetchone())['id']
    await seed_news(bc,db,owner,monkeypatch)
    before=await snapshot(db,owner)
    assert len(before['feed_source_admissions'])==6
    assert all(row['input_bytes'] and row['input_sha256'] and row['stage']!='legacy' for row in before['feed_source_admissions'])
    capsule,_=await create_capsule(bc,backup_app,configured)
    preview=await bc.get('/api/backups/'+capsule+'/restore-preview',params={'target_id':'isolated-qa'})
    assert preview.status_code==200,preview.text
    job,_=await backup_submit(bc,'backup.restore',backup_id=capsule,target_id='isolated-qa',restore_ticket=preview.json()['restore_ticket'])
    await execute(backup_app,configured,UUID(job['id']))
    target=configured.restore_targets[0]
    settings=configured.model_copy(update={'database_url':target.database_url,'instance_id':target.instance_id,'file_root':target.recovery_directory/'files'})
    restored=Database(settings);await restored.open()
    calls=[]
    async def no_io(*args,**kwargs):
        calls.append('unexpected');raise AssertionError('restored source evidence must not authorize new IO')
    monkeypatch.setattr(FeedTransport,'read',no_io);monkeypatch.setattr(FeedModel,'complete',no_io)
    try:
        assert await snapshot(restored,owner)==before
        async with restored.connection() as conn:
            assert await(await conn.execute('SELECT 1 FROM restore_quarantine LIMIT 1')).fetchone()
            task=await(await conn.execute("SELECT * FROM tasks WHERE owner_id=%s AND kind='feed.refresh'",(owner,))).fetchone()
        try:
            assert not await FeedWorker(restored).execute(task)
        except HTTPException as error:
            assert error.status_code in (401,403,409,503)
        assert calls==[]
        assert await snapshot(restored,owner)==before
    finally:await restored.close()
