import { createHash } from "node:crypto";
import { getDb } from "./db";
import { listRecords, readRecord } from "./store";
import { listOrders } from "./orders";
import { collectionRevision, RecordsError, validRecordRequestId } from "./recordsContract";
import { readAccountCash } from "./accountCashStore";
import { ACCOUNT_MARKET_CURRENCY, accountTotals, convertAccountAmount, reconcileAccountCash } from "./accountCash";
import { replayEconomicOrders } from "./portfolioLedger";
import type { Quote, StockRecord, TradeOrder } from "./types";

type Instrument = { user_id: string; record_id: string; market: string; code: string; kind: "cash_equity" | "etf" | "unknown"; listing_status: "listed" | "delisted" | "unknown"; revision: number; updated_at: string };
export function instrumentRows(userId: string) {
  return getDb().prepare("SELECT * FROM app_asset_instruments WHERE user_id=? ORDER BY record_id").all(userId) as Instrument[];
}
function declaration(record: StockRecord, rows: Instrument[]) {
  const stored = rows.find(row => row.record_id === record.id);
  const current = stored && stored.market === record.market && stored.code === record.code;
  return { kind: current ? stored.kind : "unknown", listingStatus: current ? stored.listing_status : "unknown",
    multiplier: current && stored.kind !== "unknown" ? 1 : null, underlyingRecordId: null,
    source: current ? "owner_declared" : "unavailable", revision: stored?.revision ?? 0,
    identityMatches: !!current, updatedAt: stored?.updated_at ?? null };
}
export function instrumentSnapshot(userId: string, recordId: string) {
  const record = readRecord(userId, recordId);
  if (!record) throw new RecordsError("持仓记录不存在", 404);
  return { recordId, recordRevision: record.revision, market: record.market, code: record.code, instrument: declaration(record, instrumentRows(userId)) };
}
export function assetOperation(userId: string, requestId: string) {
  validRecordRequestId(requestId);
  const row = getDb().prepare("SELECT result_json FROM app_asset_operations WHERE user_id=? AND request_id=?").get(userId, requestId) as { result_json: string } | undefined;
  if (!row) throw new RecordsError("未找到已提交回执", 404);
  return JSON.parse(row.result_json);
}
export function declareInstrument(userId: string, recordId: string, body: unknown, authorize: () => string) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new RecordsError("无效请求体");
  const b = body as Record<string, unknown>;
  if (Object.keys(b).some(key => !["requestId", "recordRevision", "revision", "kind", "listingStatus"].includes(key)) ||
      !Number.isSafeInteger(b.recordRevision) || Number(b.recordRevision) < 1 || !Number.isSafeInteger(b.revision) || Number(b.revision) < 0 ||
      typeof b.kind !== "string" || typeof b.listingStatus !== "string" || !["cash_equity", "etf", "unknown"].includes(String(b.kind)) || !["listed", "delisted", "unknown"].includes(String(b.listingStatus))) throw new RecordsError("证券声明参数无效；期权及衍生品尚不支持");
  const requestId = validRecordRequestId(b.requestId);
  return getDb().transaction(() => {
    if (authorize() !== userId) throw new RecordsError("连接已失效", 401);
    if (getDb().prepare("SELECT 1 FROM app_asset_operations WHERE user_id=? AND request_id=?").get(userId, requestId)) throw new RecordsError("requestId 已使用，请查询原回执", 409, 40901);
    const record = readRecord(userId, recordId), old = instrumentRows(userId).find(row => row.record_id === recordId);
    const error = !record ? new RecordsError("持仓记录不存在", 404) : record.revision !== b.recordRevision || (old?.revision ?? 0) !== b.revision ? new RecordsError("记录或证券声明已变化，请重新读取后确认", 409, 40902) : null;
    if (!error) getDb().prepare(`INSERT INTO app_asset_instruments(user_id,record_id,market,code,kind,listing_status,revision,updated_at) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(user_id,record_id) DO UPDATE SET market=excluded.market,code=excluded.code,kind=excluded.kind,listing_status=excluded.listing_status,revision=excluded.revision,updated_at=excluded.updated_at`)
      .run(userId, recordId, record!.market, record!.code, b.kind, b.listingStatus, Number(b.revision) + 1, new Date().toISOString());
    const result = { requestId, recordId, accountId: userId, state: error ? "failed" : "completed", code: error?.code ?? 0,
      message: error?.message ?? "ok", data: !error ? instrumentSnapshot(userId, recordId) : null, completedAt: new Date().toISOString() };
    getDb().prepare("INSERT INTO app_asset_operations VALUES(?,?,?)").run(userId, requestId, JSON.stringify(result));
    return { result, error };
  }).immediate();
}
const numeric = (n: unknown): number | null => typeof n === "number" && Number.isFinite(n) ? n : null;
const round = (n: number | null) => n === null || !Number.isFinite(n) ? null : +n.toFixed(2);
const close = (a: number, b: number) => Math.abs(a - b) <= 1e-7 * Math.max(1, Math.abs(a), Math.abs(b));
export const assetTimeZones: Record<string, string> = { US: "America/New_York", HK: "Asia/Hong_Kong", CN: "Asia/Shanghai", JP: "Asia/Tokyo", KR: "Asia/Seoul", SG: "Asia/Singapore", UK: "Europe/London", DE: "Europe/Berlin", FR: "Europe/Paris", AU: "Australia/Sydney", CA: "America/Toronto", IN: "Asia/Kolkata", BR: "America/Sao_Paulo", TW: "Asia/Taipei" };
export function assetLocalDate(at: string | number, market: string): string | null {
  const tz = assetTimeZones[market], date = new Date(at);
  if (!tz || !Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const part = (type: string) => parts.find(p => p.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
function sameIdentity(order: TradeOrder, record: StockRecord) { return order.market === record.market && order.code === record.code; }
function costs(record: StockRecord, all: TradeOrder[], verifiedSnapshotIds: Set<string>, orderRank: Map<string, number>) {
  const orders = all.filter(o => o.recordId === record.id && o.status === "filled");
  if (orders.some(o => !verifiedSnapshotIds.has(o.id) || !sameIdentity(o, record) || !Number.isFinite(Date.parse(o.tradedAt)))) return { average: null, cycleStartedAt: null, reason: "order_identity_or_time_mismatch" };
  const sorted = orders.sort((a, b) => Date.parse(a.tradedAt) - Date.parse(b.tradedAt) || a.createdAt.localeCompare(b.createdAt) || (orderRank.get(a.id)! - orderRank.get(b.id)!));
  // A nonzero opening snapshot may already be a diluted cost. Never invent its average basis.
  let start = -1;
  sorted.forEach((o, i) => { if (o.side === "buy" && o.positionQtyBefore === 0) start = i; });
  if (start < 0) return { average: null, cycleStartedAt: null, reason: "missing_zero_opening_cycle" };
  const cycle = sorted.slice(start), last = cycle[cycle.length - 1];
  let qty = 0;
  for (const order of cycle) {
    if (!close(qty, order.positionQtyBefore) || !Number.isFinite(order.fees) || order.fees < 0 || !close(order.amount, order.qty * order.price)) return { average: null, cycleStartedAt: null, reason: "incomplete_order_chain" };
    qty += order.side === "buy" ? order.qty : order.side === "sell" ? -order.qty : 0;
    if (!close(qty, order.positionQtyAfter)) return { average: null, cycleStartedAt: null, reason: "incomplete_order_chain" };
  }
  if (numeric(record.qty) === null || !close(qty, Number(record.qty)) || last.positionCostAfter === null || numeric(record.cost) === null || !close(last.positionCostAfter, Number(record.cost))) return { average: null, cycleStartedAt: null, reason: "position_not_reconciled" };
  const replay = replayEconomicOrders(cycle.map((o, i) => ({ ...o, tradedAt: new Date(o.tradedAt).toISOString(), createdAt: String(i).padStart(16, "0") })), { qty: 0, cost: 0 });
  return replay.complete && replay.averageCost !== null && close(replay.qty, qty) ? { average: replay.averageCost, cycleStartedAt: cycle[0].tradedAt, reason: null } : { average: null, cycleStartedAt: null, reason: "incomplete_order_chain" };
}
export type AssetOptions = { currency: string; costMethod: "diluted" | "average_open"; usPrice: "observed" | "regular" };
/** Caller holds one SQLite read transaction after all external I/O and live identity checks. */
export function buildAssets(userId: string, profile: { username: string; nickname: string; uid: string; avatar: string }, rates: Record<string, number>, quotes: Record<string, Quote>, options: AssetOptions, now = Date.now()) {
  const records = listRecords(userId), orders = listOrders(userId, "all", Number.MAX_SAFE_INTEGER), instruments = instrumentRows(userId), cash = readAccountCash(userId);
  const orderSource = getDb().prepare("SELECT id,position_qty_before,position_qty_after FROM trade_orders WHERE user_id=? ORDER BY traded_at,created_at,rowid").all(userId) as {id: string; position_qty_before: number | null; position_qty_after: number | null}[];
  const orderRank = new Map(orderSource.map((r, i) => [r.id, i]));
  const verifiedSnapshotIds = new Set(orderSource.filter(r => r.position_qty_before !== null && r.position_qty_after !== null).map(r => r.id));
  const asOf = new Date(now).toISOString(), nativeHoldings: Record<string, number> = {};
  const monetary = new Map<string, { market: number | null; cost: number | null; pnl: number | null; nativeMarket: number | null; nativePnl: number | null }>();
  const positions = records.map(record => {
    const instrument = declaration(record, instruments), currency = ACCOUNT_MARKET_CURRENCY[record.market] ?? null;
    const known = instrument.multiplier === 1, qty = numeric(record.qty), quote = quotes[record.id];
    const quotePrice = numeric(quote?.price) !== null && quote.price >= 0 ? quote.price : null, regularAllowed = record.market !== "US" || options.usPrice === "observed" || quote?.session === "REGULAR";
    const candidatePrice = regularAllowed ? quotePrice ?? (record.market !== "US" || options.usPrice === "observed" ? numeric(record.price) : null) : null;
    const price = candidatePrice !== null && candidatePrice >= 0 ? candidatePrice : null;
    const priceSource = price === null ? "unavailable" : quotePrice !== null ? "quote" : "record";
    const economic = costs(record, orders, verifiedSnapshotIds, orderRank), diluted = numeric(record.cost), cost = options.costMethod === "diluted" ? diluted : economic.average;
    const convert = (n: number | null) => n === null || !currency ? null : round(convertAccountAmount(n, currency, rates, options.currency));
    const nativeMarketValue = known && qty !== null && qty > 0 && price !== null && price >= 0 ? qty * price : qty === 0 ? 0 : null;
    if (currency && nativeMarketValue !== null && qty !== null && qty > 0) nativeHoldings[record.market] = (nativeHoldings[record.market] ?? 0) + nativeMarketValue;
    const nativeCost = known && qty !== null && qty > 0 && cost !== null ? qty * cost : qty === 0 ? 0 : null;
    const nativePnl = nativeMarketValue !== null && nativeCost !== null ? nativeMarketValue - nativeCost : null;
    const rawConvert = (n: number | null) => n === null || !currency ? null : numeric(convertAccountAmount(n, currency, rates, options.currency));
    monetary.set(record.id, { market: rawConvert(nativeMarketValue), cost: rawConvert(nativeCost), pnl: rawConvert(nativePnl), nativeMarket: nativeMarketValue, nativePnl });
    const related = orders.filter(o => o.recordId === record.id && o.status === "filled" && sameIdentity(o, record)).sort((a, b) => Date.parse(b.tradedAt) - Date.parse(a.tradedAt) || b.createdAt.localeCompare(a.createdAt) || (orderRank.get(b.id)! - orderRank.get(a.id)!));
    const last = related[0], clearedAt = last && verifiedSnapshotIds.has(last.id) && last.side === "sell" && last.positionQtyAfter === 0 && (qty === 0 || record.qty === "") ? last.tradedAt : null;
    return { recordId: record.id, recordRevision: record.revision, name: record.name, code: record.code, market: record.market, broker: record.group,
      currency, instrument, qty, price, priceSource, priceAt: price === null ? null : priceSource === "quote" ? quote.time : record.updatedAt,
      quoteSession: priceSource === "quote" ? quote.session ?? null : null, quoteSource: priceSource === "quote" ? quote.source ?? null : null,
      quoteCached: priceSource === "quote" ? quote.cached ?? false : false,
      cost: known ? cost : null, dilutedCost: known ? diluted : null, averageOpenCost: known ? economic.average : null,
      costMethod: options.costMethod, averageCostComplete: known && economic.average !== null,
      costUnavailableReason: !known ? "instrument_unclassified" : cost === null ? economic.reason ?? "missing_cost" : null,
      cycleStartedAt: known ? economic.cycleStartedAt : null,
      nativeMarketValue: round(nativeMarketValue), nativeCostValue: round(nativeCost), nativeHoldingPnl: round(nativePnl), valuationCurrency: options.currency, marketValue: convert(nativeMarketValue), costValue: convert(nativeCost),
      holdingPnl: convert(nativePnl), holdingPnlPct: nativePnl !== null && nativeCost !== null && nativeCost !== 0 ? round(nativePnl / Math.abs(nativeCost) * 100) : null,
      dayPnl: null, dayPnlPct: null, dayPnlUnavailableReason: "missing_verified_day_opening_position_and_cashflows",
      weightPct: null as number | null, clearedAt, clearedToday: clearedAt !== null && assetLocalDate(clearedAt, record.market) !== null && assetLocalDate(clearedAt, record.market) === assetLocalDate(now, record.market),
      active: qty !== null && qty !== 0, valuationComplete: nativeMarketValue !== null && convert(nativeMarketValue) !== null,
      rawRecord: record };
  });
  const active = positions.filter(p => p.active), holdingComplete = active.every(p => p.marketValue !== null), costComplete = active.every(p => p.costValue !== null);
  const totalMarket = holdingComplete ? active.reduce((n, p) => n + monetary.get(p.recordId)!.market!, 0) : null;
  const totalCost = costComplete ? active.reduce((n, p) => n + monetary.get(p.recordId)!.cost!, 0) : null;
  // Unknown units cannot safely be used in either equity-derived cash or legacy filled-order cash.
  const unitsComplete = orders.filter(o => o.status === "filled").every(o => positions.some(p => p.recordId === o.recordId && p.instrument.multiplier === 1 && p.currency !== null && p.market === o.market && p.code === o.code));
  const balances = reconcileAccountCash(cash.balances, cash.cardCash, cash.investmentEquities, nativeHoldings);
  const linkedComplete = cash.investmentEquities.every(e => !active.some(p => p.market === e.market && p.marketValue === null));
  const totals = accountTotals(totalMarket ?? Number.NaN, balances, rates, options.currency, holdingComplete, cash.sourceComplete && unitsComplete && linkedComplete);
  if (totalMarket !== null && totalMarket !== 0) for (const p of positions) if (p.marketValue !== null) p.weightPct = round(monetary.get(p.recordId)!.market! / totalMarket * 100);
  const todayOrders = orders.filter(o => assetLocalDate(o.tradedAt, o.market) !== null && assetLocalDate(o.tradedAt, o.market) === assetLocalDate(now, o.market)).map(o => {
    const raw = orderSource.find(r => r.id === o.id)!;
    return { ...o, positionQtyBefore: raw.position_qty_before, positionQtyAfter: raw.position_qty_after };
  });
  const markets = [...new Set([...active.map(p => p.market), ...todayOrders.map(o => o.market)])].sort().map(market => {
    const rows = active.filter(p => p.market === market), valid = rows.every(p => p.marketValue !== null), pnlValid = rows.every(p => p.holdingPnl !== null);
    const nativeValid = rows.every(p => p.nativeMarketValue !== null), nativePnlValid = rows.every(p => p.nativeHoldingPnl !== null);
    return { market, currency: ACCOUNT_MARKET_CURRENCY[market] ?? null, valuationCurrency: options.currency, nativeMarketValue: nativeValid ? round(rows.reduce((n, p) => n + monetary.get(p.recordId)!.nativeMarket!, 0)) : null, nativeHoldingPnl: nativePnlValid ? round(rows.reduce((n, p) => n + monetary.get(p.recordId)!.nativePnl!, 0)) : null, date: assetLocalDate(now, market), timeZone: assetTimeZones[market] ?? null,
      positionCount: rows.length, marketValue: valid ? round(rows.reduce((n, p) => n + monetary.get(p.recordId)!.market!, 0)) : null,
      holdingPnl: pnlValid ? round(rows.reduce((n, p) => n + monetary.get(p.recordId)!.pnl!, 0)) : null,
      cash: null, cashUnavailableReason: "currency_balances_not_allocated_to_markets", dayPnl: null, sessionStatus: "unknown" };
  });
  const data = { schemaVersion: 1, accountId: userId, profile: { accountId: userId, ...profile }, collectionRevision: collectionRevision(userId), asOf,
    currency: options.currency, options, summary: { totalMarket: round(totalMarket), totalCost: round(totalCost), holdingPnl: totalMarket !== null && totalCost !== null ? round(totalMarket - totalCost) : null,
      totalCash: round(totals.totalCash), totalAsset: round(totals.totalAsset), holdingsComplete: holdingComplete, costComplete, cashComplete: totals.cashComplete,
      totalAssetComplete: totals.totalAssetComplete, dayPnl: null, dayPnlPct: null, dayPnlUnavailableReason: "missing_verified_account_day_opening_nav", unconvertedCurrencies: [...new Set([...totals.unconvertedCurrencies, ...active.filter(p => !p.currency || !Number.isFinite(rates[p.currency]) || rates[p.currency] <= 0).map(p => p.currency ?? `UNKNOWN:${p.market}`)])].sort() },
    cash: { balancesByCurrency: totals.cashComplete ? balances : null, complete: totals.cashComplete, source: "account_cash_reconciliation", marketAllocationAvailable: false },
    markets, positions, todayOrders: { items: todayOrders, count: todayOrders.length, available: true, emptyReason: todayOrders.length ? null : "no_recorded_orders_today",
      dateBasis: "exchange_local_calendar_date", timeZones: assetTimeZones, unknownDateOrderIds: orders.filter(o => assetLocalDate(o.tradedAt, o.market) === null).map(o => o.id), settlesPendingOrders: false },
    unavailable: ["account_day_pnl", "position_day_pnl", "market_cash", "derivative_valuation", "underlying_merge", "verified_live_market_status"] };
  // asOf is observation time; unchanged economic inputs keep the same opaque revision.
  const revisionInput = { ...data, asOf: undefined, orders, cashSource: cash, instruments, rates, quotes };
  return { ...data, snapshotRevision: createHash("sha256").update(JSON.stringify(revisionInput)).digest("hex") };
}
