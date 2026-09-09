"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FALLBACK_RATES, type Quote, type StockRecord, type TradeOrder } from "@/lib/types";
import { MARKET_CURRENCY } from "@/lib/currency";
import PnlTrendChart, { type PnlTrendPoint } from "@/components/PnlTrendChart";
import MarketIcon from "@/components/MarketIcon";
import CurrencyFlag from "@/components/CurrencyFlag";
import { useAssetIcons } from "@/lib/useAssetIcons";
import { getMarketBadge } from "@/lib/marketBadge";
import { useMarketBadge, useMarketBadgeVisible } from "@/lib/useMarketBadge";
import { showToast } from "@/lib/toast";
import { buildPortfolioLedger } from "@/lib/portfolioLedger";
import { CURRENCIES, CURRENCY_SYMBOLS, useDisplayCurrency } from "@/lib/currencyPrefs";
import { fmtMoney, fmtMoneyCompact } from "@/lib/format";

/** 成交日按市场时区归到 YYYY-MM-DD（与资产分析页同款，时间加权需要） */
function marketDate(value: string, market: string) {
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

/* 客户端 K 线缓存：日收盘序列 10 分钟内不重复请求（与资产分析页同款），
 * 避免每次挂载/切页都并发重拉全部持仓（30+ 只）K 线触发限流、趋势图空白。 */
const KLINE_CACHE_TTL = 10 * 60 * 1000;
const klineCache = new Map<string, { items: CloseItem[]; at: number }>();

async function fetchCachedKline(market: string, code: string, limit: number, index = false): Promise<CloseItem[]> {
  const key = `${market}:${code}:${limit}:${index ? "1" : "0"}`;
  const hit = klineCache.get(key);
  if (hit && Date.now() - hit.at < KLINE_CACHE_TTL) return hit.items;
  try {
    const response = await fetch(`/api/kline/full?market=${encodeURIComponent(market)}&code=${encodeURIComponent(code)}&limit=${limit}${index ? "&index=1" : ""}`, { cache: "no-store" });
    if (!response.ok) throw new Error("kline");
    const data = await response.json();
    const items = Array.isArray(data.items)
      ? (data.items as CloseItem[]).filter((it) => Number.isFinite(Number(it.c)) && typeof it.d === "string")
      : [];
    if (items.length > 0) klineCache.set(key, { items, at: Date.now() });
    return items;
  } catch {
    // 源站/限流抖动时回退上一次成功缓存，避免趋势图被清空
    return hit?.items ?? [];
  }
}

type PnlRow = {
  id: string;
  name: string;
  code: string;
  market: "US" | "HK" | "CN" | "JP" | "KR";
  pnl: number;
  rate: number;
  price: number;
  cost: number;
  qty: number;
  realizedPnl?: number;
  unrealizedPnl?: number;
  investedCapital?: number;
  complete?: boolean;
};

/** 收益日历某一天的每只股票盈亏（当日收盘 − 前收盘）× 数量 */
interface DayStockRow {
  id: string;
  name: string;
  code: string;
  market: PnlRow["market"];
  pnl: number;
}

interface CloseItem {
  d: string;
  c: number;
}

const SUPPORTED = new Set(["US", "HK", "CN", "JP", "KR"]);

// 基准对比（收益率趋势图）：主要市场指数（日 K 数据源：US/HK 用指数 ETF，CN 用指数代码）
const BENCHMARKS: { key: string; label: string; market: string; code: string; index?: boolean }[] = [
  { key: "spy", label: "标普 500", market: "US", code: "SPY" },
  { key: "qqq", label: "纳斯达克", market: "US", code: "QQQ" },
  { key: "dia", label: "道琼斯", market: "US", code: "DIA" },
  { key: "hsi", label: "恒生指数", market: "HK", code: "02800", index: true },
  { key: "sse", label: "上证指数", market: "CN", code: "sh000001", index: true },
  { key: "szse", label: "深证成指", market: "CN", code: "sz399001", index: true }
] as const;

const WEIGHT_OPTIONS = [
  ["simple", "简单加权"],
  ["time", "时间加权"]
] as const;


// 分享截图：html2canvas 懒加载 + dataURL → Blob（与资产分析-账户资产分享卡同款）
let html2canvasPromise: Promise<typeof import("html2canvas")> | null = null;
function loadHtml2canvas() {
  if (!html2canvasPromise) html2canvasPromise = import("html2canvas");
  return html2canvasPromise;
}

function dataUrlToBlob(dataUrl: string) {
  const comma = dataUrl.indexOf(",");
  const mime = /^data:([^;]+)/.exec(dataUrl.slice(0, comma))?.[1] || "image/png";
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mime });
}

function BackIcon() {
  return <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2"><path d="m15 18-6-6 6-6" /></svg>;
}

function FilterIcon() {
  return <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 5h16l-6 7v5l-4 2v-7L4 5Z" /></svg>;
}

function MarketBadge({ market, code }: { market: PnlRow["market"]; code: string }) {
  const visible = useMarketBadgeVisible();
  const b = useMarketBadge(market, code);
  if (!visible) return null;
  return (
    <span className="inline-flex h-[18px] w-[30px] flex-none items-center justify-center rounded-[4px] text-[10px] font-bold leading-none" style={{ background: b.bg, color: b.fg }}>
      {b.label}
    </span>
  );
}

function ClosedBadge() {
  return <small className="flex-none whitespace-nowrap rounded-full bg-bg-gray px-1.5 py-0.5 text-[9px] font-semibold text-muted">已清仓</small>;
}

function PnlStockIcon({ src, name }: { src?: string; name: string }) {
  const [failed, setFailed] = useState(false);

  useEffect(() => setFailed(false), [src]);

  if (!src || failed) {
    return <span className="grid h-8 w-8 flex-none place-items-center rounded-full bg-bg-gray text-xs font-bold text-muted">{name.slice(0, 1) || "?"}</span>;
  }

  return <img src={src} alt="" onError={() => setFailed(true)} className="h-8 w-8 flex-none rounded-full object-cover" />;
}

/** 盈亏榜股票信息：状态统一放在代码行，避免名称长度造成布局跳动。 */
function AdaptivePnlIdentity({ row }: { row: PnlRow }) {
  const closed = row.qty <= 0;

  return (
    <div className="w-full min-w-0">
      <p className="truncate text-xs font-semibold" title={row.name}>{row.name}</p>
      <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-muted">
        <MarketBadge market={row.market} code={row.code} />
        <span className="truncate">{row.code}</span>
        {closed && <ClosedBadge />}
      </p>
    </div>
  );
}

