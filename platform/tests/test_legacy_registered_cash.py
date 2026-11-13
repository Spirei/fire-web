"""Sealed legacy book parity is independent from actual cash authorization."""

import copy
import json
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest
from psycopg.types.json import Jsonb

from alcor_api.database_migration_capture import canonical, sha
from alcor_api.backups import BackupFailure
from alcor_api.legacy_registered_cash import CURRENCIES, book_from_original, empty_source_cards
from test_legacy_order_projection import table


def sealed_book(*, net=False):
    base = {'user_id':'source-owner','market':'US','code':'SYN','name':'Synthetic','record_id':'source-record',
        'qty':'2','price':'10','settlement_currency':None,'settlement_amount':None,
        'traded_at':'2026-01-02T12:00:00Z','created_at':'2026-01-02T12:00:00Z'}
    orders = [{**base,'id':'buy','status':'filled','side':'buy','amount':'20','fees':'1'},
              {**base,'id':'sell','status':'filled','side':'sell','amount':'50','fees':'2'},
              {**base,'id':'pending','status':'pending','side':'buy','amount':'999','fees':'9'}]
    if net:orders.append({**base,'id':'net','status':'filled','side':'sell','market':'HK','settlement_currency':'CNY','settlement_amount':'100','fees':None,'amount':'20'})
    funds = [{'id':'fund-manual','user_id':'source-owner','currency':'USD','type':'adjustment','amount':'100','direction':'1',
              'note':'Synthetic independent amount','occurred_at':base['traded_at'],'created_at':base['created_at']},
             {'id':'fund-order-buy','user_id':'source-owner','currency':'USD','type':'adjustment','amount':'99999','direction':'-1',
              'note':'Synthetic old automatic copy','occurred_at':base['traded_at'],'created_at':base['created_at']}]
    raw = {'format':'legacy-storage-snapshot/1','source':{'instance':'synthetic-source','owner':'source-owner',
        'ownerVerified':True,'datasetIdentityVerified':True,'timezone':'UTC'},'tables':{}}
    for name, rows in [('trade_orders',orders),('fund_transactions',funds)]:
        raw['tables'][name] = table(rows)
        raw['tables'][name]['columns'] = [{'name':key,'type':'text'} for key in rows[0]]
    packet = {'format':'registered-history/1','source_instance':'synthetic-source','source_owner':'source-owner',
        'orders':orders,'funds':funds,'timezone':'UTC','maps':{'accounts':{'source-account':'target-account'},'records':{'source-record':'target-record'}},
        'normalized_orders':{row['id']:{'sourceOwner':'source-owner','status':row['status'],'fillAuthority':'owner_recorded_history' if row['status']=='filled' else 'not_filled',
            'accountKind':'real','settlementCurrency':row['settlement_currency'] or ('HKD' if row['market']=='HK' else 'USD'),'occurredAt':row['traded_at'],'version':'1','currency':'HKD' if row['market']=='HK' else 'USD','feeAuthority':'unverified_legacy','sourceAccountId':'source-account'} for row in orders},
        'raw_snapshot':raw}
    return {'originals':packet,'source_instance':'synthetic-source','source_owner':'source-owner','source_sha256':sha(canonical(packet))}


def reseal(value):
    p=value['originals']
    for name, rows in [('trade_orders',p['orders']),('fund_transactions',p['funds'])]:
        p['raw_snapshot']['tables'][name]['rows'] = table(rows)['rows']
    value['source_sha256'] = sha(canonical(p))


