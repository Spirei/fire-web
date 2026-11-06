"""Original native internal intents; no broker calls and no fabricated actual fills."""

import secrets
from datetime import datetime
from decimal import Decimal
from uuid import NAMESPACE_URL, uuid4, uuid5
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .internal_orders import InternalOrders, fingerprint, normalize, order_dto
from .legacy_trade_commands import number, revision, version_hash
from .legacy_trading_snapshot import command_snapshot, exact_scalar, legacy_numbers, scalar
from .security import digest


async def get_context(conn, owner, order_id, revision):
    return await (await conn.execute('SELECT * FROM internal_order_contexts WHERE owner_id=%s AND order_id=%s AND order_revision=%s',
                                    (owner,order_id,revision))).fetchone()


def command(raw, owner, order_id=None):
    allowed={'requestId','accountId','recordId','recordRevision','snapshotRevision','side','mode','orderType','qty','price','fees',
             'tif','session','note','orderRevision','attachments','feeInput','expiresAt','triggerPrice'}
    required=allowed-{'requestId','note','orderRevision','attachments','feeInput','expiresAt','triggerPrice'}
    if not isinstance(raw,dict) or set(raw)-allowed or not required<=set(raw) or raw['accountId']!=owner:
        raise HTTPException(400,'内部委托参数或本人账户无效')
    if raw['mode']!='order' or raw['side'] not in ('buy','sell') or raw['orderType'] not in ('limit','market','trigger_buy','trigger_sell','rebound_buy','rebound_sell') or raw['tif'] not in ('day','gtc','custom') or raw['session'] not in ('REGULAR','EXTENDED'):
        raise HTTPException(400,'内部委托方向、类型、时段或有效期无效')
    if raw.get('expiresAt') is not None:
        try:
            deadline=datetime.fromisoformat(raw['expiresAt'])
            if deadline.tzinfo is None and len(raw['expiresAt'])!=10:raise ValueError
        except (TypeError,ValueError,AttributeError) as error:
            raise HTTPException(400,'委托到期时间须为带时区日期') from error
    if raw['tif']=='custom' and raw.get('expiresAt') is None:
        raise HTTPException(400,'自定义有效期须明确到期时间')
    if raw.get('triggerPrice') is not None:
        number(raw['triggerPrice'])
    from .internal_order_families import attachments
    attachments(raw.get('attachments'))
    if 'feeInput' in raw and not isinstance(raw['feeInput'],dict):
        raise HTTPException(400,'费用来源参数无效')
    from .actual_fee_confirmations import identifier
    rid=identifier(raw['requestId']) if raw.get('requestId') is not None else str(uuid5(NAMESPACE_URL,owner+fingerprint(exact_scalar(raw))))
    data=normalize({'requestId':rid,'action':'create','recordId':raw['recordId'],'recordRevision':revision(raw['recordRevision']),
                    'side':raw['side'],'quantity':number(raw['qty']),'limitPrice':number(raw['price']),
                    'fees':number(raw['fees'],zero=True),'note':raw.get('note',''),'confirmedInternalOrder':True})
    version_hash(raw['snapshotRevision'])
    if order_id is not None:
        identifier(order_id)
        revision(raw.get('orderRevision'))
    return data


def semantic(raw, order_id):
    return fingerprint({'orderId':order_id,'data':exact_scalar({key:value for key,value in raw.items() if key not in ('requestId','previewRevision','targetRevision')})})


