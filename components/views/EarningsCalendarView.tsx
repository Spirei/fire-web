"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { StockRecord } from "@/lib/types";
import { ensureStockIcons, useAssetIcons } from "@/lib/useAssetIcons";
import { pickStockIcon } from "@/lib/stockIconKey";
import MarketIcon from "@/components/MarketIcon";
import { usePersistedState } from "@/lib/usePersistedState";

interface EarnRow {
  symbol: string;
  name: string;
  nameZh: string;
  market: string;
  date: string;
  time: string;
  quarter: string;
  epsForecast: string;
  ests: number;
  marketCap: number;
  price: number | null;
  changePct: number | null;
}

type TimeKey = "all" | "pre" | "after" | "intra";
// 市值档位：参考券商大盘 / 中盘 / 小盘口径，min / max 为闭开区间 [min, max)
type CapKey = "all" | "1000b" | "100b" | "10b" | "lt10b";
type CapKeyCN = "all" | "5000y" | "1000y" | "100y" | "lt100y";
type MarketKey = "US" | "CN" | "HK" | "JP" | "KR";
type StockKey = "all" | "watch" | "hold" | "special";

const TIMES: { key: TimeKey; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "pre", label: "盘前" },
  { key: "after", label: "盘后" },
  { key: "intra", label: "盘中" }
];

const US_CAPS: { key: CapKey; label: string; min?: number; max?: number }[] = [
  { key: "all", label: "全部市值" },
  { key: "1000b", label: "超大盘 ≥$1000亿", min: 100e9 },
  { key: "100b", label: "大盘 $100-1000亿", min: 10e9, max: 100e9 },
  { key: "10b", label: "中盘 $10-100亿", min: 1e9, max: 10e9 },
  { key: "lt10b", label: "小盘 <$10亿", max: 1e9 }
];

const CN_CAPS: { key: CapKeyCN; label: string; min?: number; max?: number }[] = [
  { key: "all", label: "全部市值" },
  { key: "5000y", label: "超大盘 ≥¥5000亿", min: 500e9 },
  { key: "1000y", label: "大盘 ¥1000-5000亿", min: 100e9, max: 500e9 },
  { key: "100y", label: "中盘 ¥100-1000亿", min: 10e9, max: 100e9 },
  { key: "lt100y", label: "小盘 <¥100亿", max: 10e9 }
];

const MARKETS: { key: MarketKey; label: string }[] = [
  { key: "US", label: "美股" },
  { key: "HK", label: "港股" },
  { key: "CN", label: "A股" },
  { key: "JP", label: "日股" },
  { key: "KR", label: "韩股" }
];

const STOCK_TYPES: { key: StockKey; label: string }[] = [
  { key: "all", label: "全部股票" },
  { key: "watch", label: "自选" },
  { key: "hold", label: "持仓" },
  { key: "special", label: "特别关注" }
];

const WEEKDAY_ZH = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

function timeKind(time: string): TimeKey {
  if (time.includes("pre")) return "pre";
  if (time.includes("after")) return "after";
  return "intra";
}

function timeLabel(time: string): string {
  const kind = timeKind(time);
  return kind === "pre" ? "盘前" : kind === "after" ? "盘后" : "盘中";
}

function fmtCap(n: number): string {
  if (!n) return "";
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  return "";
}

