"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useState } from "react";
import MarketIcon from "@/components/MarketIcon";
import { marketMeta } from "@/lib/types";

interface TickerItem {
  key: string;
  label: string;
  market: string;
  price: number | null;
  change: number | null;
  changePct: number | null;
  points: number[];
}

function fmtPrice(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "--";
  return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtSigned(v: number | null, suffix = ""): string {
  if (v == null || !Number.isFinite(v)) return "--";
  return `${v > 0 ? "+" : ""}${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${suffix}`;
}

/**
 * 迷你走势图 + 昨收基准线（对齐 Yahoo Finance 的写法：虚线画在昨收位置，
 * 一眼看出现在是站在开盘基准线上方还是下方）。基准线取值 = 现价 − 涨跌额。
 */
function Sparkline({ points, up, baseline }: { points: number[]; up: boolean; baseline: number | null }) {
  const gid = useId().replace(/:/g, "");
  const svg = useMemo(() => {
    if (!points || points.length < 2) return null;
    const prices = points.filter((p) => Number.isFinite(p));
    if (prices.length < 2) return null;
    // 基准线也要算进纵向范围：否则昨收落在当日区间之外时那条线会跑出画布
    const base = baseline != null && Number.isFinite(baseline) ? baseline : null;
    const rawMin = Math.min(...prices, base ?? Number.POSITIVE_INFINITY);
    const rawMax = Math.max(...prices, base ?? Number.NEGATIVE_INFINITY);
    const rawRange = rawMax - rawMin;
    // 上下各留约 10% 呼吸空间，基准线即使是当日极值也不会贴住画布边缘。
    const pad = rawRange > 0 ? rawRange * 0.1 : Math.max(Math.abs(rawMin) * 0.0005, 1);
    const min = rawMin - pad;
    const max = rawMax + pad;
    const range = max - min;
    const W = 56;
    const H = 20;
    const X_PAD = 1.5;
    const yOf = (p: number) => H - 1.5 - ((p - min) / range) * (H - 3);
    const coords = prices.map((p, i) => {
      const x = X_PAD + (i / (prices.length - 1)) * (W - X_PAD * 2);
      const y = yOf(p);
      return [x, y] as const;
    });
    const line = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
    const baseY = base == null ? null : yOf(base);
    // 色带只填到昨收基准线；没有基准值时才沿用填到底部的兜底。
    const fillY = baseY ?? H;
    const area = `${line} L${coords[coords.length - 1][0].toFixed(1)},${fillY.toFixed(1)} L${coords[0][0].toFixed(1)},${fillY.toFixed(1)} Z`;
    return {
      line,
      area,
      color: up ? "#e23d3d" : "#0fa07b",
      lastX: coords[coords.length - 1][0],
      lastY: coords[coords.length - 1][1],
      baseY
    };
  }, [points, up, baseline]);

  if (!svg) return <span className="h-5 w-14 flex-none" />;
  return (
    <svg viewBox="0 0 56 20" preserveAspectRatio="none" className="h-5 w-14 flex-none" aria-hidden>
      <defs>
        <linearGradient id={`tg-${gid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={svg.color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={svg.color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={svg.area} fill={`url(#tg-${gid})`} />
      {/* 昨收基准线：浅色细虚线，压在色带之上、走势线之下 */}
      {svg.baseY != null && (
        <line
          x1="1"
          x2="55"
          y1={svg.baseY.toFixed(1)}
          y2={svg.baseY.toFixed(1)}
          stroke="currentColor"
          className="text-muted"
          strokeWidth="0.65"
          strokeDasharray="2.2 2"
          opacity="0.5"
        />
      )}
      <path d={svg.line} fill="none" stroke={svg.color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={svg.lastX} cy={svg.lastY} r="1.55" fill={svg.color} />
    </svg>
  );
}

function TickerChip({ item }: { item: TickerItem }) {
  const up = (item.change ?? 0) >= 0;
  const color = up ? "text-[#e23d3d]" : "text-[#0fa07b]";
  // 昨收 = 现价 − 涨跌额（接口给的是今日涨跌额）；拿不到就不画基准线
  const baseline = item.price != null && item.change != null ? item.price - item.change : null;
  return (
    <div className="ticker-item flex items-center gap-2.5 rounded-2xl px-3 py-2 transition-colors duration-200 hover:bg-brand-hover">
      <span className="group/icon relative flex-none">
        <MarketIcon market={item.market} size={22} title="" />
        <span className="pointer-events-none absolute left-1/2 top-full z-50 mt-1.5 -translate-x-1/2 whitespace-nowrap rounded-lg border border-edge bg-white px-2 py-1 text-[11px] font-semibold text-ink opacity-0 shadow-[0_6px_18px_rgba(10,14,25,.14)] transition-all duration-150 group-hover/icon:opacity-100 dark:bg-[#1c2433] dark:text-[#e7ebf1]">
          {marketMeta(item.market).label} · {item.label}
        </span>
      </span>
      <span className="whitespace-nowrap text-[13px] font-semibold text-ink">{item.label}</span>
      <span className="whitespace-nowrap text-[15px] font-bold tabular-nums text-ink">{fmtPrice(item.price)}</span>
      {item.change !== null && <svg viewBox="0 0 24 24" fill="currentColor" className={`h-[10px] w-[10px] flex-none ${color}`} aria-hidden>
        {up ? <path d="M12 5 20 19H4Z" /> : <path d="M12 19 4 5h16Z" />}
      </svg>}
      <Sparkline points={item.points} up={up} baseline={baseline} />
      <span className={`whitespace-nowrap text-[12.5px] font-semibold tabular-nums ${color}`}>
        {fmtSigned(item.change)} {fmtSigned(item.changePct, "%")}
      </span>
    </div>
  );
}

const TICKER_CACHE_KEY = "fire:ticker";

function readTickerCache(): { items: TickerItem[]; interval?: number; pollSec?: number } | null {
  try {
    const raw = JSON.parse(sessionStorage.getItem(TICKER_CACHE_KEY) || "null") as { items?: TickerItem[]; interval?: number; pollSec?: number } | null;
    if (Array.isArray(raw?.items) && raw.items.length) return { items: raw.items, interval: raw.interval, pollSec: raw.pollSec };
  } catch {
    /* ignore */
  }
  return null;
}

export default function IndexTicker() {
  const [items, setItems] = useState<TickerItem[]>([]);
  const [intervalSec, setIntervalSec] = useState(5);
  // 轮询间隔由服务端按「是否有市场在交易」给出：开市 60 秒，全部收市 5 分钟兜底
  const [pollSec, setPollSec] = useState(60);
  const [idx, setIdx] = useState(0);

  useLayoutEffect(() => {
    const cached = readTickerCache();
    if (!cached) return;
    setItems(cached.items);
    if (typeof cached.interval === "number" && cached.interval >= 3) setIntervalSec(cached.interval);
    if (typeof cached.pollSec === "number" && cached.pollSec >= 30) setPollSec(cached.pollSec);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/ticker", { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json().catch(() => null);
        if (!cancelled && Array.isArray(data?.items) && data.items.length > 0) {
          setItems(data.items);
          if (typeof data.interval === "number" && data.interval >= 3) setIntervalSec(data.interval);
          if (typeof data.pollSec === "number" && data.pollSec >= 30) setPollSec(data.pollSec);
          try { sessionStorage.setItem(TICKER_CACHE_KEY, JSON.stringify({ items: data.items, interval: data.interval, pollSec: data.pollSec })); } catch { /* quota */ }
        }
      } catch {
        /* 静默失败，下轮重试 */
      }
    }
    load();
    const timer = window.setInterval(() => {
      // 页面不可见（切后台 / 睡眠）时暂停轮询，避免多标签页堆积请求拖慢服务
      if (!document.hidden) load();
    }, pollSec * 1000);
    const onVis = () => {
      if (!document.hidden) load();
    };
    document.addEventListener("visibilitychange", onVis);
    const onSettings = () => load();
    window.addEventListener("fire:settings-updated", onSettings);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("fire:settings-updated", onSettings);
    };
  }, [pollSec]);

  // 按设置的时间轮换一个指数
  useEffect(() => {
    if (items.length <= 1) return;
    const timer = window.setInterval(() => setIdx((i) => (i + 1) % items.length), intervalSec * 1000);
    return () => window.clearInterval(timer);
  }, [items.length, intervalSec]);

  // 数据刷新后保持当前展示位置
  useEffect(() => {
    setIdx((i) => Math.min(i, Math.max(items.length - 1, 0)));
  }, [items.length]);

  const current = items[idx];
  if (!current) {
    return (
      <div className="flex h-[42px] w-[300px] animate-pulse items-center gap-2.5 rounded-2xl bg-bg-gray px-3">
        <span className="h-6 w-6 flex-none rounded bg-bg-gray" />
        <span className="h-3 w-20 rounded bg-bg-gray" />
        <span className="h-4 w-14 rounded bg-bg-gray" />
        <span className="ml-auto h-3 w-16 rounded bg-bg-gray" />
      </div>
    );
  }

  return (
    <div className="min-w-0">
      <TickerChip key={current.key} item={current} />
    </div>
  );
}
