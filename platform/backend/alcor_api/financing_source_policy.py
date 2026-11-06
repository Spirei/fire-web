"""Policy facts from the same immutable, consented financial source archive."""
import json
from decimal import Decimal

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .actual_fee_confirmations import identifier
from .fee_repairs import hashed
from .financing_model import policy, revision
from .financing_policies import FinancingPolicies, cash_state, head
from .source_snapshot import canonical, sha


def check_table_authority(snapshot,name,table):
    source=snapshot.get('source',{})
    row_security=source.get('financingRowSecurity',{})
    if row_security.get('known') is not True or row_security.get('tables',{}).get(name) is True:raise HTTPException(409,'原融资数据的行权限范围尚未核实，不能把筛选后的空值当作未配置')
    if any(field.startswith(name+'.') for field in source.get('unknownColumns',[])):raise HTTPException(409,'原融资数据含尚未核实的字段，不能声明完整迁入')
    if not table.get('present'):
        structure=source.get('financialFamilyEvidence',{})
        observed=structure.get('tables',{}).get(name,{})
        if structure.get('schemaInventoryKnown') is not True or observed.get('observed') is not False:raise HTTPException(409,'原融资数据表不可读取，不能把未知当作未配置')


def captured_policy(snapshot):
    source=snapshot.get('source',{})
    if not source.get('ownerVerified') or not source.get('datasetIdentityVerified'):
        raise HTTPException(409,'原融资政策尚未核实来源与本人归属')
    table=snapshot.get('tables',{}).get('account_financing_policy')
    if table is None:raise HTTPException(409,'此历史快照未采集原融资政策，不能把未知当作空配置')
    check_table_authority(snapshot,'account_financing_policy',table)
    rows=table.get('rows')
    if not isinstance(rows,list) or len(rows)>1:raise HTTPException(409,'原融资政策归属或唯一性未核实')
    if not table.get('present'):
        if rows:raise HTTPException(409,'原融资政策表状态与原行不符')
        return None
    if not rows:return None
    row=rows[0]
    if row.get('user_id',{}).get('text')!=source.get('owner'):raise HTTPException(409,'原融资政策本人标识不符')
    cell=row.get('value',{})
    if cell.get('null') or cell.get('storageType') not in ('text','character varying') or not isinstance(cell.get('text'),str):raise HTTPException(409,'原融资政策须保留完整存储文本')
    raw=cell['text']
    if len(raw.encode('utf8'))>8192:raise HTTPException(409,'原融资政策超出已核实范围')
    def pairs(items):
        value={}
        for key,item in items:
            if key in value:raise ValueError('duplicate policy field')
            value[key]=item
        return value
    try:
        value=json.loads(raw,parse_float=Decimal,parse_int=Decimal,parse_constant=lambda _:(_ for _ in ()).throw(ValueError()),object_pairs_hook=pairs)
        if not isinstance(value,dict) or set(value)!={'currency','limit','initialMargin','maintenanceMargin'}:raise ValueError()
        for key in ('limit','initialMargin','maintenanceMargin'):
            if value[key] is not None and not isinstance(value[key],Decimal):raise ValueError()
        return policy({key:str(item) if isinstance(item,Decimal) else item for key,item in value.items()})
    except (ValueError,TypeError,HTTPException):raise HTTPException(409,'原融资政策金额或字段尚未核实，不能替换为默认值') from None


def captured_requests(snapshot):
    import re

    from .legacy_financing import legacy_revision
    table=snapshot.get('tables',{}).get('account_financing_requests')
    if table is None:raise HTTPException(409,'此历史快照未采集原融资UUID回执，不能声明完整迁入')
    check_table_authority(snapshot,'account_financing_requests',table)
    rows=table.get('rows')
    if not isinstance(rows,list) or len(rows)>10000:raise HTTPException(409,'原融资UUID回执超出本次范围')
    results=[];seen=set();owner=snapshot['source']['owner']
    for row in rows:
        values={key:row.get(key,{}).get('text') for key in ('user_id','request_id','payload','result')}
        if values['user_id']!=owner or not isinstance(values['payload'],str) or not re.fullmatch('[a-f0-9]{64}',values['payload']):raise HTTPException(409,'原融资UUID回执归属或请求摘要尚未核实')
        request=identifier(values['request_id'])
        if request in seen:raise HTTPException(409,'原融资UUID回执重复')
        seen.add(request)
        raw=values['result']
        if not isinstance(raw,str) or len(raw.encode('utf8'))>8192:raise HTTPException(409,'原融资UUID回执字节无效')
        try:
            result=json.loads(raw,parse_float=Decimal,parse_int=Decimal)
            if not isinstance(result,dict) or set(result)!={'version','accountId','revision','policy'} or not isinstance(result['version'],Decimal) or result['version']!=1 or result['accountId']!=owner:raise ValueError()
            value=result['policy']
            if not isinstance(value,dict):raise TypeError()
            normalized=policy({key:str(item) if isinstance(item,Decimal) else item for key,item in value.items()})
            if result['revision']!=legacy_revision(normalized):raise ValueError()
        except (ValueError,TypeError,HTTPException):raise HTTPException(409,'原融资UUID完成回执结构、本人标识或政策版本尚未核实') from None
        results.append({'requestId':request,'payloadHash':values['payload'],'resultRaw':raw,'resultSha256':sha(raw.encode()),'policy':normalized,'originalAccountId':owner})
    return results


