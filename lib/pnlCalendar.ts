/* 收益日历（资产盈亏分析 / 资产分析共用）的数据口径：
 * 日资产序列、月格子、年汇总、某天的每股盈亏，两个页面都走这里，避免同一天两个页面数字不一致。 */

import { MARKET_CURRENCY } from "./currency";
import type { TradeOrder } from "./types";

export interface CalendarCloseItem {
  d: string;
  c: number;
}

/** 日历只用得到持仓的这几项，资产分析 / 盈亏分析各传各的记录即可 */
export interface CalendarPosition {
  id: string;
  name: string;
  code: string;
  market: string;
  qty: number;
}

export interface CalendarAssetPoint {
  date: string;
  asset: number;
  actual: number;
  flow: number;
  timeIndex: number;
}

export interface CalendarDayCell {
  day: number;
  pnl: number;
  pct: number | null;
}

export interface CalendarYearCell {
  m: number;
  pnl: number;
  pct: number | null;
  active: boolean;
}

export interface CalendarDayRow {
  id: string;
  name: string;
  code: string;
  market: string;
  pnl: number;
}

/** 订单成交时间 → 市场当地日期（YYYY-MM-DD） */
export function calendarMarketDate(value: string, market: string): string {
  const timeZone = market.toUpperCase() === "US" ? "America/New_York" : "Asia/Shanghai";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * 日资产序列（USD 口径，与资产分析页一致）：
 * - 每只持仓沿用「最近一个有效收盘价」，首日用各自首个有效收盘价回填；
 * - 按订单轨迹推进实际持仓数量，得到时间加权用的 actual；
 * - 现金流按交易日聚合（非交易日成交归入下一个交易日），供时间加权收益率使用。
 */
export function buildDailyAssetSeries({
  positions,
  closesMap,
  orders,
  rates
}: {
  positions: CalendarPosition[];
  closesMap: Record<string, CalendarCloseItem[]>;
  orders: TradeOrder[];
  rates: Record<string, number>;
}): CalendarAssetPoint[] {
  const byId = new Map(positions.map((p) => [p.id, p]));
  const recordItems = Object.entries(closesMap)
    .map(([id, items]) => ({
      id,
      first: items.length > 0 ? Number(items[0].c) || 0 : 0,
      map: new Map(items.map((it) => [it.d, Number(it.c)]))
    }))
    .filter((row) => byId.has(row.id) && row.first > 0);
  const dates = [...new Set(recordItems.flatMap((row) => [...row.map.keys()]))].sort();
  const last = new Map<string, number>();
  recordItems.forEach(({ id, first }) => {
    last.set(id, first);
  });

  const ordersByRecord = new Map<string, TradeOrder[]>();
  const flowByDate = new Map<string, number>();
  orders.forEach((order) => {
    if (order.status !== "filled") return;
    const rec = byId.get(order.recordId);
    if (!rec) return;
    const list = ordersByRecord.get(order.recordId) || [];
    list.push(order);
    ordersByRecord.set(order.recordId, list);
    const date = calendarMarketDate(order.tradedAt, order.market);
    if (!date) return;
    const gross = order.amount || order.price * order.qty;
    const cashFlow = order.side === "buy" ? gross + order.fees : -(gross - order.fees);
    const iso = MARKET_CURRENCY[rec.market] || "USD";
    const rate = rates[iso] || (iso === "USD" ? 1 : 0);
    flowByDate.set(date, (flowByDate.get(date) || 0) + cashFlow / (rate || 1));
  });
  ordersByRecord.forEach((list) => list.sort((a, b) => a.tradedAt.localeCompare(b.tradedAt)));

  const quantityState = new Map<string, { qty: number; cursor: number; orders: TradeOrder[] }>();
  recordItems.forEach(({ id }) => {
    const recOrders = ordersByRecord.get(id) || [];
    const qty = recOrders.length ? Number(recOrders[0].positionQtyBefore) || 0 : Number(byId.get(id)?.qty) || 0;
    quantityState.set(id, { qty, cursor: 0, orders: recOrders });
  });

  let timeIndex = 100;
  let previousActualAsset = 0;
  const flowDates = [...flowByDate.keys()].sort();
  let flowCursor = 0;
  let pendingFlow = 0;
  const out: CalendarAssetPoint[] = [];
  dates.forEach((date) => {
    let thisDayFlow = 0;
    while (flowCursor < flowDates.length && flowDates[flowCursor] <= date) {
      thisDayFlow += flowByDate.get(flowDates[flowCursor]) || 0;
      flowCursor += 1;
    }
    pendingFlow += thisDayFlow;
    let asset = 0;
    let actualAsset = 0;
    recordItems.forEach(({ id, map }) => {
      const next = map.get(date);
      if (next !== undefined) last.set(id, next);
      const close = last.get(id);
      if (close == null) return;
      const rec = byId.get(id);
      if (!rec) return;
      const iso = MARKET_CURRENCY[rec.market] || "USD";
      const rate = rates[iso] || (iso === "USD" ? 1 : 0);
      asset += (close * Number(rec.qty || 0)) / (rate || 1);
      const state = quantityState.get(id);
      if (!state) return;
      while (
        state.cursor < state.orders.length &&
        calendarMarketDate(state.orders[state.cursor].tradedAt, state.orders[state.cursor].market) <= date
      ) {
        state.qty = Number(state.orders[state.cursor].positionQtyAfter) || 0;
        state.cursor += 1;
      }
      actualAsset += (close * state.qty) / (rate || 1);
    });
    if (previousActualAsset > 0) {
      const dailyReturn = (actualAsset - thisDayFlow) / previousActualAsset - 1;
      if (Number.isFinite(dailyReturn) && dailyReturn > -1) timeIndex *= 1 + dailyReturn;
    }
    if (actualAsset > 0) previousActualAsset = actualAsset;
    if (asset > 0) out.push({ date, asset, actual: actualAsset, flow: pendingFlow, timeIndex });
  });
  return out;
}

/** 某月格子（周日为一周首日，与日历表头 日一二三四五六 对齐；m 为 1-12） */
export function buildMonthCells(
  series: CalendarAssetPoint[],
  year: number,
  month: number
): (CalendarDayCell | null)[] {
  const prefix = `${year}-${String(month).padStart(2, "0")}`;
  const daysInMonth = new Date(year, month, 0).getDate();
  const firstWeekday = new Date(year, month - 1, 1).getDay();
  const prevAsset = new Map<string, number>();
  series.forEach((p, i) => {
    if (i > 0) prevAsset.set(p.date, series[i - 1].asset);
  });
  const byDate = new Map(series.map((p) => [p.date, p.asset]));
  const cells: (CalendarDayCell | null)[] = Array.from({ length: firstWeekday }, () => null);
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = `${prefix}-${String(day).padStart(2, "0")}`;
    const asset = byDate.get(date);
    const prev = prevAsset.get(date);
    if (asset == null || prev == null) {
      cells.push({ day, pnl: 0, pct: null });
    } else {
      const pnl = asset - prev;
      cells.push({ day, pnl, pct: prev ? (pnl / prev) * 100 : null });
    }
  }
  return cells;
}

