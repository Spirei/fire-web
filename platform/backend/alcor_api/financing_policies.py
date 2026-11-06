"""Versioned owner/kind policy metadata over one authoritative signed-cash book."""
from decimal import Decimal
from fractions import Fraction
from uuid import UUID

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .actual_fee_confirmations import identifier
from .fee_repairs import FeeRepairs, hashed
from .financing_model import debt, decimal_text, policy, revision
from .security import digest
from .source_read_access import source_read_lock
from .source_snapshot import canonical, sha


def parse(raw):
    fields={'requestId','targetUserId','accountKind','revision','policy'}
    if not isinstance(raw,dict) or set(raw)!=fields or raw.get('accountKind') not in ('real','simulated') or not isinstance(raw.get('targetUserId'),str):raise HTTPException(422,'请明确本人真实或模拟账本及融资政策')
    if not isinstance(raw['revision'],str) or len(raw['revision'])!=64 or any(c not in '0123456789abcdef' for c in raw['revision']):raise HTTPException(422,'融资政策版本无效')
    return {**raw,'requestId':identifier(raw['requestId']),'policy':policy(raw['policy'])}


async def head(conn,owner,kind):
    row=await(await conn.execute('SELECT v.* FROM financing_policy_heads h JOIN financing_policy_versions v ON v.owner_id=h.owner_id AND v.request_id=h.request_id WHERE h.owner_id=%s AND h.account_kind=%s',(owner,kind))).fetchone()
    value=row['policy'] if row else None
    pending=bool(await(await conn.execute('SELECT 1 FROM legacy_source_heads WHERE owner_id=%s',(owner,))).fetchone())
    imported=None
    installed=await(await conn.execute("SELECT to_regclass('financing_source_policy_heads') name")).fetchone()
    if installed['name']:
        imported=await(await conn.execute('SELECT m.* FROM financing_source_policy_heads h JOIN financing_source_policy_mappings m ON m.owner_id=h.owner_id AND m.request_id=h.request_id JOIN legacy_source_heads s ON s.owner_id=m.owner_id AND s.manifest_id=m.manifest_id WHERE h.owner_id=%s AND h.account_kind=%s',(owner,kind))).fetchone()
    pending=pending and imported is None
    known=row is not None or not pending
    return {'version':1,'targetUserId':owner,'accountKind':kind,'revision':revision(value if known else {'unknown':'legacy_financing_policy_unmigrated'}),'policyKnown':known,'sourceImportRequestId':str(imported['request_id']) if imported else None,'sourcePolicyPending':pending,'policyOrigin':'source_import' if imported and (row is None or row['request_id']==imported['request_id']) else 'owner_recorded' if row else 'unknown' if pending else 'unconfigured','policyRevision':row['revision'] if row else 0,'requestId':str(row['request_id']) if row else None,'policy':value}


async def saved_rates(conn):
    # The same selected immutable FX observation used by the public FX service.
    config=await(await conn.execute('SELECT * FROM fx_config WHERE singleton FOR SHARE')).fetchone()
    observation=await(await conn.execute('SELECT * FROM fx_observations WHERE provider_revision IS NOT DISTINCT FROM %s::uuid ORDER BY source_instant DESC NULLS LAST,observation_date DESC NULLS LAST,received_at DESC,id DESC LIMIT 1',(config['provider_revision'] if config else None,))).fetchone()
    rates={'USD':Fraction(1)}
    if observation:
        rows=await(await conn.execute('SELECT currency,rate,numerator,denominator FROM fx_values WHERE observation_id=%s ORDER BY currency',(observation['id'],))).fetchall()
        from .reference_integrity import fx_observation
        provider=None
        if observation.get('provider_revision') is not None:
            provider=await(await conn.execute('SELECT config FROM fx_provider_revisions WHERE id=%s',(observation['provider_revision'],))).fetchone()
        try:
            fx_observation(observation,rows,provider['config'] if provider else None)
        except (ValueError,TypeError,KeyError,ArithmeticError):
            return rates,{'observationId':str(observation['id']),
                'providerRevision':str(config['provider_revision']) if config and config['provider_revision'] else None,
                'receivedAt':None,'identityCurrencies':['USD'],'fallback':False,'integrityState':'unavailable','state':'retained_unavailable'}
        for row in rows:rates[row['currency']]=Fraction(int(row['numerator']),int(row['denominator'])) if row['numerator'] is not None else Fraction(row['rate'])
    return rates,{'observationId':str(observation['id']) if observation else None,'providerRevision':str(config['provider_revision']) if config and config['provider_revision'] else None,'receivedAt':observation['received_at'].isoformat() if observation else None,'identityCurrencies':['USD'],'fallback':False}


