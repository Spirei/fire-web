"""Two deferred native HTTP workflows over isolated PG, without provider collection."""

from uuid import uuid4

from source_pure_read_candidate.test_reads import snapshot as business_snapshot
from test_cash_ledger import command as cash_command
from test_cash_ledger import submit as cash_submit
from test_legacy_broker_read import bearer, grant
from test_trading import setup as trading_setup

SCOPES='portfolio.read portfolio.write cash.read positions.read assets.read'


async def test_native_cash_assets_unknown_reads_scopes_and_instrument_receipt(client,db,admin):
    pair=await grant(db,admin,SCOPES)
    headers=bearer(pair)
    before=await business_snapshot(db)
    for version in (1,2):
        base=f'/api/v{version}'
        for path in ('/account-assets/cash','/broker-accounts/cash','/account-assets/positions','/account-assets/summary'):
            response=await client.get(base+path,headers=headers)
            assert response.status_code==200,response.text
            data=response.json()['data']
            if path.endswith('/positions'):
                assert data['items']==[]
            elif path.endswith('/summary'):
                assert data['summary']['totalCash'] is None
                assert data['summary']['totalAsset'] is None
                assert data['summary']['cashComplete'] is False
            elif path=='/account-assets/cash':
                assert data['nativeBalancesByCurrency'] is None
                assert data['sourceComplete'] is False
                assert data['transactions']==[]
            else:
                assert data['byCurrency']==[] and data['complete'] is False
            assert 'no-store' in response.headers['cache-control']
        for invalid in ({'authorization':pair['access_token']},{'authorization':'bearer '+pair['access_token']},{}):
            response=await client.get(base+'/account-assets/cash',headers=invalid)
            assert response.status_code==401,response.text
    assert await business_snapshot(db)==before

    # Position/summary reads require both their dedicated grant and portfolio.read.
    for scopes,path in (('portfolio.read','cash'),('portfolio.read','positions'),('portfolio.read','summary'),
                        ('positions.read','positions'),('assets.read','summary')):
        limited=await grant(db,admin,'portfolio.read '+scopes)
        if 'portfolio.read' not in scopes.split():
            # Token issuance requires the base scope. Model a later isolated
            # server-side scope revocation rather than issuing an illegal grant.
            async with db.connection() as conn:
                await conn.execute('UPDATE identity_app_grants SET scope=%s WHERE id=%s AND user_id=%s',
                                   (scopes,limited['grant_id'],admin))
        response=await client.get('/api/v2/account-assets/'+path,headers=bearer(limited))
        assert response.status_code==403,response.text

    _account,record=await trading_setup(client,name='Synthetic declaration account')
    root='/api/v1/account-assets/instruments/'+record['id']
    first=await client.get(root,headers=headers)
    assert first.status_code==200,first.text
    state=first.json()['data']
    assert state['instrument']['revision']==0
    assert state['instrument']['kind']=='unknown'
    assert state['instrument']['multiplier'] is None
    mutation={'requestId':str(uuid4()),'recordRevision':state['recordRevision'],'revision':0,
              'kind':'cash_equity','listingStatus':'listed'}
    async with db.connection() as conn:
        original=await (await conn.execute('SELECT to_jsonb(r) AS row FROM portfolio_records r WHERE owner_id=%s AND id=%s',(admin,record['id']))).fetchone()
    applied=await client.put(root,json=mutation,headers=headers)
    assert applied.status_code==200,applied.text
    receipt=applied.json()['data']
    assert receipt['state']=='completed' and receipt['financialIdentityChanged'] is False
    assert receipt['data']['instrument']['revision']==1
    assert receipt['data']['instrument']['kind']=='cash_equity'
    assert (await client.put(root,json=mutation,headers=headers)).json()['data']==receipt
    for version in (1,2):
        lookup=await client.get(f'/api/v{version}/account-assets/operations/'+mutation['requestId'],headers=headers)
        assert lookup.status_code==200,lookup.text
        assert lookup.json()['data']==receipt
    async with db.connection() as conn:
        current=await (await conn.execute('SELECT to_jsonb(r) AS row FROM portfolio_records r WHERE owner_id=%s AND id=%s',(admin,record['id']))).fetchone()
    assert current==original
    denied=await grant(db,admin,'portfolio.read')
    assert (await client.put(root,json={**mutation,'requestId':str(uuid4())},headers=bearer(denied))).status_code==403


