"""Old owner-recorded currency book; never broker buying power or a cash posting."""

import asyncio
import json
import math
import threading
from collections import OrderedDict
from copy import deepcopy
from dataclasses import dataclass
from decimal import Decimal, localcontext

from fastapi import HTTPException

from .backups import BackupFailure, private_read
from .card_preferences import card_key, restore_json
from .database_migration_capture import CaptureBudget, canonical, sha
from .database_migration_history import cells
from .database_migration_retry import attempt_path
from .database_migration_transform import FrozenTables

# Frozen funds contract, distinct from broker metadata's additional currencies.
CURRENCIES = ('USD','HKD','CNY','SGD','JPY','KRW','EUR','TWD','MOP','GBP','AUD','CAD','INR','BRL')
REGION_CURRENCY = {'中国内地':'CNY','中国香港':'HKD','中国台湾':'TWD','中国澳门':'MOP','美国':'USD',
    '日本':'JPY','韩国':'KRW','新加坡':'SGD','英国':'GBP','德国':'EUR','爱尔兰':'EUR','澳大利亚':'AUD','加拿大':'CAD'}
SUMMARY_FIELDS = ('openingAsset','cashNetFlow','stockNetFlow','otherNetFlow')
_files = threading.BoundedSemaphore(2)
# Imported sealed originals are insert-only; re-parsing their JSON and
# re-validating the sealed book on every funds read made cash values appear
# seconds late. Key by the sealed fingerprints (a new import changes the key).
# The archive manifest and the current card/cash evidence are still read and
# verified on every request.
_cache_limit = 64
_books = OrderedDict()


def _cache_key(owner, original):
    archive = original.get('archive') or {}
    return (owner, original['source_owner'], original['source_instance'], original['source_sha256'],
            archive.get('archive_task'), archive.get('archive_attempt'))


def _cached_ordered(cache, key, value=None):
    if value is not None:
        cache[key] = value
        cache.move_to_end(key)
        while len(cache) > _cache_limit:
            cache.popitem(last=False)
        return value
    cached = cache.get(key)
    if cached is not None:
        cache.move_to_end(key)
    return cached


@dataclass(frozen=True)
class RegisteredCash:
    dto: dict
    exact_balances: dict


def number(value, *, signed=True):
    if value is None or isinstance(value, bool):
        raise ValueError('unknown_registered_amount')
    result = Decimal(str(value))
    if not result.is_finite() or abs(result) > Decimal('1e30') or not signed and result < 0:
        raise ValueError('invalid_registered_amount')
    return result


def book_from_original(stored):
    """Validate the actual owner/dataset/cells before deriving the old read model."""
    packet = stored['originals']; raw = packet['raw_snapshot']; source = raw['source']
    if (packet['format'] != 'registered-history/1' or raw['format'] != 'legacy-storage-snapshot/1'
        or sha(canonical(packet)) != stored['source_sha256']
        or packet['source_owner'] != stored['source_owner'] or packet['source_instance'] != stored['source_instance']
        or source['owner'] != packet['source_owner'] or source['instance'] != packet['source_instance']
        or source['ownerVerified'] is not True or source['datasetIdentityVerified'] is not True):
        raise ValueError('unproved_registered_book')
    for table, fields in (
        ('trade_orders', ('id','user_id','status','market','side','amount','qty','price','fees','settlement_currency','settlement_amount')),
        ('fund_transactions', ('id','user_id','currency','type','amount','direction')),
    ):
        captured = raw['tables'][table]
        if captured['present'] is not True or not set(fields) <= {c['name'] for c in captured['columns']}:
            raise ValueError('incomplete_registered_book')
        rows = cells(raw, table)
        ids = [r['id'] for r in rows]
        if (len(ids) != len(set(ids)) or any(not i for i in ids)
            or any(r['user_id'] != packet['source_owner'] for r in rows)
            or rows != packet['orders' if table == 'trade_orders' else 'funds']):
            raise ValueError('registered_original_mismatch')
    balances = {c:Decimal(0) for c in CURRENCIES}
    summaries = {c:{k:Decimal(0) for k in SUMMARY_FIELDS} for c in CURRENCIES}
    kinds = set()
    def add(currency, value, field):
        if currency not in balances:
            raise ValueError('unsupported_registered_currency')
        balances[currency] += value; summaries[currency][field] += value
    with localcontext() as precision:
        precision.prec = 80
        for row in packet['funds']:
            # Automatic copies are displayed in fund history but never counted twice.
            if row['id'].startswith('fund-order-'):
                continue
            if row['direction'] not in ('1','-1'):
                raise ValueError('invalid_registered_direction')
            value = number(row['amount'], signed=False) * Decimal(row['direction'])
            field = 'openingAsset' if row['type']=='opening' else 'cashNetFlow' if row['type'] in ('deposit','withdrawal') else 'otherNetFlow'
            add(row['currency'], value, field)
        for row in packet['orders']:
            if row['status'] != 'filled':
                continue
            normalized = packet['normalized_orders'][row['id']]
            if (normalized['sourceOwner'] != packet['source_owner'] or normalized['status'] != 'filled'
                or normalized['fillAuthority'] != 'owner_recorded_history' or row['side'] not in ('buy','sell','dividend')):
                raise ValueError('unproved_registered_fill')
            kinds.add(normalized['accountKind'])
            if row['settlement_currency'] == 'CNY':
                value = number(row['settlement_amount'], signed=False)
                if value <= 0:
                    raise ValueError('unknown_registered_net_settlement')
                currency = 'CNY'
            else:
                gross = number(row['amount'], signed=False) if row['amount'] is not None else None
                if gross is None or gross == 0:
                    gross = number(row['qty'], signed=False) * number(row['price'], signed=False)
                fees = number(row['fees'], signed=False)
                value = gross+fees if row['side']=='buy' else gross-fees
                currency = normalized['currency']
            add(currency, -value if row['side']=='buy' else value, 'stockNetFlow')
    if len(kinds) != 1 or not kinds <= {'real','simulated'}:
        raise ValueError('registered_account_kinds_not_separated')
    return {'balances':balances, 'summaries':summaries, 'accountKind':next(iter(kinds))}


