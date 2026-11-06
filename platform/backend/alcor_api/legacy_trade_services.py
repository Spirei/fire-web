"""Protocol translations and frozen old views, all mutations use native PG services."""
import re
from datetime import UTC, datetime, timedelta
from decimal import Decimal, localcontext
from uuid import NAMESPACE_URL, uuid5

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .broker_accounts import broker_account
from .legacy_identity import LegacyError
from .legacy_trade_commands import correction, registration, registration_fingerprint
from .legacy_trading_snapshot import command_snapshot, legacy_numbers, scalar, snapshot_in_transaction
from .security import digest
from .source_snapshot import canonical, sha
from .trade_amendments import TradeAmendments
from .trading import MARKET_CURRENCY, Trading, normalize


def old_preview(data,native):
    with localcontext() as context:
        context.prec=80
        qty=Decimal(data['qty']);price=Decimal(data['price']);fees=Decimal(data['fees']);gross=qty*price
        total=Decimal(data['settlementAmount']) if data.get('settlementAmount') is not None else gross+fees if data['side']=='buy' else gross-fees
    return legacy_numbers(scalar({'accountId':data['accountId'],'recordId':data['recordId'],'recordRevision':data['recordRevision'],'snapshotRevision':data['snapshotRevision'],
      'side':data['side'],'mode':'record','orderType':data['orderType'],'qty':qty,'price':price,'fees':fees,'tif':data['tif'],'session':data['session'],
      'amount':gross,'total':total,'currency':native['cashCurrency'],
      'priceCurrency':native.get('priceCurrency', 'HKD' if data.get('settlementAmount') is not None else native['cashCurrency']),
      'settlementCurrency':native['cashCurrency'],'settlementAmount':data.get('settlementAmount'),'conversionAuthority':'explicit_actual_net_settlement' if data.get('settlementAmount') is not None else 'same_currency','cashBefore':native['cashBefore'],'cashAfter':native['cashAfter'],
      'quantityBefore':native['quantityBefore'],'quantityAfter':native['quantityAfter'],'costBefore':native['costBefore'],'costAfter':native['costAfter'],
      'realizedPnl':native['realizedPnl'],'feeDetail':native.get('feeDetail'),'brokerAccountId':native['accountId'],'brokerExecution':False,
      'previewRevision':native.get('preview'),'expiresAt':native.get('expiresAt'),
      **({'financing':{'basis':'broker_currency_ledger','brokerAccountId':native['accountId'],'currency':native['cashCurrency'],'cashBefore':Decimal(native['cashBefore']),'cashAfter':Decimal(native['cashAfter']),'debtIncrease':Decimal(native['financing']['debtChange'])}} if native.get('financing') else {})}))


def legacy_failed(who,request_id,kind,result,at):
    return {'requestId':request_id,'accountId':who.id,'kind':kind,'state':'failed','code':result.get('code',40902),
      'message':result['message'],'data':None,'completedAt':scalar(at)}


