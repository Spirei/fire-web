import { orderExecutionAuthorized } from "./orderExecutionAuthorization";
import { getDb } from "./db";
import { readRecord, listRecords } from "./store";
import { RecordsError, validRecordRequestId } from "./recordsContract";
import { assetLocalDate, assetTimeZones } from "./appAssets";
import type { Quote, StockRecord } from "./types";
import { holdingAccountMarket, holdingAccountCurrency } from "./stockAccount";
import { orderFeeRead } from './orderFeeRead';
export const ASSET_ORDER_FILTERS = ["all", "pending", "filled", "cancelled", "rejected", "expired"] as const;
type Row = Record<string, unknown> & { id: string; record_id: string; market: string; code: string; revision: number; status: string; traded_at: string };
const num = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
export function assetOrderRows(userId: string) {
  return getDb().prepare("SELECT o.*,v.revision,m.parent_id,m.role,m.trigger_above,m.draft_json AS submission_draft,json_extract(m.draft_json,'$.mode') AS submission_mode,f.source fee_source,f.request_id fee_operation_id,f.detail_json fee_detail,e.source fee_evidence_source,e.detail_json fee_evidence_detail,l.account_id cash_broker_account_id,d.detail_json saved_fee_detail,c.request_id correction_operation,c.replacement_id correction_replacement,n.request_id replacement_operation FROM trade_orders o JOIN app_asset_order_versions v ON v.order_id=o.id LEFT JOIN app_trade_metadata m ON m.order_id=o.id LEFT JOIN trade_fee_corrections f ON f.order_id=o.id AND f.user_id=o.user_id LEFT JOIN trade_fee_evidence e ON e.order_id=o.id AND e.user_id=o.user_id LEFT JOIN broker_cash_order_links l ON l.order_id=o.id AND l.user_id=o.user_id LEFT JOIN trade_fee_details d ON d.order_id=o.id AND d.user_id=o.user_id LEFT JOIN trade_correction_originals c ON c.order_id=o.id AND c.user_id=o.user_id LEFT JOIN trade_correction_replacements n ON n.order_id=o.id AND n.user_id=o.user_id WHERE o.user_id=? ORDER BY o.traded_at DESC,o.created_at DESC,o.id DESC").all(userId) as Row[];
}
export function selectAssetOrders(rows: Row[], scope: string, status: string, recordId: string | null, now: number) {
  const todayByMarket = new Map<string, string | null>();
  return rows.filter(row => {
    if (recordId && row.record_id !== recordId || status !== "all" && row.status !== status) return false;
    if (scope === "all") return true;
    const day = assetLocalDate(row.traded_at, row.market);
    if (day === null) return false;
    if (!todayByMarket.has(row.market)) todayByMarket.set(row.market, assetLocalDate(now, row.market));
    return day === todayByMarket.get(row.market);
  });
}
export function assetOrderItem(userId: string, row: Row, quote?: Quote, cachedRecord?: StockRecord | null) {
  const record = cachedRecord === undefined ? readRecord(userId, row.record_id) : cachedRecord, identityMatches = !!record && record.market === row.market && record.code === row.code;
  const qty = num(row.qty), knownStatus = ["pending", "filled", "cancelled", "expired"].includes(row.status);
  // The existing engine settles each order atomically. No partial fills are recorded.
  const filledQty = qty !== null && knownStatus ? row.status === "filled" ? qty : 0 : null;
  const currentPrice = quote && num(quote.price) !== null && quote.price > 0 ? quote.price : null;
  let attachments: unknown = null, attachmentInputsAvailable = false;
  if (row.role === "parent" && typeof row.submission_draft === "string") {
    try {
      const draft = JSON.parse(row.submission_draft);
      if (draft && typeof draft === "object" && !Array.isArray(draft) &&
        (draft.attachments === undefined || draft.attachments && typeof draft.attachments === "object" && !Array.isArray(draft.attachments))) {
        attachmentInputsAvailable = true;
        attachments = draft.attachments ?? null;
      }
    } catch { /* Missing confirmation inputs must not be guessed by amendment editors. */ }
  }
  let executionGrant: string | undefined;
  try { executionGrant = JSON.parse(String(row.submission_draft)).executionGrant; } catch { /* Legacy drafts stay explicit. */ }
  const continuousExecution = typeof executionGrant === "string";
  const executionScan = continuousExecution ? getDb().prepare("SELECT result,scanned_at FROM app_order_worker_scans WHERE order_id=?").get(row.id) as {result:string|null;scanned_at:number}|undefined : undefined;
  const executionFailure = executionScan?.result;
  const executionStatus = row.status !== "pending" ? null : !row.role ? null : !identityMatches ? "证券身份已变化，执行已暂停" : !continuousExecution ? "待重新确认委托" : !orderExecutionAuthorized(userId, executionGrant!) ? "授权失效，执行已暂停" : executionFailure ? executionFailure : row.trigger_status === "已触发，等待委托价" ? row.trigger_status : !executionScan ? "等待服务端核对" : Date.now() - executionScan.scanned_at > 30000 ? "服务端监控暂未更新" : "服务端持续核对";
  return {
    continuousExecution, executionStatus,
    id: row.id, orderNo: row.order_no, recordId: row.record_id, market: row.market, code: row.code, name: row.name,
    side: row.side, status: row.status, revision: row.revision, recordRevision: record?.revision ?? null, identityMatches,
    accountMarket: identityMatches ? holdingAccountMarket(record!) : row.settlement_currency === "CNY" ? "CN" : row.market,
    accountCurrency: identityMatches ? holdingAccountCurrency(record!) : null,
    settlementCurrency: row.settlement_currency || null, settlementAmount: num(row.settlement_amount),
    realizedPnl: num(row.realized_pnl), positionQtyBefore: num(row.position_qty_before), positionQtyAfter: num(row.position_qty_after),
    positionCostBefore: num(row.position_cost_before), positionCostAfter: num(row.position_cost_after),
    parentOrderId: row.parent_id ?? null, attachmentRole: row.role ?? null,
    attachments, attachmentInputsAvailable,
    executionModel: row.role ? row.submission_mode === "record" ? "owner_recorded_fill" : "explicit_quote_observation" : "legacy_internal_orders",
    qty, price: num(row.price), fees: num(row.fees), amount: num(row.amount), orderType: row.order_type,
    ...orderFeeRead(row),currentRecordBrokerAccountId:identityMatches?record!.brokerAccountId||null:null,
    orderPrice: row.status === "filled" ? null : num(row.price), executedPrice: row.status === "filled" ? num(row.price) : null,
    triggerPrice: num(row.trigger_price), filledQty, filledQtySource: filledQty === null ? "unavailable" : "atomic_order_status",
    tif: row.tif, expiresAt: row.expires_at, session: row.session, triggerStatus: row.trigger_status,
    tradedAt: row.traded_at, createdAt: row.created_at, broker: row.broker, note: row.note,
    currentPrice, currentPriceSource: currentPrice === null ? "unavailable" : quote!.cached ? "quote_cache" : "quote",
    currentPriceAt: currentPrice === null ? null : quote!.time || null,
    ...(row.correction_operation?{correction:{state:"superseded",operationId:row.correction_operation,replacementId:row.correction_replacement??null}}:row.replacement_operation?{correction:{state:"replacement",operationId:row.replacement_operation}}:{}),
    cancellable: row.status === "pending" && identityMatches
  };
}
export function assetOrdersResult(userId: string, rows: Row[], scope: string, status: string, recordId: string | null, now: number, quotes: Record<string, Quote>) {
  const selected = selectAssetOrders(rows, scope, status, recordId, now);
  const records = new Map(listRecords(userId).map(r => [r.id, r]));
  return { accountId: userId, asOf: new Date(now).toISOString(), scope, status, recordId,
    source: "local_trade_ledger", executionModel: "atomic_internal_orders",
    items: selected.map(row => assetOrderItem(userId, row, quotes[row.id], records.get(row.record_id) ?? null)), count: selected.length, settlesPendingOrders: false,
    dateBasis: "exchange_local_calendar_date", timeZones: assetTimeZones,
    unknownDateOrderIds: rows.filter(row => (!recordId || row.record_id === recordId) && assetLocalDate(row.traded_at, row.market) === null).map(row => row.id),
    supportedStatuses: ["pending", "filled", "cancelled", "expired"], rejectedOrdersAvailable: false, partialFillsAvailable: false };
}
export function cancelAssetOrders(userId: string, body: unknown, authorize: () => string) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new RecordsError("无效请求体");
  const b = body as Record<string, unknown>, requestId = validRecordRequestId(b.requestId);
  if (Object.keys(b).some(k => !["requestId", "accountId", "orders"].includes(k)) || b.accountId !== userId || !Array.isArray(b.orders) || !b.orders.length || b.orders.length > 100) throw new RecordsError("须明确选择本人1至100笔订单");
  const selected = b.orders.map(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new RecordsError("订单参数无效");
    const o = value as Record<string, unknown>;
    if (Object.keys(o).some(k => !["orderId", "recordId", "market", "code", "revision", "recordRevision"].includes(k)) ||
      typeof o.orderId !== "string" || !o.orderId || o.orderId.length > 200 ||
      ["recordId", "market", "code"].some(k => typeof o[k] !== "string" || !o[k] || (o[k] as string).length > 200) ||
      !Number.isSafeInteger(o.revision) || Number(o.revision) < 1 || !Number.isSafeInteger(o.recordRevision) || Number(o.recordRevision) < 1) throw new RecordsError("须提供订单身份与最新版本");
    return o;
  });
  if (new Set(selected.map(o => o.orderId)).size !== selected.length) throw new RecordsError("订单编号重复");
  const db = getDb();
  return db.transaction(() => {
    if (authorize() !== userId) throw new RecordsError("连接已失效", 401);
    if (db.prepare("SELECT 1 FROM app_asset_operations WHERE user_id=? AND request_id=?").get(userId, requestId)) throw new RecordsError("requestId已使用，请查询原回执", 409, 40901);
    const rows = new Map(assetOrderRows(userId).map(row => [row.id, row]));
    let error: RecordsError | null = null;
    for (const o of selected) {
      const row = rows.get(o.orderId as string), record = row ? readRecord(userId, row.record_id) : null;
      if (!row) { error = new RecordsError("本人订单不存在", 404); break; }
      if (!record || row.status !== "pending" || row.revision !== o.revision || row.record_id !== o.recordId || row.market !== o.market || row.code !== o.code ||
        record.revision !== o.recordRevision || record.market !== row.market || record.code !== row.code) {
        error = new RecordsError("订单或证券已变化，请重新读取后确认", 409, 40902); break;
      }
    }
    if (!error) for (const o of selected) db.prepare("UPDATE trade_orders SET status='cancelled',trigger_status='已撤销' WHERE id=? AND user_id=? AND status='pending'").run(o.orderId, userId);
    const result = { requestId, kind: "cancel_orders", accountId: userId, orderIds: selected.map(o => o.orderId), state: error ? "failed" : "completed",
      code: error?.code ?? 0, message: error?.message ?? "ok", completedAt: new Date().toISOString(),
      data: error ? null : { items: assetOrderRows(userId).filter(row => selected.some(o => o.orderId === row.id)).map(row => assetOrderItem(userId, row)) } };
    db.prepare("INSERT INTO app_asset_operations VALUES(?,?,?)").run(userId, requestId, JSON.stringify(result));
    return { result, error };
  }).immediate();
}
