from uuid import uuid4
from decimal import Decimal
import httpx
import pytest
from alcor_api.native_app_auth import issue_grant
from .segment_helpers import imported
from .helpers import export
from .test_scope_derivation import add_unknown_hkd_source


@pytest.mark.asyncio
async def test_closed_a_is_readable_b_unknown_is_visible_and_global_canonical_and_old_app_are_limited(client,admin,old_pg,app,pg):
    grant,first,account,record,finance=await imported(client,admin,old_pg)
    await add_unknown_hkd_source(pg,old_pg)
    current,*_=await export(client,grant,predecessor=first['manifestSha256'])
    assert current['headAdvanced'] and not current['financialReady']
    async with app.state.db.connection() as conn:
        from alcor_api.scope_coverage import status
        coverage=await status(conn,admin)
        assert not coverage['complete'] and {r['scope']:r['complete'] for r in coverage['scopes']}=={'real:HKD':False,'real:USD':True},coverage
        user=await(await conn.execute('SELECT * FROM users WHERE id=%s',(admin,))).fetchone()
        native=await issue_grant(conn,user,'portfolio.read','Synthetic scope device')
    global_read=await client.get('/api/portfolio/records');assert global_read.status_code==409 and global_read.headers.get('x-alcor-financial-scope')=='incomplete',global_read.text
    scoped=await client.get('/api/portfolio/records',params={'brokerAccountId':account});assert scoped.status_code==200 and scoped.json()['total']==1 and scoped.json()['records'][0]['id']==record,scoped.text
    assert (await client.get('/api/portfolio/records/'+record)).status_code==200
    assert (await client.get('/api/trading/fills',params={'recordId':record})).status_code==200
    cash=await client.get('/api/cash/accounts/'+account)
    assert cash.status_code==200 and Decimal(cash.json()['currencies'][0]['balance'])==Decimal('922.5') and cash.json()['currencies'][0]['complete'] and not cash.json()['currencies'][0]['ownerCashComplete'],cash.text
    # Legacy full-portfolio contracts have no completeness channel; reject rather
    # than silently return A as the whole owner, including filtered old-App reads.
    app_read=await client.get('/api/v1/records',headers={'authorization':'Bearer '+native['access_token']})
    assert app_read.status_code==409,app_read.text
    app_filter=await client.get('/api/v2/records',params={'market':'US'},headers={'authorization':'Bearer '+native['access_token']})
    assert app_filter.status_code==409,app_filter.text
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver',headers={'origin':'http://testserver'}) as web:
        login=await web.post('/api/auth/login',json={'username':'SourceAdministrator','password':'Synthetic9Pass'});assert login.status_code==200,login.text
        old=await web.get('/api/records');assert old.status_code==409,old.text
    raw=(await client.get('/api/legacy-financial/manifests/'+current['manifestId']+'/raw')).json()
    assert any(row['id']['text']=='old-order-B' and row['fees']['null'] for row in raw['tables']['trade_orders']['rows'])


@pytest.mark.asyncio
async def test_unknown_owner_currency_cannot_fund_global_allocations_but_proved_independent_account_remains_usable(client,admin,old_pg,app,pg):
    grant,first,account,record,finance=await imported(client,admin,old_pg)
    await add_unknown_hkd_source(pg,old_pg);await export(client,grant,predecessor=first['manifestSha256'])
    response=await client.post('/api/broker-accounts',json={'request_id':str(uuid4()),'name':'Synthetic independent manual book','provider_id':'longbridge','account_kind':'real','currency':'HKD','currencies':['HKD']});assert response.status_code==201,response.text
    manual=response.json()['data']['id']
    opening={'requestId':str(uuid4()),'accountId':manual,'accountKind':'real','currency':'HKD','action':'opening','amount':'100','occurredAt':'2026-02-01T10:00:00Z','openingBasis':'new_external_opening'}
    p=await client.post('/api/cash/preview',json=opening)
    assert p.status_code==200 and p.json()['ownerCashAfter'] is None and not p.json()['ownerCashComplete'],p.text
    posted=await client.post('/api/cash/operations',json={'data':opening,'preview':p.json()['preview']})
    assert posted.status_code==200 and posted.json()['ownerCashAfter'] is None and not posted.json()['ownerCashComplete'],posted.text
    # The manual account retains its own proved value; it is not claimed to be
    # the still-unknown HKD value of the original source owner.
    own=(await client.get('/api/cash/accounts/'+manual)).json()['currencies'][0]
    assert own['balance']=='100' and own['complete'] and not own['ownerCashComplete']
    withdraw={k:v for k,v in {**opening,'requestId':str(uuid4()),'action':'external_withdrawal','amount':'1'}.items() if k!='openingBasis'}
    response=await client.post('/api/cash/preview',json=withdraw);assert response.status_code==200 and response.json()['balanceAfter']=='99' and response.json()['ownerCashAfter'] is None,response.text
    # The broker USD scope is closed, but unexported financial families still
    # prevent representing it as the whole owner USD balance.
    deposit={k:v for k,v in {**opening,'requestId':str(uuid4()),'accountId':account,'currency':'USD','action':'external_deposit','amount':'2'}.items() if k!='openingBasis'}
    p=await client.post('/api/cash/preview',json=deposit);assert p.status_code==200 and p.json()['ownerCashAfter'] is None and not p.json()['ownerCashComplete'],p.text


