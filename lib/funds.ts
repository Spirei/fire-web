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

export function listFundTransactions(userId: string, limit = 200) {
  return (getDb().prepare("SELECT id,currency,type,amount,direction,note,occurred_at,created_at FROM fund_transactions WHERE user_id=? ORDER BY occurred_at DESC,created_at DESC LIMIT ?").all(userId, limit) as Row[]).map(mapRow);
}
export function fundBalances(userId: string): Record<FundCurrency, number> {
  const result: Record<FundCurrency, number> = { USD: 0, EUR: 0, HKD: 0, CNY: 0, JPY: 0, KRW: 0, SGD: 0 };
  const rows = getDb().prepare("SELECT currency,SUM(amount*direction) balance FROM fund_transactions WHERE user_id=? GROUP BY currency").all(userId) as { currency: FundCurrency; balance: number }[];
  rows.forEach((row) => { result[row.currency] = Number(row.balance) || 0; });
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
