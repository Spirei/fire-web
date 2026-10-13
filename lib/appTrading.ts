import { createHash } from "node:crypto";
import { getDb } from "./db";
import { listRecords, readRecord } from "./store";
import { buildAssets, instrumentSnapshot, assetLocalDate, assetTimeZones } from "./appAssets";
import { assetOrderRows, assetOrderItem } from "./appAssetOrders";
import { RecordsError, validRecordRequestId } from "./recordsContract";
import { createFundTransaction, listFundTransactions, countFundTransactions, isFundCurrency } from "./funds";
import { applyOrder } from "./tradeAccounting";
import { executeOrder, placeOrder, fillPendingRow } from "./orders";
import { holdingAccountCurrency, isStockConnect } from "./stockAccount";
import type { Quote, StockRecord } from "./types";

type Values = Record<string, unknown>;
type Leg = { percent: number; orderType: "limit" | "market"; limitPrice?: number; fees: number };
type Attachment = { takeProfit?: Leg; stopLoss?: Leg; session: string; tif: "day" | "gtc" };
type Draft = { recordId: string; recordRevision: number; snapshotRevision: string; side: "buy" | "sell" | "dividend";
  mode: "record" | "order"; orderType: "limit" | "market"; qty: number; price: number; fees: number;
  tif: "day" | "gtc"; session: string; tradedAt?: string; settlementAmount?: number; attachments?: Attachment; note: string; confirmedAt?: string; triggeredAt?: string };
