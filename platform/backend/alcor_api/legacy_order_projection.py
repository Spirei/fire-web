"""Restore the sealed old internal-book read model, without replaying executions.

The old top-level atomic model also contained legacy_internal_orders. It did not
claim broker executions or verified cash. Unknown/unsealed imports keep their
existing registered-history representation instead of being silently promoted.
"""

import json
import re
from decimal import Decimal
from zoneinfo import ZoneInfo

from fastapi import HTTPException

from .database_migration_capture import canonical, sha
from .portfolio_records import symbol

READ_MODEL = 'sealed_legacy_internal_book_v1'
REQUIRED_TABLES = (
    'records', 'trade_orders', 'app_asset_order_versions', 'app_trade_metadata',
    'broker_cash_order_links', 'trade_fee_evidence', 'trade_fee_corrections',
    'trade_fee_details', 'trade_correction_originals', 'trade_correction_replacements',
)
REQUIRED_COLUMNS = {
    'records': ('id', 'user_id', 'market', 'code'),
    'trade_orders': ('id', 'user_id', 'record_id', 'market', 'code', 'status', 'qty', 'price'),
    'app_asset_order_versions': ('order_id', 'revision'),
    'app_trade_metadata': ('order_id', 'parent_id', 'role', 'draft_json'),
    'broker_cash_order_links': ('order_id', 'user_id', 'account_id'),
    'trade_fee_evidence': ('order_id', 'user_id', 'source', 'detail_json'),
    'trade_fee_corrections': ('order_id', 'user_id', 'source', 'detail_json'),
    'trade_fee_details': ('order_id', 'user_id', 'detail_json'),
    'trade_correction_originals': ('order_id', 'user_id'),
    'trade_correction_replacements': ('order_id', 'user_id'),
}


def object_value(value):
    try:
        result = json.loads(value) if isinstance(value, str) else value
        return result if isinstance(result, dict) else {}
    except (ValueError, TypeError):
        return {}


def unique_rows(rows, key):
    result = {row[key]: row for row in rows}
    if len(result) != len(rows) or any(not value for value in result):
        raise ValueError('duplicate_or_missing_original_identity')
    return result