class LegacyRecordedTrading(Trading):
    durable_financing_failures=False
    normalize_command=staticmethod(registration)
    command_fingerprint=staticmethod(registration_fingerprint)

    async def existing_receipt(self,conn,who,data,result):
        raise LegacyError(409,40901,'requestId已使用，请查询原回执')

    async def prepare_command(self,conn,who,data):
        if data['accountId']!=who.id:raise HTTPException(404,'本人账户不存在')
        _,snapshot,scoped=await command_snapshot(conn,who,data['snapshotRevision'],record_id=data.get('recordId') if 'buyTarget' not in data else None,account_id=data['buyTarget'].get('brokerAccountId') if isinstance(data.get('buyTarget'),dict) else None)
        if data['snapshotRevision']!=snapshot['snapshotRevision']:raise HTTPException(409,'账户或证券已变化，请重新读取并预览')
        original_data=dict(data)
        target=None
        if 'buyTarget' in data:
            from .legacy_buy_target import create_empty, resolve
            account,record,target=await resolve(conn,who,data['buyTarget'])
            if data.get('targetRevision') is not None and data['targetRevision']!=target['targetRevision']:
                raise HTTPException(409,'买入目标已变化，请重新预览')
            if not getattr(self,'_target_preview_stage',False) and data.get('targetRevision')!=target['targetRevision']:
                raise HTTPException(409,'提交须明确保留已预览目标版本')
            record=record or await create_empty(conn,who,account,target)
            data={**data,'recordId':record['id'],'recordRevision':record['revision']}
        else:
            record=await self.records.get(conn,who.id,data['recordId'])
        if not record:raise HTTPException(404,'本人证券不存在')
        if not record['broker_account_id']:raise HTTPException(409,'请明确稳定账户和原现金期初')
        account=await broker_account(conn,who.id,record['broker_account_id'])
        if record['revision']!=data['recordRevision']:raise HTTPException(409,'证券版本已变化')
        currency=MARKET_CURRENCY.get(record['market'])
        if not currency:raise HTTPException(409,'该市场原币尚未核实')
        connect=record['market']=='HK' and record['account_market']=='CN'
        if connect and ('settlementAmount' not in data or data.get('attachments')):
            raise HTTPException(400,'港股通须提供实际人民币净结算额且不接受自动附加单')
        if not connect and 'settlementAmount' in data:
            raise HTTPException(400,'同币成交不接受跨币结算额')
        if record['market']!='US' and data['session']!='REGULAR':raise HTTPException(400,'此市场不支持该登记时段')
        fee_input=data.get('feeInput') or {'source':'owner_recorded','brokerAccountId':account['id'],'providerId':account['provider_id'],'confirmed':True}
        if fee_input['brokerAccountId']!=account['id'] or fee_input['providerId']!=account['provider_id']:raise HTTPException(409,'费用实际所属账户已变化')
        with localcontext() as precision:
            precision.prec=80
            principal=Decimal(data['qty'])*Decimal(data['price'])
            if principal<=0 or principal>Decimal('1e12'):raise HTTPException(400,'成交额超出原契约范围')
        request_id=data['requestId'] or str(uuid5(NAMESPACE_URL,who.id+registration_fingerprint(data)))
        context={'source':'legacy_explicit_record_request','requestId':request_id,'accountId':who.id,'recordId':record['id'],
          'brokerAccountId':account['id'],'brokerNameAtEntry':account['name'],'brokerNameSource':'platform_account_at_entry','mode':'record','orderType':data['orderType'],'tif':data['tif'],'session':data['session'],
          'expiresAt':data.get('expiresAt'),'triggerPrice':str(data['triggerPrice']) if data.get('triggerPrice') is not None else None,'conditionExecutionVerified':False,
          'inputFeeAuthority':'explicit_owner_fee_input' if 'feeInput' in data else 'legacy_explicit_amount_without_fee_input'}
        normalized=normalize({'requestId':request_id,'recordId':record['id'],'recordRevision':record['revision'],'side':data['side'],
          'quantity':'0' if data['side']=='dividend' else data['qty'],'price':'0' if data['side']=='dividend' else data['price'],'amount':str(principal),'fees':data['fees'],'currency':currency,'settlementCurrency':'CNY' if connect else currency,
          **({'settlementAmount':data['settlementAmount']} if connect else {}),
          'occurredAt':data['tradedAt'],'confirmedActualFill':True,'feeInput':fee_input,'note':data['note'],**({'allowFinancing':True,'financingConfirmation':{'kind':'owner_statement','statement':'The authenticated old-client owner explicitly confirmed allowFinancing for this already occurred buy and the supplied actual paid fee, for the identified internal account only.','actualBorrowingConfirmed':True,'ledgerOnlyConfirmed':True}} if data.get('allowFinancing') else {})})
        if data['side']=='dividend':self._statement_context=True
        return {**normalized,'_legacyTradeContext':context,'_legacyRequest':original_data,'_legacyTarget':target,'_legacyScoped':scoped}

    async def decorate_preview(self,conn,who,data,preview):
        semantic=registration_fingerprint(data['_legacyRequest'])
        await conn.execute('INSERT INTO legacy_trade_preview_bindings(owner_id,session_hash,semantic_hash,token_hash) VALUES(%s,%s,%s,%s)',
          (who.id,who.token_hash,semantic,digest(preview['preview'])))
        value=old_preview({**data['_legacyRequest'],'recordId':data['recordId'],'recordRevision':data['recordRevision']},preview)
        return {**value,**({'buyTarget':data['_legacyTarget'],'targetRevision':data['_legacyTarget']['targetRevision']} if data.get('_legacyTarget') else {})}

    async def preview_token_hash(self,conn,who,data,preview):
        match=await(await conn.execute('SELECT b.token_hash FROM legacy_trade_preview_bindings b JOIN trade_previews p ON p.token_hash=b.token_hash WHERE b.owner_id=%s AND b.session_hash=%s AND b.semantic_hash=%s AND p.consumed_at IS NULL AND p.expires_at>clock_timestamp() ORDER BY b.created_at DESC LIMIT 1 FOR UPDATE OF p',(who.id,who.token_hash,registration_fingerprint(data)))).fetchone()
        if not match:raise HTTPException(409,'须在当前会话预览完全相同的成交；过期结果只能查原UUID')
        return match['token_hash']

    async def decorate_receipt(self,conn,who,data,receipt):
        context=data['_legacyTradeContext']
        await conn.execute('INSERT INTO trade_registration_contexts(owner_id,trade_id,request_id,context,context_raw,context_sha256,authority) VALUES(%s,%s,%s,%s,%s,%s,%s)',
          (who.id,receipt['tradeId'],data['requestId'],Jsonb(context),canonical(context),sha(canonical(context)),'legacy_owner_declared'))
        if data['side']=='dividend':
            from .dividend_receipts import DividendReceipts
            await DividendReceipts(self.db).record_legacy_aggregate(conn,who,receipt['tradeId'],data['requestId'],gross=data['amount'],fees=data['fees'])
        children=[]
        if data['_legacyRequest'].get('attachments'):
            from .internal_order_families import create_children_from_recorded_trade
            trade=await(await conn.execute('SELECT * FROM trade_ledger WHERE owner_id=%s AND id=%s',(who.id,receipt['tradeId']))).fetchone()
            children=await create_children_from_recorded_trade(conn,who,trade,{'draft':{**data['_legacyRequest'],'attachmentsExact':data['_legacyRequest']['attachments']}},data['requestId'])
        _,snapshot=await snapshot_in_transaction(conn,who,strict=False,scope_record_id=data['recordId'] if data.get('_legacyScoped') else None)
        item=next(row for row in snapshot['orders'] if row['id']==receipt['tradeId'])
        prior=old_preview({**data['_legacyRequest'],'recordId':data['recordId'],'recordRevision':data['recordRevision']},receipt)
        # Old F10 committedState carries its selected position, not a guessed
        # total for positions outside this registered platform book.
        state={key:snapshot[key] for key in ('accountId','snapshotRevision','collectionRevision','cash')}
        state['position']=next((row for row in snapshot['positions'] if row['recordId']==data['recordId']),None)
        legacy={'requestId':data['requestId'],'accountId':who.id,'kind':'submit_trade','state':'completed','code':0,'message':'ok',
          'data':{'preview':prior,'items':[item,*children],'snapshot':state},'completedAt':scalar(datetime.now(UTC))}
        return {**receipt,'kind':'legacy_recorded_trade','legacyReceipt':legacy}

    async def preview(self,who,raw):
        if not isinstance(raw,dict) or 'buyTarget' not in raw:
            return await super().preview(who,raw)
        import copy
        from contextlib import asynccontextmanager
        service=copy.copy(self)
        async with self.db.connection() as conn,conn.transaction():
            await self.lock(conn,who)
            class Bound:
                settings=self.db.settings
                @asynccontextmanager
                async def connection(self):
                    yield conn
            service.db=Bound()
            service._target_preview_stage=True
            # Hypothetical zero record is rolled back; only the checked financial proof survives.
            async with conn.transaction(force_rollback=True):
                value=await super(LegacyRecordedTrading,service).preview(who,raw)
                proof=await(await conn.execute('SELECT * FROM trade_previews WHERE token_hash=%s',(digest(value['previewRevision']),))).fetchone()
                binding=await(await conn.execute('SELECT * FROM legacy_trade_preview_bindings WHERE token_hash=%s',(proof['token_hash'],))).fetchone()
            await conn.execute('INSERT INTO trade_previews(token_hash,owner_id,session_hash,fingerprint,record_revision,cash_revision,account_revision,expires_at) VALUES(%s,%s,%s,%s,%s,%s,%s,%s)',
                tuple(proof[key] for key in ('token_hash','owner_id','session_hash','fingerprint','record_revision','cash_revision','account_revision','expires_at')))
            await conn.execute('INSERT INTO legacy_trade_preview_bindings(owner_id,session_hash,semantic_hash,token_hash) VALUES(%s,%s,%s,%s)',
                tuple(binding[key] for key in ('owner_id','session_hash','semantic_hash','token_hash')))
            return value

    async def submit(self,who,raw,preview='legacy-matched-preview'):
        data=self.normalize_command(raw)
        if data['requestId'] is None:raise HTTPException(400,'提交须保留原请求UUID')
        try:return await super().submit(who,raw,preview)
        except Exception as error:
            if isinstance(error,HTTPException) and (error.status_code in (401,403) or getattr(error,'business_code',None)==40901):raise
            fingerprint=registration_fingerprint(data)
            async with self.db.connection() as conn,conn.transaction():
                await self.lock(conn,who)
                prior=await(await conn.execute('SELECT fingerprint,result FROM trade_operations WHERE owner_id=%s AND request_id=%s',(who.id,data['requestId']))).fetchone()
                if prior:
                    if prior['fingerprint']!=fingerprint:raise LegacyError(409,40901,'UUID已用于不同操作，请查询原回执')
                    return prior['result']
                status=error.status_code if isinstance(error,HTTPException) else 503
                message=str(error.detail) if isinstance(error,HTTPException) else '本次交易未完成，请查询原UUID回执'
                at=(await(await conn.execute('SELECT clock_timestamp() at')).fetchone())['at']
                result={'requestId':data['requestId'],'kind':'legacy_recorded_trade','state':'failed','status':status,'code':40902 if status==409 else status*100+1,'message':message,'data':None}
                result['legacyReceipt']=legacy_failed(who,data['requestId'],'submit_trade',result,at)
                await conn.execute('INSERT INTO trade_operations(owner_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)',(who.id,data['requestId'],fingerprint,Jsonb(result)))
                return result


