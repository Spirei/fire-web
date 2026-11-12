"""Sealed old-book reads preserve identity, historical attribution and unknowns."""

import copy
import json
from decimal import Decimal

import pytest
from alcor_api.database_migration_capture import canonical, sha
from alcor_api.legacy_order_projection import READ_MODEL, REQUIRED_COLUMNS, REQUIRED_TABLES, native_fields


def table(rows):
    return {'present': True, 'rows': [
        {key: {'null': value is None, 'text': None if value is None else str(value)} for key, value in row.items()}
        for row in rows
    ]}


def sealed():
    source_account = 'ba-' + '1' * 24
    order = {'id': 'original', 'user_id': 'source-owner', 'record_id': 'source-record',
             'market': 'HK', 'code': '2580', 'status': 'filled', 'side': 'buy',
             'qty': '2.000000000000000001', 'price': '3.000000000000000001', 'fees': '0'}
    tables = {name: table([]) for name in REQUIRED_TABLES}
    tables.update(trade_orders=table([order]),
                  records=table([{'id': 'source-record', 'user_id': 'source-owner'}]),
                  app_asset_order_versions=table([{'order_id': 'original', 'revision': 17}]))
    for name, columns in REQUIRED_COLUMNS.items():
        tables[name]['columns']=[{'name': name} for name in columns]
    packet = {'format': 'registered-history/1', 'source_instance': 'sealed-source', 'source_owner': 'source-owner',
              'timezone': 'Asia/Shanghai',
              'orders': [order], 'maps': {'records': {'source-record': 'target-record'}, 'accounts': {source_account: 'target-historical-account'}},
              'normalized_orders': {'original': {'version': '17', 'sourceOwner': 'source-owner',
                  'recordId': 'source-record', 'status': 'filled', 'fillAuthority': 'owner_recorded_history'}},
              'raw_snapshot': {'format': 'legacy-storage-snapshot/1', 'source': {
                  'owner': 'source-owner', 'instance': 'sealed-source', 'ownerVerified': True, 'datasetIdentityVerified': True, 'timezone': 'Asia/Shanghai'}, 'tables': tables}}
    stored = {'originals': packet, 'source_sha256': sha(canonical(packet)),
              'source_instance': 'sealed-source', 'source_owner': 'source-owner'}
    records = [{'id': 'target-record', 'market': 'HK', 'code': '02580', 'revision': 29,
                'broker_account_id': 'current-account'}]
    return stored, records, source_account


def reseal(stored):
    for name, columns in REQUIRED_COLUMNS.items():
        stored['originals']['raw_snapshot']['tables'][name].setdefault('columns',[{'name': name} for name in columns])
    stored['source_sha256'] = sha(canonical(stored['originals']))


def test_original_whole_fill_and_hk_padding_use_current_identity_without_rewriting_originals():
    stored, records, _ = sealed()
    before = copy.deepcopy(stored)
    row = native_fields(stored, records)['original']
    assert row['originalReadModel'] == READ_MODEL
    assert row['originalCode'] == '2580' and row['code'] == '02580'
    assert row['identityMatches'] is True and row['recordRevision'] == 29 and row['revision'] == 17
    assert row['filledQty'] == Decimal('2.000000000000000001')
    assert row['executedPrice'] == Decimal('3.000000000000000001') and row['orderPrice'] is None
    assert row['originalExecutionModel'] == 'legacy_internal_orders'
    assert row['brokerAccountId'] is None and row['brokerAccountIdSource'] == 'unavailable'
    assert row['currentRecordBrokerAccountId'] == 'current-account'
    assert row['continuousExecution'] is False and stored == before


@pytest.mark.parametrize('mode,expected', [('record', 'owner_recorded_fill'), ('order', 'explicit_quote_observation')])
def test_recorded_metadata_restores_classification_without_leaking_execution_grants(mode, expected):
    stored, records, account = sealed()
    packet = stored['originals']
    packet['raw_snapshot']['tables']['app_trade_metadata'] = table([{
        'order_id': 'original', 'role': 'parent', 'draft_json': json.dumps({
            'mode': mode, 'brokerTargetId': account, 'executionGrant': 'synthetic-must-not-leave-server'})}])
    reseal(stored)
    row = native_fields(stored, records)['original']
    assert row['originalExecutionModel'] == expected
    assert row['brokerAccountId'] == 'target-historical-account'
    assert row['currentRecordBrokerAccountId'] == 'current-account'
    assert row['brokerAccountIdSource'] == 'submission_target'
    assert 'executionGrant' not in str(row) and 'synthetic-must-not-leave-server' not in str(row)


def test_true_current_security_change_is_false_and_missing_record_does_not_get_a_revision():
    stored, records, _ = sealed()
    records[0]['code'] = '09999'
    row = native_fields(stored, records)['original']
    assert row['identityMatches'] is False and row['currentRecordBrokerAccountId'] is None
    row = native_fields(stored, [])['original']
    assert row['identityMatches'] is False and row['recordRevision'] is None


@pytest.mark.parametrize('broken', ['digest', 'owner', 'dataset', 'version_missing', 'version_duplicate',
                                  'version_unknown', 'metadata_missing', 'columns_missing', 'timezone', 'original_changed', 'unmatched_fill_authority', 'correction'])
def test_unproven_history_keeps_its_existing_representation_instead_of_being_promoted(broken):
    stored, records, _ = sealed()
    packet = stored['originals']; tables = packet['raw_snapshot']['tables']
    if broken == 'digest':
        stored['source_sha256'] = '0' * 64
    elif broken == 'owner':
        packet['raw_snapshot']['source']['owner'] = 'another-owner'
    elif broken == 'dataset':
        packet['raw_snapshot']['source']['datasetIdentityVerified'] = False
    elif broken == 'version_missing':
        tables['app_asset_order_versions'] = table([])
    elif broken == 'version_duplicate':
        tables['app_asset_order_versions']['rows'] *= 2
    elif broken == 'version_unknown':
        tables['app_asset_order_versions'] = table([{'order_id': 'original', 'revision': None}])
    elif broken == 'metadata_missing':
        tables['app_trade_metadata']['present'] = False
    elif broken == 'columns_missing':
        tables['app_trade_metadata']['columns'] = []
    elif broken == 'timezone':
        packet['timezone'] = 'Invalid/Timezone'
    elif broken == 'original_changed':
        packet['orders'][0]['price'] = '99'
    elif broken == 'unmatched_fill_authority':
        packet['normalized_orders']['original']['fillAuthority'] = 'arbitrary_import'
    else:
        tables['trade_correction_originals'] = table([{'order_id': 'original'}])
    if broken != 'digest':
        reseal(stored)
    assert native_fields(stored, records) is None
