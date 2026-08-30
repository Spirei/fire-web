import type { StockRecord, TradeOrder } from "./types";

export interface LedgerPnlRow {
  recordId: string;
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  investedCapital: number;
  complete: boolean;
}

interface EconomicState {
  qty: number;
  averageCost: number | null;
  realizedPnl: number;
  investedCapital: number;
  complete: boolean;
}

const EPSILON = 1e-8;

/**
 * 独立于券商“摊薄成本”的经济盈亏账本。
 *
 * 持仓页允许卖出回款冲减剩余成本，这种成本适合展示“还剩多少本金”，但不能再用于
 * 逐笔已实现盈亏求和，否则连续减仓会重复计算利润。这里用标准移动平均成本回放：
 * 买入改变平均成本，卖出不改变剩余股平均成本，股息直接计入已实现收益。
 */
export function replayEconomicOrders(
  orders: TradeOrder[],
  initial: { qty: number; cost: number | null }
): EconomicState & { realizedByOrder: Map<string, number | null> } {
  let qty = Math.max(0, Number(initial.qty) || 0);
  let averageCost = qty > EPSILON && initial.cost == null ? null : Number(initial.cost || 0);
  let realizedPnl = 0;
  let investedCapital = averageCost == null ? 0 : qty * averageCost;
  let complete = qty <= EPSILON || averageCost != null;
  const realizedByOrder = new Map<string, number | null>();

  for (const order of [...orders].sort((a, b) => a.tradedAt.localeCompare(b.tradedAt) || a.createdAt.localeCompare(b.createdAt))) {
    if (order.status !== "filled") continue;
    const tradeQty = Math.max(0, Number(order.qty) || 0);
    const price = Math.max(0, Number(order.price) || 0);
    const fees = Math.max(0, Number(order.fees) || 0);

    if (order.side === "dividend") {
      const income = tradeQty * price - fees;
      realizedPnl += income;
      realizedByOrder.set(order.id, income);
      continue;
    }

    if (order.side === "buy") {
      const nextQty = qty + tradeQty;
      investedCapital += tradeQty * price + fees;
      if (averageCost != null && nextQty > EPSILON) {
        averageCost = (qty * averageCost + tradeQty * price + fees) / nextQty;
      } else {
        complete = false;
      }
      qty = nextQty;
      realizedByOrder.set(order.id, null);
      continue;
    }

    if (tradeQty > qty + EPSILON) {
      complete = false;
      realizedByOrder.set(order.id, null);
      qty = Math.max(0, qty - tradeQty);
    } else if (averageCost == null) {
      complete = false;
      realizedByOrder.set(order.id, null);
      qty = Math.max(0, qty - tradeQty);
    } else {
      const pnl = (price - averageCost) * tradeQty - fees;
      realizedPnl += pnl;
      realizedByOrder.set(order.id, pnl);
      qty = Math.max(0, qty - tradeQty);
    }

    // 一轮未知成本的旧仓完全卖完后，后续新买入可重新建立完整账本。
    if (qty <= EPSILON) {
      qty = 0;
      averageCost = 0;
    }
  }

  return { qty, averageCost, realizedPnl, investedCapital, complete, realizedByOrder };
}

/** 计算每只股票的累计已实现 + 当前未实现盈亏；无订单的手工持仓回退为原浮动盈亏。 */
export function buildPortfolioLedger(
  records: StockRecord[],
  orders: TradeOrder[],
  livePrice: (record: StockRecord) => number
): Map<string, LedgerPnlRow> {
  const grouped = new Map<string, TradeOrder[]>();
  for (const order of orders) {
    if (order.status !== "filled") continue;
    const list = grouped.get(order.recordId) || [];
    list.push(order);
    grouped.set(order.recordId, list);
  }

  const result = new Map<string, LedgerPnlRow>();
  for (const record of records) {
    const currentQty = Math.max(0, Number(record.qty) || 0);
    const currentCost = Number(record.cost) || 0;
    const price = Number(livePrice(record)) || Number(record.price) || 0;
    const recordOrders = grouped.get(record.id) || [];

    if (recordOrders.length === 0) {
      const unrealizedPnl = (price - currentCost) * currentQty;
      result.set(record.id, {
        recordId: record.id,
        realizedPnl: 0,
        unrealizedPnl,
        totalPnl: unrealizedPnl,
        investedCapital: Math.abs(currentCost * currentQty),
        complete: false
      });
      continue;
    }

    const sorted = [...recordOrders].sort((a, b) => a.tradedAt.localeCompare(b.tradedAt) || a.createdAt.localeCompare(b.createdAt));
    const first = sorted[0];
    const initialQty = Number(first.positionQtyBefore) || 0;
    const initialCost = first.positionCostBefore == null ? null : Number(first.positionCostBefore);

    // 数量对平时，完整现金流是最稳健的累计盈亏答案；即使历史中出现临时负持仓，
    // 也不需要猜测每一笔卖出的成本分摊。
    const endingQty = sorted.reduce((value, order) => {
      if (order.side === "buy") return value + order.qty;
      if (order.side === "sell") return value - order.qty;
      return value;
    }, initialQty);
    const quantityMatches = Math.abs(endingQty - currentQty) <= EPSILON;
    if (quantityMatches && (initialQty <= EPSILON || initialCost != null)) {
      let totalPnl = price * currentQty - initialQty * (initialCost || 0);
      let investedCapital = initialQty * Math.abs(initialCost || 0);
      for (const order of sorted) {
        const gross = Number(order.amount) || order.qty * order.price;
        if (order.side === "buy") {
          totalPnl -= gross + order.fees;
          investedCapital += gross + order.fees;
        } else {
          totalPnl += gross - order.fees;
        }
      }
      const replay = replayEconomicOrders(sorted, { qty: initialQty, cost: initialCost });
      const replayUsable = replay.complete && replay.averageCost != null && Math.abs(replay.qty - currentQty) <= EPSILON;
      const unrealizedPnl = currentQty <= EPSILON
        ? 0
        : replayUsable
          ? (price - replay.averageCost!) * currentQty
          : (price - currentCost) * currentQty;
      result.set(record.id, {
        recordId: record.id,
        realizedPnl: totalPnl - unrealizedPnl,
        unrealizedPnl,
        totalPnl,
        investedCapital,
        complete: replayUsable || currentQty <= EPSILON
      });
      continue;
    }
    const replay = replayEconomicOrders(sorted, {
      qty: initialQty,
      cost: initialCost
    });
    const replayQuantityMatches = Math.abs(replay.qty - currentQty) <= EPSILON;

    if (!replayQuantityMatches || replay.averageCost == null || !replay.complete) {
      // 手动调整过持仓或导入窗口缺少旧仓成本时，避免“已实现 + 摊薄浮盈”重复计算。
      const fallback = (price - currentCost) * currentQty;
      result.set(record.id, {
        recordId: record.id,
        realizedPnl: 0,
        unrealizedPnl: fallback,
        totalPnl: fallback,
        investedCapital: Math.abs(currentCost * currentQty),
        complete: false
      });
      continue;
    }

    const unrealizedPnl = (price - replay.averageCost) * currentQty;
    result.set(record.id, {
      recordId: record.id,
      realizedPnl: replay.realizedPnl,
      unrealizedPnl,
      totalPnl: replay.realizedPnl + unrealizedPnl,
      investedCapital: replay.investedCapital,
      complete: replay.complete
    });
  }
  return result;
}
