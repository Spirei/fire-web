"""Full-prefix verification before appending a same-source historical tail."""
from decimal import Decimal,localcontext
from alcor_api.financial_source import decimal


def semantics(value):
    if isinstance(value,dict):return {k:semantics(v) for k,v in value.items() if k not in ('evidenceId','feeEvidenceId')}
    if isinstance(value,list):return [semantics(v) for v in value]
    return value


def same_original(kind,old,new):
    old=semantics(old);new=semantics(new)
    if kind=='cash':
        # The old normalized cash view had a snapshot/projection version, not an immutable event revision.
        # Raw source-prefix equality is checked separately; economic fields and both provenance versions stay retained.
        old={k:v for k,v in old.items() if k!='version'}
        new={k:v for k,v in new.items() if k!='version'}
    if kind=='record':
        old={k:v for k,v in old.items() if k not in ('version','closing')}
        new={k:v for k,v in new.items() if k not in ('version','closing')}
    return old==new


async def existing_prefix(conn,who,data,source,block):
    meta=source['source'];applied={}
    rows=await(await conn.execute('SELECT l.* FROM financial_import_links l WHERE l.owner_id=%s AND l.source_instance=%s AND l.source_owner=%s ORDER BY object_kind,original_id',(who.id,meta['instance'],meta['owner']))).fetchall()
    originals={(kind,item['id']):item for kind,key in (('record','records'),('cash','cash'),('order','orders')) for item in source[key]}
    for row in rows:
        key=(row['object_kind'],row['original_id']);item=originals.get(key)
        if item is None or not same_original(key[0],row['original'],item):
            block('imported_source_prefix_changed_or_missing',row['original_id'],{'kind':row['object_kind']});continue
        lineage=await(await conn.execute('''WITH RECURSIVE chain AS (
          SELECT m.* FROM legacy_source_manifests m WHERE m.owner_id=%s AND m.id=%s
          UNION ALL SELECT m.* FROM legacy_source_manifests m JOIN chain c ON m.owner_id=c.owner_id AND m.manifest_sha256=c.predecessor_hash
        ) SELECT 1 FROM chain WHERE id=%s''',(who.id,data['sourceId'],row['source_id']))).fetchone()
        if not lineage:block('previous_import_is_not_in_current_source_coverage_chain',item['id']);continue
        if key[0]=='record' and data['recordMap'].get(item['id'])!=row['target_id']:
            block('imported_record_mapping_changed',item['id']);continue
        current=(await(await conn.execute('SELECT legacy_mapping_target_snapshot(%s,%s,%s) value',(who.id,key[0],row['target_id']))).fetchone())['value']
        if current is None:block('previous_canonical_target_missing',item['id']);continue
        account=item.get('sourceAccountId')
        if account is not None and current.get('account_id')!=data['accountMap'].get(account):
            block('imported_cash_or_fill_account_mapping_changed',item['id']);continue
        receipt=await(await conn.execute("SELECT 1 FROM financial_import_operations WHERE owner_id=%s AND request_id=%s AND result->>'financialApplied'='true' AND result->>'state'='completed'",(who.id,row['operation_id']))).fetchone()
        if not receipt:block('previous_financial_receipt_missing',item['id']);continue
        if key[0]=='order' and item['status']=='filled':
            pairs=(('quantity','quantity'),('price','price'),('amount','amount'),('fees','fees'),('settlement_amount','settlementAmount'))
            if current['rowType']!='trade' or any(decimal(current[a],negative=True)!=decimal(item[b],negative=True) for a,b in pairs) or current['source']!=item['feeAuthority']:
                block('canonical_fill_no_longer_matches_original',item['id']);continue
            correction=await(await conn.execute('SELECT 1 FROM trade_fee_corrections WHERE owner_id=%s AND trade_id=%s',(who.id,row['target_id']))).fetchone()
            if correction:block('canonical_fee_correction_requires_source_reconciliation',item['id']);continue
        if key[0]=='order' and item['status']!='filled':
            if current.get('rowType')!='intent' or current.get('order_type')!='imported' or current.get('original_status')!=item['status'] or current.get('original_intent')!=item['intent'] or any(decimal(current[a])!=decimal(item[b]) for a,b in (('quantity','quantity'),('price','price'),('fees','fees'))):
                block('canonical_imported_intent_no_longer_matches_original',item['id']);continue
        if key[0]=='cash' and (current['rowType']!='cash' or Decimal(current['amount'])!=decimal(item['amount'],negative=True) or current['currency']!=item['currency'] or current['kind']!=item['kind']):
            block('canonical_cash_no_longer_matches_original',item['id']);continue
        applied[key]=row
    return applied


async def verify_target_prefix(conn,who,data,source,applied,prefix_positions,prefix_cash,targets,block):
    """Existing wealth must equal exactly the verified source prefix, never be overwritten."""
    for rid,current in targets.items():
        expected=prefix_positions[rid]
        if current['qty']!=expected.quantity or current['cost']!=expected.cost:block('target_position_does_not_match_verified_prefix',rid)
        known={row['target_id'] for key,row in applied.items() if key[0]=='order' and row['original']['status']=='filled' and row['original']['recordId']==rid}
        actual=await(await conn.execute('SELECT id FROM trade_ledger WHERE owner_id=%s AND record_id=%s',(who.id,current['id']))).fetchall()
        if {str(r['id']) for r in actual}!=known:block('target_record_has_unrelated_or_missing_financial_history',rid)
        if known:
            tips=await(await conn.execute('SELECT id FROM trade_ledger WHERE owner_id=%s AND record_id=%s AND NOT EXISTS(SELECT 1 FROM trade_ledger next WHERE next.owner_id=%s AND next.previous_trade_id=trade_ledger.id)',(who.id,current['id'],who.id))).fetchall()
            if len(tips)!=1 or tips[0]['id']!=current['trade_tip_id']:block('target_trade_tip_does_not_match_verified_prefix',rid)
    for (kind,currency),expected in prefix_cash.items():
        actual=await(await conn.execute('SELECT id,account_id,amount,affects_owner FROM cash_ledger_entries WHERE owner_id=%s AND account_kind=%s AND currency=%s',(who.id,kind,currency))).fetchall()
        known={row['target_id'] for key,row in applied.items() if key[0]=='cash' and row['original']['accountKind']==kind and row['original']['currency']==currency}
        if {str(r['id']) for r in actual}!=known:block('target_cash_scope_has_unrelated_or_missing_financial_history',detail={'accountKind':kind,'currency':currency})
        with localcontext() as context:
            context.prec=80
            total=sum((r['amount'] for r in actual if r['affects_owner']),Decimal(0));balances={}
            for r in actual:
                if r['account_id'] is not None:balances[r['account_id']]=balances.get(r['account_id'],Decimal(0))+r['amount']
            wanted={data['accountMap'][key]:value for key,value in expected['accounts'].items()}
            if total!=expected['owner'] or balances!=wanted:block('target_cash_does_not_match_verified_prefix',detail={'accountKind':kind,'currency':currency})
