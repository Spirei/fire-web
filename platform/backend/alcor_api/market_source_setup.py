"""Explicit owner-bound setup of the four requested read-only market providers."""
import asyncio
import copy
from dataclasses import asdict
from hashlib import sha256
from ipaddress import ip_address
from uuid import UUID, uuid5

from fastapi import HTTPException

from .dividend_sources import Target
from .fx_provider_transport import resolve
from .market_authority import Authority, Policy
from .market_source_tests import selection
from .market_worker import Bound
from .private_runtime_settings import PrivateRuntimeSettings, load_runtime_on_connection
from .security import lock_mutation_identity

SPECS = {
    'tencent': ('qt.gtimg.cn','tencent-quotes-v1',('US','HK','CN'),('latest',)),
    'eastmoney': ('push2delay.eastmoney.com','eastmoney-quotes-v1',('US','HK','CN','JP','KR','SG'),('latest',)),
    'yahoo': ('query1.finance.yahoo.com','yahoo-chart-history-v1',('US','HK','CN','JP','KR','SG'),('latest','bars.day')),
}


async def setup(db, authority, who, request_id):
    if who.role != 'admin':raise HTTPException(403,'需要管理员权限')
    rid=UUID(str(request_id));operation={'action':'market.sources.setup','version':1}
    async with db.connection() as conn,conn.transaction():
        await authority.owner_lock(conn,who)
        prior=await authority.receipt(conn,who.id,rid,operation)
        if prior:return prior
    # DNS is bounded and outside the write transaction. Targets cannot come from
    # a client URL; only these fixed public quote hosts can be installed here.
    async def target_for(provider, spec):
        host,version,markets,purposes=spec
        async with asyncio.timeout(3):addresses=tuple(await resolve(host,443))
        if not addresses or any(not ip_address(a).is_global or ip_address(a).is_multicast for a in addresses):
            raise HTTPException(503,'行情源地址暂时无法核对')
        identifier='quotes-'+provider+'-'+sha256(who.id.encode()).hexdigest()[:20]
        target=Target(identifier,provider,host,443,addresses,approved_access=True)
        policy=Policy(identifier,provider,version,identifier,target.fingerprint,who.id,'market-settings-v1',purposes,markets)
        if provider=='tencent':
            from dataclasses import replace
            policy=replace(policy,timestamp_zones=(('US','America/New_York'),('HK','Asia/Hong_Kong'),('CN','Asia/Shanghai')))
        return asdict(target),asdict(policy)
    generated=await asyncio.gather(*(target_for(k,v) for k,v in SPECS.items()))
    async with db.connection() as conn,conn.transaction():
        await conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',('identity-management:'+who.id,))
        await lock_mutation_identity(conn,who)
        await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended('private-runtime-settings',0))")
        await authority.owner_lock(conn,who)
        prior=await authority.receipt(conn,who.id,rid,operation)
        if prior:return prior
        private_service=PrivateRuntimeSettings(Bound(conn,db.settings))
        revision,private=await private_service.private_on_connection(conn)
        if private.get('_unavailableGroups',{}).get('sources'):raise HTTPException(409,'原行情配置不可用，请先恢复配置')
        targets=copy.deepcopy(private.get('dividend_source_targets',[]))
        policies=copy.deepcopy(private.get('market_data_policies',[]))
        chosen=[]
        for target,policy in generated:
            # Preserve any already configured, usable provider and its approval.
            selected=await selection(authority,conn,who,policy['source'])
            if selected:
                chosen.append((None,selected[0]));continue
            targets=[t for t in targets if t.get('id')!=target['id']]+[target]
            policies=[p for p in policies if p.get('id')!=policy['id']]+[policy]
            chosen.append((policy['id'],None))
        # The same approved OpenD device can read history; never change its host,
        # port, owner, transport or provider account permissions here.
        futu=[p for p in policies if p.get('source')=='futu' and p.get('owner_id')==who.id]
        if len(futu)==1:
            p=futu[0];before=list(p['purposes'])
            p['purposes']=list(dict.fromkeys(before+['bars.day','bars.minute.REGULAR','bars.minute.ALL','price_series.minute.REGULAR','price_series.minute.ALL']))
            if before!=p['purposes']:chosen.append((p['id'],None))
        await private_service.save(who,{'requestId':str(uuid5(rid,'private-sources')),'expectedRevision':revision,'group':'sources',
            'patch':{'dividend_source_targets':targets,'market_data_policies':policies,'quoteSource':private.get('quoteSource') or 'auto','quoteSourceOrder':private.get('quoteSourceOrder') or ['futu','tencent','eastmoney','yahoo']}},connection=conn)
        # Use a transaction-local policy view. Other processes consume the same
        # sealed PG revision through their normal runtime refresh after commit.
        bound=Authority(Bound(conn,db.settings),tuple(Policy(**p) for p in policies))
        configured=[]
        for policy_id,source_revision in chosen:
            if policy_id:
                result=await bound.configure(who,uuid5(rid,'configure:'+policy_id),policy_id)
                source_revision=result['revision']
                # Superseded client leases cannot block the newly approved
                # policy. Preserve their originals and all business alert rules.
                stale=await (await conn.execute("UPDATE market_demands d SET revoked_at=clock_timestamp(),revision=d.revision+1 FROM market_streams s JOIN market_source_configs c ON c.owner_id=s.owner_id AND c.revision=s.source_revision WHERE d.owner_id=%s AND d.owner_id=s.owner_id AND d.stream_id=s.id AND d.origin='client' AND d.revoked_at IS NULL AND c.policy_id=%s AND s.source_revision<>%s RETURNING d.stream_id",(who.id,policy_id,source_revision))).fetchall()
                if stale:await conn.execute('UPDATE market_streams SET demand_generation=demand_generation+1 WHERE owner_id=%s AND id=ANY(%s)',(who.id,[r['stream_id'] for r in stale]))
            configured.append(str(source_revision))
        result={'requestId':str(rid),'state':'configured','sources':configured}
        await authority.save_receipt(conn,who.id,rid,operation,result)
    async with db.connection() as conn,conn.transaction():await load_runtime_on_connection(conn,db.settings)
    return result
