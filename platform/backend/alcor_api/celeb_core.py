"""Versioned public disclosure catalogue, independent of every owner's financial book."""

import hashlib
import json
import math
import re
from decimal import Decimal
from urllib.parse import parse_qs, urlsplit
from uuid import UUID

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .market_contract import canonical
from .security import lock_mutation_identity

FIELDS={'id','name','title','avatar','enabled','sort','sourceKind','cik','entity','sourceLabel','holdings','trades','returns','stockIcons','refreshHours','reportDate','reportQuarter','sourceUrl','sourceEvidence'}
UNKNOWN_RETURNS={'y1':None,'y3':None,'y5':None,'spxY1':None,'points':[],'spxPoints':[],'benchmarks':[]}


def input_bytes(value):
    def exact(item):
        if type(item) is float:
            if not math.isfinite(item):raise ValueError('nonfinite_input')
            return Decimal(str(item))
        if isinstance(item,list):return [exact(child) for child in item]
        if isinstance(item,dict):return {key:exact(child) for key,child in item.items()}
        return item
    return canonical(exact(value)).encode()


def identifier(value):
    if not isinstance(value,str) or not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,39}',value):raise HTTPException(400,'名人编号无效')
    return value


def text(value,limit,*,empty=True):
    if not isinstance(value,str) or len(value.encode('utf-16-le'))//2>limit or re.search(r'[\x00-\x1f\x7f]',value) or not empty and not value.strip():raise HTTPException(422,'目录文字无效')
    return value.strip()


def number(value,*,signed=False):
    if value is None:return None
    if type(value) not in (str,int,float,Decimal) or isinstance(value,float) and not math.isfinite(value):raise HTTPException(422,'披露数值无效')
    try:
        result=Decimal(str(value))
        if not result.is_finite() or abs(result)>Decimal('1e30') or not signed and result<0 or len(format(result,'f'))>120:raise ValueError()
        return format(result,'f')
    except (ValueError,ArithmeticError):raise HTTPException(422,'披露数值无效') from None


def day(value):
    if value is None:return None
    from datetime import date
    try:
        if not isinstance(value,str) or date.fromisoformat(value).isoformat()!=value:raise ValueError()
        return value
    except (ValueError,TypeError):raise HTTPException(422,'披露日期无效') from None


async def asset_reference(conn,value):
    if value=='':return ''
    if not isinstance(value,str) or len(value)>2048:raise HTTPException(422,'素材引用无效')
    parsed=urlsplit(value);params=parse_qs(parsed.query,keep_blank_values=True)
    if parsed.scheme or parsed.netloc or parsed.fragment or '..' in parsed.path or set(params)-{'sha256'} or not re.fullmatch(r'/uploads/(?:ico|background|logo|login|asset)/[A-Za-z0-9._/-]+',parsed.path):raise HTTPException(409,'图片须先登记为平台公开素材')
    sha=params.get('sha256',[None])
    if len(sha)!=1 or sha[0] is not None and not re.fullmatch(r'[a-f0-9]{64}',sha[0]):raise HTTPException(422,'素材版本无效')
    if sha[0]:row=await(await conn.execute('SELECT served_sha256 FROM system_asset_versions WHERE public_path=%s AND served_sha256=%s LIMIT 1',(parsed.path,sha[0]))).fetchone()
    else:row=await(await conn.execute('SELECT v.served_sha256 FROM system_asset_paths p JOIN system_asset_versions v ON v.id=p.current_version WHERE p.public_path=%s',(parsed.path,))).fetchone()
    if not row:raise HTTPException(409,'公开图片原件尚未登记')
    return parsed.path+'?sha256='+row['served_sha256']


def holding(raw):
    if not isinstance(raw,dict) or set(raw)-{'code','name','market','weight','weightDelta','isNew','marketCap','price','changePct','target','quantity','qty','cost','currency','asOf','cusip','issuer','value','shares','putCall','valueReported','valueUnit','sharesType','securityType','reportedValueCurrency'}:raise HTTPException(422,'持仓披露字段无效')
    result={'code':text(raw.get('code') or '',40),'name':text(raw.get('name',''),200)}
    if not result['code'] and not raw.get('cusip'):raise HTTPException(422,'披露证券标识缺失')
    for key in ('weight','weightDelta','marketCap','price','changePct','target','quantity','qty','cost','value','shares','valueReported'):
        result[key]=number(raw.get(key),signed=key in ('weightDelta','changePct'))
    for key in ('market','currency','cusip','issuer','putCall','valueUnit','sharesType','securityType','reportedValueCurrency'):
        result[key]=text(raw[key],100) if raw.get(key) is not None else None
    result['asOf']=day(raw.get('asOf'))
    if 'isNew' in raw:
        if type(raw['isNew']) is not bool:raise HTTPException(422,'新进披露状态无效')
        result['isNew']=raw['isNew']
    return result


