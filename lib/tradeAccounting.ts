import type { OrderSide } from "./types";

export interface PositionSnapshot {
  qty: number;
  cost: number;
}

export interface TradeAccountingResult extends PositionSnapshot {
  realizedPnl: number | null;
}

/**
 * 券商持仓成本按千分位保存和展示。每次成交后即统一精度，避免数据库保留
 * 14.586448…、界面展示 14.586，却又用未展示的小数计算盈亏，造成账面差额。
 */
function normalizePositionCost(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000) / 1_000;
}

function normalizeMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * 券商口径的持仓成本：
 * - 买入：成交额与费用并入持仓，按数量加权；
 * - 卖出：卖出回款冲减累计投入，摊薄到剩余持仓；费用计入已实现盈亏，
 *   不重复并入剩余成本。盈利卖出可令剩余成本降低甚至为负数。
 */
export function applyFilledTrade(
  position: PositionSnapshot,
  trade: { side: OrderSide; qty: number; price: number; fees: number }
): TradeAccountingResult {
  const oldQty = position.qty;
  const oldCost = position.cost;

  if (trade.side === "buy") {
    const qty = oldQty + trade.qty;
    return {
      qty,
      cost: normalizePositionCost(((oldQty * oldCost) + (trade.qty * trade.price) + trade.fees) / qty),
      realizedPnl: null
    };
  }

  if (trade.qty > oldQty + 1e-10) throw new Error(`可卖数量不足，当前最多 ${oldQty}`);
  const qty = Math.max(0, oldQty - trade.qty);
  return {
    qty,
    cost: qty > 0
      ? normalizePositionCost(((oldQty * oldCost) - (trade.qty * trade.price)) / qty)
      : 0,
    realizedPnl: normalizeMoney((trade.price - oldCost) * trade.qty - trade.fees)
  };
}

/**
 * 股息入账：不改变持仓数量与成本，每股股息 × 股数（减费用）记为现金收入，
 * 归入已实现收益（realizedPnl），供订单账本与资产盈亏口径使用。
 */
export function applyDividend(
  position: PositionSnapshot,
  trade: { side: "dividend"; qty: number; price: number; fees: number }
): TradeAccountingResult {
  return {
    qty: position.qty,
    cost: position.cost,
    realizedPnl: normalizeMoney(trade.qty * trade.price - trade.fees)
  };
}

/** 统一记账入口：买入/卖出走 applyFilledTrade，股息走 applyDividend（重放账本同用）。 */
export function applyOrder(
  position: PositionSnapshot,
  trade: { side: OrderSide; qty: number; price: number; fees: number }
): TradeAccountingResult {
  if (trade.side === "dividend") {
    return applyDividend(position, { side: "dividend", qty: trade.qty, price: trade.price, fees: trade.fees });
  }
  return applyFilledTrade(position, { side: trade.side, qty: trade.qty, price: trade.price, fees: trade.fees });
}
