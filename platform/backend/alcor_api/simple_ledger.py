"""Independent declared personal ledger; never a broker or live FX authority."""
import hashlib
import json
from decimal import Decimal, InvalidOperation
from uuid import UUID, uuid4

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .account_signals import guard
from .security import lock_mutation_identity

ARRAYS = ('cash','fixed','receivable','debt','invest','snaps','logs','members')

def decimal_json(raw):
    from .fx_provider_parser import unique
    def bad(_):
        raise ValueError('non-finite')
    def integer(token):
        return int(token) if len(token.lstrip('-'))<=4000 else Decimal(token)
    try:return json.loads(raw,parse_float=Decimal,parse_int=integer,parse_constant=bad,object_pairs_hook=unique)
    except (InvalidOperation,OverflowError):raise ValueError('number outside exact range') from None


def wire(value):
    # Historical wire-v1 behavior, used only for legacy normalization/hash/projection.
    return json.loads(json.dumps(value,default=str,ensure_ascii=False))


def exact_json(value,*,max_bytes=None):
    """JSON numbers stay numbers; never route Decimal through binary float."""
    def number(item):
        if not item.is_finite():raise HTTPException(400,'账本数值必须有限')
        if item.is_zero():return '0'
        _,digits,exponent=item.as_tuple()
        if max(0,len(digits)+exponent)>131072 or max(0,-exponent)>16383:
            raise HTTPException(400,'账本数值超出可保存的精确范围')
        return str(item)
    def emit(item,depth=0):
        if depth>128:raise HTTPException(400,'账本JSON嵌套过深')
        if item is None:return 'null'
        if item is True:return 'true'
        if item is False:return 'false'
        if isinstance(item,str):return json.dumps(item,ensure_ascii=False)
        if isinstance(item,int):return number(Decimal(item)) if item.bit_length()>10000 else str(item)
        if isinstance(item,Decimal):return number(item)
        if isinstance(item,list):return '['+','.join(emit(child,depth+1) for child in item)+']'
        if isinstance(item,dict):
            if any(not isinstance(key,str) for key in item):raise HTTPException(400,'账本字段须为字符串')
            return '{'+','.join(json.dumps(key,ensure_ascii=False)+':'+emit(child,depth+1) for key,child in item.items())+'}'
        raise HTTPException(400,'账本包含非精确JSON类型')
    def expanded_width(item,depth=0):
        if depth>128:raise HTTPException(400,'账本JSON嵌套过深')
        if item is None:return 4
        if isinstance(item,bool):return 4 if item else 5
        if isinstance(item,str):
            try:return len(json.dumps(item,ensure_ascii=False).encode('utf-8'))
            except UnicodeError:raise HTTPException(400,'账本包含无效UTF8文本') from None
        if isinstance(item,(int,Decimal)):
            n=Decimal(item)
            # Validate PostgreSQL numeric range without expanding exponent notation.
            if not n.is_finite():raise HTTPException(400,'账本数值必须有限')
            if n.is_zero():return 1
            sign,digits,exponent=n.as_tuple();length=len(digits)
            if max(0,length+exponent)>131072 or max(0,-exponent)>16383:raise HTTPException(400,'账本数值超出可保存的精确范围')
            return sign+(length+exponent if exponent>=0 else length+1 if length+exponent>0 else 2-exponent)
        if isinstance(item,list):
            total=2
            for index,child in enumerate(item):
                total+=(2 if index else 0)+expanded_width(child,depth+1)
                if total>max_bytes:raise HTTPException(413,'账本展开后数据超过2MiB')
            return total
        if isinstance(item,dict):
            total=2
            for index,(key,child) in enumerate(item.items()):
                if not isinstance(key,str):raise HTTPException(400,'账本字段须为字符串')
                total+=(2 if index else 0)+expanded_width(key,depth+1)+2+expanded_width(child,depth+1)
                if total>max_bytes:raise HTTPException(413,'账本展开后数据超过2MiB')
            return total
        raise HTTPException(400,'账本包含非精确JSON类型')
    if max_bytes is not None and expanded_width(value)>max_bytes:raise HTTPException(413,'账本展开后数据超过2MiB')
    return emit(value)