type Meta = { order_id: string; parent_id: string | null; role: string; trigger_above: number | null; draft_json: string; identity_json: string };
const defaults = { currency: "USD", costMethod: "diluted" as const, usPrice: "observed" as const };
const profile = { username: "", nickname: "", uid: "", avatar: "" };
const conflict = (message: string) => new RecordsError(message, 409, 40902);
function isoTime(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/);
  if (!m || +m[4] > 23 || +m[5] > 59 || +m[6] > 59) return null;
  const day = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (day.toISOString().slice(0, 10) !== raw.slice(0, 10)) return null;
  const n = Date.parse(raw); return Number.isFinite(n) ? n : null;
}
function object(value: unknown, fields: string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => !fields.includes(k))) throw new RecordsError("请求含无效或未知字段");
  return value as Values;
}
function number(value: unknown, zero = false) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < (zero ? 0 : Number.MIN_VALUE) || value > 1e12) throw new RecordsError("金额、价格、数量或费用无效");
  return value;
}
const identity = (r: StockRecord) => JSON.stringify({ market: r.market, code: r.code, accountMarket: r.accountMarket || r.market });
function metas(userId: string) {
  return getDb().prepare("SELECT m.* FROM app_trade_metadata m JOIN trade_orders o ON o.id=m.order_id WHERE o.user_id=? ORDER BY m.order_id").all(userId) as Meta[];
}
/** Quotes never alter this revision. Every financial writer and cash adjustment does. */
export function tradingSnapshot(userId: string) {
  const db = getDb(), records = listRecords(userId), rows = assetOrderRows(userId);
  const assets = buildAssets(userId, profile, { USD: 1 }, {}, defaults);
  const funds = db.prepare("SELECT * FROM fund_transactions WHERE user_id=? ORDER BY id").all(userId);
  const declarations = db.prepare("SELECT * FROM app_asset_instruments WHERE user_id=? ORDER BY record_id").all(userId);
  const metadata = metas(userId);
  const byRecord = new Map(records.map(r => [r.id, r]));
  const snapshotRevision = createHash("sha256").update(JSON.stringify({ records, rows, funds, declarations, metadata, cash: assets.cash })).digest("hex");
  return { accountId: userId, snapshotRevision, collectionRevision: assets.collectionRevision, asOf: new Date().toISOString(),
    cash: assets.cash, positions: assets.positions, orders: rows.map(row => assetOrderItem(userId, row, undefined, byRecord.get(row.record_id) ?? null)) };
}
function leg(value: unknown): Leg {
  const v = object(value, ["percent", "orderType", "limitPrice", "fees"]), percent = number(v.percent);
  if (percent >= 100 || !["limit", "market"].includes(String(v.orderType))) throw new RecordsError("附加单比例或类型无效");
  if (v.orderType === "market" && v.limitPrice !== undefined) throw new RecordsError("市价附加单不接受委托价");
  return { percent, orderType: v.orderType as Leg["orderType"], fees: number(v.fees, true), ...(v.limitPrice === undefined ? {} : { limitPrice: number(v.limitPrice) }) };
}
function attachments(value: unknown): Attachment | undefined {
  if (value === undefined) return;
  const v = object(value, ["takeProfit", "stopLoss", "session", "tif"]);
  if ((!v.takeProfit && !v.stopLoss) || !["REGULAR", "EXTENDED"].includes(String(v.session)) || !["day", "gtc"].includes(String(v.tif))) throw new RecordsError("附加单时段或有效期无效");
  return { ...(v.takeProfit ? { takeProfit: leg(v.takeProfit) } : {}), ...(v.stopLoss ? { stopLoss: leg(v.stopLoss) } : {}), session: String(v.session), tif: v.tif as Attachment["tif"] };
}
function draft(body: unknown, userId: string): Draft {
  const v = object(body, ["requestId", "accountId", "recordId", "recordRevision", "snapshotRevision", "side", "mode", "orderType", "qty", "price", "fees", "tif", "session", "tradedAt", "settlementAmount", "attachments", "note", "orderRevision"]);
  if (v.accountId !== userId || typeof v.recordId !== "string" || !v.recordId || v.recordId.length > 200 || !Number.isSafeInteger(v.recordRevision) || Number(v.recordRevision) < 1 || typeof v.snapshotRevision !== "string" || !/^[a-f0-9]{64}$/.test(v.snapshotRevision)) throw new RecordsError("须提供本人账户、证券和快照版本");
  if (!["buy", "sell", "dividend"].includes(String(v.side)) || !["record", "order"].includes(String(v.mode)) || !["limit", "market"].includes(String(v.orderType)) || !["day", "gtc"].includes(String(v.tif)) || !["REGULAR", "EXTENDED"].includes(String(v.session))) throw new RecordsError("交易方向、类型、时段或有效期无效");
  const qty = number(v.qty), price = number(v.price), fees = number(v.fees, true);
  if (qty * price <= 0 || qty * price > 1e12 || ![qty, price, fees].every(n => Number(n.toFixed(8)) === n)) throw new RecordsError("成交金额超出上限或输入超过八位小数");
  if (v.note !== undefined && (typeof v.note !== "string" || v.note.length > 500)) throw new RecordsError("备注无效");
  const tradedAt = isoTime(v.tradedAt);
  if (v.mode === "record" && (tradedAt === null || tradedAt > Date.now())) throw new RecordsError("须明确提供已发生的成交时间");
  if (v.mode === "order" && v.tradedAt !== undefined || v.side === "dividend" && (v.mode !== "record" || v.attachments !== undefined)) throw new RecordsError("委托不能补造成交时间，股息仅支持实际登记");
  return { recordId: v.recordId, recordRevision: Number(v.recordRevision), snapshotRevision: v.snapshotRevision, side: v.side as Draft["side"], mode: v.mode as Draft["mode"], orderType: v.orderType as Draft["orderType"], qty, price, fees,
    tif: v.tif as Draft["tif"], session: String(v.session), tradedAt: v.tradedAt as string | undefined, settlementAmount: v.settlementAmount === undefined ? undefined : number(v.settlementAmount), attachments: attachments(v.attachments), note: String(v.note ?? "") };
}
function reservation(userId: string, record: StockRecord, excluded?: string) {
  const metadata = new Map(metas(userId).map(m => [m.order_id, m]));
  const records = new Map(listRecords(userId).map(r => [r.id, r]));
  const sells = new Map<string, number>(), buys = new Map<string, number>();
  const excludedGroup = excluded ? metadata.get(excluded)?.parent_id : null;
  for (const row of assetOrderRows(userId).filter(o => o.status === "pending" && o.id !== excluded)) {
    const current = records.get(row.record_id);
    if (!current || current.market !== row.market || current.code !== row.code) continue;
    const group = metadata.get(row.id)?.parent_id || row.id;
    if (excludedGroup && group === excludedGroup) continue;
    if (row.side === "buy" && holdingAccountCurrency(current) === holdingAccountCurrency(record)) buys.set(group, Math.max(buys.get(group) ?? 0, Number(row.qty) * Number(row.price) + Number(row.fees)));
    if (row.side === "sell" && row.record_id === record.id) {
      const key = metadata.get(row.id)?.parent_id || row.id;
      sells.set(key, Math.max(sells.get(key) ?? 0, Number(row.qty)));
    }
  }
  const qty = [...sells.values()].reduce((a, b) => a + b, 0);
  const cash = [...buys.values()].reduce((a, b) => a + b, 0);
  if (!Number.isFinite(cash) || !Number.isFinite(qty)) throw conflict("待成交订单的占用金额或数量无法核对");
  return { cash, qty };
}
function preview(userId: string, d: Draft, excluded?: string) {
  const state = tradingSnapshot(userId), record = readRecord(userId, d.recordId);
  if (!record) throw new RecordsError("本人证券不存在", 404);
  if (state.snapshotRevision !== d.snapshotRevision || record.revision !== d.recordRevision) throw conflict("账户或证券已变化，请重新预览");
  if (d.mode === "record") {
    const dates = assetOrderRows(userId).filter(o => o.record_id === record.id && o.status === "filled").map(o => Date.parse(o.traded_at));
    if (dates.some(n => !Number.isFinite(n) || n > Date.parse(d.tradedAt!))) throw conflict("已有成交历史晚于本次记录，请先核对历史顺序");
  }
  const declared = instrumentSnapshot(userId, record.id).instrument;
  if (!declared.identityMatches || !["cash_equity", "etf"].includes(declared.kind) || declared.listingStatus === "delisted") throw conflict("须先确认当前证券为股票或 ETF 且未声明退市");
  if (!assetTimeZones[record.market] || record.market !== "US" && (d.session !== "REGULAR" || d.attachments?.session === "EXTENDED")) throw new RecordsError("该市场不支持所选时段");
  if (isStockConnect(record) ? d.mode !== "record" || d.attachments || !d.settlementAmount : d.settlementAmount !== undefined) throw new RecordsError("港股通仅登记已成交订单及实际人民币净额，不支持自动委托或附加单");
  const currency = holdingAccountCurrency(record), cash = state.cash.nativeBalancesByCurrency?.[currency];
  const qty = record.qty === "" ? NaN : Number(record.qty), cost = record.cost === "" ? qty > 0 ? null : 0 : Number(record.cost);
  if (!state.cash.sourceComplete || !Number.isFinite(cash) || !Number.isFinite(qty) || qty < 0 || cost === null || !Number.isFinite(cost)) throw conflict("现金、数量或成本来源不完整，请先核对");
  const reserved = reservation(userId, record, excluded), amount = d.qty * d.price;
  const total = d.settlementAmount ?? (d.side === "buy" ? amount + d.fees : amount - d.fees);
  if (total < 0 || total > 1e12 || d.side === "buy" && total > cash! - reserved.cash + 1e-8 || d.side === "sell" && d.qty > qty - reserved.qty + 1e-10) throw conflict("可用现金或可卖数量不足");
  const position = applyOrder({ qty, cost }, d);
  if (![position.qty, position.cost].every(Number.isFinite) || position.qty > 1e12) throw new RecordsError("成交后数量或成本超出上限");
  return { accountId: userId, recordId: record.id, recordRevision: record.revision, snapshotRevision: state.snapshotRevision,
    mode: d.mode, executionModel: "internal_trade_ledger", priceCurrency: state.positions.find(p => p.recordId === record.id)!.currency, settlementCurrency: currency,
    amount, fees: d.fees, feeSource: "owner_recorded", feeBreakdown: null, settlementAmount: total,
    cashBefore: cash!, cashAfter: cash! + (d.side === "buy" ? -total : total), qtyBefore: qty, qtyAfter: position.qty, costBefore: cost, costAfter: position.cost,
    reservedCash: reserved.cash, reservedQty: reserved.qty, attachments: d.attachments ?? null, immediateAccounting: d.mode === "record", canSubmit: true };
}
export function previewTrade(userId: string, body: unknown) {
  const d = draft(body, userId);
  if ("orderRevision" in (body as Values)) throw new RecordsError("新建预览不接受订单版本，请使用改单预览");
  return preview(userId, d);
}
function amendTarget(userId: string, id: string, d: Draft, b: Values) {
  if (!Number.isSafeInteger(b.orderRevision) || Number(b.orderRevision) < 1 || d.mode !== "order") throw new RecordsError("改单版本或模式无效");
  const row = assetOrderRows(userId).find(row => row.id === id), meta = metas(userId).find(m => m.order_id === id);
  if (!row || !meta) throw new RecordsError("本人 API 委托不存在", 404);
  const record = readRecord(userId, d.recordId);
  if (!record || row.status !== "pending" || row.revision !== b.orderRevision || row.record_id !== d.recordId || meta.parent_id ||
    row.market !== record.market || row.code !== record.code || identity(record) !== meta.identity_json) throw conflict("只能修改身份一致的最新未成交主单");
  return row;
}
export function previewAmendTrade(userId: string, id: string, body: unknown) {
  const d = draft(body, userId);
  const row = amendTarget(userId, id, d, body as Values);
  return { ...preview(userId, d, id), orderId: row.id, orderRevision: row.revision };
}
function saveMeta(userId: string, id: string, d: Draft, parent: string | null = null, role = "parent", above: boolean | null = null) {
  const r = readRecord(userId, d.recordId)!;
  getDb().prepare("INSERT INTO app_trade_metadata VALUES(?,?,?,?,?,?)").run(id, parent, role, above === null ? null : Number(above), JSON.stringify({ ...d, confirmedAt: new Date().toISOString() }), identity(r));
}
function committedState(userId: string, recordId: string) {
  const s = tradingSnapshot(userId);
  return { accountId: userId, snapshotRevision: s.snapshotRevision, collectionRevision: s.collectionRevision, cash: s.cash,
    position: s.positions.find(p => p.recordId === recordId) ?? null };
}
function pending(userId: string, d: Draft) {
  const result = placeOrder({ userId, ...d, mode: "order", orderType: "limit" });
  getDb().prepare("UPDATE trade_orders SET order_type=?,session=?,trigger_status='等待明确行情观察' WHERE id=?").run(d.orderType, d.session, result.order.id);
  return result.order.id;
}
function children(userId: string, parent: string, d: Draft, fillPrice: number) {
  if (!d.attachments) return;
  for (const [role, leg] of [["take_profit", d.attachments.takeProfit], ["stop_loss", d.attachments.stopLoss]] as const) {
    if (!leg) continue;
    const above = (d.side === "buy") === (role === "take_profit"), trigger = fillPrice * (1 + (above ? 1 : -1) * leg.percent / 100);
    const child: Draft = { ...d, side: d.side === "buy" ? "sell" : "buy", mode: "order", price: leg.limitPrice ?? trigger, fees: leg.fees, orderType: leg.orderType, session: d.attachments.session, tif: d.attachments.tif, attachments: undefined, tradedAt: undefined };
    const id = pending(userId, child); saveMeta(userId, id, child, parent, role, above);
    getDb().prepare("UPDATE trade_orders SET trigger_price=? WHERE id=?").run(trigger, id);
  }
}
/** Receipt and every financial change commit once, including deterministic failures. */
function mutation(userId: string, body: unknown, kind: string, authorize: () => string, run: () => unknown) {
  const b = body as Values, requestId = validRecordRequestId(b?.requestId), db = getDb();
  return db.transaction(() => {
    if (authorize() !== userId) throw new RecordsError("连接已失效", 401);
    if (db.prepare("SELECT 1 FROM app_asset_operations WHERE user_id=? AND request_id=?").get(userId, requestId)) throw new RecordsError("requestId 已使用，请查询原回执", 409, 40901);
    let data: unknown = null, error: RecordsError | null = null;
    try { data = db.transaction(run)(); }
    catch (e) { if (!(e instanceof RecordsError)) throw e; error = e; }
    const result = { requestId, accountId: userId, kind, state: error ? "failed" : "completed", code: error?.code ?? 0, message: error?.message ?? "ok", data, completedAt: new Date().toISOString() };
    db.prepare("INSERT INTO app_asset_operations VALUES(?,?,?)").run(userId, requestId, JSON.stringify(result));
    return { result, error };
  }).immediate();
}
export function submitTrade(userId: string, body: unknown, authorize: () => string) {
  const d = draft(body, userId);
  if ("orderRevision" in (body as Values)) throw new RecordsError("新建交易不接受订单版本");
  return mutation(userId, body, "submit_trade", authorize, () => {
    const p = preview(userId, d);
    const id = d.mode === "record" ? executeOrder({ userId, ...d, triggerStatus: "API 实际成交登记" }).order.id : pending(userId, d);
    saveMeta(userId, id, d);
    if (d.mode === "record") children(userId, id, d, d.price);
    const childIds = new Set(metas(userId).filter(m => m.parent_id === id).map(m => m.order_id));
    return { preview: p, items: assetOrderRows(userId).filter(row => row.id === id || childIds.has(row.id)).map(row => assetOrderItem(userId, row)), snapshot: committedState(userId, d.recordId) };
  });
}
export function amendTrade(userId: string, id: string, body: unknown, authorize: () => string) {
  const d = draft(body, userId), b = body as Values;
  if (!Number.isSafeInteger(b.orderRevision) || Number(b.orderRevision) < 1 || d.mode !== "order") throw new RecordsError("改单版本或模式无效");
  return mutation(userId, body, "amend_trade", authorize, () => {
    amendTarget(userId, id, d, b);
    const p = preview(userId, d, id), db = getDb();
    db.prepare("UPDATE trade_orders SET side=?,qty=?,price=?,fees=?,amount=?,order_type=?,tif=?,session=?,note=?,trigger_status='等待明确行情观察' WHERE id=? AND user_id=?").run(d.side, d.qty, d.price, d.fees, d.qty * d.price, d.orderType, d.tif, d.session, d.note, id, userId);
    db.prepare("UPDATE app_trade_metadata SET draft_json=?,identity_json=? WHERE order_id=?").run(JSON.stringify({ ...d, confirmedAt: new Date().toISOString() }), identity(readRecord(userId, d.recordId)!), id);
    return { preview: p, items: [assetOrderItem(userId, assetOrderRows(userId).find(row => row.id === id)!)], snapshot: committedState(userId, d.recordId) };
  });
}
/** Exchange timestamps are not device-local timestamps; reject ambiguous DST times. */
export function tradingQuoteTime(value: unknown, market: string): number | null {
  if (typeof value !== "string" || value.length > 100) return null;
  let raw = value;
  if (/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(raw)) return isoTime(raw);
  const slash = raw.match(/^(\d{4})\/(\d{2})\/(\d{2})([ T].*)$/);
  if (slash) raw = `${slash[1]}-${slash[2]}-${slash[3]}${slash[4]}`;
  const compact = raw.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (compact) raw = `${compact[1]}-${compact[2]}-${compact[3]} ${compact[4]}:${compact[5]}:${compact[6]}`;
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/), zone = assetTimeZones[market];
  if (!m || !zone) return null;
  const desired = m.slice(1, 7).join(""), utc = Date.UTC(...[Number(m[1]), Number(m[2]) - 1, ...m.slice(3, 7).map(Number)] as [number, number, number, number, number, number]);
  const format = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const parts = (n: number) => Object.fromEntries(format.formatToParts(n).map(p => [p.type, p.value]));
  const key = (n: number) => { const p = parts(n); return p.year + p.month + p.day + p.hour + p.minute + p.second; };
  let n = utc;
  for (let i = 0; i < 3; i++) { const p = parts(n); n += utc - Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second); }
  if (key(n) !== desired || key(n - 3600000) === desired || key(n + 3600000) === desired) return null;
  return n + Number((m[7] ?? "").padEnd(3, "0"));
}
export function validateObservation(userId: string, body: unknown) {
  const b = object(body, ["requestId", "accountId", "snapshotRevision", "orderRevision", "recordRevision"]);
  validRecordRequestId(b.requestId);
  if (b.accountId !== userId || typeof b.snapshotRevision !== "string" || !/^[a-f0-9]{64}$/.test(b.snapshotRevision) || !Number.isSafeInteger(b.orderRevision) || Number(b.orderRevision) < 1 || !Number.isSafeInteger(b.recordRevision) || Number(b.recordRevision) < 1) throw new RecordsError("观察请求版本无效");
  return b;
}
export function observeTrade(userId: string, id: string, body: unknown, quote: Quote | undefined, authorize: () => string) {
  const b = validateObservation(userId, body);
  return mutation(userId, b, "observe_trade", authorize, () => {
    const row = assetOrderRows(userId).find(row => row.id === id), meta = metas(userId).find(m => m.order_id === id);
    if (!row || !meta) throw new RecordsError("本人 API 委托不存在", 404);
    const record = readRecord(userId, row.record_id), state = tradingSnapshot(userId);
    if (!record || row.status !== "pending" || row.revision !== b.orderRevision || record.revision !== b.recordRevision || state.snapshotRevision !== b.snapshotRevision || identity(record) !== meta.identity_json || isStockConnect(record)) throw conflict("委托、证券或账户已变化，请重新读取");
    const d = JSON.parse(meta.draft_json) as Draft, now = Date.now(), created = Date.parse(d.confirmedAt ?? String(row.created_at));
    if (!Number.isFinite(created)) throw conflict("委托确认时间无法核对");
    if (row.tif === "day" && assetLocalDate(now, row.market) !== assetLocalDate(created, row.market)) {
      getDb().prepare("UPDATE trade_orders SET status='expired',trigger_status='当日有效已到期' WHERE id=?").run(id);
    } else {
      const at = quote ? tradingQuoteTime(quote.time, row.market) : null;
      if (!quote || at === null || at < created || at > now || now - at > 30_000 || !Number.isFinite(quote.price) || quote.price <= 0 || !["futu", "tencent", "yahoo"].includes(quote.source ?? "") || (quote as Quote & { displayStale?: boolean }).displayStale || !["REGULAR", ...(d.session === "EXTENDED" && row.market === "US" ? ["PRE", "AFTER"] : [])].includes(quote.session ?? "")) throw conflict("缺少保存之后的有效实时行情，未执行订单");
      const triggered = !!d.triggeredAt || meta.trigger_above === null || (meta.trigger_above ? quote.price >= Number(row.trigger_price) : quote.price <= Number(row.trigger_price));
      const limit = d.orderType === "market" || (d.side === "buy" ? quote.price <= d.price : quote.price >= d.price);
      if (triggered && limit) {
        const actual = { ...d, mode: "record" as const, tradedAt: new Date(at).toISOString(), price: quote.price, snapshotRevision: state.snapshotRevision, recordRevision: record.revision! };
        preview(userId, actual, id);
        if (!fillPendingRow(row, quote.price, new Date(at).toISOString())) throw conflict("委托未成交，请重新读取");
        if (meta.parent_id) getDb().prepare("UPDATE trade_orders SET status='cancelled',trigger_status='附加单另一侧已成交' WHERE status='pending' AND id IN(SELECT order_id FROM app_trade_metadata WHERE parent_id=? AND order_id<>?)").run(meta.parent_id, id);
        else children(userId, id, d, quote.price);
      } else if (triggered && meta.trigger_above !== null && !d.triggeredAt) {
        getDb().prepare("UPDATE app_trade_metadata SET draft_json=? WHERE order_id=?").run(JSON.stringify({ ...d, triggeredAt: new Date(at).toISOString() }), id);
        getDb().prepare("UPDATE trade_orders SET trigger_status='已触发，等待委托价' WHERE id=?").run(id);
      }
    }
    const childIds = new Set(metas(userId).filter(m => m.parent_id === id || meta.parent_id && m.parent_id === meta.parent_id).map(m => m.order_id));
    return { items: assetOrderRows(userId).filter(row => row.id === id || childIds.has(row.id)).map(row => assetOrderItem(userId, row)), snapshot: committedState(userId, row.record_id) };
  });
}
export function cashSnapshot(userId: string, options: { limit?: number; offset?: number; currency?: string; snapshotRevision?: string } = {}) {
  const state = tradingSnapshot(userId);
  if (options.snapshotRevision && state.snapshotRevision !== options.snapshotRevision) throw conflict("资金流水已变化，请重新读取第一页");
  const currency = options.currency && isFundCurrency(options.currency) ? options.currency : undefined;
  const limit = options.limit ?? 100, offset = options.offset ?? 0;
  return { accountId: userId, snapshotRevision: state.snapshotRevision, asOf: state.asOf, ...state.cash,
    transactions: listFundTransactions(userId, limit, offset, currency), transactionSource: "stored_fund_ledger", ordersCashSource: "filled_trade_orders",
    pagination: { limit, offset, total: countFundTransactions(userId, currency) }, marketAllocationAvailable: false };
}
export function reconcileCash(userId: string, body: unknown, authorize: () => string) {
  const b = object(body, ["requestId", "accountId", "snapshotRevision", "currency", "balance", "note"]);
  if (b.accountId !== userId || typeof b.snapshotRevision !== "string" || !/^[a-f0-9]{64}$/.test(b.snapshotRevision) || typeof b.currency !== "string" || !isFundCurrency(b.currency) || typeof b.balance !== "number" || !Number.isFinite(b.balance) || Math.abs(b.balance) > 1e12 || b.note !== undefined && (typeof b.note !== "string" || b.note.length > 200)) throw new RecordsError("现金核对参数无效");
  const currency = b.currency;
  return mutation(userId, b, "reconcile_cash", authorize, () => {
    const state = tradingSnapshot(userId), before = state.cash.nativeBalancesByCurrency?.[currency];
    if (state.snapshotRevision !== b.snapshotRevision) throw conflict("账户已变化，请重新核对现金");
    if (!state.cash.sourceComplete || !Number.isFinite(before)) throw conflict("现有现金来源不完整，不能猜测调整差额");
    const delta = Number(b.balance) - before!;
    if (!Number.isFinite(delta) || Math.abs(delta) > 1e12) throw new RecordsError("现金调整差额超出上限");
    if (delta) createFundTransaction({ userId, currency, type: "adjustment", amount: Math.abs(delta), direction: delta > 0 ? 1 : -1, note: String(b.note ?? "API 现金核对") });
    const next = cashSnapshot(userId);
    return { ...next, transactions: undefined, currency, before, after: Number(b.balance), adjustment: delta };
  });
}
