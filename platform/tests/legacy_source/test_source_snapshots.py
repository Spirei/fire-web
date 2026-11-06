from source_window_fixture import active_window
import copy
import json
import struct
from dataclasses import replace
from pathlib import Path

import psycopg
import pytest
from psycopg import sql

from alcor_api.source_snapshot import PgSnapshot,SourceDefinition,SourceMismatch,canonical,schema_digest
from alcor_api.source_mapping import Mapping
from .synthetic_legacy import OWNER


@pytest.mark.asyncio
async def test_read_only_pg_preserves_numeric_text_projection_dedup_original_uuid_and_owner(old_pg):
    snapshot=await PgSnapshot().export(old_pg,OWNER);bundle=Mapping(snapshot).build()
    assert snapshot['source']['readOnly'] and snapshot['source']['isolation']=='repeatable read'
    assert b'MUST-NOT-EXPORT' not in canonical(snapshot) and b'other-owner-fund' not in canonical(snapshot)
    cell=next(r for r in snapshot['tables']['fund_transactions']['rows'] if r['id']['text']=='old-fund-opening')['amount']
    assert cell['text']=='1000.000000000000000000' and cell['storedDecimalExact'] and not cell['originalInputKnown']
    assert not bundle['manifest']['normalizationBlockers'],bundle['manifest']['normalizationBlockers']
    source=bundle['financial'];assert len(source['cash'])==3
    assert source['cashScopes'][0]['ownerTotal']=='922.500000000000000000'
    assert source['cashScopes'][0]['unallocated']=='0E-18'
    assert source['orders'][0]['requestId'].endswith('0001')
    projections=[x for x in bundle['manifest']['lineage'] if x.get('representation')=='existing_legacy_read_model_projection']
    assert len(projections)==2 and all(not x['physicalCashRow'] for x in projections)
    assert len([x for x in bundle['manifest']['lineage'] if x.get('excludedFundId')])==2
    async with await psycopg.AsyncConnection.connect(old_pg.locator) as conn:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):await conn.execute("UPDATE trade_orders SET fees=0")


@pytest.mark.asyncio
async def test_pg_identity_schema_owner_mismatch_cannot_export(old_pg):
    for definition in (replace(old_pg,expected_database='not-the-source'),replace(old_pg,expected_schema_hash='0'*64),replace(old_pg,expected_role='not-the-role')):
        with pytest.raises(SourceMismatch):await PgSnapshot().export(definition,OWNER)
    with pytest.raises(SourceMismatch):await PgSnapshot().export(old_pg,'different-owner')




@pytest.mark.asyncio
async def test_declared_broker_label_and_wrong_fee_snapshot_never_become_official(old_pg):
    snapshot=await PgSnapshot().export(old_pg,OWNER)
    for total,authority in (('999','owner_recorded'),('1','broker_reported')):
        edited=copy.deepcopy(snapshot)
        row=next(r for r in edited['tables']['trade_fee_details']['rows'] if r['order_id']['text']=='old-order-1')
        detail=json.loads(row['detail_json']['text']);detail.update(total=total,source=authority)
        row['detail_json']['text']=json.dumps(detail)
        bundle=Mapping(edited).build()
        assert bundle['financial']['orders'][0]['feeAuthority']=='unverified_legacy'
        assert bundle['financial']['orders'][0]['fees'] is None
        assert bundle['manifest']['orderFacts']['old-order-1']['sourceDeclaredAuthority']==authority


@pytest.mark.asyncio
async def test_missing_owner_is_unknown_not_a_fabricated_complete_empty_book(old_pg):
    missing='allowlisted-but-absent-owner'
    snapshot=await PgSnapshot().export(replace(old_pg,owners=(*old_pg.owners,missing)),missing)
    bundle=Mapping(snapshot).build()
    assert not snapshot['source']['ownerVerified'] and not bundle['manifest']['coverage']['complete']
    assert any(row['code']=='source_owner_identity_not_verified' for row in bundle['manifest']['normalizationBlockers'])


@pytest.mark.asyncio
async def test_original_real_simulated_scope_and_missing_versions_are_not_guessed_from_today_record(old_pg):
    snapshot=await PgSnapshot().export(old_pg,OWNER)
    edited=copy.deepcopy(snapshot);edited['tables']['broker_cash_order_links']['rows']=[]
    bundle=Mapping(edited).build()
    assert bundle['financial']['orders'][0]['originalBrokerAccountId'] is None and bundle['financial']['orders'][0]['accountKind']=='unknown'
    assert any(row['code']=='original_order_real_simulated_identity_unknown' for row in bundle['manifest']['normalizationBlockers'])
    edited=copy.deepcopy(snapshot);edited['tables']['app_asset_order_versions']['rows']=[]
    bundle=Mapping(edited).build()
    assert bundle['fee'] is None and bundle['manifest']['feeInventorySha256'] is None
    assert bundle['financial']['orders'][0]['version']=='unknown'


@pytest.mark.asyncio
async def test_cash_projection_follows_old_cny_branch_and_keeps_original_stored_position_differences(old_pg):
    snapshot=await PgSnapshot().export(old_pg,OWNER)
    # Ordinary CN without explicit settlement_currency uses amount+fees; it does
    # not require a synthetic CNY net field. Keep fee evidence's original identity.
    for table in ('records','trade_orders'):
        for row in snapshot['tables'][table]['rows']:row['market']['text']='CN'
    for row in snapshot['tables']['trade_orders']['rows']:row['settlement_currency']={'storageType':'text','null':True}
    bundle=Mapping(snapshot).build()
    original_buy=next(item for item in bundle['financial']['cash'] if item['orderId']=='old-order-1')
    assert original_buy['currency']=='CNY' and original_buy['amount']=='-101'
    broken=copy.deepcopy(snapshot)
    row=next(r for r in broken['tables']['trade_orders']['rows'] if r['id']['text']=='old-order-1')
    row['position_cost_after']['text']='99'
    bundle=Mapping(broken).build()
    assert any(row['code']=='original_registered_position_projection_differs' for row in bundle['manifest']['normalizationBlockers'])


@pytest.mark.asyncio
async def test_legacy_number_projection_difference_is_reported_not_silently_rewritten(old_pg):
    snapshot=await PgSnapshot().export(old_pg,OWNER)
    row=next(r for r in snapshot['tables']['trade_orders']['rows'] if r['id']['text']=='old-order-1')
    row['amount']['text']='0.2';row['qty']['text']='2';row['price']['text']='0.1';row['fees']['text']='0.1'
    bundle=Mapping(snapshot).build()
    projection=bundle['manifest']['orderFacts']['old-order-1']['cashProjection']
    assert projection['exactStoredDecimalNet']=='-0.3' and projection['legacyNumberRoundTrip']=='-0.30000000000000004'
    assert any(row['code']=='legacy_number_cash_projection_requires_explicit_reconciliation' for row in bundle['manifest']['normalizationBlockers'])