def empty_source_cards(settings, stored, archive):
    with _files:
        return _empty_source_cards(settings, stored, archive)


def _empty_source_cards(settings, stored, archive):
    """Only a captured and hashed empty table proves no original recorded card cash."""
    packet = stored['originals']; source = packet['raw_snapshot']['source']
    root = attempt_path(settings, archive['archive_task'], archive['archive_attempt'])/'source'
    raw = private_read(root/'manifest.json', 16*1024**2)
    manifest = json.loads(raw); identity = manifest['identity']
    if (sha(raw) != packet['source_manifest_sha256']
        or sha(canonical({k:identity[k] for k in ('system_identifier','oid','database')})) != packet['source_instance']
        or manifest['snapshot'] != source['snapshotToken'] or manifest['schema_sha256'] != source['schemaHash']):
        raise ValueError('registered_card_archive_mismatch')
    tables = FrozenTables(root, manifest, threading.Event(), CaptureBudget(16*1024**2,0,20))
    schema = manifest['selected_schema']
    for name, required in (
        ('card_amounts', {'user_id','card_key','amount','currency'}),
        ('card_details', {'user_id','card_key','currency'}),
        ('card_balance_history', {'user_id','card_key','balance'}),
    ):
        entry = tables.inventory.get((schema,name))
        if entry is None or entry['rows'] != 0 or not required <= set(tables.columns.get((schema,name),{})):
            return False  # Unimported nonempty families require their original mapping.
        if tables.rows(schema,name):
            raise ValueError('registered_empty_table_mismatch')
    return True


def classification_key(value):
    try:
        return card_key(value)
    except HTTPException:
        raise ValueError('invalid_cash_card_identity') from None


async def card_totals(conn, owner, account_kind):
    """Read only amounts and public card classification; no card numbers or secrets."""
    amounts = await (await conn.execute('''SELECT a.amount,a.currency,a.card_key,a.account_kind,d.metadata AS details
        FROM card_wallet_accounts a JOIN card_preference_holdings h ON h.owner_id=a.owner_id AND h.card_key=a.card_key AND h.held
        LEFT JOIN card_wallet_details d ON d.owner_id=a.owner_id AND d.card_key=a.card_key
        WHERE a.owner_id=%s ORDER BY a.card_key LIMIT 10001''', (owner,))).fetchall()
    if len(amounts)>10000:
        raise ValueError('card_cash_read_budget')
    result = {c:Decimal(0) for c in CURRENCIES}
    if not amounts:
        return result
    source = await (await conn.execute('''SELECT s.manifest FROM card_catalog_scope c
        JOIN card_catalog_sources s ON s.id=c.current_source WHERE c.singleton''')).fetchone()
    metadata = {}
    for region in restore_json(source['manifest']).get('regions',[]) if source else []:
        for bank in region.get('banks',[]):
            for card in bank.get('cards',[]):
                if isinstance(card.get('file'),str):
                    metadata[classification_key(card['file'])] = {'type':card.get('type'), 'region':region.get('label')}
    custom = await (await conn.execute('SELECT image_path,metadata FROM card_custom_records WHERE owner_id=%s AND deleted_at IS NULL', (owner,))).fetchall()
    for row in custom:
        metadata.setdefault(classification_key(row['image_path']), restore_json(row['metadata']))
    for row in amounts:
        info = metadata.get(row['card_key'])
        if not info:
            if number(row['amount']) != 0:raise ValueError('unknown_cash_card_identity')
            continue
        if info.get('type') not in ('借记卡','预付卡'):
            continue
        value = number(row['amount'])
        if value == 0:
            continue
        if row['account_kind'] is not None and row['account_kind'] != account_kind:
            raise ValueError('card_account_kind_mismatch')
        detail = restore_json(row['details']) if row['details'] else {}
        currency = (row['currency'] or detail.get('currency') or REGION_CURRENCY.get(info.get('region')) or '').upper()
        if currency not in result:raise ValueError('unknown_cash_card_currency')
        result[currency] += value
    return result