def archive(tmp_path, stored, *, nonempty=False, omit=None):
    identifier=uuid4();root=tmp_path/'database-migrations'/str(identifier)/'attempt-1'/'source'
    root.mkdir(parents=True,mode=0o700)
    for directory in (root,*list(root.parents)[:3]):directory.chmod(0o700)
    (root/'rows').mkdir(mode=0o700)
    required = {'card_amounts':('user_id','card_key','amount','currency'),
                'card_details':('user_id','card_key','currency'), 'card_balance_history':('user_id','card_key','balance')}
    schema='\n'.join('CREATE TABLE legacy.'+name+' (\n'+',\n'.join('    '+field+' text' for field in fields)+'\n);' for name,fields in required.items()).encode()
    (root/'schema.sql').write_bytes(schema);(root/'schema.sql').chmod(0o600)
    manifest={'identity':{'system_identifier':'controlled','oid':1,'database':'source'},'snapshot':'synthetic-snapshot',
        'selected_schema':'legacy','schema_sha256':sha(schema),'tables':[]}
    for name in required:
        if name==omit:continue
        raw=b'{}\n' if nonempty and name=='card_amounts' else b''
        relative='rows/'+sha(name.encode())+'.jsonl';p=root/relative;p.write_bytes(raw);p.chmod(0o600)
        manifest['tables'].append({'schema':'legacy','name':name,'rows':int(bool(raw)),'file':relative,'file_sha256':sha(raw)})
    content=canonical(manifest);(root/'manifest.json').write_bytes(content);(root/'manifest.json').chmod(0o600)
    packet=stored['originals'];identity=sha(canonical(manifest['identity']))
    stored['source_instance']=packet['source_instance']=packet['raw_snapshot']['source']['instance']=identity
    packet['source_manifest_sha256']=sha(content)
    packet['raw_snapshot']['source'].update(schemaHash=sha(schema),snapshotToken=manifest['snapshot'])
    reseal(stored)
    return {'archive_task':str(identifier),'archive_attempt':1},root


def test_original_filled_flows_ignore_automatic_copies_and_do_not_require_an_invented_opening():
    stored=sealed_book(net=True);before=copy.deepcopy(stored)
    result=book_from_original(stored)
    assert result['balances']['USD']==Decimal('127') and result['balances']['CNY']==100
    assert result['summaries']['USD']=={'openingAsset':0,'cashNetFlow':0,'stockNetFlow':27,'otherNetFlow':100}
    assert set(result['balances'])==set(CURRENCIES) and 'CHF' not in CURRENCIES
    assert stored==before and stored['originals']['normalized_orders']['buy']['feeAuthority']=='unverified_legacy'


@pytest.mark.parametrize('broken',['digest','owner','dataset','missing_table','changed_cells','null_fee','unknown_net','mixed_kind','unknown_currency'])
def test_unproved_cash_never_becomes_a_zero_or_complete_book(broken):
    stored=sealed_book(net=True);p=stored['originals']
    if broken=='digest':stored['source_sha256']='0'*64
    elif broken=='owner':p['raw_snapshot']['source']['owner']='another-owner'
    elif broken=='dataset':p['raw_snapshot']['source']['datasetIdentityVerified']=False
    elif broken=='missing_table':p['raw_snapshot']['tables']['fund_transactions']['present']=False
    elif broken=='changed_cells':p['orders'][0]['amount']='21'
    elif broken=='null_fee':p['orders'][0]['fees']=None
    elif broken=='unknown_net':p['orders'][-1]['settlement_amount']=None
    elif broken=='mixed_kind':p['normalized_orders']['sell']['accountKind']='simulated'
    elif broken=='unknown_currency':p['funds'][0]['currency']='CHF'
    if broken not in ('digest','changed_cells'):reseal(stored)
    with pytest.raises((ValueError,KeyError,ArithmeticError)):book_from_original(stored)


@pytest.mark.parametrize('nonempty,omit,expected',[(False,None,True),(True,None,False),(False,'card_amounts',False)])
def test_captured_empty_cards_are_distinct_from_unexported_or_unmapped_rows(tmp_path,nonempty,omit,expected):
    stored=sealed_book();binding,root=archive(tmp_path,stored,nonempty=nonempty,omit=omit)
    settings=SimpleNamespace(backup_dir=tmp_path)
    assert empty_source_cards(settings,stored,binding) is expected
    if expected:
        (root/'rows'/ (sha(b'card_amounts')+'.jsonl')).write_bytes(b'changed')
        with pytest.raises(BackupFailure):empty_source_cards(settings,stored,binding)


