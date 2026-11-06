"""Owner-confirmed actual fees for completed native calculated-fee registrations."""
from decimal import Decimal, localcontext
from uuid import UUID

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .actual_fee_confirmations import amount, identifier, valid_text
from .fee_repair_model import effective_trades, replay
from .fee_repairs import FeeRepairs
from .source_snapshot import canonical, sha
from .trade_accounting import apply_filled_trade, replay_economic_trades


def parse_native_actual(raw):
    keys={'requestId','targetUserId','brokerAccountId','brokerRevision','snapshotRevision','confirmations'}
    if not isinstance(raw,dict) or set(raw)!=keys:raise HTTPException(422,'原生实付确认参数无效')
    if not valid_text(raw['targetUserId'],200) or not valid_text(raw['brokerAccountId'],200):raise HTTPException(422,'须明确本人账号与券商账户')
    if type(raw['brokerRevision']) is not int or raw['brokerRevision']<1:raise HTTPException(422,'账户版本无效')
    if not isinstance(raw['snapshotRevision'],str) or len(raw['snapshotRevision'])!=64 or any(c not in '0123456789abcdef' for c in raw['snapshotRevision']):raise HTTPException(422,'成交与资金版本无效')
    if not isinstance(raw['confirmations'],list) or not 1<=len(raw['confirmations'])<=500:raise HTTPException(422,'须明确逐笔实付范围')
    items=[];seen=set()
    for item in raw['confirmations']:
        required={'tradeId','registrationRequestId','registrationSha256','recordRevision','actualFee','currency','authority','actualPaidConfirmed','historicalCashAttributionConfirmed','evidence'}
        if not isinstance(item,dict) or set(item)!=required:raise HTTPException(422,'须逐笔保留原完成回执、实付金额与本人依据')
        tid=identifier(item['tradeId']);oid=identifier(item['registrationRequestId']);proof=item['registrationSha256']
        if tid in seen or type(item['recordRevision']) is not int or item['recordRevision']<1:raise HTTPException(422,'成交或记录版本无效')
        if not isinstance(proof,str) or len(proof)!=64 or any(c not in '0123456789abcdef' for c in proof):raise HTTPException(422,'原完成登记摘要无效')
        if item['currency'] not in ('USD','HKD','CNY'):raise HTTPException(422,'实付币种无效')
        if item['authority']!='owner_recorded':raise HTTPException(422,'本人确认仅记录owner_recorded；不能自报券商账单身份')
        if item['actualPaidConfirmed'] is not True or item['historicalCashAttributionConfirmed'] is not True:raise HTTPException(422,'须明确核实实付费用和原现金归属')
        evidence=item['evidence']
        if not isinstance(evidence,dict) or set(evidence)!={'kind','statement'} or evidence['kind']!='owner_statement' or not valid_text(evidence['statement'],4096,multiline=True):raise HTTPException(422,'请填写本人实际费用核对依据，估算金额不构成实付证明')
        items.append({**item,'tradeId':tid,'registrationRequestId':oid,'actualFee':amount(item['actualFee']),'evidence':dict(evidence)});seen.add(tid)
    return {**raw,'requestId':identifier(raw['requestId']),'confirmations':sorted(items,key=lambda item:item['tradeId'])}


async def registrations(conn,owner,ids):
    rows=await(await conn.execute("""WITH originals AS MATERIALIZED(
      SELECT t.id,native_fee_registration_snapshot(t.owner_id,t.id) value FROM trade_ledger t WHERE t.owner_id=%s AND t.id=ANY(%s::uuid[]))
      SELECT id,value,encode(sha256(convert_to(value::text,'UTF8')),'hex') hash FROM originals WHERE value IS NOT NULL""",(owner,ids))).fetchall()
    return {str(row['id']):row for row in rows}


