"""Explicit legacy URL references over existing byte authorities; no disk discovery."""

import hashlib
import json
import math
import re
from decimal import Decimal, InvalidOperation
from fractions import Fraction
from uuid import UUID, uuid4

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .admin_attachments import AdminAttachments
from .asset_catalog_management import AssetManagement
from .asset_lookup_catalog import AssetCatalog
from .asset_lookup_contract import trim
from .asset_web_paging import ASCII_UPPER, web_page_number
from .financial_reports import FinancialReports
from .resource_library import ResourceLibrary
from .security import lock_mutation_identity
from .shared_attachment_media import open_original
from .system_assets import SystemAssets


def alias_path(value):
    if not isinstance(value,str) or not value.startswith('/uploads/') or len(value)>1024 or any(ord(char)<32 or ord(char)==127 for char in value) or any(char in value for char in ('\\','%','?','#')) or any(part in ('','.','..') for part in value[1:].split('/')):raise HTTPException(400,'旧媒体路径无效')
    try:
        if len(value.encode('utf-8'))>1024:raise ValueError()
    except (ValueError,UnicodeError):raise HTTPException(400,'旧媒体路径过长或编码无效') from None
    return value


def library_page_number(raw,size):
    text=trim(raw or '')
    try:
        number=float(int(text,0)) if re.fullmatch(r'0[xX][a-fA-F0-9]+|0[bB][01]+|0[oO][0-7]+',text) else float(text or 0)
    except (ValueError,OverflowError):
        return 1
    if not math.isfinite(number) or not number.is_integer() or not 0<number<=9007199254740991:
        return 1
    return min(int(number),9007199254740991//size)


def cap_sort(rows,requested,fx):
    ordered=sorted(rows,key=lambda row:row['code'].translate(ASCII_UPPER))
    metadata={'requestedSort':requested,'sortApplied':'code','sortBasis':'code_for_unknown_market_caps','unavailableReasons':[]}
    if requested=='code':return ordered,metadata
    known=[];unknown=[]
    for row in ordered:
        try:
            value=row.get('marketCap');currency=row.get('marketCapCurrency')
            if not isinstance(value,str) or len(value)>256 or row.get('metadataObservation',{}).get('state')!='observed' or not currency:
                raise ValueError()
            number=Decimal(value)
            if not number.is_finite() or number<0:raise ValueError()
            known.append((row,Fraction(number),currency))
        except (ValueError,InvalidOperation):unknown.append(row)
    currencies={item[2] for item in known};converted=[]
    same_currency=len(currencies)==1
    for row,value,currency in known:
        try:
            if same_currency or currency=='USD':rate=Fraction(1)
            else:
                if fx.get('state')!='observed' or currency not in fx.get('quoted',[]):raise ValueError()
                exact=fx.get('exactRatios',{}).get(currency)
                rate=Fraction(int(exact['numerator']),int(exact['denominator'])) if exact else Fraction(Decimal(fx['rates'][currency]))
                if rate<=0:raise ValueError()
            converted.append((row,value/rate))
        except (ValueError,KeyError,TypeError,ZeroDivisionError,InvalidOperation):
            metadata['unavailableReasons']=['verified_currency_conversion_unavailable']
            return ordered,metadata
    if not converted:
        metadata['unavailableReasons']=['verified_market_cap_and_conversion_basis_unavailable']
        return ordered,metadata
    converted.sort(key=lambda pair:pair[1],reverse=requested!='cap_asc')
    metadata.update(sortApplied='cap_partial' if unknown else 'cap',sortBasis='retained_licensed_market_cap_not_live',
        sortCurrency=next(iter(currencies)) if same_currency else 'USD',capSortableCount=len(converted),unknownCapCount=len(unknown),
        conversionBasis='same_reported_currency_no_conversion' if same_currency else 'verified_exact_fx_observation',
        fxObservation=None if same_currency else {key:fx.get(key) for key in ('observationId','providerRevision','observationDate','observationInstant','receivedAt','sourcePrecision','rawSha256')},
        sourceAsOfKnown=all(row.get('asOf') is not None for row,_value in converted),realTimePricesAssumed=False)
    if unknown:metadata['unavailableReasons']=['some_market_caps_unknown_not_zero']
    return [row for row,_value in converted]+unknown,metadata


def metadata(row):
    return {'legacyPath':row['legacy_path'],'scope':row['scope'],'targetKind':row['target_kind'],'targetId':row['target_id'],'revision':row['revision'],'sha256':row['sha256'],'size':row['byte_length'],'deleted':row['deleted_at'] is not None,'updatedAt':row['updated_at'].isoformat()}


def standard(row):
    sha=row.get('served_sha256',row.get('sha256'));size=row.get('served_size',row.get('byte_length',row.get('size_bytes')))
    media=row.get('media_type',row.get('mime_type',row.get('mime')))
    if media is None:
        extension=row.get('original_name','').rsplit('.',1)[-1].lower()
        media={'pdf':'application/pdf','json':'application/json','csv':'text/csv','html':'text/plain','txt':'text/plain','mp4':'video/mp4','webm':'video/webm','mp3':'audio/mpeg','m4a':'audio/mp4','aac':'audio/aac','ogg':'audio/ogg','wav':'audio/wav','glb':'model/gltf-binary','gltf':'model/gltf+json','hdr':'image/vnd.radiance','ktx2':'image/ktx2'}.get(extension,'application/octet-stream')
    return {**row,'served_sha256':sha,'original_sha256':sha,'served_size':size,'original_size':size,'media_type':media}


class MediaCompat:
    def __init__(self,db):self.db=db

    async def library(self,who,params):
        async with AssetCatalog(self.db).context(who) as conn:
            from .market_worker import Bound
            manager=AssetManagement(AssetCatalog(Bound(conn,self.db.settings)))
            # The existing public metadata authority has no verified cap/FX observation.
            rows=[]
            for kind in ('stock','crypto','metal','market'):
                full=await manager.listing(kind=kind,page=1,page_size=5000)
                rows.extend({key:row.get(key) for key in ('id','type','market','code','name','url','board','marketCap','marketCapCurrency','marketCapAsOf','asOf','sourceEvidence','metadataObservation')} for row in full['assets'])
                if len(rows)>5000:raise HTTPException(503,'素材目录超过完整读取预算，请使用分类目录分页')
            for row in rows:
                if row['board'] is None:row['board']=''
            if params.get('paged')!='1':
                result={'stock':{},'crypto':[],'metal':[],'market':[]}
                for row in rows:
                    if row['type']=='stock':result['stock'].setdefault(row['market'],[]).append(row)
                    else:result[row['type']].append(row)
                return result
            kind=params.get('type') if params.get('type') in ('stock','crypto','metal','market') else 'stock'
            market=params.get('market') if kind=='stock' and params.get('market') not in (None,'','ALL') else None
            query=trim(params.get('q','')).encode('utf-16-le',errors='surrogatepass')[:160].decode('utf-16-le',errors='surrogatepass').translate(ASCII_UPPER);size=web_page_number(params.get('pageSize'),10,100);page=library_page_number(params.get('page'),size)
            selected=[row for row in rows if row['type']==kind and (not market or row['market']==market) and (not query or query in row['name'].translate(ASCII_UPPER) or query in row['code'].translate(ASCII_UPPER))]
            fx={}
            if params.get('sort')!='code':
                from .fx_reference import FxWorker
                try:fx=await FxWorker(Bound(conn,self.db.settings)).snapshot(exact=True)
                except HTTPException:pass
            selected,ordering=cap_sort(selected,params.get('sort','cap_desc'),fx)
            counts={kind:sum(row['type']==kind for row in rows) for kind in ('stock','crypto','metal','market')}
            return {'items':selected[(page-1)*size:page*size],'page':page,'pageSize':size,'total':len(selected),'totalAll':len(rows),'counts':counts,'markets':sorted({row['market'] for row in rows if row['type']=='stock' and row['market']}),
                    'revision':full['revision'],'marketCapAuthority':'retained_licensed_provider_metadata','coverage':{'scope':'registered_public_asset_metadata','complete':True,'historicalDataCoverageKnown':False},**ordering}

    async def list_aliases(self,who):
        async with self.db.connection() as conn,conn.transaction():
            await lock_mutation_identity(conn,who,require_admin=who.role=='admin')
            rows=await(await conn.execute("SELECT * FROM media_compat_aliases WHERE (scope='owner' AND owner_key=%s) OR (scope IN ('admin','public') AND %s) ORDER BY scope,legacy_path LIMIT 1001",(who.id,who.role=='admin'))).fetchall()
            if len(rows)>1000:raise HTTPException(409,'映射超过本次完整读取预算')
            return {'aliases':[metadata(row) for row in rows],'collectionOnRead':False}

    async def receipt(self,who,request_id):
        async with self.db.connection() as conn,conn.transaction():
            await lock_mutation_identity(conn,who,require_admin=False)
            row=await(await conn.execute('SELECT result FROM media_compat_operations WHERE actor_id=%s AND request_id=%s',(who.id,UUID(request_id)))).fetchone()
            if not row:raise HTTPException(404,'原映射回执不存在')
            if row['result'].get('alias',{}).get('scope')!='owner':await lock_mutation_identity(conn,who,require_admin=True)
            return row['result']

    async def register(self,who,raw):
        allowed={'requestId','expectedRevision','legacyPath','targetKind','targetId','scope','publicDisplay','acknowledgePublicDisclosure','action'}
        if not isinstance(raw,dict) or set(raw)-allowed:raise HTTPException(400,'映射字段无效')
        try:rid=str(UUID(raw['requestId']))
        except (ValueError,TypeError,KeyError):raise HTTPException(400,'原请求UUID无效') from None
        expected=raw.get('expectedRevision');path=alias_path(raw.get('legacyPath'));scope=raw.get('scope','owner');action=raw.get('action','register')
        if type(expected) is not int or not 0<=expected<9007199254740991 or scope not in ('owner','admin','public') or action not in ('register','remove'):raise HTTPException(400,'映射范围或版本无效')
        if path.startswith('/uploads/fonts/'):raise HTTPException(409,'本人字体继续使用已有专用字体映射')
        if scope!='admin' and path.lower().startswith(('/uploads/reports/','/uploads/alcor-test/')):raise HTTPException(403,'私有报告路径不得公开或降为普通成员文件')
        if scope in ('admin','public') and who.role!='admin':raise HTTPException(403,'需要管理员确认此映射范围')
        hashed=hashlib.sha256(json.dumps(raw,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
        key=who.id if scope=='owner' else ''
        async with self.db.connection() as conn,conn.transaction():
            await conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',('identity-management:'+who.id,))
            await lock_mutation_identity(conn,who,require_admin=scope!='owner')
            await conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',('media-alias:'+scope+':'+key+':'+path,))
            prior=await(await conn.execute('SELECT fingerprint,result FROM media_compat_operations WHERE actor_id=%s AND request_id=%s',(who.id,rid))).fetchone()
            if prior:
                if prior['fingerprint']!=hashed:raise HTTPException(409,'原UUID已用于其他映射')
                return prior['result']
            old=await(await conn.execute('SELECT * FROM media_compat_aliases WHERE scope=%s AND owner_key=%s AND legacy_path=%s FOR UPDATE',(scope,key,path))).fetchone()
            if (old['revision'] if old else 0)!=expected:raise HTTPException(409,'旧媒体映射已变化')
            if action=='remove':
                if not old:raise HTTPException(404,'旧媒体映射不存在')
                await conn.execute('UPDATE media_compat_aliases SET deleted_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() WHERE scope=%s AND owner_key=%s AND legacy_path=%s',(scope,key,path))
            else:
                kind=raw.get('targetKind');target=raw.get('targetId')
                if kind not in ('system','asset','report','attachment','resource') or not isinstance(target,str):raise HTTPException(400,'目标须为已登记不可变版本')
                if path.split('/')[2] in ('asset','cards') and (kind not in ('asset','system') or scope!='public'):raise HTTPException(403,'托管素材别名只能指向已登记公开图片')
                if kind=='report' and scope!='admin' or kind=='resource' and scope!='owner' or kind in ('system','asset') and scope!='public' or kind=='attachment' and scope=='owner':raise HTTPException(403,'目标与可见范围不一致')
                if scope=='public' and (raw.get('publicDisplay') is not True or raw.get('acknowledgePublicDisclosure') is not True):raise HTTPException(400,'须明确确认此已登记版本可公开展示')
                from .market_worker import Bound
                resolver=MediaCompat(Bound(conn,self.db.settings))
                if kind=='asset':
                    row,stream=await AssetCatalog(resolver.db).original(target);kind='system';target=str(row['id'])
                else:row,stream=await resolver.target(who,kind,target,scope)
                stream.close();info=standard(row)
                await conn.execute('''INSERT INTO media_compat_aliases(scope,owner_key,legacy_path,owner_id,target_kind,target_id,sha256,byte_length,revision,created_by)
                 VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT(scope,owner_key,legacy_path) DO UPDATE SET target_kind=excluded.target_kind,target_id=excluded.target_id,sha256=excluded.sha256,byte_length=excluded.byte_length,revision=excluded.revision,deleted_at=NULL,created_by=excluded.created_by,updated_at=clock_timestamp()''',
                 (scope,key,path,who.id if scope=='owner' else None,kind,target,info['served_sha256'],info['served_size'],expected+1,who.id))
            row=await(await conn.execute('SELECT * FROM media_compat_aliases WHERE scope=%s AND owner_key=%s AND legacy_path=%s',(scope,key,path))).fetchone()
            result={'requestId':rid,'state':'completed','alias':metadata(row)}
            await conn.execute('INSERT INTO media_compat_versions(id,scope,owner_key,legacy_path,revision,payload,actor_id,request_id) VALUES(%s,%s,%s,%s,%s,%s,%s,%s)',(uuid4(),scope,key,path,expected+1,Jsonb(result['alias']),who.id,rid))
            await conn.execute('INSERT INTO media_compat_operations(actor_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)',(who.id,rid,hashed,Jsonb(result)))
            await conn.execute("INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'media.alias.'||%s,%s,%s)",(who.id,action,path,rid))
            return result

    async def target(self,who,kind,target,scope):
        if kind=='system':
            async with self.db.connection() as conn:
                row=await(await conn.execute('SELECT * FROM system_asset_versions WHERE id=%s',(UUID(target),))).fetchone()
            if not row:raise HTTPException(404,'已登记公开素材版本不存在')
            return await SystemAssets(self.db).public(row['public_path'],row['served_sha256'])
        if kind=='resource':return await ResourceLibrary(self.db).content(who,target)
        if kind=='report':return await FinancialReports(self.db).original(who,target)
        if kind=='attachment' and scope=='admin':return await AdminAttachments(self.db).content(who,version=UUID(target))
        if kind=='attachment' and scope=='public':
            async with self.db.connection() as conn:
                row=await(await conn.execute('SELECT v.* FROM admin_attachment_versions v JOIN admin_attachment_entries e ON e.id=v.entry_id WHERE v.id=%s AND e.deleted_at IS NULL',(UUID(target),))).fetchone()
            if not row:raise HTTPException(404,'已登记附件版本不存在')
            return row,await open_original(self.db.settings,row)
        raise HTTPException(404,'媒体目标不存在')

    async def resolve(self,path,who=None,*,managed=False,sha=None):
        path=alias_path(path)
        if managed and path.split('/')[2] not in ('asset','cards'):raise HTTPException(404,'托管素材路径不存在')
        private=path.lower().startswith(('/uploads/reports/','/uploads/alcor-test/'))
        if not private:
            if managed or path.split('/')[2] in ('asset','cards'):
                alias=await AssetCatalog(self.db).resolve_alias(path)
                if alias['imageUrl']:
                    key=alias['imageUrl'].rsplit('/',1)[-1];row,stream=await AssetCatalog(self.db).original(key)
                    return standard(row),stream,False
            if path.split('/')[2] in ('ico','background','logo','login','asset'):
                try:
                    row,stream=await SystemAssets(self.db).public(path,sha)
                    return standard(row),stream,False
                except HTTPException as exc:
                    if exc.status_code!=404:raise
        async with self.db.connection() as conn:
            rows=await(await conn.execute('''SELECT * FROM media_compat_aliases WHERE legacy_path=%s AND deleted_at IS NULL AND
             ((scope='public' AND %s) OR (scope='admin' AND %s) OR (scope='owner' AND owner_key=%s))''',(path,not private,bool(who and who.role=='admin'),who.id if who else ''))).fetchall()
        if not rows:raise HTTPException(404,'旧路径尚未明确映射到已登记版本')
        if len(rows)!=1:raise HTTPException(409,'旧路径存在多个可见来源，不能猜测目标')
        alias=rows[0]
        if managed and (alias['scope']!='public' or alias['target_kind']!='system'):raise HTTPException(404,'托管素材映射不存在')
        row,stream=await self.target(who,alias['target_kind'],alias['target_id'],alias['scope'])
        info=standard(row)
        if info['served_sha256']!=alias['sha256'] or info['served_size']!=alias['byte_length']:
            stream.close();raise HTTPException(409,'已登记媒体版本不一致')
        return info,stream,alias['scope']!='public'