async def store_packet(db, owner, stored, binding):
    task,portfolio,conversion=uuid4(),uuid4(),uuid4();request=uuid4()
    async with db.connection() as conn,conn.transaction():
        for tid,kind in [(task,'database.migration.history'),(portfolio,'database.migration.portfolio'),(conversion,'database.migration.convert')]:
            await conn.execute("INSERT INTO tasks(id,owner_id,request_id,fingerprint,kind,status,payload) VALUES(%s,%s,%s,%s,%s,'succeeded',%s)",
                (tid,owner,uuid4(),'1'*64,kind,Jsonb({'_archive':binding})))
        await conn.execute('''INSERT INTO database_migration_history_imports(owner_id,request_id,task_id,portfolio_task_id,conversion_id,
            source_instance,source_owner,source_sha256,fingerprint,originals,result) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''',
            (owner,request,task,portfolio,conversion,stored['source_instance'],stored['source_owner'],stored['source_sha256'],'2'*64,Jsonb(stored['originals']),Jsonb({'cash_posted':False})))


async def test_real_pg_and_original_http_models_share_registered_cash_without_financial_writes(client,app,db,admin,tmp_path):
    from source_pure_read_candidate.test_reads import snapshot
    from test_legacy_devices import bearer, grant
    from test_cash_ledger import account
    broker=await account(client,name='Synthetic registered book account without native opening')
    from alcor_api.portfolio_records import PortfolioRecords
    from test_portfolio_records import create
    current=await create(PortfolioRecords(db),admin,qty='0',price='10',cost='2')
    async with db.connection() as conn:
        await conn.execute('UPDATE portfolio_records SET broker_account_id=%s,qty=2 WHERE owner_id=%s AND id=%s',(broker,admin,current['record']['id']))
    stored=sealed_book();stored['originals']['maps']['accounts']['source-account']=broker
    binding,_=archive(tmp_path,stored);app.state.db.settings.backup_dir=tmp_path
    await store_packet(db,admin,stored,binding)
    headers=bearer(await grant(db,admin,'portfolio.read cash.read orders.read'))
    from test_fire_web import fire_login
    await fire_login(client)
    before=await snapshot(db)
    web=await client.get('/api/fire/funds');assert web.status_code==200,web.text
    assert web.json()['balances']['USD']==127 and web.json()['cardCash']['USD']==0
    assert web.json()['sourceOrdersReplayed'] is False
    for version in (1,2):
        funds=await client.get(f'/api/v{version}/funds?limit=1',headers=headers)
        assert funds.status_code==200,funds.text
        assert funds.json()['data']['balances']==web.json()['balances']
        value=await client.get(f'/api/v{version}/account-assets',headers=headers)
        assert value.status_code==200,value.text
        data=value.json()['data']
        assert data['cash']['source']=='recorded_cash_ledger' and data['cash']['valuationIndependent'] is True
        assert data['cash']['nativeBalancesByCurrency']==web.json()['balances']
        assert data['cash']['sourceRevision']==web.json()['snapshotRevision']
        assert data['summary']['totalCash']==127 and data['summary']['totalAsset']==147
        assert data['summary']['cashComplete'] is True and data['cash']['actualBrokerBalanceClaimed'] is False
        foreign=await client.get(f'/api/v{version}/account-assets?currency=HKD',headers=headers)
        assert foreign.status_code==200,foreign.text
        missing_fx=foreign.json()['data']
        assert missing_fx['cash']['sourceComplete'] is True and missing_fx['cash']['complete'] is False
        assert missing_fx['cash']['nativeBalancesByCurrency']==web.json()['balances']
        assert missing_fx['summary']['totalCash'] is None and missing_fx['summary']['totalAsset'] is None
        assert missing_fx['summary']['cashComplete'] is False
        # Independent registered display never supplies cash-reconciliation or trading authority.
        for strict_path in ('cash','trading'):
            strict=await client.get(f'/api/v{version}/account-assets/{strict_path}',headers={**headers,'x-alcor-trading-context':'nullable-v1'})
            assert strict.status_code==200,f'{strict_path}: {strict.text}'
            original=strict.json()['data']
            strict_cash=original['cash'] if strict_path=='trading' else original
            assert strict_cash['sourceComplete'] is False and strict_cash['nativeBalancesByCurrency'] is None
    assert await snapshot(db)==before
    async with db.connection() as conn:
        assert (await(await conn.execute('SELECT count(*) AS n FROM cash_ledger_entries')).fetchone())['n']==0
        assert (await(await conn.execute('SELECT count(*) AS n FROM trade_ledger')).fetchone())['n']==0