def native_fields(stored, current_records):
    """Return verified original read fields or None; never manufacture evidence."""
    from .database_migration_history import cells

    try:
        packet = stored['originals']
        raw = packet['raw_snapshot']
        source = raw['source']
        if (packet['format'] != 'registered-history/1' or raw['format'] != 'legacy-storage-snapshot/1'
                or sha(canonical(packet)) != stored['source_sha256']
                or packet['source_instance'] != stored['source_instance']
                or packet['source_owner'] != stored['source_owner']
                or source['instance'] != packet['source_instance'] or source['owner'] != packet['source_owner']
                or source['ownerVerified'] is not True or source['datasetIdentityVerified'] is not True
                or source['timezone'] != packet['timezone']
                or any(raw['tables'][table]['present'] is not True for table in REQUIRED_TABLES)):
            return None
        ZoneInfo(packet['timezone'])
        if any(not set(columns) <= {column['name'] for column in raw['tables'][name]['columns']}
               for name, columns in REQUIRED_COLUMNS.items()):
            return None
        orders = unique_rows(cells(raw, 'trade_orders'), 'id')
        if unique_rows(packet['orders'], 'id') != orders or set(packet['normalized_orders']) != set(orders):
            return None
        records = unique_rows(cells(raw, 'records'), 'id')
        versions = unique_rows(cells(raw, 'app_asset_order_versions'), 'order_id')
        metadata = unique_rows(cells(raw, 'app_trade_metadata'), 'order_id')
        links = unique_rows(cells(raw, 'broker_cash_order_links'), 'order_id')
        evidence = unique_rows(cells(raw, 'trade_fee_evidence'), 'order_id')
        repairs = unique_rows(cells(raw, 'trade_fee_corrections'), 'order_id')
        details = unique_rows(cells(raw, 'trade_fee_details'), 'order_id')
        # Nonempty correction chains require their own original replacement
        # projection. Do not turn those into fresh whole fills here.
        if cells(raw, 'trade_correction_originals') or cells(raw, 'trade_correction_replacements'):
            return None
        if any(set(values) - set(orders) for values in (versions, metadata, links, evidence, repairs, details)):
            return None
        if any(row['user_id'] != packet['source_owner'] for values in (links, evidence, repairs, details) for row in values.values()):
            return None
        current = {row['id']: row for row in current_records}
        result = {}
        for oid, order in orders.items():
            normalized = packet['normalized_orders'][oid]
            version = versions[oid]['revision']
            if (not isinstance(version, str) or not version.isdigit() or not 1 <= int(version) <= 2**63-1
                    or normalized['version'] != version or normalized['sourceOwner'] != packet['source_owner']
                    or order['user_id'] != packet['source_owner']
                    or records[order['record_id']]['user_id'] != packet['source_owner']
                    or normalized['recordId'] != order['record_id']
                    or normalized['status'] != order['status']
                    or normalized['fillAuthority'] != ('owner_recorded_history' if order['status'] == 'filled' else 'not_filled')):
                return None
            rid = packet['maps']['records'][order['record_id']]
            record = current.get(rid)
            if not isinstance(order['code'], str) or not isinstance(order['market'], str):
                return None
            code = symbol(order['code'], order['market'])
            matches = bool(record and record['market'] == order['market'] and symbol(record['code'], record['market']) == code)
            meta = metadata.get(oid, {})
            draft = object_value(meta.get('draft_json'))
            # These are the old LEFT JOIN priorities. A current association or
            # migration attribution is not proof of historical cash attribution.
            repair = repairs.get(oid, {})
            detail = object_value(repair.get('detail_json'))
            proof = evidence.get(oid, {})
            fee_proof = object_value(proof.get('detail_json'))
            saved = object_value(details.get(oid, {}).get('detail_json'))
            candidates = (
                (links.get(oid, {}).get('account_id'), 'cash_attribution_at_creation'),
                (detail.get('brokerAccountId') if repair.get('source') == 'owner_reconstructed' else None, 'fee_repair_owner_confirmation'),
                (fee_proof.get('brokerAccountId') if proof.get('source') == 'explicit_order_entry' else None, 'recorded_order_entry'),
                (draft.get('brokerTargetId'), 'submission_target'),
            )
            historical, historical_source = None, 'unavailable'
            for original, attribution in candidates:
                if isinstance(original, str) and re.fullmatch(r'ba-[a-f0-9]{24}', original):
                    historical = packet['maps']['accounts'].get(original)
                    if historical:
                        historical_source = attribution
                        break
            if historical_source not in ('cash_attribution_at_creation', 'fee_repair_owner_confirmation'):
                original = saved.get('brokerAccountId')
                if (saved.get('source') in ('owner_recorded', 'rule_calculated')
                        and Decimal(str(saved.get('total'))) == Decimal(order['fees'])
                        and isinstance(original, str) and re.fullmatch(r'ba-[a-f0-9]{24}', original)
                        and original in packet['maps']['accounts']):
                    historical, historical_source = packet['maps']['accounts'][original], 'recorded_fee_snapshot'
            status = order['status']
            quantity = Decimal(order['qty']) if order.get('qty') is not None else None
            price = Decimal(order['price']) if order.get('price') is not None else None
            if any(value is not None and not value.is_finite() for value in (quantity, price)):
                return None
            result[oid] = {
                'originalReadModel': READ_MODEL, 'originalCode': order['code'], 'code': code,
                'revision': int(version), 'recordRevision': record['revision'] if record else None,
                'identityMatches': matches, 'currentRecordBrokerAccountId': record['broker_account_id'] if matches else None,
                'brokerAccountId': historical, 'brokerAccountIdSource': historical_source,
                'originalExecutionModel': ('owner_recorded_fill' if draft.get('mode') == 'record' else 'explicit_quote_observation') if meta.get('role') else 'legacy_internal_orders',
                'parentOrderId': meta.get('parent_id'), 'attachmentRole': meta.get('role'),
                'filledQty': (quantity if status == 'filled' else Decimal(0)) if quantity is not None and status in ('filled', 'pending', 'cancelled', 'expired') else None,
                'filledQtySource': 'atomic_order_status' if quantity is not None and status in ('filled', 'pending', 'cancelled', 'expired') else 'unavailable',
                'executedPrice': price if status == 'filled' else None,
                'orderPrice': None if status == 'filled' else price,
                'continuousExecution': False,
            }
        return result
    except (KeyError, ValueError, TypeError, ArithmeticError, HTTPException):
        return None