class NativeActualFeeConfirmations(FeeRepairs):
    parse_command=staticmethod(parse_native_actual)
    operation_kind='native_actual_fee_confirmation'
    operation_source='owner_recorded'
    audit_action='fees.native-actual-confirmed'
    cash_note='Owner-confirmed native actual fee difference'

    async def snapshot(self,who,account_id):
        async with self.db.connection() as conn,conn.transaction():
            await conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
            state=await self.state(conn,who,account_id)
            fills=[row for row in state['fills'] if row['account_id']==account_id]
            originals=await registrations(conn,who.id,[row['id'] for row in fills])
            records={row['id']:row for row in state['records']}
            actual={row['trade_id']:row for row in state['actualConfirmations']}
            corrections={row['trade_id']:row for row in state['corrections']}
            items=[]
            for row in fills:
                original=originals.get(str(row['id']));record=records.get(row['record_id'])
                if not original or not record:continue
                from .position_transfer_checkpoint import opening
                boundary=opening(record)
                transfer_blocked=boundary is not None and row['before_record_revision']<=boundary['revision']
                confirmed=actual.get(row['id'])
                items.append({'tradeId':str(row['id']),'recordId':record['id'],'recordRevision':record['revision'],
                  'registrationRequestId':str(row['request_id']),'registrationSha256':original['hash'],
                  'currency':row['currency'],'registeredFees':str(row['fees']),'estimatedFees':str(row['fees']),
                  'actualFee':None if not confirmed else str(confirmed['actual_fee']),'actualFeeKnown':bool(confirmed),
                  'authority':'owner_recorded' if confirmed else None,'canConfirm':not transfer_blocked and not confirmed and row['id'] not in corrections,'positionTransferBlocked':transfer_blocked,
                  'occurredAt':row['occurred_at'].isoformat(),'code':record['code'],'side':row['side']})
            return {'targetUserId':who.id,'brokerAccountId':account_id,'brokerRevision':state['account']['revision'],
                    'snapshotRevision':state['snapshotRevision'],'coverageScope':'completed_native_calculated_fee_registrations_only',
                    'items':items}

    async def calculate(self,conn,who,data):
        if data['targetUserId']!=who.id:raise HTTPException(403,'目标账号不是本人')
        state=await self.state(conn,who,data['brokerAccountId']);account=state['account']
        if account['holding_source']!='manual' or account['account_kind'] not in ('real','simulated'):raise HTTPException(409,'此账户不支持本人手工实付确认')
        if account['revision']!=data['brokerRevision'] or state['snapshotRevision']!=data['snapshotRevision']:raise HTTPException(409,'账户、成交或资金已变化，请重新核对')
        fills={str(row['id']):row for row in state['fills']};records={row['id']:row for row in state['records']}
        corrected={str(row['trade_id']) for row in state['corrections']}
        actual={row['trade_id']:row['actual_fee'] for row in state['actualConfirmations']}
        originals=await registrations(conn,who.id,[item['tradeId'] for item in data['confirmations']])
        candidates=[];currency=None
        with localcontext() as context:
            context.prec=80
            for item in data['confirmations']:
                row=fills.get(item['tradeId']);original=originals.get(item['tradeId']);record=records.get(row['record_id']) if row else None
                if not row or row['account_id']!=account['id'] or not record:raise HTTPException(404,'本人成交不存在')
                from .position_transfer_checkpoint import assert_after_opening
                assert_after_opening(record,row)
                if not original:raise HTTPException(409,'须有原生完成登记、计算费用原始依据和原现金归属；旧导入成交不能走此入口')
                if item['tradeId'] in corrected:raise HTTPException(409,'此费用已有更正，请查询原UUID及原更正链')
                if item['registrationRequestId']!=str(row['request_id']) or item['registrationSha256']!=original['hash'] or item['recordRevision']!=record['revision']:raise HTTPException(409,'原完成登记或记录版本已变化')
                if item['currency']!=row['currency'] or currency is not None and item['currency']!=currency:raise HTTPException(409,'一次确认只处理同一原实际结算币种')
                currency=item['currency'];paid=Decimal(item['actualFee'])
                evidence={'kind':'owner_statement','authority':'owner_recorded','targetUserId':who.id,'tradeId':item['tradeId'],
                  'registrationRequestId':item['registrationRequestId'],'registrationSha256':original['hash'],
                  'brokerAccountId':account['id'],'providerId':account['provider_id'],'currency':currency,'actualFee':item['actualFee'],
                  'actualPaidConfirmed':True,'historicalCashAttributionConfirmed':True,'statement':item['evidence']['statement']}
                candidates.append({'orderId':item['tradeId'],'recordId':record['id'],'oldFees':str(row['fees']),
                  'newFees':item['actualFee'],'feeDelta':str(paid-row['fees']),'kind':self.operation_kind,
                  'authority':'owner_recorded','actualFeeKnown':True,'registrationSha256':original['hash'],
                  'evidence':evidence,'evidenceSha256':sha(canonical(evidence)),
                  'components':[{'kind':'actual_paid','amount':item['actualFee'],'currency':currency}]})
            proposed={**actual,**{UUID(item['orderId']):Decimal(item['newFees']) for item in candidates}}
            effects=[]
            for rid in sorted({item['recordId'] for item in candidates}):
                history=sorted((row for row in state['fills'] if row['record_id']==rid),key=lambda row:row['before_record_revision'])
                record=records[rid];projections=[row for row in state['projections'] if row['record_id']==rid]
                try:
                    initial,before_events=replay(history,record,actual,projections)
                    from .position_transfer_checkpoint import current_rows, economic_initial
                    history=current_rows(history,record)
                    after_events=effective_trades(history,proposed)
                    # The PG position remains the effective registered book. A
                    # separate actual projection never fills unknown fees with zero.
                    position=initial
                    for current_event in effective_trades(history,proposed,registered=True):position=apply_filled_trade(position,current_event).position
                    actual_position=initial
                    for event in after_events:actual_position=apply_filled_trade(actual_position,event).position
                    economic_opening=economic_initial(record,initial)
                    before=replay_economic_trades(economic_opening,before_events);after=replay_economic_trades(economic_opening,after_events)
                except ValueError:raise HTTPException(409,'完整原成交与持仓更正链尚未核对') from None
                unknown_after=any(row.get('actual_fee_pending') and row['id'] not in proposed for row in history)
                effects.append({'recordId':rid,'quantity':str(position.quantity),'beforeCost':None if record['cost'] is None else str(record['cost']),
                  'afterCost':None if position.cost is None else str(position.cost),'costBasis':'effective_registered_book',
                  'actualBeforeCost':None if any(row.get('actual_fee_pending') for row in history) else str(record['cost']) if record['cost'] is not None else None,
                  'actualAfterCost':None if unknown_after or actual_position.cost is None else str(actual_position.cost),
                  'beforeRealizedPnl':None if any(row.get('actual_fee_pending') for row in history) or before.realized_pnl is None else str(before.realized_pnl),
                  'afterRealizedPnl':None if unknown_after or after.realized_pnl is None else str(after.realized_pnl),'actualCostKnown':not unknown_after})
            delta=-sum((Decimal(item['feeDelta']) for item in candidates),Decimal(0))
            registered=sum((row['amount'] for row in state['cash'] if row['account_id']==account['id'] and row['currency']==currency),Decimal(0))
            if registered+delta<0:raise HTTPException(409,'实付差额导致负现金，须先核对真实融资或资金来源')
            from .registered_account_coverage import registered_account_known
            remaining=any(row.get('actual_fee_pending') and row['id'] not in proposed for row in state['fills'] if row['account_id']==account['id'] and row['settlement_currency']==currency)
            if not await registered_account_known(conn,who.id,account['id'],currency,proposed=set(proposed)):remaining=True
            cash={'currency':currency,'before':None,'after':None,'delta':str(delta),'registeredBrokerBefore':str(registered),
              'registeredBrokerAfter':str(registered+delta),'brokerBefore':None,'brokerAfter':None if remaining else str(registered+delta),
              'brokerDelta':str(delta),'unallocatedDelta':'0','externalFlow':'0','income':'0','actualBrokerAfterKnown':not remaining}
        value={'version':1,'targetUserId':who.id,'brokerAccountId':account['id'],'snapshotRevision':state['snapshotRevision'],
          'authority':'owner_recorded','actualFeeKnown':True,'financialApplied':True,'candidates':candidates,'positionEffects':effects,
          'cashEffect':cash,'canSubmit':bool(candidates),'excluded':[]}
        return state,value

    def correction_detail(self,item,data):return dict(item)

    async def before_post(self,conn,who,data,state,value):
        originals=await registrations(conn,who.id,[item['orderId'] for item in value['candidates']])
        for item in value['candidates']:
            original=originals[item['orderId']]
            await conn.execute('INSERT INTO native_actual_fee_confirmations(owner_id,request_id,trade_id,registered_fee,actual_fee,currency,authority,registration_snapshot,registration_sha256,evidence,evidence_raw,evidence_sha256) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',
              (who.id,data['requestId'],item['orderId'],item['oldFees'],item['newFees'],item['components'][0]['currency'],'owner_recorded',Jsonb(original['value']),original['hash'],Jsonb(item['evidence']),canonical(item['evidence']),item['evidenceSha256']))

    def completed_result(self,data,value,revision):
        return {**super().completed_result(data,value,revision),'financialApplied':True,'actualFeeKnown':True,'authority':'owner_recorded'}
