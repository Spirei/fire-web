import { randomBytes } from "node:crypto";
import PinyinMatch from "pinyin-match";
import { getDb } from "@/lib/db";
import { stockTitle } from "@/lib/stockTitle";

export type FundCurrency = "USD" | "EUR" | "HKD" | "CNY" | "JPY" | "KRW" | "SGD";
export type FundType = "opening" | "deposit" | "withdrawal" | "adjustment";
export interface FundTransaction {
  id: string; currency: FundCurrency; type: FundType; amount: number; direction: 1 | -1;
  note: string; occurredAt: string; createdAt: string; sourceOrderId: string | null;
  stockCode?: string | null; stockName?: string | null; stockMarket?: string | null;
}

interface Row {
  id: string; currency: FundCurrency; type: FundType; amount: number; direction: 1 | -1;
  note: string; occurred_at: string; created_at: string;
  stock_code?: string | null; stock_name?: string | null; stock_market?: string | null;
}
const AUTO_ORDER_PREFIX = "fund-order-";
const mapRow = (row: Row): FundTransaction => ({
  id: row.id, currency: row.currency, type: row.type, amount: Number(row.amount), direction: row.direction,
  note: row.note, occurredAt: row.occurred_at, createdAt: row.created_at,
  sourceOrderId: row.id.startsWith(AUTO_ORDER_PREFIX) ? row.id.slice(AUTO_ORDER_PREFIX.length) : null,
  stockCode: row.stock_code || null, stockName: row.stock_name || null, stockMarket: row.stock_market || null
});
const TYPE_SEARCH: Record<FundType, string[]> = {
  opening: ["期初", "期初资金", "opening", "初始"],
  deposit: ["转入", "入金", "deposit", "充值", "资金转入"],
  withdrawal: ["转出", "出金", "withdrawal", "资金转出"],
  adjustment: ["调整", "adjustment", "余额调整", "其他"]
};
const SIDE_SEARCH: Record<string, string[]> = {
  buy: ["买入", "买", "buy"],
  sell: ["卖出", "卖", "sell"],
  dividend: ["股息", "分红", "dividend"]
};
const MARKET_SEARCH: Record<string, string[]> = {
  US: ["美股", "us", "nasdaq", "nyse"],
  HK: ["港股", "hk", "香港"],
  CN: ["a股", "沪", "深", "京", "cn", "上证", "深证"],
  JP: ["日股", "jp", "日本"],
  KR: ["韩股", "kr", "韩国"],
  SG: ["新加坡", "sg"],
  EU: ["欧股", "eu"]
};

function compactQuery(query: string) {
  return query.trim().toLocaleLowerCase("zh-CN").replace(/\s+/g, "");
}

function codeVariants(code: string, market = ""): string[] {
  const raw = code.trim().toUpperCase().replace(/^(SH|SZ|BJ|HK)/, "");
  const variants = new Set([raw, raw.replace(/^0+/, "") || "0"]);
  if (market === "HK" || /^\d+$/.test(raw)) {
    const digits = raw.replace(/^0+/, "") || "0";
    variants.add(digits.padStart(4, "0"));
    variants.add(digits.padStart(5, "0"));
  }
  return [...variants].map((value) => value.toLowerCase());
}

function pinyinHit(text: string, query: string) {
  if (!text || !query) return false;
  try { return Boolean(PinyinMatch.match(text, query)); } catch { return false; }
}

function stockMatchesQuery(query: string, stock: { name: string; code: string; market: string }) {
  const q = compactQuery(query);
  if (!q) return false;
  const name = stock.name.toLocaleLowerCase("zh-CN");
  if (name.includes(q) || compactQuery(stock.name).includes(q)) return true;
  if (codeVariants(stock.code, stock.market).some((code) => code === q || (q.length >= 2 && (code.includes(q) || q.includes(code))))) return true;
  return pinyinHit(stock.name, q) || pinyinHit(stock.name, query.trim());
}

function tokenMatches(query: string, tokens: string[]) {
  const q = compactQuery(query);
  if (!q) return false;
  return tokens.some((token) => {
    const value = token.toLocaleLowerCase("zh-CN");
    return value === q || value.startsWith(q) || (q.length >= 2 && q.startsWith(value));
  });
}

function dateLikes(query: string): string[] {
  const q = query.trim();
  const likes: string[] = [];
  const cn = /^(\d{1,2})月(\d{1,2})日?$/.exec(q);
  if (cn) likes.push(`%-${cn[1].padStart(2, "0")}-${cn[2].padStart(2, "0")}%`);
  const dotted = /^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/.exec(q);
  if (dotted) likes.push(`%${dotted[1]}-${dotted[2].padStart(2, "0")}-${dotted[3].padStart(2, "0")}%`);
  return likes;
}