def trade(raw):
    if not isinstance(raw,dict) or set(raw)-{'code','name','market','changePct','action','quantity','price','cost','amount','currency','date','asOf','sourceUrl'}:raise HTTPException(422,'公开操作披露字段无效')
    result={key:text(raw.get(key,''),200) for key in ('code','name','action')}
    for key in ('quantity','price','cost','amount','changePct'):result[key]=number(raw.get(key),signed=key=='changePct')
    for key in ('market','currency','sourceUrl'):result[key]=text(raw[key],2048) if raw.get(key) is not None else None
    result['date']=day(raw.get('date'));result['asOf']=day(raw.get('asOf'))
    return result


def returns_value(raw):
    if raw is None:return dict(UNKNOWN_RETURNS)
    if not isinstance(raw,dict) or set(raw)-{'y1','y3','y5','spxY1','points','spxPoints','benchmarks','dates','values','source','sourceUrl','sourcePageId','observedAt','synthetic','currency','startBasis'}:raise HTTPException(422,'收益披露字段无效')
    result={key:number(raw.get(key),signed=True) for key in ('y1','y3','y5','spxY1')}
    for key in ('points','spxPoints','values'):
        if key in raw:
            if not isinstance(raw[key],list) or len(raw[key])>10000:raise HTTPException(422,'披露观察点过多')
            result[key]=[number(value,signed=True) for value in raw[key]]
        elif key!='values':result[key]=[]
    if 'dates' in raw:
        if not isinstance(raw['dates'],list) or len(raw['dates'])>10000:raise HTTPException(422,'披露日期过多')
        result['dates']=[day(value) for value in raw['dates']]
        if any(value is None for value in result['dates']) or result['dates']!=sorted(set(result['dates'])):raise HTTPException(422,'披露日期须真实且严格递增')
        if 'values' not in result or len(result['dates'])!=len(result['values']):raise HTTPException(422,'披露日期和值须逐点对应')
    benchmarks=raw.get('benchmarks',[])
    if not isinstance(benchmarks,list) or len(benchmarks)>20:raise HTTPException(422,'基准披露过多')
    result['benchmarks']=[]
    for benchmark in benchmarks:
        if not isinstance(benchmark,dict) or set(benchmark)-{'code','name','y1','points','values','source','sourceUrl'}:raise HTTPException(422,'基准披露无效')
        entry={'code':text(benchmark.get('code',''),40),'name':text(benchmark.get('name',''),100),'y1':number(benchmark.get('y1'),signed=True)}
        for key in ('points','values'):
            if key in benchmark:
                if not isinstance(benchmark[key],list) or len(benchmark[key])>10000:raise HTTPException(422,'基准观察点过多')
                entry[key]=[number(value,signed=True) for value in benchmark[key]]
        for key in ('source','sourceUrl'):
            if key in benchmark:entry[key]=text(benchmark[key],2048)
        result['benchmarks'].append(entry)
    if 'synthetic' in raw:
        if type(raw['synthetic']) is not bool:raise HTTPException(422,'合成声明无效')
        result['synthetic']=raw['synthetic']
    for key in ('source','sourceUrl','sourcePageId','observedAt','currency','startBasis'):
        if key in raw:result[key]=text(raw[key],2048)
    return result