@pytest.mark.asyncio
async def test_user_without_registered_legacy_source_keeps_normal_global_and_cash_reads(client,admin,app):
    assert (await client.get('/api/portfolio/records')).status_code==200
    async with app.state.db.connection() as conn:
        from alcor_api.scope_coverage import status,scope_status
        state=await status(conn,admin)
        assert state=={'complete':True,'sourcePresent':False,'scopes':[]}
        assert await scope_status(conn,admin,'real','USD')


@pytest.mark.asyncio
async def test_unknown_b_same_usd_still_allows_proved_a_reads_but_not_owner_cash_funding(client,admin,old_pg,app,pg):
    import psycopg
    grant,first,account,record,finance=await imported(client,admin,old_pg)
    await add_unknown_hkd_source(pg,old_pg)
    async with await psycopg.AsyncConnection.connect(pg.get_uri(database=old_pg.expected_database)) as conn:
        await conn.execute("UPDATE broker_accounts SET currency='USD',currencies_json='[\"USD\"]' WHERE id='old-broker-B'")
        await conn.execute("UPDATE records SET market='US',code='MSFT' WHERE id='old-record-B'")
        await conn.execute("UPDATE trade_orders SET market='US',code='MSFT' WHERE id='old-order-B'")
        for table in ('broker_cash_accounts','fund_transactions','broker_cash_entries','broker_cash_order_links'):
            await conn.execute("UPDATE "+table+" SET currency='USD' WHERE currency='HKD'")
    current,*_=await export(client,grant,predecessor=first['manifestSha256']);assert not current['financialReady']
    cash=await client.get('/api/cash/accounts/'+account);assert cash.status_code==200,cash.text
    row=cash.json()['currencies'][0]
    assert row['complete'] and Decimal(row['balance'])==Decimal('922.5') and not row['ownerCashComplete'],row
    scoped=await client.get('/api/portfolio/records',params={'brokerAccountId':account})
    assert scoped.status_code==200 and scoped.json()['total']==1,scoped.text
    assert (await client.get('/api/portfolio/records')).status_code==409
    withdraw={'requestId':str(uuid4()),'accountId':account,'accountKind':'real','currency':'USD','action':'external_withdrawal','amount':'1','occurredAt':'2026-03-01T10:00:00Z'}
    independent=await client.post('/api/cash/preview',json=withdraw)
    assert independent.status_code==200 and Decimal(independent.json()['balanceAfter'])==Decimal('921.5') and independent.json()['ownerCashAfter'] is None,independent.text
    fill={'requestId':str(uuid4()),'recordId':record,'recordRevision':3,'side':'buy','quantity':'1','price':'10','amount':'10','fees':'0','currency':'USD','settlementCurrency':'USD','occurredAt':'2026-03-01T10:00:00Z','confirmedActualFill':True}
    response=await client.post('/api/trading/preview',json=fill)
    assert response.status_code==200 and Decimal(response.json()['cashBefore'])==Decimal('922.5') and Decimal(response.json()['cashAfter'])==Decimal('912.5'),response.text
    assert response.json()['ownerCashAfter'] is None and not response.json()['ownerCashComplete']
    # Proved A may use only A's own actual cash; unknown owner wealth never
    # supplies an excess purchase and no preview has posted a fill.
    excess=await client.post('/api/trading/preview',json={**fill,'requestId':str(uuid4()),'quantity':'100','amount':'1000'})
    assert excess.status_code==409,excess.text
    fees=(await client.get('/api/fees/repairs',params={'brokerAccountId':account})).json()
    correction={'requestId':str(uuid4()),'accountId':admin,'brokerAccountId':account,'providerId':'longbridge','brokerRevision':fees['brokerRevision'],'snapshotRevision':fees['snapshotRevision'],'ruleVersion':fees['ruleVersion'],'plan':{'effectiveFrom':'2025-05-14','effectiveThrough':'2026-10-20','confirmed':True},'orders':[{'orderId':item['orderId'],'revision':item['revision'],'recordRevision':item['recordRevision'],'instrumentKind':'us_domestic_equity','wholeOrderConfirmed':True,'brokerOwnershipConfirmed':True,'legacyImportConfirmed':True} for item in fees['items']]}
    async def financial_rows():
        from psycopg import sql
        async with app.state.db.connection() as conn, conn.transaction():
            result = {}
            for table in ('cash_ledger_entries','trade_ledger','portfolio_records','trade_fee_corrections','trade_fee_projections'):
                row = await (await conn.execute(sql.SQL("SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) rows FROM {} t").format(sql.Identifier(table)))).fetchone()
                result[table] = row['rows']
            return result
    before = await financial_rows()
    response=await client.post('/api/fees/repairs/preview',json=correction)
    assert response.status_code==200,response.text
    preview=response.json()
    assert not preview['canSubmit'] and preview['candidates']==[]
    assert preview['excluded'] and all(item['reason']=='explicit_fee_preserved' for item in preview['excluded'])
    assert preview['positionEffects']==[] and preview['cashEffect']['delta']=='0'
    assert preview['cashEffect']['before'] is None and preview['cashEffect']['after'] is None
    assert await financial_rows()==before