function fundQueryFilter(userId: string, query: string): { sql: string; args: Array<string | number> } {
  const raw = query.trim();
  if (!raw) return { sql: "", args: [] };
  const like = `%${raw}%`;
  const sqlParts = ["f.note LIKE ?", "f.occurred_at LIKE ?", "f.currency LIKE ?"];
  const args: Array<string | number> = [like, like, `%${raw.toUpperCase()}%`];
  dateLikes(raw).forEach((value) => { sqlParts.push("f.occurred_at LIKE ?"); args.push(value); });
  (Object.entries(TYPE_SEARCH) as [FundType, string[]][]).forEach(([type, tokens]) => {
    if (tokenMatches(raw, tokens)) { sqlParts.push("f.type = ?"); args.push(type); }
  });
  const db = getDb();
  const orders = db.prepare("SELECT id,name,code,market,side FROM trade_orders WHERE user_id=? AND status='filled'").all(userId) as Array<{ id: string; name: string; code: string; market: string; side: string }>;
  orders.forEach((order) => {
    if (stockMatchesQuery(raw, order) || tokenMatches(raw, SIDE_SEARCH[order.side] || []) || tokenMatches(raw, MARKET_SEARCH[order.market.toUpperCase()] || [order.market])) {
      sqlParts.push("f.id = ?");
      args.push(`${AUTO_ORDER_PREFIX}${order.id}`);
    }
  });
  const manuals = db.prepare("SELECT id,note FROM fund_transactions WHERE user_id=? AND id NOT LIKE ?").all(userId, `${AUTO_ORDER_PREFIX}%`) as Array<{ id: string; note: string }>;
  manuals.forEach((row) => {
    if (row.note && pinyinHit(row.note, compactQuery(raw))) { sqlParts.push("f.id = ?"); args.push(row.id); }
  });
  return { sql: ` AND (${sqlParts.join(" OR ")})`, args };
}

const FUND_SELECT = `SELECT f.id,f.currency,f.type,f.amount,f.direction,f.note,f.occurred_at,f.created_at,o.code AS stock_code,o.name AS stock_name,o.market AS stock_market FROM fund_transactions f LEFT JOIN trade_orders o ON o.user_id=f.user_id AND f.id = ? || o.id`;

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
    .run(id, order.user_id, settlementCurrency(order.market), "adjustment", Math.abs(signed), signed > 0 ? 1 : -1, `${action} ${stockTitle(order.name, order.code)} · 订单自动记账`.slice(0, 200), order.traded_at, order.created_at);
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
  const filter = fundQueryFilter(userId, query);
  const sql = `${FUND_SELECT} WHERE f.user_id=?${currency ? " AND f.currency=?" : ""}${filter.sql} ORDER BY f.occurred_at DESC,f.created_at DESC LIMIT ? OFFSET ?`;
  const args: Array<string | number> = [AUTO_ORDER_PREFIX, userId];
  if (currency) args.push(currency);
  args.push(...filter.args, limit, offset);
  return (db.prepare(sql).all(...args) as Row[]).map(mapRow);
}
export function countFundTransactions(userId: string, currency?: FundCurrency, query = "") {
  const filter = fundQueryFilter(userId, query);
  const sql = `SELECT COUNT(*) count FROM fund_transactions f WHERE f.user_id=?${currency ? " AND f.currency=?" : ""}${filter.sql}`;
  const args: Array<string | number> = [userId];
  if (currency) args.push(currency);
  args.push(...filter.args);
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
  // 旧持仓/导入订单通常没有与之对应的期初入金。此时历史买入从 0 倒扣会产生
  // 虚构的负现金。必须逐笔应用 0 下限：若只在所有流水求和后截断，早期未知本金
  // 造成的负数会吞掉后来真实的卖出回款。系统尚未支持融资负债，因此每个币种
  // 按发生时间维护“已知可用现金”；用户补录期初资金后仍会自然得到完整余额。
  const rows = getDb().prepare("SELECT currency,amount,direction FROM fund_transactions WHERE user_id=? ORDER BY currency,occurred_at,created_at,id").all(userId) as { currency: FundCurrency; amount: number; direction: 1 | -1 }[];
  rows.forEach((row) => {
    const delta = (Number(row.amount) || 0) * Number(row.direction);
    result[row.currency] = Math.max(0, result[row.currency] + delta);
  });
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