/** 共用「选择日期」按钮：点击弹出年份/月份选择器，选中回调 */
function DateSelectButton({
  year,
  month,
  onSelect,
  compact = false,
  label = "选择日期"
}: {
  year: number;
  month: number;
  onSelect: (y: number, m: number) => void;
  compact?: boolean;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pickerYear, setPickerYear] = useState(year);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="选择日期"
        aria-label="选择日期"
        className={`inline-flex items-center gap-1 rounded-lg font-semibold transition ${compact ? "px-2 py-1 text-sm" : "px-2.5 py-1.5 text-sm"} ${open ? "bg-bg-gray" : "text-ink-2 hover:bg-bg-gray"}`}
      >
        {label}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5 text-muted">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <>
          <div data-drag-skip className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div data-drag-skip className="absolute right-0 top-full z-40 mt-1 w-56 overflow-hidden rounded-xl border border-edge-strong bg-white p-3 shadow-pop">
            <div className="flex items-center justify-between">
              <button type="button" onClick={() => setPickerYear((y) => y - 1)} aria-label="上一年" className="grid h-7 w-7 place-items-center rounded-full text-muted hover:bg-bg-gray">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5"><path d="m15 18-6-6 6-6" /></svg>
              </button>
              <span className="text-sm font-bold">{pickerYear}</span>
              <button type="button" onClick={() => setPickerYear((y) => y + 1)} aria-label="下一年" className="grid h-7 w-7 place-items-center rounded-full text-muted hover:bg-bg-gray">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5"><path d="m9 18 6-6-6-6" /></svg>
              </button>
            </div>
            <div className="mt-2 grid grid-cols-3 gap-1">
              {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => {
                const active = year === pickerYear && month === m;
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => {
                      onSelect(pickerYear, m);
                      setOpen(false);
                    }}
                    className={`rounded-lg py-2 text-sm font-semibold transition ${active ? "bg-[#3297f6] text-white" : "text-ink-2 hover:bg-bg-gray"}`}
                  >
                    {m}月
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default function AssetPnlAnalysis({ onBack }: { onBack?: () => void }) {
  const { stockIcons } = useAssetIcons(["stock"]);
  const [allRecords, setAllRecords] = useState<StockRecord[]>([]);
  const [records, setRecords] = useState<StockRecord[]>([]);
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [rates, setRates] = useState<Record<string, number>>(FALLBACK_RATES);
  const [closesMap, setClosesMap] = useState<Record<string, CloseItem[]>>({});
  const [benchCloses, setBenchCloses] = useState<CloseItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [klineLoading, setKlineLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  const [period, setPeriod] = useState("全部");
  const [market, setMarket] = useState("全部");
  const [calMarket, setCalMarket] = useState<string>(() => {
    if (typeof window === "undefined") return "全部";
    try {
      const saved = localStorage.getItem("fire:asset-pnl-cal-market");
      return ["全部", "美股", "港股", "A股"].includes(saved ?? "") ? (saved as string) : "全部";
    } catch {
      return "全部";
    }
  });
  const [calMenuOpen, setCalMenuOpen] = useState(false);
  const [chartTab, setChartTab] = useState<"return" | "asset">("return");
  const [rankMode, setRankMode] = useState<"profit" | "loss">("profit");
  const [detailMode, setDetailMode] = useState<"profit" | "loss">("profit");
  // 盈亏总额卡片：货币（与资产分析页共用 key）、基准（多市场）、加权
  const { currency: displayCurrency, setCurrency: setDisplayCurrency } = useDisplayCurrency();
  const [benchKey, setBenchKey] = useState<string>(() => {
    if (typeof window === "undefined") return "spy";
    try {
      const saved = localStorage.getItem("fire:asset-pnl-bench");
      return BENCHMARKS.some((b) => b.key === saved) ? (saved as string) : "spy";
    } catch {
      return "spy";
    }
  });
  const [weighting, setWeighting] = useState<"simple" | "time">(() => {
    if (typeof window === "undefined") return "simple";
    try {
      return localStorage.getItem("fire:asset-pnl-weighting") === "time" ? "time" : "simple";
    } catch {
      return "simple";
    }
  });
  const [currencyMenuOpen, setCurrencyMenuOpen] = useState(false);
  const [benchOpen, setBenchOpen] = useState(false);
  const [weightOpen, setWeightOpen] = useState(false);
  const [marketMenuOpen, setMarketMenuOpen] = useState(false);

  // 分享截图：第一块卡片（盈亏总额卡片）截图为 PNG，预览后复制 / 保存
  const cardRef = useRef<HTMLElement | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [shareImage, setShareImage] = useState<string | null>(null);
  const [shareBusy, setShareBusy] = useState<"render" | "copy" | "save" | null>(null);
  // 订单（时间加权：按订单轨迹跟踪持仓数量 + 每日现金流）
  const [orders, setOrders] = useState<TradeOrder[]>([]);
  // 收益日历-每日股票盈亏明细（点击日历某天弹出）
  const [dayDetail, setDayDetail] = useState<{ date: string; rows: DayStockRow[] } | null>(null);
  const [dayDetailMode, setDayDetailMode] = useState<"profit" | "loss">("profit");
  const [calendarMode, setCalendarMode] = useState<"收益" | "收益率">("收益");
  const [calView, setCalView] = useState<"year" | "month">("month");
  const [calMonth, setCalMonth] = useState<{ y: number; m: number }>(() => {
    const now = new Date();
    try {
      const saved = JSON.parse(localStorage.getItem("fire:asset-pnl-cal-month") || "null") as { y?: number; m?: number } | null;
      const y = saved?.y;
      const m = saved?.m;
      if (typeof y === "number" && typeof m === "number" && Number.isInteger(y) && Number.isInteger(m) && m >= 1 && m <= 12) {
        return { y, m };
      }
    } catch {
      /* 忽略 */
    }
    return { y: now.getFullYear(), m: now.getMonth() + 1 };
  });
  // 真实数据：持仓 + 行情 + 汇率 + 日K（含标普500基准）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setKlineLoading(true);
      setLoadError("");
      try {
        const [recs, ratesRes, ordersRes] = await Promise.all([
          fetch("/api/records").then(async (response) => {
            if (!response.ok) throw new Error(response.status === 401 ? "登录已失效，请重新登录" : "持仓数据加载失败");
            return response.json();
          }),
          fetch("/api/rates").then((r) => (r.ok ? r.json() : null)).catch(() => null),
          fetch("/api/v1/orders?scope=all&limit=5000").then((r) => (r.ok ? r.json() : null)).catch(() => null)
        ]);
        if (cancelled) return;
        if (ratesRes?.rates) setRates((prev) => ({ ...prev, ...ratesRes.rates, USD: 1 }));
        if (Array.isArray(ordersRes?.data?.orders)) {
          setOrders(ordersRes.data.orders as TradeOrder[]);
        }
        const importedRecords = recs as StockRecord[];
        setAllRecords(importedRecords);
        const positions = importedRecords.filter((r) => Number(r.qty) > 0);
        setRecords(positions);
        if (positions.length > 0) {
          const qRes = await fetch("/api/quotes", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ items: positions.map((p) => ({ id: p.id, market: p.market, code: p.code })) })
          }).catch(() => null);
          const qData = await qRes?.json().catch(() => null);
          if (!cancelled && qData?.quotes) setQuotes(qData.quotes);
        }
        // 持仓 / 行情 / 汇率已就绪，先渲染页面（总额、排行、明细立即可见）
        setLoading(false);
        // 日K（有界并发 + force-cache）
        const eligible = positions.filter((p) => SUPPORTED.has(p.market.toUpperCase()));
        const closes: Record<string, CloseItem[]> = {};
        let cursor = 0;
        const workers = Array.from({ length: 4 }, async () => {
          while (cursor < eligible.length) {
            const idx = cursor++;
            const p = eligible[idx];
            const items = await fetchCachedKline(p.market, p.code, 250);
            if (items.length > 0) closes[p.id] = items;
          }
        });
        await Promise.all(workers);
        if (!cancelled) {
          setClosesMap(closes);
          setKlineLoading(false);
        }
      } catch (error) {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : "资产盈亏数据加载失败");
      } finally {
        if (!cancelled) {
          setLoading(false);
          setKlineLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  // 基准（多市场下拉：标普500 / 纳斯达克 / 道琼斯 / 恒生指数 / 上证指数 / 深证成指）日 K
  useEffect(() => {
    let cancelled = false;
    const bench = BENCHMARKS.find((b) => b.key === benchKey) || BENCHMARKS[0];
    (async () => {
      const items = await fetchCachedKline(bench.market, bench.code, 250, bench.index);
      if (!cancelled) {
        setBenchCloses(items);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [benchKey]);

  const toUsd = (marketKey: string, value: number) => {
    const iso = MARKET_CURRENCY[marketKey] || "USD";
    const rate = rates[iso] || (iso === "USD" ? 1 : 0);
    return rate ? value / rate : value;
  };

  const positions = useMemo<PnlRow[]>(
    () =>
      records.map((r) => {
        const qty = Number(r.qty) || 0;
        const price = quotes[r.id]?.price ?? (Number(r.price) || 0);
        const cost = Number(r.cost) || 0;
        const mv = toUsd(r.market, price * qty);
        const cv = toUsd(r.market, cost * qty);
        const pnl = mv - cv;
        return {
          id: r.id,
          name: r.name || r.code,
          code: r.code,
          market: r.market as PnlRow["market"],
          pnl,
          rate: cv ? (pnl / cv) * 100 : 0,
          price,
          cost,
          qty
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [records, quotes, rates]
  );

  const lifetimePositions = useMemo<PnlRow[]>(() => {
    const ledger = buildPortfolioLedger(
      allRecords,
      orders,
      (record) => quotes[record.id]?.price ?? (Number(record.price) || 0)
    );
    return allRecords.flatMap((record) => {
      const item = ledger.get(record.id);
      if (!item) return [];
      const totalPnl = toUsd(record.market, item.totalPnl);
      const realizedPnl = toUsd(record.market, item.realizedPnl);
      const unrealizedPnl = toUsd(record.market, item.unrealizedPnl);
      const investedCapital = toUsd(record.market, item.investedCapital);
      const qty = Number(record.qty) || 0;
      if (qty <= 0 && Math.abs(totalPnl) < 0.005) return [];
      return [{
        id: record.id,
        name: record.name || record.code,
        code: record.code,
        market: record.market as PnlRow["market"],
        pnl: totalPnl,
        rate: investedCapital ? (totalPnl / investedCapital) * 100 : 0,
        price: quotes[record.id]?.price ?? (Number(record.price) || 0),
        cost: Number(record.cost) || 0,
        qty,
        realizedPnl,
        unrealizedPnl,
        investedCapital,
        complete: item.complete
      }];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allRecords, orders, quotes, rates]);

  const byMarket = (rows: PnlRow[], key: string) =>
    rows.filter(
      (row) =>
        key === "全部" ||
        (key === "美股" && row.market === "US") ||
        (key === "港股" && row.market === "HK") ||
        (key === "A股" && row.market === "CN")
    );
  const positionsFiltered = useMemo(() => byMarket(positions, market), [positions, market]);
  const lifetimeFiltered = useMemo(() => byMarket(lifetimePositions, market), [lifetimePositions, market]);
  const calPositions = useMemo(() => byMarket(positions, calMarket), [positions, calMarket]);

  const totalPnl = useMemo(() => lifetimeFiltered.reduce((sum, p) => sum + p.pnl, 0), [lifetimeFiltered]);
  const realizedPnlTotal = useMemo(() => lifetimeFiltered.reduce((sum, p) => sum + (p.realizedPnl || 0), 0), [lifetimeFiltered]);
  const unrealizedPnlTotal = useMemo(() => lifetimeFiltered.reduce((sum, p) => sum + (p.unrealizedPnl || 0), 0), [lifetimeFiltered]);
  const costBasis = useMemo(() => lifetimeFiltered.reduce((sum, p) => sum + (p.investedCapital || 0), 0), [lifetimeFiltered]);
  const returnPct = costBasis ? (totalPnl / costBasis) * 100 : 0;

  // 盈亏总额卡片：货币换算 + 基准（多市场）
  const currencyFactor = rates[displayCurrency] || 1;
  const curSymbol = CURRENCY_SYMBOLS[displayCurrency] || displayCurrency;
  const curOption = CURRENCIES.find((o) => o.code === displayCurrency) || CURRENCIES[0];
  const moneyDisp = (value: number) => {
    const converted = value * currencyFactor;
    const body = Math.abs(converted) >= 1e7 ? fmtMoneyCompact(Math.abs(converted), curSymbol) : fmtMoney(Math.abs(converted), curSymbol);
    return `${converted >= 0 ? "+" : "−"}${body}`;
  };
  const compactDisp = (value: number) => {
    const converted = value * currencyFactor;
    const abs = Math.abs(converted);
    const sign = converted < 0 ? "−" : "+";
    return `${sign}${fmtMoneyCompact(abs, curSymbol)}`;
  };
  const benchLabel = BENCHMARKS.find((b) => b.key === benchKey)?.label ?? "标普 500";

  const winners = useMemo(() => [...lifetimeFiltered].filter((p) => p.pnl > 0).sort((a, b) => b.pnl - a.pnl), [lifetimeFiltered]);
  const losers = useMemo(() => [...lifetimeFiltered].filter((p) => p.pnl < 0).sort((a, b) => a.pnl - b.pnl), [lifetimeFiltered]);
  const ranking = rankMode === "profit" ? winners.slice(0, 5) : losers.slice(0, 5);
  const maxRank = Math.max(...ranking.map((row) => Math.abs(row.pnl)), 1);

  const rows = detailMode === "profit" ? winners : losers;

  // 每日组合 USD 资产 → 日盈亏 / 收益率 / 总资产趋势（按传入的持仓子集计算）
  // 同时按订单轨迹跟踪持仓数量与现金流，产出时间加权 timeIndex（与资产分析页口径一致）
  const buildDailyAsset = useCallback(
    (rows: PnlRow[]) => {
    const byId = new Map(rows.map((p) => [p.id, p]));
    const recordItems = Object.entries(closesMap)
      .map(([id, items]) => ({
        id,
        first: items.length > 0 ? Number(items[0].c) || 0 : 0,
        map: new Map(items.map((it) => [it.d, Number(it.c)]))
      }))
      .filter((row) => byId.has(row.id) && row.first > 0);
    const dates = [...new Set(recordItems.flatMap((row) => [...row.map.keys()]))].sort();
    // 每只持仓沿用「最近一个有效收盘价」：首日用各自首个有效收盘价回填（与资产分析页口径一致），
    // 避免不同股票起始交易日不一致时前几日只计入少数股票、资产从很小的值起步，
    // 把区间收益率算爆（如 80000%）且基准线被压成直线。
    const last = new Map<string, number>();
    recordItems.forEach(({ id, first }) => {
      last.set(id, first);
    });
    // 订单 → 每只持仓数量轨迹 + 每日现金流（时间加权）
    const ordersByRecord = new Map<string, TradeOrder[]>();
    const flowByDate = new Map<string, number>();
    orders.forEach((order) => {
      if (order.status !== "filled") return;
      const rec = byId.get(order.recordId);
      if (!rec) return;
      const list = ordersByRecord.get(order.recordId) || [];
      list.push(order);
      ordersByRecord.set(order.recordId, list);
      const date = marketDate(order.tradedAt, order.market);
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
    // 现金流游标：非交易日（周末等）的成交现金流归入下一个交易日，避免被丢
    const flowDates = [...flowByDate.keys()].sort();
    let flowCursor = 0;
    let pendingFlow = 0;
    const out: { date: string; asset: number; actual: number; flow: number; timeIndex: number }[] = [];
    dates.forEach((date) => {
      // 本交易日应计入的现金流：非交易日（周末等）成交归入下一个交易日，避免被丢
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
        // 时间加权：按订单轨迹推进实际持仓数量
        const state = quantityState.get(id);
        if (!state) return;
        while (state.cursor < state.orders.length && marketDate(state.orders[state.cursor].tradedAt, state.orders[state.cursor].market) <= date) {
          state.qty = Number(state.orders[state.cursor].positionQtyAfter) || 0;
          state.cursor += 1;
        }
        actualAsset += (close * state.qty) / (rate || 1);
      });
      if (previousActualAsset > 0) {
        // 日收益率用「当日现金流」而非累计现金流：资产分析页同口径，避免累计扣减把曲线压成 -100% 假深坑
        const dailyReturn = (actualAsset - thisDayFlow) / previousActualAsset - 1;
        if (Number.isFinite(dailyReturn) && dailyReturn > -1) timeIndex *= 1 + dailyReturn;
      }
      if (actualAsset > 0) previousActualAsset = actualAsset;
      if (asset > 0) out.push({ date, asset, actual: actualAsset, flow: pendingFlow, timeIndex });
    });
    return out;
    },
    [closesMap, rates, orders]
  );
  const dailyAsset = useMemo(() => buildDailyAsset(positionsFiltered), [buildDailyAsset, positionsFiltered]);
  const calDailyAsset = useMemo(() => buildDailyAsset(calPositions), [buildDailyAsset, calPositions]);

  // 周期筛选：按所选区间截取日资产序列
  const periodStart = useMemo(() => {
    const now = new Date();
    const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    switch (period) {
      case "本月": return iso(now).slice(0, 7) + "-01";
      case "近 1 月": { const d = new Date(now); d.setMonth(d.getMonth() - 1); return iso(d); }
      case "近 6 月": { const d = new Date(now); d.setMonth(d.getMonth() - 6); return iso(d); }
      case "本年": return `${now.getFullYear()}-01-01`;
      case "近 1 年": { const d = new Date(now); d.setFullYear(d.getFullYear() - 1); return iso(d); }
      default: return "";
    }
  }, [period]);

  const dailyAssetFiltered = useMemo(
    () => (periodStart ? dailyAsset.filter((p) => p.date >= periodStart) : dailyAsset),
    [dailyAsset, periodStart]
  );

  const chartPoints = useMemo<PnlTrendPoint[]>(() => {
    const benchMap = new Map(benchCloses.map((it) => [it.d, it.c]));
    // 基准首值回填：基准数据起始日晚于组合首日时，首个点若为 0，
    // PnlTrendChart 的 startBench 会回退成 1，把基准线算成几万%（如 600/1-1）。
    let lastBench = benchCloses.length > 0 ? Number(benchCloses[0].c) || 0 : 0;
    return dailyAssetFiltered.map(({ date, asset, timeIndex }) => {
      const next = benchMap.get(date);
      if (next !== undefined) lastBench = next;
      return { date, asset, benchmark: lastBench, timeIndex };
    });
  }, [dailyAssetFiltered, benchCloses]);

  // 跑赢幅度 = 我的组合区间收益率 − 基准区间收益率（与资产分析页口径一致；时间加权用 timeIndex）
  const myTrendReturn = useMemo(() => {
    if (chartPoints.length < 2) return 0;
    if (weighting === "time") {
      const first = chartPoints[0].timeIndex;
      const last = chartPoints[chartPoints.length - 1].timeIndex;
      return first > 0 ? (last / first - 1) * 100 : 0;
    }
    const first = chartPoints[0].asset;
    const last = chartPoints[chartPoints.length - 1].asset;
    return first > 0 ? (last / first - 1) * 100 : 0;
  }, [chartPoints, weighting]);
  const benchTrendReturn = useMemo(() => {
    const vals = chartPoints.filter((p) => p.benchmark > 0);
    if (vals.length < 2) return 0;
    return (vals[vals.length - 1].benchmark / vals[0].benchmark - 1) * 100;
  }, [chartPoints]);
  const benchDiff = myTrendReturn - benchTrendReturn;

  // 全部：累计账本盈亏；其余周期：期末实际资产 − 期初实际资产 − 区间净流入。
  // 使用筛选区间之前的最后一个交易日作基线，避免所有周期误用同一个累计总额。
  const periodMetrics = useMemo(() => {
    if (period === "全部" || dailyAssetFiltered.length === 0) return { pnl: totalPnl, rate: returnPct };
    const first = dailyAssetFiltered[0];
    const last = dailyAssetFiltered[dailyAssetFiltered.length - 1];
    const firstIndex = dailyAsset.findIndex((item) => item.date === first.date);
    const baseline = firstIndex > 0 ? dailyAsset[firstIndex - 1] : first;
    const pnl = last.actual - baseline.actual - (last.flow - baseline.flow);
    const rate = baseline.timeIndex > 0 ? (last.timeIndex / baseline.timeIndex - 1) * 100 : 0;
    return {
      pnl: Number.isFinite(pnl) ? pnl : 0,
      rate: Number.isFinite(rate) ? rate : 0
    };
  }, [period, dailyAsset, dailyAssetFiltered, totalPnl, returnPct]);
  const periodPnl = periodMetrics.pnl;
  const periodRate = periodMetrics.rate;

  const calDays = useMemo(() => {
    const y = calMonth.y;
    const m = calMonth.m;
    const prefix = `${y}-${String(m).padStart(2, "0")}`;
    const daysInMonth = new Date(y, m, 0).getDate();
    const firstWeekday = new Date(y, m - 1, 1).getDay();
    const prevAsset = new Map<string, number>();
    calDailyAsset.forEach((p, i) => {
      if (i > 0) prevAsset.set(p.date, calDailyAsset[i - 1].asset);
    });
    const cells: ({ day: number; pnl: number; pct: number | null } | null)[] = Array.from({ length: firstWeekday }, () => null);
    for (let day = 1; day <= daysInMonth; day += 1) {
      const date = `${prefix}-${String(day).padStart(2, "0")}`;
      const asset = calDailyAsset.find((p) => p.date === date)?.asset;
      const prev = prevAsset.get(date);
      if (asset == null || prev == null) {
        cells.push({ day, pnl: 0, pct: null });
      } else {
        const pnl = asset - prev;
        cells.push({ day, pnl, pct: prev ? (pnl / prev) * 100 : null });
      }
    }
    return cells;
  }, [calMonth, calDailyAsset]);

  // 年视图：展示所选年份每个月的收益 / 收益率（收益=当月日盈亏合计，收益率=相对上月月末资产）
  const yearSummary = useMemo(() => {
    const y = calMonth.y;
    return Array.from({ length: 12 }, (_, i) => i + 1).map((m) => {
      const prefix = `${y}-${String(m).padStart(2, "0")}`;
      const monthStart = `${prefix}-01`;
      let base: number | null = null;
      let prev: number | null = null;
      let pnl = 0;
      for (const p of calDailyAsset) {
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
      return { m, pnl, pct, active: calMonth.m === m };
    });
  }, [calMonth, calDailyAsset]);

  // 收益日历某天 → 每只股票的当日盈亏（当日收盘 − 前一日收盘）× 数量，按日历市场筛选，USD
  const openDayDetail = (date: string) => {
    const rows: DayStockRow[] = [];
    calPositions.forEach((p) => {
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
    if (rows.length === 0) return;
    // 某天全盈利或全亏损时，默认打开有数据的页签
    setDayDetailMode(rows.some((r) => r.pnl > 0) ? "profit" : "loss");
    setDayDetail({ date, rows });
  };

  const updatedAt = new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
  const dateRange = klineLoading
    ? ""
    : dailyAssetFiltered.length > 1
      ? `${dailyAssetFiltered[0].date.replace(/-/g, "/")} - ${dailyAssetFiltered[dailyAssetFiltered.length - 1].date.replace(/-/g, "/")}`
      : "暂无数据";

  const shiftMonth = (delta: number) =>
    setCalMonth(({ y, m }) => {
      const total = y * 12 + (m - 1) + delta;
      return { y: Math.floor(total / 12), m: (total % 12) + 1 };
    });

  // 分享截图：把第一块卡片（盈亏总额卡片）渲染成 PNG
  const renderShareCard = async () => {
    const card = cardRef.current;
    if (!card) throw new Error("卡片尚未准备好");
    if (document.fonts?.ready) await document.fonts.ready;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const { default: html2canvas } = await loadHtml2canvas();
    return html2canvas(card, {
      backgroundColor: null,
      width: card.offsetWidth,
      height: card.offsetHeight,
      scale: 3,
      useCORS: true,
      logging: false
    });
  };

  const openShare = async () => {
    if (shareBusy) return;
    setShareBusy("render");
    showToast("正在生成分享图…");
    try {
      const canvas = await renderShareCard();
      setShareImage(canvas.toDataURL("image/png"));
      setShareOpen(true);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "生成失败", "err");
    } finally {
      setShareBusy(null);
    }
  };

  const copyShare = async () => {
    if (shareBusy || !shareImage) return;
    setShareBusy("copy");
    showToast("正在生成图片…");
    try {
      const blob = dataUrlToBlob(shareImage);
      if (window.isSecureContext && navigator.clipboard?.write) {
        try {
          await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
          showToast("已复制图片");
          return;
        } catch { /* 局域网环境使用服务端剪贴板兜底 */ }
      }
      const response = await fetch("/api/clipboard", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image: shareImage }) });
      if (!response.ok) throw new Error("复制失败，请改用保存图片");
      showToast("已复制图片");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "复制失败", "err");
    } finally {
      setShareBusy(null);
    }
  };

  const saveShare = async () => {
    if (shareBusy || !shareImage) return;
    setShareBusy("save");
    try {
      const link = document.createElement("a");
      link.href = shareImage;
      link.download = `盈亏总额-${new Date().toISOString().slice(0, 10)}.png`;
      link.click();
      showToast("分享图已保存");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "保存失败", "err");
    } finally {
      setShareBusy(null);
    }
  };

  return (
    <div className="w-full max-w-[760px]">
      {/* 页面标题行（取消大卡片模式：普通页面流式布局，与资产分析页一致） */}
      <div className="flex items-center gap-3">
        {onBack && (
          <button type="button" onClick={onBack} aria-label="返回资产分析" className="grid h-10 w-10 place-items-center rounded-full border border-edge bg-white shadow-sm transition hover:-translate-x-1"><BackIcon /></button>
        )}
        <div><h1 className="text-xl font-bold tracking-tight">资产盈亏分析</h1><p className="mt-0.5 text-xs text-muted">更新至 {updatedAt}</p></div>
      </div>

      <div className="mt-3 mb-4 flex items-center gap-3">
        <div className="flex min-w-0 items-center gap-3 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {["本月", "近 1 月", "近 6 月", "本年", "近 1 年", "全部"].map((item) => (
            <button key={item} onClick={() => setPeriod(item)} className={`flex-none rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${period === item ? "border-[#3297f6] bg-[#3297f6]/15 text-[#3297f6] shadow-sm" : "border-edge text-muted hover:bg-bg-gray"}`}>{item}</button>
          ))}
        </div>
        {/* 市场筛选按钮：紧跟「全部」右侧（在滚动容器外，下拉不被裁剪） */}
        <div className="relative flex-none">
          <button
            type="button"
            onClick={() => setMarketMenuOpen((open) => !open)}
            title={`市场：${market}`}
            aria-label="选择市场"
            className={`grid h-8 w-8 flex-none place-items-center rounded-full border transition ${marketMenuOpen ? "border-edge-strong bg-bg-gray text-ink-2" : "border-edge text-muted hover:bg-bg-gray hover:text-ink-2"}`}
          >
            <FilterIcon />
          </button>
          {marketMenuOpen && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setMarketMenuOpen(false)} />
              <div className="absolute right-0 top-full z-40 mt-1 w-32 overflow-hidden rounded-xl border border-edge-strong bg-white p-1 shadow-pop">
                {(["全部", "美股", "港股", "A股"] as const).map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => {
                      setMarket(item);
                      setMarketMenuOpen(false);
                    }}
                    className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm transition ${market === item ? "bg-bg-gray font-semibold text-ink" : "text-ink hover:bg-bg-gray"}`}
                  >
                    {item === "全部" ? (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4">
                        <rect x="3.5" y="3.5" width="7" height="7" rx="1.8" />
                        <rect x="13.5" y="3.5" width="7" height="7" rx="1.8" />
                        <rect x="3.5" y="13.5" width="7" height="7" rx="1.8" />
                        <rect x="13.5" y="13.5" width="7" height="7" rx="1.8" />
                      </svg>
                    ) : (
                      <MarketIcon market={item === "美股" ? "US" : item === "港股" ? "HK" : "CN"} size={16} />
                    )}
                    {item}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

        {loadError && records.length === 0 ? (
          <div className="card flex min-h-[260px] flex-col items-center justify-center gap-3 text-center">
            <p className="text-sm font-semibold text-ink-2">{loadError}</p>
            <p className="text-xs text-muted">请检查网络或登录状态后重试</p>
            <button type="button" onClick={() => setReloadKey((key) => key + 1)} className="btn btn-line btn-sm">重新加载</button>
          </div>
        ) : loading ? (
          <div className="grid gap-5">
            <div className="h-[380px] animate-pulse rounded-card bg-bg-gray" />
            <div className="h-[380px] animate-pulse rounded-card bg-bg-gray" />
          </div>
        ) : (
          <>
            <section>
              <article ref={cardRef} className="card p-5">
                {/* 标题行：盈亏总额（货币下拉）+ 分享截图 */}
                <div className="flex items-center justify-between gap-3">
                  <div className="relative flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setCurrencyMenuOpen((open) => !open)}
                      aria-expanded={currencyMenuOpen}
                      title="切换货币"
                      className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink-2 transition-colors hover:text-ink"
                    >
                      <CurrencyFlag market={curOption.market} size={15} />
                      盈亏总额 ({displayCurrency})
                      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" className={`h-3 w-3 transition-transform ${currencyMenuOpen ? "rotate-180" : ""}`}><path d="m5 7 5 5 5-5" /></svg>
                    </button>
                    {currencyMenuOpen && (
                      <>
                        <div className="fixed inset-0 z-30" onClick={() => setCurrencyMenuOpen(false)} />
                        <div className="absolute left-0 top-full z-40 mt-1 min-w-[150px] overflow-hidden rounded-xl border border-edge-strong bg-white p-1.5 shadow-pop">
                          {CURRENCIES.map((option) => (
                            <button
                              key={option.code}
                              type="button"
                              onClick={() => {
                                setDisplayCurrency(option.code);
                                setCurrencyMenuOpen(false);
                              }}
                              className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-xs transition ${displayCurrency === option.code ? "bg-[#3297f6]/15 font-bold text-[#3297f6]" : "text-ink hover:bg-bg-gray"}`}
                            >
                              <span className="flex items-center gap-2"><CurrencyFlag market={option.market} size={15} />{option.label}</span>
                              <small className="text-muted">{option.code}</small>
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => void openShare()}
                    disabled={shareBusy !== null}
                    title={shareBusy === "render" ? "正在生成分享图…" : "分享截图"}
                    aria-label="分享截图"
                    className="grid h-9 w-9 flex-none place-items-center rounded-lg border border-edge text-muted transition hover:border-edge-strong hover:text-ink-2 disabled:opacity-50"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><circle cx="18" cy="5" r="2.2" /><circle cx="6" cy="12" r="2.2" /><circle cx="18" cy="19" r="2.2" /><path d="m8 11 8-5M8 13l8 5" /></svg>
                  </button>
                </div>

                {/* 盈亏总额大数字 / 收益率 / 日期（居中，对齐图1） */}
                <div className="mt-4 text-center">
                  <p className={`text-3xl font-extrabold tracking-tight tabular-nums ${periodPnl >= 0 ? "text-up" : "text-down"}`}>{moneyDisp(periodPnl)}</p>
                  <p className={`mt-2 text-lg font-bold ${periodRate >= 0 ? "text-up" : "text-down"}`}>{periodRate >= 0 ? "+" : ""}{periodRate.toFixed(2)}%</p>
                  <p className="mt-1.5 text-xs text-muted">{dateRange}</p>
                  {period === "全部" ? (
                    <p className="mt-2 text-[11px] text-muted">
                      已实现 <span className={realizedPnlTotal >= 0 ? "text-up" : "text-down"}>{moneyDisp(realizedPnlTotal)}</span>
                      <span className="mx-2 text-faint">·</span>
                      未实现 <span className={unrealizedPnlTotal >= 0 ? "text-up" : "text-down"}>{moneyDisp(unrealizedPnlTotal)}</span>
                    </p>
                  ) : (
                    <p className="mt-2 text-[11px] text-muted">区间盈亏已扣除买卖资金净流入</p>
                  )}
                </div>

                {/* 收益率走势 / 总资产趋势（资产分析-账户资产-收益率趋势图同款下划线 tab） */}
                <div className="mt-5 flex items-end gap-6 border-b border-edge">
                  {([["return", "收益率走势"], ["asset", "总资产趋势"]] as const).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setChartTab(key)}
                      className={`relative px-0.5 pb-2.5 transition-colors ${chartTab === key ? "text-[15px] font-bold text-ink" : "text-sm font-medium text-muted hover:text-ink"}`}
                    >
                      {label}
                      {chartTab === key && <i className="absolute inset-x-1 bottom-0 h-[2px] rounded-full bg-[#3297f6]" />}
                    </button>
                  ))}
                </div>

                {/* 跑赢基准条（多市场下拉，资产分析同款）+ 简单加权 */}
                <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-bg-gray px-3 py-2 text-xs">
                  <div className="relative">
                    <button
                      type="button"
                      onClick={() => setBenchOpen((open) => !open)}
                      aria-expanded={benchOpen}
                      title="切换基准市场"
                      className="inline-flex items-center gap-1.5 text-ink-2 transition-colors hover:text-ink"
                    >
                      <i className="h-2 w-2 rounded-full bg-[#ef5b19]" />
                      <span className="font-semibold">我的</span>
                      <i className="ml-2 h-2 w-2 rounded-full bg-[#4a90d9]" />
                      <span className="font-semibold">{benchLabel}</span>
                      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" className={`h-3 w-3 text-muted transition-transform ${benchOpen ? "rotate-180" : ""}`}><path d="m5 7 5 5 5-5" /></svg>
                      <b className={`tabular-nums ${benchDiff >= 0 ? "text-up" : "text-down"}`}>{benchDiff >= 0 ? "+" : ""}{benchDiff.toFixed(2)}%</b>
                    </button>
                    {benchOpen && (
                      <>
                        <div className="fixed inset-0 z-30" onClick={() => setBenchOpen(false)} />
                        <div className="absolute left-0 top-full z-40 mt-1 min-w-[150px] overflow-hidden rounded-xl border border-edge bg-white p-1 shadow-xl">
                          {BENCHMARKS.map((bench) => (
                            <button
                              key={bench.key}
                              type="button"
                              onClick={() => {
                                setBenchKey(bench.key);
                                setBenchOpen(false);
                                try { localStorage.setItem("fire:asset-pnl-bench", bench.key); } catch { /* 忽略 */ }
                              }}
                              className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-xs transition ${benchKey === bench.key ? "bg-[#3297f6]/15 font-bold text-[#3297f6]" : "text-ink hover:bg-bg-gray"}`}
                            >
                              <span>{bench.label}</span>
                              {benchKey === bench.key && <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3"><path d="m2.4 6.4 2.5 2.5 4.7-5.8" /></svg>}
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                  <div className="relative">
                    <button
                      type="button"
                      onClick={() => setWeightOpen((open) => !open)}
                      aria-expanded={weightOpen}
                      title="加权方式"
                      className="inline-flex items-center gap-1 text-muted transition-colors hover:text-ink-2"
                    >
                      {weighting === "simple" ? "简单加权" : "时间加权"}
                      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" className={`h-3 w-3 transition-transform ${weightOpen ? "rotate-180" : ""}`}><path d="m5 7 5 5 5-5" /></svg>
                    </button>
                    {weightOpen && (
                      <>
                        <div className="fixed inset-0 z-30" onClick={() => setWeightOpen(false)} />
                        <div className="absolute right-0 top-full z-40 mt-1 min-w-[140px] overflow-hidden rounded-xl border border-edge-strong bg-white p-1 shadow-pop">
                          {WEIGHT_OPTIONS.map(([key, label]) => (
                            <button
                              key={key}
                              type="button"
                              onClick={() => {
                                setWeighting(key);
                                setWeightOpen(false);
                                try { localStorage.setItem("fire:asset-pnl-weighting", key); } catch { /* 忽略 */ }
                              }}
                              className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-xs transition ${weighting === key ? "bg-[#3297f6]/15 font-bold text-[#3297f6]" : "text-ink hover:bg-bg-gray"}`}
                            >
                              <span>{label}</span>
                              {weighting === key && <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3"><path d="m2.4 6.4 2.5 2.5 4.7-5.8" /></svg>}
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                </div>

                {/* 图表（资产分析-账户资产-收益率趋势图同款 PnlTrendChart） */}
                {klineLoading && chartPoints.length < 2 ? (
                  <div className="mt-4 flex h-[330px] flex-col justify-center gap-4 rounded-2xl bg-bg-gray px-10">
                    {[92, 78, 64, 50].map((width, i) => (
                      <div key={i} className="h-4 animate-pulse rounded bg-white/50 dark:bg-white/10" style={{ width: `${width}%` }} />
                    ))}
                  </div>
                ) : (
                  <div className="mt-4">
                    <PnlTrendChart points={chartPoints} tab={chartTab} weighting={weighting} benchLabel={benchLabel} />
                  </div>
                )}
              </article>

            </section>

            <section className="mt-5 grid gap-5 xl:grid-cols-2">
              <article className="card p-5">
                <div className="flex items-center justify-between"><h2 className="text-base font-bold">全部盈亏排行榜</h2><span className="text-xs text-muted">更新至 {updatedAt.slice(5).replace("/", ".")}</span></div>
                <div className="mt-5 grid grid-cols-2 rounded-full bg-bg-gray p-1">
                  <button onClick={() => setRankMode("profit")} className={`rounded-full py-2.5 font-semibold ${rankMode === "profit" ? "bg-white shadow-sm" : "text-muted"}`}>盈利 Top5</button>
                  <button onClick={() => setRankMode("loss")} className={`rounded-full py-2.5 font-semibold ${rankMode === "loss" ? "bg-white shadow-sm" : "text-muted"}`}>亏损 Top5</button>
                </div>
                <div className="mt-5 space-y-2">
                  {ranking.length === 0 && <p className="py-8 text-center text-sm text-muted">暂无数据</p>}
                  {ranking.map((row, index) => (
                    <div key={row.id} className="relative flex min-h-16 items-center overflow-hidden rounded-xl px-4">
                      <div className={`absolute inset-y-0 right-0 rounded-xl ${rankMode === "profit" ? "bg-up-bg" : "bg-down-bg"}`} style={{ width: `${Math.max(20, Math.abs(row.pnl) / maxRank * 100)}%` }} />
                      <span className="relative mr-3 w-6 flex-none text-xs text-muted">{String(index + 1).padStart(2, "0")}</span>
                      <div className="relative flex min-w-0 flex-1 items-center gap-2">
                        <AdaptivePnlIdentity row={row} />
                      </div>
                      <strong className={`relative ml-3 max-w-[42%] flex-none text-right text-xs tabular-nums ${row.pnl >= 0 ? "text-up" : "text-down"}`}>{moneyDisp(row.pnl)}</strong>
                    </div>
                  ))}
                </div>
              </article>

              <article className="card p-5">
                <div className="flex items-center justify-between"><h2 className="text-base font-bold">股票盈亏明细</h2><span className="text-xs text-muted">{rows.length} 只</span></div>
                <div className="mt-5 grid grid-cols-2 rounded-full bg-bg-gray p-1">
                  <button onClick={() => setDetailMode("profit")} className={`rounded-full py-2.5 font-semibold ${detailMode === "profit" ? "bg-white shadow-sm" : "text-muted"}`}>盈利</button>
                  <button onClick={() => setDetailMode("loss")} className={`rounded-full py-2.5 font-semibold ${detailMode === "loss" ? "bg-white shadow-sm" : "text-muted"}`}>亏损</button>
                </div>
                <div className="mt-5 divide-y divide-edge">
                  {rows.length === 0 && <p className="py-8 text-center text-sm text-muted">暂无数据</p>}
                  {rows.map((row, index) => (
                    <div key={row.id} className="flex items-center gap-4 py-3">
                      <span className="w-6 text-xs text-muted">{String(index + 1).padStart(2, "0")}</span>
                      <PnlStockIcon src={stockIcons[`${row.market.toUpperCase()}:${row.code.toUpperCase()}`]} name={row.name} />
                      <div className="min-w-0 flex-1"><AdaptivePnlIdentity row={row} /></div>
                      <strong className={`ml-2 max-w-[42%] flex-none text-right text-xs tabular-nums ${row.pnl >= 0 ? "text-up" : "text-down"}`}>{moneyDisp(row.pnl)}</strong>
                    </div>
                  ))}
                </div>
              </article>
            </section>

            <section className="mt-5 card p-5">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <h2 className="text-base font-bold">收益日历</h2>
                  <div className="flex items-center gap-1">
                    <button onClick={() => shiftMonth(-1)} className="grid h-7 w-7 place-items-center rounded-full border border-edge text-muted hover:bg-bg-gray" aria-label="上个月"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5"><path d="m15 18-6-6 6-6" /></svg></button>
                    <button onClick={() => shiftMonth(1)} className="grid h-7 w-7 place-items-center rounded-full border border-edge text-muted hover:bg-bg-gray" aria-label="下个月"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5"><path d="m9 18 6-6-6-6" /></svg></button>
                    <DateSelectButton
                      year={calMonth.y}
                      month={calMonth.m}
                      label={`${calMonth.y}/${String(calMonth.m).padStart(2, "0")}`}
                      onSelect={(y, m) => {
                        setCalMonth({ y, m });
                        setCalMenuOpen(false);
                        try {
                          localStorage.setItem("fire:asset-pnl-cal-month", JSON.stringify({ y, m }));
                        } catch {
                          /* 忽略 */
                        }
                      }}
                    />
                    <div className="relative ml-1">
                      <button
                        type="button"
                        onClick={() => {
                          setCalMenuOpen((open) => !open);
                        }}
                        title={`市场：${calMarket}`}
                        aria-label="选择日历市场"
                        className={`grid h-8 w-8 place-items-center rounded-full border transition ${calMenuOpen ? "border-edge-strong bg-bg-gray text-ink-2" : "border-edge text-muted hover:bg-bg-gray hover:text-ink-2"}`}
                      >
                        {calMarket === "全部" ? (
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4">
                            <rect x="3.5" y="3.5" width="7" height="7" rx="1.8" />
                            <rect x="13.5" y="3.5" width="7" height="7" rx="1.8" />
                            <rect x="3.5" y="13.5" width="7" height="7" rx="1.8" />
                            <rect x="13.5" y="13.5" width="7" height="7" rx="1.8" />
                          </svg>
                        ) : (
                          <MarketIcon market={calMarket === "美股" ? "US" : calMarket === "港股" ? "HK" : "CN"} size={17} />
                        )}
                      </button>
                      {calMenuOpen && (
                        <>
                          <div data-drag-skip className="fixed inset-0 z-30" onClick={() => setCalMenuOpen(false)} />
                          <div data-drag-skip className="absolute right-0 top-full z-40 mt-1 w-32 overflow-hidden rounded-xl border border-edge-strong bg-white p-1 shadow-pop">
                            {(["全部", "美股", "港股", "A股"] as const).map((item) => (
                              <button
                                key={item}
                                type="button"
                                onClick={() => {
                                  setCalMarket(item);
                                  try {
                                    localStorage.setItem("fire:asset-pnl-cal-market", item);
                                  } catch {
                                    /* 忽略 */
                                  }
                                  setCalMenuOpen(false);
                                }}
                                className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm transition ${calMarket === item ? "bg-bg-gray font-semibold text-ink" : "text-ink hover:bg-bg-gray"}`}
                              >
                                {item === "全部" ? (
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4">
                                    <rect x="3.5" y="3.5" width="7" height="7" rx="1.8" />
                                    <rect x="13.5" y="3.5" width="7" height="7" rx="1.8" />
                                    <rect x="3.5" y="13.5" width="7" height="7" rx="1.8" />
                                    <rect x="13.5" y="13.5" width="7" height="7" rx="1.8" />
                                  </svg>
                                ) : (
                                  <MarketIcon market={item === "美股" ? "US" : item === "港股" ? "HK" : "CN"} size={16} />
                                )}
                                {item}
                              </button>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <div className="flex rounded-full bg-bg-gray p-1 text-sm">
                    <button onClick={() => setCalView("year")} className={`rounded-full px-5 py-2 font-semibold transition ${calView === "year" ? "bg-white shadow-sm" : "text-muted hover:text-ink-2"}`}>年</button>
                    <button onClick={() => setCalView("month")} className={`rounded-full px-5 py-2 font-semibold transition ${calView === "month" ? "bg-white shadow-sm" : "text-muted hover:text-ink-2"}`}>月</button>
                  </div>
                  <div className="flex rounded-full bg-bg-gray p-1 text-sm">
                    <button onClick={() => setCalendarMode("收益")} className={`rounded-full px-5 py-2 font-semibold transition ${calendarMode === "收益" ? "bg-white shadow-sm" : "text-muted hover:text-ink-2"}`}>收益</button>
                    <button onClick={() => setCalendarMode("收益率")} className={`rounded-full px-5 py-2 font-semibold transition ${calendarMode === "收益率" ? "bg-white shadow-sm" : "text-muted hover:text-ink-2"}`}>收益率</button>
                  </div>
                </div>
              </div>
              {klineLoading && calDays.every((c) => !c || c.pnl === 0) ? (
                <div className="mt-4 grid grid-cols-7 gap-2" aria-hidden>
                  {Array.from({ length: 28 }).map((_, i) => (
                    <div key={i} className="h-16 animate-pulse rounded-xl bg-bg-gray" />
                  ))}
                </div>
              ) : (
                <>
                  {calView === "year" ? (
                    <div className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-4">
                      {yearSummary.map(({ m, pnl, pct, active }) => (
                        <button
                          key={m}
                          type="button"
                          onClick={() => {
                            setCalMonth({ y: calMonth.y, m });
                            setCalView("month");
                            try {
                              localStorage.setItem("fire:asset-pnl-cal-month", JSON.stringify({ y: calMonth.y, m }));
                            } catch {
                              /* 忽略 */
                            }
                          }}
                          className={`flex min-h-20 flex-col items-center justify-center rounded-xl border transition ${active ? "border-up bg-up-bg" : "border-edge hover:border-edge-strong"} ${pnl > 0 ? "text-up" : pnl < 0 ? "text-down" : "text-muted"}`}
                        >
                          <b className="text-sm text-ink">{m}月</b>
                          {pnl !== 0 && (
                            <span className="mt-2 text-xs font-semibold sm:text-sm">
                              {calendarMode === "收益" ? compactDisp(pnl) : pct != null ? `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%` : "—"}
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <>
                      <div className="mt-4 grid grid-cols-7 text-center text-xs font-semibold text-muted">{["日", "一", "二", "三", "四", "五", "六"].map((day) => <span key={day}>{day}</span>)}</div>
                      <div className="mt-3 grid grid-cols-7 gap-1 sm:gap-2">
                        {calDays.map((cell, index) =>
                          cell ? (
                            <button
                              key={index}
                              type="button"
                              onClick={() => openDayDetail(`${calMonth.y}-${String(calMonth.m).padStart(2, "0")}-${String(cell.day).padStart(2, "0")}`)}
                              title="点击查看当日每只股票盈亏"
                              className={`flex min-h-20 flex-col items-center justify-center rounded-xl transition hover:ring-1 hover:ring-edge-strong ${cell.pnl > 0 ? "bg-up-bg text-up" : cell.pnl < 0 ? "bg-down-bg text-down" : "text-muted hover:bg-bg-gray"}`}
                            >
                              <b className="text-sm text-ink">{String(cell.day).padStart(2, "0")}</b>
                              {calendarMode === "收益" ? (
                                cell.pnl !== 0 && <span className="mt-2 text-xs font-semibold sm:text-sm">{compactDisp(cell.pnl)}</span>
                              ) : (
                                cell.pct != null && cell.pnl !== 0 && <span className="mt-2 text-xs font-semibold sm:text-sm">{cell.pct >= 0 ? "+" : ""}{cell.pct.toFixed(2)}%</span>
                              )}
                            </button>
                          ) : (
                            <span key={index} />
                          )
                        )}
                      </div>
                    </>
                  )}
                </>
              )}
            </section>

            <section className="mt-5 card p-5">
              <div className="flex items-center justify-between"><h2 className="text-base font-bold">全部盈亏总结</h2><span className="text-xs text-muted">更新至 {updatedAt.slice(5).replace("/", ".")}</span></div>
              <div className="mt-5 flex gap-2">
                {["全部", "美股", "港股", "A股"].map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => setMarket(item)}
                    className={`flex-none rounded-full border px-3.5 py-1.5 text-xs font-semibold transition-colors ${market === item ? "border-edge-strong bg-white shadow-sm" : "bg-bg-gray text-muted hover:text-ink-2"}`}
                  >
                    {item}
                  </button>
                ))}
              </div>
              <div className="mt-6 flex items-end justify-between"><span className="text-sm text-muted">股票累计盈亏</span><strong className={`text-xl font-extrabold tracking-tight ${totalPnl >= 0 ? "text-up" : "text-down"}`}>{moneyDisp(totalPnl)}</strong></div>
              <div className="mt-5 grid grid-cols-2 overflow-hidden rounded-2xl text-white">
                <div className="bg-gradient-to-br from-[#ff6a21] to-[#ff4f08] p-5">
                  <span className="text-xs text-white/70">盈利 ↗</span>
                  <p className="mt-5 line-clamp-2 break-words font-semibold">{winners[0] ? `${winners[0].name}.${winners[0].market}` : "—"}</p>
                  <p className="text-base font-bold">{winners[0] ? moneyDisp(winners[0].pnl) : "—"}</p>
                </div>
                <div className="bg-gradient-to-br from-[#19c5a7] to-[#00aa91] p-5 text-right">
                  <span className="text-xs text-white/70">↘ 亏损</span>
                  <p className="mt-5 line-clamp-2 break-words font-semibold">{losers[0] ? `${losers[0].name}.${losers[0].market}` : "—"}</p>
                  <p className="text-base font-bold">{losers[0] ? moneyDisp(losers[0].pnl) : "—"}</p>
                </div>
              </div>
            </section>
          </>
        )}

        {/* 收益日历-每日股票盈亏明细弹窗（点击日历某天弹出，样式对齐全部盈亏排行榜） */}
        {dayDetail && (() => {
          const profitRows = dayDetail.rows.filter((r) => r.pnl > 0);
          const lossRows = dayDetail.rows.filter((r) => r.pnl < 0).slice().sort((a, b) => a.pnl - b.pnl);
          const shownRows = dayDetailMode === "profit" ? profitRows : lossRows;
          const shownTotal = shownRows.reduce((sum, r) => sum + r.pnl, 0);
          return (
            <div className="fixed inset-0 z-[10002] flex items-center justify-center bg-black/50 p-6">
              <div className="flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-card border border-edge bg-white shadow-2xl">
                <div className="flex items-center justify-between border-b border-edge px-5 py-4">
                  <div>
                    <h3 className="text-base font-bold">当日盈亏 · {dayDetail.date.replace(/-/g, "/")}</h3>
                    <p className="mt-0.5 text-xs text-muted">{profitRows.length} / {lossRows.length}</p>
                  </div>
                  <button type="button" onClick={() => setDayDetail(null)} aria-label="关闭" className="grid h-8 w-8 place-items-center rounded-full text-muted transition hover:bg-bg-gray hover:text-ink-2">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-4 w-4"><path d="m6 6 12 12M18 6 6 18" /></svg>
                  </button>
                </div>
                <div className="px-5 pt-4">
                  <div className="grid grid-cols-2 rounded-full bg-bg-gray p-1">
                    <button onClick={() => setDayDetailMode("profit")} className={`rounded-full py-2.5 font-semibold ${dayDetailMode === "profit" ? "bg-white shadow-sm" : "text-muted"}`}>盈利</button>
                    <button onClick={() => setDayDetailMode("loss")} className={`rounded-full py-2.5 font-semibold ${dayDetailMode === "loss" ? "bg-white shadow-sm" : "text-muted"}`}>亏损</button>
                  </div>
                </div>
                <div className="mt-3 flex-1 space-y-2 overflow-y-auto px-2 pb-2">
                  {shownRows.length === 0 && <p className="py-10 text-center text-sm text-muted">当日暂无{dayDetailMode === "profit" ? "盈利" : "亏损"}持仓</p>}
                  {(() => {
                    const maxRank = Math.max(...shownRows.map((r) => Math.abs(r.pnl)), 1);
                    return shownRows.map((row, index) => (
                      <div key={row.id} className="relative flex min-h-16 items-center overflow-hidden rounded-xl px-4">
                        <div className={`absolute inset-y-0 right-0 rounded-xl ${dayDetailMode === "profit" ? "bg-up-bg" : "bg-down-bg"}`} style={{ width: `${Math.max(20, Math.abs(row.pnl) / maxRank * 100)}%` }} />
                        <span className="relative mr-3 w-6 flex-none text-xs text-muted">{String(index + 1).padStart(2, "0")}</span>
                        <div className="relative flex min-w-0 flex-1 items-center gap-2">
                          <div className="min-w-0">
                            <p className="truncate text-xs font-semibold">{row.name}</p>
                            <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted"><MarketBadge market={row.market} code={row.code} /><span className="truncate">{row.code}</span></p>
                          </div>
                        </div>
                        <strong className={`relative text-xs tabular-nums ${row.pnl >= 0 ? "text-up" : "text-down"}`}>{moneyDisp(row.pnl)}</strong>
                      </div>
                    ));
                  })()}
                </div>
                <div className="flex items-center justify-between border-t border-edge px-5 py-4">
                  <span className="text-xs text-muted">{dayDetailMode === "profit" ? "盈利合计" : "亏损合计"}</span>
                  <strong className={`text-sm font-bold tabular-nums ${shownTotal >= 0 ? "text-up" : "text-down"}`}>{moneyDisp(shownTotal)}</strong>
                </div>
              </div>
            </div>
          );
        })()}

        {/* 分享截图预览弹窗 */}
    {shareOpen && shareImage && (
      <div className="fixed inset-0 z-[10002] flex items-center justify-center bg-black/50 p-6">
        <div className="flex max-h-[92vh] w-full max-w-md flex-col overflow-hidden rounded-card border border-edge bg-white shadow-2xl">
          <div className="flex items-center justify-between border-b border-edge px-5 py-4">
            <h3 className="text-base font-bold">盈亏总额分享图</h3>
            <button type="button" onClick={() => setShareOpen(false)} aria-label="关闭" className="grid h-8 w-8 place-items-center rounded-full text-muted transition hover:bg-bg-gray hover:text-ink-2">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-4 w-4"><path d="m6 6 12 12M18 6 6 18" /></svg>
            </button>
          </div>
          <div className="flex-1 overflow-auto bg-bg-gray p-4">
            <img src={shareImage} alt="盈亏总额分享图" className="w-full rounded-xl" />
          </div>
          <div className="mt-5 flex justify-end gap-2.5 border-t border-edge px-5 py-4">
            <button type="button" onClick={() => void copyShare()} disabled={shareBusy !== null} title={shareBusy === "copy" ? "正在生成" : "复制分享图"} aria-label="复制分享图" className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-edge-strong bg-white px-4 text-[13px] font-semibold text-ink-2 transition-all duration-200 hover:bg-brand-hover hover:-translate-y-px active:scale-[.97] disabled:opacity-50 dark:border-white/10">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg>
              复制图片
            </button>
            <button type="button" onClick={() => void saveShare()} disabled={shareBusy !== null} title={shareBusy === "save" ? "正在生成" : "保存分享图"} aria-label="保存分享图" className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-edge-strong bg-white px-4 text-[13px] font-semibold text-ink-2 transition-all duration-200 hover:bg-brand-hover hover:-translate-y-px active:scale-[.97] disabled:opacity-50 dark:border-white/10">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M12 3v12m0 0 4-4m-4 4-4-4" /><path d="M5 19h14" /></svg>
              保存图片
            </button>
          </div>
        </div>
      </div>
    )}
    </div>
  );
}
