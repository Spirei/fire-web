import copy
from contextlib import asynccontextmanager
from legacy_fee_source_fixture import old_rows_from_target,registered_source,target_placeholder


@asynccontextmanager
async def source_case(client,admin,app,old_pg,pg,tmp_path,*,extra=None):
    db=app.state.db;account,fill=await target_placeholder(client,db,pg)
    data,oid=await old_rows_from_target(client,db,fill['tradeId'],old_pg.owners[0])
    if extra:
        row=copy.deepcopy(data['trade_orders'][0]);row.update(id=extra['id'],status=extra.get('status','filled'))
        record=copy.deepcopy(data['records'][0])
        if extra.get('unassigned'):
            record.update(id='old-unassigned-record',broker_account_id=None)
            row['record_id']=record['id'];data['records'].append(record)
            data['record_revisions'].append({'user_id':old_pg.owners[0],'record_id':record['id'],'revision':record['revision']})
        else:
            data['broker_cash_order_links'].append({**data['broker_cash_order_links'][0],'order_id':row['id']})
        if extra.get('recordRevision'):
            record['revision']=extra['recordRevision']
            for item in data['records']:item['revision']=extra['recordRevision']
            for item in data['record_revisions']:item['revision']=extra['recordRevision']
        if row['status']!='filled':row.update(position_qty_after=None,position_cost_after=None)
        if extra.get('unknown'):
            row.update(fees=None,market=None,traded_at=None)
        data['trade_orders'].append(row)
        data['app_asset_order_versions'].append({'order_id':row['id'],'revision':extra.get('revision',1)})
    async with registered_source(client,db,pg,old_pg,tmp_path,data) as result:
        yield (*result,account,fill,oid)
