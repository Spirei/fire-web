"""An explicit owner statement of actual fees, separate from every rate estimate."""
import re
from decimal import Decimal, InvalidOperation, localcontext
from uuid import UUID

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .fee_repair_model import effective_trades, replay
from .fee_repairs import FeeRepairs
from .source_snapshot import canonical, sha
from .trade_accounting import apply_filled_trade, replay_economic_trades


def identifier(value):
    try:return str(UUID(value))
    except (ValueError,TypeError,AttributeError):raise HTTPException(422,'实付确认UUID无效') from None


def amount(value):
    if not isinstance(value,str) or len(value)>80:raise HTTPException(422,'请提供精确的实付费用文本')
    try:
        number=Decimal(value)
        if not number.is_finite() or number<0 or number>=Decimal('1e20') or number.as_tuple().exponent < -18:raise InvalidOperation()
    except InvalidOperation:raise HTTPException(422,'实付费用金额无效') from None
    return format(number,'f')


def valid_text(value,limit,*,multiline=False):
    if not isinstance(value,str) or not 1<=len(value)<=limit:return False
    try:value.encode('utf8')
    except UnicodeEncodeError:return False
    return bool(value.strip()) and not any(ord(c)<32 and (not multiline or c not in '\n\t') or ord(c)==127 for c in value)


def parse_actual(raw):
    fields={'requestId','targetUserId','manifestId','manifestSha256','brokerAccountId','brokerRevision','snapshotRevision','confirmations'}
    if not isinstance(raw,dict) or set(raw)!=fields:raise HTTPException(422,'实际费用确认参数无效')
    data={**raw,'requestId':identifier(raw['requestId']),'manifestId':identifier(raw['manifestId'])}
    if not valid_text(raw['targetUserId'],200) or not isinstance(raw['brokerAccountId'],str) or not re.fullmatch('ba-[a-f0-9]{24}',raw['brokerAccountId']):raise HTTPException(422,'须明确本人平台内部账号与券商标识')
    if type(raw['brokerRevision']) is not int or raw['brokerRevision']<1 or any(not isinstance(raw[key],str) or len(raw[key])!=64 or any(c not in '0123456789abcdef' for c in raw[key]) for key in ('manifestSha256','snapshotRevision')):raise HTTPException(422,'实际费用确认版本无效')
    if not isinstance(raw['confirmations'],list) or not 1<=len(raw['confirmations'])<=500:raise HTTPException(422,'实际费用确认范围无效')
    confirmations=[];seen=set()
    for item in raw['confirmations']:
        keys={'tradeId','originalOrderId','recordRevision','actualFee','currency','authority','actualPaidConfirmed','historicalCashAttributionConfirmed','evidence'}
        if not isinstance(item,dict) or set(item)!=keys:raise HTTPException(422,'须逐笔明确原订单、实付费用及依据')
        evidence=item['evidence'];oid=item['originalOrderId'];tid=identifier(item['tradeId'])
        if tid in seen or not valid_text(oid,200) or type(item['recordRevision']) is not int or item['recordRevision']<1:raise HTTPException(422,'实际费用原订单或记录版本无效')
        if item['currency'] not in ('USD','HKD','CNY'):raise HTTPException(422,'实际费用币种无效')
        if item['authority']!='owner_recorded':raise HTTPException(422,'本人手工确认仅记作owner_recorded；券商来源须独立核验账单')
        if item['actualPaidConfirmed'] is not True or item['historicalCashAttributionConfirmed'] is not True:raise HTTPException(422,'须明确核实实付费用及原现金归属；估算不能代替')
        if not isinstance(evidence,dict) or set(evidence)!={'kind','statement'} or evidence['kind']!='owner_statement' or not valid_text(evidence['statement'],4096,multiline=True):raise HTTPException(422,'须保留本人实付核对声明，不能仅上传金额或自报券商类型')
        confirmations.append({**item,'tradeId':tid,'actualFee':amount(item['actualFee']),'evidence':dict(evidence)});seen.add(tid)
    return {**data,'confirmations':sorted(confirmations,key=lambda item:item['tradeId'])}


