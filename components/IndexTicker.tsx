"use client";

import { useEffect, useId, useMemo, useState } from "react";
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

function Sparkline({ points, up }: { points: number[]; up: boolean }) {
  const gid = useId().replace(/:/g, "");
  const svg = useMemo(() => {
    if (!points || points.length < 2) return null;
    const prices = points.filter((p) => Number.isFinite(p));
    if (prices.length < 2) return null;
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const range = max - min || 1;
    const W = 56;
    const H = 20;
    const coords = prices.map((p, i) => {
      const x = (i / (prices.length - 1)) * W;
      const y = H - 1.5 - ((p - min) / range) * (H - 6);
      return [x, y] as const;
    });
    const line = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
    const area = `${line} L${W},${H} L0,${H} Z`;
    return { line, area, color: up ? "#e23d3d" : "#0fa07b", lastY: coords[coords.length - 1][1] };
  }, [points, up]);

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
      <path d={svg.line} fill="none" stroke={svg.color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx="56" cy={svg.lastY} r="1.8" fill={svg.color} />
    </svg>
  );
}

function TickerChip({ item }: { item: TickerItem }) {
  const up = (item.change ?? 0) >= 0;
  const color = up ? "text-[#e23d3d]" : "text-[#0fa07b]";
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
      <svg viewBox="0 0 24 24" fill="currentColor" className={`h-[10px] w-[10px] flex-none ${color}`} aria-hidden>
        {up ? <path d="M12 5 20 19H4Z" /> : <path d="M12 19 4 5h16Z" />}
      </svg>
      <Sparkline points={item.points} up={up} />
      <span className={`whitespace-nowrap text-[12.5px] font-semibold tabular-nums ${color}`}>
        {fmtSigned(item.change)} {fmtSigned(item.changePct, "%")}
      </span>
    </div>
  );
}

export default function IndexTicker() {
  const [items, setItems] = useState<TickerItem[]>([]);
  const [intervalSec, setIntervalSec] = useState(5);
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/ticker", { cache: "no-store" });
        const data = await res.json().catch(() => null);
        if (!cancelled && data?.items) {
          setItems(data.items);
          if (typeof data.interval === "number" && data.interval >= 3) setIntervalSec(data.interval);
        }
      } catch {
        /* 静默失败，下轮重试 */
      }
    }
    load();
    const timer = window.setInterval(() => {
      // 页面不可见（切后台 / 睡眠）时暂停轮询，避免多标签页堆积请求拖慢服务
      if (!document.hidden) load();
    }, 60_000);
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
  }, []);

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
