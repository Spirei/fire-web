import copy
import json
from dataclasses import replace
from uuid import uuid4

import psycopg
import pytest
from psycopg import sql

from alcor_api.source_mapping import Mapping
from alcor_api.source_snapshot import PgSnapshot,canonical
from .synthetic_legacy import rows,OWNER
from alcor_api.scope_derivation import ScopeDerivation


async def add_unknown_hkd_source(pg,old_pg):
    data=rows();items={}
    items['broker_accounts']=copy.deepcopy(data['broker_accounts'][0]);items['broker_accounts'].update(id='old-broker-B',currency='HKD',currencies_json='["HKD"]')
    items['records']=copy.deepcopy(data['records'][0]);items['records'].update(id='old-record-B',broker_account_id='old-broker-B',code='0005',market='HK',qty='10',cost='10.1')
    items['record_revisions']={'user_id':OWNER,'record_id':'old-record-B','revision':3}
    items['trade_orders']=copy.deepcopy(data['trade_orders'][0]);items['trade_orders'].update(id='old-order-B',record_id='old-record-B',market='HK',code='0005',fees=None)
    items['app_asset_order_versions']={'order_id':'old-order-B','revision':8}
    items['broker_cash_order_links']={'order_id':'old-order-B','user_id':OWNER,'account_id':'old-broker-B','currency':'HKD'}
    items['broker_cash_accounts']=copy.deepcopy(data['broker_cash_accounts'][0]);items['broker_cash_accounts'].update(account_id='old-broker-B',currency='HKD')
    items['fund_transactions']=copy.deepcopy(data['fund_transactions'][2]);items['fund_transactions'].update(id='old-fund-B',currency='HKD')
    items['broker_cash_entries']=copy.deepcopy(data['broker_cash_entries'][0]);items['broker_cash_entries'].update(id='old-cash-B',account_id='old-broker-B',currency='HKD',fund_id='old-fund-B',operation_id='00000000-0000-0000-0000-000000000020')
    async with await psycopg.AsyncConnection.connect(pg.get_uri(database=old_pg.expected_database)) as conn:
        for table,item in items.items():
            await conn.execute(sql.SQL('INSERT INTO {} ({}) VALUES ({})').format(sql.Identifier(table),sql.SQL(',').join(map(sql.Identifier,item)),sql.SQL(',').join(sql.Placeholder() for _ in item)),tuple(item.values()))


@pytest.mark.asyncio
async def test_known_usd_scope_can_be_derived_but_unknown_hkd_stays_in_whole_source_inventory(old_pg,pg):
    await add_unknown_hkd_source(pg,old_pg)
    snapshot=await PgSnapshot().export(old_pg,OWNER);bundle=Mapping(snapshot).build()
    assert bundle['manifest']['normalizationBlockers']
    inventory=ScopeDerivation(bundle['manifest'],bundle['financial'])
    scopes=inventory.inventory();assert {r['scope'] for r in scopes}=={'real:USD','real:HKD'}
    usd=inventory.select('real:USD');hkd=inventory.select('real:HKD')
    assert usd['ready'],usd['blockers']
    assert not hkd['ready'] and any(r['code'] in ('actual_fee_authority_unknown','original_input_missing') for r in hkd['blockers'])
    assert usd['originalIds']=={'record':['old-record-1'],'order':['old-order-1','old-order-2'],'cash':['fund:old-fund-opening','order-projection:old-order-1','order-projection:old-order-2']}
    assert len(bundle['financial']['orders'])==3 and any(row['id']['text']=='old-order-B' for row in snapshot['tables']['trade_orders']['rows'])
    assert hkd['financial']['orders'][0]['fees'] is None  # not a fabricated zero
    assert hkd['financial']['cashScopes'][0]['ownerTotal'] is None
    assert len(bundle['financial']['cashScopes'])==2


@pytest.mark.asyncio
async def test_source_unknown_cash_in_same_currency_cannot_be_hidden_by_selecting_real_kind(old_pg,pg):
    async with await psycopg.AsyncConnection.connect(pg.get_uri(database=old_pg.expected_database)) as conn:
        await conn.execute("INSERT INTO fund_transactions(id,user_id,currency,type,amount,direction,occurred_at,created_at) VALUES('unassigned-old-cash',%s,'USD','opening',50,1,'2026-01-01T10:00:00-05:00','2026-01-01T10:00:00-05:00')",(OWNER,))
    bundle=Mapping(await PgSnapshot().export(old_pg,OWNER)).build()
    inventory=ScopeDerivation(bundle['manifest'],bundle['financial'])
    usd=inventory.select('real:USD')
    assert not usd['ready'] and any(r['code']=='unresolved_source_scope_overlaps_selected_scope' and r['scope']=='unknown:USD' for r in usd['blockers'])
    assert any(r['scope']=='unknown:USD' for r in inventory.inventory())


@pytest.mark.asyncio
async def test_independent_scope_semantic_hash_is_stable_across_snapshot_ids_but_not_economic_changes(old_pg,pg):
    await add_unknown_hkd_source(pg,old_pg)
    first=Mapping(await PgSnapshot().export(old_pg,OWNER)).build()
    exported=await PgSnapshot().export(old_pg,OWNER)
    exported['source']['exportOperationId']=str(uuid4())  # SourceAuthority adds this explicit original operation metadata.
    second=Mapping(exported).build()
    a=ScopeDerivation(first['manifest'],first['financial']).select('real:USD');b=ScopeDerivation(second['manifest'],second['financial']).select('real:USD')
    assert a['ready'] and b['ready'] and first['manifest']['rawSha256']!=second['manifest']['rawSha256']
    assert a['semanticSha256']==b['semanticSha256']
    changed=copy.deepcopy(second['financial']);changed['orders'][0]['amount']='100.01'
    c=ScopeDerivation(second['manifest'],changed).select('real:USD')
    assert c['semanticSha256']!=b['semanticSha256']