async def test_native_cards_checkpoints_and_owner_changes_cannot_duplicate_or_borrow_originals(client,app,db,admin,settings,tmp_path):
    from alcor_api.cli import create_user
    from test_cash_ledger import account, command, submit
    from test_legacy_devices import bearer,grant
    from source_pure_read_candidate.test_reads import snapshot
    broker=await account(client,name='Synthetic independent cash book')
    stored=sealed_book();binding,root=archive(tmp_path,stored);app.state.db.settings.backup_dir=tmp_path
    await store_packet(db,admin,stored,binding)
    other=await create_user(settings,'OtherCashOwner','Synthetic9Pass',email='other-cash@example.invalid')
    headers=bearer(await grant(db,admin,'portfolio.read cash.read'))
    foreign=bearer(await grant(db,other,'portfolio.read cash.read'))
    async with db.connection() as conn,conn.transaction():
        for key,kind,amount,currency,held in [
            ('synthetic-debit','借记卡','30','USD',True),('synthetic-prepaid','预付卡','15','HKD',True),
            ('synthetic-credit','信用卡',None,'USD',True),('synthetic-unheld','借记卡','999','USD',False),
            ('synthetic-gift','礼品卡','888','USD',True)]:
            await conn.execute('INSERT INTO card_custom_records(owner_id,id,image_path,metadata) VALUES(%s,%s,%s,%s)',
                (admin,uuid4(),key,Jsonb({'type':kind,'region':'美国'})))
            await conn.execute('INSERT INTO card_preference_holdings(owner_id,card_key,held) VALUES(%s,%s,%s)',(admin,key,held))
            await conn.execute('INSERT INTO card_wallet_accounts(owner_id,card_key,amount,currency) VALUES(%s,%s,%s,%s)',(admin,key,amount,currency))
    before=await snapshot(db)
    first=(await client.get('/api/v2/account-assets',headers=headers)).json()['data']
    assert first['cash']['sourceComplete'] is True and first['cash']['complete'] is False
    assert first['cash']['nativeBalancesByCurrency']['USD']==157 and first['cash']['nativeBalancesByCurrency']['HKD']==15
    assert first['summary']['totalCash'] is None  # Original HKD stays known without observed FX.
    independent=(await client.get('/api/v2/funds?balancesOnly=1',headers=foreign)).json()['data']
    assert independent['balances']['USD']!=157
    assert await snapshot(db)==before
    async with db.connection() as conn:
        await conn.execute("UPDATE card_wallet_accounts SET currency='USD' WHERE owner_id=%s AND card_key='synthetic-prepaid'",(admin,))
    second=(await client.get('/api/v2/account-assets',headers=headers)).json()['data']
    assert second['summary']['totalCash']==172 and second['summary']['cashComplete'] is True
    assert first['snapshotRevision']!=second['snapshotRevision']
    # A new explicit native opening supersedes the sealed display baseline for that currency.
    login=await client.post('/api/session/login',json={'login':'AdminOne','password':'Synthetic9Pass'})
    client.headers['x-csrf-token']=login.json()['csrf']
    await submit(client,command(broker,amount='1000'))
    after_opening=(await client.get('/api/v2/account-assets',headers=headers)).json()['data']
    assert after_opening['cash']['nativeBalancesByCurrency']['USD']==1045
    assert after_opening['summary']['totalCash']==1045
    assert after_opening['snapshotRevision']!=second['snapshotRevision']
    # A known simulated card must never leak into the real recorded book.
    async with db.connection() as conn:
        await conn.execute("UPDATE card_wallet_accounts SET account_kind='simulated' WHERE owner_id=%s AND card_key='synthetic-debit'",(admin,))
    mixed=(await client.get('/api/v2/funds?balancesOnly=1',headers=headers)).json()['data']
    assert mixed['cardCashCoverageKnown'] is False and mixed['balances']['USD']==1000
    # Revoke the actual test grant and reject every existing entry point.
    async with db.connection() as conn:
        await conn.execute('UPDATE identity_app_grants SET revoked_at=clock_timestamp() WHERE user_id=%s',(admin,))
    for path in ('/api/v2/funds','/api/v2/account-assets'):
        assert (await client.get(path,headers=headers)).status_code==401
