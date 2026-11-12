"""Explicit bounded history intent over the existing source/worker authority."""
from dataclasses import asdict
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid5

from fastapi import HTTPException

from .market_authority import Authority
from .market_contract import Query, canonical, digest
from .market_worker import Bound


async def prepare(authority,who,request_id,items,days=330,*,minute=False,adjust='none'):
    if type(days) is not int or not 1<=days<=3300:raise HTTPException(400,'历史期间无效')
    if adjust not in ('none','qfq','hfq'):raise HTTPException(400,'历史复权口径无效')
    if not isinstance(items,list) or not 1<=len(items)<=100:raise HTTPException(400,'历史证券数量无效')
    rid=UUID(str(request_id));operation={'action':'history.prepare','items':items,'days':days,'minute':minute,'adjust':adjust}
    async with authority.db.connection() as conn,conn.transaction():
        await authority.owner_lock(conn,who)
        prior=await authority.receipt(conn,who.id,rid,operation)
        if prior:return prior
        bound=Authority(Bound(conn,authority.db.settings),policy_provider=authority.policy_provider,policies=authority.policies)
        configs=await (await conn.execute('SELECT revision FROM market_source_configs WHERE owner_id=%s',(who.id,))).fetchall()
        policies=[]
        for config in configs:
            try:_,policy=await authority.config(conn,who.id,config['revision'])
            except HTTPException:continue
            policies.append((config['revision'],policy))
        end=datetime.now(UTC).date();begin=end-timedelta(days=7 if minute else int(days*365/252)+20)
        streams=[];unavailable=[]
        for item in items:
            query=Query('price_series' if minute else 'bars',item['market'],item['code'],frame='minute' if minute else 'day',adjust=adjust if not minute and item.get('instrument','equity')=='equity' else 'none',session='ALL' if minute and item['market']=='US' else 'REGULAR',instrument=item.get('instrument','equity'),start=begin.isoformat(),through=end.isoformat()).validate()
            usable=[]
            for revision,policy in policies:
                try:authority.validate_query(policy,query)
                except HTTPException:continue
                usable.append((revision,policy))
            if not usable:
                unavailable.append(item);continue
            failed=await (await conn.execute("SELECT DISTINCT s.source_revision FROM market_streams s JOIN tasks t ON t.id=s.current_task_id WHERE s.owner_id=%s AND s.source_revision=ANY(%s) AND (s.query->>'kind'=%s OR %s AND s.query->>'kind'='latest') AND s.query->>'market'=%s AND s.query->>'code'=%s AND s.query->>'instrument'=%s AND t.status='failed' AND t.finished_at>clock_timestamp()-interval '60 seconds'",(who.id,[v[0] for v in usable],query.kind,minute,query.market,query.code,query.instrument))).fetchall()
            failed_revisions={r['source_revision'] for r in failed}
            usable=[v for v in usable if v[0] not in failed_revisions] or usable
            # Reuse the existing authorized history rather than introducing a
            # parallel series every time a page is reopened.
            existing=await (await conn.execute("SELECT source_revision FROM market_streams WHERE owner_id=%s AND source_revision=ANY(%s) AND query->>'kind'=%s AND query->>'frame'=%s AND query->>'adjust'=%s AND query->>'session'=%s AND query->>'market'=%s AND query->>'code'=%s AND query->>'instrument'=%s ORDER BY id LIMIT 1",(who.id,[v[0] for v in usable],query.kind,query.frame,query.adjust,query.session,query.market,query.code,query.instrument))).fetchone()
            if existing:usable=[v for v in usable if v[0]==existing['source_revision']]
            else:
                order=getattr(authority.db.settings,'_legacy_quote_order',None) or ['futu','tencent','eastmoney','yahoo']
                usable.sort(key=lambda row:order.index(row[1].source) if row[1].source in order else 99)
                usable=[v for v in usable if v[1].source==usable[0][1].source]
            if len(usable)!=1:raise HTTPException(409,'历史来源不唯一，请先核对行情源配置')
            revision,_=usable[0]
            stream=await (await conn.execute('SELECT s.id,t.status FROM market_streams s LEFT JOIN tasks t ON t.id=s.current_task_id WHERE s.owner_id=%s AND s.source_revision=%s AND s.query_fingerprint=%s',(who.id,revision,digest(asdict(query))))).fetchone()
            if stream and (stream['status'] in ('queued','running') or not minute and stream['status']=='succeeded'):
                streams.append(str(stream['id']));continue
            principal=str(getattr(who,'grant_id',None) or 'web:'+who.token_hash)
            old=await (await conn.execute('SELECT revision FROM market_demands WHERE owner_id=%s AND stream_id=%s AND principal=%s',(who.id,stream['id'],principal))).fetchone() if stream else None
            result=await bound.demand(who,uuid5(rid,'history:'+str(revision)+canonical(asdict(query))),revision,asdict(query),old['revision'] if old else 0,observed=True)
            streams.append(result['streamId'])
        return await authority.save_receipt(conn,who.id,rid,operation,{'requestId':str(rid),'purpose':'history.prepare','state':'accepted','streams':streams,'unavailable':unavailable})


async def progress(authority,who,request_id):
    """Observe the original intent; never renew demand or retry a provider here."""
    async with authority.db.connection() as conn,conn.transaction():
        await conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
        await authority.authorize_read(conn,who)
        saved=await authority.receipt(conn,who.id,UUID(str(request_id)))
        if not saved or saved.get('purpose')!='history.prepare':raise HTTPException(404,'本人历史采集请求不存在')
        identifiers=[UUID(value) for value in saved['streams']]
        rows=await (await conn.execute('SELECT s.id,s.source_revision,s.query,t.status FROM market_streams s LEFT JOIN tasks t ON t.id=s.current_task_id WHERE s.owner_id=%s AND s.id=ANY(%s)',(who.id,identifiers))).fetchall() if identifiers else []
        if len(rows)!=len(set(identifiers)):raise HTTPException(409,'历史采集范围已变化')
        from .market_authority import query_from
        for row in rows:
            _,policy=await authority.config(conn,who.id,row['source_revision'])
            authority.validate_query(policy,query_from(row['query']))
        pending=any(row['status'] in (None,'queued','running','cancel_requested') for row in rows)
        failed=any(row['status'] in ('failed','cancelled') for row in rows)
        return {'requestId':str(request_id),'pending':pending,'failed':failed,'unavailable':saved['unavailable'],
                'state':'pending' if pending else 'failed' if failed else 'complete',
                'streams':[{'id':str(row['id']),'state':row['status'] or 'pending'} for row in rows]}
