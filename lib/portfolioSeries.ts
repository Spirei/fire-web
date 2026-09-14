"use client";

import type { TradeOrder } from "./types";

export interface SeriesClose {
  d: string;
  c: number;
}

export interface PortfolioBundle {
  /** recordId → 日收盘序列（只带 d / c，体积是完整日K的三分之一） */
  closes: Record<string, SeriesClose[]>;
  orders: TradeOrder[];
  days: number;
  at: number;
}

const BUNDLE_TTL = 5 * 60 * 1000;
const bundleCache = new Map<string, PortfolioBundle>();
const bundleCachedAt = new Map<string, number>();
const bundleInflight = new Map<string, Promise<PortfolioBundle | null>>();

/** 同一页面树内同步读取已经完成的组合数据，供二级页首帧直接复用。 */
export function peekPortfolioBundle(days = 330): PortfolioBundle | null {
  const hit = bundleCache.get(String(days));
  const cachedAt = bundleCachedAt.get(String(days)) || 0;
  return hit && Date.now() - cachedAt < BUNDLE_TTL ? hit : null;
}

/**
 * 一次取回「持仓日K + 基准日K + 订单」。
 * 资产分析与资产盈亏分析共用：此前两边都按持仓逐只请求 /api/kline/full，
 * 17 只持仓 ≈ 17 次请求 / 约 700KB；现在 1 次请求、约 1/5 体积，并且两页共享缓存。
 */
export async function fetchPortfolioBundle({
  days = 330,
  force = false
}: {
  days?: number;
  force?: boolean;
} = {}): Promise<PortfolioBundle | null> {
  const key = String(days);
  const hit = bundleCache.get(key);
  if (!force && hit && Date.now() - (bundleCachedAt.get(key) || 0) < BUNDLE_TTL) return hit;
  const pending = bundleInflight.get(key);
  if (pending && !force) return pending;

  const params = new URLSearchParams({ days: String(days) });
  let task!: Promise<PortfolioBundle | null>;
  task = (async () => {
    try {
      // 默认走浏览器 HTTP 缓存：服务端带 ETag + max-age=30，刷新时命中就 304（不重传正文）；
      // 强制刷新（交易后 / 手动刷新）才绕过缓存。
      const response = await fetch(`/api/v1/portfolio-series?${params}`, force ? { cache: "no-store" } : undefined);
      if (!response.ok) throw new Error(`bundle ${response.status}`);
      const data = (await response.json()) as Partial<PortfolioBundle> | null;
      if (!data || typeof data.closes !== "object" || data.closes === null) throw new Error("bundle empty");
      const bundle: PortfolioBundle = {
        closes: data.closes as Record<string, SeriesClose[]>,
        orders: Array.isArray(data.orders) ? (data.orders as TradeOrder[]) : [],
        days: Number(data.days) || days,
        at: Number(data.at) || Date.now()
      };
      bundleCache.set(key, bundle);
      bundleCachedAt.set(key, Date.now());
      return bundle;
    } catch {
      // 源站 / 限流抖动时回退上一次成功结果，避免趋势图与日历被清空
      return hit ?? null;
    } finally {
      if (bundleInflight.get(key) === task) bundleInflight.delete(key);
    }
  })();
  bundleInflight.set(key, task);
  return task;
}

/** 服务端返回的 closes 已经是 { d, c }，这里统一过滤一次，避免脏数据进图 */
export function normalizeCloses(items: SeriesClose[] | undefined): SeriesClose[] {
  if (!Array.isArray(items)) return [];
  return items.filter((item) => typeof item?.d === "string" && Number.isFinite(Number(item?.c)));
}

const benchmarkCache = new Map<string, { items: SeriesClose[]; at: number }>();
const benchmarkInflight = new Map<string, Promise<SeriesClose[]>>();

/** 基准日K（单个小请求，带内存缓存与并发去重）：切换基准时不必重拉全部持仓 */
export async function fetchBenchmarkKline(
  market: string,
  code: string,
  days = 330,
  index = false
): Promise<SeriesClose[]> {
  const key = `${market.toUpperCase()}:${code.toUpperCase()}:${days}:${index ? 1 : 0}`;
  const hit = benchmarkCache.get(key);
  if (hit && Date.now() - hit.at < BUNDLE_TTL) return hit.items;
  const pending = benchmarkInflight.get(key);
  if (pending) return pending;
  let task!: Promise<SeriesClose[]>;
  task = (async () => {
    try {
      const url = `/api/kline/full?market=${encodeURIComponent(market)}&code=${encodeURIComponent(code)}&limit=${days}${index ? "&index=1" : ""}`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`benchmark ${response.status}`);
      const data = (await response.json()) as { items?: SeriesClose[] };
      const items = normalizeCloses(data?.items);
      if (items.length > 0) benchmarkCache.set(key, { items, at: Date.now() });
      return items.length > 0 ? items : hit?.items ?? [];
    } catch {
      return hit?.items ?? [];
    } finally {
      if (benchmarkInflight.get(key) === task) benchmarkInflight.delete(key);
    }
  })();
  benchmarkInflight.set(key, task);
  return task;
}
