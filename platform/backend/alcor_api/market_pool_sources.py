"""Readonly origin-aware view; a business demand is never a removable client lease."""

from fastapi import HTTPException

from .market_authority import active_demands
from .market_pool_reads import enrich_metadata, milliseconds
from .security import lock_read_identity


class PoolSources:
    def __init__(self,authority):self.authority,self.db=authority,authority.db

    async def read(self,who,*,shared=False):
        async with self.db.connection() as conn,conn.transaction():
            await conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
            await lock_read_identity(conn,who,require_admin=shared)
            user=await (await conn.execute('SELECT role FROM users WHERE id=%s',(who.id,))).fetchone()
            if not user or user['role']!=who.role:raise HTTPException(403,'读取权限已变化')
            now=(await (await conn.execute('SELECT clock_timestamp() AS at')).fetchone())['at']
            rows=await (await conn.execute("SELECT d.*,s.query,s.source_revision,s.current_task_id,t.status AS task_status,t.lease_until FROM market_demands d JOIN market_streams s ON s.owner_id=d.owner_id AND s.id=d.stream_id LEFT JOIN tasks t ON t.id=s.current_task_id WHERE (%s OR d.owner_id=%s) AND d.revoked_at IS NULL AND (d.expires_at IS NULL OR d.expires_at>clock_timestamp()) AND s.query->>'kind'='latest' ORDER BY d.owner_id,d.stream_id,d.principal LIMIT 4097",(shared,who.id))).fetchall()
            if len(rows)>4096:raise HTTPException(409,'行情需求超过本次完整读取范围')
            active={};policies={};stamps={}
            if rows:
                accepted=await (await conn.execute("SELECT owner_id,result->>'streamId' AS stream_id,max(created_at) AS at FROM market_data_operations WHERE owner_id=ANY(%s) AND result->>'streamId'=ANY(%s) AND result->>'revoked'='false' GROUP BY owner_id,result->>'streamId'",(list({r['owner_id'] for r in rows}),list({str(r['stream_id']) for r in rows})))).fetchall()
                stamps={(r['owner_id'],r['stream_id']):r['at'] for r in accepted}
            entries={}
            for row in rows:
                stream=(row['owner_id'],row['stream_id'])
                if stream not in active:active[stream]={d['principal'] for d in await active_demands(conn,{'owner_id':row['owner_id'],'id':row['stream_id'],'query':row['query']})}
                if row['principal'] not in active[stream]:continue
                source=(row['owner_id'],row['source_revision'])
                if source not in policies:
                    try:_,policy=await self.authority.config(conn,*source);policies[source]=policy.source
                    except HTTPException:policies[source]=None
                own=row['owner_id']==who.id;origin=row['origin'];known=policies[source] is not None
                stamp=stamps.get((row['owner_id'],str(row['stream_id']))) if origin=='client' else None
                requested=milliseconds(stamp) if stamp else None
                expires=milliseconds(row['expires_at']) if row['expires_at'] else None
                updating=row['task_status']=='running' and row['lease_until'] is not None and row['lease_until']>now
                if not known:execution='source_unavailable'
                elif updating:execution='running'
                elif row['task_status']=='queued':execution='queued'
                elif row['task_status']=='running':execution='lease_expired'
                else:execution=row['task_status'] or 'not_scheduled'
                key=(row['query']['market'],row['query']['code'])
                entry=entries.setdefault(key,{'market':key[0],'code':key[1],'name':key[1],'icon':'','lastRequestedAt':None,'expiresAt':None,'cancellable':False,'updating':False,'sources':[]})
                # Other owners' subscriber/grant/rule/config identifiers are never
                # projected into the admin public-security aggregate.
                origin_key=(origin,own,str(row['source_revision']) if own else None,known)
                member=next((r for k,r in entry['sources'] if k==origin_key),None)
                if member is None:
                    member={'kind':origin,'ownership':'mine' if own else 'shared','sourceRevision':str(row['source_revision']) if own else None,'source':policies[source],'permission':'current' if known else 'unavailable','cancellable':origin=='client' and own,'count':0,'registeredAt':milliseconds(row['created_at']),'lastRequestedAt':requested,'expiresAt':expires,'lifetime':'client_lease' if origin=='client' else 'while_rule_enabled','collectionStates':[],'updating':False}
                    entry['sources'].append((origin_key,member))
                member['count']+=1;member['registeredAt']=min(member['registeredAt'],milliseconds(row['created_at']))
                if requested is not None:member['lastRequestedAt']=max(member['lastRequestedAt'] or requested,requested)
                if origin=='client':
                    if member['expiresAt'] is None or expires is None:member['expiresAt']=None
                    else:member['expiresAt']=max(member['expiresAt'],expires)
                member['updating']|=bool(updating)
                if execution not in member['collectionStates']:member['collectionStates'].append(execution)
                entry['cancellable']|=member['cancellable'];entry['updating']|=bool(updating)
            values=[]
            for entry in entries.values():
                members=[member for _,member in entry['sources']]
                members.sort(key=lambda row:(row['kind'],row['ownership'],row['sourceRevision'] or '',row['permission']))
                for member in members:member['collectionStates'].sort()
                entry['sources']=members
                requests=[r['lastRequestedAt'] for r in members if r['lastRequestedAt'] is not None]
                entry['lastRequestedAt']=max(requests) if requests else None
                # Any ongoing business demand precludes a finite aggregate expiry.
                expiry=[r['expiresAt'] for r in members]
                entry['expiresAt']=max(expiry) if all(value is not None for value in expiry) else None
                kinds={r['kind'] for r in members}
                entry['lifetime']='mixed' if len(kinds)>1 else members[0]['lifetime']
                values.append(entry)
            values.sort(key=lambda row:(row['market'],row['code']))
            await enrich_metadata(self.db,values)
            return {'scope':'shared' if shared else 'mine','at':milliseconds(now),'schema':'pool-origins-v1','entries':values}
