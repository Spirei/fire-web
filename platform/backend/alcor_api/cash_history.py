"""Bounded original-currency posted entries; never a reconstructed account book."""
from fastapi import HTTPException
from .broker_accounts import broker_account,serialize_brokers
from .security import lock_mutation_identity


async def entries(db,who,account_id,*,currency=None,limit=25,offset=0,revision=None):
    async with db.connection() as conn,conn.transaction():
        await serialize_brokers(conn,who.id)
        await lock_mutation_identity(conn,who,require_admin=False)
        account=await broker_account(conn,who.id,account_id)
        if currency is not None and currency not in account['currencies']:raise HTTPException(422,'币种不属于本账户')
        head=await(await conn.execute('SELECT revision FROM cash_ledger_collections WHERE owner_id=%s',(who.id,))).fetchone()
        current=head['revision'] if head else 0
        if offset and revision is None or revision is not None and revision!=current:raise HTTPException(409,'现金流水版本已变化，请重新读取第一页')
        args=(who.id,account_id,currency,currency)
        total=(await(await conn.execute('SELECT count(*) total FROM cash_ledger_entries WHERE owner_id=%s AND account_id=%s AND (%s::text IS NULL OR currency=%s)',args)).fetchone())['total']
        rows=await(await conn.execute("SELECT e.*,(SELECT jsonb_build_object('kind','cash','requestId',o.request_id::text) FROM cash_ledger_operations o WHERE o.owner_id=e.owner_id AND o.request_id=e.request_id LIMIT 1) cash_receipt,(SELECT jsonb_build_object('kind','trade','requestId',o.request_id::text) FROM trade_operations o WHERE o.owner_id=e.owner_id AND o.request_id=e.request_id LIMIT 1) trade_receipt,(SELECT jsonb_build_object('kind','financial_import','requestId',l.operation_id::text) FROM financial_import_links l WHERE l.owner_id=e.owner_id AND l.object_kind='cash' AND l.target_id=e.id::text LIMIT 1) import_receipt,coalesce(d.detail->>'source',t.source) fee_source,t.fees original_fees,(EXISTS(SELECT 1 FROM actual_fee_confirmations a JOIN trade_fee_corrections c ON c.owner_id=a.owner_id AND c.trade_id=a.trade_id AND c.request_id=a.request_id AND c.new_fees=a.actual_fee WHERE a.owner_id=t.owner_id AND a.trade_id=t.id) OR EXISTS(SELECT 1 FROM native_actual_fee_confirmations a JOIN trade_fee_corrections c ON c.owner_id=a.owner_id AND c.trade_id=a.trade_id AND c.request_id=a.request_id AND c.old_fees=a.registered_fee AND c.new_fees=a.actual_fee WHERE a.owner_id=t.owner_id AND a.trade_id=t.id)) actual_confirmed FROM cash_ledger_entries e LEFT JOIN trade_ledger t ON t.owner_id=e.owner_id AND t.id=e.source_trade_id LEFT JOIN trade_fee_details d ON d.owner_id=t.owner_id AND d.trade_id=t.id WHERE e.owner_id=%s AND e.account_id=%s AND (%s::text IS NULL OR e.currency=%s) ORDER BY e.occurred_at DESC,e.created_at DESC,e.id DESC LIMIT %s OFFSET %s",(*args,limit,offset))).fetchall()
        items=[{'receipt':row['cash_receipt'] or row['trade_receipt'] or row['import_receipt'],'id':str(row['id']),'requestId':str(row['request_id']),'kind':row['kind'],'currency':row['currency'],'registeredAmount':str(row['amount']),'occurredAt':row['occurred_at'].isoformat(),'createdAt':row['created_at'].isoformat(),'note':row['note'],'affectsOwnerCash':row['affects_owner'],'sourceTradeId':str(row['source_trade_id']) if row['source_trade_id'] else None,'feeAuthority':'owner_recorded' if row['actual_confirmed'] else row['fee_source'],'actualFeeKnown':bool(row['actual_confirmed'] or row['fee_source'] in ('owner_recorded','broker_reported')) if row['source_trade_id'] else None} for row in rows]
        return {'accountId':account_id,'accountKind':account['account_kind'],'coverageScope':'platform_registered_entries_only','revision':current,'total':total,'nextOffset':offset+len(items) if offset+len(items)<total else None,'items':items}
