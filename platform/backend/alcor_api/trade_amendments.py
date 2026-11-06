"""Single native manual ledger amendment; no broker instruction or raw mutation."""
from datetime import datetime
from decimal import Decimal, InvalidOperation, localcontext
from uuid import UUID, uuid4, uuid5

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .actual_fee_confirmations import identifier, valid_text
from .actual_projection import first_unknown_revision
from .fee_repair_model import replay as verify_registered
from .fee_repairs import FeeRepairs
from .internal_orders import pending_reservations
from .security import digest
from .source_snapshot import canonical, sha
from .trade_amendment_model import HistoryError, event, replay_events


def precise(value,*,positive=False):
    try:
        if not isinstance(value,str) or len(value)>80:raise ValueError()
        number=Decimal(value)
        if not number.is_finite() or number<0 or positive and number==0 or number>Decimal('1e12') or number.as_tuple().exponent < -8:raise ValueError()
        return format(number,'f')
    except (ValueError,InvalidOperation):raise HTTPException(422,'更正数量、价格与实付费用须为精确有效文本') from None


def parse(raw):
    keys={'requestId','targetUserId','brokerAccountId','brokerRevision','snapshotRevision','recordId','recordRevision','tradeId','expectedAmendmentId','action','replacement','evidence'}
    if not isinstance(raw,dict) or raw.get('action') not in ('amend','merge','delete') or set(raw)-{'financingConfirmation'}!=(keys|({'members'} if raw.get('action')=='merge' else set())):raise HTTPException(422,'须明确成交更正、合并或删除及全部原单版本')
    if any(not valid_text(raw[key],200) for key in ('targetUserId','brokerAccountId','recordId')):raise HTTPException(422,'更正目标无效')
    if any(type(raw[key]) is not int or raw[key]<1 for key in ('brokerRevision','recordRevision')):raise HTTPException(422,'更正版本无效')
    if not isinstance(raw['snapshotRevision'],str) or len(raw['snapshotRevision'])!=64 or any(c not in '0123456789abcdef' for c in raw['snapshotRevision']):raise HTTPException(422,'完整历史版本无效')
    evidence=raw['evidence'];replacement=raw['replacement']
    if not isinstance(evidence,dict) or set(evidence)!={'authority','kind','statement','actualPaidConfirmed','ledgerCorrectionConfirmed'} or evidence['authority']!='owner_recorded' or evidence['kind']!='owner_statement' or evidence['actualPaidConfirmed'] is not True or evidence['ledgerCorrectionConfirmed'] is not True or not valid_text(evidence['statement'],4096,multiline=True):raise HTTPException(422,'须本人核实成交与实付费用，并明确仅更正内部账本')
    primary=identifier(raw['tradeId']);previous=identifier(raw['expectedAmendmentId']) if raw['expectedAmendmentId'] is not None else None
    if raw['action']=='delete':
        if replacement is not None:raise HTTPException(422,'删除不接受替换成交或费用')
        changed=None
    else:
        if not isinstance(replacement,dict) or set(replacement)!={'quantity','price','fees','occurredAt'}:raise HTTPException(422,'须明确更正数量、价格、实付费用与原时区')
        try:
            if not isinstance(replacement['occurredAt'],str) or len(replacement['occurredAt'])>50:raise ValueError()
            when=datetime.fromisoformat(replacement['occurredAt'])
            if when.tzinfo is None:raise ValueError()
        except ValueError:raise HTTPException(422,'成交时间须保留明确时区') from None
        with localcontext() as context:
            context.prec=80
            changed={key:precise(replacement[key],positive=key in ('quantity','price')) for key in ('quantity','price','fees')}
            if Decimal(changed['quantity'])*Decimal(changed['price'])>Decimal('1e12'):raise HTTPException(422,'更正成交额超出范围')
        changed['occurredAt']=when.isoformat()
    result={**raw,'requestId':identifier(raw['requestId']),'tradeId':primary,'expectedAmendmentId':previous,'replacement':changed,'evidence':dict(evidence)}
    if 'financingConfirmation' in raw:
        from .financing_model import confirmation
        result['financingConfirmation']=confirmation(raw['financingConfirmation'])
    if raw['action']=='merge':
        if not isinstance(raw['members'],list) or not 2<=len(raw['members'])<=100:raise HTTPException(422,'合并须选择二至一百笔有效原单')
        members=[]
        for member in raw['members']:
            if not isinstance(member,dict) or set(member)!={'tradeId','expectedAmendmentId'}:raise HTTPException(422,'原单成员版本无效')
            members.append({'tradeId':identifier(member['tradeId']),'expectedAmendmentId':identifier(member['expectedAmendmentId']) if member['expectedAmendmentId'] is not None else None})
        if len({row['tradeId'] for row in members})!=len(members) or {'tradeId':primary,'expectedAmendmentId':previous} not in members:raise HTTPException(422,'原单重复或时间来源单版本不符')
        result['members']=members
    return result