class LegacyTradeCorrections(TradeAmendments):
    parse_command=staticmethod(correction)

    async def preview(self,who,raw):
        value=await super().preview(who,raw)
        expires=datetime.fromisoformat(value['expiresAt'])
        milliseconds=(expires.astimezone(UTC)-datetime(1970,1,1,tzinfo=UTC))//timedelta(milliseconds=1)
        return {**value,'previewRevision':str(milliseconds)+'.'+digest(value['previewRevision'])}

    async def preview_token_hash(self,conn,who,data,preview):
        match=re.fullmatch(r'([0-9]{13})\.([a-f0-9]{64})',preview)
        if not match:raise HTTPException(409,'原更正预览格式无效或已经过期')
        row=await(await conn.execute('SELECT expires_at FROM trade_fee_previews WHERE token_hash=%s AND owner_id=%s AND session_hash=%s AND consumed_at IS NULL FOR UPDATE',(match[2],who.id,who.token_hash))).fetchone()
        if not row:raise HTTPException(409,'原更正预览已失效')
        milliseconds=(row['expires_at'].astimezone(UTC)-datetime(1970,1,1,tzinfo=UTC))//timedelta(milliseconds=1)
        if int(match[1])!=milliseconds:raise HTTPException(409,'原更正预览期限已变化')
        return match[2]

    async def submit(self,who,raw,preview):
        self.parse_command(raw)
        try:return await super().submit(who,raw,preview)
        except HTTPException as error:
            if error.status_code==409:raise LegacyError(409,40901,'UUID已用于不同操作，请查询原回执') from None
            raise

    async def translate(self,conn,who,data):
        if data['accountId']!=who.id:raise HTTPException(404,'本人账户不存在')
        from .scope_coverage import status as coverage_status
        scoped = True
        snapshot = None
        if (await coverage_status(conn,who.id))['complete']:
            try:
                _,global_snapshot=await snapshot_in_transaction(conn,who,strict=False)
                if global_snapshot['snapshotRevision']==data['snapshotRevision']:
                    scoped=False;snapshot=global_snapshot
            except HTTPException as error:
                if error.status_code!=409:raise
        if snapshot is None:
            _,snapshot=await snapshot_in_transaction(conn,who,strict=False,scope_record_id=data['recordId'])
        if snapshot['snapshotRevision']!=data['snapshotRevision']:raise HTTPException(409,'账户或证券已变化，请重新读取原快照')
        selected=[];roots=[]
        from uuid import UUID
        for selection in data['orders']:
            row=next((row for row in snapshot['orders'] if row['id']==selection['id']),None)
            if not row or row['recordId']!=data['recordId'] or row['status']!='filled':raise HTTPException(404,'本人当前有效原单不存在')
            if row['revision']!=selection['revision']:raise HTTPException(409,'原订单版本已变化')
            try:order_id=UUID(selection['id'])
            except (ValueError,TypeError):raise HTTPException(404,'原单与平台成交映射缺失') from None
            root=await(await conn.execute('SELECT id,record_id,account_id FROM trade_ledger WHERE owner_id=%s AND id=%s',(who.id,order_id))).fetchone()
            if root is None:root=await(await conn.execute('SELECT t.id,t.record_id,t.account_id FROM trade_amendments a JOIN trade_ledger t ON t.owner_id=a.owner_id AND t.id=a.trade_id WHERE a.owner_id=%s AND a.replacement_id=%s',(who.id,order_id))).fetchone()
            if not root:raise HTTPException(404,'原单与平台成交映射缺失')
            selected.append(row);roots.append(root)
        if len({str(row['id']) for row in roots})!=len(roots) or len({row['account_id'] for row in roots})!=1 or len({row['side'] for row in selected})!=1:raise HTTPException(409,'只支持同证券同账户同方向有效原单')
        primary=next((i for i,row in enumerate(selected) if row['id']==data.get('timeSourceOrderId')),0)
        root=roots[primary];selected_primary=selected[primary]
        state=await self.state(conn,who,root['account_id']);account=state['account']
        current_by_id={row['id']:row for row in state['fills']}
        current=current_by_id[root['id']];amendment=current.get('_latest_amendment')
        record=next(row for row in state['records'] if row['id']==data['recordId'])
        detail=None;declared=None;replacement=None
        if data['action']!='delete':
            fee_input=data['replacement'].get('feeInput')
            if fee_input and (fee_input['brokerAccountId']!=account['id'] or fee_input['providerId']!=account['provider_id']):raise HTTPException(409,'费用账户或来源已变化')
            if data['action']=='merge' and data['replacement']['tradedAt']!=selected_primary['tradedAt']:raise HTTPException(409,'合并时间须严格保留所选原单时间文本')
            from .current_fees import calculate as paid_detail
            declared=fee_input or {'source':'owner_recorded','brokerAccountId':account['id'],'providerId':account['provider_id'],'confirmed':True}
            replacement_side=data['replacement'].get('side',selected_primary['side'])
            if replacement_side!=selected_primary['side'] and (not self.allow_flat_side_change or data['action']!='amend' or replacement_side not in ('buy','sell')):raise HTTPException(409,'此入口不接受成交方向变更')
            try:detail=paid_detail({'fees':data['replacement']['fees'],'occurredAt':data['replacement']['tradedAt'],'side':replacement_side},record,account,declared)
            except (ValueError,TypeError,KeyError):raise HTTPException(409,'本人费用分项与实际总额、币种或原账户不符') from None
            replacement={'quantity':data['replacement']['qty'],'price':data['replacement']['price'],'fees':data['replacement']['fees'],'occurredAt':data['replacement']['tradedAt']}
            if 'side' in data['replacement']:
                if not self.allow_flat_side_change:raise HTTPException(409,'此入口不接受成交方向变更')
                replacement['side']=replacement_side
            if self.allow_flat_net_settlement and record['market']=='HK' and record['account_market']=='CN':
                from .trade_amendments import precise
                if data['replacement'].get('settlementCurrency')!='CNY' or data['replacement'].get('settlementAmount') is None:raise HTTPException(409,'须明确人民币实际净结算额，不能推算汇率或费用')
                replacement.update(settlementAmount=precise(data['replacement']['settlementAmount']),settlementCurrency='CNY')
            elif data['replacement'].get('settlementAmount') is not None:raise HTTPException(409,'该更正来源不接受净结算字段')
        statement='Authenticated legacy client explicitly requested this manual ledger '+data['action']+' of the identified original orders; all original paid fees and any supplied replacement paid amount are independently required known. No fee rule or broker instruction was inferred.'
        normalized={'requestId':data['requestId'],'targetUserId':who.id,'brokerAccountId':account['id'],'brokerRevision':account['revision'],
          'snapshotRevision':state['snapshotRevision'],'recordId':data['recordId'],'recordRevision':data['recordRevision'],'tradeId':str(root['id']),
          'expectedAmendmentId':str(amendment['id']) if amendment else None,'action':data['action'],'replacement':replacement,
          'evidence':{'authority':'owner_recorded','kind':'owner_statement','statement':statement,'actualPaidConfirmed':True,'ledgerCorrectionConfirmed':True,**({'legacyFeeInput':declared,'legacyFeeDetail':detail} if detail else {})}}
        if data.get('financingConfirmation'):normalized['financingConfirmation']=data['financingConfirmation']
        if data['action']=='merge':normalized['members']=[{'tradeId':str(row['id']),'expectedAmendmentId':str(current_by_id[row['id']]['_latest_amendment']['id']) if current_by_id[row['id']].get('_latest_amendment') else None} for row in roots]
        return {**normalized,'_legacyCorrection':data,'_legacyScoped':scoped}

    async def calculate(self,conn,who,data):
        mapped=data if '_legacyCorrection' in data else await self.translate(conn,who,data)
        state,value=await super().calculate(conn,who,mapped)
        return state,{**value,'legacyRequest':mapped['_legacyCorrection'],'legacyAffectedOrderCount':sum(row['record_id']==mapped['recordId'] for row in state['fills'])+1}

    async def commit(self,conn,who,data,fingerprint,revision,preview):
        mapped=await self.translate(conn,who,data)
        return await super().commit(conn,who,mapped,fingerprint,revision,preview)

    async def decorate_receipt(self,conn,who,data,receipt):
        _,snapshot=await snapshot_in_transaction(conn,who,strict=False,scope_record_id=data['recordId'] if data.get('_legacyScoped') else None)
        value=receipt['data'];request=data['_legacyCorrection']
        ids={item['id'] for item in request['orders']}|{receipt['replacementId']}|{row['id'] for row in snapshot['orders'] if row['recordId']==data['recordId'] and row['status']=='filled'}
        affected=[row for row in snapshot['orders'] if row['id'] in ids]
        legacy={'requestId':data['requestId'],'accountId':who.id,'kind':'correct_trade','state':'completed','code':0,'message':'ok',
          'data':{'snapshot':snapshot,'items':affected,'preview':correction_preview(request,value)},'completedAt':scalar(datetime.now(UTC))}
        return {**receipt,'legacyReceipt':legacy}

    async def decorate_failure(self,conn,who,data,result):
        at=(await(await conn.execute('SELECT clock_timestamp() at')).fetchone())['at']
        return {**result,'legacyReceipt':legacy_failed(who,data['requestId'],'correct_trade',result,at)}