async def normalized(conn,raw,current=None):
    if not isinstance(raw,dict) or set(raw)-FIELDS:raise HTTPException(422,'名人目录字段无效')
    value=dict(current) if current else {'title':'','avatar':'','enabled':True,'sort':0,'sourceKind':'none','cik':'','entity':'','sourceLabel':'','holdings':[],'trades':[],'returns':dict(UNKNOWN_RETURNS),'stockIcons':{},'refreshHours':0,'reportDate':None,'reportQuarter':None,'sourceUrl':None,'sourceEvidence':None}
    value.update(raw)
    value['id']=identifier(value.get('id'));value['name']=text(value.get('name'),50,empty=False)
    for key,limit in (('title',100),('cik',20),('entity',100),('sourceLabel',100)):value[key]=text(value[key],limit)
    if value['cik'] and not re.fullmatch(r'[0-9]{10}',value['cik']):raise HTTPException(422,'CIK需为10位数字')
    if value['sourceKind'] not in ('none','13f','form4'):raise HTTPException(422,'公开披露来源类型无效')
    if type(value['enabled']) is not bool or type(value['sort']) is not int or not -2147483648<=value['sort']<=2147483647:raise HTTPException(422,'启停或排序无效')
    if isinstance(value['refreshHours'],Decimal) and value['refreshHours'].is_finite():value['refreshHours']=float(value['refreshHours'])
    if type(value['refreshHours']) not in (int,float) or not math.isfinite(value['refreshHours']) or not 0<=value['refreshHours']<=8760:raise HTTPException(422,'来源有效期无效')
    value['avatar']=await asset_reference(conn,value['avatar'])
    if not isinstance(value['stockIcons'],dict) or len(value['stockIcons'])>2000:raise HTTPException(422,'股票图标映射过多')
    value['stockIcons']={text(key,40,empty=False):await asset_reference(conn,url) for key,url in value['stockIcons'].items()}
    for key,convert in (('holdings',holding),('trades',trade)):
        if not isinstance(value[key],list) or len(value[key])>2000:raise HTTPException(422,'公开持仓或操作过多')
        value[key]=[convert(row) for row in value[key]]
    value['returns']=returns_value(value['returns']);value['reportDate']=day(value['reportDate'])
    if value['reportQuarter'] is not None and not re.fullmatch(r'[0-9]{4}Q[1-4]',value['reportQuarter']):raise HTTPException(422,'报告季度无效')
    if value['sourceUrl'] is not None:
        from .feed_parse import public_url
        if not public_url(value['sourceUrl']):raise HTTPException(422,'披露来源须为公开HTTPS地址')
    if value.get('sourceEvidence') is not None and (not isinstance(value['sourceEvidence'],dict) or len(input_bytes(value['sourceEvidence']))>262144):raise HTTPException(422,'披露来源证据无效')
    if value.get('sourceEvidence') is not None:value['sourceEvidence']=json.loads(input_bytes(value['sourceEvidence']),parse_float=str)
    return value


async def latest_on_connection(conn,celeb_id,public=True):
    identifier(celeb_id)
    row=await(await conn.execute('SELECT r.*,h.sort,h.deleted_at,h.created_at AS registered_at FROM celeb_heads h JOIN celeb_revisions r ON r.celeb_id=h.id AND r.revision=h.revision WHERE h.id=%s AND h.deleted_at IS NULL',(celeb_id,))).fetchone()
    if not row or public and row['payload'].get('enabled') is not True:raise HTTPException(404,'名人不存在')
    return row


def projection(row):
    payload={**row['payload'],'sort':row['sort']};source=row['source_kind']
    payload.update(revision=row['revision'],createdAt=row['registered_at'].isoformat(),updatedAt=row['created_at'].isoformat(),dataSource=source,
                   dataAuthority='example_data' if source=='sample' else 'verified_disclosure_original' if row['source_page_id'] else 'administrator_registered_disclosure',
                   positionAuthority='public_disclosure_not_owner_account',gain250=None)
    payload.pop('sourceEvidence',None)
    detail={'reportedSourceEvidence':row['payload'].get('sourceEvidence'),'revision':row['revision'],'sourceEvidence':{'sourceKind':source,'sourcePageId':row['source_page_id'],'sourceRevision':row['source_revision'],'originalInputSha256':row['input_sha256'],'inputRepresentation':'canonical_json_not_original_wire'},
            'reportedHoldings':row['payload']['holdings'],'reportedTrades':row['payload']['trades'],'reportedReturns':row['payload']['returns'],
            'performanceState':'dated_disclosed_observations' if row['payload']['returns'].get('dates') else 'unknown_no_verified_dated_performance',
            'ownerFinancialWrites':False,'returnEvidenceAuthority':'separate_reported_declaration_not_inferred_from_holdings'}
    # Input summaries are evidence, never an actual-return curve or a verified person's PnL.
    payload['returns']={**UNKNOWN_RETURNS,'authority':'unverified_summary_only','datedObservationsAvailable':bool(row['payload']['returns'].get('dates'))}
    return payload,detail


async def public_projection(conn,row):
    from .celeb_evidence import source_integrity
    value,detail=projection(row)
    integrity=await source_integrity(conn,row)
    detail['sourceIntegrity']=integrity
    if integrity['state']=='retained_unavailable':
        value['dataAuthority']='registered_disclosure_source_retained_unavailable'
        detail['sourceEvidence']['integrityState']='retained_unavailable'
    return value,detail


