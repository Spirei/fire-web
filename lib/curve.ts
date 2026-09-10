/**
 * 收益曲线口径单一数据源（纯函数：不依赖 DOM / React / 图表库）
 *
 * 背景：同一条「收益率曲线 / 累计收益曲线」有三处渲染 —— 资产分析（ECharts）、
 * 资产盈亏分析（ECharts）、简化版账户页（public/simple-app-runtime.js 手写 SVG）。
 * 渲染层各写各的没问题，但**周期窗口 / 资金加权算法 / 基准归一化**必须只有一份定义，
 * 否则同一个账户在不同页面会算出两个收益率。
 *
 * 维护约定：
 * 1. 本文件保持纯函数，禁止 import DOM / React / echarts；
 * 2. 简化版 runtime.js 通过 window.FireCurve 桥接调用（见 app/simple-app/SimpleAppClient.tsx），
 *    runtime 内保留的降级实现只在桥接缺失时兜底，口径一律以本文件为准；
 * 3. 新增周期 / 口径先改这里，再让两侧渲染层引用。
 */

/** 全站统一的曲线周期 */
export type CurveRange = "month" | "1m" | "6m" | "ytd" | "1y" | "all" | "custom";

/** 简化版账本的历史快照行（每日总资产 + 当日转入 / 转出） */
export interface CurveLedgerRow {
  /** 日期 YYYY-MM-DD（含时间也按前 10 位取日期） */
  d: string;
  /** 当日总资产 */
  v: number;
  /** 当日转入 */
  inn?: number;
  /** 当日转出 */
  out?: number;
}

/** 基准日线（收盘价 / 点位） */
export interface CurveBenchRow {
  d: string;
  c: number;
}

export interface CurveSeries {
  dates: string[];
  values: number[];
}

export interface CurveRangeOptions {
  /** 计算「本月 / 近期」的参照时间，缺省为当前时间（测试可注入） */
  now?: Date;
  /** custom 区间起点 */
  from?: string;
  /** 区间终点（含） */
  to?: string;
}

