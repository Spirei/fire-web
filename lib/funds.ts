import { randomBytes } from "node:crypto";
import { getDb } from "@/lib/db";

export type FundCurrency = "USD" | "EUR" | "HKD" | "CNY" | "JPY" | "KRW" | "SGD";
export type FundType = "opening" | "deposit" | "withdrawal" | "adjustment";
export interface FundTransaction {
  id: string; currency: FundCurrency; type: FundType; amount: number; direction: 1 | -1;
  note: string; occurredAt: string; createdAt: string; sourceOrderId: string | null;
}

interface Row { id: string; currency: FundCurrency; type: FundType; amount: number; direction: 1 | -1; note: string; occurred_at: string; created_at: string }
const AUTO_ORDER_PREFIX = "fund-order-";
const mapRow = (row: Row): FundTransaction => ({ id: row.id, currency: row.currency, type: row.type, amount: Number(row.amount), direction: row.direction, note: row.note, occurredAt: row.occurred_at, createdAt: row.created_at, sourceOrderId: row.id.startsWith(AUTO_ORDER_PREFIX) ? row.id.slice(AUTO_ORDER_PREFIX.length) : null });

interface FilledOrderCashRow {
  id: string; user_id: string; market: string; code: string; name: string; side: "buy" | "sell" | "dividend";
  qty: number; price: number; fees: number; amount: number; traded_at: string; created_at: string;
}

function settlementCurrency(market: string): FundCurrency {
  const key = market.trim().toUpperCase();
  if (["HK", "HKG"].includes(key)) return "HKD";
  if (["CN", "SH", "SZ", "A"].includes(key)) return "CNY";
  if (["JP", "JPN"].includes(key)) return "JPY";
  if (["KR", "KOR"].includes(key)) return "KRW";
  if (["SG", "SGP"].includes(key)) return "SGD";
  if (["EU", "EUR"].includes(key)) return "EUR";
  return "USD";
}

