"""History imports preserve original money, do not repost trades, and commit once."""
from decimal import Decimal
from uuid import uuid4
import psycopg
import pytest
from alcor_api.backups import BackupFailure
from alcor_api.database_migration_jobs import execute as prepare
from alcor_api.database_migration_conversion import execute as convert
from alcor_api.database_migration_portfolio import execute as portfolio
from alcor_api.database_migration_history import execute as history,registered_orders,registered_funds
from alcor_api.worker import claim
from test_database_migration_preparation import migration_source
from test_database_migration_conversion import add_source


async def test_original_history_is_visible_atomic_and_deduplicated(client,db,settings,pg,migration_source,monkeypatch):
    config,revision=migration_source;dsn=pg.get_uri(database=config['database']);add_source(dsn)
    with psycopg.connect(dsn) as c:
        c.execute('''CREATE TABLE ledger.trade_orders(id text,user_id text,record_id text,market text,code text,name text,side text,status text,qty numeric,price numeric,fees numeric,amount numeric,realized_pnl numeric,position_qty_after numeric,position_cost_after numeric,broker text,note text,traded_at text,created_at text,position_qty_before numeric,position_cost_before numeric,order_no text,order_type text,trigger_price numeric,tif text,expires_at text,session text,trigger_status text,settlement_currency text,settlement_amount numeric)''')
        c.execute("""INSERT INTO ledger.trade_orders(id,user_id,record_id,market,code,name,side,status,qty,price,fees,amount,realized_pnl,position_qty_after,position_cost_after,broker,note,traded_at,created_at,position_qty_before,position_cost_before,order_no,order_type) VALUES
        ('original-fill','source-owner','position','US','TEST','Source security','sell','filled',1,123.000000000000000001,0,123.000000000000000001,23.000000000000000001,2,100.000000000000000001,'Original broker','original note','2020-01-01T00:00:00Z','2020-01-01T00:00:00Z',3,100.000000000000000001,'source-number','market'),
        ('original-pending','source-owner','position','US','TEST','Source security','sell','pending',1,200,0,200,NULL,2,100,'Original broker','','2020-01-02T00:00:00Z','2020-01-02T00:00:00Z',2,100,'pending-number','limit')""")
        c.execute('CREATE TABLE ledger.fund_transactions(id text,user_id text,currency text,type text,amount numeric,direction integer,note text,occurred_at text,created_at text)')
        c.execute("""INSERT INTO ledger.fund_transactions VALUES('fund-order-original-fill','source-owner','USD','adjustment',123.000000000000000001,1,'source trade cash','2020-01-01T00:00:00Z','2020-01-01T00:00:00Z'),('fund-original-adjustment','source-owner','USD','adjustment',8.000000000000000001,1,'original global adjustment','2020-01-02T00:00:00Z','2020-01-02T00:00:00Z')""")
    p=await client.post('/api/fire/database-migration/preparations',json={'request_id':str(uuid4()),'source_revision':revision});assert p.status_code==202,p.text
    t=await claim(db,uuid4());await prepare(db,t)
    cv=await client.post('/api/fire/database-migration/preparations/'+str(t['id'])+'/conversion',json={'request_id':str(uuid4()),'source_owner':'source-owner','timezone':'Asia/Shanghai','account_kinds':{'old-account':'real'},'market_accounts':{'US':'old-account'}});assert cv.status_code==202,cv.text
    conversion=await claim(db,uuid4());await convert(db,conversion)
    task=(await client.get('/api/fire/tasks/'+str(conversion['id']))).json()
    prefix='/api/fire/database-migration/conversions/'+str(conversion['id']);body={'request_id':str(uuid4()),'plan_sha256':task['result']['plan_sha256'],'confirmed_registered_values':True}
    assert (await client.post(prefix+'/history',json=body)).status_code==409
    admitted=await client.post(prefix+'/portfolio',json=body);assert admitted.status_code==202,admitted.text
    job=await claim(db,uuid4());await portfolio(db,job)
    before=(await client.get('/api/records')).json()
    command=body|{'request_id':str(uuid4())}
    result=await client.post(prefix+'/history',json=command);assert result.status_code==202,result.text
    assert (await client.post(prefix+'/history',json=command)).json()['id']==result.json()['id']
    running=await claim(db,uuid4())
    import alcor_api.database_migration_history as module
    complete=module.complete_on_connection
    async def fault(*args):raise BackupFailure('injected completion fault')
    monkeypatch.setattr(module,'complete_on_connection',fault)
    with pytest.raises(BackupFailure,match='injected'):await history(db,running)
    async with db.connection() as c:
        assert (await(await c.execute('SELECT count(*) n FROM database_migration_history_imports')).fetchone())['n']==0
    monkeypatch.setattr(module,'complete_on_connection',complete)
    await history(db,running)
    final=(await client.get('/api/fire/tasks/'+str(running['id']))).json();assert final['status']=='succeeded',final
    assert final['result']['counts']=={'orders':2,'funds':2,'independent_funds':1,'recorded_pnl':1}
    assert final['result']['history_imported'] and final['result']['cash_posted'] is False
    async with db.connection() as c:
        orders=await registered_orders(c,running['owner_id']);funds=await registered_funds(c,running['owner_id'])
        assert len(orders)==len(funds)==2
        fill=next(r for r in orders if r['id']=='original-fill')
        assert fill['fees']==0 and fill['actualFeeKnown'] is False
        assert fill['realizedPnl']==Decimal('23.000000000000000001')
        assert fill['positionCostAfter']==Decimal('100.000000000000000001')
        assert next(r for r in orders if r['id']=='original-pending')['status']=='imported_suspended'
        assert all(r['cancellable'] is False and r['historyLocked'] is True and r['apiManaged'] is False for r in orders)
        assert next(r for r in funds if r['id']=='fund-original-adjustment')['accountId'] is None
        assert len(await registered_orders(c,'different-owner'))==0
        for table in ('trade_ledger','cash_ledger_entries','internal_orders'):
            assert (await(await c.execute('SELECT count(*) n FROM '+table)).fetchone())['n']==0
    from test_legacy_trade_corrections import native_headers
    headers=await native_headers(db,running['owner_id'],'portfolio.read')
    visible=await client.get('/api/v1/account-assets/orders?scope=all',headers=headers);assert visible.status_code==200,visible.text
    assert visible.json()['data']['count']==2
    funds=await client.get('/api/v1/funds?recordsOnly=1');assert funds.status_code==200,funds.text
    assert funds.json()['data']['pagination']['total']==2 and len(funds.json()['data']['transactions'])==2
    assert (await client.get('/api/records')).json()==before
    await history(db,running)
    assert (await client.post(prefix+'/history',json=command)).json()['id']==result.json()['id']
    assert (await client.post(prefix+'/history',json=command|{'request_id':str(uuid4())})).status_code==409
    cancel=await client.post('/api/fire/database-migration/history/cancel',json={'request_id':command['request_id']})
    assert cancel.json()['status']=='succeeded' and cancel.json()['result']['history_imported']
    saved=(await client.get('/api/fire/database-migration/preparations/'+str(t['id'])+'/conversion')).json()
    assert saved['history_imports'][0]['id']==str(running['id'])
