"""Known independent cash receipt must not pretend the unmigrated owner book is complete."""
from decimal import Decimal

from test_notification_composition import statement
from test_trading import setup, command as ordinary_command

from .helpers import authorized, export


async def test_actual_independent_dividend_credit_with_exported_unapplied_legacy_scope(client,admin,old_pg,app):
    grant=await authorized(client,admin,old_pg)
    original,*_=await export(client,grant)
    assert (await client.get('/api/portfolio/records')).status_code==409
    original_raw=(await client.get('/api/legacy-financial/manifests/'+original['manifestId']+'/raw')).content
    account,record=await setup(client,name='Independent new recorded account',code='SYN')
    command=statement(record,eventReference='independent-receipt-during-source-migration')
    preview=await client.post('/api/dividends/receipts/preview',json=command)
    assert preview.status_code==200,preview.text
    assert preview.json()['cashDelta']=='8.0' and preview.json()['ownerCashAfter'] is None
    payload={'data':command,'preview':preview.json()['preview']}
    submitted=await client.post('/api/dividends/receipts/operations',json=payload)
    assert submitted.status_code==200,submitted.text
    assert submitted.json()['cashAfter']=='1008.0' and submitted.json()['ownerCashAfter'] is None
    assert (await client.post('/api/dividends/receipts/operations',json=payload)).json()==submitted.json()
    receipt=await client.get('/api/dividends/receipts/operations/'+command['requestId'])
    assert receipt.status_code==200 and receipt.json()==submitted.json()
    cash=await client.get('/api/cash/accounts/'+account)
    usd=next(r for r in cash.json()['currencies'] if r['currency']=='USD')
    assert Decimal(usd['balance'])==Decimal('1008') and usd['complete'] and not usd['ownerCashComplete']
    assert (await client.get('/api/portfolio/records')).status_code==409
    assert (await client.get('/api/legacy-financial/manifests/'+original['manifestId']+'/raw')).content==original_raw
    current_record=(await client.get('/api/portfolio/records/'+record['id'])).json()['record']
    permitted=await client.post('/api/trading/preview',json=ordinary_command(current_record))
    assert permitted.status_code==200,permitted.text
    assert Decimal(permitted.json()['cashAfter'])==Decimal('987')
    assert permitted.json()['ownerCashAfter'] is None and not permitted.json()['ownerCashComplete']
    excessive=ordinary_command(current_record,quantity='200',amount='2000')
    assert (await client.post('/api/trading/preview',json=excessive)).status_code==409
    assert (await client.get('/api/portfolio/records')).status_code==409
    assert (await client.get('/api/legacy-financial/manifests/'+original['manifestId']+'/raw')).content==original_raw

    async with app.state.db.connection() as conn:
        assert (await(await conn.execute('SELECT count(*) n FROM dividend_receipts WHERE owner_id=%s',(admin,))).fetchone())['n']==1
        assert (await(await conn.execute('SELECT count(*) n FROM financial_import_operations WHERE owner_id=%s',(admin,))).fetchone())['n']==0
