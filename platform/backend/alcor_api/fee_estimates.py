"""Verified existing-book fee assessments. No cash, position or actual-fee writes."""
import json
import secrets
import re
from datetime import datetime
from decimal import Decimal
from uuid import UUID,uuid4

from fastapi import HTTPException
from psycopg import Error as DatabaseError
from psycopg.types.json import Jsonb
from alcor_api.broker_accounts import broker_account
from alcor_api.fee_plans import fee_limit
from alcor_api.fee_rules import VERSION,plan as fee_plan
from alcor_api.security import digest
from alcor_api.trading import Trading,fingerprint
from alcor_api.source_mapping import CURRENCY,legacy_settlement_currency
from .estimate_model import BaselineError,assess
from .registered_baseline_verifier import RegisteredBaselineVerifier,value,exact


def as_uuid(value):
    try:return str(UUID(str(value)))
    except (ValueError,TypeError,AttributeError):raise HTTPException(422,'估算UUID无效') from None


async def json_hash(conn,data):
    return (await(await conn.execute("SELECT encode(sha256(convert_to(%s::jsonb::text,'UTF8')),'hex') value",(Jsonb(data),))).fetchone())['value']


class FeeEstimates:
    def __init__(self,db,authority):
        self.db=db;self.authority=authority;self.trading=Trading(db)
        self.after_step=None;self.after_commit=None
        self.verifier=RegisteredBaselineVerifier(db,authority)

    def command(self,who,raw):
        keys={'requestId','manifestId','targetUserId','brokerAccountId','expectedRevision','ruleVersion','plan','selections','registeredBaselineConfirmed','estimatedOnlyConfirmed'}
        if not isinstance(raw,dict) or set(raw)!=keys:raise HTTPException(422,'费率估算参数无效')
        if not isinstance(raw['brokerAccountId'],str) or not re.fullmatch(r'ba-[a-f0-9]{24}',raw['brokerAccountId']):raise HTTPException(422,'账户标识无效')
        if raw['targetUserId']!=who.id:raise HTTPException(409,'目标平台内部账号标识与本人不匹配')
        if raw['registeredBaselineConfirmed'] is not True or raw['estimatedOnlyConfirmed'] is not True:raise HTTPException(422,'请明确确认登记基线及仅作费率估算')
        if type(raw['expectedRevision']) is not int or raw['expectedRevision']<0 or raw['ruleVersion']!=VERSION:raise HTTPException(422,'估算版本无效')
        if not isinstance(raw['selections'],list) or not 1<=len(raw['selections'])<=100:raise HTTPException(422,'估算范围无效')
        selected=[];seen=set()
        for item in raw['selections']:
            if not isinstance(item,dict) or set(item)!={'originalOrderId','tradeId','instrumentKind','wholeOrderConfirmed'}:raise HTTPException(422,'须明确逐笔原订单与完整订单确认')
            identifier=item['originalOrderId']
            if not isinstance(identifier,str) or not 1<=len(identifier)<=200 or identifier in seen or any(ord(c)<32 or ord(c)==127 for c in identifier):raise HTTPException(422,'原订单标识无效')
            if item['wholeOrderConfirmed'] is not True or item['instrumentKind'] not in ('us_domestic_equity','us_etf','cn_a_equity','unknown'):raise HTTPException(422,'须明确逐笔证券类型与完整订单')
            selected.append({**item,'tradeId':as_uuid(item['tradeId']) if item['tradeId'] is not None else None});seen.add(identifier)
        return {**raw,'requestId':as_uuid(raw['requestId']),'manifestId':as_uuid(raw['manifestId']),'selections':sorted(selected,key=lambda i:i['originalOrderId'])}

    async def plan(self,conn,who,data):
        account=await broker_account(conn,who.id,data['brokerAccountId'])
        try:confirmed_plan=fee_plan(data['plan'],account['provider_id'])
        except ValueError:raise HTTPException(422,'请明确确认历史费率期间') from None
        previous=await(await conn.execute('SELECT * FROM legacy_fee_estimation_heads WHERE owner_id=%s AND account_id=%s',(who.id,account['id']))).fetchone()
        if data['expectedRevision']!=(previous['revision'] if previous else 0):raise HTTPException(409,'估算前驱已变化')
        context=await self.verifier.verify(conn,who,data,estimate_market=True)
        original=context['original'];assessments=[]
        for record_id,group in context['groups'].items():
            try:assessment=assess(account['provider_id'],confirmed_plan,group['kind'],group['sourceHistory'],group['targetHistory'],group['selections'],registered_target_cash=group['cash'],unknown_outside_record=group['cashUnknownOutside'])
            except BaselineError as exc:raise HTTPException(409,'已有登记与原经济前缀不一致：'+str(exc)) from None
            assessments.append({'recordId':record_id,**assessment})
        stable={**context['stable'],'headRevision':previous['revision'] if previous else 0}
        result={'ready':bool(assessments) and any(item['orders'] for item in assessments),'financialApplied':False,'actualFeeKnown':False,'authority':'rule_calculated','manifestId':str(original['id']),'sourceBlockers':original['manifest']['normalizationBlockers'],'brokerAccountId':account['id'],'targetUserId':who.id,'revision':(previous['revision'] if previous else 0)+1,'assessments':assessments,'excluded':context['excluded']}
        return result,stable,context['bindings'],previous

    async def preview(self,who,raw):
        await fee_limit(self.db,who);data=self.command(who,raw)
        async with self.db.connection() as conn,conn.transaction():
            await self.trading.lock(conn,who)
            result,dependencies,*_=await self.plan(conn,who,data)
            if result['ready']:
                token=secrets.token_urlsafe(32)
                row=await(await conn.execute('INSERT INTO legacy_fee_estimation_previews(token_hash,owner_id,session_hash,fingerprint,dependencies) VALUES(%s,%s,%s,%s,%s) RETURNING expires_at',(digest(token),who.id,who.token_hash,fingerprint(data),Jsonb(dependencies)))).fetchone()
                result.update(preview=token,expiresAt=row['expires_at'].isoformat())
            return result

    async def submit(self,who,raw,preview):
        await fee_limit(self.db,who);data=self.command(who,raw);hashed=fingerprint(data)
        async with self.db.connection() as conn,conn.transaction():
            await self.trading.lock(conn,who)
            prior=await(await conn.execute('SELECT fingerprint,result FROM legacy_fee_estimation_operations WHERE owner_id=%s AND request_id=%s',(who.id,data['requestId']))).fetchone()
            if prior:
                if prior['fingerprint']!=hashed:raise HTTPException(409,'原估算UUID已用于其他内容')
                return prior['result']
            proof=await(await conn.execute('SELECT * FROM legacy_fee_estimation_previews WHERE token_hash=%s AND owner_id=%s AND session_hash=%s AND consumed_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE',(digest(preview),who.id,who.token_hash))).fetchone()
            if not proof or proof['fingerprint']!=hashed:
                return await self.failed(conn,who,data,hashed,409)
            try:result,dependencies,bindings,previous=await self.plan(conn,who,data)
            except HTTPException as exc:return await self.failed(conn,who,data,hashed,exc.status_code)
            if not result['ready'] or proof['dependencies']!=dependencies:return await self.failed(conn,who,data,hashed,409)
            await conn.execute('UPDATE legacy_fee_estimation_previews SET consumed_at=clock_timestamp() WHERE token_hash=%s',(digest(preview),))
            try:
                async with conn.transaction():
                    receipt={**result,'requestId':data['requestId'],'state':'completed'}
                    await conn.execute('INSERT INTO legacy_fee_estimation_operations(owner_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)',(who.id,data['requestId'],hashed,Jsonb(receipt)))
                    await self.verifier.persist(conn,who,data['manifestId'],bindings,after_step=self.after_step)
                    await conn.execute('INSERT INTO legacy_fee_estimates(owner_id,request_id,manifest_id,account_id,revision,previous_request_id,result) VALUES(%s,%s,%s,%s,%s,%s,%s)',(who.id,data['requestId'],data['manifestId'],data['brokerAccountId'],receipt['revision'],previous['request_id'] if previous else None,Jsonb(receipt)))
                    if previous:await conn.execute('UPDATE legacy_fee_estimation_heads SET revision=revision+1,request_id=%s WHERE owner_id=%s AND account_id=%s',(data['requestId'],who.id,data['brokerAccountId']))
                    else:await conn.execute('INSERT INTO legacy_fee_estimation_heads VALUES(%s,%s,1,%s)',(who.id,data['brokerAccountId'],data['requestId']))
                    await conn.execute("INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'fees.rate-assessed',%s,%s)",(who.id,data['brokerAccountId'],data['requestId']))
                    await conn.execute('SET CONSTRAINTS ALL IMMEDIATE')
            except (DatabaseError,HTTPException,RuntimeError):
                receipt={'requestId':data['requestId'],'state':'failed','financialApplied':False,'actualFeeKnown':False,'authority':'rule_calculated','status':409,'failure':'atomic_assessment_rejected'}
                await conn.execute('INSERT INTO legacy_fee_estimation_operations(owner_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)',(who.id,data['requestId'],hashed,Jsonb(receipt)))
        if self.after_commit:await self.after_commit(receipt)
        return receipt

    async def failed(self,conn,who,data,hashed,status):
        result={'requestId':data['requestId'],'state':'failed','financialApplied':False,'actualFeeKnown':False,'authority':'rule_calculated','status':status,'failure':'assessment_proof_or_dependencies_rejected'}
        await conn.execute('INSERT INTO legacy_fee_estimation_operations(owner_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)',(who.id,data['requestId'],hashed,Jsonb(result)))
        return result

    async def receipt(self,who,request):
        async with self.db.connection() as conn,conn.transaction():
            await self.trading.lock(conn,who)
            row=await(await conn.execute('SELECT result FROM legacy_fee_estimation_operations WHERE owner_id=%s AND request_id=%s',(who.id,request))).fetchone()
            if not row:raise HTTPException(404,'原估算UUID尚无回执')
            return row['result']
