"""Append-only derived source-to-canonical mappings; never an economic ledger."""
import json
import secrets
from uuid import UUID

from fastapi import HTTPException

from psycopg import Error as DatabaseError
from psycopg.types.json import Jsonb

from .source_read_access import source_read_lock

from alcor_api.financial_source import parse_source
from alcor_api.financial_continuation import same_original
from alcor_api.security import digest
from alcor_api.fee_plans import fee_limit
from alcor_api.trading import Trading,fingerprint


def uuid(value):
    try:return str(UUID(value))
    except (ValueError,TypeError,AttributeError):raise HTTPException(422,'映射UUID无效') from None


async def content_digest(conn,content):
    return (await(await conn.execute("SELECT encode(sha256(convert_to(%s::jsonb::text,'UTF8')),'hex') value",(Jsonb(content),))).fetchone())['value']


class FinancialMappings:
    def __init__(self,db,authority):
        self.db=db;self.authority=authority;self.trading=Trading(db)
        self.after_step=None;self.after_commit=None

    def command(self,who,raw):
        if not isinstance(raw,dict) or set(raw)!={'requestId','manifestId','importRequestId','targetUserId','expectedMappingRevision'}:
            raise HTTPException(422,'映射参数无效')
        if raw['targetUserId']!=who.id:raise HTTPException(409,'目标平台内部账号标识与本人不匹配')
        if type(raw['expectedMappingRevision']) is not int or raw['expectedMappingRevision']<0:raise HTTPException(422,'映射版本无效')
        return {**raw,**{k:uuid(raw[k]) for k in ('requestId','manifestId','importRequestId')}}

    async def plan(self,conn,who,data):
        original=await(await conn.execute('SELECT * FROM legacy_source_manifests WHERE owner_id=%s AND id=%s',(who.id,data['manifestId']))).fetchone()
        if not original:raise HTTPException(404,'本人原始清单不存在')
        grant=await self.authority.archive_grant(conn,who,original['grant_id'],original['grant_revision'],manifest_id=original['id'])
        source_head=await(await conn.execute('SELECT * FROM legacy_source_heads WHERE owner_id=%s',(who.id,))).fetchone()
        previous=await(await conn.execute('SELECT * FROM legacy_financial_mapping_heads WHERE owner_id=%s',(who.id,))).fetchone()
        receipt=await(await conn.execute('SELECT result FROM financial_import_operations WHERE owner_id=%s AND request_id=%s',(who.id,data['importRequestId']))).fetchone()
        blockers=[]
        def block(code,original_id=None):
            item={'code':code}
            if original_id is not None:item['originalId']=original_id
            blockers.append(item)
        if not receipt or receipt['result'].get('financialApplied') is not True or receipt['result'].get('state')!='completed' or receipt['result'].get('sourceId')!=data['manifestId']:block('completed_same_manifest_financial_receipt_required')
        if not source_head or source_head['manifest_id']!=original['id']:block('source_manifest_is_not_current_coverage_head')
        if (previous['revision'] if previous else 0)!=data['expectedMappingRevision']:block('mapping_predecessor_revision_changed')
        if not original['financial_raw']:block('financial_source_view_missing')
        if not original['manifest']['coverage']['complete']:block('source_coverage_incomplete')
        blockers.extend(original['manifest']['normalizationBlockers'])
        source=parse_source(bytes(original['financial_raw'])) if original['financial_raw'] else None
        links=await(await conn.execute('SELECT * FROM financial_import_links WHERE owner_id=%s AND source_instance=%s AND source_owner=%s ORDER BY object_kind,original_id',(who.id,original['manifest']['source']['instance'],original['manifest']['source']['owner']))).fetchall()
        linked={(r['object_kind'],r['original_id']):r for r in links};items=[];originals=[]
        if source:
            originals=[(kind,item) for kind,key in (('record','records'),('cash','cash'),('order','orders')) for item in source[key]]
            if len(originals)>30000:raise HTTPException(409,'完整映射超出本次范围，须明确分段')
        for kind,item in originals:
            row=linked.get((kind,item['id']))
            if not row: block('source_original_has_not_been_financially_imported',item['id']);continue
            if not same_original(kind,row['original'],item):
                block('original_provenance_or_receipt_mismatch',item['id']);continue
            snapshot=(await(await conn.execute('SELECT legacy_mapping_target_snapshot(%s,%s,%s) value',(who.id,kind,row['target_id']))).fetchone())['value']
            if snapshot is None: block('canonical_target_missing',item['id']);continue
            if kind=='order' and item['status']=='filled' and (item['fees'] is None or item['feeAuthority'] not in ('owner_recorded','broker_reported')):
                block('unknown_source_fee_cannot_become_canonical_mapping',item['id']);continue
            items.append({'objectKind':kind,'originalId':item['id'],'sourceInstance':row['source_instance'],'sourceOwner':row['source_owner'],'targetId':row['target_id'],'originManifestId':str(row['source_id']),'originImportRequestId':str(row['operation_id']),'canonical':snapshot})
        if set(linked)!=set((kind,item['id']) for kind,item in originals):block('provenance_scope_contains_extra_or_missing_originals')
        content={'version':1,'manifestId':data['manifestId'],'manifestSha256':original['manifest_sha256'],'rawSha256':original['manifest']['rawSha256'],'financialSha256':original['manifest']['financialSha256'],'feeInventorySha256':original['manifest']['feeInventorySha256'],'importRequestId':data['importRequestId'],'predecessorId':str(previous['request_id']) if previous else None,'predecessorSha256':previous['sha256'] if previous else None,'items':items}
        hashed=await content_digest(conn,content)
        result={'ready':not blockers,'blockers':blockers,'manifestId':data['manifestId'],'importRequestId':data['importRequestId'],'targetUserId':who.id,'mappingRevision':(previous['revision'] if previous else 0)+1,'mappingSha256':hashed,'mappedObjects':len(items),'sourceObjects':len(originals),'financialApplied':False,'linkedFinancialApplied':bool(receipt and receipt['result'].get('financialApplied') is True),'sourceRawRewritten':False,'brokerExecution':False}
        dependencies={'content':hashed,'grantId':str(grant['id']),'grantRevision':grant['revision'],'sourceHead':str(source_head['manifest_id']) if source_head else None,'sourceRevision':source_head['revision'] if source_head else None,'mappingRevision':previous['revision'] if previous else 0,'mappingPredecessor':str(previous['request_id']) if previous else None,'mappingHash':previous['sha256'] if previous else None}
        return result,dependencies,content

    async def preview(self,who,raw):
        await fee_limit(self.db,who)
        data=self.command(who,raw)
        async with self.db.connection() as conn,conn.transaction():
            await self.trading.lock(conn,who)
            result,dependencies,_=await self.plan(conn,who,data)
            if result['ready']:
                token=secrets.token_urlsafe(32)
                row=await(await conn.execute('INSERT INTO legacy_financial_mapping_previews(token_hash,owner_id,session_hash,fingerprint,dependencies) VALUES(%s,%s,%s,%s,%s) RETURNING expires_at',(digest(token),who.id,who.token_hash,fingerprint(data),Jsonb(dependencies)))).fetchone()
                result.update(preview=token,expiresAt=row['expires_at'].isoformat())
            return result

    async def submit(self,who,raw,preview):
        await fee_limit(self.db,who)
        data=self.command(who,raw);hashed=fingerprint(data)
        if not isinstance(preview,str) or not 1<=len(preview)<=128:raise HTTPException(422,'映射预览凭证无效')
        async with self.db.connection() as conn,conn.transaction():
            await self.trading.lock(conn,who)
            prior=await(await conn.execute('SELECT fingerprint,result FROM legacy_financial_mapping_receipts WHERE owner_id=%s AND request_id=%s',(who.id,data['requestId']))).fetchone()
            if prior:
                if prior['fingerprint']!=hashed:raise HTTPException(409,'原映射UUID用于其他内容')
                return prior['result']
            proof=await(await conn.execute('SELECT * FROM legacy_financial_mapping_previews WHERE owner_id=%s AND session_hash=%s AND token_hash=%s AND consumed_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE',(who.id,who.token_hash,digest(preview)))).fetchone()
            if not proof or proof['fingerprint']!=hashed:raise HTTPException(409,'映射预览过期、输入或会话已变化')
            result,dependencies,content=await self.plan(conn,who,data)
            if not result['ready'] or dependencies!=proof['dependencies']:raise HTTPException(409,{'message':'映射前驱、来源或账本已变化，请重新预览','blockers':result['blockers']})
            await conn.execute('UPDATE legacy_financial_mapping_previews SET consumed_at=clock_timestamp() WHERE token_hash=%s',(digest(preview),))
            try:
                async with conn.transaction():
                    result={**result,'requestId':data['requestId'],'state':'completed'}
                    await conn.execute('INSERT INTO legacy_financial_mapping_versions(owner_id,request_id,manifest_id,import_request_id,revision,predecessor_id,predecessor_sha256,sha256,content,result) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',(who.id,data['requestId'],data['manifestId'],data['importRequestId'],result['mappingRevision'],content['predecessorId'],content['predecessorSha256'],result['mappingSha256'],Jsonb(content),Jsonb(result)))
                    for index,item in enumerate(content['items']):
                        await conn.execute('INSERT INTO legacy_financial_mapping_items VALUES(%s,%s,%s,%s,%s,%s,%s,%s)',(who.id,data['requestId'],item['objectKind'],item['originalId'],item['sourceInstance'],item['sourceOwner'],item['targetId'],Jsonb(item['canonical'])))
                        if self.after_step:await self.after_step(conn,index,item)
                    if content['predecessorId']:
                        await conn.execute('UPDATE legacy_financial_mapping_heads SET request_id=%s,revision=%s,sha256=%s WHERE owner_id=%s',(data['requestId'],result['mappingRevision'],result['mappingSha256'],who.id))
                    else:
                        await conn.execute('INSERT INTO legacy_financial_mapping_heads VALUES(%s,%s,%s,%s)',(who.id,data['requestId'],result['mappingRevision'],result['mappingSha256']))
                    await conn.execute("INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'legacy-source.canonical-mapped',%s,%s)",(who.id,data['manifestId'],data['requestId']))
                    await conn.execute('SET CONSTRAINTS ALL IMMEDIATE')
            except (DatabaseError,RuntimeError,HTTPException):
                result={'requestId':data['requestId'],'state':'failed','financialApplied':False,'linkedFinancialApplied':False,'failure':'atomic_mapping_rejected','retry':'query_original_uuid_then_repreview'}
            await conn.execute('INSERT INTO legacy_financial_mapping_receipts VALUES(%s,%s,%s,%s)',(who.id,data['requestId'],hashed,Jsonb(result)))
        if self.after_commit:await self.after_commit(result)
        return result

    async def receipt(self,who,request):
        async with self.db.connection() as conn,conn.transaction():
            await source_read_lock(conn,who)
            row=await(await conn.execute('SELECT result FROM legacy_financial_mapping_receipts WHERE owner_id=%s AND request_id=%s',(who.id,request))).fetchone()
            if not row:raise HTTPException(404,'原映射UUID尚无回执')
            return row['result']

    async def head(self,who):
        async with self.db.connection() as conn,conn.transaction():
            await source_read_lock(conn,who)
            row=await(await conn.execute('SELECT v.* FROM legacy_financial_mapping_heads h JOIN legacy_financial_mapping_versions v ON v.owner_id=h.owner_id AND v.request_id=h.request_id WHERE h.owner_id=%s',(who.id,))).fetchone()
            return {'head':None} if row is None else {'head':row['result'],'content':row['content']}