def parse_source_policy(raw):
    fields={'requestId','manifestId','targetUserId','accountKind','revision','sourcePolicyKindConfirmed'}
    if not isinstance(raw,dict) or set(raw)!=fields or raw.get('sourcePolicyKindConfirmed') is not True or raw.get('accountKind') not in ('real','simulated') or not isinstance(raw.get('targetUserId'),str):raise HTTPException(422,'须明确原融资政策仅归属所选真实或模拟账本，不能复制额度')
    version=raw['revision']
    if not isinstance(version,str) or len(version)!=64 or any(c not in '0123456789abcdef' for c in version):raise HTTPException(422,'融资政策前驱无效')
    return {**raw,'requestId':identifier(raw['requestId']),'manifestId':identifier(raw['manifestId'])}


class FinancingSourcePolicies(FinancingPolicies):
    parse_command=staticmethod(parse_source_policy)
    audit_action='financing.policy-source-import'

    def __init__(self,db,authority):
        super().__init__(db);self.authority=authority

    async def options(self,who,kind):
        from uuid import uuid4

        from .source_read_access import source_read_lock
        async with self.db.connection() as conn,conn.transaction():
            await source_read_lock(conn,who)
            current=await head(conn,who.id,kind)
            source=await(await conn.execute('SELECT manifest_id FROM legacy_source_heads WHERE owner_id=%s',(who.id,))).fetchone()
            if not source:return {'state':'not_captured','manifestId':None,'policyKnown':False,'policy':None}
            try:
                data=await self.resolve(conn,who,{'requestId':str(uuid4()),'manifestId':str(source['manifest_id']),'targetUserId':who.id,'accountKind':kind,'revision':current['revision'],'sourcePolicyKindConfirmed':True})
                return {'state':'available','manifestId':data['manifestId'],'policyKnown':True,'policy':data['policy'],'sourcePolicy':data['_sourcePolicy'],'originalReceiptCount':len(data['_sourcePolicyRequests'])}
            except HTTPException as error:
                if error.status_code in (401,403):raise
                return {'state':'blocked','manifestId':str(source['manifest_id']),'policyKnown':False,'policy':None,'message':str(error.detail)}

    async def resolve(self,conn,who,data):
        if data['targetUserId']!=who.id:raise HTTPException(403,'来源融资政策账号不是本人')
        row=await(await conn.execute('SELECT m.*,g.physical_identity_hash,g.source_owner,g.source_instance,h.revision head_revision FROM legacy_source_manifests m JOIN legacy_source_grants g ON g.id=m.grant_id AND g.owner_id=m.owner_id JOIN legacy_source_heads h ON h.owner_id=m.owner_id AND h.manifest_id=m.id WHERE m.owner_id=%s AND m.id=%s FOR SHARE OF m,g,h',(who.id,data['manifestId']))).fetchone()
        if not row:raise HTTPException(409,'须选择本人当前已确认来源快照')
        await self.authority.archive_grant(conn,who,row['grant_id'],row['grant_revision'],manifest_id=row['id'])
        claim=await(await conn.execute('SELECT account_kind FROM financing_source_policy_claims WHERE physical_identity_hash=%s AND source_owner=%s FOR SHARE',(row['physical_identity_hash'],row['source_owner']))).fetchone()
        if claim and claim['account_kind']!=data['accountKind']:raise HTTPException(409,'同一原融资政策已归属另一账本，不能再次复制额度')
        original=json.loads(bytes(row['raw']))
        value=captured_policy(original)
        requests=captured_requests(original)
        for request in requests:
            if request['requestId']==data['requestId']:raise HTTPException(409,'迁入UUID不能占用原融资请求编号')
            if await(await conn.execute('SELECT 1 FROM cash_ledger_entries WHERE owner_id=%s AND request_id=%s UNION ALL SELECT 1 FROM cash_ledger_operations WHERE owner_id=%s AND request_id=%s',(who.id,request['requestId'],who.id,request['requestId']))).fetchone():raise HTTPException(409,'原融资UUID与已有现金操作冲突')
            existing=await(await conn.execute('SELECT result FROM trade_operations WHERE owner_id=%s AND request_id=%s',(who.id,request['requestId']))).fetchone()
            if existing and not (existing['result'].get('sourcePolicyArchive') and existing['result'].get('sourceOriginalResultSha256')==request['resultSha256'] and existing['result'].get('sourceOriginalPayloadHash')==request['payloadHash'] and existing['result'].get('sourcePhysicalIdentityHash')==row['physical_identity_hash'] and existing['result'].get('sourceOriginalAccountId')==row['source_owner']):raise HTTPException(409,'原融资UUID与平台已有操作冲突，须先核对来源')
        return {**data,'policy':value,'_sourcePolicyRequests':requests,'_sourcePolicy':{'manifestId':data['manifestId'],'manifestSha256':row['manifest_sha256'],'rawSha256':sha(bytes(row['raw'])),'sourceOwner':row['source_owner'],'sourceInstance':row['source_instance'],'physicalIdentityHash':row['physical_identity_hash'],'grantRevision':row['grant_revision'],'sourceHeadRevision':row['head_revision']}}

    async def calculate(self,conn,who,data):
        resolved=await self.resolve(conn,who,data)
        current=await head(conn,who.id,data['accountKind'])
        if current['revision']!=data['revision']:raise HTTPException(409,'融资政策已变化，请重新读取并预览')
        value=resolved['policy']
        cash,_used,stable=await cash_state(self,conn,who,data['accountKind'],value['currency'] if value else None)
        # Import records an existing original fact. A historical exceeded limit
        # or unknown cash remains explicit; neither rewrites the captured policy.
        return {'snapshotRevision':hashed({'current':current,'cash':stable,'source':resolved['_sourcePolicy']})},{'version':1,'targetUserId':who.id,'accountKind':data['accountKind'],'before':current,'policy':value,'revision':revision(value),'usedDebt':cash,'brokerExecution':False,'canSubmit':True,'changed':value!=current['policy'],'sourcePolicy':resolved['_sourcePolicy'],'sourcePolicyKindConfirmed':True,'financialApplied':False,'originalReceiptCount':len(resolved['_sourcePolicyRequests'])}

    async def commit(self,conn,who,data,fingerprint,cash_revision,preview):
        return await super().commit(conn,who,await self.resolve(conn,who,data),fingerprint,cash_revision,preview)

    async def decorate_policy_receipt(self,conn,who,data,result):
        source=data['_sourcePolicy'];raw=canonical(data['policy'])
        await conn.execute('INSERT INTO financing_source_policy_claims(owner_id,physical_identity_hash,source_owner,source_instance,account_kind,first_request_id) VALUES(%s,%s,%s,%s,%s,%s) ON CONFLICT(physical_identity_hash,source_owner) DO NOTHING',(who.id,source['physicalIdentityHash'],source['sourceOwner'],source['sourceInstance'],data['accountKind'],data['requestId']))
        claim=await(await conn.execute('SELECT * FROM financing_source_policy_claims WHERE physical_identity_hash=%s AND source_owner=%s FOR SHARE',(source['physicalIdentityHash'],source['sourceOwner']))).fetchone()
        if claim['owner_id']!=who.id or claim['account_kind']!=data['accountKind']:raise HTTPException(409,'原融资政策归属已变化')
        await conn.execute('INSERT INTO financing_source_policy_mappings(owner_id,request_id,manifest_id,manifest_sha256,account_kind,policy,policy_raw,policy_sha256,source_head_revision) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s)',(who.id,data['requestId'],data['manifestId'],source['manifestSha256'],data['accountKind'],Jsonb(data['policy']),raw,sha(raw),source['sourceHeadRevision']))
        await conn.execute('INSERT INTO financing_source_policy_heads(owner_id,account_kind,request_id) VALUES(%s,%s,%s) ON CONFLICT(owner_id,account_kind) DO UPDATE SET request_id=excluded.request_id',(who.id,data['accountKind'],data['requestId']))
        from .legacy_financing import view
        for item in data['_sourcePolicyRequests']:
            archived={'requestId':item['requestId'],'kind':'financing_policy','state':'completed','policyRevision':None,'policy':item['policy'],'brokerExecution':False,'financialApplied':False,'sourcePolicyArchive':True,'sourceOriginalResultSha256':item['resultSha256'],'sourceOriginalPayloadHash':item['payloadHash'],'sourcePhysicalIdentityHash':source['physicalIdentityHash'],'sourceOriginalAccountId':item['originalAccountId'],'legacyReceipt':view(who.id,item['policy']),'data':{'targetUserId':who.id,'sourceManifestId':data['manifestId']}}
            await conn.execute('INSERT INTO trade_operations(owner_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s) ON CONFLICT(owner_id,request_id) DO NOTHING',(who.id,item['requestId'],'archived-financing-policy:'+item['payloadHash'],Jsonb(archived)))
            await conn.execute('INSERT INTO financing_source_policy_request_archives(owner_id,original_request_id,account_kind,payload_hash,result_raw,result_sha256,manifest_id,mapping_request_id) VALUES(%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT(owner_id,original_request_id) DO NOTHING',(who.id,item['requestId'],data['accountKind'],item['payloadHash'],item['resultRaw'].encode(),item['resultSha256'],data['manifestId'],data['requestId']))
        return {**result,'sourcePolicy':source,'sourcePolicyKindConfirmed':True,'financialApplied':False,'originalReceiptCount':len(data['_sourcePolicyRequests'])}