function fmtPrice(n: number | null): string {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtPriceByMarket(n: number | null, market: string): string {
  const num = fmtPrice(n);
  if (num === "—") return num;
  return market === "CN" ? `¥${num}` : `$${num}`;
}

function fmtCapByMarket(n: number, market: string): string {
  if (!n) return "";
  if (market === "CN") {
    if (n >= 1e12) return `¥${(n / 1e12).toFixed(2)}万亿`;
    if (n >= 1e8) return `¥${(n / 1e8).toFixed(0)}亿`;
    return `¥${(n / 1e4).toFixed(0)}万`;
  }
  return fmtCap(n);
}

const TIME_DOT: Record<TimeKey, string> = {
  all: "bg-[#9aa1ab]",
  pre: "bg-[#e6a23c]",
  after: "bg-brand",
  intra: "bg-[#9aa1ab]"
};

const TIME_BADGE: Record<TimeKey, string> = {
  all: "",
  pre: "bg-[#fff4e5] text-[#b06a00]",
  after: "bg-brand-light text-brand-deep",
  intra: "bg-bg-gray text-muted"
};

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function dateKey(y: number, m: number, d: number): string {
  return `${y}-${pad2(m + 1)}-${pad2(d)}`;
}

function parseKey(key: string): { y: number; m: number; d: number } {
  const [y, m, d] = key.split("-").map(Number);
  return { y, m: m - 1, d };
}

function PillGroup({
  label,
  options,
  value,
  onChange
}: {
  label: string;
  options: { key: string; label: string }[];
  value: string;
  onChange: (k: string) => void;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <span className="mr-0.5 text-[11px] font-semibold text-faint">{label}</span>
      <div className="flex min-w-0 max-w-full flex-wrap gap-0.5 rounded-xl border border-edge-strong bg-bg-gray/60 p-0.5 text-[11px] font-semibold">
        {options.map((o) => (
          <button
            key={o.key}
            type="button"
            onClick={() => onChange(o.key)}
            className={`whitespace-nowrap rounded-full px-2.5 py-1 transition-colors duration-200 ${
              value === o.key ? "seg-active" : "text-muted hover:bg-brand-hover hover:text-ink"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

const LOGO_BASE = "https://g.foolcdn.com/art/companylogos/square/";
const PARQET_BASE = "https://assets.parqet.com/logos/symbol/";

function logoUrl(symbol: string, market: string, usBase: string, cnBase: string): string {
  if (market === "CN") {
    const c = symbol.trim().toUpperCase();
    const ex = /^6/.test(c) ? "SS" : /^[03]/.test(c) ? "SZ" : "";
    return ex ? `${cnBase}${c}.${ex}` : "";
  }
  const clean = symbol.replace(/[.^/]/g, "").toUpperCase();
  return clean ? `${usBase}${clean}.png` : "";
}

function Fireo({
  symbol,
  name,
  market = "US",
  className,
  usBase = LOGO_BASE,
  cnBase = PARQET_BASE
}: {
  symbol: string;
  name: string;
  market?: string;
  className?: string;
  usBase?: string;
  cnBase?: string;
}) {
  const [err, setErr] = useState(false);
  const { stockIcons } = useAssetIcons(["stock"]);
  const url = logoUrl(symbol, market, usBase, cnBase);
  const custom = pickStockIcon(stockIcons, market, symbol);
  if (err || (!custom && !url)) {
    return (
      <span className={`${className} flex items-center justify-center rounded-full bg-brand-light text-[11px] font-bold text-brand-deep`}>
        {(name || symbol).trim().slice(0, 1).toUpperCase()}
      </span>
    );
  }
  return (
    <img
      src={custom || url}
      alt=""
      loading="lazy"
      onError={() => setErr(true)}
      className={`${className} rounded-full bg-bg-gray object-cover`}
    />
  );
}

export default function EarningsCalendarView({ records = [] }: { records?: StockRecord[] }) {
  const [months, setMonths] = useState<Record<string, EarnRow[] | null>>({});
  const [failed, setFailed] = useState(false);
  const [logoBases, setLogoBases] = useState<{ us: string; cn: string } | null>(null);
  const [timeKey, setTimeKey] = usePersistedState<TimeKey>("fire:earnings-time", "all");
  const [capKey, setCapKey] = usePersistedState<CapKey | CapKeyCN>("fire:earnings-cap", "all");
  const [marketKey, setMarketKey] = useState<MarketKey>(() => {
    if (typeof window === "undefined") return "US";
    const m = new URLSearchParams(window.location.search).get("market")?.toUpperCase();
    return (["US", "HK", "CN", "JP", "KR", "ALL"] as string[]).includes(m ?? "") ? (m as MarketKey) : "US";
  });
  const [stockKey, setStockKey] = useState<StockKey>(() => {
    if (typeof window === "undefined") return "all";
    const s = new URLSearchParams(window.location.search).get("type");
    return s === "watchlist" || s === "holdings" || s === "star" ? (s as StockKey) : "all";
  });
  const [marketOrder, setMarketOrder] = useState<MarketKey[]>([]);
  const [cursor, setCursor] = useState(() => {
    const n = new Date();
    return { y: n.getFullYear(), m: n.getMonth() };
  });
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const dragMarketIndex = useRef<number | null>(null);
  // 已发起过请求的月份键：避免缓存回填导致的重复请求
  const loadedKeys = useRef<Set<string>>(new Set());
  // 今日格子引用：打开财报日历自动定位到当前日期
  const todayCellRef = useRef<HTMLButtonElement | null>(null);

  // URL 同步市场/类型筛选：刷新保持
  useEffect(() => {
    function syncFromUrl() {
      const sp = new URLSearchParams(window.location.search);
      const m = sp.get("market")?.toUpperCase();
      if (m && (["US", "HK", "CN", "JP", "KR", "ALL"] as string[]).includes(m)) setMarketKey(m as MarketKey);
      const s = sp.get("type");
      if (s === "watchlist" || s === "holdings" || s === "star") setStockKey(s as StockKey);
    }
    window.addEventListener("popstate", syncFromUrl);
    return () => window.removeEventListener("popstate", syncFromUrl);
  }, []);

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    if (sp.get("market") !== marketKey) {
      sp.set("market", marketKey);
      window.history.replaceState(null, "", `?${sp.toString()}`);
    }
  }, [marketKey]);

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    if (sp.get("type") !== stockKey) {
      sp.set("type", stockKey);
      window.history.replaceState(null, "", `?${sp.toString()}`);
    }
  }, [stockKey]);

  const cursorKey = `${cursor.y}-${pad2(cursor.m + 1)}`;
  const dataKey = `${marketKey}:${cursorKey}`;
  const items = months[dataKey] ?? null;

  useEffect(() => {
    if (!items?.length) return;
    void ensureStockIcons(items.map((row) => ({ market: row.market, code: row.symbol })));
  }, [items]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled) return;
        if (data?.settings) {
          setLogoBases({
            us: data.settings.usLogoApiUrl || LOGO_BASE,
            cn: data.settings.cnLogoApiUrl || PARQET_BASE
          });
          if (Array.isArray(data.settings.assetMarketOrder)) {
            const valid = (data.settings.assetMarketOrder as string[]).filter((k) => MARKETS.some((m) => m.key === k)) as MarketKey[];
            if (valid.length > 0) setMarketOrder(valid);
          }
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (marketKey !== "US" && marketKey !== "CN") return; // 该市场暂无数据源
    if (months[dataKey] || loadedKeys.current.has(dataKey)) return; // 已加载
    let cancelled = false;
    setFailed(false);
    // 本地缓存秒出（上次访问过的月份立即展示，再后台刷新）
    try {
      const raw = localStorage.getItem(`fire:earnings:${dataKey}`);
      if (raw) {
        const arr = JSON.parse(raw) as EarnRow[];
        if (Array.isArray(arr) && arr.length > 0) {
          setMonths((prev) => ({ ...prev, [dataKey]: arr }));
        }
      }
    } catch {
      /* 缓存无效忽略 */
    }
    fetch(`/api/earnings?month=${cursorKey}&market=${marketKey}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled) return;
        if (data?.items) {
          loadedKeys.current.add(dataKey); // 请求成功后标记，避免 StrictMode 双挂载重复请求
          setMonths((prev) => ({ ...prev, [dataKey]: data.items }));
          try {
            localStorage.setItem(`fire:earnings:${dataKey}`, JSON.stringify(data.items));
          } catch {
            /* 忽略 */
          }
        } else {
          setFailed(true);
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [cursorKey, dataKey, marketKey, months]);

  const caps = marketKey === "CN" ? CN_CAPS : US_CAPS;

  // 自动定位当前日期：财报数据就绪后，若正处于本月，滚动到今日格子
  useEffect(() => {
    if (items === null) return;
    const now = new Date();
    if (cursor.y !== now.getFullYear() || cursor.m !== now.getMonth()) return;
    const t = window.setTimeout(() => {
      // 定位到今日并置顶，让下方财报详情直接可见
      todayCellRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      // 自动展开今日财报详情，更直观
      setSelectedDate(dateKey(now.getFullYear(), now.getMonth(), now.getDate()));
    }, 300);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, cursorKey]);

  const changeMarket = (k: MarketKey) => {
    setMarketKey(k);
    setSelectedDate(null);
    setCapKey("all");
  };

  function toggleDate(key: string) {
    setSelectedDate(selectedDate === key ? null : key);
  }

  const orderedMarkets = useMemo(() => {
    const base = MARKETS.map((m) => m.key);
    return [...marketOrder, ...base.filter((k) => !marketOrder.includes(k))];
  }, [marketOrder]);

  function persistMarketOrder(next: MarketKey[]) {
    setMarketOrder(next);
    fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assetMarketOrder: next })
    }).catch(() => {});
  }

  function dropMarket(target: number) {
    const from = dragMarketIndex.current;
    dragMarketIndex.current = null;
    if (from === null || from === target) return;
    const next = [...orderedMarkets];
    const [moved] = next.splice(from, 1);
    next.splice(target, 0, moved);
    persistMarketOrder(next);
  }

  const bounds = useMemo(() => {
    const now = new Date();
    const min = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const max = new Date(now.getFullYear(), now.getMonth() + 5, 0); // 未来 4 个月（含本月）
    return { minY: min.getFullYear(), minM: min.getMonth(), maxY: max.getFullYear(), maxM: max.getMonth() };
  }, []);

  // 股票类型 → 记录代码集合（自选=无持仓，持仓=数量>0，特别关注=分组名为“特别关注”）
  const stockSets = useMemo(() => {
    const codeSet = (arr: StockRecord[]) => new Set(arr.map((r) => r.code.trim().toUpperCase()));
    return {
      watch: codeSet(records.filter((r) => Number(r.qty) <= 0)),
      hold: codeSet(records.filter((r) => Number(r.qty) > 0)),
      special: codeSet(records.filter((r) => r.group.trim() === "特别关注"))
    };
  }, [records]);

  const filtered = useMemo(() => {
    if (!items) return [];
    const cap = (caps as { key: string; label: string; min?: number; max?: number }[]).find((c) => c.key === capKey);
    return items.filter((it) => {
      if (timeKey !== "all" && timeKind(it.time) !== timeKey) return false;
      if (cap && capKey !== "all") {
        const mc = it.marketCap;
        if (mc == null || mc <= 0) return false;
        if (cap.min !== undefined && mc < cap.min) return false;
        if (cap.max !== undefined && mc >= cap.max) return false;
      }
      if (stockKey !== "all") {
        const set = stockSets[stockKey];
        if (!set || !set.has(it.symbol.toUpperCase())) return false;
      }
      return true;
    });
  }, [items, timeKey, capKey, caps, stockKey, stockSets]);

  const byDate = useMemo(() => {
    const map = new Map<string, EarnRow[]>();
    filtered.forEach((it) => {
      const list = map.get(it.date) || [];
      list.push(it);
      map.set(it.date, list);
    });
    return map;
  }, [filtered]);

  // 未过滤的全部财报（用于提示「有财报但被筛选隐藏」的日期）
  const byDateAll = useMemo(() => {
    const map = new Map<string, EarnRow[]>();
    (items ?? []).forEach((it) => {
      const list = map.get(it.date) || [];
      list.push(it);
      map.set(it.date, list);
    });
    return map;
  }, [items]);

  const monthBounds = useMemo(() => {
    return bounds;
  }, [bounds]);

  const grid = useMemo(() => {
    const { y, m } = cursor;
    const first = new Date(y, m, 1);
    const offset = (first.getDay() + 6) % 7;
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const cells: ({ type: "blank" } | { type: "day"; key: string; day: number; rows: EarnRow[]; isToday: boolean })[] = [];
    for (let i = 0; i < offset; i++) cells.push({ type: "blank" });
    const now = new Date();
    const today = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
    for (let d = 1; d <= daysInMonth; d++) {
      const key = dateKey(y, m, d);
      cells.push({ type: "day", key, day: d, rows: byDate.get(key) || [], isToday: key === today });
    }
    while (cells.length % 7 !== 0) cells.push({ type: "blank" });
    return cells;
  }, [cursor, byDate]);

  const canPrev = !monthBounds || cursor.y > monthBounds.minY || (cursor.y === monthBounds.minY && cursor.m > monthBounds.minM);
  const canNext = !monthBounds || cursor.y < monthBounds.maxY || (cursor.y === monthBounds.maxY && cursor.m < monthBounds.maxM);
  const monthTitle = `${cursor.y}年${cursor.m + 1}月`;

  const moveMonth = (delta: number) => {
    setSelectedDate(null);
    setCursor((c) => {
      const m = c.m + delta;
      const y = m < 0 ? c.y - 1 : m > 11 ? c.y + 1 : c.y;
      const nm = ((m % 12) + 12) % 12;
      if (delta < 0 && (y < bounds.minY || (y === bounds.minY && nm < bounds.minM))) return c;
      if (delta > 0 && (y > bounds.maxY || (y === bounds.maxY && nm > bounds.maxM))) return c;
      return { y, m: nm };
    });
  };

  const goToday = () => {
    const n = new Date();
    setCursor({ y: n.getFullYear(), m: n.getMonth() });
    setSelectedDate(null);
  };

  const selectedRows = selectedDate ? byDate.get(selectedDate) || [] : [];
  const sel = selectedDate ? parseKey(selectedDate) : null;

  let emptyHint = "";
  if (marketKey === "HK" || marketKey === "JP" || marketKey === "KR") emptyHint = "该市场财报数据源暂未接入，敬请期待";
  else if (items === null || items === undefined) emptyHint = failed ? "财报数据加载失败，请稍后重试" : "loading";
  else if (failed && items.length === 0) emptyHint = "财报数据加载失败，请稍后重试";
  else if (items.length === 0) emptyHint = "该月暂无财报数据";
  else if (stockKey === "special" && stockSets.special.size === 0) emptyHint = "暂未设置「特别关注」券商，可在 设置 → 股票设置 → 券商管理 中创建";
  else if (filtered.length === 0) emptyHint = "没有符合筛选条件的财报，试试放宽市值或时段筛选";

  return (
    <div className="earnings-calendar-page">
      <h2 className="mb-1.5 text-lg font-bold">财报日历</h2>
      <p className="mb-4 text-sm text-muted">美股 / A股财报 · 上月至未来 4 个月，点击日期查看当天财报详情。</p>

      <div className="card overflow-visible">
        {/* 头部：月份导航 + 统计 + 筛选 */}
        <div className="flex flex-col gap-3 border-b border-edge px-4 py-3.5 sm:px-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <div className="flex items-center gap-1 rounded-full border border-edge-strong bg-bg-gray/60 p-1">
                <button
                  type="button"
                  onClick={() => moveMonth(-1)}
                  disabled={!canPrev}
                  aria-label="上个月"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-full text-muted transition-all duration-200 hover:bg-brand-hover hover:text-ink dark:hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="m15 18-6-6 6-6" /></svg>
                </button>
                <span className="min-w-[112px] text-center text-sm font-bold tabular-nums text-ink">{monthTitle}</span>
                <button
                  type="button"
                  onClick={() => moveMonth(1)}
                  disabled={!canNext}
                  aria-label="下个月"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-full text-muted transition-all duration-200 hover:bg-brand-hover hover:text-ink dark:hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="m9 18 6-6-6-6" /></svg>
                </button>
              </div>
              <button
                type="button"
                onClick={goToday}
                className="rounded-full border border-edge bg-transparent px-3 py-1.5 text-xs font-semibold text-ink-2 transition-colors duration-200 hover:bg-brand-hover hover:text-ink dark:border-[#3b4354] dark:text-[#e7ebf1] dark:hover:bg-white/10"
              >
                回到本月
              </button>
              <span className="hidden items-center gap-1.5 rounded-full bg-brand-light px-2.5 py-1 text-[11px] font-semibold text-brand-deep sm:flex">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand" />
                实时
              </span>
            </div>
            <span className="rounded-full bg-bg-gray px-3 py-1.5 text-xs font-semibold text-muted">共 {filtered.length} 家</span>
          </div>

          <div className="flex min-w-0 flex-col gap-2.5 rounded-2xl border border-edge bg-bg-gray/40 p-2.5 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-5 sm:rounded-[14px] sm:px-3 sm:py-2.5 dark:bg-white/[0.03]">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span className="mr-0.5 text-[11px] font-semibold text-faint">市场</span>
              <div className="flex min-w-0 max-w-full flex-wrap gap-0.5 rounded-xl border border-edge-strong bg-bg-gray/60 p-0.5 text-[11px] font-semibold">
                {orderedMarkets.map((m, i) => (
                  <button
                    key={m}
                    type="button"
                    draggable
                    onDragStart={(e) => {
                      dragMarketIndex.current = i;
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => dropMarket(i)}
                    onDragEnd={() => {
                      dragMarketIndex.current = null;
                    }}
                    onClick={() => changeMarket(m)}
                    title="按住拖动排序"
                    className={`flex cursor-pointer items-center gap-1 rounded-full px-2.5 py-1 transition-all duration-200 active:cursor-grabbing ${
                      marketKey === m ? "seg-active" : "text-muted hover:bg-brand-hover hover:text-ink"
                    }`}
                  >
                    <MarketIcon market={m} size={15} />
                    {MARKETS.find((x) => x.key === m)?.label}
                    <svg viewBox="0 0 24 24" fill="currentColor" className="h-2.5 w-2.5 flex-none opacity-30">
                      <circle cx="9" cy="6" r="1.1" /><circle cx="15" cy="6" r="1.1" />
                      <circle cx="9" cy="12" r="1.1" /><circle cx="15" cy="12" r="1.1" />
                      <circle cx="9" cy="18" r="1.1" /><circle cx="15" cy="18" r="1.1" />
                    </svg>
                  </button>
                ))}
              </div>
            </div>
            <PillGroup label="市值" options={caps} value={capKey} onChange={(k) => setCapKey(k as CapKey | CapKeyCN)} />
            <PillGroup label="类型" options={STOCK_TYPES} value={stockKey} onChange={(k) => setStockKey(k as StockKey)} />
            <PillGroup label="时段" options={TIMES} value={timeKey} onChange={(k) => setTimeKey(k as TimeKey)} />
          </div>
        </div>

        {/* 月历网格 */}
        <div className="earnings-calendar-grid overflow-hidden px-3 py-4 sm:px-5">
          {emptyHint === "loading" ? (
            <>
              {/* 先渲染日历骨架，财报数据异步填充，避免日历迟迟不出 */}
              <div className="mb-1.5 grid grid-cols-7 gap-1.5 sm:gap-2">
                {WEEKDAY_ZH.map((w) => (
                  <div key={w} className="py-1 text-center text-[11px] font-semibold text-faint">{w}</div>
                ))}
              </div>
              <div className="grid grid-cols-7 gap-1.5 sm:gap-2">
                {grid.map((cell, i) =>
                  cell.type === "blank" ? (
                    <div key={`blank-${i}`} className="min-h-[88px] rounded-[14px]" />
                  ) : (
                    <button
                      key={cell.key}
                      type="button"
                      aria-current={cell.isToday ? "date" : undefined}
                      className={`flex min-h-[88px] cursor-default flex-col rounded-[14px] border bg-bg-gray/30 p-2.5 dark:bg-white/[0.04] ${
                        cell.isToday
                          ? "border-2 border-white bg-[#eef0f3] shadow-[0_0_0_2px_rgba(17,24,39,0.22)] dark:bg-white/[0.08] dark:shadow-[0_0_0_2px_rgba(255,255,255,0.18)]"
                          : "border-transparent"
                      }`}
                    >
                      <span className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold tabular-nums ${cell.isToday ? "bg-white text-black shadow-sm" : "text-faint"}`}>
                        {cell.day}
                      </span>
                    </button>
                  )
                )}
              </div>
              <div className="mt-3 h-3 w-40 mx-auto animate-pulse rounded bg-bg-gray" aria-hidden />
            </>
          ) : emptyHint ? (
            <div className="py-16 text-center text-sm text-faint">{emptyHint}</div>
          ) : (
            <>
              <div className="mb-1.5 grid grid-cols-7 gap-1.5 sm:gap-2">
                {WEEKDAY_ZH.map((w) => (
                  <div key={w} className="py-1 text-center text-[11px] font-semibold text-faint">{w}</div>
                ))}
              </div>
              <div className="grid grid-cols-7 gap-1.5 sm:gap-2">
                {grid.map((cell, i) =>
                  cell.type === "blank" ? (
                    <div key={`blank-${i}`} className="min-h-[88px] rounded-[14px]" />
                  ) : (
                    <button
                      key={cell.key}
                      ref={cell.isToday ? todayCellRef : undefined}
                      type="button"
                      aria-current={cell.isToday ? "date" : undefined}
                      onClick={() => toggleDate(cell.key)}
                      data-open={selectedDate === cell.key ? "true" : undefined}
                      className={`group relative flex min-h-[88px] cursor-pointer flex-col gap-1.5 overflow-hidden rounded-[14px] border p-2.5 text-left transition-all duration-300 ease-out hover:-translate-y-0.5 hover:border-edge-strong hover:shadow-pop ${
                        selectedDate === cell.key
                          ? "border-edge bg-white shadow-pop dark:bg-[#252c3a]"
                          : cell.rows.length > 0
                            ? "border-edge bg-bg-gray/50 hover:bg-brand-hover dark:bg-white/[0.05] dark:hover:bg-white/[0.09]"
                            : "border-transparent bg-bg-gray/30 dark:bg-white/[0.04]"
                      } ${cell.isToday ? "!border-2 !border-white !bg-[#eef0f3] shadow-[0_0_0_2px_rgba(17,24,39,0.22)] hover:!border-white dark:!bg-white/[0.08] dark:shadow-[0_0_0_2px_rgba(255,255,255,0.18)]" : ""}`}
                    >
                      <span
                        className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold tabular-nums transition-colors duration-200 ${
                          cell.isToday ? "bg-white text-black shadow-sm" : cell.rows.length > 0 ? "text-ink" : "text-faint"
                        }`}
                      >
                        {cell.day}
                      </span>
                      {cell.rows.length === 0 && (byDateAll.get(cell.key)?.length ?? 0) > 0 && (
                        <span className="text-[9.5px] font-medium leading-tight text-faint">
                          {byDateAll.get(cell.key)!.length} 家已过滤
                        </span>
                      )}

                      <div data-earnings-rows className="flex flex-col gap-[4px] pt-0.5">
                        {cell.rows.map((row) => (
                          <span data-earnings-row key={row.symbol} className="flex min-w-0 items-center gap-1 overflow-hidden text-[10px] font-medium leading-[1.3] text-ink-2 sm:text-[10.5px]">
                            <span data-earnings-logo className="flex h-3.5 w-3.5 flex-none overflow-hidden rounded-full">
                              <Fireo symbol={row.symbol} name={row.nameZh || row.name} market={row.market} usBase={logoBases?.us} cnBase={logoBases?.cn} className="h-3.5 w-3.5 flex-none" />
                            </span>
                            <span data-earnings-name className="min-w-0 flex-1 truncate">{row.nameZh || row.name}</span>
                            <span data-earnings-dot className={`ml-auto h-1.5 w-1.5 flex-none rounded-full ${TIME_DOT[timeKind(row.time)]}`} />
                          </span>
                        ))}
                        {cell.rows.length > 3 && (
                          <span data-earnings-more className="text-[10px] font-semibold text-muted">+{cell.rows.length - 3} 家</span>
                        )}
                      </div>

                      {cell.rows.length > 0 && (
                        <div
                          data-earnings-pop
                          onClick={() => toggleDate(cell.key)}
                          className={`pointer-events-none absolute inset-0 z-20 flex flex-col overflow-hidden rounded-[14px] border border-edge-strong bg-white p-2 shadow-pop transition-all duration-300 ease-out ${selectedDate === cell.key ? "translate-y-0 scale-100 opacity-100 pointer-events-auto" : "-translate-y-1 scale-95 opacity-0 group-hover:translate-y-0 group-hover:scale-100 group-hover:opacity-100 group-hover:pointer-events-auto"}`}
                        >
                          <div className="mb-1 flex items-center justify-between">
                            <span className="text-[11px] font-bold text-ink">{cell.key.slice(5).replace("-", "月")}日</span>
                            <span className="rounded-full bg-bg-gray px-1.5 py-0.5 text-[9px] font-semibold text-muted">{cell.rows.length} 家</span>
                          </div>
                          <div className="flex min-h-0 flex-1 flex-col gap-[3px] overflow-y-auto overscroll-contain pr-0.5">
                            {cell.rows.map((row) => (
                              <div key={row.symbol} className="flex items-center justify-between gap-1 rounded-md px-1 py-0.5 transition-colors duration-200 hover:bg-brand-hover">
                                <div className="flex min-w-0 items-center gap-1">
                                  <Fireo symbol={row.symbol} name={row.nameZh || row.name} market={row.market} usBase={logoBases?.us} cnBase={logoBases?.cn} className="h-4 w-4" />
                                  <div className="min-w-0 leading-[1.2]">
                                    <div className="truncate text-[10px] font-semibold text-ink">{row.nameZh || row.name}</div>
                                    <div className="truncate text-[9px] text-faint">
                                      {row.symbol} · {fmtCapByMarket(row.marketCap, row.market) || "—"}
                                    </div>
                                  </div>
                                </div>
                                <div className="flex flex-none flex-col items-end leading-[1.2]">
                                  <span className="text-[10px] font-semibold tabular-nums text-ink">{fmtPriceByMarket(row.price, row.market)}</span>
                                  <span className={`text-[9px] font-semibold tabular-nums ${row.changePct !== null && row.changePct >= 0 ? "text-up" : row.changePct !== null ? "text-down" : "text-faint"}`}>
                                    {row.changePct !== null ? `${row.changePct >= 0 ? "+" : ""}${row.changePct.toFixed(2)}%` : "—"}
                                  </span>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </button>
                  )
                )}
              </div>
            </>
          )}
        </div>

        {/* 选中日期详情（平滑展开） */}
        <div
          className={`grid transition-all duration-300 ease-out ${selectedDate ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`}
          aria-hidden={!selectedDate}
        >
          <div className="overflow-hidden">
            <div className="mx-3 mb-4 rounded-[16px] border border-edge bg-bg-gray/40 p-3 sm:mx-5 sm:p-4 dark:bg-[#10141d]">
              {sel && (
                <div className="mb-3 flex items-center gap-2 px-1">
                  <span className="text-sm font-bold text-ink">{sel.m + 1}月{sel.d}日</span>
                  <span className="text-xs text-faint">{WEEKDAY_ZH[new Date(sel.y, sel.m, sel.d).getDay()]}</span>
                  <span className="rounded-full bg-bg-gray/60 px-2 py-0.5 text-[11px] font-semibold text-muted ring-1 ring-edge dark:bg-white/5 dark:text-[#e7ebf1] dark:ring-white/10">{selectedRows.length} 家财报</span>
                </div>
              )}
              {selectedDate && selectedRows.length === 0 && (byDateAll.get(selectedDate)?.length ?? 0) > 0 && (
                <p className="mb-3 rounded-[10px] border border-dashed border-edge-strong px-3 py-2.5 text-xs text-muted">
                  当天有 {byDateAll.get(selectedDate)!.length} 家财报，但被当前「市值 / 时段 / 类型」筛选隐藏，可调整筛选条件查看
                </p>
              )}
              {selectedDate && selectedRows.length === 0 && (byDateAll.get(selectedDate)?.length ?? 0) === 0 && (
                <p className="mb-3 px-1 text-xs text-faint">该日暂无财报</p>
              )}
              <div data-day-detail-list className="flex flex-col gap-2">
                {selectedRows.map((row) => {
                  const chg = row.changePct;
                  return (
                    <div
                      key={`${row.symbol}-${row.date}`}
                      className="earnings-result-row grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 rounded-[14px] border border-edge bg-white px-4 py-3 shadow-card transition-all duration-300 ease-out hover:-translate-y-0.5 hover:border-edge-strong/35 hover:shadow-pop md:grid-cols-[1.8fr_auto_1fr_1.2fr_1fr]"
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <Fireo symbol={row.symbol} name={row.nameZh || row.name} market={row.market} usBase={logoBases?.us} cnBase={logoBases?.cn} className="h-9 w-9" />
                        <div className="min-w-0 leading-[1.35]">
                          <div className="truncate text-sm font-semibold text-ink">{row.nameZh || row.name}</div>
                          <div className="text-xs text-muted">
                            {row.symbol}
                            {row.name && row.nameZh && <span className="ml-1.5">{row.name}</span>}
                            {fmtCapByMarket(row.marketCap, row.market) && <span className="ml-1.5 text-faint">{fmtCapByMarket(row.marketCap, row.market)}</span>}
                          </div>
                        </div>
                      </div>
                      <span className={`flex-none rounded-full px-2.5 py-1 text-xs font-semibold ${row.market === "CN" ? "bg-bg-gray text-muted" : TIME_BADGE[timeKind(row.time)]}`}>
                        {row.market === "CN" ? "财报" : timeLabel(row.time)}
                      </span>
                      <div className="hidden flex-col items-center leading-[1.35] md:flex">
                        <span className="text-sm font-semibold tabular-nums text-ink">{row.market === "CN" ? (row.quarter || "—") : (row.epsForecast || "—")}</span>
                        <span className="text-[11px] text-faint">{row.market === "CN" ? "" : row.ests > 0 ? `${row.ests} 家机构` : ""}</span>
                      </div>
                      <div className="flex flex-col items-end leading-[1.35]">
                        <span className="text-sm font-semibold tabular-nums text-ink">{fmtPriceByMarket(row.price, row.market)}</span>
                        {chg !== null ? (
                          <span className={`text-xs font-semibold tabular-nums ${chg >= 0 ? "text-up" : "text-down"}`}>{chg >= 0 ? "+" : ""}{chg.toFixed(2)}%</span>
                        ) : (
                          <span className="text-faint">—</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        <div className="border-t border-edge bg-bg-gray/50 px-5 py-2.5 text-right text-xs text-faint">
          美股数据来自 Nasdaq，A股数据来自东方财富预约披露，行情实时更新，仅供参考
        </div>
      </div>
    </div>
  );
}