async def cash_state(service,conn,who,kind,currency):
    from .scope_coverage import status
    coverage=await status(conn,who.id)
    accounts=await(await conn.execute('SELECT * FROM broker_accounts WHERE owner_id=%s AND account_kind=%s AND (deleted_at IS NULL OR EXISTS(SELECT 1 FROM cash_ledger_entries e WHERE e.owner_id=broker_accounts.owner_id AND e.account_id=broker_accounts.id)) ORDER BY id LIMIT 10001',(who.id,kind))).fetchall()
    entries=await(await conn.execute('SELECT * FROM cash_ledger_entries WHERE owner_id=%s AND account_kind=%s ORDER BY id LIMIT 10001',(who.id,kind))).fetchall()
    openings=await(await conn.execute('SELECT o.* FROM cash_ledger_accounts o JOIN broker_accounts a ON a.owner_id=o.owner_id AND a.id=o.account_id WHERE o.owner_id=%s AND a.account_kind=%s ORDER BY o.account_id,o.currency',(who.id,kind))).fetchall()
    if len(accounts)>10000 or len(entries)>10000:raise HTTPException(409,'完整融资现金范围超出本次核对上限')
    known={(row['account_id'],row['currency']) for row in openings};reasons=[]
    if not coverage['complete']:reasons.append('whole_owner_financial_scope_unknown')
    if not entries:reasons.append('cash_opening_unrecorded')
    if any((account['id'],code) not in known for account in accounts for code in account['currencies']):reasons.append('account_currency_opening_unrecorded')
    balances={};by_account={}
    from decimal import localcontext
    with localcontext() as context:
        context.prec=80
        for entry in entries:
            if entry['affects_owner']:balances[entry['currency']]=balances.get(entry['currency'],Decimal(0))+entry['amount']
            if entry['account_id'] is not None:
                key=(entry['account_id'],entry['currency']);by_account[key]=by_account.get(key,Decimal(0))+entry['amount']
    for code in balances:
        if not await service.trading.cash.actual_known(conn,who.id,kind,code):reasons.append('actual_cash_or_fee_unknown');break
    rates,fx=await saved_rates(conn);value=None;ratio=None
    if not reasons and currency:
        try:
            ratio=debt(balances,currency,rates);value=decimal_text(ratio)
        except ValueError as error:reasons.append(str(error))
    return {'complete':not reasons,'debtKnown':value is not None,'currency':currency,'debt':value,'basis':'owner_net_cash_by_currency','basisLabel':'同身份同币种净现金负值','brokerGrossLoanKnown':False,'balances':{code:str(value) for code,value in balances.items()} if not reasons else None,'blockers':list(dict.fromkeys(reasons)),'fx':fx,'accounts':[{'accountId':aid,'currency':code,'basis':'account_negative_cash_observation','brokerGrossLoanKnown':False,'registeredBalance':str(amount),'registeredDebt':str(max(Decimal(0),amount.copy_negate())),'debt':str(max(Decimal(0),amount.copy_negate())) if not reasons else None} for (aid,code),amount in by_account.items()]},ratio,{'coverage':coverage,'accounts':accounts,'entries':entries,'openings':openings,'fx':fx}