async def read_registered_cash(conn, who, settings, overview):
    """Compatibility display only. Existing CashLedger remains trading authority."""
    with localcontext() as precision:
        precision.prec = 80
        return await _read_registered_cash(conn, who, settings, overview)


async def _read_registered_cash(conn, who, settings, overview):
    stored = await (await conn.execute('''SELECT h.originals,h.source_sha256,h.source_instance,h.source_owner,
        t.payload->'_archive' AS archive FROM database_migration_history_imports h
        JOIN tasks t ON t.id=h.task_id AND t.owner_id=h.owner_id
        WHERE h.owner_id=%s ORDER BY h.created_at LIMIT 2''', (who.id,))).fetchall()
    if len(stored) != 1:
        return None
    try:
        original = stored[0]
        key = _cache_key(who.id, original)
        cached_book = _cached_ordered(_books, key)
        if cached_book is None:
            cached_book = _cached_ordered(_books, key, book_from_original(original))
        # The cached book is shared by concurrent readers and is mutated below.
        book = deepcopy(cached_book)
        duplicate = await (await conn.execute('''SELECT 1 FROM financial_import_links WHERE owner_id=%s
            AND source_instance=%s AND source_owner=%s AND object_kind IN ('cash','order') LIMIT 1''',
            (who.id,original['source_instance'],original['source_owner']))).fetchone()
        if duplicate:
            return None
        work = asyncio.create_task(asyncio.to_thread(empty_source_cards, settings, original, original['archive']))
        try:
            empty = await asyncio.shield(work)
        except asyncio.CancelledError:
            await asyncio.shield(work)
            raise
        if not empty:
            return None
        native = await (await conn.execute('''SELECT currency,account_kind,kind,sum(amount) AS amount
            FROM cash_ledger_entries WHERE owner_id=%s AND affects_owner
            GROUP BY currency,account_kind,kind ORDER BY currency,account_kind,kind''', (who.id,))).fetchall()
        if any(r['account_kind'] != book['accountKind'] for r in native):
            return None
        opened = {r['currency'] for r in native if r['kind']=='opening'}
        balances, summaries = book['balances'], book['summaries']
        canonical_balances = {r['currency']:r for b in overview['books'] if b['accountKind']==book['accountKind'] for r in b['currencies']}
        for currency in opened:
            if currency not in balances:raise ValueError('unsupported_registered_currency')
            observed = canonical_balances.get(currency)
            if not observed or not observed['complete'] or observed['ownerBalance'] is None:
                return None
            balances[currency] = number(observed['ownerBalance'])
            summaries[currency] = {k:Decimal(0) for k in SUMMARY_FIELDS}
        for row in native:
            currency = row['currency']
            if currency not in balances:raise ValueError('unsupported_registered_currency')
            field = 'openingAsset' if row['kind']=='opening' else 'cashNetFlow' if row['kind'] in ('external_deposit','external_withdrawal') else 'stockNetFlow' if row['kind'].startswith(('trade_','fee_')) else 'otherNetFlow'
            value = number(row['amount'])
            if currency not in opened:balances[currency] += value
            summaries[currency][field] += value
        cards = await card_totals(conn, who.id, book['accountKind'])
        for currency, value in cards.items():
            balances[currency] += value; summaries[currency]['otherNetFlow'] += value
        from .simple_ledger import SimpleLedger
        ledger = await SimpleLedger(None).current(conn, who.id)
        investments = ledger['ledger'].get('invest')
        if not isinstance(investments,list):raise ValueError('invalid_imported_equity_source')
        for item in investments:
            if not isinstance(item,dict):raise ValueError('invalid_imported_equity_source')
            if item.get('market') and (isinstance(item.get('amount'),bool) or not isinstance(item.get('amount'),(int,Decimal))):
                raise ValueError('invalid_imported_equity_source')
            if item.get('market'):number(item['amount'])
        from .broker_metadata import fingerprint
        values = {'balances':{c:float(v) for c,v in balances.items()},'cardCash':{c:float(v) for c,v in cards.items()},
            'summaries':{c:{k:float(v) for k,v in s.items()} for c,s in summaries.items()}}
        if any(not math.isfinite(v) for v in (*values['balances'].values(),*values['cardCash'].values())):
            raise ValueError('invalid_registered_total')
        wallet_head = await (await conn.execute('SELECT revision FROM card_wallet_collections WHERE owner_id=%s', (who.id,))).fetchone()
        dto = {**values, 'snapshotRevision':fingerprint([original['source_sha256'],overview['snapshotRevision'],ledger['revision'],wallet_head,values]),
            'sourceComplete':True, 'cardCashCoverageKnown':True,'historicalCoverageKnown':False,
            'coverageScope':'independent_recorded_currency_ledger','sourceAuthority':'sealed_legacy_registered_book_with_platform_postings',
            'accountKind':book['accountKind'],'unboundLegacyGlobalCashIncluded':True,'accountKindsCombined':False,
            'sourceOrdersReplayed':False,'actualBrokerBalanceClaimed':False}
        return RegisteredCash(dto, balances)
    except (ValueError,KeyError,TypeError,ArithmeticError,OSError,BackupFailure):
        return None