function writeOrderCashTransaction(order: FilledOrderCashRow) {
  const db = getDb();
  const id = `${AUTO_ORDER_PREFIX}${order.id}`;
  const gross = Number(order.amount) > 0 ? Number(order.amount) : Number(order.qty) * Number(order.price);
  const fees = Math.max(0, Number(order.fees) || 0);
  const signed = order.side === "buy" ? -(gross + fees) : gross - fees;
  db.prepare("DELETE FROM fund_transactions WHERE id=? AND user_id=?").run(id, order.user_id);
  if (!Number.isFinite(signed) || Math.abs(signed) < 0.00000001) return;
  const action = order.side === "buy" ? "买入" : order.side === "sell" ? "卖出" : "股息";
  db.prepare("INSERT INTO fund_transactions (id,user_id,currency,type,amount,direction,note,occurred_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(id, order.user_id, settlementCurrency(order.market), "adjustment", Math.abs(signed), signed > 0 ? 1 : -1, `${action} ${order.name || order.code} · 订单自动记账`.slice(0, 200), order.traded_at, order.created_at);
}

/** 将一笔订单精确同步到现金账；待成交、撤销、删除订单不会留下现金流水。 */
export function syncOrderCashTransaction(userId: string, orderId: string) {
  const db = getDb();
  const order = db.prepare("SELECT id,user_id,market,code,name,side,qty,price,fees,amount,traded_at,created_at FROM trade_orders WHERE id=? AND user_id=? AND status='filled'").get(orderId, userId) as FilledOrderCashRow | undefined;
  if (order) writeOrderCashTransaction(order);
  else db.prepare("DELETE FROM fund_transactions WHERE id=? AND user_id=?").run(`${AUTO_ORDER_PREFIX}${orderId}`, userId);
}

/** 为历史订单补齐现金账，同时清理已经删除或撤销的订单流水。 */
export function syncOrderCashTransactions(userId: string) {
  const db = getDb();
  const orders = db.prepare("SELECT id,user_id,market,code,name,side,qty,price,fees,amount,traded_at,created_at FROM trade_orders WHERE user_id=? AND status='filled'").all(userId) as FilledOrderCashRow[];
  db.transaction(() => {
    db.prepare("DELETE FROM fund_transactions WHERE user_id=? AND id LIKE ?").run(userId, `${AUTO_ORDER_PREFIX}%`);
    orders.forEach(writeOrderCashTransaction);
  })();
}

/** 常规读取只做 O(1) 数量校验；仅首次接入或数据不一致时才全量重建。 */
export function ensureOrderCashTransactions(userId: string) {
  const db = getDb();
  const filled = db.prepare("SELECT COUNT(*) count FROM trade_orders WHERE user_id=? AND status='filled'").get(userId) as { count: number };
  const linked = db.prepare("SELECT COUNT(*) count FROM fund_transactions WHERE user_id=? AND id LIKE ?").get(userId, `${AUTO_ORDER_PREFIX}%`) as { count: number };
  if (Number(filled.count) !== Number(linked.count)) syncOrderCashTransactions(userId);
}

export function listFundTransactions(userId: string, limit = 40, offset = 0, currency?: FundCurrency, query = "") {
  const db = getDb();
  const keyword = `%${query.trim()}%`;
  const search = query.trim() ? " AND (note LIKE ? OR occurred_at LIKE ?)" : "";
  const sql = `SELECT id,currency,type,amount,direction,note,occurred_at,created_at FROM fund_transactions WHERE user_id=?${currency ? " AND currency=?" : ""}${search} ORDER BY occurred_at DESC,created_at DESC LIMIT ? OFFSET ?`;
  const args: Array<string | number> = [userId];
  if (currency) args.push(currency);
  if (query.trim()) args.push(keyword, keyword);
  args.push(limit, offset);
  const rows = db.prepare(sql).all(...args);
  return (rows as Row[]).map(mapRow);
}
export function countFundTransactions(userId: string, currency?: FundCurrency, query = "") {
  const keyword = `%${query.trim()}%`;
  const search = query.trim() ? " AND (note LIKE ? OR occurred_at LIKE ?)" : "";
  const sql = `SELECT COUNT(*) count FROM fund_transactions WHERE user_id=?${currency ? " AND currency=?" : ""}${search}`;
  const args: string[] = [userId];
  if (currency) args.push(currency);
  if (query.trim()) args.push(keyword, keyword);
  const row = getDb().prepare(sql).get(...args);
  return Number((row as { count?: number } | undefined)?.count) || 0;
}
export function fundSummaries(userId: string) {
  const empty = () => ({ openingAsset: 0, cashNetFlow: 0, stockNetFlow: 0, otherNetFlow: 0 });
  const result: Record<FundCurrency, ReturnType<typeof empty>> = { USD: empty(), EUR: empty(), HKD: empty(), CNY: empty(), JPY: empty(), KRW: empty(), SGD: empty() };
  const rows = getDb().prepare(`SELECT currency,
    SUM(CASE WHEN type='opening' THEN amount*direction ELSE 0 END) opening_asset,
    SUM(CASE WHEN type IN ('deposit','withdrawal') THEN amount*direction ELSE 0 END) cash_net_flow,
    SUM(CASE WHEN id LIKE 'fund-order-%' THEN amount*direction ELSE 0 END) stock_net_flow,
    SUM(CASE WHEN type='adjustment' AND id NOT LIKE 'fund-order-%' THEN amount*direction ELSE 0 END) other_net_flow
    FROM fund_transactions WHERE user_id=? GROUP BY currency`).all(userId) as { currency: FundCurrency; opening_asset: number; cash_net_flow: number; stock_net_flow: number; other_net_flow: number }[];
  rows.forEach((row) => { result[row.currency] = { openingAsset: Number(row.opening_asset) || 0, cashNetFlow: Number(row.cash_net_flow) || 0, stockNetFlow: Number(row.stock_net_flow) || 0, otherNetFlow: Number(row.other_net_flow) || 0 }; });
  return result;
}
export function fundBalances(userId: string): Record<FundCurrency, number> {
  const result: Record<FundCurrency, number> = { USD: 0, EUR: 0, HKD: 0, CNY: 0, JPY: 0, KRW: 0, SGD: 0 };
  const rows = getDb().prepare("SELECT currency,SUM(amount*direction) balance FROM fund_transactions WHERE user_id=? GROUP BY currency").all(userId) as { currency: FundCurrency; balance: number }[];
  // 旧持仓/导入订单通常没有与之对应的期初入金。此时历史买入从 0 倒扣会产生
  // 虚构的负现金，并跨币种抵消后来已确认的卖出回款。系统尚未支持融资负债，
  // 因此可用现金采用“已知下限”：每个币种最低为 0；用户补录期初资金后自然恢复完整余额。
  rows.forEach((row) => { result[row.currency] = Math.max(0, Number(row.balance) || 0); });
  return result;
}
export function createFundTransaction(input: { userId: string; currency: FundCurrency; type: FundType; amount: number; direction: 1 | -1; note?: string; occurredAt?: string }) {
  const now = new Date().toISOString();
  const id = `fund-${randomBytes(12).toString("hex")}`;
  getDb().prepare("INSERT INTO fund_transactions (id,user_id,currency,type,amount,direction,note,occurred_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(id, input.userId, input.currency, input.type, input.amount, input.direction, input.note || "", input.occurredAt || now, now);
  return listFundTransactions(input.userId, 1)[0];
}
export function deleteFundTransaction(userId: string, id: string) {
  if (id.startsWith(AUTO_ORDER_PREFIX)) return false;
  return getDb().prepare("DELETE FROM fund_transactions WHERE id=? AND user_id=?").run(id, userId).changes > 0;
}
