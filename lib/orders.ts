import { randomBytes } from "crypto";
import { getDb } from "./db";
import { applyOrder } from "./tradeAccounting";
import { generateOrderNo } from "./orderNo";
import { replayEconomicOrders } from "./portfolioLedger";
import { syncOrderCashTransaction } from "./funds";
import { fetchQuotes } from "./quotes";
import { parseMarket } from "./store";
import type { OrderSide, OrderType, OrderValidity, TradeOrder } from "./types";

type OrderRow = Record<string, unknown>;
const ORDER_TYPES = new Set<OrderType>(["limit", "market", "trigger_buy", "trigger_sell", "rebound_buy", "rebound_sell"]);
const ORDER_VALIDITIES = new Set<OrderValidity>(["day", "gtc", "custom"]);

function rowToOrder(row: OrderRow): TradeOrder {
  return {
    id: String(row.id),
    orderNo: String(row.order_no || ""),
    recordId: String(row.record_id),
    market: String(row.market),
    code: String(row.code),
    name: String(row.name),
    side: row.side as OrderSide,
    status: row.status as TradeOrder["status"],
    qty: Number(row.qty),
    price: Number(row.price),
    fees: Number(row.fees),
    amount: Number(row.amount),
    realizedPnl: row.realized_pnl == null ? null : Number(row.realized_pnl),
    positionQtyBefore: Number(row.position_qty_before),
    positionCostBefore: row.position_cost_before == null ? null : Number(row.position_cost_before),
    positionQtyAfter: Number(row.position_qty_after),
    positionCostAfter: row.position_cost_after == null ? null : Number(row.position_cost_after),
    broker: String(row.broker || ""),
    note: String(row.note || ""),
    orderType: (row.order_type as OrderType) || "limit",
    triggerPrice: row.trigger_price == null ? null : Number(row.trigger_price),
    tif: (row.tif as OrderValidity) || "day",
    expiresAt: row.expires_at == null ? null : String(row.expires_at),
    session: String(row.session || ""),
    triggerStatus: String(row.trigger_status || ""),
    tradedAt: String(row.traded_at),
    createdAt: String(row.created_at)
  };
}

/** 位置快照继续使用券商摊薄成本；订单的已实现盈亏另按经济成本账本统一回放。 */
export function refreshEconomicRealizedPnl(userId: string, recordId: string) {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM trade_orders WHERE user_id = ? AND record_id = ? AND status = 'filled' ORDER BY traded_at ASC, created_at ASC")
    .all(userId, recordId) as OrderRow[];
  if (rows.length === 0) return;
  const orders = rows.map(rowToOrder);
  const first = orders[0];
  const replay = replayEconomicOrders(orders, {
    qty: Number(first.positionQtyBefore) || 0,
    cost: first.positionCostBefore
  });
  const update = db.prepare("UPDATE trade_orders SET realized_pnl = ? WHERE id = ?");
  for (const order of orders) update.run(replay.realizedByOrder.get(order.id) ?? null, order.id);
}

/** 生成不冲突的唯一订单号（DB 唯一索引兜底，最多重试 5 次）。 */
function nextOrderNo(): string {
  const db = getDb();
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generateOrderNo();
    const exists = db.prepare("SELECT 1 FROM trade_orders WHERE order_no = ?").get(candidate);
    if (!exists) return candidate;
  }
  throw new Error("订单号生成冲突，请重试");
}

export function listOrders(
  userId: string,
  scope: "today" | "history" | "all",
  limit = 200,
  recordId?: string,
  market?: string,
  status?: string
): TradeOrder[] {
  const db = getDb();
  const conditions: string[] = ["user_id = ?"];
  const params: Array<string | number> = [userId];
  if (recordId) {
    conditions.push("record_id = ?");
    params.push(recordId);
  }
  if (market && market !== "ALL") {
    conditions.push("UPPER(market) = ?");
    params.push(market.toUpperCase());
  }
  if (status && status !== "all") {
    conditions.push("status = ?");
    params.push(status);
  }
  const rows = db.prepare(`SELECT * FROM trade_orders WHERE ${conditions.join(" AND ")} ORDER BY traded_at DESC, created_at DESC`).all(...params) as OrderRow[];
  const now = Date.now();
  return rows.map(rowToOrder).filter((order) => {
    if (scope === "all") return true;
    const orderDay = exchangeDate(order.tradedAt, order.market);
    const today = exchangeDate(now, order.market);
    return scope === "today" ? orderDay === today : orderDay < today;
  }).slice(0, limit);
}