/** 解析日期（前 10 位），无效返回 0 —— 与简化版 parseDay 保持一致 */
export function dayOf(date: string): number {
  const parsed = Date.parse(String(date || "").slice(0, 10));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function isoDay(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

/** 日历回退 N 个月并夹取月末：3/31 回退 1 个月 = 2/28（而不是 JS 默认的 3/3） */
function shiftMonths(value: Date, months: number): Date {
  const day = value.getDate();
  const target = new Date(value.getFullYear(), value.getMonth() + months, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(day, lastDay));
  return target;
}

/** 日历回退 N 年并夹取月末：2/29 回退 1 年 = 2/28 */
function shiftYears(value: Date, years: number): Date {
  const month = value.getMonth();
  const day = value.getDate();
  const target = new Date(value.getFullYear() - years, month, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(day, lastDay));
  return target;
}

/**
 * 周期起点（全站唯一口径）。
 * 本月 = 当月 1 日；本年 = 1 月 1 日；近 1 月 / 近 6 月 / 近 1 年 = 日历回退（不是 31 / 183 / 366 天近似）。
 * 返回 "" 表示不裁剪（全部）。
 */
export function rangeStart(range: CurveRange, options: CurveRangeOptions = {}): string {
  if (range === "all") return "";
  if (range === "custom") return String(options.from || "").slice(0, 10);
  const now = options.now ? new Date(options.now) : new Date();
  if (range === "month") return isoDay(new Date(now.getFullYear(), now.getMonth(), 1));
  if (range === "ytd") return `${now.getFullYear()}-01-01`;
  if (range === "1m") return isoDay(shiftMonths(now, -1));
  if (range === "6m") return isoDay(shiftMonths(now, -6));
  return isoDay(shiftYears(now, 1));
}

function sortedRows<T extends { d: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => String(a.d).localeCompare(String(b.d)));
}

function inWindow(date: string, start: string, end: string) {
  const day = String(date).slice(0, 10);
  return (!start || day >= start) && (!end || day <= end);
}

/** 严格按周期裁剪（主站趋势图用：起点即区间第一天） */
export function sliceRange<T extends { d: string }>(rows: T[], range: CurveRange, options: CurveRangeOptions = {}): T[] {
  const start = rangeStart(range, options);
  const end = String(options.to || "").slice(0, 10);
  const sorted = sortedRows(rows);
  if (!start && !end) return sorted;
  return sorted.filter((row) => inWindow(row.d, start, end));
}

/**
 * 按周期裁剪，并额外带上起点之前最近的一条作为基线。
 * 资金加权收益率 / 累计收益曲线必须用它：缺了基线，区间首日收益会被算成 0（曲线从 0 开始）。
 */
export function sliceWithAnchor<T extends { d: string }>(rows: T[], range: CurveRange, options: CurveRangeOptions = {}): T[] {
  const start = rangeStart(range, options);
  if (!start) return sliceRange(rows, range, options);
  const end = String(options.to || "").slice(0, 10);
  const sorted = sortedRows(rows);
  const inside = sorted.filter((row) => inWindow(row.d, start, end));
  const before = sorted.filter((row) => String(row.d).slice(0, 10) < start);
  return before.length ? [before[before.length - 1], ...inside] : inside;
}

export type LedgerCurveKind = "mwr" | "pnl";

/**
 * 账本曲线（Modified Dietz 资金加权）：
 * - "mwr" → 资金加权收益率（%）：累计盈亏 ÷ (起始资产 + 时间加权净流入)；
 * - "pnl" → 累计收益（金额）：期末资产 − 起始资产 − 区间净流入。
 * 只有资金流、没有资产估值的日期仅参与计算、不作为采样点，避免曲线上出现人为尖峰。
 */
export function ledgerSeries(rows: CurveLedgerRow[], kind: LedgerCurveKind): CurveSeries {
  const list = sortedRows(rows);
  const dates: string[] = [];
  const values: number[] = [];
  if (!list.length) return { dates, values };
  const start = Number(list[0].v) || 0;
  const t0 = dayOf(list[0].d);
  for (let i = 0; i < list.length; i++) {
    const endDay = dayOf(list[i].d);
    const span = Math.max(0, endDay - t0);
    let netFlow = 0;
    let weightedFlow = 0;
    for (let j = 1; j <= i; j++) {
      const flow = (Number(list[j].inn) || 0) - (Number(list[j].out) || 0);
      netFlow += flow;
      if (span) weightedFlow += (flow * Math.max(0, endDay - dayOf(list[j].d))) / span;
    }
    const pnl = (Number(list[i].v) || 0) - start - netFlow;
    const denominator = start + weightedFlow;
    const ownFlow = (Number(list[i].inn) || 0) - (Number(list[i].out) || 0);
    const previous = i ? Number(list[i - 1].v) || 0 : 0;
    const value = Number(list[i].v) || 0;
    const flowOnly = i > 0 && !!ownFlow && (
      Math.abs(value - previous) < 0.000001 || Math.abs(value - (previous + ownFlow)) < 0.000001
    );
    if (flowOnly) continue;
    values.push(kind === "pnl" ? pnl : denominator ? (pnl / denominator) * 100 : 0);
    dates.push(String(list[i].d));
  }
  return { dates, values };
}

/** 归一化成相对首值的百分比（首值缺失时回退 1，与历史行为一致） */
export function normalizeToPercent(values: number[]): number[] {
  if (!values.length) return [];
  const start = values[0] || 1;
  return values.map((value) => (value / start - 1) * 100);
}

/**
 * 把基准日线对齐到曲线日期轴：首个有效行情日之前用首值回填，之后顺延最近收盘价。
 * 不这样做的话，基准首个有效行情日之前会拿到 0，归一化后算成 −100%（历史上还出现过几万百分比的爆值）。
 */
export function benchmarkOnDates(rows: CurveBenchRow[], dates: string[]): number[] {
  if (!rows.length || !dates.length) return [];
  const sorted = rows
    .map((row) => ({ d: String(row.d).slice(0, 10), c: Number(row.c) }))
    .filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.d) && Number.isFinite(row.c) && row.c > 0)
    .sort((a, b) => a.d.localeCompare(b.d));
  if (!sorted.length) return [];
  const map = new Map(sorted.map((row) => [row.d, row.c]));
  let last = sorted[0].c;
  return dates.map((date) => {
    const next = map.get(String(date).slice(0, 10));
    if (next !== undefined) last = next;
    return last;
  });
}

/**
 * 简化版 runtime.js 的桥接载体（挂在 window.FireCurve 上）。
 * runtime 是静态 JS，无法直接 import TS 模块；两边共享同一份实现，避免口径漂移。
 */
export const curveApi = {
  rangeStart,
  sliceRange,
  sliceWithAnchor,
  ledgerSeries,
  normalizeToPercent,
  benchmarkOnDates
};
