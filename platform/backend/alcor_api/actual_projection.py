"""Keep original registered amounts available without labelling them actual."""
from fastapi import HTTPException

from alcor_api.portfolio_records import record_dto

# t is always a server-selected trade_ledger alias. Fee authority is separate
# from fill authority; owner_recorded fills can still contain a pure estimate.
PENDING_FEE_SQL="""((t.source IN ('legacy_import_zero','unverified_legacy'))
 OR EXISTS(SELECT 1 FROM trade_fee_details fd WHERE fd.owner_id=t.owner_id AND fd.trade_id=t.id AND fd.detail->>'source'='rule_calculated'))
 AND NOT EXISTS(SELECT 1 FROM actual_fee_confirmations a JOIN trade_fee_corrections c ON c.owner_id=a.owner_id AND c.trade_id=a.trade_id AND c.request_id=a.request_id AND c.new_fees=a.actual_fee WHERE a.owner_id=t.owner_id AND a.trade_id=t.id)
 AND NOT EXISTS(SELECT 1 FROM native_actual_fee_confirmations a JOIN trade_fee_corrections c ON c.owner_id=a.owner_id AND c.trade_id=a.trade_id AND c.request_id=a.request_id AND c.old_fees=a.registered_fee AND c.new_fees=a.actual_fee WHERE a.owner_id=t.owner_id AND a.trade_id=t.id)"""


async def pending_fee_rows(conn,owner):
    return await(await conn.execute("SELECT t.id,EXISTS(SELECT 1 FROM trade_fee_details d WHERE d.owner_id=t.owner_id AND d.trade_id=t.id AND d.detail->>'source'='rule_calculated') calculated FROM trade_ledger t WHERE t.owner_id=%s AND "+PENDING_FEE_SQL+' ORDER BY t.id LIMIT 10001',(owner,))).fetchall()


async def first_unknown_revision(conn,owner,record):
    row=await(await conn.execute('SELECT min(t.before_record_revision) revision FROM trade_ledger t WHERE t.owner_id=%s AND t.record_id=%s AND '+PENDING_FEE_SQL,(owner,record))).fetchone()
    return row['revision']


async def actual_record_dto(conn,owner,row):
    result=record_dto(row)
    if row.get('position_transfer_id') is not None:
        from .position_transfer_checkpoint import verify_current
        await verify_current(conn, owner, row)
        transfer = await (await conn.execute(
            'SELECT e.id,e.direction,e.after_quantity,e.after_cost,h.id AS transfer_id,h.occurred_at,'
            'h.source_record_id,h.target_record_id,h.source_account_id,h.target_account_id,'
            'h.evidence_sha256 FROM broker_position_transfer_events e '
            'JOIN broker_position_transfers h ON h.owner_id=e.owner_id AND h.id=e.transfer_id '
            'WHERE e.owner_id=%s AND e.id=%s AND e.record_id=%s AND e.account_id=%s',
            (owner,row['position_transfer_id'],row['id'],row['broker_account_id']),
        )).fetchone()
        if transfer is None:
            raise HTTPException(503,'转仓凭证与当前持仓归属暂时无法核对')
        result['transferObservation'] = {
            'transferId':str(transfer['transfer_id']), 'checkpointId':str(transfer['id']),
            'direction':transfer['direction'], 'occurredAt':transfer['occurred_at'].isoformat(),
            'sourceRecordId':transfer['source_record_id'], 'targetRecordId':transfer['target_record_id'],
            'sourceAccountId':transfer['source_account_id'], 'targetAccountId':transfer['target_account_id'],
            'evidenceSha256':transfer['evidence_sha256'], 'authority':'owner_recorded_transfer',
            'cashEffect':'none', 'originalTradeHistoryMoved':False,
            'checkpointQuantity':str(transfer['after_quantity']), 'checkpointUnitCost':str(transfer['after_cost']),
            'economicCostBasisKnown':False,
        }
        if row.get('trade_tip_id') is None:
            result['positionAuthority']='owner_recorded_transfer'
            result['costAuthority']='registered_transfer_unit_cost'
    if await first_unknown_revision(conn,owner,row['id']) is not None:
        result.update(registeredCost=result['cost'],cost=None,costKnown=False)
    from .broker_statement_projection import official_record
    official = await official_record(conn, owner, row)
    if official is not None:
        result.update(registeredQty=record_dto(row)['qty'],
                      registeredCost=record_dto(row)['cost'],
                      registeredPrice=record_dto(row)['price'],
                      ledgerCost=result['cost'], ledgerCostKnown=result.get('costKnown', result['cost'] is not None))
        result.update(official)
        result['costKnown'] = official['cost'] is not None
        result['financialHistoryReplayed'] = False
    return result


async def actual_cash_known(conn,owner,kind,currency,account=None):
    row=await(await conn.execute('SELECT 1 FROM trade_ledger t WHERE t.owner_id=%s AND t.account_kind=%s AND t.settlement_currency=%s AND (%s::text IS NULL OR t.account_id=%s) AND '+PENDING_FEE_SQL+' LIMIT 1',(owner,kind,currency,account,account))).fetchone()
    if row:return False
    from .registered_account_coverage import registered_account_known
    if account is not None:return await registered_account_known(conn,owner,account,currency)
    accounts=await(await conn.execute('SELECT DISTINCT b.account_id FROM legacy_fee_source_account_bindings b JOIN broker_accounts a ON a.owner_id=b.owner_id AND a.id=b.account_id WHERE b.owner_id=%s AND a.account_kind=%s',(owner,kind))).fetchall()
    return all([await registered_account_known(conn,owner,item['account_id'],currency) for item in accounts])


async def require_actual_cash(conn,owner,kind,currency,account=None):
    if not await actual_cash_known(conn,owner,kind,currency,account):
        raise HTTPException(409,'历史实付费用尚未核实，不能把登记余额当作实际可用资金',headers={'X-Alcor-Financial-Scope':'incomplete'})


async def confirmed_actual_fees(conn,owner,ids=None):
    """Both lanes retain their own evidence; ordinary economics share one actual projection."""
    return await(await conn.execute("""SELECT a.trade_id,a.request_id,a.actual_fee,a.evidence,a.evidence_sha256 FROM actual_fee_confirmations a
      JOIN trade_fee_corrections c ON c.owner_id=a.owner_id AND c.trade_id=a.trade_id AND c.request_id=a.request_id AND c.new_fees=a.actual_fee
      WHERE a.owner_id=%s AND (%s::uuid[] IS NULL OR a.trade_id=ANY(%s::uuid[]))
      UNION ALL SELECT a.trade_id,a.request_id,a.actual_fee,a.evidence,a.evidence_sha256 FROM native_actual_fee_confirmations a
      JOIN trade_fee_corrections c ON c.owner_id=a.owner_id AND c.trade_id=a.trade_id AND c.request_id=a.request_id AND c.old_fees=a.registered_fee AND c.new_fees=a.actual_fee
      WHERE a.owner_id=%s AND (%s::uuid[] IS NULL OR a.trade_id=ANY(%s::uuid[]))""",(owner,ids,ids,owner,ids,ids))).fetchall()