def legacy_fingerprint(raw):
    return hashlib.sha256(json.dumps(wire(raw),sort_keys=True,separators=(',',':')).encode()).hexdigest()


def typed_fingerprint(raw):
    # Hash raw types; storage bounds apply to the field-normalized JSONB value.
    def tagged(value,depth=0):
        if depth>128:raise HTTPException(400,'账本JSON嵌套过深')
        if value is None:return ['null']
        if isinstance(value,bool):return ['boolean',value]
        if isinstance(value,str):return ['string',value]
        if isinstance(value,(int,Decimal)):
            n=Decimal(value)
            if not n.is_finite():raise HTTPException(400,'账本数值必须有限')
            sign,digits,exponent=n.as_tuple();digits=list(digits)
            if not any(digits):return ['number','0']
            while digits[-1]==0:digits.pop();exponent+=1
            return ['number',('-' if sign else '')+''.join(map(str,digits))+'e'+str(exponent)]
        if isinstance(value,list):return ['array',[tagged(child,depth+1) for child in value]]
        if isinstance(value,dict):
            if any(not isinstance(key,str) for key in value):raise HTTPException(400,'账本字段须为字符串')
            return ['object',[[key,tagged(value[key],depth+1)] for key in sorted(value)]]
        raise HTTPException(400,'账本包含非精确JSON类型')
    return hashlib.sha256(json.dumps(tagged(raw),ensure_ascii=False,separators=(',',':')).encode()).hexdigest()


def legacy_wire(value):
    """Keep the captured JS metadata numbers without floating arbitrary financial fields."""
    import math
    result=wire(value)
    original=value.get('ledger',value) if isinstance(value,dict) else None
    projected=result.get('ledger',result) if isinstance(result,dict) else None
    if isinstance(original,dict) and isinstance(projected,dict):
        for key in ('reminder','expected'):
            item=original.get(key)
            if isinstance(item,Decimal):
                converted=float(item)
                if math.isfinite(converted):projected[key]=converted
    return result


def defaults(*,legacy=False):
    return {'hide': False,'excludeFixed': False,'displayCur': 'CNY','fx': {'CNY':'1','HKD':'0.92','USD':'7.18'} if legacy else {'CNY':1},'reminder': 0,'expected': 8,'cash': [],'fixed': [],'receivable': [],'debt': [],'invest': [],'cashflow': {'stable':0,'flex':0,'income':0},'snaps': [],'logs': [],'members': [{'id':'me','name':'我'}]}



def financial_wire(value):
    """Historical known financial Decimal DTOs are strings; opaque extensions are not."""
    def fields(row,names):
        if not isinstance(row,dict):return row
        return {key:str(item) if key in names and isinstance(item,Decimal) else item for key,item in row.items()}
    result=fields(value,('expected',))
    for key in ('cash','fixed','receivable','debt','invest','logs','snaps'):
        source=result.get(key)
        if not isinstance(source,list):continue
        names=('amount','inAmt','outAmt','expected') if key=='invest' else ('assets','debt','cash','fixed','inv','rec') if key=='snaps' else ('amount',)
        converted=[]
        for row in source:
            row=fields(row,names)
            if key=='invest' and isinstance(row,dict) and isinstance(row.get('hist'),list):
                row={**row,'hist':[fields(item,('v','inn','out')) for item in row['hist']]}
            converted.append(row)
        result[key]=converted
    if isinstance(result.get('fx'),dict):result['fx']={key:str(item) if isinstance(item,Decimal) else item for key,item in result['fx'].items()}
    if isinstance(result.get('cashflow'),dict):
        cashflow=fields(result['cashflow'],('stable','flex','income'))
        for key in ('incomeItems','expenseItems'):
            if isinstance(cashflow.get(key),list):cashflow[key]=[fields(row,('amount',)) for row in cashflow[key]]
        result['cashflow']=cashflow
    return result