def correction_preview(request,value):
    with localcontext() as precision:
        precision.prec=80
        before=sum((Decimal(row['beforeEvent']['fees']) for row in value['evidence'].get('members',[{'beforeEvent':value['beforeEvent']}])),Decimal(0));after=Decimal(0) if value.get('action')=='delete' else Decimal(value['replacement']['fees'])
    return legacy_numbers(scalar({'request':request,'currency':value['cashEffect']['currency'],'cashBefore':value['cashEffect']['brokerBefore'],
      'cashAfter':value['cashEffect']['brokerAfter'],'cashDelta':value['cashEffect']['delta'],'quantityBefore':value['quantityBefore'],'quantityAfter':value['quantityAfter'],
      'costBefore':value['costBefore'],'costAfter':value['costAfter'],'realizedBefore':value['realizedBefore'],'realizedAfter':value['realizedAfter'],
      'feeBefore':before,'feeAfter':after,'feeSource':'owner_recorded','feeDetail':value['evidence'].get('legacyFeeDetail'),'affectedOrderCount':value.get('legacyAffectedOrderCount',1),
      'canSubmit':True,'brokerAccountId':value['brokerAccountId'],'preservesOriginals':True,**{key:value[key] for key in ('previewRevision','expiresAt') if key in value}}))
