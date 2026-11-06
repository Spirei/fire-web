"""Explicit parent/OCO provenance. No inferred fill, fee payment or quote authority."""

from decimal import Decimal, localcontext
from uuid import UUID, uuid5

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .internal_orders import InternalOrders, normalize, order_dto
from .legacy_trade_commands import number
from .legacy_trading_snapshot import scalar


def attachments(raw):
    if raw is None:
        return None
    if (not isinstance(raw,dict) or set(raw)-{'takeProfit','stopLoss','session','tif'}
            or not any(key in raw for key in ('takeProfit','stopLoss'))
            or raw.get('session') not in ('REGULAR','EXTENDED') or raw.get('tif') not in ('day','gtc')):
        raise HTTPException(400,'附加单时段、有效期或组成无效')
    result={'session':raw['session'],'tif':raw['tif']}
    for name in ('takeProfit','stopLoss'):
        if name not in raw:
            continue
        leg=raw[name]
        if (not isinstance(leg,dict) or set(leg)-{'percent','orderType','limitPrice','fees'}
                or not {'percent','orderType','fees'}<=set(leg) or leg['orderType'] not in ('limit','market')):
            raise HTTPException(400,'附加单比例或类型无效')
        percent=number(leg['percent'])
        if Decimal(percent)>=100 or leg['orderType']=='market' and 'limitPrice' in leg:
            raise HTTPException(400,'附加单比例或限价无效')
        result[name]={'percent':percent,'orderType':leg['orderType'],'fees':number(leg['fees'],zero=True),
                      **({'limitPrice':number(leg['limitPrice'])} if 'limitPrice' in leg else {})}
    return result


async def create_children_on_connection(conn, who, parent, context, fill, request_id):
    return await _create_children(conn,who,parent,context,fill,request_id)


async def create_children_from_recorded_trade(conn, who, trade, context, request_id):
    return await _create_children(conn,who,trade,context,{'quantity':str(trade['quantity']),'price':str(trade['price']),
        'tradeId':str(trade['id']),'simulation':trade['account_kind']=='simulated'},request_id,actual=True)