async def test_native_broker_cash_preview_submission_and_owner_target_stable_receipts(client,db,admin):
    account,_record=await trading_setup(client,name='Synthetic legacy cash account',amount='1000')
    pair=await grant(db,admin,SCOPES)
    headers=bearer(pair)
    first=await client.get('/api/v1/broker-accounts/cash?include=accounts',headers=headers)
    assert first.status_code==200,first.text
    global_cash=first.json()['data']
    current=next(item for item in global_cash['accounts'] if item['account']['id']==account)
    usd=next(item for item in current['cash']['currencies'] if item['currency']=='USD')
    assert usd['balance']==1000
    request={'requestId':str(uuid4()),'action':'external_deposit','currency':'USD','amount':100,
             'occurredAt':'2026-02-01T12:00:00Z','note':'Synthetic explicit cash deposit',
             'globalCashRevision':global_cash['globalCashRevision'],'brokerAccountId':account,
             'targets':[{'brokerAccountId':account,'brokerRevision':current['account']['revision'],
                         'cashRevision':usd['cashRevision']}]}
    preview=await client.post('/api/v1/broker-accounts/cash/preview',json=request,headers=headers)
    assert preview.status_code==200,preview.text
    proof=preview.json()['data']
    assert proof['canSubmit'] is True
    assert proof['effects'][0]['before']==1000 and proof['effects'][0]['after']==1100
    submission={**request,'previewRevision':proof['previewRevision']}
    submitted=await client.post('/api/v2/broker-accounts/cash/submissions',json=submission,headers=headers)
    assert submitted.status_code==200,submitted.text
    cash_receipt=submitted.json()['data']
    assert cash_receipt['state']=='completed'
    assert cash_receipt['kind']=='cash_external_deposit'
    assert cash_receipt['data']['snapshots'][0]['currencies'][0]['balance']==1100
    for version in (1,2):
        replay=await client.post(f'/api/v{version}/broker-accounts/cash/submissions',json=submission,headers=headers)
        assert replay.status_code==200,replay.text
        assert replay.json()['data']==cash_receipt
        lookup=await client.get(f'/api/v{version}/broker-accounts/operations/'+request['requestId'],headers=headers)
        assert lookup.status_code==200,lookup.text
        assert lookup.json()['data']==cash_receipt

    # An account opening proves its attributed cash, not an independently
    # observed unallocated-owner checkpoint. Explicitly register the synthetic
    # owner's verified zero; do not weaken CashLedger's missing-opening guard.
    await cash_submit(client,cash_command(None,amount='0',occurredAt='2026-02-02T12:00:00Z',
                                         note='Synthetic independently verified unallocated zero checkpoint'))
    observed=await client.get('/api/v2/account-assets/cash',headers=headers)
    assert observed.status_code==200,observed.text
    snapshot=observed.json()['data']
    assert snapshot['nativeBalancesByCurrency']['USD']==1100
    target={'requestId':str(uuid4()),'accountId':admin,'snapshotRevision':snapshot['snapshotRevision'],
            'currency':'USD','balance':1500,'note':'Synthetic owner total observation'}
    adjusted=await client.post('/api/v1/account-assets/cash',json=target,headers=headers)
    assert adjusted.status_code==200,adjusted.text
    original=adjusted.json()['data']
    assert original['kind']=='reconcile_cash'
    assert original['data']['before']==1100 and original['data']['after']==1500
    assert original['data']['adjustment']==400
    assert original['data']['nativeBalancesByCurrency']['USD']==1500
    assert 'transactions' not in original['data']
    before=await business_snapshot(db)
    for version in (1,2):
        replay=await client.post(f'/api/v{version}/account-assets/cash',json=target,headers=headers)
        assert replay.status_code==200,replay.text
        assert replay.json()['data']==original
        lookup=await client.get(f'/api/v{version}/account-assets/operations/'+target['requestId'],headers=headers)
        assert lookup.status_code==200,lookup.text
        assert lookup.json()['data']==original
    after = await business_snapshot(db)
    # Replaying a POST consumes its authentication rate budget, but no financial row.
    assert {key: value for key, value in after.items() if key != 'auth_rate_limits'} == {
        key: value for key, value in before.items() if key != 'auth_rate_limits'
    }
    # The old broker receipt stays its admitted immutable snapshot after later cash changes.
    lookup=await client.get('/api/v2/broker-accounts/operations/'+request['requestId'],headers=headers)
    assert lookup.status_code==200,lookup.text
    assert lookup.json()['data']==cash_receipt


async def test_native_positions_and_summary_keep_official_units_and_unknown_owner_cash(client, db, admin):
    from test_broker_statement_integration import BASE, XML
    from test_cash_ledger import account as empty_account

    account = await empty_account(client, name='Synthetic official valuation book')
    preview = await client.post(BASE + '/preview', json={
        'requestId': str(uuid4()), 'accountId': account, 'accountKind': 'real', 'revision': 1,
        'externalAccount': 'SYNTHETIC', 'xml': XML,
    })
    assert preview.status_code == 200, preview.text
    confirmed = await client.post(BASE + '/imports', json={
        'requestId': str(uuid4()), 'previewId': preview.json()['previewId'],
        'confirmExternalAccount': 'SYNTHETIC', 'takeOverOfficial': True, 'acknowledgeUnassigned': True,
    })
    assert confirmed.status_code == 200, confirmed.text
    headers = bearer(await grant(db, admin, SCOPES))
    before = await business_snapshot(db)
    for version in (1, 2):
        position = await client.get(f'/api/v{version}/account-assets/positions', headers=headers)
        assert position.status_code == 200, position.text
        row = position.json()['data']['items'][0]
        assert row['brokerAccountId'] == account and row['accountKind'] == 'real'
        assert (row['qty'], row['price'], row['cost']) == (2, 12, 10)
        assert row['nativeMarketValue'] == 24 and row['nativeCostValue'] == 20 and row['nativeHoldingPnl'] == 4
        assert row['priceAuthority'] == 'official_reported_mark_price'
        assert row['instrument']['kind'] == 'unknown' and row['valuationBasis'] == 'legacy_record_unit'
        assert row['valuationUnitMultiplier'] == 1 and row['dayPnl'] is None
        summary = await client.get(f'/api/v{version}/account-assets/summary', headers=headers)
        assert summary.status_code == 200, summary.text
        value = summary.json()['data']['summary']
        assert (value['totalMarket'], value['totalCost'], value['holdingPnl']) == (24, 20, 4)
        assert value['totalCash'] is None and value['totalAsset'] is None and value['cashComplete'] is False
    assert await business_snapshot(db) == before
