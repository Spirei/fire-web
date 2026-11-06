"""Pure original registered-book verification; no fee-rate or actual-fee input."""
import re
import secrets
from uuid import UUID,uuid4
from fastapi import HTTPException
from psycopg import Error as DatabaseError
from psycopg.types.json import Jsonb
from .registered_baseline_verifier import RegisteredBaselineVerifier
from .trading import Trading,fingerprint
from .fee_plans import fee_limit
from .security import digest,lock_mutation_identity
from .broker_accounts import broker_account,serialize_brokers


def as_uuid(value):
    try:return str(UUID(value))
    except (ValueError,TypeError,AttributeError):raise HTTPException(422,'原登记基线UUID无效') from None


class RegisteredFeeBaselines:
    def __init__(self,db,authority):
        self.db=db;self.verifier=RegisteredBaselineVerifier(db,authority);self.trading=Trading(db)
        self.after_step=None;self.after_commit=None

    def command(self,who,raw):
        fields={'requestId','manifestId','targetUserId','brokerAccountId','expectedRevision','selections','registeredBaselineConfirmed'}
        if not isinstance(raw,dict) or set(raw)!=fields:raise HTTPException(422,'纯登记基线参数无效；不接受费率或实付金额')
        if raw['targetUserId']!=who.id:raise HTTPException(409,'目标平台内部账号与本人不匹配')
        if not isinstance(raw['brokerAccountId'],str) or not re.fullmatch('ba-[a-f0-9]{24}',raw['brokerAccountId']) or type(raw['expectedRevision']) is not int or raw['expectedRevision']<0:raise HTTPException(422,'基线账户或版本无效')
        if raw['registeredBaselineConfirmed'] is not True or not isinstance(raw['selections'],list) or not 1<=len(raw['selections'])<=100:raise HTTPException(422,'须明确逐笔核对原登记及完整范围')
        selections=[];seen=set()
        for item in raw['selections']:
            if not isinstance(item,dict) or set(item)!={'originalOrderId','tradeId','wholeOrderConfirmed'}:raise HTTPException(422,'须明确原订单及已有本人成交')
            original=item['originalOrderId']
            if not isinstance(original,str) or not 1<=len(original)<=200 or original in seen or any(ord(c)<32 or ord(c)==127 for c in original) or item['wholeOrderConfirmed'] is not True:raise HTTPException(422,'原订单标识或完整订单确认无效')
            try:original.encode('utf8')
            except UnicodeEncodeError:raise HTTPException(422,'原订单标识无效') from None
            selections.append({**item,'tradeId':as_uuid(item['tradeId']) if item['tradeId'] is not None else None});seen.add(original)
        return {**raw,'requestId':as_uuid(raw['requestId']),'manifestId':as_uuid(raw['manifestId']),'selections':sorted(selections,key=lambda item:item['originalOrderId'])}

    async def head(self,who,account):
        async with self.db.connection() as conn,conn.transaction():
            await serialize_brokers(conn,who.id);await lock_mutation_identity(conn,who,require_admin=False);await broker_account(conn,who.id,account)
            row=await(await conn.execute('SELECT revision,request_id FROM registered_fee_baseline_heads WHERE owner_id=%s AND account_id=%s',(who.id,account))).fetchone()
            return {'brokerAccountId':account,'revision':row['revision'] if row else 0,'requestId':str(row['request_id']) if row else None}

    async def plan(self,conn,who,data):
        previous=await(await conn.execute('SELECT * FROM registered_fee_baseline_heads WHERE owner_id=%s AND account_id=%s',(who.id,data['brokerAccountId']))).fetchone()
        if data['expectedRevision']!=(previous['revision'] if previous else 0):raise HTTPException(409,'登记基线前驱已变化，请重新读取')
        internal={**data,'selections':[{**item,'instrumentKind':'unknown'} for item in data['selections']]}
        context=await self.verifier.verify(conn,who,internal)
        groups=context['groups'];original=context['original']
        records=[{'recordId':record_id,'registered':group['registered'],'actualCost':None,'actualRealizedPnl':None,'estimatedFees':None} for record_id,group in groups.items()]
        result={'ready':bool(context['bindings']),'kind':'registered_fee_baseline','authority':'verified_registered_book','financialApplied':False,'actualFeeKnown':False,'estimatedFees':None,'manifestId':str(original['id']),'manifestSha256':original['manifest_sha256'],'brokerAccountId':data['brokerAccountId'],'targetUserId':who.id,'revision':(previous['revision'] if previous else 0)+1,'records':records,'excluded':context['excluded'],'sourceBlockers':original['manifest']['normalizationBlockers']}
        dependencies={**context['stable'],'headRevision':previous['revision'] if previous else 0}
        return result,dependencies,context['bindings'],previous

    async def preview(self,who,raw):
        await fee_limit(self.db,who);data=self.command(who,raw)
        async with self.db.connection() as conn,conn.transaction():
            await serialize_brokers(conn,who.id);await lock_mutation_identity(conn,who,require_admin=False);result,deps,*_=await self.plan(conn,who,data)
            if result['ready']:
                token=secrets.token_urlsafe(32)
                row=await(await conn.execute('INSERT INTO registered_fee_baseline_previews(token_hash,owner_id,session_hash,fingerprint,dependencies) VALUES(%s,%s,%s,%s,%s) RETURNING expires_at',(digest(token),who.id,who.token_hash,fingerprint(data),Jsonb(deps)))).fetchone()
                result.update(preview=token,expiresAt=row['expires_at'].isoformat())
            return result

    async def submit(self,who,raw,preview):
        await fee_limit(self.db,who);data=self.command(who,raw);hashed=fingerprint(data)
        async with self.db.connection() as conn,conn.transaction():
            await serialize_brokers(conn,who.id);await lock_mutation_identity(conn,who,require_admin=False)
            old=await(await conn.execute('SELECT fingerprint,result FROM registered_fee_baseline_operations WHERE owner_id=%s AND request_id=%s',(who.id,data['requestId']))).fetchone()
            if old:
                if old['fingerprint']!=hashed:raise HTTPException(409,'原基线UUID已用于其他内容')
                return old['result']
            proof=await(await conn.execute('SELECT * FROM registered_fee_baseline_previews WHERE owner_id=%s AND token_hash=%s AND session_hash=%s AND consumed_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE',(who.id,digest(preview),who.token_hash))).fetchone()
            try:
                async with conn.transaction():
                    if not proof or proof['fingerprint']!=hashed:raise HTTPException(409,'原登记预览已失效')
                    result,deps,bindings,previous=await self.plan(conn,who,data)
                    if not result['ready'] or deps!=proof['dependencies']:raise HTTPException(409,'原登记、来源或版本已变化')
                    await conn.execute('UPDATE registered_fee_baseline_previews SET consumed_at=clock_timestamp() WHERE token_hash=%s',(digest(preview),))
                    saved=await self.verifier.persist(conn,who,data['manifestId'],bindings,after_step=self.after_step)
                    receipt={**result,'requestId':data['requestId'],'state':'completed','bindings':[{'baselineId':item['id'],'originalOrderId':item['originalOrderId'],'tradeId':item['tradeId'],'recordId':item['recordId']} for item in saved]}
                    await conn.execute('INSERT INTO registered_fee_baseline_operations VALUES(%s,%s,%s,%s,DEFAULT)',(who.id,data['requestId'],hashed,Jsonb(receipt)))
                    for item in saved:
                        await conn.execute('INSERT INTO registered_fee_baseline_verifications(owner_id,id,request_id,baseline_id,first_manifest_id,source_instance,source_owner,original_order_id,trade_id,cash_entry_id,record_id,account_id,registered_fee,actual_fee_known,original_row,canonical_snapshot,prefix_proof) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,0,false,%s,%s,%s)',(who.id,uuid4(),data['requestId'],item['id'],data['manifestId'],item['sourceInstance'],item['sourceOwner'],item['originalOrderId'],item['tradeId'],item['cashEntryId'],item['recordId'],item['accountId'],Jsonb(item['originalRow']),Jsonb(item['canonical']),Jsonb(item['prefix'])))
                    await conn.execute('INSERT INTO registered_fee_baseline_versions VALUES(%s,%s,%s,%s,%s,%s,%s)',(who.id,data['requestId'],data['manifestId'],data['brokerAccountId'],receipt['revision'],previous['request_id'] if previous else None,Jsonb(receipt)))
                    if previous:await conn.execute('UPDATE registered_fee_baseline_heads SET revision=revision+1,request_id=%s WHERE owner_id=%s AND account_id=%s',(data['requestId'],who.id,data['brokerAccountId']))
                    else:await conn.execute('INSERT INTO registered_fee_baseline_heads VALUES(%s,%s,1,%s)',(who.id,data['brokerAccountId'],data['requestId']))
                    await conn.execute("INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'fees.registered-baseline-verified',%s,%s)",(who.id,data['brokerAccountId'],data['requestId']))
                    await conn.execute('SET CONSTRAINTS ALL IMMEDIATE')
            except (HTTPException,DatabaseError,RuntimeError) as error:
                receipt={'requestId':data['requestId'],'kind':'registered_fee_baseline','state':'failed','financialApplied':False,'actualFeeKnown':False,'status':error.status_code if isinstance(error,HTTPException) else 409,'message':'原登记基线未保存，请查询原UUID并重新核对来源和版本'}
                await conn.execute('INSERT INTO registered_fee_baseline_operations VALUES(%s,%s,%s,%s,DEFAULT)',(who.id,data['requestId'],hashed,Jsonb(receipt)))
        if self.after_commit:await self.after_commit(receipt)
        return receipt

    async def receipt(self,who,request):
        async with self.db.connection() as conn,conn.transaction():
            await serialize_brokers(conn,who.id);await lock_mutation_identity(conn,who,require_admin=False)
            row=await(await conn.execute('SELECT result FROM registered_fee_baseline_operations WHERE owner_id=%s AND request_id=%s',(who.id,request))).fetchone()
            if not row:raise HTTPException(404,'原登记基线UUID尚无回执')
            return row['result']
