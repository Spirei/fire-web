"""Explicit public discovery licenses and immutable captures, never personal grants."""
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from decimal import Decimal
from hashlib import sha256
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo

import httpcore
from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .fx_reference import external_delivery_blocked
from .market_discovery_protocol import VERSION, Target, digest, parse, purpose, query
from .market_discovery_transport import PageFailure, Transport
from .notification_security import NotificationSecurity
from .public_market_authority import PublicAuthority, instant
from .public_market_quotes import PublicQuotes

SCOPES={'discovery.search','discovery.indices','discovery.top','discovery.ranking.volume','discovery.ranking.amount'}


@dataclass(frozen=True)
class PublicDiscoveryPolicy:
    id:str
    source:str
    source_version:str
    target_id:str
    target_fingerprint:str
    license_revision:str
    license_evidence_sha256:str
    instance_id:str
    valid_from:str
    valid_until:str
    markets:tuple[str,...]
    purposes:tuple[str,...]

    @property
    def fingerprint(self):return digest(asdict(self))


class PublicDiscovery:
    def __init__(self,db,policies=(),targets=(),*,policy_provider=None,target_provider=None,transport=None,quote_authority=None):
        self.db,self.policies,self.targets=db,tuple(policies),tuple(targets)
        self.policy_provider,self.target_provider=policy_provider,target_provider
        self.transport=transport or Transport()
        self.admin=PublicAuthority(db)
        self.quote_authority=quote_authority

    def policy(self,identifier):
        values=self.policy_provider() if self.policy_provider else self.policies
        matches=[p if isinstance(p,PublicDiscoveryPolicy) else PublicDiscoveryPolicy(**p) for p in values if (p.id if isinstance(p,PublicDiscoveryPolicy) else p.get('id'))==identifier]
        if len(matches)!=1:raise HTTPException(503,'公共发现许可未安装或不唯一')
        p=matches[0]
        try:
            if (p.source!='market-discovery' or p.source_version!=VERSION or str(p.instance_id)!=str(self.db.settings.instance_id)
                    or not p.id or not p.license_revision or len(p.license_evidence_sha256)!=64 or any(c not in '0123456789abcdef' for c in p.license_evidence_sha256)
                    or not p.markets or not set(p.markets)<={'US','HK','CN','JP','KR','ASSET','ALL'}
                    or not set(p.purposes)<={'collect','display',*SCOPES} or not set(p.purposes)&SCOPES
                    or instant(p.valid_from)>=instant(p.valid_until)):raise ValueError()
        except (ValueError,TypeError):raise HTTPException(503,'公共发现许可无效') from None
        return p

    def target(self,p,value):
        values=self.target_provider() if self.target_provider else self.targets
        found=[t if isinstance(t,Target) else Target(**t) for t in values if (t.id if isinstance(t,Target) else t.get('id'))==p.target_id]
        try:
            if len(found)!=1 or found[0].fingerprint!=p.target_fingerprint:raise ValueError()
            target=found[0].validate();target.request(value)
            markets=({'US'} if target.source=='cnn' else {'US','HK','CN'}) if value['kind']=='indices' else {value['market']} if value.get('market') else set()
            if not markets<=set(p.markets) or purpose(value) not in p.purposes:raise ValueError()
            return target
        except (ValueError,TypeError,KeyError):raise HTTPException(503,'公共发现目标或用途未获许可') from None

    async def lock(self,conn,identifier):
        await conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',('public-discovery:'+str(identifier),))

    async def current(self,conn,identifier,usage,value=None):
        await self.lock(conn,identifier)
        row=await(await conn.execute('SELECT * FROM public_discovery_licenses WHERE id=%s',(identifier,))).fetchone()
        if not row:raise HTTPException(404,'公共发现许可不存在')
        p=self.policy(row['policy_id'])
        instance=await(await conn.execute('SELECT instance_id FROM alcor_instance WHERE singleton')).fetchone()
        now=(await(await conn.execute('SELECT clock_timestamp() AS now')).fetchone())['now']
        if (usage not in ('collect','display') or usage not in p.purposes or row['policy_fingerprint']!=p.fingerprint
                or row['license_revision']!=p.license_revision or str(row['origin_instance'])!=str(p.instance_id)
                or not instance or str(instance['instance_id'])!=str(p.instance_id)
                or not instant(p.valid_from)<=now<instant(p.valid_until)
                or await(await conn.execute('SELECT 1 FROM public_discovery_revocations WHERE license_id=%s',(identifier,))).fetchone()):raise HTTPException(403,'公共发现许可已失效或撤销')
        if usage=='collect' and await external_delivery_blocked(conn):raise HTTPException(403,'恢复隔离禁止发现采集')
        if value is not None:self.target(p,value)
        return row,p

    async def prior(self,conn,who,rid,hashed):
        await self.admin._admin(conn,who)
        await self.lock(conn,'request:'+str(rid))
        row=await(await conn.execute('SELECT * FROM public_discovery_operations WHERE request_id=%s',(rid,))).fetchone()
        if row and (row['created_by']!=who.id or row['request_hash']!=hashed):raise HTTPException(409,'原UUID已用于其他公共发现操作')
        if row:
            final=await(await conn.execute('SELECT result FROM public_discovery_results WHERE request_id=%s',(rid,))).fetchone()
            return final['result'] if final else row['result']
        return None

    async def install(self,who,rid,policy_id,password,code=''):
        rid=UUID(str(rid));hashed=digest({'action':'install','policyId':policy_id})
        async with self.db.connection() as conn,conn.transaction():
            prior=await self.prior(conn,who,rid,hashed)
            if prior:return prior
            await NotificationSecurity(self.db).passkeys.step_up(conn,who,password,code)
            p=self.policy(policy_id);identifier=uuid4()
            await conn.execute('INSERT INTO public_discovery_licenses(id,policy_id,policy_fingerprint,license_revision,origin_instance,created_by) VALUES(%s,%s,%s,%s,%s,%s)',(identifier,p.id,p.fingerprint,p.license_revision,p.instance_id,who.id))
            result={'requestId':str(rid),'licenseId':str(identifier),'state':'installed'}
            await conn.execute('INSERT INTO public_discovery_operations(request_id,created_by,request_hash,license_id,result) VALUES(%s,%s,%s,%s,%s)',(rid,who.id,hashed,identifier,Jsonb(result)))
            return result

    async def revoke(self,who,rid,license_id,password,code=''):
        rid,identifier=UUID(str(rid)),UUID(str(license_id));hashed=digest({'action':'revoke','licenseId':str(identifier)})
        async with self.db.connection() as conn,conn.transaction():
            prior=await self.prior(conn,who,rid,hashed)
            if prior:return prior
            await NotificationSecurity(self.db).passkeys.step_up(conn,who,password,code)
            await self.lock(conn,identifier)
            if not await(await conn.execute('SELECT 1 FROM public_discovery_licenses WHERE id=%s',(identifier,))).fetchone():raise HTTPException(404,'公共发现许可不存在')
            await conn.execute('INSERT INTO public_discovery_revocations(license_id,request_id,created_by) VALUES(%s,%s,%s) ON CONFLICT(license_id) DO NOTHING',(identifier,rid,who.id))
            result={'requestId':str(rid),'licenseId':str(identifier),'state':'revoked'}
            await conn.execute('INSERT INTO public_discovery_operations(request_id,created_by,request_hash,license_id,result) VALUES(%s,%s,%s,%s,%s)',(rid,who.id,hashed,identifier,Jsonb(result)))
            return result

    async def rank_amounts(self,value,projection,*,snapshot=None,stamp=None):
        candidates=projection.pop('candidates');selected=candidates[:72]
        if self.quote_authority is None:raise HTTPException(503,'公共成交额报价许可未配置')
        observed=await PublicQuotes(self.quote_authority).read([{'id':row['code'],'market':value['market'],'code':row['code']} for row in selected],session='REGULAR',retain_evidence=True,snapshot=snapshot,observed_at=stamp if snapshot is not None else None)
        references=observed.pop('_publicEvidence')
        accepted=[];unresolved=[];exact={}
        for row in selected:
            data=observed['quotes'].get(row['code'],{});state=observed['quoteStates'].get(row['code'],{})
            try:
                amount=Decimal(data['dayStatsExact']['amount']);price=Decimal(state['priceExact'])
                stamp=datetime.fromisoformat(state['sourceTime']);local=stamp.astimezone(ZoneInfo('America/New_York' if value['market']=='US' else 'Asia/Shanghai')).date().isoformat()
                if (state['state'] not in ('observed','stale') or local!=projection['tradeDate'] or not amount.is_finite() or not 0<amount<=Decimal(row['upper']) or price<=0
                        or data.get('changePct') is None or data.get('source') not in ('futu','yahoo') or data.get('detailMetrics',{}).get('currency')!=projection['currency']):raise ValueError()
                exact[row['code']]=amount
                accepted.append({'market':value['market'],'code':row['code'],'name':data.get('name') or row['name'],'amount':float(amount),'price':float(price),'changePct':data['changePct'],'time':state['sourceTime'],
                    'sourceTime':state['sourceTime'],'quoteState':state['state'],'displayStale':data.get('displayStale'),
                    'cached':data.get('cached') if type(data.get('cached')) is bool else None})
            except (KeyError,ValueError,TypeError,ArithmeticError):unresolved.append(row)
        accepted.sort(key=lambda row:(-exact[row['code']],row['code']))
        outstanding=max([Decimal(row['upper']) for row in [*unresolved,*candidates[72:]]] or [Decimal(0)])
        verified=len(accepted)>=10 and exact[accepted[9]['code']]>outstanding
        projection.update(items=accepted[:10],publicQuoteEvidence=observed,publicQuoteFacts=references,rankingVerified=verified)
        projection['coverage'].update(complete=verified,observedCount=len(accepted[:10]),remainingCandidates=len(unresolved)+len(candidates[72:]),unverifiedAmountNeverSubstituted=True,
            rankingBasis='retained_provider_observations_on_trade_date_not_live',realTimePricesAssumed=False)
        return projection

    async def project(self,raw,target,value,stamp,p,*,snapshot=None):
        result=parse(raw,target,value,stamp)
        if value['kind']=='search':
            result['items']=[r for r in result['items'] if r['market'] in p.markets]
            result['coverage']['observedCount']=len(result['items'])
        if 'candidates' in result:result=await self.rank_amounts(value,result,snapshot=snapshot,stamp=stamp)
        return result

    async def collect(self,who,rid,license_id,raw,password,code=''):
        rid,identifier=UUID(str(rid)),UUID(str(license_id));value=query(raw);hashed=digest({'action':'collect','licenseId':str(identifier),'query':value})
        async with self.db.connection() as conn,conn.transaction():
            prior=await self.prior(conn,who,rid,hashed)
            if prior:return prior
            await NotificationSecurity(self.db).passkeys.step_up(conn,who,password,code)
            _,p=await self.current(conn,identifier,'collect',value);target=self.target(p,value)
            admitted={'requestId':str(rid),'licenseId':str(identifier),'state':'unknown','externalRequestAdmitted':True,'automaticRetry':False}
            await conn.execute('INSERT INTO public_discovery_operations(request_id,created_by,request_hash,license_id,query,result) VALUES(%s,%s,%s,%s,%s,%s)',(rid,who.id,hashed,identifier,Jsonb(value),Jsonb(admitted)))
        body=None;status=None;complete=False;projection=None;failure=None;stamp=datetime.now(UTC)
        try:
            body,status,_headers=await self.transport.read(target,value);complete=True
            projection=await self.project(body,target,value,stamp,p)
        except PageFailure as exc:body,status,complete=exc.raw,exc.status,exc.complete;failure='http_or_budget_failed'
        except (ValueError,TypeError,KeyError,UnicodeError,ArithmeticError,HTTPException,httpcore.NetworkError,httpcore.TimeoutException,TimeoutError):failure='source_unavailable_or_invalid'
        async with self.db.connection() as conn,conn.transaction():
            active=True
            try:await self.admin._admin(conn,who)
            except HTTPException:active=False
            await self.lock(conn,identifier)
            database=await(await conn.execute('SELECT instance_id FROM alcor_instance WHERE singleton')).fetchone()
            if not database or str(database['instance_id'])!=str(p.instance_id) or str(self.db.settings.instance_id)!=str(p.instance_id):raise HTTPException(409,'实例变化，旧响应不得写入其他实例')
            page_id=None
            if body is not None:
                page_id=uuid4()
                await conn.execute('INSERT INTO public_discovery_pages(id,request_id,raw_bytes,raw_sha256,http_status,complete) VALUES(%s,%s,%s,%s,%s,%s)',(page_id,rid,body,sha256(body).hexdigest(),status,complete))
            try:await self.current(conn,identifier,'collect',value)
            except HTTPException:active=False
            result={**admitted,'state':'retained_unavailable' if not active else 'observed' if projection is not None and failure is None else 'unavailable',
                    'projection':projection,'pageId':str(page_id) if page_id else None,'observedAt':stamp.isoformat(),'failure':failure,
                    'source':target.source,'licenseRevision':p.license_revision,'revision':digest({'requestId':str(rid),'projection':projection})}
            await conn.execute('INSERT INTO public_discovery_results(request_id,page_id,result) VALUES(%s,%s,%s)',(rid,page_id,Jsonb(result)))
            return result if active else {**admitted,'state':'retained_unavailable','originalsRetained':page_id is not None}

    async def read(self,raw,*,offset=0,limit=100,revision=None,**selectors):
        value=query(raw)
        if selectors.get('source_revision'):raise HTTPException(400,'匿名读取不能指定个人来源')
        if type(limit) is not int or not 1<=limit<=100 or type(offset) is not int or not 0<=offset<=1000000 or offset and not revision:raise HTTPException(400,'公共发现分页无效')
        async with self.db.connection() as conn,conn.transaction():
            rows=await(await conn.execute('''SELECT o.*,r.result AS final,p.raw_bytes,p.raw_sha256,p.http_status,p.complete,p.id AS page_id,p.request_id AS page_request
                FROM public_discovery_operations o JOIN public_discovery_results r ON r.request_id=o.request_id
                LEFT JOIN public_discovery_pages p ON p.id=r.page_id WHERE o.query=%s ORDER BY o.created_at DESC,o.request_id DESC LIMIT 1001''',(Jsonb(value),))).fetchall()
            if len(rows)>1000:raise HTTPException(409,'公共发现候选超过核对范围')
            choices={}
            for row in rows:
                try:
                    _,p=await self.current(conn,row['license_id'],'display',value);target=self.target(p,value)
                except HTTPException:continue
                if row['license_id'] in choices:continue
                final=row['final']
                if final['state']!='observed':continue
                if (not row['complete'] or row['http_status']!=200 or row['page_request']!=row['request_id']
                        or sha256(bytes(row['raw_bytes'])).hexdigest()!=row['raw_sha256']):raise HTTPException(503,'公共发现原件绑定无法核对')
                try:observed=await self.project(bytes(row['raw_bytes']),target,value,datetime.fromisoformat(final['observedAt']),p,snapshot=final['projection'].get('publicQuoteFacts'))
                except (ValueError,TypeError,KeyError,HTTPException):continue
                if digest(observed)!=digest(final['projection']):continue
                choices[row['license_id']]=(row,p,observed)
            if not choices:raise HTTPException(503,'公共发现许可或已观察结果不可用')
            if len(choices)!=1 and value['kind']!='indices':raise HTTPException(409,'公共发现存在多个来源，未自动选择')
            row,p,observed=next(iter(choices.values()));final=row['final']
            if value['kind']=='indices' and len(choices)>1:
                groups={}
                for _row,_policy,part in choices.values():
                    for group in part.get('groups') or []:
                        if not group.get('indices'):continue
                        key=group['market']
                        if key in groups:raise HTTPException(409,'公共指数同市场存在多个来源，未自动选择')
                        groups[key]=group
                observed={**observed,'groups':list(groups.values()),'items':[],
                          'coverage':{'scope':'explicit_public_index_groups','complete':all(part['coverage']['complete'] for _,_,part in choices.values()),
                                      'observedCount':sum(len(group['indices']) for group in groups.values())}}
                final={**final,'revision':digest(sorted(item[0]['final']['revision'] for item in choices.values()))}
            if revision and revision!=final['revision']:raise HTTPException(409,'公共发现版本已变化')
            items=observed['items']
            return {'query':value,'state':'observed','revision':final['revision'],'sourceRevision':None,'licenseRevision':p.license_revision,'source':final['source'],
                    'observedAt':final['observedAt'],**{k:v for k,v in observed.items() if k not in ('items','publicQuoteEvidence','publicQuoteFacts')},'items':items[offset:offset+limit],
                    'pagination':{'offset':offset,'limit':limit,'total':len(items),'hasMore':offset+limit<len(items)},'originals':[],'automaticCollection':False,'collectionOnRead':False}

    async def receipt(self,who,rid):
        async with self.db.connection() as conn,conn.transaction():
            await self.admin._admin(conn,who)
            row=await(await conn.execute('SELECT o.*,r.result AS final FROM public_discovery_operations o LEFT JOIN public_discovery_results r USING(request_id) WHERE o.request_id=%s AND o.created_by=%s',(UUID(str(rid)),who.id))).fetchone()
            if not row:raise HTTPException(404,'公共发现回执不存在')
            return row['final'] or row['result']

    async def original(self,who,page_id,password,code=''):
        async with self.db.connection() as conn,conn.transaction():
            await self.admin._admin(conn,who)
            await NotificationSecurity(self.db).passkeys.step_up(conn,who,password,code)
            row=await(await conn.execute('SELECT p.* FROM public_discovery_pages p JOIN public_discovery_operations o ON o.request_id=p.request_id WHERE p.id=%s AND o.created_by=%s',(UUID(str(page_id)),who.id))).fetchone()
            if not row:raise HTTPException(404,'公共发现原件不存在')
            data=bytes(row['raw_bytes'])
            if sha256(data).hexdigest()!=row['raw_sha256']:raise HTTPException(503,'公共发现原件校验失败')
            return data,row['raw_sha256']