class ActualFeeConfirmations(FeeRepairs):
    parse_command=staticmethod(parse_actual)
    operation_kind='actual_fee_confirmation'
    operation_source='owner_recorded'
    audit_action='fees.actual-confirmed'
    cash_note='Owner-confirmed actual historical fee'

    def __init__(self,db,authority):
        super().__init__(db);self.authority=authority

    async def snapshot(self,who,account_id):
        async with self.db.connection() as conn,conn.transaction():
            await self.trading.lock(conn,who)
            state=await self.state(conn,who,account_id)
            rows=await(await conn.execute("SELECT b.original_order_id,b.trade_id,m.id first_manifest_id,b.record_id,r.revision record_revision,m.manifest_sha256,a.actual_fee FROM legacy_fee_baseline_bindings b JOIN portfolio_records r ON r.owner_id=b.owner_id AND r.id=b.record_id LEFT JOIN legacy_source_heads h ON h.owner_id=b.owner_id JOIN legacy_source_manifests m ON m.owner_id=b.owner_id AND m.id=CASE WHEN registered_baseline_authorized_for_manifest(b.owner_id,b.id,h.manifest_id) THEN h.manifest_id ELSE b.first_manifest_id END LEFT JOIN actual_fee_confirmations a ON a.owner_id=b.owner_id AND a.trade_id=b.trade_id WHERE b.owner_id=%s AND b.account_id=%s ORDER BY b.original_order_id LIMIT 10001",(who.id,account_id))).fetchall()
            if len(rows)>10000:raise HTTPException(409,'登记基线超出本次范围，须明确分页')
            items=[{'originalOrderId':row['original_order_id'],'tradeId':str(row['trade_id']),'recordId':row['record_id'],'recordRevision':row['record_revision'],'manifestId':str(row['first_manifest_id']),'manifestSha256':row['manifest_sha256'],'registeredFees':'0','actualFee':None if row['actual_fee'] is None else str(row['actual_fee']),'actualFeeKnown':row['actual_fee'] is not None,'authority':'owner_recorded' if row['actual_fee'] is not None else None} for row in rows]
            return {'targetUserId':who.id,'brokerAccountId':account_id,'brokerRevision':state['account']['revision'],'snapshotRevision':state['snapshotRevision'],'coverageScope':'verified_existing_registered_baselines_only','wholeLegacyFinancialComplete':False,'items':items}

    async def calculate(self,conn,who,data):
        if data['targetUserId']!=who.id:raise HTTPException(403,'目标平台内部账号与本人不匹配')
        original=await(await conn.execute('SELECT * FROM legacy_source_manifests WHERE owner_id=%s AND id=%s',(who.id,data['manifestId']))).fetchone()
        if not original or original['manifest_sha256']!=data['manifestSha256']:raise HTTPException(409,'本人原始来源清单已变化')
        await self.authority.archive_grant(conn,who,original['grant_id'],original['grant_revision'],manifest_id=original['id'])
        head=await(await conn.execute('SELECT manifest_id FROM legacy_source_heads WHERE owner_id=%s',(who.id,))).fetchone()
        if not head or head['manifest_id']!=original['id']:raise HTTPException(409,'来源前驱已变化，请重新核对实际费用')
        if not original['manifest']['coverage']['complete']:raise HTTPException(409,'原表范围尚未核实完整')
        state=await self.state(conn,who,data['brokerAccountId']);account=state['account']
        if account['holding_source']!='manual' or account['account_kind'] not in ('real','simulated'):raise HTTPException(409,'官方或身份未知账户不能手工更正实际费用')
        if account['revision']!=data['brokerRevision'] or state['snapshotRevision']!=data['snapshotRevision']:raise HTTPException(409,'账户、成交、来源或资金已变化')
        fills={str(row['id']):row for row in state['fills']};records={row['id']:row for row in state['records']}
        corrected={row['trade_id']:row for row in state['corrections']}
        from .actual_projection import confirmed_actual_fees
        confirmed=await confirmed_actual_fees(conn,who.id)
        actual_corrections={row['trade_id']:row['actual_fee'] for row in confirmed}
        candidates=[];currency=None
        for item in data['confirmations']:
            row=fills.get(item['tradeId']);record=records.get(row['record_id']) if row else None
            if not row or not record or row['account_id']!=account['id']:raise HTTPException(404,'本人成交不存在')
            from .position_transfer_checkpoint import assert_after_opening
            assert_after_opening(record,row)
            if row['source'] not in ('legacy_import_zero','unverified_legacy') or row['fees']!=0 or row['side'] not in ('buy','sell'):raise HTTPException(409,'已有明确实付费用受到保护，不能覆盖')
            if row['id'] in corrected:raise HTTPException(409,'原费用已有更正回执，须保留原UUID及更正链')
            if record['revision']!=item['recordRevision']:raise HTTPException(409,'记录已变化')
            if row['currency']!=row['settlement_currency'] or row['settlement_amount'] is not None or item['currency']!=row['currency']:raise HTTPException(409,'实际费用须与原实际结算币种一致；跨币须独立核对')
            if currency is not None and currency!=item['currency']:raise HTTPException(409,'一次实际费用确认不能合并不同币种')
            currency=item['currency']
            baseline=await(await conn.execute('SELECT * FROM legacy_fee_baseline_bindings WHERE owner_id=%s AND trade_id=%s AND original_order_id=%s AND registered_baseline_authorized_for_manifest(owner_id,id,%s)',(who.id,row['id'],item['originalOrderId'],original['id']))).fetchone()
            if not baseline:raise HTTPException(409,'须先核实原订单与已有登记的经济前缀及原现金基线')
            snapshot=(await(await conn.execute('SELECT legacy_fee_registered_target_snapshot(%s,%s) value',(who.id,row['id']))).fetchone())['value']
            if snapshot!=baseline['canonical_snapshot']:raise HTTPException(409,'原登记经济输入已变化')
            fact=original['manifest']['orderFacts'].get(item['originalOrderId'],{})
            if fact.get('actualFeeKnown') is not False or fact.get('registeredFee') is None or Decimal(fact['registeredFee'])!=0:raise HTTPException(409,'原实际费用已明确或登记值缺失，不能按0占位')
            content={'kind':'owner_statement','authority':'owner_recorded','statement':item['evidence']['statement'],
                     'manifestSha256':original['manifest_sha256'],'originalOrderId':item['originalOrderId'],
                     'tradeId':str(row['id']),'brokerAccountId':account['id'],'providerId':account['provider_id'],'currency':currency,'actualFee':item['actualFee'],
                     'targetUserId':who.id,'actualPaidConfirmed':True,'historicalCashAttributionConfirmed':True}
            candidates.append({'orderId':str(row['id']),'recordId':record['id'],'oldFees':'0','newFees':item['actualFee'],'feeDelta':item['actualFee'],
                               'authority':'owner_recorded','actualFeeKnown':True,'kind':'actual_fee_confirmation',
                               'baselineId':str(baseline['id']),'manifestId':str(original['id']),
                               'originalOrderId':item['originalOrderId'],'evidence':content,'evidenceSha256':sha(canonical(content)),
                               'components':[{'kind':'actual_paid','amount':item['actualFee'],'currency':currency}],
                               'confirmation':{'legacyImportConfirmed':True,'actualPaidConfirmed':True}})
        effects=[]
        with localcontext() as context:
            context.prec=80
            for rid in {item['recordId'] for item in candidates}:
                history=sorted((row for row in state['fills'] if row['record_id']==rid),key=lambda row:row['before_record_revision'])
                record=records[rid];projections=[row for row in state['projections'] if row['record_id']==rid]
                if any(row.get('calculated_fee_pending') and str(row['id']) not in {item['orderId'] for item in candidates} for row in history):raise HTTPException(409,'同证券有计算费用尚无独立实付依据，不能把登记成本更正冒充实际完整成本')
                try:
                    initial,events=replay(history,record,actual_corrections,projections)
                    proposed={**actual_corrections,**{UUID(item['orderId']):Decimal(item['newFees']) for item in candidates if item['recordId']==rid}}
                    from .position_transfer_checkpoint import current_rows, economic_initial
                    history=current_rows(history,record)
                    changed=effective_trades(history,proposed)
                    position=initial
                    for event in changed:position=apply_filled_trade(position,event).position
                    economic_opening=economic_initial(record,initial)
                    before=replay_economic_trades(economic_opening,events);after=replay_economic_trades(economic_opening,changed)
                except ValueError:raise HTTPException(409,'原持仓与完整经济历史需要核对') from None
                effects.append({'recordId':rid,'quantity':str(position.quantity),'beforeCost':None if record['cost'] is None else str(record['cost']),
                                'afterCost':None if position.cost is None else str(position.cost),
                                'beforeRealizedPnl':None if before.realized_pnl is None else str(before.realized_pnl),
                                'afterRealizedPnl':None if after.realized_pnl is None else str(after.realized_pnl)})
            delta=-sum((Decimal(item['feeDelta']) for item in candidates),Decimal(0))
            registered=sum((row['amount'] for row in state['cash'] if row['account_id']==account['id'] and row['currency']==currency),Decimal(0))
            if registered+delta<0:raise HTTPException(409,'实际费用核对将出现负现金，须先核对融资来源')
            remaining_unknown=any(row.get('actual_fee_pending') and row['id'] not in actual_corrections and str(row['id']) not in {item['orderId'] for item in candidates} for row in state['fills'] if row['account_id']==account['id'] and row['settlement_currency']==currency)
            from .registered_account_coverage import registered_account_known
            if not await registered_account_known(conn,who.id,account['id'],currency,proposed={UUID(item['orderId']) for item in candidates}):remaining_unknown=True
            cash={'currency':currency,'before':None,'after':None,'delta':str(delta),'registeredBrokerBefore':str(registered),
                  'brokerBefore':None,'brokerAfter':None if remaining_unknown else str(registered+delta),'brokerDelta':str(delta),'unallocatedDelta':'0','externalFlow':'0'}
        value={'version':1,'targetUserId':who.id,'brokerAccountId':account['id'],'snapshotRevision':state['snapshotRevision'],
               'manifestId':str(original['id']),'authority':'owner_recorded','actualFeeKnown':True,'financialApplied':True,
               'candidates':candidates,'positionEffects':effects,'cashEffect':cash,'canSubmit':bool(candidates),'excluded':[],
               'unresolvedSourceBlockers':original['manifest']['normalizationBlockers']}
        return state,value

    def correction_detail(self,item,data):return dict(item)

    async def before_post(self,conn,who,data,state,value):
        for item in value['candidates']:
            await conn.execute('INSERT INTO actual_fee_confirmations(owner_id,request_id,trade_id,manifest_id,baseline_id,actual_fee,currency,authority,evidence,evidence_raw,evidence_sha256) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',
                               (who.id,data['requestId'],item['orderId'],data['manifestId'],item['baselineId'],item['newFees'],item['components'][0]['currency'],'owner_recorded',Jsonb(item['evidence']),canonical(item['evidence']),item['evidenceSha256']))

    def completed_result(self,data,value,revision):
        return {**super().completed_result(data,value,revision),'financialApplied':True,'actualFeeKnown':True,'authority':'owner_recorded'}
