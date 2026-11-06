"""Persistent NAS read/export limits. No automatic deletion or history pruning."""
from fastapi import HTTPException


async def usage(conn,owner,instance):
    pending=await(await conn.execute("SELECT owner_id,request_id,(result->>'reservationBytes')::bigint reserved FROM legacy_source_operations WHERE state='reading' AND result->>'operationType'='source_export' AND result->>'platformInstance'=%s",(str(instance),))).fetchall()
    sizes=await(await conn.execute("SELECT owner_id,coalesce(sum(octet_length(raw)+coalesce(octet_length(financial_raw),0)+coalesce(octet_length(fee_payload::text),0)+octet_length(manifest::text)),0) bytes FROM legacy_source_manifests GROUP BY owner_id")).fetchall()
    installed=await(await conn.execute("SELECT to_regclass('watch_group_import_operations') operations,to_regclass('watch_group_source_manifests') manifests")).fetchone()
    if installed['operations'] and installed['manifests']:
        pending+=await(await conn.execute("SELECT owner_id,request_id,(result->>'reservationBytes')::bigint reserved FROM watch_group_import_operations WHERE kind='capture' AND state='reading' AND result->>'platformInstance'=%s",(str(instance),))).fetchall()
        sizes+=await(await conn.execute("SELECT owner_id,coalesce(sum(octet_length(raw)+octet_length(manifest::text)),0) bytes FROM watch_group_source_manifests GROUP BY owner_id")).fetchall()
    icons=await(await conn.execute("SELECT to_regclass('watch_group_source_icon_captures') name")).fetchone()
    if icons['name']:
        sizes+=await(await conn.execute("SELECT owner_id,coalesce(sum(original_size),0) bytes FROM watch_group_source_icon_captures WHERE state='captured' GROUP BY owner_id")).fetchall()
    return {'ownerPending':[row for row in pending if row['owner_id']==owner],'instancePending':pending,'ownerBytes':sum(row['bytes'] for row in sizes if row['owner_id']==owner),'instanceBytes':sum(row['bytes'] for row in sizes)}


async def reserve(conn,owner,instance):
    await conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',('legacy-source-export-budget:'+str(instance),))
    policy=await(await conn.execute('SELECT * FROM legacy_source_export_policy WHERE singleton FOR SHARE')).fetchone()
    state=await usage(conn,owner,instance)
    if len(state['ownerPending'])>=policy['owner_pending'] or len(state['instancePending'])>=policy['instance_pending']:
        raise HTTPException(429,'导出并发预算已满；请查询原UUID回执，不要重新抓取来源')
    reserved=policy['reservation_bytes']
    if state['ownerBytes']+sum(row['reserved'] for row in state['ownerPending'])+reserved>policy['owner_bytes'] or state['instanceBytes']+sum(row['reserved'] for row in state['instancePending'])+reserved>policy['instance_bytes']:
        raise HTTPException(429,'导出证据容量预算已满；原始快照与回执继续保留，请先核对容量配置')
    bucket=(await(await conn.execute("SELECT date_trunc('hour',clock_timestamp()) bucket")).fetchone())['bucket']
    for scope,limit in (('owner:'+owner,policy['owner_hourly']),('instance:'+str(instance),policy['instance_hourly'])):
        row=await(await conn.execute('SELECT attempts FROM legacy_source_export_windows WHERE scope=%s AND bucket=%s',(scope,bucket))).fetchone()
        if row and row['attempts']>=limit:raise HTTPException(429,'导出频率预算已满；原UUID查询不会再次取源')
    for scope in ('owner:'+owner,'instance:'+str(instance)):
        await conn.execute('INSERT INTO legacy_source_export_windows VALUES(%s,%s,1) ON CONFLICT(scope,bucket) DO UPDATE SET attempts=legacy_source_export_windows.attempts+1',(scope,bucket))
    return reserved


async def public_status(conn,owner,instance):
    policy=await(await conn.execute('SELECT * FROM legacy_source_export_policy WHERE singleton')).fetchone()
    state=await usage(conn,owner,instance)
    return {'ownerPending':len(state['ownerPending']),'ownerPendingLimit':policy['owner_pending'],'instancePendingLimit':policy['instance_pending'],'ownerHourlyLimit':policy['owner_hourly'],'instanceHourlyLimit':policy['instance_hourly'],'ownerStoredBytes':state['ownerBytes'],'ownerBytesLimit':policy['owner_bytes'],'instanceBytesLimit':policy['instance_bytes'],'reservationBytes':policy['reservation_bytes'],'pendingOriginalRequestIds':[str(row['request_id']) for row in state['ownerPending']],'automaticHistoryPruning':False}