class InternalOrderActions(InternalOrders):
    async def planned(self,conn,who,raw,order_id,cash_revision,order_revision):
        _,snapshot,_scoped=await command_snapshot(conn,who,raw['snapshotRevision'],record_id=raw.get('recordId') if 'buyTarget' not in raw else None,account_id=raw['buyTarget'].get('brokerAccountId') if isinstance(raw.get('buyTarget'),dict) else None)
        if raw['snapshotRevision']!=snapshot['snapshotRevision']:
            raise HTTPException(409,'账户、持仓、现金或委托已变化，请重新读取')
        target=None
        if 'buyTarget' in raw:
            if order_id or raw.get('side')!='buy' or 'recordId' in raw or 'recordRevision' in raw:
                raise HTTPException(400,'买入目标不能与原记录或改单混用')
            from .legacy_buy_target import create_empty, resolve
            account,record,target=await resolve(conn,who,raw['buyTarget'])
            if not getattr(self,'_target_preview_stage',False) and raw.get('targetRevision')!=target['targetRevision']:
                raise HTTPException(409,'目标版本已变化，须重新预览')
            record=record or await create_empty(conn,who,account,target)
            raw={key:value for key,value in raw.items() if key not in ('buyTarget','targetRevision')}
            raw.update(recordId=record['id'],recordRevision=record['revision'])
        data=command(raw,who.id,order_id)
        old=None
        if order_id:
            old=await (await conn.execute('SELECT * FROM internal_orders WHERE owner_id=%s AND id=%s FOR UPDATE',(who.id,order_id))).fetchone()
            if not old or old['status']!='pending' or old['revision']!=raw['orderRevision']:
                raise HTTPException(409,'原委托版本或状态已变化')
            if old['record_id']!=data['recordId'] or old['side']!=data['side']:
                raise HTTPException(409,'改单不可变更证券或买卖方向')
            data['_excludedOrder']=str(old['id'])
            family=await (await conn.execute('SELECT f.* FROM internal_order_families f JOIN internal_order_family_legs l ON l.owner_id=f.owner_id AND l.family_id=f.id WHERE l.owner_id=%s AND l.order_id=%s',(who.id,old['id']))).fetchone()
            if family:
                if Decimal(data['quantity'])!=family['quantity'] or raw.get('attachments') is not None:
                    raise HTTPException(409,'OCO附加单须保留已核实父单数量，不可再嵌套附加单')
                sibling=await (await conn.execute("SELECT max(o.reservation_cash) AS cash FROM internal_orders o JOIN internal_order_family_legs l ON l.owner_id=o.owner_id AND l.order_id=o.id WHERE l.owner_id=%s AND l.family_id=%s AND o.status='pending' AND o.id<>%s",(who.id,family['id'],old['id']))).fetchone()
                data['_capacityCash']=str(max(Decimal(data['reservationCash']),sibling['cash'] or Decimal(0)))
        planned=await self.plan(conn,who,data,cash_revision,order_revision)
        if raw['tif']=='custom':
            from .market_contract import ZONES
            now=(await(await conn.execute('SELECT clock_timestamp() at')).fetchone())['at']
            expiry=datetime.fromisoformat(raw['expiresAt'])
            expired=(expiry.date()<now.astimezone(ZoneInfo(ZONES[planned['record']['market']])).date()
                     if len(raw['expiresAt'])==10 else expiry<=now)
            if expired:raise HTTPException(400,'自定义有效期不能早于当前市场日期或时刻')
        if planned['record']['market']!='US' and (raw['session']!='REGULAR' or raw.get('attachments') and raw['attachments'].get('session')!='REGULAR'):
            raise HTTPException(400,'该市场不支持扩展时段')
        planned['target']=target
        planned['dependencies']['originalOrderRevision']=old['revision'] if old else None
        return data,planned,old

    async def preview_native(self,who,raw,order_id=None,*,exact=False):
        if isinstance(raw,dict) and 'buyTarget' in raw and not getattr(self,'_target_preview_stage',False):
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
                async with conn.transaction(force_rollback=True):
                    value=await service.preview_native(who,raw,order_id,exact=exact)
                    proof=await(await conn.execute('SELECT * FROM internal_order_previews WHERE token_hash=%s',(digest(value['previewRevision']),))).fetchone()
                await conn.execute('INSERT INTO internal_order_previews(token_hash,owner_id,session_hash,fingerprint,dependencies,expires_at) VALUES(%s,%s,%s,%s,%s,%s)',
                    (proof['token_hash'],proof['owner_id'],proof['session_hash'],proof['fingerprint'],Jsonb(proof['dependencies']),proof['expires_at']))
                return value
        async with self.db.connection() as conn,conn.transaction():
            cash,orders=await self.lock(conn,who)
            data,plan,old=await self.planned(conn,who,raw,order_id,cash,orders)
            token=secrets.token_urlsafe(32)
            row=await (await conn.execute('INSERT INTO internal_order_previews(token_hash,owner_id,session_hash,fingerprint,dependencies) VALUES(%s,%s,%s,%s,%s) RETURNING expires_at',
                (digest(token),who.id,who.token_hash,semantic(raw,order_id),Jsonb(plan['dependencies'])))).fetchone()
            result=scalar({**plan['summary'],'mode':'order','orderType':raw['orderType'],'tif':raw['tif'],'session':raw['session'],
                'qty':data['quantity'],'price':data['limitPrice'],'previewRevision':token,'expiresAt':row['expires_at'],
                'accountId':who.id,'brokerAccountId':plan['account']['id'],'snapshotRevision':raw['snapshotRevision'],
                'recordRevision':data['recordRevision'],'orderRevision':old['revision'] if old else None,
                'immediateAccounting':False,'feeAuthority':'estimated_not_actual_paid',
                **({'buyTarget':plan['target'],'targetRevision':plan['target']['targetRevision']} if plan.get('target') else {})})
            return result if exact else legacy_numbers(result)

    async def submit_native(self,who,raw,order_id=None):
        if not isinstance(raw,dict) or 'requestId' not in raw:
            raise HTTPException(400,'提交须保留原requestId')
        token=raw.get('previewRevision')
        raw={key:value for key,value in raw.items() if key!='previewRevision'}
        if 'buyTarget' in raw:
            from .actual_fee_confirmations import identifier
            data={'requestId':identifier(raw['requestId'])}
        else:
            data=command(raw,who.id,order_id)
        hashed=semantic(raw,order_id)
        async with self.db.connection() as conn,conn.transaction():
            cash,orders=await self.lock(conn,who)
            prior=await (await conn.execute('SELECT * FROM internal_order_operations WHERE owner_id=%s AND request_id=%s',(who.id,data['requestId']))).fetchone()
            if prior:
                raise HTTPException(409,'requestId已使用，请查询原回执')
            from .asset_request_domains import require_domain
            await require_domain(conn,who.id,data['requestId'],'internal_order')
            proof=await (await conn.execute('''SELECT * FROM internal_order_previews WHERE owner_id=%s AND session_hash=%s AND fingerprint=%s
                AND consumed_at IS NULL AND expires_at>clock_timestamp() AND (%s::text IS NULL OR token_hash=%s)
                ORDER BY expires_at DESC LIMIT 1 FOR UPDATE''',(who.id,who.token_hash,hashed,token,digest(token) if isinstance(token,str) else None))).fetchone()
            if not proof:
                raise HTTPException(409,'须重新预览当前会话的原委托')
            data,plan,old=await self.planned(conn,who,raw,order_id,cash,orders)
            if proof['dependencies']!=plan['dependencies']:
                raise HTTPException(409,'预览依赖版本已变化')
            if old:
                await conn.execute('''INSERT INTO internal_order_actions(owner_id,request_id,order_id,action,before_revision,after_revision,before_snapshot,after_snapshot)
                    SELECT owner_id,%s,id,'amend',revision,revision+1,to_jsonb(o),jsonb_build_object('quantity',%s::numeric,'limit_price',%s::numeric,
                    'fees',%s::numeric,'reservation_cash',%s::numeric,'note',%s::text) FROM internal_orders o WHERE owner_id=%s AND id=%s''',
                    (data['requestId'],data['quantity'],data['limitPrice'],data['fees'],data['reservationCash'],data['note'],who.id,old['id']))
                row=await (await conn.execute('UPDATE internal_orders SET quantity=%s,limit_price=%s,fees=%s,reservation_cash=%s,note=%s WHERE owner_id=%s AND id=%s RETURNING *',
                    (data['quantity'],data['limitPrice'],data['fees'],data['reservationCash'],data['note'],who.id,old['id']))).fetchone()
            else:
                record,account=plan['record'],plan['account']
                row=await (await conn.execute('''INSERT INTO internal_orders(id,owner_id,account_id,account_kind,record_id,record_code,record_market,
                    record_account_market,record_source,currency,side,quantity,limit_price,fees,reservation_cash,note)
                    VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *''',
                    (uuid4(),who.id,account['id'],account['account_kind'],record['id'],record['code'],record['market'],record['account_market'],record['source'],
                     plan['currency'],data['side'],data['quantity'],data['limitPrice'],data['fees'],data['reservationCash'],data['note']))).fetchone()
            from .internal_order_families import attachments
            draft={**exact_scalar(raw),'attachmentsExact':attachments(raw.get('attachments')),'feeAuthority':'estimated_not_actual_paid','executionModel':'internal_trade_ledger','brokerExecution':False,
                   'quantityExact':data['quantity'],'priceExact':data['limitPrice'],'feesExact':data['fees']}
            if old:
                prior_context=await get_context(conn,who.id,old['id'],old['revision'])
                if prior_context:
                    if 'expiresAt' not in raw and 'expiresAt' in prior_context['draft']:
                        draft['expiresAt']=prior_context['draft']['expiresAt']
                    draft.update({key:prior_context['draft'][key] for key in ('parentOrderId','attachmentRole','triggerPrice','triggerAbove','familyId') if key in prior_context['draft']})
            await conn.execute('INSERT INTO internal_order_contexts(owner_id,order_id,order_revision,request_id,draft) VALUES(%s,%s,%s,%s,%s)',
                (who.id,row['id'],row['revision'],data['requestId'],Jsonb(draft)))
            await conn.execute('UPDATE cash_ledger_collections SET revision=revision+1 WHERE owner_id=%s',(who.id,))
            result={'requestId':data['requestId'],'accountId':who.id,'kind':'amend_trade' if old else 'submit_trade','state':'completed','code':0,'message':'ok',
                    'data':{'items':[order_dto(row)],'brokerExecution':False,'immediateAccounting':False}}
            outcome={'requestId':data['requestId'],'kind':'legacy_internal_orders','state':'completed','legacyReceipt':result}
            await conn.execute('INSERT INTO internal_order_operations(owner_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)',(who.id,data['requestId'],hashed,Jsonb(outcome)))
            await conn.execute('UPDATE internal_order_previews SET consumed_at=clock_timestamp() WHERE token_hash=%s',(proof['token_hash'],))
            await conn.execute("INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'internal-order.native',%s,%s)",(who.id,str(row['id']),data['requestId']))
            return result