def normalize(raw,*,legacy=False):
    if not isinstance(raw,dict):
        raise HTTPException(400,'简化账本须为对象')
    value={**defaults(legacy=legacy),**raw}
    for key in ARRAYS:
        if not isinstance(value[key],list):
            raise HTTPException(400,key+'须为数组')
        if len(value[key])>50000:
            raise HTTPException(413,'账本行数超限')
    for key in ('fx','cashflow'):
        if not isinstance(value[key],dict):
            raise HTTPException(400,key+'须为对象')
        value[key]={**defaults(legacy=legacy)[key],**value[key]}
    if not isinstance(value['displayCur'],str) or not legacy and not value['displayCur']:
        raise HTTPException(400,'展示币种无效')
    for key in ('hide','excludeFixed'):
        if type(value[key]) is not bool:
            raise HTTPException(400,'显示设置须为布尔值')
    if not value['members']:
        value['members']=defaults(legacy=legacy)['members']
    value=wire(value) if legacy else financial_wire(value)
    if len((json.dumps(value,ensure_ascii=False) if legacy else exact_json(value,max_bytes=2*1024*1024)).encode())>2*1024*1024:
        raise HTTPException(413,'账本数据超过2MiB')
    return value


def legacy_normalize(raw):
    import math
    value={**defaults(legacy=True),**raw}
    def truth(v):return not (v is None or v is False or isinstance(v,(str,int,float,Decimal)) and not v)
    def metadata_number(v):
        try:
            if isinstance(v,list):v=','.join('' if child is None else str(child) for child in v)
            return float(v.strip() or '0') if isinstance(v,str) else float(0 if v is None else v)
        except (TypeError,ValueError,OverflowError):return float('nan')
    for key in ('hide','excludeFixed'):value[key]=truth(value.get(key))
    if not isinstance(value.get('displayCur'),str):value['displayCur']='CNY'
    reminder=metadata_number(value.get('reminder'));expected=metadata_number(value.get('expected'))
    value['reminder']=reminder if math.isfinite(reminder) and reminder else 0
    value['expected']=expected if math.isfinite(expected) else 8
    for key in ARRAYS:
        if not isinstance(value.get(key),list):value[key]=[]
    for key in ('fx','cashflow'):
        item=value.get(key)
        if isinstance(item,list) or key=='cashflow' and isinstance(item,str):item={str(i):v for i,v in enumerate(item)}
        value[key]={**defaults(legacy=True)[key],**(item if isinstance(item,dict) else {})}
    return normalize(value,legacy=True)


def request_id(raw):
    try:
        return str(UUID(str(raw)))
    except (ValueError,TypeError,AttributeError):
        raise HTTPException(400,'操作编号无效') from None