/** 年视图：每月盈亏（当月日盈亏合计）与收益率（相对上月月末资产） */
export function buildYearSummary(
  series: CalendarAssetPoint[],
  year: number,
  activeMonth: number
): CalendarYearCell[] {
  return Array.from({ length: 12 }, (_, i) => i + 1).map((m) => {
    const prefix = `${year}-${String(m).padStart(2, "0")}`;
    const monthStart = `${prefix}-01`;
    let base: number | null = null;
    let prev: number | null = null;
    let pnl = 0;
    for (const p of series) {
      if (p.date < monthStart) {
        base = p.asset;
        prev = p.asset;
      } else if (p.date.startsWith(prefix)) {
        if (prev != null) pnl += p.asset - prev;
        prev = p.asset;
      } else if (p.date > `${prefix}-31`) {
        break;
      }
    }
    const pct = base != null && base !== 0 ? (pnl / base) * 100 : null;
    return { m, pnl, pct, active: activeMonth === m };
  });
}

/** 某天每只股票的当日盈亏（当日收盘 − 前收盘）× 数量，USD 口径 */
export function buildDayDetailRows({
  date,
  positions,
  closesMap,
  rates
}: {
  date: string;
  positions: CalendarPosition[];
  closesMap: Record<string, CalendarCloseItem[]>;
  rates: Record<string, number>;
}): CalendarDayRow[] {
  const rows: CalendarDayRow[] = [];
  positions.forEach((p) => {
    const items = closesMap[p.id] || [];
    let close: number | null = null;
    let prevClose: number | null = null;
    for (let i = 0; i < items.length; i += 1) {
      if (items[i].d === date) {
        close = Number(items[i].c);
        prevClose = i > 0 ? Number(items[i - 1].c) : null;
        break;
      }
      if (items[i].d > date) break;
    }
    if (close == null || prevClose == null) return;
    const iso = MARKET_CURRENCY[p.market] || "USD";
    const rate = rates[iso] || 1;
    rows.push({ id: p.id, name: p.name, code: p.code, market: p.market, pnl: ((close - prevClose) * p.qty) / rate });
  });
  rows.sort((a, b) => b.pnl - a.pnl);
  return rows;
}
