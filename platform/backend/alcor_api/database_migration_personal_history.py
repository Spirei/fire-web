"""Retain owned alert rules and feed originals without reactivating old jobs."""
import json
from datetime import UTC,datetime,timedelta
from uuid import UUID,uuid5

from psycopg.types.json import Jsonb

from .backups import BackupFailure
from .database_migration_capture import canonical,sha


def decoded(value,default):
    return json.loads(value) if isinstance(value,str) else value if value is not None else default


def alert_time(value):
    # The old alert protocol stores epoch milliseconds, unlike native PG timestamps.
    if value is None:return None
    try:return datetime(1970,1,1,tzinfo=UTC)+timedelta(milliseconds=int(value))
    except (TypeError,ValueError,OverflowError):raise BackupFailure('原提醒时间无效') from None


async def import_owned_history(conn,who,plan,selected,task):
    from .price_alert_contract import rule
    from .feed_core import validate_post,text
    from .card_preferences import persist_json
    now=datetime.now(UTC)
    for row in selected['price_alert_rules']:
        original=decoded(row['config'],{})
        expiry=original.get('expiresAt')
        config=rule({**original,'expiresAt':None},now)
        if expiry is not None and (type(expiry) is not int or expiry<0):raise BackupFailure('原提醒的到期时间无效')
        config['expiresAt']=expiry
        if config['id']!=row['id']:raise BackupFailure('原提醒编号不一致')
        if row['state'] not in ('enabled','paused','completed','expired','deleted'):raise BackupFailure('原提醒状态不可表达')
        state='paused' if row['state']=='enabled' else row['state']
        prior=await(await conn.execute('SELECT 1 FROM price_alert_rules WHERE owner_id=%s AND id=%s',(who.id,UUID(row['id'])))).fetchone()
        if prior:raise BackupFailure('原提醒编号与当前提醒冲突')
        await conn.execute('INSERT INTO price_alert_rules(owner_id,id,revision,account_id,source_identity,config,state,activated_at,last_quote_at,deleted_at) VALUES(%s,%s,%s,%s,\'platform\',%s,%s,%s,%s,%s)',
            (who.id,UUID(row['id']),max(1,int(row['revision'])),who.id,Jsonb(config),state,alert_time(row['activated_at']),alert_time(row.get('last_quote_at')),now if state=='deleted' else None))
    if selected['price_alert_rules']:
        await conn.execute('INSERT INTO price_alert_collections(owner_id,revision) VALUES(%s,1) ON CONFLICT(owner_id) DO UPDATE SET revision=price_alert_collections.revision+1',(who.id,))
    for row in selected['feed_groups']:
        if row.get('mode') not in ('news','people'):raise BackupFailure('原动态分组类别不可表达')
        if await(await conn.execute('SELECT 1 FROM feed_groups WHERE owner_id=%s AND id=%s',(who.id,row['id']))).fetchone():raise BackupFailure('原动态分组与当前编号冲突')
        await conn.execute('INSERT INTO feed_groups(owner_id,id,name,mode,people,subscriptions,updated_at) VALUES(%s,%s,%s,%s,%s,%s,%s)',
            (who.id,row['id'],text(row['name'],40),row['mode'],Jsonb(decoded(row.get('people'),[])),Jsonb(decoded(row.get('subscriptions'),[])),row['updated_at']))
    for row in selected['feed_preferences']:
        if await(await conn.execute('SELECT 1 FROM feed_preferences WHERE owner_id=%s',(who.id,))).fetchone():raise BackupFailure('当前动态偏好已有记录，未覆盖')
        await conn.execute('INSERT INTO feed_preferences(owner_id,instructions,revision,enabled,interval_minutes,updated_at) VALUES(%s,%s,%s,false,%s,%s)',
            (who.id,text(row['instructions'],12000,empty=True),int(row['revision']),int(row['interval_minutes']),row['updated_at']))
    for row in selected['feed_group_preferences']:
        await conn.execute('INSERT INTO feed_group_preferences(owner_id,group_id,instructions,revision,enabled,interval_minutes,updated_at) VALUES(%s,%s,%s,%s,false,%s,%s)',
            (who.id,row['group_id'],text(row['instructions'],12000,empty=True),int(row['revision']),int(row['interval_minutes']),row['updated_at']))
    revision='legacy-archive:'+plan['source_manifest_sha256']
    for row in selected['feed_posts']:
        payload=validate_post(decoded(row['payload'],{}))
        page='legacy-row:'+sha(canonical(row))
        await conn.execute('INSERT INTO feed_posts(owner_id,id,group_id,fingerprint,payload,kind,author_key,source_revision,source_page_id,sort_at,created_at) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',
            (who.id,row['id'],row['group_id'],row['fingerprint'],Jsonb(persist_json(payload)),row['kind'],row.get('author_key'),revision,page,row['sort_at'],row['created_at']))
        if row.get('liked') or row.get('hidden'):
            await conn.execute('INSERT INTO feed_post_marks(owner_id,post_id,liked,hidden) VALUES(%s,%s,%s,%s)',(who.id,row['id'],bool(row.get('liked')),bool(row.get('hidden'))))
    for row in selected['feed_messages']:
        if row['role'] not in ('user','assistant'):raise BackupFailure('原动态讨论角色不可表达')
        await conn.execute('INSERT INTO feed_messages(owner_id,id,post_id,request_id,role,text,source_revision,source_page_id,created_at) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s)',
            (who.id,row['id'],row['post_id'],uuid5(task['request_id'],'feed-message:'+row['id']),row['role'],text(row['text'],12000),revision if row['role']=='assistant' else None,'legacy-row:'+sha(canonical(row)) if row['role']=='assistant' else None,row['created_at']))
    return {'price_alert_rules':len(selected['price_alert_rules']),'feed_groups':len(selected['feed_groups']),'feed_posts':len(selected['feed_posts']),'feed_messages':len(selected['feed_messages']),
            'feed_source_evidence':'sealed_original_archive_not_new_external_observation','automatic_jobs_reactivated':False}