class SimpleLedger:
    def __init__(self,db): self.db=db

    async def lock(self,conn,who,write=False):
        await conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',('identity-management:'+who.id,))
        user=await(await conn.execute('SELECT id,role FROM users WHERE id=%s AND active AND deleted_at IS NULL FOR '+('UPDATE' if write else 'SHARE'),(who.id,))).fetchone()
        if not user:raise HTTPException(401,'账号已失效')
        if user['role']!=who.role:raise HTTPException(403,'账号权限已变化')
        if getattr(who,'legacy_client',False) and not getattr(who,'legacy_platform',False):
            client=getattr(who,'simple_session_client',None)
            if client not in ('legacy-web','legacy-v1'):raise HTTPException(401,'旧会话绑定缺失')
            row=await(await conn.execute('SELECT s.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=%s AND s.user_id=%s AND s.client_id=%s AND s.expires_at>clock_timestamp() AND s.session_version=u.session_version FOR SHARE OF s',(who.token_hash,who.id,client))).fetchone()
            if not row or row['passkey_id'] and not await(await conn.execute('SELECT 1 FROM identity_passkeys WHERE id=%s AND user_id=%s',(row['passkey_id'],who.id))).fetchone():raise HTTPException(401,'旧会话已失效')
            return
        if write:
            await lock_mutation_identity(conn,who,require_admin=False)
        await guard(conn,who,'portfolio.write' if write else 'portfolio.read')

    async def current(self,conn,owner,*,legacy=False):
        row=await(await conn.execute('SELECT h.revision,v.value::text AS value_text FROM simple_ledger_heads h JOIN simple_ledger_versions v USING(owner_id,revision) WHERE h.owner_id=%s',(owner,))).fetchone()
        return {'ledger':decimal_json(row['value_text']) if row else defaults(legacy=legacy),'revision':row['revision'] if row else 0,'scope':'independent_personal_ledger','fxAuthority':'retained_declaration_or_legacy_defaults_not_observed_fx' if row else 'legacy_display_defaults_not_observed_fx' if legacy else 'currency_identity_only_not_observed_fx','brokerLedgerLinked':False}

    async def read(self,who,*,legacy=False):
        async with self.db.connection() as conn,conn.transaction():
            await self.lock(conn,who)
            return await self.current(conn,who.id,legacy=legacy)

    async def read_revision(self,who):
        """A committed owner watermark; never loads the ledger or initializes it."""
        async with self.db.connection() as conn,conn.transaction():
            await self.lock(conn,who)
            row=await(await conn.execute('SELECT h.revision FROM simple_ledger_heads h JOIN simple_ledger_versions v USING(owner_id,revision) WHERE h.owner_id=%s',(who.id,))).fetchone()
            return {'revision':row['revision'] if row else 0}

    async def save(self,who,raw,*,legacy=False):
        if not isinstance(raw,dict): raise HTTPException(400,'无效请求')
        supplied=raw.get('requestId')
        rid=request_id(supplied) if supplied is not None else str(uuid4())
        if not legacy and supplied is None: raise HTTPException(400,'请提供操作编号')
        expected=raw.get('expectedRevision')
        if expected is not None and (type(expected) is not int or expected<0): raise HTTPException(400,'账本版本无效')
        if not legacy and expected is None: raise HTTPException(400,'请提供账本版本')
        body=raw.get('ledger') if not legacy else {k:v for k,v in raw.items() if k not in ('requestId','expectedRevision')}
        if not isinstance(body,dict): raise HTTPException(400,'账本内容无效')
        fingerprint=legacy_fingerprint(raw) if legacy else None
        async with self.db.connection() as conn,conn.transaction():
            await self.lock(conn,who,True)
            prior=await(await conn.execute('SELECT fingerprint,result::text AS result_text FROM simple_ledger_operations WHERE owner_id=%s AND request_id=%s',(who.id,rid))).fetchone()
            if prior:
                result=decimal_json(prior['result_text']);version=result.get('fingerprintVersion')
                if 'fingerprintVersion' not in result:previous_fingerprint=legacy_fingerprint(raw)
                elif version=='typed-exact-v2':previous_fingerprint=typed_fingerprint(raw)
                else:raise HTTPException(409,'原操作指纹版本不可识别，请核对原回执')
                if prior['fingerprint']!=previous_fingerprint or result.get('protocolMode', 'legacy' if legacy else 'canonical')!=('legacy' if legacy else 'canonical'): raise HTTPException(409,'操作编号已用于其他内容')
                return result
            if not legacy:fingerprint=typed_fingerprint(raw)
            if await(await conn.execute('SELECT 1 FROM simple_ledger_files WHERE owner_id=%s AND request_id=%s',(who.id,rid))).fetchone(): raise HTTPException(409,'操作编号已用于文件解析')
            current=await self.current(conn,who.id,legacy=legacy)
            if expected is not None and current['revision']!=expected: raise HTTPException(409,'账本已变化，请重新读取')
            value=legacy_normalize({**current['ledger'],**body}) if legacy else normalize(body)
            revision=current['revision']+1
            result={'requestId':rid,'state':'completed','revision':revision,'ledger':value,'scope':'independent_personal_ledger','legacyClientIdempotency':supplied is not None,'protocolMode':'legacy' if legacy else 'canonical'}
            if not legacy:result['fingerprintVersion']='typed-exact-v2'
            encode_json=None if legacy else exact_json
            await conn.execute('INSERT INTO simple_ledger_versions(owner_id,revision,value,request_id) VALUES(%s,%s,%s,%s)',(who.id,revision,Jsonb(value,dumps=encode_json),rid))
            await conn.execute('INSERT INTO simple_ledger_heads VALUES(%s,%s) ON CONFLICT(owner_id) DO UPDATE SET revision=excluded.revision',(who.id,revision))
            await conn.execute('INSERT INTO simple_ledger_operations(owner_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)',(who.id,rid,fingerprint,Jsonb(result,dumps=encode_json)))
            await conn.execute("INSERT INTO audit_events(actor_id,action,target_id) VALUES(%s,'simple-ledger.saved',%s)",(who.id,who.id))
            return result

    async def receipt(self,who,rid):
        rid=request_id(rid)
        async with self.db.connection() as conn,conn.transaction():
            await self.lock(conn,who)
            row=await(await conn.execute('SELECT result::text AS result_text,NULL::bytea AS raw,NULL::text AS sha256 FROM simple_ledger_operations WHERE owner_id=%s AND request_id=%s UNION ALL SELECT result::text AS result_text,raw,sha256 FROM simple_ledger_files WHERE owner_id=%s AND request_id=%s',(who.id,rid,who.id,rid))).fetchall()
            if len(row)!=1: raise HTTPException(409 if row else 404,'操作编号冲突' if row else '未查到原操作')
            if row[0]['raw'] is not None and hashlib.sha256(bytes(row[0]['raw'])).hexdigest()!=row[0]['sha256']:raise HTTPException(503,'原文件完整性不可验证')
            return decimal_json(row[0]['result_text'])

    async def close(self,who,rid):
        rid=request_id(rid)
        async with self.db.connection() as conn,conn.transaction():
            await self.lock(conn,who,True)
            prior=await(await conn.execute('SELECT result::text AS result_text,NULL::bytea AS raw,NULL::text AS sha256 FROM simple_ledger_operations WHERE owner_id=%s AND request_id=%s UNION ALL SELECT result::text AS result_text,raw,sha256 FROM simple_ledger_files WHERE owner_id=%s AND request_id=%s',(who.id,rid,who.id,rid))).fetchall()
            if len(prior)>1:raise HTTPException(409,'操作编号冲突')
            if prior:
                if prior[0]['raw'] is not None and hashlib.sha256(bytes(prior[0]['raw'])).hexdigest()!=prior[0]['sha256']:raise HTTPException(503,'原文件完整性不可验证')
                return decimal_json(prior[0]['result_text'])
            result={'requestId':rid,'state':'closed','executed':False,'scope':'independent_personal_ledger'}
            await conn.execute('INSERT INTO simple_ledger_operations(owner_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)',(who.id,rid,hashlib.sha256(b'simple-ledger-close-v1').hexdigest(),Jsonb(result)))
            return result

    async def import_file(self,who,rid,raw):
        from .simple_ledger_xlsx import parse
        rid=request_id(rid)
        digest=hashlib.sha256(raw).hexdigest()
        async with self.db.connection() as conn,conn.transaction():
            await self.lock(conn,who,True)
            prior=await(await conn.execute('SELECT sha256,raw,result::text AS result_text FROM simple_ledger_files WHERE owner_id=%s AND request_id=%s',(who.id,rid))).fetchone()
            if prior:
                if prior['sha256']!=digest: raise HTTPException(409,'操作编号已用于另一文件')
                if hashlib.sha256(bytes(prior['raw'])).hexdigest()!=prior['sha256']:raise HTTPException(503,'原文件完整性不可验证')
                return decimal_json(prior['result_text'])
            if await(await conn.execute('SELECT 1 FROM simple_ledger_operations WHERE owner_id=%s AND request_id=%s',(who.id,rid))).fetchone(): raise HTTPException(409,'操作编号已用于账本写入')
            if len(raw)>10*1024*1024:raise HTTPException(413,'文件不能超过10MiB')
            try:rows=parse(raw)
            except HTTPException as exc:
                result={'ok':False,'state':'rejected','requestId':rid,'error':str(exc.detail),'httpStatus':400 if exc.status_code==422 else exc.status_code,'sourceSha256':digest,'applied':False,'scope':'independent_personal_ledger'}
                await conn.execute('INSERT INTO simple_ledger_files(owner_id,request_id,sha256,raw,result) VALUES(%s,%s,%s,%s,%s)',(who.id,rid,digest,raw,Jsonb(result)))
                return result
            result={'ok':True,'state':'parsed','requestId':rid,'format':'youzhiyouxing','invest':rows,'sourceSha256':digest,'applied':False,'scope':'independent_personal_ledger'}
            await conn.execute('INSERT INTO simple_ledger_files(owner_id,request_id,sha256,raw,result) VALUES(%s,%s,%s,%s,%s)',(who.id,rid,digest,raw,Jsonb(result)))
            return result