class FinancingPolicies(FeeRepairs):
    parse_command=staticmethod(parse)
    operation_kind='financing_policy'
    operation_source='owner_recorded'
    failure_message='融资政策未完成，请查询原UUID回执'

    async def consume_budget(self,who):
        async with self.db.connection() as conn,conn.transaction():
            row=await(await conn.execute("INSERT INTO financing_rate_windows VALUES(%s,date_trunc('minute',clock_timestamp()),1) ON CONFLICT(owner_id,minute) DO UPDATE SET count=financing_rate_windows.count+1 RETURNING count",(who.id,))).fetchone()
            if row['count']>30:raise HTTPException(429,'融资政策核对过于频繁')

    async def snapshot(self,who,kind):
        if kind not in ('real','simulated'):raise HTTPException(422,'请选择真实或模拟账本')
        async with self.db.connection() as conn,conn.transaction():
            await source_read_lock(conn,who)
            current=await head(conn,who.id,kind)
            debt_value,used_debt,_=await cash_state(self,conn,who,kind,current['policy']['currency'] if current['policy'] else None)
            exceeded=debt_value['debtKnown'] and current['policy'] is not None and current['policy']['limit'] is not None and used_debt>Fraction(Decimal(current['policy']['limit']))
            return {**current,'debt':debt_value,'exceedsLimit':bool(exceeded) if debt_value['debtKnown'] else None,'brokerExecution':False}

    async def calculate(self,conn,who,data):
        if data['targetUserId']!=who.id:raise HTTPException(403,'融资政策账号不是本人')
        current=await head(conn,who.id,data['accountKind'])
        if current['revision']!=data['revision']:raise HTTPException(409,'融资政策已变化，请重新读取并预览')
        calculated,used,stable=await cash_state(self,conn,who,data['accountKind'],data['policy']['currency'])
        if data['policy']['limit'] is not None:
            if used is None:raise HTTPException(409,{'message':'完整实际现金或已保存汇率尚未核实，不能核对融资总额度','blockers':calculated['blockers']})
            if used>Fraction(Decimal(data['policy']['limit'])):raise HTTPException(409,'额度不能低于已用融资')
        state={'snapshotRevision':hashed({'current':current,'cash':stable})}
        return state,{'version':1,'targetUserId':who.id,'accountKind':data['accountKind'],'before':current,'policy':data['policy'],'revision':revision(data['policy']),'usedDebt':calculated,'brokerExecution':False,'canSubmit':True,'changed':data['policy']!=current['policy']}

    async def commit(self,conn,who,data,fingerprint,cash_revision,preview):
        state,value=await self.calculate(conn,who,data)
        proof=await(await conn.execute('SELECT * FROM trade_fee_previews WHERE token_hash=%s AND owner_id=%s AND session_hash=%s AND expires_at>clock_timestamp() AND consumed_at IS NULL FOR UPDATE',(digest(preview),who.id,who.token_hash))).fetchone()
        if not proof or proof['payload_hash']!=fingerprint or proof['snapshot_hash']!=state['snapshotRevision']:raise HTTPException(409,'政策、现金、汇率或会话已变化，请重新预览')
        previous=value['before'];new_revision=previous['policyRevision']+int(value['changed'])
        if value['changed']:
            raw=canonical(data['policy'])
            await conn.execute('INSERT INTO financing_policy_versions(owner_id,account_kind,request_id,revision,previous_id,policy,policy_raw,policy_sha256,snapshot_sha256) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s)',(who.id,data['accountKind'],data['requestId'],new_revision,previous['requestId'],Jsonb(data['policy']),raw,sha(raw),state['snapshotRevision']))
            if previous['requestId'] is None:
                await conn.execute('INSERT INTO financing_policy_heads VALUES(%s,%s,%s,%s)',(who.id,data['accountKind'],data['requestId'],new_revision))
            else:
                await conn.execute('UPDATE financing_policy_heads SET request_id=%s,revision=%s WHERE owner_id=%s AND account_kind=%s',(data['requestId'],new_revision,who.id,data['accountKind']))
            await conn.execute('UPDATE cash_ledger_collections SET revision=revision+1 WHERE owner_id=%s',(who.id,))
        result={'requestId':data['requestId'],'kind':self.operation_kind,'state':'completed','accountKind':data['accountKind'],'policyRevision':new_revision,'revision':value['revision'],'policy':data['policy'],'brokerExecution':False,'data':value}
        result=await self.decorate_policy_receipt(conn,who,data,result)
        await conn.execute('INSERT INTO trade_operations(owner_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)',(who.id,data['requestId'],fingerprint,Jsonb(result)))
        await conn.execute('UPDATE trade_fee_previews SET consumed_at=clock_timestamp() WHERE token_hash=%s',(digest(preview),))
        await conn.execute("INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'financing.policy',%s,%s)",(who.id,data['accountKind'],data['requestId']))
        return result

    async def decorate_policy_receipt(self,conn,who,data,result):return result

    async def receipt(self,who,request_id):
        result=await self.trading.receipt(who,UUID(str(request_id)))
        if result.get('kind')!=self.operation_kind:raise HTTPException(404,'融资政策原UUID不存在')
        return result