async def overlay_inventory_mappings(conn,owner,head,orders):
    """Derived read overlay. The immutable source inventory remains byte-identical."""
    if not head:return head,orders
    mapping=await(await conn.execute('SELECT v.* FROM legacy_financial_mapping_heads h JOIN legacy_financial_mapping_versions v ON v.owner_id=h.owner_id AND v.request_id=h.request_id JOIN legacy_source_view_bindings b ON b.owner_id=v.owner_id AND b.manifest_id=v.manifest_id AND b.view_kind=\'fees\' AND b.view_sha256=%s WHERE h.owner_id=%s',(head['source_digest'],owner))).fetchone()
    if not mapping:return {**head,'mappingRevision':None,'mappingSha256':None},orders
    items={i['originalId']:i for i in mapping['content']['items'] if i['objectKind']=='order'}
    result=[]
    for row in orders:
        item=items.get(row['original_order_id']);row=dict(row)
        if item:
            canonical=item['canonical']
            row.update(mapped_broker_id=canonical['account_id'],trade_id=UUID(canonical['id']) if canonical['rowType']=='trade' else None,mapping_request_id=mapping['request_id'])
        result.append(row)
    return {**head,'complete':bool(head.get('sourceDeclaredComplete',head['complete'])),'sourceEvidenceVerified':True,'newFinancialAuthorized':bool(head.get('sourceVerified')),'mappingRevision':mapping['revision'],'mappingSha256':mapping['sha256'],'mappingManifestId':str(mapping['manifest_id'])},result