class Celebs:
    def __init__(self,db):self.db=db

    async def list(self,public=True):
        async with self.db.connection() as conn,conn.transaction():
            await conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
            return await self.list_on_connection(conn,public=public)

    async def list_on_connection(self,conn,public=True):
        scope=await(await conn.execute('SELECT revision FROM celeb_scope WHERE singleton')).fetchone()
        rows=await(await conn.execute('SELECT r.*,h.sort,h.deleted_at,h.created_at AS registered_at FROM celeb_heads h JOIN celeb_revisions r ON r.celeb_id=h.id AND r.revision=h.revision WHERE h.deleted_at IS NULL ORDER BY h.sort,r.created_at,h.id LIMIT 501')).fetchall()
        if len(rows)>500:raise HTTPException(409,'公开人物目录超出完整读取预算')
        rows=[row for row in rows if not public or row['payload'].get('enabled') is True]
        celebs=[];details={}
        for row in rows:
            celeb,detail=await public_projection(conn,row);celebs.append(celeb);details[celeb['id']]=detail
        return {'celebs':celebs,'detail':details,'source':'stored_public_disclosures','scopeRevision':scope['revision'],
                'updatedAt':max((row['created_at'].isoformat() for row in rows),default=None),'collectionOnRead':False,'sampleSeeded':False}

    async def detail(self,celeb_id,public=True):
        async with self.db.connection() as conn,conn.transaction():
            row=await latest_on_connection(conn,celeb_id,public)
            celeb,detail=await public_projection(conn,row)
            return {'celeb':celeb,'detail':detail,'source':row['source_kind']}

    async def manage(self,who):
        async with self.db.connection() as conn,conn.transaction():
            await conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
            await lock_mutation_identity(conn,who)
            result=await self.list_on_connection(conn,public=False)
            rows=await(await conn.execute('SELECT r.*,h.sort,h.created_at AS registered_at FROM celeb_heads h JOIN celeb_revisions r ON r.celeb_id=h.id AND r.revision=h.revision WHERE h.deleted_at IS NULL ORDER BY h.sort,h.id LIMIT 501')).fetchall()
            result['celebs']=[{**row['payload'],'sort':row['sort'],'revision':row['revision'],'createdAt':row['registered_at'].isoformat(),'updatedAt':row['created_at'].isoformat(),'dataAuthority':'registered_input_not_verified_performance'} for row in rows]
            return result

    async def receipt(self,who,request_id):
        try:request_id=str(UUID(request_id))
        except (ValueError,TypeError):raise HTTPException(400,'请求编号无效') from None
        async with self.db.connection() as conn,conn.transaction():
            await lock_mutation_identity(conn,who)
            row=await(await conn.execute('SELECT result FROM celeb_operations WHERE actor_id=%s AND request_id=%s',(who.id,request_id))).fetchone()
            if not row:raise HTTPException(404,'原操作回执尚未找到')
            return row['result']

    async def mutate(self,who,request_id,action,raw,expected_revision=None):
        try:request_id=str(UUID(request_id))
        except (ValueError,TypeError):raise HTTPException(400,'请求编号无效') from None
        if not isinstance(raw,dict):raise HTTPException(422,'目录修改无效')
        if expected_revision is not None and (type(expected_revision) is not int or not 0<=expected_revision<=9007199254740991):raise HTTPException(422,'当前版本无效')
        try:
            request={'action':action,'raw':raw,'expectedRevision':expected_revision}
            encoded=input_bytes(request)
            if len(encoded)>1024*1024:raise HTTPException(413,'目录输入过长')
            hashed=hashlib.sha256(encoded).hexdigest()
        except (TypeError,ValueError,UnicodeError):raise HTTPException(422,'目录输入无效') from None
        async with self.db.connection() as conn,conn.transaction():
            await lock_mutation_identity(conn,who)
            await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended('celeb-catalogue',0))")
            scope=await(await conn.execute('SELECT revision FROM celeb_scope WHERE singleton FOR UPDATE')).fetchone()
            prior=await(await conn.execute('SELECT fingerprint,result FROM celeb_operations WHERE actor_id=%s AND request_id=%s',(who.id,request_id))).fetchone()
            if prior:
                if prior['fingerprint']!=hashed:raise HTTPException(409,'原请求编号已用于其他修改')
                return prior['result']
            if action=='reorder':
                if set(raw)!={'reorder'} or not isinstance(raw['reorder'],list) or not raw['reorder'] or len(raw['reorder'])>500 or any(not isinstance(item,str) for item in raw['reorder']) or len(set(raw['reorder']))!=len(raw['reorder']):raise HTTPException(422,'排序编号无效')
                if expected_revision is not None and scope['revision']!=expected_revision:raise HTTPException(409,'名人目录已变化')
                ordered=[identifier(value) for value in raw['reorder']]
                rows=await(await conn.execute('SELECT id FROM celeb_heads WHERE deleted_at IS NULL ORDER BY sort,id LIMIT 501')).fetchall()
                if len(rows)>500 or not set(ordered)<={row['id'] for row in rows}:raise HTTPException(409,'排序目标已变化')
                # Partial old reorder is explicit; retain other current IDs after it, without collisions.
                ordered.extend(row['id'] for row in rows if row['id'] not in ordered)
                for index,celeb_id in enumerate(ordered):
                    current=await latest_on_connection(conn,celeb_id,False)
                    payload={**current['payload'],'sort':index}
                    await self._revision(conn,who,request_id,payload,raw,current,source_kind=current['source_kind'],source_page_id=current['source_page_id'],source_revision=current['source_revision'])
                outcome={'ok':True,'reorder':ordered}
            elif action in ('create','update','delete'):
                celeb_id=identifier(raw.get('id'))
                head=await(await conn.execute('SELECT * FROM celeb_heads WHERE id=%s FOR UPDATE',(celeb_id,))).fetchone()
                if action=='create':
                    if celeb_id in {'manage','returns','sources','operations','avatar','stock-icon'}:raise HTTPException(422,'人物编号与管理路径冲突')
                    if head:raise HTTPException(409,'名人编号已存在或已留存删除历史')
                    if expected_revision not in (None,0):raise HTTPException(409,'创建版本无效')
                    count=await(await conn.execute('SELECT count(*) AS n FROM celeb_heads WHERE deleted_at IS NULL')).fetchone()
                    if count['n']>=500:raise HTTPException(409,'名人目录已达当前容量')
                    content=dict(raw)
                    if 'sort' not in content:
                        maximum=await(await conn.execute('SELECT max(sort) AS n FROM celeb_heads WHERE deleted_at IS NULL')).fetchone()
                        content['sort']=maximum['n']+1 if maximum['n'] is not None else 0
                    payload=await normalized(conn,content)
                    revision=await self._revision(conn,who,request_id,payload,raw)
                    row=await latest_on_connection(conn,celeb_id,False);celeb,detail=projection(row)
                    outcome={'celeb':celeb,'detail':detail,'revision':revision}
                else:
                    if not head or head['deleted_at'] is not None:raise HTTPException(404,'名人不存在')
                    if expected_revision is not None and head['revision']!=expected_revision:raise HTTPException(409,'名人资料已变化')
                    current=await latest_on_connection(conn,celeb_id,False)
                    if action=='delete':
                        if set(raw)!={'id'}:raise HTTPException(422,'删除参数无效')
                        await self._revision(conn,who,request_id,current['payload'],raw,current,source_kind=current['source_kind'],source_page_id=current['source_page_id'],source_revision=current['source_revision'])
                        await conn.execute('UPDATE celeb_heads SET deleted_at=clock_timestamp() WHERE id=%s',(celeb_id,))
                        outcome={'ok':True,'id':celeb_id,'deleted':True,'historyRetained':True}
                    else:
                        payload=await normalized(conn,raw,current['payload'])
                        changed=bool(set(raw)&{'holdings','trades','returns','sourceKind','cik','entity','reportDate','sourceUrl'})
                        await self._revision(conn,who,request_id,payload,raw,current,source_kind=None if changed else current['source_kind'],source_page_id=None if changed else current['source_page_id'],source_revision=None if changed else current['source_revision'])
                        row=await latest_on_connection(conn,celeb_id,False);celeb,detail=projection(row)
                        outcome={'celeb':celeb,'detail':detail,'revision':row['revision']}
            else:raise HTTPException(404,'目录操作不存在')
            await conn.execute('UPDATE celeb_scope SET revision=revision+1 WHERE singleton')
            result={'requestId':request_id,'state':'completed','result':outcome,'scopeRevision':scope['revision']+1,'financialWrites':False}
            await conn.execute('INSERT INTO celeb_operations(actor_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)',(who.id,request_id,hashed,Jsonb(result)))
            await conn.execute("INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,%s,%s,%s)",(who.id,'celebs.'+action,raw.get('id','catalogue'),request_id))
            return result

    async def _revision(self,conn,who,request_id,payload,raw,current=None,*,source_kind=None,source_page_id=None,source_revision=None):
        number=current['revision']+1 if current else 1
        authority=source_kind or 'registered_public_disclosure'
        source=input_bytes(raw)
        await conn.execute('INSERT INTO celeb_heads(id,revision,sort) VALUES(%s,%s,%s) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,sort=excluded.sort',(payload['id'],number,payload['sort']))
        await conn.execute('''INSERT INTO celeb_revisions(celeb_id,revision,payload,raw_input,raw_bytes,input_sha256,actor_id,request_id,source_kind,source_page_id,source_revision)
         VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''',
         (payload['id'],number,Jsonb(payload),Jsonb(json.loads(source)),source,hashlib.sha256(source).hexdigest(),who.id,request_id,authority,source_page_id,source_revision))
        return number

    async def set_media_on_connection(self,conn,who,celeb_id,revision,kind,key,public_path,request_id):
        from .market_worker import Bound
        current=await latest_on_connection(conn,celeb_id,False)
        if kind=='avatar':patch={'id':celeb_id,'avatar':public_path}
        elif kind=='stock-icon':patch={'id':celeb_id,'stockIcons':{**current['payload']['stockIcons'],text(key,40,empty=False):public_path}}
        else:raise HTTPException(422,'目录素材类型无效')
        return await Celebs(Bound(conn,self.db.settings)).mutate(who,request_id,'update',patch,expected_revision=revision)

    async def ingest_on_connection(self,conn,who,celeb_id,expected_revision,payload,*,source_revision,source_page_id,request_id):
        """Trusted source worker has retained/verified its page and current installation first."""
        try:request_id=str(UUID(request_id));source_page_id=str(UUID(source_page_id))
        except (TypeError,ValueError):raise HTTPException(422,'披露原件或操作编号无效') from None
        if not isinstance(source_revision,str) or not 1<=len(source_revision)<=200 or type(expected_revision) is not int:raise HTTPException(422,'披露来源版本无效')
        if not isinstance(payload,dict) or set(payload)-{'holdings','trades','sourceEvidence','reportDate','reportQuarter','sourceUrl'}:raise HTTPException(422,'披露采集字段无效')
        await lock_mutation_identity(conn,who)
        await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended('celeb-catalogue',0))")
        scope=await(await conn.execute('SELECT revision FROM celeb_scope WHERE singleton FOR UPDATE')).fetchone()
        command={'action':'source.ingest','id':celeb_id,'revision':expected_revision,'payload':payload,'sourceRevision':source_revision,'sourcePageId':source_page_id}
        hashed=hashlib.sha256(input_bytes(command)).hexdigest()
        prior=await(await conn.execute('SELECT fingerprint,result FROM celeb_operations WHERE actor_id=%s AND request_id=%s',(who.id,request_id))).fetchone()
        if prior:
            if prior['fingerprint']!=hashed:raise HTTPException(409,'披露操作编号已使用')
            return prior['result']
        current=await latest_on_connection(conn,celeb_id,False)
        if current['revision']!=expected_revision:raise HTTPException(409,'名人来源或资料已变化，旧任务不得覆盖')
        if current['payload']['sourceKind'] not in ('13f','form4'):raise HTTPException(409,'此人物尚未配置真实披露来源')
        merged=await normalized(conn,{'id':celeb_id,**payload},current['payload'])
        source_kind='sec13f' if merged['sourceKind']=='13f' else 'secform4'
        revision=await self._revision(conn,who,request_id,merged,command,current,source_kind=source_kind,source_page_id=source_page_id,source_revision=source_revision)
        await conn.execute('UPDATE celeb_scope SET revision=revision+1 WHERE singleton')
        row=await latest_on_connection(conn,celeb_id,False);celeb,detail=projection(row)
        result={'requestId':request_id,'state':'completed','revision':revision,'scopeRevision':scope['revision']+1,'result':{'celeb':celeb,'detail':detail},'financialWrites':False}
        await conn.execute('INSERT INTO celeb_operations(actor_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)',(who.id,request_id,hashed,Jsonb(result)))
        await conn.execute("INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'celebs.source.ingest',%s,%s)",(who.id,celeb_id,request_id))
        return result
