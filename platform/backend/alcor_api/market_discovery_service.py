"""Durable owner-licensed discovery captures; GET never collects or ranks a private subset."""

from contextlib import asynccontextmanager
from datetime import UTC, datetime
from hashlib import sha256
from uuid import UUID, uuid4

import httpcore
from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .fx_reference import external_delivery_blocked
from .market_discovery_protocol import VERSION, digest, iso, parse, purpose, query
from .market_discovery_transport import PageFailure, Transport
from .market_quote_reads import BatchQuotes
from .security import digest as token_digest
from .security import lock_mutation_identity


class Discovery:
    def __init__(self,authority,targets=(),transport=None):
        self.authority,self.db=authority,authority.db
        self.targets=tuple(targets)
        self.transport=transport or Transport()

    @asynccontextmanager
    async def context(self,who):
        async with self.db.connection() as conn,conn.transaction():
            await conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',('market-discovery:'+who.id,))
            await lock_mutation_identity(conn,who,require_admin=False)
            user=await (await conn.execute('SELECT role FROM users WHERE id=%s',(who.id,))).fetchone()
            if not user or user['role']!=who.role:raise HTTPException(403,'账号权限已变化')
            yield conn

    def target(self,policy,value):
        found=[target for target in self.targets if target.id==policy.target_id]
        markets=({'US'} if len(found)==1 and found[0].source=='cnn' else {'US','HK','CN'}) if value['kind']=='indices' else {value['market']} if value.get('market') not in (None,'ALL') else set()
        if (policy.source!='market-discovery' or policy.source_version!=VERSION or policy.fixture or purpose(value) not in policy.purposes
                or not markets<=set(policy.markets) or len(found)!=1 or found[0].fingerprint!=policy.target_fingerprint):
            raise HTTPException(503,'该发现来源、范围或许可尚未安装')
        try:found[0].request(value)
        except (ValueError,TypeError,KeyError):raise HTTPException(503,'该发现来源固定协议尚未安装') from None
        return found[0]

    def binding(self,who):
        return token_digest(':'.join((str(self.db.settings.instance_id),who.id,str(getattr(who,'grant_id',None) or who.token_hash))))

    async def collect(self,who,raw):
        if not isinstance(raw,dict) or set(raw)!={'requestId','sourceRevision','query'}:raise HTTPException(400,'采集参数无效')
        try:rid,revision=UUID(raw['requestId']),UUID(raw['sourceRevision'])
        except (ValueError,TypeError,AttributeError):raise HTTPException(400,'采集请求编号或来源无效') from None
        value=query(raw['query']);fingerprint=digest({'sourceRevision':str(revision),'query':value})
        async with self.context(who) as conn:
            prior=await (await conn.execute('SELECT * FROM market_discovery_admissions WHERE owner_id=%s AND request_id=%s',(who.id,rid))).fetchone()
            if prior:
                if prior['fingerprint']!=fingerprint:raise HTTPException(409,'原UUID已用于其他发现请求，请查询原回执')
                return await self.result(conn,who,rid)
            _,policy=await self.authority.config(conn,who.id,revision);target=self.target(policy,value)
            if await external_delivery_blocked(conn):raise HTTPException(409,'恢复隔离尚未解除，未执行外部采集')
            admitted={'requestId':str(rid),'sourceRevision':str(revision),'query':value,'state':'unknown','externalRequestAdmitted':True,'automaticRetry':False}
            await conn.execute('INSERT INTO market_discovery_admissions(owner_id,request_id,source_revision,query,fingerprint,authorization_binding,result) VALUES(%s,%s,%s,%s,%s,%s,%s)',
                (who.id,rid,revision,Jsonb(value),fingerprint,self.binding(who),Jsonb(admitted)))
        pages=[];projection=None;failure=None
        try:
            response,status,headers=await self.transport.read(target,value)
            pages.append((response,status,True,headers))
            now=self.authority.clock() if self.authority.clock else datetime.now(UTC)
            projection=parse(response,target,value,now)
            if value['kind']=='search':
                retained_items=[row for row in projection['items'] if row['market'] in policy.markets]
                projection['coverage']['excludedOutsideLicensedMarkets']=len(projection['items'])-len(retained_items)
                projection['items']=retained_items
                projection['coverage']['observedCount']=len(retained_items)
            if value.get('metric')=='amount' and 'candidates' in projection:
                projection=await self.rank_amounts(who,value,projection)
        except HTTPException:
            failure='source_or_quote_authority_changed'
        except PageFailure as exc:
            pages.append((exc.raw,exc.status,exc.complete,exc.headers));failure='source_http_or_size_failed'
        except (ValueError, TypeError, KeyError, UnicodeError, OverflowError, ArithmeticError, httpcore.NetworkError, httpcore.TimeoutException, TimeoutError):
            failure='source_response_unavailable_or_invalid'
        # Finalizing a capture does not replay the network after an authorization
        # change. Keep its admitted bytes; displaying them rechecks current source.
        async with self.db.connection() as conn,conn.transaction():
            await conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',('market-discovery:'+who.id,))
            current=True
            try:
                await lock_mutation_identity(conn,who,require_admin=False)
                _,latest=await self.authority.config(conn,who.id,revision)
                self.target(latest,value)
                current=latest.fingerprint==policy.fingerprint
            except HTTPException:current=False
            if projection is not None and value['kind']=='top':
                previous=await (await conn.execute('SELECT result FROM market_discovery_receipts WHERE owner_id=%s AND source_revision=%s AND query_hash=%s ORDER BY created_at DESC,request_id DESC LIMIT 1',
                    (who.id,revision,digest(value)))).fetchone()
                prior_items=((previous['result'].get('projection') or {}).get('items',[]) if previous else [])
                ranks={(row.get('market'),row.get('type','stock'),row['code'].upper()):index+1 for index,row in enumerate(prior_items)}
                for index,row in enumerate(projection['items']):
                    rank=ranks.get((row.get('market'),row.get('type','stock'),row['code'].upper()))
                    row['rankChange']=rank-index-1 if rank is not None else None
            originals=[]
            for number,(body,status,complete,headers) in enumerate(pages):
                identifier=uuid4();sha=sha256(body).hexdigest()
                await conn.execute('''INSERT INTO market_discovery_pages(owner_id,request_id,id,page_number,role,http_status,raw_bytes,raw_sha256,complete,representation,response_headers)
                    VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,'http_response_body',%s)''',(who.id,rid,identifier,number,purpose(value),status,body,sha,complete,Jsonb(headers)))
                originals.append({'id':str(identifier),'sha256':sha,'complete':complete,'path':'/api/market/discovery/originals/'+str(identifier)+'?source_revision='+str(revision)})
            result={**admitted,'state':'retained_unavailable' if not current else 'observed' if projection is not None and failure is None else 'unavailable',
                    'licenseRevision':policy.license_revision,'source':target.source,'sourceVersion':VERSION,
                    'projection':projection,'originals':originals,'failure':failure,'observedAt':iso(datetime.now(UTC)),
                    'revision':digest({'requestId':str(rid),'originals':originals,'projection':projection})}
            await conn.execute('''INSERT INTO market_discovery_receipts(owner_id,request_id,source_revision,license_revision,policy_fingerprint,query,query_hash,result)
                VALUES(%s,%s,%s,%s,%s,%s,%s,%s)''',(who.id,rid,revision,policy.license_revision,policy.fingerprint,Jsonb(value),digest(value),Jsonb(result)))
            return result if current else {**admitted,'state':'retained_unavailable','originalsRetained':True}

    async def rank_amounts(self,who,value,projection):
        from decimal import Decimal
        candidates=projection.pop('candidates');selected=candidates[:72]
        quotes=await BatchQuotes(self.authority).read(who,[{'id':row['code'],'market':value['market'],'code':row['code']} for row in selected])
        accepted=[];unresolved=[];references=[];exact={}
        async with self.context(who) as conn:
            for row in selected:
                state=quotes['quoteStates'].get(row['code'],{});fact=None
                if state.get('factId'):
                    _,policy=await self.authority.config(conn,who.id,state['sourceRevision'])
                    if policy.license_revision!=state['licenseRevision']:raise HTTPException(403,'成交额报价许可已变化')
                    fact=await (await conn.execute('SELECT contents,source_time FROM market_facts WHERE owner_id=%s AND id=%s',(who.id,UUID(state['factId'])))).fetchone()
                if not fact or fact['contents'].get('amount') is None or fact['contents'].get('price') is None:
                    unresolved.append(row);continue
                data=fact['contents'];amount=Decimal(str(data['amount']));price=Decimal(str(data['price']));change=quotes['quotes'].get(row['code'],{}).get('changePct')
                from zoneinfo import ZoneInfo
                local=fact['source_time'].astimezone(ZoneInfo('America/New_York' if value['market']=='US' else 'Asia/Shanghai')).date().isoformat()
                if local!=projection['tradeDate'] or amount<=0 or amount>Decimal(row['upper']) or price<=0 or change is None:
                    unresolved.append(row);continue
                # Canonical Futu turnover is already original currency units;
                # Tencent's legacy 10,000-CNY unit must never be inferred here.
                if data.get('source') not in ('futu','yahoo') or data.get('currency')!=projection['currency']:
                    unresolved.append(row);continue
                accepted.append({'market':value['market'],'code':row['code'],'name':data.get('name') or row['name'],
                    'amount':float(amount),'price':float(price),'changePct':change,'time':fact['source_time'].isoformat()})
                references.append(state);exact[row['code']]=amount
        accepted.sort(key=lambda row:(-exact[row['code']],row['code']))
        outstanding=max([Decimal(row['upper']) for row in [*unresolved,*candidates[72:]]] or [Decimal(0)])
        verified=len(accepted)>=10 and exact[accepted[9]['code']]>outstanding
        projection.update(items=accepted[:10],quoteFacts=references)
        projection['coverage'].update(complete=verified,observedCount=len(accepted[:10]),scope='full_provider_universe_with_verified_exclusion_bounds',
            remainingCandidates=len(unresolved)+len(candidates[72:]),unverifiedAmountNeverSubstituted=True)
        projection['rankingVerified']=verified
        return projection

    async def validate_projection(self,conn,who,result):
        if result.get('state') != 'observed':
            return
        try:
            admission = await (await conn.execute('SELECT * FROM market_discovery_admissions WHERE owner_id=%s AND request_id=%s',
                (who.id,UUID(result['requestId'])))).fetchone()
            if not admission or str(admission['source_revision']) != result['sourceRevision']:
                raise ValueError()
            value = query(admission['query'])
            _,policy = await self.authority.config(conn,who.id,admission['source_revision'])
            target = self.target(policy,value)
            if (policy.license_revision != result['licenseRevision'] or result['source'] != target.source
                    or result['sourceVersion'] != VERSION):
                raise ValueError()
            pages = await (await conn.execute('SELECT * FROM market_discovery_pages WHERE owner_id=%s AND request_id=%s ORDER BY page_number LIMIT 3',
                (who.id,admission['request_id']))).fetchall()
            if len(pages) != 1 or len(result['originals']) != 1:
                raise ValueError()
            page = pages[0]
            raw = bytes(page['raw_bytes'])
            if (not page['complete'] or page['http_status'] != 200 or page['role'] != purpose(value)
                    or sha256(raw).hexdigest() != page['raw_sha256']
                    or result['originals'][0]['id'] != str(page['id'])
                    or result['originals'][0]['sha256'] != page['raw_sha256']
                    or result['originals'][0].get('complete') is not True
                    or result['originals'][0]['path'] != '/api/market/discovery/originals/'+str(page['id'])+'?source_revision='+result['sourceRevision']):
                raise ValueError()
            stored = result['projection']
            clock = datetime.fromisoformat(stored['updatedAt'])
            if clock.tzinfo is None:
                raise ValueError()
            projected = parse(raw,target,value,clock)
            if value['kind'] == 'search':
                retained = [item for item in projected['items'] if item['market'] in policy.markets]
                projected['coverage']['excludedOutsideLicensedMarkets'] = len(projected['items'])-len(retained)
                projected['items'] = retained
                projected['coverage']['observedCount'] = len(retained)
            if value['kind'] == 'top':
                for item,saved in zip(projected['items'],stored['items'],strict=True):
                    item['rankChange'] = saved.get('rankChange')
            if 'candidates' in projected:
                await self.verify_amount_projection(conn,who,value,projected,stored)
            if digest(projected) != digest(stored):
                raise ValueError()
            if result['revision'] != digest({'requestId':result['requestId'],'originals':result['originals'],'projection':stored}):
                raise ValueError()
        except (ValueError,TypeError,KeyError,OverflowError,RecursionError,UnicodeError):
            raise HTTPException(503,'发现结果与保留原件无法核对') from None

    async def verify_amount_projection(self,conn,who,value,projected,stored):
        from decimal import Decimal
        from zoneinfo import ZoneInfo

        from .market_authority import query_from
        from .market_history_evidence import verify_history_rows
        from .market_quote_reads import project
        from .market_snapshot_metrics import with_snapshot_metrics
        candidates = projected.pop('candidates')
        selected = {item['code']:item for item in candidates[:72]}
        accepted,exact,used = [],{},set()
        for reference in stored.get('quoteFacts',[]):
            _,policy = await self.authority.config(conn,who.id,reference['sourceRevision'])
            if policy.license_revision != reference['licenseRevision']:
                raise HTTPException(403,'排行引用的实际报价来源许可已变化，历史原件仍保留')
            fact = await (await conn.execute('SELECT f.*,s.query FROM market_facts f JOIN market_streams s ON s.owner_id=f.owner_id AND s.id=f.stream_id WHERE f.owner_id=%s AND f.id=%s AND f.source_revision=%s',
                (who.id,UUID(reference['factId']),UUID(reference['sourceRevision'])))).fetchone()
            if not fact:
                raise ValueError()
            security = query_from(fact['query'])
            if security.market != value['market'] or security.code not in selected or security.code in used or security.kind != 'latest':
                raise ValueError()
            if fact['sequence'] != reference['factRevision'] or fact['source_time'].isoformat() != reference['sourceTime']:
                raise ValueError()
            await verify_history_rows(conn,who.id,fact['source_revision'],[fact],policy)
            fact = await with_snapshot_metrics(conn,who,security,policy,fact,{})
            dto,_ = project(fact,policy,value['market'],fact['source_time'])
            if not dto or dto.get('changePct') is None:
                raise ValueError()
            data = fact['contents'];row = selected[security.code]
            amount,price = Decimal(str(data['amount'])),Decimal(str(data['price']))
            local = fact['source_time'].astimezone(ZoneInfo('America/New_York' if value['market']=='US' else 'Asia/Shanghai')).date().isoformat()
            if (local != projected['tradeDate'] or not 0 < amount <= Decimal(row['upper']) or price <= 0
                    or data.get('source') not in ('futu','yahoo') or data.get('currency') != projected['currency']):
                raise ValueError()
            used.add(security.code);exact[security.code] = amount
            accepted.append({'market':value['market'],'code':security.code,'name':data.get('name') or row['name'],
                'amount':float(amount),'price':float(price),'changePct':dto['changePct'],'time':fact['source_time'].isoformat()})
        accepted.sort(key=lambda item:(-exact[item['code']],item['code']))
        unresolved = [item for item in candidates[:72] if item['code'] not in used]
        outstanding = max([Decimal(item['upper']) for item in [*unresolved,*candidates[72:]]] or [Decimal(0)])
        verified = len(accepted)>=10 and exact[accepted[9]['code']]>outstanding
        projected.update(items=accepted[:10],quoteFacts=stored.get('quoteFacts',[]),rankingVerified=verified)
        projected['coverage'].update(complete=verified,observedCount=len(accepted[:10]),scope='full_provider_universe_with_verified_exclusion_bounds',
            remainingCandidates=len(unresolved)+len(candidates[72:]),unverifiedAmountNeverSubstituted=True)

    async def result(self,conn,who,rid):
        final=await (await conn.execute('SELECT result FROM market_discovery_receipts WHERE owner_id=%s AND request_id=%s',(who.id,rid))).fetchone()
        admitted=await (await conn.execute('SELECT * FROM market_discovery_admissions WHERE owner_id=%s AND request_id=%s',(who.id,rid))).fetchone()
        if not admitted:raise HTTPException(404,'未找到原请求')
        if admitted['authorization_binding']!=self.binding(who):raise HTTPException(403,'原采集属于其他连接上下文')
        await self.authority.config(conn,who.id,admitted['source_revision'])
        if final:await self.validate_projection(conn,who,final['result'])
        return final['result'] if final else admitted['result']

    async def receipt(self,who,rid):
        try:rid=UUID(str(rid))
        except ValueError:raise HTTPException(400,'请求编号无效') from None
        async with self.context(who) as conn:return await self.result(conn,who,rid)

    async def read(self,who,raw,*,source_revision=None,revision=None,limit=100,offset=0):
        value=query(raw)
        if type(limit) is not int or not 1<=limit<=100 or type(offset) is not int or not 0<=offset<=1000000 or offset and not revision:raise HTTPException(400,'发现分页或版本无效')
        try:source_revision=UUID(source_revision) if source_revision else None
        except (ValueError,TypeError):raise HTTPException(400,'来源编号无效') from None
        async with self.context(who) as conn:
            if source_revision:await self.authority.config(conn,who.id,source_revision)
            rows=await (await conn.execute('''SELECT * FROM market_discovery_receipts WHERE owner_id=%s AND query_hash=%s
                AND (%s::uuid IS NULL OR source_revision=%s) ORDER BY created_at DESC,request_id DESC LIMIT 1001''',(who.id,digest(value),source_revision,source_revision))).fetchall()
            if len(rows)>1000:raise HTTPException(409,'发现来源候选超过读取范围，请明确来源版本')
            choices={};retained=False
            for row in rows:
                try:
                    _,policy=await self.authority.config(conn,who.id,row['source_revision']);self.target(policy,value)
                    if row['license_revision']!=policy.license_revision:continue
                    await self.validate_projection(conn,who,row['result'])
                except HTTPException:retained=True;continue
                if row['result']['state']=='observed' and row['source_revision'] not in choices:choices[row['source_revision']]=row['result']
            if len(choices)>1 and value['kind']=='search':
                priority={'futu':0,'tencent':1,'eastmoney':2,'coingecko':3}
                nonempty=[entry for entry in choices.values() if entry['projection']['items']]
                candidates=nonempty or list(choices.values())
                order=min(priority.get(entry['source'],99) for entry in candidates)
                preferred=[entry for entry in candidates if priority.get(entry['source'],99)==order]
                if len(preferred)!=1:raise HTTPException(409,'同类搜索有多个许可来源，请明确来源版本')
                choices={preferred[0]['sourceRevision']:preferred[0]}
            elif len(choices)>1 and value['kind']!='indices':raise HTTPException(409,'有多个发现来源，请明确来源版本')
            if not choices:
                return {'query':value,'revision':None,'state':'retained_unavailable' if retained else 'unknown','sourceRevision':str(source_revision) if source_revision else None,
                    'licenseRevision':None,'source':None,'observedAt':None,'coverage':{'scope':'unavailable','complete':False,'providerTotal':None,'observedCount':0},
                    'items':[],'groups':[] if value['kind']=='indices' else None,'pagination':{'offset':offset,'limit':limit,'total':None,'hasMore':False},'originals':[],'automaticCollection':False}
            chosen=list(choices.values());result=chosen[0];projection=dict(result['projection'])
            if value['kind']=='indices':
                groups={};originals=[]
                for response in chosen:
                    for group in response['projection'].get('groups') or []:
                        if group['market'] in groups and groups[group['market']]['indices'] and group['indices']:raise HTTPException(409,'指数分组有多个真实来源，请明确来源版本')
                        if group['market'] not in groups or group['indices']:groups[group['market']]=group
                    originals.extend(response['originals'])
                projection['groups']=list(groups.values());result={**result,'originals':originals,'revision':digest([row['revision'] for row in chosen])}
                projection['coverage']={'scope':'declared_index_set','complete':all(group['indices'] and all(row['latest'] is not None for row in group['indices']) for group in groups.values()),'providerTotal':7,'observedCount':sum(len(group['indices']) for group in groups.values())}
            if revision and revision!=result['revision']:raise HTTPException(409,'发现结果已变化，请从第一页重读')
            items=projection.get('items',[])
            return {'query':value,'state':'observed','revision':result['revision'],'sourceRevision':result['sourceRevision'],'licenseRevision':result['licenseRevision'],
                'source':result['source'],'observedAt':result['observedAt'],**{key:item for key,item in projection.items() if key!='items'},
                'items':items[offset:offset+limit],'pagination':{'offset':offset,'limit':limit,'total':len(items),'hasMore':offset+limit<len(items)},
                'originals':result['originals'],'automaticCollection':False,'realTimePricesAssumed':False}

    async def original(self,who,page_id,source_revision):
        try:page_id,source_revision=UUID(page_id),UUID(source_revision)
        except (ValueError,TypeError):raise HTTPException(400,'原件或来源编号无效') from None
        async with self.context(who) as conn:
            await self.authority.config(conn,who.id,source_revision)
            row=await (await conn.execute('SELECT p.* FROM market_discovery_pages p JOIN market_discovery_admissions a ON a.owner_id=p.owner_id AND a.request_id=p.request_id WHERE p.owner_id=%s AND p.id=%s AND a.source_revision=%s',(who.id,page_id,source_revision))).fetchone()
            if not row:raise HTTPException(404,'原件不存在')
            raw=bytes(row['raw_bytes'])
            if sha256(raw).hexdigest()!=row['raw_sha256']:raise HTTPException(503,'原件校验失败')
            return raw,row['raw_sha256']
