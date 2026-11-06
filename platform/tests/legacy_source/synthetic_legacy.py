"""Frozen synthetic old structures, never a connection to a user's old repository."""
import json
from pathlib import Path
from uuid import UUID

from psycopg import sql

from alcor_api.source_snapshot import TABLES

OWNER='legacy-owner-A'
NUMERIC={'price','qty','fees','amount','realized_pnl','position_qty_after','position_cost_after','position_qty_before','position_cost_before','cost','opening_amount','trigger_price','settlement_amount','old_fees','new_fees'}
INTEGER={'revision','direction','watch_group_sort','trigger_above'}


def column_type(table,name):
    if name in INTEGER:return 'bigint'
    if name in NUMERIC:return 'numeric'
    return 'TEXT'


def rows():
    result={name:[] for name in TABLES}
    result['broker_accounts']=[{'id':'old-broker-1','user_id':OWNER,'name':'Synthetic old broker','provider_id':'longbridge','currency':'USD','currencies_json':'["USD"]','account_kind':'real','holding_source':'manual','revision':2,'created_at':'2026-01-01T09:00:00-05:00','updated_at':'2026-01-01T09:00:00-05:00'}]
    result['records']=[{'id':'old-record-1','user_id':OWNER,'name':'Synthetic stock','code':'AAPL','market':'US','account_market':'','price':'12','qty':'8','cost':'9.625','source':'','broker_account_id':'old-broker-1','revision':3,'updated_at':'2026-01-03T10:00:00-05:00'}]
    result['record_revisions']=[{'user_id':OWNER,'record_id':'old-record-1','revision':3}]
    for i,side,qty,price,fees,amount,bqty,bcost,aqty,acost in ((1,'buy','10','10','1','100','0','0','10','10.1'),(2,'sell','2','12','0.5','24','10','10.1','8','9.625')):
        oid='old-order-'+str(i);when=f'2026-01-0{i+1}T10:00:00-05:00'
        result['trade_orders'].append({'id':oid,'user_id':OWNER,'record_id':'old-record-1','market':'US','code':'AAPL','name':'Synthetic stock','side':side,'status':'filled','qty':qty,'price':price,'fees':fees,'amount':amount,'position_qty_before':bqty,'position_cost_before':bcost,'position_qty_after':aqty,'position_cost_after':acost,'traded_at':when,'created_at':when,'order_no':'source-no-'+str(i),'order_type':'limit','tif':'day','session':'regular'})
        result['app_asset_order_versions'].append({'order_id':oid,'revision':7+i})
        fee_input={'source':'owner_recorded','confirmed':True,'brokerAccountId':'old-broker-1','providerId':'longbridge'}
        fee_detail={'source':'owner_recorded','currency':'USD','total':fees,'brokerAccountId':'old-broker-1','providerId':'longbridge'}
        result['trade_fee_details'].append({'order_id':oid,'user_id':OWNER,'input_json':json.dumps(fee_input),'detail_json':json.dumps(fee_detail),'created_at':when})
        result['broker_cash_order_links'].append({'order_id':oid,'user_id':OWNER,'account_id':'old-broker-1','currency':'USD'})
        receipt={'requestId':str(UUID(int=i)),'kind':'submit_trade','state':'completed','accountId':OWNER,'data':{'items':[{'id':oid}]}}
        result['app_asset_operations'].append({'user_id':OWNER,'request_id':str(UUID(int=i)),'result_json':json.dumps(receipt)})
        result['fund_transactions'].append({'id':'fund-order-'+oid,'user_id':OWNER,'currency':'USD','type':'adjustment','amount':'101' if i==1 else '23.5','direction':-1 if i==1 else 1,'occurred_at':when,'created_at':when,'note':'old automatic projection duplicate'})
    when='2026-01-01T09:00:00-05:00'
    result['fund_transactions'].append({'id':'old-fund-opening','user_id':OWNER,'currency':'USD','type':'opening','amount':'1000.000000000000000000','direction':1,'occurred_at':when,'created_at':when,'note':'synthetic original opening'})
    result['broker_cash_accounts'].append({'user_id':OWNER,'account_id':'old-broker-1','currency':'USD','revision':3,'opening_amount':'1000.000000000000000000','opening_at':when,'opening_basis':'new_external_opening'})
    result['broker_cash_entries'].append({'id':'old-broker-cash-opening','user_id':OWNER,'account_id':'old-broker-1','currency':'USD','kind':'opening','amount':'1000.000000000000000000','direction':1,'occurred_at':when,'created_at':when,'note':'same wealth as fund row','operation_id':str(UUID(int=3)),'fund_id':'old-fund-opening'})
    # A second user's row must never enter this owner's source manifest.
    result['fund_transactions'].append({'id':'other-owner-fund','user_id':'unrelated-old-owner','currency':'EUR','type':'opening','amount':'9999','direction':1,'occurred_at':when,'created_at':when,'note':'owner isolation sentinel'})
    return result


async def seed_pg(conn,data=None):
    data=data or rows()
    await conn.execute('CREATE TABLE users(id text PRIMARY KEY,password_hash text)')
    await conn.execute("INSERT INTO users VALUES(%s,'synthetic-password-MUST-NOT-EXPORT')",(OWNER,))
    for name,(columns,scope) in TABLES.items():
        declarations=[sql.SQL('{} {}').format(sql.Identifier(c),sql.SQL(column_type(name,c))) for c in columns.split()]
        await conn.execute(sql.SQL('CREATE TABLE {} ({})').format(sql.Identifier(name),sql.SQL(',').join(declarations)))
        for row in data[name]:
            await conn.execute(sql.SQL('INSERT INTO {} ({}) VALUES ({})').format(sql.Identifier(name),sql.SQL(',').join(map(sql.Identifier,row)),sql.SQL(',').join(sql.Placeholder() for _ in row)),tuple(row.values()))
    await conn.execute("CREATE TABLE broker_connections(secret text);INSERT INTO broker_connections VALUES ('synthetic-secret-MUST-NOT-EXPORT')")