class TradeAmendments(FeeRepairs):
    def __init__(self,db,authority=None):
        super().__init__(db)
        self.authority=authority

    parse_command=staticmethod(parse)
    operation_kind='trade_amendment'
    operation_source='owner_recorded'
    allow_flat_net_settlement=False
    allow_flat_side_change=False
    failure_message='成交更正未完成，请查询原UUID回执'

    async def receipt(self,who,request_id):
        result=await self.trading.receipt(who,UUID(str(request_id)))
        if result.get('kind')!=self.operation_kind:raise HTTPException(404,'成交更正原请求回执不存在')
        return result

    async def ready(self,conn):
        row=await(await conn.execute("SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE name='0067_imported_trade_correction_authority.sql') ready")).fetchone()
        if not row['ready']:raise HTTPException(503,'成交更正所需数据库兼容迁移尚未完成')

    async def snapshot(self,who,record_id):
        async with self.db.connection() as conn,conn.transaction():
            await conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
            from .security import lock_mutation_identity
            await lock_mutation_identity(conn,who,require_admin=False)
            await self.ready(conn)
            record=await(await conn.execute('SELECT * FROM portfolio_records WHERE owner_id=%s AND id=%s AND deleted_at IS NULL',(who.id,record_id))).fetchone()
            if not record:raise HTTPException(404,'记录不存在')
            if not record['broker_account_id']:raise HTTPException(409,'记录没有明确券商账户')
            state=await self.state(conn,who,record['broker_account_id'])
            rows=sorted((row for row in state['fills'] if row['record_id']==record_id),key=lambda row:row['before_record_revision'])
            if len(rows)>5000:raise HTTPException(409,'完整成交历史超过本次更正核对范围')
            eligible=await(await conn.execute('SELECT id,current_effective_trade_event(owner_id,id) event,amendable_native_registration(owner_id,id) eligible FROM trade_ledger WHERE owner_id=%s AND record_id=%s ORDER BY before_record_revision LIMIT 5001',(who.id,record_id))).fetchall()
            source_authorities=(await(await conn.execute('SELECT source_trade_correction_authorities(%s,%s::uuid[]) value',(who.id,[row['id'] for row in eligible]))).fetchone())['value']
            for row in eligible:
                row['source_authority']=source_authorities.get(str(row['id']));row['eligible']=row['eligible'] or row['source_authority'] is not None
            latest={row['id']:row for row in rows};unknown=await first_unknown_revision(conn,who.id,record_id)
            from .position_transfer_checkpoint import opening
            boundary=opening(record)
            for item in eligible:
                item['transfer_blocked']=boundary is not None and latest[item['id']]['before_record_revision']<=boundary['revision']
            return {'targetUserId':who.id,'brokerAccountId':state['account']['id'],'brokerRevision':state['account']['revision'],
              'recordId':record_id,'recordRevision':record['revision'],'snapshotRevision':state['snapshotRevision'],
              'scope':'manual_actual_correction_actions','mergeReady':True,'deleteReady':True,
              'items':[{'tradeId':str(row['id']),'registrationRequestId':str(latest[row['id']]['request_id']),
                'currentAmendmentId':str(latest[row['id']]['_latest_amendment']['id']) if latest[row['id']].get('_latest_amendment') else None,
                'sourceAuthority':row['source_authority'],'event':row['event'],'active':row['event'] is not None,'actualFeeKnown':not latest[row['id']].get('actual_fee_pending'),
                'blocker':'旧成交不能穿越已确认转仓更正' if row['transfer_blocked'] else '此成交已被合并或删除' if row['event'] is None else '此来源的成交更正尚未接通' if not row['eligible'] else '实付费用尚未核实' if unknown is not None else '该市场更正尚未接通' if record['market'] not in ('US','HK','CN') or record['account_market'] not in ('',record['market']) else None,
                'canAmend':not row['transfer_blocked'] and row['event'] is not None and row['eligible'] and unknown is None and record['market'] in ('US','HK','CN') and record['account_market'] in ('',record['market'])} for row in eligible]}

    async def calculate(self,conn,who,data):
        await self.ready(conn)
        if data['targetUserId']!=who.id:raise HTTPException(403,'更正账号不是本人')
        state=await self.state(conn,who,data['brokerAccountId']);account=state['account']
        records={row['id']:row for row in state['records']};record=records.get(data['recordId'])
        if not record or record['broker_account_id']!=account['id']:raise HTTPException(404,'本人账户记录不存在')
        if record['revision']!=data['recordRevision'] or account['revision']!=data['brokerRevision'] or state['snapshotRevision']!=data['snapshotRevision']:raise HTTPException(409,'完整成交、账户或资金版本已变化')
        flat_net=bool(self.allow_flat_net_settlement and record['market']=='HK' and record['account_market']=='CN')
        if account['holding_source']!='manual' or account['account_kind'] not in ('real','simulated') or record['market'] not in ('US','HK','CN') or record['account_market'] not in ('',record['market']) and not flat_net:raise HTTPException(409,'当前仅支持已明确手工账户同币种现货成交')
        rows=sorted((row for row in state['fills'] if row['record_id']==record['id']),key=lambda row:row['before_record_revision'])
        if not rows or len(rows)>5000:raise HTTPException(409,'须完整有界成交历史及独立期初证据')
        from .position_transfer_checkpoint import (
            assert_after_opening,
            current_rows,
            economic_initial,
            opening,
        )
        members=data.get('members') or [{'tradeId':data['tradeId'],'expectedAmendmentId':data['expectedAmendmentId']}]
        family_schema = await (await conn.execute("SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE name='0115_record_trade_order_families.sql') AS ready")).fetchone()
        if family_schema['ready']:
            identifiers = [member['tradeId'] for member in members]
            attached = await (await conn.execute('''SELECT 1 FROM internal_order_families f
                JOIN internal_order_family_legs l ON l.owner_id=f.owner_id AND l.family_id=f.id
                JOIN internal_orders o ON o.owner_id=l.owner_id AND o.id=l.order_id
                WHERE f.owner_id=%s AND o.status='pending'
                AND (f.parent_trade_id=ANY(%s::uuid[]) OR f.fill_evidence->>'tradeId'=ANY(%s::text[])) LIMIT 1''',
                (who.id,identifiers,identifiers))).fetchone()
            if attached:
                raise HTTPException(409,'原成交仍有生效附加单，请先明确取消相关委托再更正成交来源')
        selected_rows=[];originals={}
        authorities=(await(await conn.execute('SELECT source_trade_correction_authorities(%s,%s::uuid[]) value',(who.id,[member['tradeId'] for member in members]))).fetchone())['value']
        if authorities:
            from .trade_source_authority import lock_source_authorities
            authorities=await lock_source_authorities(self,conn,who,authorities)
        for member in members:
            row=next((row for row in rows if str(row['id'])==member['tradeId']),None)
            if not row:raise HTTPException(404,'本人成交不存在')
            assert_after_opening(record,row)
            original=await(await conn.execute('SELECT current_effective_trade_event(%s,%s) event,amendable_native_registration(%s,%s) eligible',(who.id,row['id'],who.id,row['id']))).fetchone()
            flat_eligible=flat_net and (await(await conn.execute('SELECT amendable_flat_net_registration(%s,%s) eligible',(who.id,row['id']))).fetchone())['eligible']
            if not original['eligible'] and not flat_eligible and member['tradeId'] not in authorities:raise HTTPException(409,'此成交缺少当前有效原单、来源归属、授权或实际费用依据；官方账户不可手动更正')
            if original['event'] is None:raise HTTPException(409,'原单已被合并或删除，须选择当前有效成交')
            current=row.get('_latest_amendment');current_id=str(current['id']) if current else None
            if current_id!=member['expectedAmendmentId']:raise HTTPException(409,'成交更正前驱已变化')
            selected_rows.append(row);originals[member['tradeId']]=original['event']
        selected=next(row for row in selected_rows if str(row['id'])==data['tradeId']);original={'event':originals[data['tradeId']]}
        if len({value['side'] for value in originals.values()})!=1:raise HTTPException(409,'合并只支持同证券同方向实际成交')
        if await first_unknown_revision(conn,who.id,record['id']) is not None:raise HTTPException(409,'完整成交含未核实实付费用，不能用估算或缺失零更正')
        requested_side=(data.get('replacement') or {}).get('side')
        if requested_side is not None and (not self.allow_flat_side_change or data['action']!='amend' or requested_side not in ('buy','sell')):raise HTTPException(422,'此更正入口不接受方向变更')
        side_change=requested_side is not None and requested_side!=original['event']['side']
        currency=selected['settlement_currency'] if flat_net else selected['currency']
        if flat_net:
            if data['action']=='merge' or any(row['currency']!='HKD' or row['settlement_currency']!='CNY' or row['settlement_amount'] is None for row in rows):raise HTTPException(409,'净结算更正须单笔明确港币成交与人民币实际净额')
        elif any(row['settlement_currency']!=currency or row['currency']!=currency or row['settlement_amount'] is not None for row in rows):raise HTTPException(409,'跨币结算或币种不明须独立核对')
        cash_scope={'accountId':account['id'],'accountKind':account['account_kind'],'currency':currency}
        if not await self.trading.cash.account_complete(conn,who,cash_scope):raise HTTPException(409,'本账户原币现金范围或实际费用尚未闭合',headers={'X-Alcor-Financial-Scope':'incomplete'})
        if await(await conn.execute("SELECT 1 FROM internal_orders WHERE owner_id=%s AND record_id=%s AND status='pending'",(who.id,record['id']))).fetchone():raise HTTPException(409,'此记录仍有待处理委托，须先明确处理')
        rows=current_rows(rows,record)
        actual={row['trade_id']:row['actual_fee'] for row in state['actualConfirmations']}
        projections=[row for row in state['projections'] if row['record_id']==record['id']]
        with localcontext() as context:
            context.prec=80
            try:
                initial,_=verify_registered(rows,record,actual,projections)
                from .trade_amendment_history import effective_events
                before_events=effective_events(rows,actual)
                before=replay_events(before_events,initial,verified_opening=opening(record) is not None,economic_initial=economic_initial(record,initial))
                if before.position.quantity!=record['qty'] or before.position.cost!=record['cost']:
                    raise HistoryError('registered_and_actual_cost_basis_require_reconciliation')
                removed=set(originals)
                if data['action']=='delete':replacement={**original['event'],'active':False}
                else:
                    replacement={**original['event'],**{key:data['replacement'][key] for key in ('quantity','price','fees')},
                      'amount':str(Decimal(data['replacement']['quantity'])*Decimal(data['replacement']['price'])),
                      'occurred_at':data['replacement']['occurredAt']}
                    if requested_side is not None:replacement['side']=requested_side
                    if flat_net:
                        replacement.update(settlement_amount=precise(data['replacement']['settlementAmount']),settlement_currency='CNY',currency='HKD')
                    if data['action']=='merge':
                        if datetime.fromisoformat(replacement['occurred_at'])!=datetime.fromisoformat(original['event']['occurred_at']):raise HTTPException(409,'合并时间须明确保留所选原单时间')
                        if Decimal(replacement['quantity'])!=sum((Decimal(item['quantity']) for item in originals.values()),Decimal(0)) or Decimal(replacement['amount'])!=sum((Decimal(item['amount']) for item in originals.values()),Decimal(0)):raise HTTPException(409,'合并数量或本金不守恒，不能舍入加权价格')
                after_events=[item for item in before_events if item['id'] not in removed]
                if data['action']!='delete':after_events.append(event({**selected,**replacement}))
                for changed in after_events:
                    assert_after_opening(record,selected,changed['occurred_at'])
                after=replay_events(after_events,initial,verified_opening=opening(record) is not None,economic_initial=economic_initial(record,initial))
                if data['action']=='amend' and [row['id'] for row in before.rows]!=[row['id'] for row in after.rows]:raise HistoryError('historical_reorder_requires_separate_causal_replay')
            except ValueError as error:
                messages={'registered_and_actual_cost_basis_require_reconciliation':'登记成本与实际费用投影须先独立核对，不能覆盖转仓期初',
                  'historical_reorder_requires_separate_causal_replay':'更正会改变成交先后顺序，须独立历史重放',
                  'historical_causal_order_unproved':'同一时间的成交缺少可核对先后顺序',
                  'independent_position_opening_missing':'期初持仓尚未独立核实，不能从当前持仓倒推',
                  'independently_verified_position_opening_required':'期初持仓尚未独立核实，不能从当前持仓倒推',
                  'effective_economics_unknown':'历史实际费用或成本仍未知'}
                raise HTTPException(409,messages.get(str(error),'完整原成交与更正链需要重新核对')) from None
            now=(await(await conn.execute('SELECT clock_timestamp() at')).fetchone())['at']
            changed_time=datetime.fromisoformat(data['replacement']['occurredAt']) if data['replacement'] else None
            if changed_time is not None and changed_time>now:raise HTTPException(422,'不能把未来时间登记为已成交')
            openings=[row for row in state['openings'] if row['account_id']==account['id'] and row['currency']==currency]
            if len(openings)!=1 or any(row['occurred_at']<openings[0]['opening_at'] for row in after.rows):raise HTTPException(409,'更正历史早于已核实现金期初')
            if openings[0]['opening_basis']=='allocate_verified_unallocated_checkpoint':raise HTTPException(409,'分配式现金期初需要独立历史对账，不能覆盖更正')
            delta=after.cash-before.cash
            balance=sum((row['amount'] for row in state['cash'] if row['account_id']==account['id'] and row['currency']==currency),Decimal(0))
            reservation=await pending_reservations(conn,who.id,account['account_kind'],currency,record['id'],account['id'],account_scope=True)
            if not reservation['complete']:raise HTTPException(409,'预留资金来源未知，不能核对更正')
            confirmed=data.get('financingConfirmation') is not None
            if balance+delta<reservation['account_cash'] and not (reservation['account_cash']==0 and (balance<0 and delta>=0 or confirmed)):raise HTTPException(409,'更正后资金不足，须明确核实新增融资')
            # Replay original cash authority with this full record replaced by
            # its effective history; never synthesize opening from today's cash.
            ids={row['id'] for row in rows};correction_requests={row['request_id'] for row in state['corrections'] if row['trade_id'] in ids}
            amended_ids={amendment['id'] for amendment in rows[0].get('_record_amendments',())}
            timeline=[(row['occurred_at'],row['created_at'],str(row['id']),row['amount']) for row in state['cash'] if row['account_id']==account['id'] and row['currency']==currency and row['source_trade_id'] not in ids and row['fee_repair_request_id'] not in correction_requests and row.get('trade_amendment_id') not in amended_ids]
            baseline=[*timeline,*((row['occurred_at'],row['created_at'],row['id'],row['cash_delta']) for row in before.rows)]
            timeline.extend((row['occurred_at'],row['created_at'],row['id'],row['cash_delta']) for row in after.rows)
            from .financing_history import nonincreasing_debt_history
            await nonincreasing_debt_history(conn,who.id,account['id'],currency,state['cash'],timeline,baseline=baseline,additional_confirmed=confirmed)
            running=sum((change for _,_,_,change in timeline),Decimal(0))
            if running!=balance+delta:raise HTTPException(409,'原现金、费用差额与更正链未守恒')
        financing_evidence={'financingConfirmation':data['financingConfirmation']} if data.get('financingConfirmation') else {}
        member_evidence=[{'tradeId':str(row['id']),'previousAmendmentId':next(m['expectedAmendmentId'] for m in members if m['tradeId']==str(row['id'])),'beforeEvent':originals[str(row['id'])],'originalRegistrationRequestId':str(row['request_id'])} for row in selected_rows]
        for member in member_evidence:
            if member['tradeId'] in authorities:member['sourceAuthority']=authorities[member['tradeId']]
        evidence={**data['evidence'],**financing_evidence,'targetUserId':who.id,'tradeId':data['tradeId'],'brokerAccountId':account['id'],
          **({'flatSideChange':True} if side_change else {}),
          **({'cashBasis':'flat_actual_net','tradeCurrency':'HKD','cashCurrency':'CNY','settlementNetIncludesFees':True} if flat_net else {}),
          'originalRegistrationRequestId':str(selected['request_id']),'beforeEvent':original['event'],'replacement':replacement,'currency':currency,'action':data['action'],'members':member_evidence}
        value={'version':1,'flatSideChange':side_change,'cashBasis':'flat_actual_net' if flat_net else 'same_currency','tradeCurrency':selected['currency'],'costCurrency':selected['currency'],'realizedCurrency':selected['currency'],'requestId':data['requestId'],'recordId':record['id'],'brokerAccountId':account['id'],'source':'owner_recorded',
          'brokerExecution':False,'preservesOriginals':True,'canSubmit':True,'action':data['action'],'beforeEvent':original['event'],'replacement':replacement,
          'quantityBefore':str(before.position.quantity),'quantityAfter':str(after.position.quantity),'costBefore':None if before.position.cost is None else str(before.position.cost),
          'costAfter':None if after.position.cost is None else str(after.position.cost),'realizedBefore':None if before.realized is None else str(before.realized),'realizedAfter':None if after.realized is None else str(after.realized),
          'cashEffect':{'currency':currency,'registeredBrokerBefore':str(balance),'brokerBefore':str(balance),'brokerAfter':str(balance+delta),'delta':str(delta),'externalFlow':'0'},
          'evidence':evidence,'evidenceSha256':sha(canonical(evidence))}
        return state,value

    async def decorate_receipt(self,conn,who,data,receipt):
        return receipt

    async def preview_token_hash(self,conn,who,data,preview):
        return digest(preview)

    async def commit(self,conn,who,data,fingerprint,revision,preview):
        state,value=await self.calculate(conn,who,data)
        selected_proof_hash=await self.preview_token_hash(conn,who,data,preview)
        proof=await(await conn.execute('SELECT * FROM trade_fee_previews WHERE token_hash=%s AND owner_id=%s AND session_hash=%s AND expires_at>clock_timestamp() AND consumed_at IS NULL FOR UPDATE',(selected_proof_hash,who.id,who.token_hash))).fetchone()
        if not proof or proof['payload_hash']!=fingerprint or proof['snapshot_hash']!=state['snapshotRevision']:raise HTTPException(409,'更正预览已失效')
        record=next(row for row in state['records'] if row['id']==data['recordId']);account=state['account'];aid=uuid4();replacement_id=uuid5(UUID(data['requestId']),who.id+data['tradeId'])
        await conn.execute('INSERT INTO trade_amendments(owner_id,id,request_id,record_id,trade_id,replacement_id,previous_amendment_id,previous_record_amendment_id,before_record_revision,trade_tip_id,fee_projection_id,before_quantity,after_quantity,before_cost,after_cost,before_realized,after_realized,currency,cash_delta,before_event,replacement,evidence,evidence_raw,evidence_sha256,action,cash_basis,flat_side_change) VALUES('+','.join(['%s']*27)+')',
          (who.id,aid,data['requestId'],record['id'],data['tradeId'],replacement_id,data['expectedAmendmentId'],record['amendment_tip_id'],record['revision'],record['trade_tip_id'],record['fee_projection_id'],value['quantityBefore'],value['quantityAfter'],value['costBefore'],value['costAfter'],value['realizedBefore'],value['realizedAfter'],value['cashEffect']['currency'],value['cashEffect']['delta'],Jsonb(value['beforeEvent']),Jsonb(value['replacement']),Jsonb(value['evidence']),canonical(value['evidence']),value['evidenceSha256'],data['action'],value['cashBasis'],value['flatSideChange']))
        await conn.execute('UPDATE portfolio_records SET qty=%s,cost=%s,amendment_tip_id=%s,revision=revision+1,updated_at=clock_timestamp() WHERE owner_id=%s AND id=%s',(value['quantityAfter'],value['costAfter'],aid,who.id,record['id']))
        cash_entry_id=uuid4()
        if Decimal(value['cashEffect']['delta'])<0 and Decimal(value['cashEffect']['brokerAfter'])<0:
            from .financing_cash import attach_correction
            await attach_correction(conn,who,data,cash_entry_id,aid,account,value)
        await conn.execute("INSERT INTO cash_ledger_entries(id,owner_id,account_id,account_kind,currency,request_id,kind,amount,affects_owner,occurred_at,note,trade_amendment_id) VALUES(%s,%s,%s,%s,%s,%s,'trade_correction',%s,true,clock_timestamp(),%s,%s)",(cash_entry_id,who.id,account['id'],account['account_kind'],value['cashEffect']['currency'],data['requestId'],value['cashEffect']['delta'],'Owner ledger trade amendment',aid))
        await conn.execute('UPDATE cash_ledger_collections SET revision=revision+1 WHERE owner_id=%s',(who.id,))
        result={'requestId':data['requestId'],'kind':self.operation_kind,'state':'completed','source':'owner_recorded','brokerExecution':False,'preservesOriginals':True,'amendmentId':str(aid),'replacementId':None if data['action']=='delete' else str(replacement_id),'action':data['action'],'cashRevision':revision+1,'data':value}
        result=await self.decorate_receipt(conn,who,data,result)
        await conn.execute('INSERT INTO trade_operations(owner_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)',(who.id,data['requestId'],fingerprint,Jsonb(result)))
        await conn.execute('UPDATE trade_fee_previews SET consumed_at=clock_timestamp() WHERE token_hash=%s',(selected_proof_hash,))
        await conn.execute("INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'trading.correct',%s,%s)",(who.id,str(aid),data['requestId']))
        return result
