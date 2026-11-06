"""Independent instance-public reference licences and retained acquisition receipts."""
from dataclasses import asdict, dataclass
from datetime import datetime
from hashlib import sha256
from uuid import UUID, uuid4

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .fx_reference import external_delivery_blocked
from .market_discovery_protocol import digest
from .notification_security import NotificationSecurity
from .security import lock_mutation_identity


@dataclass(frozen=True)
class PublicReferencePolicy:
    id:str
    kind:str
    source_version:str
    target_id:str
    target_fingerprint:str
    license_revision:str
    license_evidence_sha256:str
    instance_id:str
    valid_from:str
    valid_until:str
    purposes:tuple[str,...]
    markets:tuple[str,...]
    codes:tuple[str,...]=()
    months:tuple[str,...]=()

    @property
    def fingerprint(self):return digest(asdict(self))


def instant(value):
    stamp=datetime.fromisoformat(value)
    if stamp.tzinfo is None:raise ValueError()
    return stamp


class PublicReference:
    def __init__(self,db,policies=(),*,policy_provider=None,adapters=None):
        self.db,self.policies,self.policy_provider,self.adapters=db,tuple(policies),policy_provider,dict(adapters or {})

    def policy(self,identifier):
        installed=self.policy_provider() if self.policy_provider else self.policies
        try:
            if not isinstance(installed,(list,tuple)) or len(installed)>128:raise ValueError()
            rows=[p if isinstance(p,PublicReferencePolicy) else PublicReferencePolicy(**p) for p in installed
                  if (p.id if isinstance(p,PublicReferencePolicy) else p.get('id'))==identifier]
            if len(rows)!=1:raise ValueError()
            policy=rows[0];adapter=self.adapters[policy.kind]
            if (not all(isinstance(item,str) and item for item in (policy.id,policy.kind,policy.source_version,policy.target_id,policy.target_fingerprint,policy.license_revision))
                    or policy.source_version!=adapter.source_version or str(policy.instance_id)!=str(self.db.settings.instance_id)
                    or len(policy.license_evidence_sha256)!=64 or any(c not in '0123456789abcdef' for c in policy.license_evidence_sha256)
                    or not isinstance(policy.purposes,(tuple,list)) or not policy.purposes or not set(policy.purposes)<={'collect','display'}
                    or not isinstance(policy.markets,(tuple,list)) or not policy.markets or not set(policy.markets)<={'US','CN','HK'}
                    or not isinstance(policy.codes,(tuple,list)) or len(policy.codes)>10000
                    or not all(isinstance(code,str) and 1<=len(code)<=40 and code.isascii() for code in policy.codes)
                    or not isinstance(policy.months,(tuple,list)) or len(policy.months)>1200
                    or not all(isinstance(month,str) and len(month)==7 and datetime.strptime(month,'%Y-%m') for month in policy.months)
                    or policy.kind=='earnings.calendar' and not policy.months
                    or policy.kind in ('company-profile','financials') and not policy.codes
                    or instant(policy.valid_from)>=instant(policy.valid_until)):
                raise ValueError()
            adapter.target(policy)
            return policy
        except (ValueError,TypeError,KeyError,AttributeError):raise HTTPException(503,'独立公开资料许可未安装或无效') from None

    async def lock(self,conn,identifier):
        await conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',('public-reference-license:'+str(identifier),))

    async def current(self,conn,identifier,purpose,query=None):
        identifier=UUID(str(identifier));await self.lock(conn,identifier)
        row=await (await conn.execute('SELECT * FROM public_reference_licenses WHERE id=%s',(identifier,))).fetchone()
        if not row:raise HTTPException(404,'公开资料许可不存在')
        policy=self.policy(row['policy_id']);adapter=self.adapters[policy.kind]
        current=await (await conn.execute('SELECT instance_id,clock_timestamp() AS now FROM alcor_instance WHERE singleton')).fetchone()
        if (not current or str(current['instance_id'])!=str(policy.instance_id) or str(row['origin_instance'])!=str(policy.instance_id)
                or row['policy_fingerprint']!=policy.fingerprint or row['license_revision']!=policy.license_revision
                or purpose not in policy.purposes or not instant(policy.valid_from)<=current['now']<instant(policy.valid_until)
                or await (await conn.execute('SELECT 1 FROM public_reference_revocations WHERE license_id=%s',(identifier,))).fetchone()):
            raise HTTPException(403,'公开资料许可已撤销或失效')
        if purpose=='collect' and await external_delivery_blocked(conn):raise HTTPException(403,'恢复隔离禁止公开资料外部采集')
        if query is not None:
            if query.get('market') not in policy.markets:raise HTTPException(403,'公开资料市场不在许可范围')
            if query.get('code') is not None and query['code'] not in policy.codes:raise HTTPException(403,'公开资料证券未明确许可')
            if query.get('month') is not None and query['month'] not in policy.months:raise HTTPException(403,'公开资料月份未明确许可')
            try:adapter.validate(policy,adapter.target(policy),query)
            except (ValueError,TypeError,KeyError):raise HTTPException(403,'公开资料查询与独立许可不匹配') from None
        return row,policy

    async def admin(self,conn,who):
        if getattr(who,'native_client',False) or getattr(who,'legacy_client',False):raise HTTPException(403,'公开来源管理需要新网页管理员')
        await lock_mutation_identity(conn,who)
        await conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',('public-reference-admin:'+who.id,))

    async def request_lock(self,conn,rid):
        await conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',('public-reference-request:'+str(rid),))

    async def prior(self,conn,who,rid,hashed):
        for table in ('public_reference_receipts','public_reference_admissions'):
            row=await (await conn.execute('SELECT * FROM '+table+' WHERE request_id=%s',(rid,))).fetchone()
            if row:
                if row['created_by']!=who.id or row['request_hash']!=hashed:raise HTTPException(409,'原UUID已用于其他公开资料请求')
                return row.get('result') or {'requestId':str(rid),'state':'unknown','willRetryAutomatically':False}
        return None

    async def save(self,conn,who,rid,hashed,result):
        await conn.execute('INSERT INTO public_reference_receipts(request_id,request_hash,result,created_by) VALUES(%s,%s,%s,%s)',(rid,hashed,Jsonb(result),who.id))
        return result

    async def install(self,who,rid,policy_id,password,code=''):
        rid=UUID(str(rid));hashed=digest({'action':'install','policyId':policy_id})
        async with self.db.connection() as conn,conn.transaction():
            await self.admin(conn,who);await self.request_lock(conn,rid)
            old=await self.prior(conn,who,rid,hashed)
            if old:return old
            await NotificationSecurity(self.db).passkeys.step_up(conn,who,password,code)
            policy=self.policy(policy_id);identifier=uuid4()
            now=(await (await conn.execute('SELECT clock_timestamp() AS now')).fetchone())['now']
            if not instant(policy.valid_from)<=now<instant(policy.valid_until):raise HTTPException(403,'公开资料许可尚未生效或已过期')
            await conn.execute('INSERT INTO public_reference_licenses(id,policy_id,policy_fingerprint,license_revision,origin_instance,created_by) VALUES(%s,%s,%s,%s,%s,%s)',(identifier,policy.id,policy.fingerprint,policy.license_revision,policy.instance_id,who.id))
            return await self.save(conn,who,rid,hashed,{'requestId':str(rid),'state':'completed','licenseId':str(identifier),'kind':policy.kind})

    async def revoke(self,who,rid,identifier,password,code=''):
        rid,identifier=UUID(str(rid)),UUID(str(identifier));hashed=digest({'action':'revoke','licenseId':str(identifier)})
        async with self.db.connection() as conn,conn.transaction():
            await self.admin(conn,who);await self.lock(conn,identifier);await self.request_lock(conn,rid)
            old=await self.prior(conn,who,rid,hashed)
            if old:return old
            await NotificationSecurity(self.db).passkeys.step_up(conn,who,password,code)
            row=await (await conn.execute('SELECT * FROM public_reference_licenses WHERE id=%s AND origin_instance=%s',(identifier,str(self.db.settings.instance_id)))).fetchone()
            if not row:raise HTTPException(404,'公开资料许可不存在')
            await conn.execute('INSERT INTO public_reference_revocations(license_id,request_id,created_by) VALUES(%s,%s,%s) ON CONFLICT(license_id) DO NOTHING',(identifier,rid,who.id))
            return await self.save(conn,who,rid,hashed,{'requestId':str(rid),'state':'completed','licenseId':str(identifier),'revoked':True})

    async def collect(self,who,rid,identifier,raw,password,code=''):
        rid,identifier=UUID(str(rid)),UUID(str(identifier))
        async with self.db.connection() as conn,conn.transaction():
            await self.admin(conn,who);await self.lock(conn,identifier);await self.request_lock(conn,rid)
            _row,policy=await self.current(conn,identifier,'collect')
            adapter=self.adapters[policy.kind];query=adapter.normalize(raw,collect=True);scope=adapter.scope(query)
            hashed=digest({'action':'collect','licenseId':str(identifier),'query':query})
            old=await self.prior(conn,who,rid,hashed)
            if old:return old
            await NotificationSecurity(self.db).passkeys.step_up(conn,who,password,code)
            await self.current(conn,identifier,'collect',query)
            await conn.execute('INSERT INTO public_reference_admissions(request_id,request_hash,license_id,query,scope,origin_instance,created_by) VALUES(%s,%s,%s,%s,%s,%s,%s)',(rid,hashed,identifier,Jsonb(query),Jsonb(scope),str(self.db.settings.instance_id),who.id))
        pages=[];payload=None;state='unknown'
        try:
            # A durable admission never causes an automatic second provider call.
            async def before_request():
                async with self.db.connection() as conn,conn.transaction():
                    await self.admin(conn,who);await self.current(conn,identifier,'collect',query)
            pages=await adapter.acquire(adapter.target(policy),query,before_request=before_request)
            if not isinstance(pages,list) or len(pages)>4:raise ValueError()
            payload=adapter.project(pages,query);state='observed'
        except HTTPException:
            state='retained_unavailable'
        except Exception as exc:  # noqa: BLE001 -- raw source failures must not expose credentials or retry IO
            body=getattr(exc,'raw',None)
            if isinstance(body,bytes):pages.append({'kind':'failure','raw':body,'status':getattr(exc,'status',None),'complete':getattr(exc,'complete',False)})
            state='unknown'
        # Archive received evidence independently of subsequent actor revocation.
        originals=[]
        async with self.db.connection() as conn,conn.transaction():
            await self.request_lock(conn,rid)
            admitted=await (await conn.execute('SELECT * FROM public_reference_admissions WHERE request_id=%s',(rid,))).fetchone()
            database=await (await conn.execute('SELECT instance_id FROM alcor_instance WHERE singleton')).fetchone()
            if not admitted or str(admitted['origin_instance'])!=str(self.db.settings.instance_id) or not database or str(database['instance_id'])!=str(self.db.settings.instance_id):
                raise HTTPException(503,'公开资料采集实例已变化，需核对原请求')
            if len(pages)>4 or sum(len(page.get('raw',b'')) for page in pages)>32*1024*1024:raise HTTPException(503,'公开资料原件超出保存预算')
            for index,page in enumerate(pages):
                body=page['raw'];page_id=uuid4()
                if not isinstance(body,bytes) or len(body)>16*1024*1024 or not isinstance(page['kind'],str) or not 1<=len(page['kind'])<=80 or type(page['complete']) is not bool:raise HTTPException(503,'公开资料原件元数据无法核对')
                await conn.execute('INSERT INTO public_reference_pages(id,request_id,page_number,kind,raw_bytes,raw_sha256,http_status,complete) VALUES(%s,%s,%s,%s,%s,%s,%s,%s)',(page_id,rid,index,page['kind'],body,sha256(body).hexdigest(),page.get('status'),page['complete']))
                originals.append(str(page_id))
        async with self.db.connection() as conn,conn.transaction():
            current=True
            try:
                await self.admin(conn,who);await self.current(conn,identifier,'collect',query)
            except HTTPException:current=False
            await self.request_lock(conn,rid)
            final_state=state if current else 'retained_unavailable'
            if current and state=='observed':
                if not pages or any(not page['complete'] or page.get('status')!=200 for page in pages):
                    final_state='unavailable'
                else:
                    await conn.execute('INSERT INTO public_reference_captures(request_id,license_id,query,scope,payload) VALUES(%s,%s,%s,%s,%s)',(rid,identifier,Jsonb(query),Jsonb(scope),Jsonb(payload)))
            return await self.save(conn,who,rid,hashed,{'requestId':str(rid),'state':final_state,'kind':policy.kind,'originalIds':originals,'willRetryAutomatically':False})

    async def receipt(self,who,rid):
        rid=UUID(str(rid))
        async with self.db.connection() as conn,conn.transaction():
            await self.admin(conn,who)
            for table in ('public_reference_receipts','public_reference_admissions'):
                row=await (await conn.execute('SELECT * FROM '+table+' WHERE request_id=%s AND created_by=%s',(rid,who.id))).fetchone()
                if row:return row.get('result') or {'requestId':str(rid),'state':'unknown','willRetryAutomatically':False}
        raise HTTPException(404,'公开资料原请求不存在')

    async def original(self,who,identifier,password,code=''):
        async with self.db.connection() as conn,conn.transaction():
            await self.admin(conn,who)
            await NotificationSecurity(self.db).passkeys.step_up(conn,who,password,code)
            page=await (await conn.execute('SELECT p.* FROM public_reference_pages p JOIN public_reference_admissions a ON a.request_id=p.request_id WHERE p.id=%s AND a.origin_instance=%s',(UUID(str(identifier)),str(self.db.settings.instance_id)))).fetchone()
            if not page:raise HTTPException(404,'公开资料采集原件不存在')
            body=bytes(page['raw_bytes'])
            if sha256(body).hexdigest()!=page['raw_sha256']:raise HTTPException(503,'公开资料采集原件校验失败')
            return body

    async def read(self,kind,raw):
        if kind not in self.adapters:raise HTTPException(503,'公开资料用途尚未安装')
        adapter=self.adapters[kind];query=adapter.normalize(raw,collect=False);scope=adapter.scope(query)
        async with self.db.connection() as conn,conn.transaction():
            licenses=await (await conn.execute('SELECT id,policy_id FROM public_reference_licenses ORDER BY id LIMIT 101')).fetchall()
            if len(licenses)>100:raise HTTPException(503,'公开资料许可超过读取预算')
            choices=[]
            for row in licenses:
                try:
                    if self.policy(row['policy_id']).kind!=kind:continue
                    _,policy=await self.current(conn,row['id'],'display',query)
                    if policy.kind==kind:choices.append((row['id'],policy))
                except HTTPException as error:
                    if error.status_code not in (403,404,503):raise
            if not choices:raise HTTPException(503,'公开资料独立展示许可尚未配置或已失效')
            if len(choices)!=1:raise HTTPException(409,'该公开资料范围有多个独立来源，请核对实例许可')
            identifier,policy=choices[0]
            captures=await (await conn.execute('SELECT * FROM public_reference_captures WHERE license_id=%s AND scope=%s::jsonb ORDER BY observed_at,request_id LIMIT 2003',(identifier,Jsonb(scope)))).fetchall()
            if len(captures)>2002:raise HTTPException(503,'公开资料观察超过分页预算')
            observations=[];total=0
            for capture in captures:
                await self.current(conn,identifier,'display',capture['query'])
                admission=await (await conn.execute('SELECT * FROM public_reference_admissions WHERE request_id=%s',(capture['request_id'],))).fetchone()
                pages=await (await conn.execute('SELECT * FROM public_reference_pages WHERE request_id=%s ORDER BY page_number LIMIT 5',(capture['request_id'],))).fetchall()
                try:
                    if (not admission or admission['license_id']!=identifier or admission['query']!=capture['query'] or admission['scope']!=scope
                            or str(admission['origin_instance'])!=str(self.db.settings.instance_id) or not 1<=len(pages)<=4):raise ValueError()
                    restored=[]
                    for page in pages:
                        body=bytes(page['raw_bytes']);total+=len(body)
                        if total>64*1024*1024 or not page['complete'] or page['http_status']!=200 or sha256(body).hexdigest()!=page['raw_sha256']:raise ValueError()
                        restored.append({'kind':page['kind'],'raw':body,'status':page['http_status'],'complete':page['complete']})
                    projected=adapter.project(restored,capture['query'])
                    if digest(projected)!=digest(capture['payload']):raise ValueError()
                except (ValueError,TypeError,KeyError,UnicodeError,OverflowError,RecursionError):raise HTTPException(503,'公开资料观察与保留原件无法核对') from None
                observations.append({'query':capture['query'],'payload':projected,'observedAt':capture['observed_at'].isoformat(),'licenseRevision':policy.license_revision})
            if not observations:raise HTTPException(503,'公开资料尚无已采集观察')
            return adapter.combine(observations,query)