export function executeOrder(input: {
  userId: string;
  recordId: string;
  side: OrderSide;
  qty: number;
  price: number;
  fees: number;
  tradedAt?: string;
  note?: string;
  orderType?: OrderType;
  triggerPrice?: number | null;
  tif?: OrderValidity;
  expiresAt?: string | null;
  session?: string;
  triggerStatus?: string;
}): { order: TradeOrder; position: { qty: number; cost: number | null } } {
  const db = getDb();
  const orderType = input.orderType || "limit";
  const tif = input.tif || "day";
  const session = String(input.session || "");
  const triggerStatus = String(input.triggerStatus || "");
  const triggerPrice = input.triggerPrice == null ? null : Number(input.triggerPrice);
  const expiresAt = input.expiresAt && !Number.isNaN(Date.parse(input.expiresAt)) ? new Date(input.expiresAt).toISOString() : null;
  const run = db.transaction(() => {
    const record = db.prepare("SELECT * FROM records WHERE id = ? AND user_id = ?").get(input.recordId, input.userId) as OrderRow | undefined;
    if (!record) throw new Error("持仓记录不存在");
    const oldQty = Number(record.qty || 0);
    const oldCost = Number(record.cost || 0);
    if (input.side === "sell" && input.qty > oldQty + 1e-10) throw new Error(`可卖数量不足，当前最多 ${oldQty}`);

    const calculated = applyOrder(
      { qty: oldQty, cost: oldCost },
      { side: input.side, qty: input.qty, price: input.price, fees: input.fees }
    );
    const nextQty = calculated.qty;
    const nextCost = nextQty > 0 ? calculated.cost : null;
    const realizedPnl = calculated.realizedPnl;

    const now = new Date().toISOString();
    const tradedAt = input.tradedAt && !Number.isNaN(Date.parse(input.tradedAt)) ? new Date(input.tradedAt).toISOString() : now;
    const id = "o-" + randomBytes(8).toString("hex");
    const orderNo = nextOrderNo();
    db.prepare(`
      INSERT INTO trade_orders
      (id,order_no,user_id,record_id,market,code,name,side,status,qty,price,fees,amount,realized_pnl,position_qty_before,position_cost_before,position_qty_after,position_cost_after,broker,note,order_type,trigger_price,tif,expires_at,session,trigger_status,traded_at,created_at)
      VALUES (?,?,?,?,?,?,?,?,'filled',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      id, orderNo, input.userId, input.recordId, String(record.market), String(record.code), String(record.name), input.side,
      input.qty, input.price, input.fees, input.qty * input.price, realizedPnl, oldQty, oldCost, nextQty, nextCost,
      String(record.group_name || ""), String(input.note || "").slice(0, 500),
      orderType, triggerPrice, tif, expiresAt, session, triggerStatus,
      tradedAt, now
    );
    db.prepare("UPDATE records SET qty = ?, cost = ?, updated_at = ? WHERE id = ? AND user_id = ?")
      .run(nextQty || null, nextCost, now, input.recordId, input.userId);
    refreshEconomicRealizedPnl(input.userId, input.recordId);
    syncOrderCashTransaction(input.userId, id);
    const order = db.prepare("SELECT * FROM trade_orders WHERE id = ?").get(id) as OrderRow;
    return { order: rowToOrder(order), position: { qty: nextQty, cost: nextCost } };
  });
  return run();
}

/** 判断某挂单在当前行情价下是否应触发成交。 */
function shouldFill(order: { side: OrderSide; orderType: OrderType; price: number; triggerPrice: number | null }, live: number): boolean {
  const tp = order.triggerPrice ?? order.price;
  switch (order.orderType) {
    case "limit":
      return order.side === "buy" ? live <= order.price : live >= order.price;
    case "trigger_buy":
      return live <= tp;
    case "trigger_sell":
      return live >= tp;
    case "rebound_buy":
      return live >= tp;
    case "rebound_sell":
      return live <= tp;
    default:
      return false;
  }
}

/** 把一笔 pending 挂单按行情价成交（原子，含持仓更新）；返回是否成功。 */
function fillPendingRow(row: OrderRow, fillPrice: number): boolean {
  const db = getDb();
  return db.transaction(() => {
    const still = db.prepare("SELECT status FROM trade_orders WHERE id = ?").get(String(row.id)) as { status: string } | undefined;
    if (!still || still.status !== "pending") return false;
    const userId = String(row.user_id);
    const record = db.prepare("SELECT * FROM records WHERE id = ? AND user_id = ?").get(String(row.record_id), userId) as OrderRow | undefined;
    if (!record) {
      db.prepare("UPDATE trade_orders SET status='expired', trigger_status='标的不存在' WHERE id=? AND status='pending'").run(String(row.id));
      return false;
    }
    const side = row.side as OrderSide;
    const qty = Number(row.qty);
    const oldQty = Number(record.qty || 0);
    const oldCost = Number(record.cost || 0);
    if (side === "sell" && qty > oldQty + 1e-10) {
      db.prepare("UPDATE trade_orders SET status='expired', trigger_status='可卖不足' WHERE id=? AND status='pending'").run(String(row.id));
      return false;
    }
    const calculated = applyOrder({ qty: oldQty, cost: oldCost }, { side, qty, price: fillPrice, fees: Number(row.fees || 0) });
    const nextQty = calculated.qty;
    const nextCost = nextQty > 0 ? calculated.cost : null;
    const now = new Date().toISOString();
    db.prepare(`UPDATE trade_orders SET status='filled', amount=?, price=?, realized_pnl=?, position_qty_before=?, position_cost_before=?, position_qty_after=?, position_cost_after=?, traded_at=?, trigger_status='已触发' WHERE id=? AND status='pending'`)
      .run(qty * fillPrice, fillPrice, calculated.realizedPnl, oldQty, oldCost, nextQty, nextCost, now, String(row.id));
    db.prepare("UPDATE records SET qty=?, cost=?, updated_at=? WHERE id=? AND user_id=?")
      .run(nextQty || null, nextCost, now, String(row.record_id), userId);
    refreshEconomicRealizedPnl(userId, String(row.record_id));
    syncOrderCashTransaction(userId, String(row.id));
    return true;
  })();
}

const lastSettle = new Map<string, number>();
const SETTLE_MIN_INTERVAL = 12_000;

function exchangeDate(value: string | number, market: string) {
  const timeZone = market.toUpperCase() === "US" ? "America/New_York"
    : market.toUpperCase() === "HK" ? "Asia/Hong_Kong"
      : market.toUpperCase() === "JP" ? "Asia/Tokyo"
        : market.toUpperCase() === "KR" ? "Asia/Seoul"
          : "Asia/Shanghai";
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
}

/** 惰性结算挂单：拉取挂单标的现价，命中触发价则成交，超期/失效则标记过期。 */
export async function settlePendingOrders(userId: string): Promise<{ checked: number; filled: number; expired: number }> {
  const db = getDb();
  const pending = db.prepare("SELECT * FROM trade_orders WHERE user_id = ? AND status = 'pending'").all(userId) as OrderRow[];
  if (pending.length === 0) return { checked: 0, filled: 0, expired: 0 };
  const last = lastSettle.get(userId) || 0;
  if (Date.now() - last < SETTLE_MIN_INTERVAL) return { checked: 0, filled: 0, expired: 0 };
  lastSettle.set(userId, Date.now());

  const now = Date.now();
  let quotes: Record<string, { price: number }> = {};
  try {
    quotes = await fetchQuotes(
      pending.map((o) => ({ id: String(o.id), market: parseMarket(String(o.market)), code: String(o.code).trim() }))
    );
  } catch {
    quotes = {};
  }

  let checked = 0;
  let filled = 0;
  let expired = 0;
  for (const o of pending) {
    const order = rowToOrder(o);
    const customExpired = order.tif === "custom" && order.expiresAt
      ? /^\d{4}-\d{2}-\d{2}$/.test(order.expiresAt)
        ? exchangeDate(now, order.market) > order.expiresAt
        : now > Date.parse(order.expiresAt)
      : false;
    const dayExpired = order.tif === "day" && exchangeDate(now, order.market) > exchangeDate(order.createdAt, order.market);
    if (customExpired || dayExpired) {
      db.prepare("UPDATE trade_orders SET status='expired', trigger_status='已失效' WHERE id=? AND status='pending'").run(order.id);
      expired++;
      continue;
    }
    const q = quotes[order.id];
    if (!q || !Number.isFinite(q.price) || q.price <= 0) continue;
    checked++;
    if (shouldFill(order, q.price)) {
      if (fillPendingRow(o, q.price)) filled++;
    }
  }
  return { checked, filled, expired };
}

/** 创建订单：历史成交记录直接入账；实时委托仅市价单立即成交，其余等待行情触发。 */
export function placeOrder(input: {
  userId: string;
  recordId: string;
  side: OrderSide;
  qty: number;
  price: number;
  fees: number;
  tradedAt?: string;
  orderType?: OrderType;
  tif?: OrderValidity;
  expiresAt?: string | null;
  session?: string;
  note?: string;
  mode?: "record" | "order";
}): { order: TradeOrder; position: { qty: number; cost: number | null }; pending: boolean } {
  const orderType = input.orderType || "limit";
  const tif = input.tif || "day";
  if (!ORDER_TYPES.has(orderType)) throw new Error("不支持的订单类型");
  if (!ORDER_VALIDITIES.has(tif)) throw new Error("不支持的订单有效期");
  const session = String(input.session || "");
  const rawExpiry = String(input.expiresAt || "").trim();
  const expiresAt = /^\d{4}-\d{2}-\d{2}$/.test(rawExpiry)
    ? rawExpiry
    : rawExpiry && !Number.isNaN(Date.parse(rawExpiry)) ? new Date(rawExpiry).toISOString() : null;
  // 旧版持仓详情没有 mode/orderType，语义一直是“补录已成交”，保持兼容。
  const mode = input.mode ?? (input.orderType ? "order" : "record");
  if (mode === "record") {
    const legacyRecord = input.mode == null && input.orderType == null;
    const tradedAt = input.tradedAt ? Date.parse(input.tradedAt) : legacyRecord ? Date.now() : NaN;
    if (!Number.isFinite(tradedAt)) throw new Error("请选择有效的成交时间");
    if (tradedAt > Date.now() + 60_000) throw new Error("成交时间不能晚于当前时间");
    const res = executeOrder({ ...input, tradedAt: new Date(tradedAt).toISOString(), orderType, tif, session, expiresAt, triggerStatus: legacyRecord ? "兼容成交" : "手工记录" });
    return { ...res, pending: false };
  }
  if (tif === "custom") {
    if (!expiresAt) throw new Error("请选择有效期");
    const recordMarket = String((getDb().prepare("SELECT market FROM records WHERE id = ? AND user_id = ?").get(input.recordId, input.userId) as OrderRow | undefined)?.market || "CN");
    const expired = /^\d{4}-\d{2}-\d{2}$/.test(expiresAt)
      ? expiresAt < exchangeDate(Date.now(), recordMarket)
      : Date.parse(expiresAt) <= Date.now();
    if (expired) throw new Error("有效期不能早于今天");
  }
  const pending = orderType !== "market";
  if (!pending) {
    const res = executeOrder({ ...input, orderType, tif, session, expiresAt, triggerStatus: "已成交" });
    return { ...res, pending: false };
  }

  const db = getDb();
  const record = db.prepare("SELECT * FROM records WHERE id = ? AND user_id = ?").get(input.recordId, input.userId) as OrderRow | undefined;
  if (!record) throw new Error("持仓记录不存在");
  const oldQty = Number(record.qty || 0);
  const oldCost = Number(record.cost || 0);
  if (input.side === "sell" && input.qty > oldQty + 1e-10) throw new Error(`可卖数量不足，当前最多 ${oldQty}`);
  const now = new Date().toISOString();
  const id = "o-" + randomBytes(8).toString("hex");
  const orderNo = nextOrderNo();
  const triggerPrice = orderType === "limit" ? null : Number(input.price);
  db.prepare(`
    INSERT INTO trade_orders
    (id,order_no,user_id,record_id,market,code,name,side,status,qty,price,fees,amount,realized_pnl,position_qty_before,position_cost_before,position_qty_after,position_cost_after,broker,note,order_type,trigger_price,tif,expires_at,session,trigger_status,traded_at,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id, orderNo, input.userId, input.recordId, String(record.market), String(record.code), String(record.name), input.side,
    "pending", input.qty, input.price, input.fees, input.qty * input.price, null,
    oldQty, oldCost, oldQty, oldCost,
    String(record.group_name || ""), String(input.note || "").slice(0, 500),
    orderType, triggerPrice, tif, expiresAt, session,
    "未触发", now, now
  );
  const order = db.prepare("SELECT * FROM trade_orders WHERE id = ?").get(id) as OrderRow;
  return { order: rowToOrder(order), position: { qty: oldQty, cost: oldCost || null }, pending: true };
}

/** 撤掉一笔待成交挂单。 */
export function cancelOrder(input: { userId: string; orderId: string }): TradeOrder {
  const db = getDb();
  const row = db.prepare("SELECT * FROM trade_orders WHERE id = ? AND user_id = ?").get(input.orderId, input.userId) as OrderRow | undefined;
  if (!row) throw new Error("订单不存在");
  if (String(row.status) !== "pending") throw new Error("仅待成交的挂单可撤单");
  db.prepare("UPDATE trade_orders SET status='cancelled', trigger_status='已撤销' WHERE id=? AND user_id=? AND status='pending'").run(input.orderId, input.userId);
  const updated = db.prepare("SELECT * FROM trade_orders WHERE id = ?").get(input.orderId) as OrderRow;
  return rowToOrder(updated);
}

function positionBeforeFirstOrder(first: TradeOrder): { qty: number; cost: number } {
  if (Number.isFinite(first.positionQtyBefore) && first.positionCostBefore != null && Number.isFinite(first.positionCostBefore)) {
    return { qty: first.positionQtyBefore, cost: first.positionCostBefore };
  }
  if (first.side === "dividend") {
    return { qty: Math.max(0, first.positionQtyBefore || 0), cost: first.positionCostBefore ?? 0 };
  }
  if (first.side === "buy") {
    const qty = Math.max(0, first.positionQtyAfter - first.qty);
    const totalAfter = first.positionQtyAfter * (first.positionCostAfter ?? 0);
    const totalBefore = totalAfter - first.qty * first.price - first.fees;
    return { qty, cost: qty > 0 ? totalBefore / qty : 0 };
  }
  return { qty: first.positionQtyAfter + first.qty, cost: first.positionCostAfter ?? 0 };
}

/** 更正已成交订单，并从第一笔订单起重放账本，保证订单快照与当前持仓一致。 */
export function updateOrder(input: {
  userId: string;
  orderId: string;
  side: OrderSide;
  qty: number;
  price: number;
  fees: number;
  tradedAt?: string;
  note?: string;
}): { order: TradeOrder; position: { qty: number; cost: number | null } } {
  const db = getDb();
  return db.transaction(() => {
    const targetRow = db.prepare("SELECT * FROM trade_orders WHERE id = ? AND user_id = ?").get(input.orderId, input.userId) as OrderRow | undefined;
    if (!targetRow) throw new Error("订单不存在");
    const target = rowToOrder(targetRow);
    const rows = db.prepare("SELECT * FROM trade_orders WHERE user_id = ? AND record_id = ? AND status = 'filled' ORDER BY traded_at ASC, created_at ASC")
      .all(input.userId, target.recordId) as OrderRow[];
    if (rows.length === 0) throw new Error("订单不存在");
    const original = rows.map(rowToOrder);
    const base = positionBeforeFirstOrder(original[0]);
    const nextTradedAt = input.tradedAt && !Number.isNaN(Date.parse(input.tradedAt)) ? new Date(input.tradedAt).toISOString() : target.tradedAt;

    db.prepare("UPDATE trade_orders SET side = ?, qty = ?, price = ?, fees = ?, amount = ?, note = ?, traded_at = ? WHERE id = ? AND user_id = ?")
      .run(input.side, input.qty, input.price, input.fees, input.qty * input.price, String(input.note || "").slice(0, 500), nextTradedAt, input.orderId, input.userId);

    const replayRows = db.prepare("SELECT * FROM trade_orders WHERE user_id = ? AND record_id = ? AND status = 'filled' ORDER BY traded_at ASC, created_at ASC")
      .all(input.userId, target.recordId) as OrderRow[];
    let qty = base.qty;
    let cost = base.cost;
    for (const row of replayRows) {
      const order = rowToOrder(row);
      if (order.side === "sell" && order.qty > qty + 1e-10) throw new Error(`更正后在 ${new Date(order.tradedAt).toLocaleString("zh-CN")} 出现超卖，最多可卖 ${qty}`);
      const beforeQty = qty;
      const beforeCost = cost;
      const calculated = applyOrder(
        { qty, cost },
        { side: order.side, qty: order.qty, price: order.price, fees: order.fees }
      );
      qty = calculated.qty;
      cost = calculated.cost;
      db.prepare("UPDATE trade_orders SET realized_pnl = ?, position_qty_before = ?, position_cost_before = ?, position_qty_after = ?, position_cost_after = ? WHERE id = ?")
        .run(calculated.realizedPnl, beforeQty, beforeCost, qty, qty > 0 ? cost : null, order.id);
    }
    const now = new Date().toISOString();
    db.prepare("UPDATE records SET qty = ?, cost = ?, updated_at = ? WHERE id = ? AND user_id = ?")
      .run(qty || null, qty > 0 ? cost : null, now, target.recordId, input.userId);
    refreshEconomicRealizedPnl(input.userId, target.recordId);
    syncOrderCashTransaction(input.userId, input.orderId);
    const updated = db.prepare("SELECT * FROM trade_orders WHERE id = ?").get(input.orderId) as OrderRow;
    return { order: rowToOrder(updated), position: { qty, cost: qty > 0 ? cost : null } };
  })();
}

/** 删除一笔成交订单，并重放该股票剩余账本，保证当前持仓与订单快照一致。 */
export function deleteOrder(input: {
  userId: string;
  orderId: string;
}): { deletedId: string; position: { qty: number; cost: number | null } } {
  const db = getDb();
  return db.transaction(() => {
    const targetRow = db.prepare("SELECT * FROM trade_orders WHERE id = ? AND user_id = ?").get(input.orderId, input.userId) as OrderRow | undefined;
    if (!targetRow) throw new Error("订单不存在");
    const target = rowToOrder(targetRow);
    const rows = db.prepare("SELECT * FROM trade_orders WHERE user_id = ? AND record_id = ? AND status = 'filled' ORDER BY traded_at ASC, created_at ASC")
      .all(input.userId, target.recordId) as OrderRow[];
    if (rows.length === 0) throw new Error("订单不存在");

    const base = positionBeforeFirstOrder(rowToOrder(rows[0]));
    db.prepare("DELETE FROM trade_orders WHERE id = ? AND user_id = ?").run(input.orderId, input.userId);
    syncOrderCashTransaction(input.userId, input.orderId);

    const replayRows = db.prepare("SELECT * FROM trade_orders WHERE user_id = ? AND record_id = ? AND status = 'filled' ORDER BY traded_at ASC, created_at ASC")
      .all(input.userId, target.recordId) as OrderRow[];
    let qty = base.qty;
    let cost = base.cost;
    for (const row of replayRows) {
      const order = rowToOrder(row);
      if (order.side === "sell" && order.qty > qty + 1e-10) {
        throw new Error(`删除后在 ${new Date(order.tradedAt).toLocaleString("zh-CN")} 出现超卖，最多可卖 ${qty}`);
      }
      const beforeQty = qty;
      const beforeCost = cost;
      const calculated = applyOrder(
        { qty, cost },
        { side: order.side, qty: order.qty, price: order.price, fees: order.fees }
      );
      qty = calculated.qty;
      cost = calculated.cost;
      db.prepare("UPDATE trade_orders SET realized_pnl = ?, position_qty_before = ?, position_cost_before = ?, position_qty_after = ?, position_cost_after = ? WHERE id = ?")
        .run(calculated.realizedPnl, beforeQty, beforeCost, qty, qty > 0 ? cost : null, order.id);
    }

    const now = new Date().toISOString();
    db.prepare("UPDATE records SET qty = ?, cost = ?, updated_at = ? WHERE id = ? AND user_id = ?")
      .run(qty || null, qty > 0 ? cost : null, now, target.recordId, input.userId);
    refreshEconomicRealizedPnl(input.userId, target.recordId);
    return { deletedId: input.orderId, position: { qty, cost: qty > 0 ? cost : null } };
  })();
}