async def _create_children(conn, who, parent, context, fill, request_id, *, actual=False):
    """Caller holds owner/cash/records locks and has committed the parent's fill in this transaction."""
    draft=context.get('draft',context)
    spec=draft.get('attachmentsExact') or attachments(draft.get('attachments'))
    if not spec:
        return []
    from .actual_fee_confirmations import identifier
    rid=identifier(str(request_id))
    if actual:
        row=await (await conn.execute('SELECT * FROM trade_ledger WHERE owner_id=%s AND id=%s',(who.id,parent['id']))).fetchone()
        if not row or row['side'] not in ('buy','sell'):
            raise HTTPException(409,'已登记父成交不存在')
        from .actual_projection import first_unknown_revision
        if await first_unknown_revision(conn,who.id,row['record_id']) is not None:
            raise HTTPException(409,'父成交实际费用尚未核实，不建立执行附加单')
        record=await (await conn.execute('SELECT * FROM portfolio_records WHERE owner_id=%s AND id=%s',(who.id,row['record_id']))).fetchone()
        row={**row,'record_code':record['code'],'record_market':record['market'],'record_account_market':record['account_market'],
             'record_source':record['source'],'currency':row['settlement_currency'],'status':'filled'}
    else:
        row=await (await conn.execute('SELECT * FROM internal_orders WHERE owner_id=%s AND id=%s FOR UPDATE',(who.id,parent['id']))).fetchone()
        if not row or row['status']!='filled' or row['revision']!=parent['revision']:
            raise HTTPException(409,'须先核实同版本父单实际完成事实')
    if not isinstance(fill,dict) or not isinstance(fill.get('quantity'),str) or not isinstance(fill.get('price'),str):
        raise HTTPException(409,'父单成交数量与价格精确证据缺失')
    qty,price=Decimal(fill['quantity']),Decimal(fill['price'])
    if not qty.is_finite() or not price.is_finite() or qty!=row['quantity'] or qty<=0 or price<=0:
        raise HTTPException(409,'父单成交数量或价格无法核对')
    if row['account_kind']=='real' and not fill.get('tradeId'):
        raise HTTPException(409,'真实父单缺独立成交原件，不建立附加单')
    if row['account_kind']=='simulated' and fill.get('simulation') is not True:
        raise HTTPException(409,'模拟父单须明确模拟证据')
    parent_column='parent_trade_id' if actual else 'parent_order_id'
    existing=await (await conn.execute(f'SELECT id,parent_fill_request FROM internal_order_families WHERE owner_id=%s AND {parent_column}=%s',(who.id,row['id']))).fetchone()
    if existing:
        if str(existing['parent_fill_request'])!=rid:
            raise HTTPException(409,'父单已经建立附加单，不能重复执行')
        children=await (await conn.execute('SELECT o.* FROM internal_orders o JOIN internal_order_family_legs l ON l.owner_id=o.owner_id AND l.order_id=o.id WHERE l.owner_id=%s AND l.family_id=%s ORDER BY l.role',(who.id,existing['id']))).fetchall()
        return [order_dto(child) for child in children]
    service=InternalOrders(None)
    record=await service.records.get(conn,who.id,row['record_id'])
    if not record or record['broker_account_id']!=row['account_id'] or record['code']!=row['record_code'] or record['market']!=row['record_market']:
        raise HTTPException(409,'父单持仓归属已变化')
    side='sell' if row['side']=='buy' else 'buy'
    plans=[]
    with localcontext() as precision:
        precision.prec=160
        for key,role in (('takeProfit','take_profit'),('stopLoss','stop_loss')):
            if key not in spec:
                continue
            leg=spec[key]
            above=(row['side']=='buy')==(role=='take_profit')
            trigger=price*(1+(1 if above else -1)*Decimal(leg['percent'])/100)
            limit=Decimal(leg.get('limitPrice') or trigger)
            data=normalize({'requestId':rid,'action':'create','recordId':record['id'],'recordRevision':record['revision'],
                            'side':side,'quantity':str(qty),'limitPrice':str(limit),'fees':leg['fees'],
                            'confirmedInternalOrder':True,'note':draft.get('note','')})
            plans.append((role,above,str(trigger),leg,data))
    # OCO max is checked once before any child exists, instead of reserving both legs twice.
    maximum=max(plans,key=lambda plan:Decimal(plan[4]['reservationCash']))
    cash_revision,order_revision=await service.lock(conn,who)
    await service.plan(conn,who,maximum[4],cash_revision,order_revision)
    family=uuid5(UUID(str(row['id'])),'oco:'+rid)
    await conn.execute(f'''INSERT INTO internal_order_families(owner_id,id,{parent_column},account_id,account_kind,record_id,currency,quantity,parent_fill_request,fill_evidence)
        VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''',(who.id,family,row['id'],row['account_id'],row['account_kind'],row['record_id'],row['currency'],str(qty),rid,Jsonb(fill)))
    result=[]
    for role,above,trigger,leg,data in plans:
        child_id=uuid5(family,role)
        child=await (await conn.execute('''INSERT INTO internal_orders(id,owner_id,account_id,account_kind,record_id,record_code,record_market,record_account_market,
            record_source,currency,side,quantity,limit_price,fees,reservation_cash,note) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *''',
            (child_id,who.id,row['account_id'],row['account_kind'],row['record_id'],row['record_code'],row['record_market'],row['record_account_market'],row['record_source'],
             row['currency'],side,data['quantity'],data['limitPrice'],data['fees'],data['reservationCash'],data['note']))).fetchone()
        await conn.execute('INSERT INTO internal_order_family_legs(owner_id,family_id,order_id,role,trigger_price,trigger_above) VALUES(%s,%s,%s,%s,%s,%s)',
                           (who.id,family,child_id,role,trigger,above))
        child_draft={**draft,'side':side,'mode':'order','orderType':leg['orderType'],'tif':spec['tif'],'session':spec['session'],
                     'attachments':None,'attachmentsExact':None,'feeInput':None,'feeAuthority':'estimated_not_actual_paid',
                     'quantityExact':data['quantity'],'priceExact':data['limitPrice'],'feesExact':data['fees'],
                     'parentOrderId':None if actual else str(row['id']),'parentTradeId':str(row['id']) if actual else None,'attachmentRole':role,'triggerPrice':trigger,'triggerAbove':above,'familyId':str(family)}
        await conn.execute('INSERT INTO internal_order_contexts(owner_id,order_id,order_revision,request_id,draft) VALUES(%s,%s,%s,%s,%s)',
                           (who.id,child_id,child['revision'],rid,Jsonb(scalar(child_draft))))
        result.append(order_dto(child))
    await conn.execute('UPDATE cash_ledger_collections SET revision=revision+1 WHERE owner_id=%s',(who.id,))
    return result


async def cancel_siblings_on_connection(conn, who, filled_order, request_id):
    family=await (await conn.execute('SELECT family_id FROM internal_order_family_legs WHERE owner_id=%s AND order_id=%s',(who.id,filled_order['id']))).fetchone()
    if not family:
        return []
    current=await (await conn.execute('SELECT status FROM internal_orders WHERE owner_id=%s AND id=%s FOR UPDATE',(who.id,filled_order['id']))).fetchone()
    if not current or current['status']!='filled':
        raise HTTPException(409,'附加单没有完成事实，不能撤销另一侧')
    siblings=await (await conn.execute("""SELECT o.* FROM internal_orders o JOIN internal_order_family_legs l ON l.owner_id=o.owner_id AND l.order_id=o.id
        WHERE l.owner_id=%s AND l.family_id=%s AND o.id<>%s AND o.status='pending' ORDER BY o.id FOR UPDATE OF o""",(who.id,family['family_id'],filled_order['id']))).fetchall()
    result=[]
    for row in siblings:
        updated=await (await conn.execute("UPDATE internal_orders SET status='cancelled',cancelled_at=clock_timestamp() WHERE owner_id=%s AND id=%s RETURNING *",(who.id,row['id']))).fetchone()
        result.append(order_dto(updated))
        await conn.execute("INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'internal-order.oco-cancel',%s,%s)",(who.id,str(row['id']),request_id))
    if result:
        await conn.execute('UPDATE cash_ledger_collections SET revision=revision+1 WHERE owner_id=%s',(who.id,))
    return result
