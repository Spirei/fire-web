"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import echarts from "@/lib/echarts";
import CurrencyFlag from "@/components/CurrencyFlag";
import { fmtMoney, fmtMoneyCompact, fmtNumMarket, fmtPct, fmtQty } from "@/lib/format";
import { marketMeta, type Quote, type StockRecord, type TradeOrder } from "@/lib/types";
import { showToast } from "@/lib/toast";
import { HoldingColumnManager, HoldingColumnsButton, useHoldingColumns } from "@/components/HoldingColumnManager";
import { HOLDING_COLUMN_LABELS, type HoldingColumnKey } from "@/lib/holdingColumns";
import { usePersistedState } from "@/lib/usePersistedState";
import { CURRENCIES, CURRENCY_SYMBOLS, useCurrencyDisplayUnit, useDisplayCurrency, type CurrencyCode } from "@/lib/currencyPrefs";
import TradeOrdersPanel from "@/components/TradeOrdersPanel";
import RefreshButton from "@/components/RefreshButton";
import DailyPnlShareModal, { preloadDailyPnlTemplates, waitForDailyPnlTemplates, type DailyPnlShareItem } from "@/components/DailyPnlShareModal";
import PnlTrendChart from "@/components/PnlTrendChart";
import QuickTradeDialog from "@/components/QuickTradeDialog";
import HoldingDividendDialog from "@/components/HoldingDividendDialog";
import { buildPortfolioLedger } from "@/lib/portfolioLedger";
import FundsPanel from "@/components/FundsPanel";
import MarketCodeBadge from "@/components/MarketCodeBadge";
import Pagination from "@/components/Pagination";

type Period = "month" | "1m" | "6m" | "ytd" | "1y" | "all" | "custom";
type ChartTab = "return" | "asset";
const WEIGHT_OPTIONS = [
  ["simple", "收益率·简单加权"],
  ["time", "收益率·时间加权"]
] as const;
interface TrendPoint {
  date: string;
  asset: number;
  benchmark: number;
  timeIndex: number;
  simpleIndex: number;
  pnl: number;
}
interface CloseItem { d: string; c: number }
interface HoldingSort { key: HoldingColumnKey; dir: "asc" | "desc" }
interface DateRange { start: string; end: string }
interface SimpleInvestmentEquity { market: string; cur: CurrencyCode; amount: number }
const EMPTY_CURRENCY_BALANCES: Record<CurrencyCode, number> = { USD: 0, HKD: 0, CNY: 0, SGD: 0, JPY: 0, KRW: 0, EUR: 0 };

function readEffectiveBalanceCache(key: string): Record<CurrencyCode, number> | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "null");
    if (!value || typeof value !== "object") return null;
    return { ...EMPTY_CURRENCY_BALANCES, ...value };
  } catch {
    return null;
  }
}

interface Props {
  positions: StockRecord[];
  quotes: Record<string, Quote>;
  livePrice: (record: StockRecord) => number;
  rates: Record<string, number>;
  currency: "USD" | "CNY" | "HKD";
  stockIcons: Record<string, string>;
  user?: { username?: string; nickname?: string; avatar?: string };
  /** 刷新行情 / 汇率 / 持仓记录（账户资产、持仓刷新按钮调用） */
  onRefreshMarketData?: () => Promise<void>;
  /** 进入资产盈亏分析页 */
  onOpenPnlAnalysis?: () => void;
}

const PERIODS: Array<[Period, string]> = [["month", "本月"], ["1m", "近 1 月"], ["6m", "近 6 月"], ["ytd", "本年"], ["1y", "近 1 年"], ["all", "全部"]];
const ISO_BY_MARKET: Record<string, string> = { US: "USD", HK: "HKD", CN: "CNY", JP: "JPY", KR: "KRW" };
// 基准对比（收益率趋势图）：主要市场指数（日 K 数据源：US/HK 用指数 ETF，CN 用指数代码）
type BenchKey = "spy" | "qqq" | "dia" | "hsi" | "sse" | "szse";
const BENCHMARKS: { key: BenchKey; label: string; market: string; code: string; index?: boolean }[] = [
  { key: "spy", label: "标普 500", market: "US", code: "SPY" },
  { key: "qqq", label: "纳斯达克", market: "US", code: "QQQ" },
  { key: "dia", label: "道琼斯", market: "US", code: "DIA" },
  { key: "hsi", label: "恒生指数", market: "HK", code: "02800", index: true },
  { key: "sse", label: "上证指数", market: "CN", code: "sh000001", index: true },
  { key: "szse", label: "深证成指", market: "CN", code: "sz399001", index: true }
] as const;
const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
const ASSET_SPLIT_STORAGE_KEY = "fire:asset-analysis:split-v1";
const ASSET_SPLIT_MIN = 24;
const ASSET_SPLIT_MAX = 52;
const ASSET_SPLIT_DEFAULT = 29;
const ASSET_TREND_CACHE_KEY = "fire:asset-analysis:trend-cache-v4";
const HOLDINGS_PAGE_SIZE = 10;

function clampSplitPct(value: number) {
  if (!Number.isFinite(value)) return ASSET_SPLIT_DEFAULT;
  return Math.min(ASSET_SPLIT_MAX, Math.max(ASSET_SPLIT_MIN, value));
}

function readSavedSplitPct() {
  try {
    const raw = localStorage.getItem(ASSET_SPLIT_STORAGE_KEY);
    if (raw == null || raw === "") return ASSET_SPLIT_DEFAULT;
    const saved = Number(raw);
    if (!Number.isFinite(saved) || saved < ASSET_SPLIT_MIN || saved > ASSET_SPLIT_MAX) return ASSET_SPLIT_DEFAULT;
    return saved;
  } catch {
    return ASSET_SPLIT_DEFAULT;
  }
}

function splitPaneStyle(pct: number): React.CSSProperties {
  const left = clampSplitPct(pct);
  return {
    "--asset-left-fr": `${left}fr`,
    "--asset-right-fr": `${(100 - left).toFixed(2)}fr`
  } as React.CSSProperties;
}

function trendSignature(positions: StockRecord[]) {
  return positions
    .filter((record) => ["US", "HK", "CN", "JP", "KR"].includes(record.market.toUpperCase()))
    .map((record) => `${record.id}:${record.qty}:${record.cost}:${record.updatedAt}`)
    .join("|");
}

function readTrendCache(signature: string, currency: CurrencyCode, benchKey: BenchKey): TrendCache | null {
  try {
    const raw = localStorage.getItem(ASSET_TREND_CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw) as TrendCache;
    if (
      cached.signature === signature &&
      cached.currency === currency &&
      cached.benchKey === benchKey &&
      Array.isArray(cached.points) &&
      cached.points.length > 0
    ) return cached;
  } catch {
    /* 缓存损坏时走正常加载 */
  }
  return null;
}

interface TrendCache {
  signature: string;
  currency: CurrencyCode;
  benchKey: BenchKey;
  points: TrendPoint[];
  recordCloses: Record<string, CloseItem[]>;
  at: number;
}

function AccountOverviewValue({ value, hidden, pending = false, forceCompact = false }: { value: number; hidden: boolean; pending?: boolean; forceCompact?: boolean }) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const full = fmtMoney(value, "");
  const compact = fmtMoneyCompact(value, "");

  useLayoutEffect(() => {
    const host = hostRef.current;
    const measure = measureRef.current;
    if (!host || !measure) return;
    const update = () => setOverflowing(measure.getBoundingClientRect().width > host.clientWidth + 0.5);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(host);
    document.fonts?.ready.then(update).catch(() => undefined);
    return () => observer.disconnect();
  }, [full]);

  const content = pending ? "—" : hidden ? "******" : forceCompact || overflowing ? compact : full;
  return <span ref={hostRef} className="relative block min-w-0 max-w-full overflow-hidden whitespace-nowrap" title={!pending && !hidden ? full : undefined}>{content}<span ref={measureRef} aria-hidden className="pointer-events-none absolute left-0 top-0 invisible whitespace-nowrap">{full}</span></span>;
}

function isoDate(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
function parseIsoDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}
function monthStart(value: Date) { return new Date(value.getFullYear(), value.getMonth(), 1); }
function shiftMonth(value: Date, delta: number) { return new Date(value.getFullYear(), value.getMonth() + delta, 1); }
function formatRangeDate(value: string) { return value.replaceAll("-", "/"); }
function defaultDateRange(): DateRange {
  const end = new Date();
  const start = new Date(end.getFullYear(), end.getMonth() - 1, 20);
  return { start: isoDate(start), end: isoDate(end) };
}

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

function cleanCloses(items: CloseItem[]) {
  return items
    .map((item) => ({ d: String(item.d || ""), c: Number(item.c) }))
    .filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(item.d) && Number.isFinite(item.c) && item.c > 0)
    .sort((a, b) => a.d.localeCompare(b.d));
}

/* 客户端 K 线缓存：日收盘序列 10 分钟内不重复请求（服务端同样有 10 分钟缓存），
 * 避免资产分析每次重算/刷新都并发请求全部持仓（30+ 只）触发限流导致趋势图偶发空白。 */
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
    const items = cleanCloses(Array.isArray(data.items) ? data.items : []);
    if (items.length > 0) klineCache.set(key, { items, at: Date.now() });
    return items;
  } catch {
    // 源站/限流抖动时回退上一次成功缓存，避免整图被清空
    return hit?.items ?? [];
  }
}

/* 有界并发：避免一次重算并发打满全部持仓的 K 线请求 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function periodStart(period: Period) {
  const now = new Date();
  if (period === "all") return "0000-00-00";
  if (period === "month") return isoDate(new Date(now.getFullYear(), now.getMonth(), 1));
  if (period === "ytd") return isoDate(new Date(now.getFullYear(), 0, 1));
  const days = period === "1m" ? 31 : period === "6m" ? 183 : 366;
  return isoDate(new Date(now.getTime() - days * 864e5));
}

function CalendarMonth({ month, range, onPick }: { month: Date; range: DateRange; onPick: (date: string) => void }) {
  const first = monthStart(month);
  const gridStart = new Date(first);
  gridStart.setDate(1 - first.getDay());
  const days = Array.from({ length: 42 }, (_, index) => {
    const value = new Date(gridStart);
    value.setDate(gridStart.getDate() + index);
    return value;
  });
  const today = isoDate(new Date());
  return <div className="min-w-0 flex-1">
    <h4 className="mb-3 text-center text-sm font-bold">{month.getFullYear()} 年 {month.getMonth() + 1} 月</h4>
    <div className="grid grid-cols-7 gap-1 border-b border-edge pb-2 text-center text-[11px] font-semibold text-muted">{WEEKDAYS.map((day) => <span key={day}>周{day}</span>)}</div>
    <div className="mt-2 grid grid-cols-7 gap-1">{days.map((date) => {
      const key = isoDate(date);
      const inMonth = date.getMonth() === month.getMonth();
      const edge = key === range.start || key === range.end;
      const between = Boolean(range.start && range.end && key > range.start && key < range.end);
      const isToday = key === today;
      return <button key={key} type="button" onClick={() => onPick(key)} className={`relative flex aspect-square min-h-8 items-center justify-center rounded-lg text-xs transition-colors ${edge ? "bg-[#3297f6] font-bold text-white" : between ? "bg-[#3297f6]/15 text-ink" : inMonth ? "text-ink hover:bg-bg-gray" : "text-faint hover:bg-bg-gray"}`}>
        {date.getDate()}{isToday && !edge && <i className="absolute bottom-1 h-1 w-1 rounded-full bg-[#3297f6]" />}
      </button>;
    })}</div>
  </div>;
}

function DateRangePicker({ range, onApply, onClose }: { range: DateRange; onApply: (range: DateRange) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(range);
  const [month, setMonth] = useState(() => monthStart(parseIsoDate(range.start || isoDate(new Date()))));
  const pick = (date: string) => setDraft((current) => !current.start || current.end ? { start: date, end: "" } : date < current.start ? { start: date, end: current.start } : { start: current.start, end: date });
  return <div className="absolute left-0 top-full z-40 mt-2 w-[min(720px,calc(100vw-3rem))] rounded-2xl border border-edge-strong bg-white p-4 shadow-2xl dark:bg-[#1b2029]" onClick={(event) => event.stopPropagation()}>
    <div className="mb-4 flex items-center justify-between">
      <button type="button" onClick={() => setMonth((value) => shiftMonth(value, -1))} className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-edge text-muted hover:bg-bg-gray" aria-label="上个月"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4"><path d="m12 15-5-5 5-5" /></svg></button>
      <strong className="text-sm">选择盈利区间</strong>
      <button type="button" onClick={() => setMonth((value) => shiftMonth(value, 1))} className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-edge text-muted hover:bg-bg-gray" aria-label="下个月"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4"><path d="m8 5 5 5-5 5" /></svg></button>
    </div>
    <div className="grid gap-5 md:grid-cols-2"><CalendarMonth month={month} range={draft} onPick={pick} /><CalendarMonth month={shiftMonth(month, 1)} range={draft} onPick={pick} /></div>
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-edge pt-4"><span className="text-xs text-muted">{draft.start ? formatRangeDate(draft.start) : "开始日期"} — {draft.end ? formatRangeDate(draft.end) : "结束日期"}</span><div className="flex gap-2"><button type="button" onClick={onClose} className="rounded-lg border border-edge px-3 py-1.5 text-xs text-muted hover:bg-bg-gray">取消</button><button type="button" disabled={!draft.start || !draft.end} onClick={() => onApply(draft)} className="rounded-lg border border-edge-strong bg-white px-3 py-1.5 text-xs font-semibold text-ink disabled:opacity-40 dark:bg-[#252c39]">应用区间</button></div></div>
  </div>;
}

export default function AssetAnalysisDashboard({ positions, quotes, livePrice, rates, currency, stockIcons, user, onRefreshMarketData, onOpenPnlAnalysis }: Props) {
  const [period, setPeriod] = usePersistedState<Period>("fire:asset-period", "ytd");
  const [chartTab, setChartTab] = usePersistedState<ChartTab>("fire:asset-chart-tab", "return");
  const [weighting, setWeighting] = usePersistedState<"simple" | "time">("fire:asset-weighting", "simple");
  const [assetMarket, setAssetMarket] = usePersistedState("fire:asset-asset-market", "ALL");
  const [holdingsMarket, setHoldingsMarket] = usePersistedState("fire:asset-holdings-market", "ALL");
  const { currency: displayCurrency, setCurrency: setDisplayCurrency } = useDisplayCurrency();
  const { unit: currencyDisplayUnit } = useCurrencyDisplayUnit();
  const [assetsVisible, setAssetsVisible] = useState(true);
  const [leftPanePct, setLeftPanePct] = useState(ASSET_SPLIT_DEFAULT);
  const [splitReady, setSplitReady] = useState(false);
  const leftPanePctRef = useRef(ASSET_SPLIT_DEFAULT);
  const splitRef = useRef<HTMLDivElement>(null);
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [trendLoading, setTrendLoading] = useState(true);
  const [retryTick, setRetryTick] = useState(0);
  // 基准与趋势的「上一次成功数据」兜底：源站/限流抖动时保留整图，不闪成空白
  const benchmarkRef = useRef<{ key: BenchKey; items: CloseItem[] }>({ key: "spy", items: [] });
  const trendRef = useRef<TrendPoint[]>([]);
  const [recordCloses, setRecordCloses] = useState<Record<string, CloseItem[]>>({});
  const [customRange, setCustomRange] = useState<DateRange>(() => defaultDateRange());
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const [currencyMenuOpen, setCurrencyMenuOpen] = useState<"asset" | "trend" | null>(null);
  const [benchKey, setBenchKey] = usePersistedState<BenchKey>("fire:asset-benchmark", "spy");
  const [benchOpen, setBenchOpen] = useState(false);
  const [weightMenuOpen, setWeightMenuOpen] = useState(false);
  const [pnlMarket, setPnlMarket] = usePersistedState("fire:asset-pnl-market", "ALL");
  const [pnlExpanded, setPnlExpanded] = useState(false);
  const [orders, setOrders] = useState<TradeOrder[]>([]);
  const [holdingSearch, setHoldingSearch] = useState("");
  const [holdingPage, setHoldingPage] = useState(1);
  const [holdingSort, setHoldingSort] = usePersistedState<HoldingSort | null>("fire:asset-holdings-sort", null);
  const [columnManagerOpen, setColumnManagerOpen] = useState(false);
  const [dailyShareOpen, setDailyShareOpen] = useState(false);
  const effectiveBalanceCacheKey = `fire:effective-fund-balances:${user?.username || "current"}`;
  const [fundBalances, setFundBalances] = useState<Record<CurrencyCode, number>>(EMPTY_CURRENCY_BALANCES);
  const [fundBalancesReady, setFundBalancesReady] = useState(false);
  const [cachedEffectiveBalances, setCachedEffectiveBalances] = useState<Record<CurrencyCode, number> | null>(null);
  const [simpleInvestmentEquities, setSimpleInvestmentEquities] = useState<SimpleInvestmentEquity[]>([]);
  const [simpleLedgerReady, setSimpleLedgerReady] = useState(false);
  const [simpleLedgerSucceeded, setSimpleLedgerSucceeded] = useState(false);
  const handleFundBalances = useCallback((balances: Record<CurrencyCode, number>) => {
    setFundBalances(balances);
    setFundBalancesReady(true);
  }, []);

  useLayoutEffect(() => {
    setCachedEffectiveBalances(readEffectiveBalanceCache(effectiveBalanceCacheKey));
  }, [effectiveBalanceCacheKey]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/v1/simple-ledger", { credentials: "same-origin", cache: "no-store" })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("simple ledger")))
      .then((payload) => {
        if (cancelled) return;
        const state = payload?.data ?? payload;
        const rows = Array.isArray(state?.invest) ? state.invest : [];
        setSimpleInvestmentEquities(rows.map((row: Record<string, unknown>) => ({
          market: String(row.market || "").toUpperCase(),
          cur: String(row.cur || "USD").toUpperCase() as CurrencyCode,
          amount: Number(row.amount) || 0
        })).filter((row: SimpleInvestmentEquity) => row.market && row.amount > 0));
        setSimpleLedgerSucceeded(true);
        setSimpleLedgerReady(true);
      })
      .catch(() => { if (!cancelled) { setSimpleLedgerSucceeded(false); setSimpleLedgerReady(true); } });
    return () => { cancelled = true; };
  }, []);
  const [shareOpening, setShareOpening] = useState(false);
  // 快捷交易
  const [tradeTarget, setTradeTarget] = useState<{ record: StockRecord; side: "buy" | "sell"; qty?: number; intent?: "close" } | null>(null);
  const [dividendTarget, setDividendTarget] = useState<StockRecord | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; record: StockRecord } | null>(null);
  const [refreshing, setRefreshing] = useState<"assets" | "holdings" | "orders" | null>(null);
  const { columns: holdingColumns, saveColumns: saveHoldingColumns } = useHoldingColumns();

  // 账户资产 / 持仓 / 交易 各自的刷新：行情+汇率+记录 或 订单接口重取
  const handleRefresh = async (kind: "assets" | "holdings" | "orders") => {
    if (refreshing) return;
    setRefreshing(kind);
    try {
      if (kind === "orders") {
        const res = await fetch("/api/v1/orders?scope=all&limit=500", { cache: "no-store" });
        const data = await res.json().catch(() => null);
        if (!res.ok || data?.code !== 0) throw new Error(data?.message || "订单刷新失败");
        setOrders(Array.isArray(data?.data?.orders) ? data.data.orders : []);
      } else {
        await onRefreshMarketData?.();
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : "刷新失败", "err");
    } finally {
      setRefreshing(null);
    }
  };

  // 货币选择写入 URL ?cur=，与我的持仓页保持一致（该页按 URL 初始化货币）
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    if (sp.get("cur") !== displayCurrency) {
      sp.set("cur", displayCurrency);
      window.history.replaceState(null, "", `?${sp.toString()}`);
    }
  }, [displayCurrency]);

  // 绘制前恢复分栏，避免 SSR 默认 29% 先画出再跳到本地保存值。
  // 首帧不写 inline 变量，让 <head> 同步脚本 / CSS 默认值先生效，避免刷新闪扩。
  useLayoutEffect(() => {
    const saved = readSavedSplitPct();
    leftPanePctRef.current = saved;
    setLeftPanePct(saved);
    setSplitReady(true);
  }, []);

  useLayoutEffect(() => {
    const cached = readTrendCache(trendSignature(positions), displayCurrency, benchKey);
    if (!cached) return;
    trendRef.current = cached.points;
    setTrend(cached.points);
    if (cached.recordCloses && typeof cached.recordCloses === "object") setRecordCloses(cached.recordCloses);
    setTrendLoading(false);
  }, [positions, displayCurrency, benchKey]);

  const applySplitPct = (value: number) => {
    const next = Number(clampSplitPct(value).toFixed(2));
    leftPanePctRef.current = next;
    setLeftPanePct(next);
    return next;
  };

  const startResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!splitRef.current || window.innerWidth < 1280) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const rect = splitRef.current.getBoundingClientRect();
    const move = (moveEvent: PointerEvent) => {
      applySplitPct(((moveEvent.clientX - rect.left) / rect.width) * 100);
    };
    const stop = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", stop);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      localStorage.setItem(ASSET_SPLIT_STORAGE_KEY, String(leftPanePctRef.current));
      showToast("布局宽度已自动保存");
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", stop, { once: true });
  };

  const resetSplit = () => {
    applySplitPct(ASSET_SPLIT_DEFAULT);
    localStorage.setItem(ASSET_SPLIT_STORAGE_KEY, String(ASSET_SPLIT_DEFAULT));
    showToast("布局宽度已恢复默认");
  };
  const currencyFactor = rates[displayCurrency] || 1;
  const symbol = CURRENCY_SYMBOLS[displayCurrency] || displayCurrency;
  const toDisplay = (record: StockRecord, value: number) => {
    const iso = ISO_BY_MARKET[record.market] || "USD";
    const usd = value / (rates[iso] || 1);
    return usd * currencyFactor;
  };

  const summary = useMemo(() => positions.reduce((acc, record) => {
    const qty = Number(record.qty) || 0;
    const price = livePrice(record);
    const cost = Number(record.cost) || 0;
    acc.asset += toDisplay(record, price * qty);
    acc.cost += toDisplay(record, cost * qty);
    acc.pnl += toDisplay(record, (price - cost) * qty);
    acc.day += toDisplay(record, (quotes[record.id]?.change || 0) * qty);
    const key = record.market.toUpperCase();
    const marketSummary = acc.markets[key] || { asset: 0, cost: 0, pnl: 0, day: 0 };
    marketSummary.asset += toDisplay(record, price * qty);
    marketSummary.cost += toDisplay(record, cost * qty);
    marketSummary.pnl += toDisplay(record, (price - cost) * qty);
    marketSummary.day += toDisplay(record, (quotes[record.id]?.change || 0) * qty);
    acc.markets[key] = marketSummary;
    return acc;
  }, { asset: 0, cost: 0, pnl: 0, day: 0, markets: {} as Record<string, { asset: number; cost: number; pnl: number; day: number }> }), [positions, quotes, rates, displayCurrency, livePrice]);
  const nativeSummary = useMemo(() => positions.reduce((acc, record) => {
    const qty = Number(record.qty) || 0;
    const price = livePrice(record);
    const cost = Number(record.cost) || 0;
    const key = record.market.toUpperCase();
    const marketSummary = acc[key] || { asset: 0, cost: 0, pnl: 0, day: 0 };
    marketSummary.asset += price * qty;
    marketSummary.cost += cost * qty;
    marketSummary.pnl += (price - cost) * qty;
    marketSummary.day += (quotes[record.id]?.change || 0) * qty;
    acc[key] = marketSummary;
    return acc;
  }, {} as Record<string, { asset: number; cost: number; pnl: number; day: number }>), [positions, quotes, livePrice]);
  const portfolioLedger = useMemo(() => buildPortfolioLedger(positions, orders, livePrice), [positions, orders, livePrice]);
  const primaryEquityByMarket = useMemo(() => simpleInvestmentEquities.reduce((result, row) => {
    // 完整版目前每个市场只有一套持仓账。若简化版同一市场记录了多个券商，
    // 取资产额最大的主账户与之对应，避免把未导入持仓的其他券商现金混入。
    const current = result[row.market];
    if (!current || row.amount > current.amount) result[row.market] = row;
    return result;
  }, {} as Record<string, SimpleInvestmentEquity>), [simpleInvestmentEquities]);
  const reconciledFundBalances = useMemo(() => {
    const next = { ...fundBalances };
    Object.entries(primaryEquityByMarket).forEach(([market, equity]) => {
      const holdings = nativeSummary[market]?.asset;
      if (holdings !== undefined && equity.cur === ISO_BY_MARKET[market]) next[equity.cur] = equity.amount - holdings;
    });
    return next;
  }, [fundBalances, primaryEquityByMarket, nativeSummary]);
  const effectiveFundBalances = (!fundBalancesReady || !simpleLedgerReady || !simpleLedgerSucceeded) && cachedEffectiveBalances ? cachedEffectiveBalances : reconciledFundBalances;
  const effectiveBalancesReady = cachedEffectiveBalances !== null || (fundBalancesReady && simpleLedgerReady);
  useEffect(() => {
    if (!fundBalancesReady || !simpleLedgerSucceeded) return;
    try { localStorage.setItem(effectiveBalanceCacheKey, JSON.stringify(reconciledFundBalances)); } catch { /* 缓存失败不影响最新数据 */ }
  }, [effectiveBalanceCacheKey, reconciledFundBalances, fundBalancesReady, simpleLedgerSucceeded]);
  const cashTotal = useMemo(() => (Object.entries(effectiveFundBalances) as [CurrencyCode, number][]).reduce((total, [iso, value]) => total + value / (rates[iso] || 1) * currencyFactor, 0), [effectiveFundBalances, rates, currencyFactor]);
  // 只为当前已满足成交条件的买入委托预留现金；尚未触价的挂单不占用可用现金。
  const isCashReservedOrder = (order: TradeOrder, record: StockRecord) => {
    if (order.status !== "pending" || order.side !== "buy") return false;
    const live = livePrice(record);
    const trigger = Number(order.triggerPrice ?? order.price) || 0;
    return order.orderType === "market"
      || (order.orderType === "limit" || order.orderType === "trigger_buy" ? live > 0 && live <= trigger : order.orderType === "rebound_buy" ? live > 0 && live >= trigger : false);
  };
  const orderReservedAmount = (order: TradeOrder, record: StockRecord) => toDisplay(record, Math.max(0, Number(order.amount) || Number(order.qty) * Number(order.price)) + Math.max(0, Number(order.fees) || 0));
  const frozenCashTotal = useMemo(() => orders.reduce((total, order) => {
    const record = positions.find((item) => item.id === order.recordId);
    return record && isCashReservedOrder(order, record) ? total + orderReservedAmount(order, record) : total;
  }, 0), [orders, positions, livePrice, rates, displayCurrency]);
  const totalAsset = summary.asset + cashTotal;

  const ledgerCumulativePnl = useMemo(() => positions.reduce((total, record) => {
    const row = portfolioLedger.get(record.id);
    return total + toDisplay(record, row?.totalPnl ?? ((livePrice(record) - (Number(record.cost) || 0)) * (Number(record.qty) || 0)));
  }, 0), [positions, portfolioLedger, rates, displayCurrency, livePrice]);
  const orderCoveredIds = useMemo(() => new Set(orders.filter((order) => order.status === "filled").map((order) => order.recordId)), [orders]);
  const coveredHoldingCount = positions.filter((record) => orderCoveredIds.has(record.id)).length;
  const historyIncomplete = coveredHoldingCount < positions.length;

  const dailyShareItems = useMemo<DailyPnlShareItem[]>(() => positions.map((record) => {
    const qty = Number(record.qty) || 0;
    return {
      id: record.id,
      name: record.name,
      code: record.code,
      market: record.market,
      dayPnl: toDisplay(record, (quotes[record.id]?.change || 0) * qty),
      marketValue: toDisplay(record, livePrice(record) * qty),
      cost: Number(record.cost) || 0,
      price: livePrice(record),
      pnl: toDisplay(record, (livePrice(record) - (Number(record.cost) || 0)) * qty)
    };
  }).filter((item) => item.marketValue > 0), [positions, quotes, rates, displayCurrency, livePrice]);

  useEffect(() => {
    preloadDailyPnlTemplates(true);
    preloadDailyPnlTemplates(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const eligible = positions.filter((p) => ["US", "HK", "CN", "JP", "KR"].includes(p.market.toUpperCase()));
    const signature = trendSignature(positions);
    const cached = readTrendCache(signature, displayCurrency, benchKey);
    if (cached) {
      trendRef.current = cached.points;
      setTrend(cached.points);
      if (cached.recordCloses && typeof cached.recordCloses === "object") setRecordCloses(cached.recordCloses);
      setTrendLoading(false);
    } else if (trendRef.current.length === 0) {
      setTrendLoading(true);
    }
    (async () => {
      const bench = BENCHMARKS.find((b) => b.key === benchKey) || BENCHMARKS[0];
      // 持仓日 K：有界并发 + 客户端缓存；基准：本次失败且同一基准时沿用上次成功数据
      const [positionRows, benchmarkItems, fetchedOrdersAll] = await Promise.all([
        mapLimit(eligible, 6, async (record) => ({
          record,
          items: await fetchCachedKline(record.market, record.code, 330)
        })),
        fetchCachedKline(bench.market, bench.code, 330, bench.index),
        (async () => {
          try {
            const response = await fetch("/api/v1/orders?scope=all&limit=5000", { cache: "no-store" });
            const data = response.ok ? await response.json() : null;
            return Array.isArray(data?.data?.orders) ? data.data.orders as TradeOrder[] : [];
          } catch {
            return [];
          }
        })()
      ]);
      if (cancelled) return;
      const benchmarkFallback =
        benchmarkItems.length === 0 && benchmarkRef.current.key === benchKey
          ? benchmarkRef.current.items
          : [];
      const effectiveBenchmark = benchmarkItems.length > 0 ? benchmarkItems : benchmarkFallback;
      if (benchmarkItems.length > 0) benchmarkRef.current = { key: benchKey, items: benchmarkItems };
      const nextRecordCloses = Object.fromEntries(positionRows.map((row) => [row.record.id, row.items]));
      setRecordCloses(nextRecordCloses);
      setOrders(fetchedOrdersAll);
      const fetchedOrders = fetchedOrdersAll.filter((order) => order.status === "filled");

      // 使用所有行情日期，但每个标的在自己的首个有效行情之前以首个收盘价回填。
      // 旧逻辑从 0 开始，标的稍晚上市或接口少一天时，会把后续出现的整笔市值误算成投资收益。
      const dates = [...new Set([
        ...positionRows.flatMap((row) => row.items.map((item) => item.d)),
        ...effectiveBenchmark.map((item) => item.d)
      ])].sort();
      const maps = positionRows.map((row) => {
        const fallback = row.items[0]?.c || livePrice(row.record) || 0;
        return { record: row.record, first: fallback, map: new Map(row.items.map((item) => [item.d, item.c])) };
      }).filter((row) => row.first > 0);
      const benchMap = new Map(effectiveBenchmark.map((item) => [item.d, item.c]));
      const last = new Map(maps.map((row) => [row.record.id, row.first]));
      // 基准在首个行情日前必须回填首个有效点位，不能使用 1。否则 5000 点会显示为约 500000%。
      let lastBench = effectiveBenchmark[0]?.c || 0;

      const recordsById = new Map(eligible.map((record) => [record.id, record]));
      const ordersByRecord = new Map<string, TradeOrder[]>();
      fetchedOrders.forEach((order) => {
        const list = ordersByRecord.get(order.recordId) || [];
        list.push(order);
        ordersByRecord.set(order.recordId, list);
      });
      ordersByRecord.forEach((list) => list.sort((a, b) => a.tradedAt.localeCompare(b.tradedAt)));

      // 成交发生在周末/节假日时，现金流必须落到下一条有效行情日期。
      // 数量轨迹本来会在下一交易日生效；若现金流仍留在非交易日，时间加权会把整笔买入误当收益。
      const flowByDate = new Map<string, number>();
      const nextAvailableDate = (date: string) => {
        let low = 0;
        let high = dates.length - 1;
        let answer = "";
        while (low <= high) {
          const middle = (low + high) >> 1;
          if (dates[middle] >= date) { answer = dates[middle]; high = middle - 1; }
          else low = middle + 1;
        }
        return answer;
      };
      fetchedOrders.forEach((order) => {
        const record = recordsById.get(order.recordId);
        const tradedDate = marketDate(order.tradedAt, order.market);
        const effectiveDate = tradedDate ? nextAvailableDate(tradedDate) : "";
        if (!record || !effectiveDate) return;
        const gross = Number(order.amount) || Number(order.price) * Number(order.qty);
        const nativeFlow = order.side === "buy"
          ? gross + Number(order.fees || 0)
          : -(gross - Number(order.fees || 0));
        flowByDate.set(effectiveDate, (flowByDate.get(effectiveDate) || 0) + toDisplay(record, nativeFlow));
      });

      type PositionTrendState = {
        qty: number;
        cursor: number;
        orders: TradeOrder[];
        startDate: string;
        active: boolean;
        initialQty: number;
        principal: number;
        netCash: number;
        grossInvested: number;
        pnlOffset: number | null;
      };
      const quantityState = new Map<string, PositionTrendState>();
      maps.forEach(({ record }) => {
        const recordOrders = ordersByRecord.get(record.id) || [];
        const firstOrder = recordOrders[0];
        const initialQty = firstOrder ? Number(firstOrder.positionQtyBefore) || 0 : Number(record.qty) || 0;
        const initialCost = firstOrder
          ? Number(firstOrder.positionCostBefore ?? record.cost) || 0
          : Number(record.cost) || 0;
        const startDate = marketDate(firstOrder?.tradedAt || record.updatedAt, record.market);
        const principal = initialQty * initialCost;
        quantityState.set(record.id, {
          qty: initialQty,
          cursor: 0,
          orders: recordOrders,
          startDate,
          active: false,
          initialQty,
          principal,
          netCash: 0,
          grossInvested: Math.abs(principal),
          pnlOffset: null
        });
      });

      let timeIndex = 100;
      let previousActualAsset = 0;
      const points = dates.map((date) => {
        let actualAsset = 0;
        let portfolioPnl = 0;
        let investedCapital = 0;
        let openingFlow = 0;
        maps.forEach(({ record, map }) => {
          const next = map.get(date);
          if (next && Number.isFinite(next)) last.set(record.id, next);
          const close = last.get(record.id) || 0;
          const state = quantityState.get(record.id);
          if (!state) return;
          if (!state.startDate || date < state.startDate) return;
          if (!state.active) {
            state.active = true;
            // 首次可确认的旧仓按当日市值作为外部转入，避免“突然出现的资产”被当成投资收益。
            if (state.initialQty > 0) openingFlow += toDisplay(record, close * state.initialQty);
          }
          while (state.cursor < state.orders.length && marketDate(state.orders[state.cursor].tradedAt, state.orders[state.cursor].market) <= date) {
            const order = state.orders[state.cursor];
            const gross = Number(order.amount) || Number(order.price) * Number(order.qty);
            const fees = Number(order.fees || 0);
            if (order.side === "buy") {
              state.netCash += gross + fees;
              state.grossInvested += gross + fees;
            } else {
              state.netCash -= gross - fees;
            }
            state.qty = Number(order.positionQtyAfter) || 0;
            state.cursor += 1;
          }
          const marketValue = toDisplay(record, close * state.qty);
          actualAsset += marketValue;
          const rawPnl = marketValue - toDisplay(record, state.principal + state.netCash);
          // 每只仓位从首个可确认的历史点归零，避免资料不完整的旧仓浮盈被一次性计入当前周期。
          if (state.pnlOffset === null) state.pnlOffset = rawPnl;
          portfolioPnl += rawPnl - state.pnlOffset;
          investedCapital += toDisplay(record, state.grossInvested);
        });
        const bench = benchMap.get(date);
        if (bench && Number.isFinite(bench)) lastBench = bench;
        if (previousActualAsset > 0) {
          const cashFlow = (flowByDate.get(date) || 0) + openingFlow;
          const dailyReturn = (actualAsset - cashFlow) / previousActualAsset - 1;
          if (Number.isFinite(dailyReturn) && dailyReturn > -1) timeIndex *= 1 + dailyReturn;
        }
        if (actualAsset > 0) previousActualAsset = actualAsset;
        const simpleIndex = investedCapital > 0 ? 100 * (1 + portfolioPnl / investedCapital) : 100;
        return { date, asset: actualAsset, benchmark: lastBench, timeIndex, simpleIndex, pnl: portfolioPnl };
      }).filter((point) => point.asset > 0 && Number.isFinite(point.timeIndex) && Number.isFinite(point.simpleIndex));
      // 本次成功则更新；本次因源站/限流抖动取不到数据时保留上一次成功趋势，避免整图闪空
      if (points.length > 0) {
        trendRef.current = points;
        setTrend(points);
        try {
          const cache: TrendCache = {
            signature,
            currency: displayCurrency,
            benchKey,
            points,
            recordCloses: nextRecordCloses,
            at: Date.now()
          };
          localStorage.setItem(ASSET_TREND_CACHE_KEY, JSON.stringify(cache));
        } catch {
          /* 存储满 / 隐私模式忽略 */
        }
      } else if (trendRef.current.length > 0) {
        setTrend(trendRef.current);
      } else {
        setTrend([]);
      }
      setTrendLoading(false);
    })().catch(() => { if (!cancelled) setTrendLoading(false); });
    return () => { cancelled = true; };
  }, [positions, rates, displayCurrency, benchKey, retryTick]);

  const activeRange = useMemo(() => period === "custom"
    ? customRange
    : { start: periodStart(period), end: isoDate(new Date()) }, [period, customRange]);
  const filteredTrend = useMemo(() => trend.filter((point) => point.date >= activeRange.start && point.date <= activeRange.end), [trend, activeRange]);
  const latest = filteredTrend.at(-1);
  const first = filteredTrend[0];
  const selectedValues = filteredTrend.map((point) => weighting === "time" ? point.timeIndex : point.simpleIndex);
  const firstValue = selectedValues[0] || 0;
  const latestValue = selectedValues.at(-1) || 0;
  const returnRate = firstValue > 0 ? latestValue / firstValue - 1 : 0;
  const benchLabel = BENCHMARKS.find((b) => b.key === benchKey)?.label ?? "标普 500";
  const hasBench = !!(latest && first && first.benchmark > 0);
  const benchRate = hasBench ? latest.benchmark / first.benchmark - 1 : 0;
  const benchDiff = hasBench ? returnRate - benchRate : null;
  const pointBeforeRange = trend.findLast((point) => point.date < activeRange.start);
  const cumulative = latest
    ? latest.pnl - (pointBeforeRange?.pnl ?? 0)
    : period === "all" ? ledgerCumulativePnl : 0;
  const pnlLabel = period === "month" ? "本月盈亏"
    : period === "1m" ? "近 1 月盈亏"
      : period === "6m" ? "近 6 月盈亏"
        : period === "ytd" ? "本年盈亏"
          : period === "1y" ? "近 1 年盈亏"
            : period === "custom" ? "区间盈亏"
              : "累计盈亏";
  const marketPositions = holdingsMarket === "ALL" ? positions : positions.filter((item) => item.market === holdingsMarket);
  const holdingAssetTotal = marketPositions.reduce((sum, record) => sum + toDisplay(record, livePrice(record) * (Number(record.qty) || 0)), 0);
  const searchedPositions = marketPositions.filter((record) => {
    const query = holdingSearch.trim().toLocaleLowerCase("zh-CN");
    return !query || record.name.toLocaleLowerCase("zh-CN").includes(query) || record.code.toLocaleLowerCase("zh-CN").includes(query);
  });
  const visiblePositions = holdingSort ? [...searchedPositions].sort((a, b) => {
    const value = (record: StockRecord): number | string => {
      const price = livePrice(record);
      const qty = Number(record.qty) || 0;
      const cost = Number(record.cost) || 0;
      const quote = quotes[record.id];
      const marketValue = toDisplay(record, price * qty);
      switch (holdingSort.key) {
        case "identity": return `${record.name} ${record.code}`;
        case "marketValue": return marketValue;
        case "cost": return cost;
        case "price": return price;
        case "qty": return qty;
        case "dayPnl": return toDisplay(record, (quote?.change || 0) * qty);
        case "dayPnlRate": return quote?.changePct || 0;
        case "pnl": return toDisplay(record, (price - cost) * qty);
        case "pnlRate": return cost ? (price - cost) / cost : 0;
        case "weight": return holdingAssetTotal ? marketValue / holdingAssetTotal : 0;
      }
    };
    const left = value(a);
    const right = value(b);
    const result = typeof left === "string" && typeof right === "string" ? left.localeCompare(right, "zh-CN") : Number(left) - Number(right);
    return result * (holdingSort.dir === "asc" ? 1 : -1);
  }) : searchedPositions;
  const enabledHoldingColumns = holdingColumns.filter((column) => column.visible);
  const holdingPageCount = Math.max(1, Math.ceil(visiblePositions.length / HOLDINGS_PAGE_SIZE));
  const safeHoldingPage = Math.min(holdingPage, holdingPageCount);
  const pagedPositions = visiblePositions.slice((safeHoldingPage - 1) * HOLDINGS_PAGE_SIZE, safeHoldingPage * HOLDINGS_PAGE_SIZE);
  const marketEntries = Object.entries(summary.markets).sort((a, b) => b[1].asset - a[1].asset);
  const accountCurrency = displayCurrency;
  const accountSymbol = symbol;
  const accountSummary = assetMarket === "ALL" ? summary : (summary.markets[assetMarket] || { asset: 0, cost: 0, pnl: 0, day: 0 });
  const marketCurrency = ISO_BY_MARKET[assetMarket] as CurrencyCode | undefined;
  const accountCash = assetMarket === "ALL" ? cashTotal : marketCurrency ? (effectiveFundBalances[marketCurrency] || 0) / (rates[marketCurrency] || 1) * currencyFactor : 0;
  const accountFrozenCash = assetMarket === "ALL" ? frozenCashTotal : orders.reduce((total, order) => {
    const record = positions.find((item) => item.id === order.recordId);
    return record?.market.toUpperCase() === assetMarket && record && isCashReservedOrder(order, record) ? total + orderReservedAmount(order, record) : total;
  }, 0);
  const accountAvailableCash = Math.max(0, accountCash - accountFrozenCash);
  const accountNetAsset = accountSummary.asset + accountCash;
  const pageUsesCompactMoney = useMemo(() => {
    const values = [
    totalAsset, summary.asset, summary.pnl, summary.day, cashTotal,
    accountNetAsset, accountSummary.asset, accountSummary.pnl, accountSummary.day, accountCash,
    ...Object.values(summary.markets).flatMap((market) => [market.asset, market.pnl, market.day])
    ];
    const max = Math.max(0, ...values.filter(Number.isFinite).map(Math.abs));
    return currencyDisplayUnit === "compact" || (currencyDisplayUnit === "auto" && max >= 1e5);
  }, [totalAsset, summary, cashTotal, accountNetAsset, accountSummary, accountCash, currencyDisplayUnit]);
  const compactMoney = useCallback((value: number, withSymbol = false) => {
    const prefix = withSymbol ? symbol : "";
    return pageUsesCompactMoney ? fmtMoneyCompact(value, prefix) : fmtMoney(value, prefix);
  }, [pageUsesCompactMoney, symbol]);
  const holdingAssetsByCurrency = useMemo<Record<CurrencyCode, number>>(() => ({ USD: nativeSummary.US?.asset || 0, EUR: 0, HKD: nativeSummary.HK?.asset || 0, CNY: nativeSummary.CN?.asset || 0, JPY: nativeSummary.JP?.asset || 0, KRW: nativeSummary.KR?.asset || 0, SGD: nativeSummary.SG?.asset || 0 }), [nativeSummary]);
  const summaryMarketKeys = Object.keys(summary.markets);
  const marketKeys = ["US", "HK", "CN", ...summaryMarketKeys.filter((key) => !["US", "HK", "CN"].includes(key))]
    .filter((key, index, keys) => summary.markets[key] && keys.indexOf(key) === index);
  const pnlPositions = useMemo(() => {
    const rows = (pnlMarket === "ALL" ? positions : positions.filter((record) => record.market.toUpperCase() === pnlMarket)).map((record) => {
      const items = recordCloses[record.id] || [];
      const inRange = items.filter((item) => item.d >= activeRange.start && item.d <= activeRange.end);
      const qty = Number(record.qty) || 0;
      const currentPrice = livePrice(record);
      const cost = Number(record.cost) || 0;
      const firstClose = inRange[0]?.c;
      const lastClose = inRange.at(-1)?.c || currentPrice;
      const pnl = period === "all" || !firstClose
        ? toDisplay(record, (currentPrice - cost) * qty)
        : toDisplay(record, (lastClose - firstClose) * qty);
      return { record, pnl };
    }).filter((row) => Number.isFinite(row.pnl)).sort((a, b) => b.pnl - a.pnl);
    return rows;
  }, [positions, pnlMarket, recordCloses, activeRange, period, rates, displayCurrency, livePrice]);
  const shownPnlPositions = pnlExpanded ? pnlPositions : pnlPositions.slice(0, 10);
  const maskMoney = (value: number, signed = false, withSymbol = false) => assetsVisible ? `${signed ? (value >= 0 ? "+" : "−") : ""}${compactMoney(Math.abs(value), withSymbol)}` : "******";
  const maskCashMoney = (value: number, withSymbol = false) => !effectiveBalancesReady ? "—" : assetsVisible ? `${value < 0 ? "−" : ""}${compactMoney(Math.abs(value), withSymbol)}` : "******";
  const MarketPills = ({ value, onChange, includeAll = true }: { value: string; onChange: (key: string) => void; includeAll?: boolean }) => <div className="flex gap-2 overflow-x-auto px-0.5 pb-1 pt-1.5">
    {(includeAll ? ["ALL", ...marketKeys] : marketKeys).map((key) => <button key={key} type="button" onClick={() => onChange(key)} className={`flex-none rounded-full border px-4 py-1.5 text-xs font-bold transition-colors ${value === key ? "border-[#3297f6] bg-[#3297f6]/15 text-[#3297f6] shadow-sm" : "border-edge-strong bg-bg-gray text-muted hover:bg-brand-hover hover:text-ink"}`}>{key === "ALL" ? "全部" : marketMeta(key).label}</button>)}
  </div>;
  const CurrencyPicker = ({ context, prefix }: { context: "asset" | "trend"; prefix: string }) => {
    const open = currencyMenuOpen === context;
    return <div className="relative inline-block">
      <button type="button" onClick={() => setCurrencyMenuOpen(open ? null : context)} className="inline-flex items-center gap-1 rounded-lg px-1 py-1 text-xs font-semibold text-muted transition-colors hover:bg-bg-gray hover:text-ink" aria-expanded={open}>{prefix} ({displayCurrency})<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" className={`ml-0.5 h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`}><path d="m5 7 5 5 5-5" /></svg></button>
      {open && <><div className="fixed inset-0 z-30" onClick={() => setCurrencyMenuOpen(null)} /><div className="absolute left-0 top-full z-40 mt-1 min-w-[150px] overflow-hidden rounded-xl border border-edge-strong bg-white p-1.5 shadow-xl dark:bg-[#1b2029]">{CURRENCIES.map((option) => <button key={option.code} type="button" onClick={() => { setDisplayCurrency(option.code); setCurrencyMenuOpen(null); }} className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-xs transition-colors ${displayCurrency === option.code ? "bg-[#3297f6]/15 font-bold text-[#3297f6]" : "text-ink hover:bg-bg-gray"}`}><span className="flex items-center gap-2"><CurrencyFlag market={option.market} size={14} />{option.label}</span><small className="text-muted">{option.code}</small></button>)}</div></>}
    </div>;
  };

  const toggleHoldingSort = (key: HoldingColumnKey) => {
    setHoldingPage(1);
    setHoldingSort((current) => {
      if (!current || current.key !== key) return { key, dir: key === "identity" ? "asc" : "desc" };
      return { key, dir: current.dir === "desc" ? "asc" : "desc" };
    });
  };

  const holdingCell = (record: StockRecord, key: HoldingColumnKey) => {
    const price = livePrice(record);
    const qty = Number(record.qty) || 0;
    const cost = Number(record.cost) || 0;
    const pnl = (price - cost) * qty;
    const pnlRate = cost ? (price - cost) / cost : 0;
    const quote = quotes[record.id];
    const dayPnl = (quote?.change || 0) * qty;
    const dayPnlRate = (quote?.changePct || 0) / 100;
    const weight = holdingAssetTotal ? toDisplay(record, price * qty) / holdingAssetTotal : 0;
    const displayMarketValue = toDisplay(record, price * qty);
    const displayDayPnl = toDisplay(record, dayPnl);
    const displayPnl = toDisplay(record, pnl);
    if (key === "identity") {
      const icon = stockIcons[`${record.market.toUpperCase()}:${record.code.toUpperCase()}`];
      return <span className="flex min-w-[150px] items-center gap-2">{icon ? <img src={icon} alt="" className="h-7 w-7 rounded-full object-cover" /> : <i className="flex h-7 w-7 items-center justify-center rounded-full bg-bg-gray not-italic">{record.name.slice(0, 1)}</i>}<span className="min-w-0"><b className="block truncate">{record.name}</b><small className="mt-0.5 flex items-center gap-1.5 text-muted"><MarketCodeBadge market={record.market} code={record.code} />{record.code}</small></span></span>;
    }
    if (key === "marketValue") return compactMoney(displayMarketValue);
    if (key === "cost") return fmtNumMarket(cost, record.market);
    if (key === "price") return fmtNumMarket(price, record.market);
    if (key === "qty") return fmtQty(qty);
    if (key === "dayPnl") return <span className={displayDayPnl >= 0 ? "text-up" : "text-down"}>{displayDayPnl >= 0 ? "+" : "−"}{compactMoney(Math.abs(displayDayPnl))}</span>;
    if (key === "dayPnlRate") return <span className={dayPnlRate >= 0 ? "text-up" : "text-down"}>{dayPnlRate >= 0 ? "+" : ""}{fmtPct(dayPnlRate)}</span>;
    if (key === "pnl") return <span className={displayPnl >= 0 ? "text-up" : "text-down"}>{displayPnl >= 0 ? "+" : "−"}{compactMoney(Math.abs(displayPnl))}</span>;
    if (key === "pnlRate") return <span className={pnlRate >= 0 ? "text-up" : "text-down"}>{pnlRate >= 0 ? "+" : ""}{fmtPct(pnlRate)}</span>;
    return <span className="font-semibold">{fmtPct(weight)}</span>;
  };

  return <div className="asset-analysis-page space-y-4">
    <div className="flex flex-wrap items-center gap-3">
      <h2 className="text-lg font-extrabold">资产分析</h2>
    </div>

    <div ref={splitRef} className="asset-analysis-split" style={splitReady ? splitPaneStyle(leftPanePct) : undefined}>
      <aside className="min-w-0 space-y-4">
        <section className="card p-5">
          <div className="mb-5 flex items-center justify-between"><h3 className="text-base font-bold">账户资产</h3><div className="flex items-center gap-1.5"><button type="button" disabled={shareOpening} onClick={async () => { if (shareOpening) return; setShareOpening(true); try { preloadDailyPnlTemplates(summary.day >= 0); await waitForDailyPnlTemplates(); setDailyShareOpen(true); } finally { setShareOpening(false); } }} title={shareOpening ? "正在准备分享图…" : "分享当日盈亏"} aria-label="分享当日盈亏" className="inline-flex h-6 w-6 flex-none items-center justify-center rounded-[7px] border border-edge bg-white text-muted shadow-sm transition-all duration-200 hover:-translate-y-px hover:bg-brand-hover hover:text-ink active:scale-[.97] disabled:opacity-50 dark:border-white/10 dark:bg-[#1c222d] dark:text-white/70 dark:hover:bg-white/10 dark:hover:text-white"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3"><circle cx="18" cy="5" r="2.2" /><circle cx="6" cy="12" r="2.2" /><circle cx="18" cy="19" r="2.2" /><path d="m8 11 8-5M8 13l8 5" /></svg></button><RefreshButton onClick={() => void handleRefresh("assets")} title="刷新账户资产" /></div></div>
          <div className="flex items-center gap-2"><CurrencyPicker context="asset" prefix="总资产" /></div>
          <div className="mt-1 grid grid-cols-3 items-end gap-3"><div className="col-span-2 flex min-w-0 items-center gap-2"><strong className="block truncate text-2xl font-extrabold tabular-nums">{maskCashMoney(totalAsset, true)}</strong><button type="button" onClick={() => setAssetsVisible((visible) => !visible)} className="inline-flex h-7 w-7 flex-none items-center justify-center rounded-lg text-muted transition-colors hover:bg-bg-gray hover:text-ink" title={assetsVisible ? "隐藏资产金额" : "显示资产金额"} aria-label={assetsVisible ? "隐藏资产金额" : "显示资产金额"}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />{assetsVisible ? <circle cx="12" cy="12" r="2.6" /> : <path d="m4 4 16 16" />}</svg></button></div><div><span className="block text-xs text-muted">当日盈亏</span><strong className={`mt-1 block text-sm tabular-nums ${summary.day >= 0 ? "text-up" : "text-down"}`}>{maskMoney(summary.day, true)}</strong></div></div>
          <div className="mt-5 grid grid-cols-3 gap-3">
            <div><span className="text-xs text-muted">持仓总市值</span><strong className="mt-1 block text-sm tabular-nums">{maskMoney(summary.asset)}</strong></div>
            <div
              role="button"
              tabIndex={0}
              onClick={onOpenPnlAnalysis}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpenPnlAnalysis?.(); } }}
              title="查看资产盈亏分析"
              className="group -mx-1 cursor-pointer rounded-[10px] px-1 transition-colors hover:bg-brand-hover/70 dark:hover:bg-white/5"
            >
              <span className="text-xs text-muted">
                持仓总盈亏
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="ml-1 inline-block h-3 w-3 opacity-0 transition-opacity group-hover:opacity-100">
                  <path d="m9 18 6-6-6-6" />
                </svg>
              </span>
              <strong className={`mt-1 block text-sm tabular-nums ${summary.pnl >= 0 ? "text-up" : "text-down"}`}>{maskMoney(summary.pnl, true)}</strong>
            </div>
            <div><span className="text-xs text-muted">现金</span><strong className="mt-1 block text-sm tabular-nums">{maskCashMoney(cashTotal)}</strong></div>
          </div>
          <div className="mt-6"><div className="mb-2 flex items-center justify-between"><span className="text-xs font-semibold">资产分布</span><span className="text-[11px] text-muted">按市场</span></div><div className="flex h-2 overflow-hidden rounded-full bg-bg-gray">{marketEntries.map(([key, value], index) => <span key={key} style={{ width: `${summary.asset ? value.asset / summary.asset * 100 : 0}%`, background: ["#f071b8", "#5579ed", "#31c2ad", "#f3b94f"][index % 4] }} />)}</div><div className="mt-3 grid grid-cols-2 gap-2">{marketEntries.map(([key, value], index) => <div key={key} className="flex items-center justify-between text-xs"><span className="flex items-center gap-1.5 text-muted"><i className="h-2 w-2 rounded-full" style={{ background: ["#f071b8", "#5579ed", "#31c2ad", "#f3b94f"][index % 4] }} />{marketMeta(key).label}</span><b>{summary.asset ? (value.asset / summary.asset * 100).toFixed(1) : "0.0"}%</b></div>)}</div></div>
        </section>

        <section className="card relative overflow-visible">
          <div className="flex items-end gap-6 border-b border-edge px-4 pt-3">{([['return', '收益率趋势图'], ['asset', '总资产趋势图']] as const).map(([key, label]) => <button key={key} type="button" onClick={() => setChartTab(key)} className={`relative px-0.5 pb-3 transition-colors ${chartTab === key ? "text-[15px] font-bold text-ink" : "text-sm font-medium text-muted hover:text-ink"}`}>{label}{chartTab === key && <i className="absolute inset-x-1 bottom-0 h-[2px] rounded-full bg-[#3297f6]" />}</button>)}</div>
          <div className="relative flex items-center gap-2 px-4 py-3"><div className="flex min-w-0 flex-1 gap-2 overflow-x-auto pr-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">{PERIODS.map(([key, label]) => <button key={key} type="button" onClick={() => { setPeriod(key); setDatePickerOpen(false); setPnlExpanded(false); }} className={`flex-none rounded-full border px-3 py-1.5 text-xs font-semibold ${period === key ? "border-[#3297f6] bg-[#3297f6]/10 text-[#3297f6]" : "border-edge text-muted hover:bg-bg-gray"}`}>{label}</button>)}</div><button type="button" onClick={() => setDatePickerOpen((open) => !open)} className={`inline-flex h-8 w-10 flex-none items-center justify-center rounded-full border transition-colors ${period === "custom" || datePickerOpen ? "border-[#3297f6] bg-[#3297f6]/10 text-[#3297f6]" : "border-edge text-muted hover:bg-bg-gray hover:text-ink"}`} title="选择日期区间" aria-label="选择日期区间"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4"><path d="M4 5h16M7 3v4m10-4v4M5 9h14v11H5z" /><path d="m9 14 2 2 4-5" /></svg></button>{datePickerOpen && <DateRangePicker range={customRange} onClose={() => setDatePickerOpen(false)} onApply={(range) => { setCustomRange(range); setPeriod("custom"); setDatePickerOpen(false); setPnlExpanded(false); }} />}</div>
          {period === "custom" && <div className="px-4 pb-2 text-xs font-semibold text-muted">{formatRangeDate(customRange.start)} – {formatRangeDate(customRange.end)}</div>}
          {chartTab === "return" && <div className="flex items-start justify-between gap-3 px-4"><div className="min-w-0 flex-1"><CurrencyPicker context="trend" prefix={pnlLabel} /><strong className={`mt-1 block max-w-[15rem] text-xl tabular-nums ${cumulative >= 0 ? "text-up" : "text-down"}`}><AccountOverviewValue value={cumulative} hidden={!assetsVisible} forceCompact={currencyDisplayUnit === "compact"} /></strong></div><div className="relative flex-none text-right"><button type="button" onClick={() => setWeightMenuOpen((open) => !open)} aria-expanded={weightMenuOpen} className="inline-flex items-center gap-1 rounded-lg px-1 py-1 text-xs font-semibold text-muted transition-colors hover:bg-bg-gray hover:text-ink">收益率·{weighting === "simple" ? "简单加权" : "时间加权"}<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" className={`h-3 w-3 transition-transform ${weightMenuOpen ? "rotate-180" : ""}`}><path d="m5 7 5 5 5-5" /></svg></button>{weightMenuOpen && <><div className="fixed inset-0 z-30" onClick={() => setWeightMenuOpen(false)} /><div className="absolute right-0 top-full z-40 mt-1 min-w-[160px] overflow-hidden rounded-xl border border-edge-strong bg-white p-1 shadow-xl dark:bg-[#1b2029]">{WEIGHT_OPTIONS.map(([key, label]) => <button key={key} type="button" onClick={() => { setWeighting(key); setWeightMenuOpen(false); }} className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-xs transition-colors ${weighting === key ? "bg-[#3297f6]/15 font-bold text-[#3297f6]" : "text-ink hover:bg-bg-gray"}`}><span>{label}</span>{weighting === key && <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3"><path d="m2.4 6.4 2.5 2.5 4.7-5.8" /></svg>}</button>)}</div></>}<strong className={`mt-1 block text-base tabular-nums ${returnRate >= 0 ? "text-up" : "text-down"}`}>{assetsVisible ? fmtPct(returnRate) : "******"}</strong></div></div>}
          {chartTab === "return" && historyIncomplete && (
            <p className="mx-4 mt-2 text-[10.5px] leading-4 text-muted">
              历史订单覆盖 {coveredHoldingCount}/{positions.length} 只持仓；未覆盖仓位从首个可确认日期起计，不再回填到年初。
            </p>
          )}
          {chartTab === "return" && <div className="mx-4 mt-3 flex items-center justify-between gap-3 rounded-lg bg-bg-gray px-3 py-2 text-xs">
            <div className="relative">
              <button type="button" onClick={() => setBenchOpen((open) => !open)} aria-expanded={benchOpen} className="inline-flex items-center gap-1.5 text-ink transition-colors hover:text-ink">
                <i className="h-2 w-2 rounded-full bg-[#ef5b19]" />
                <span>{cumulative > 0 ? "跑赢" : "跑输"}</span>
                <i className="h-2 w-2 rounded-full bg-[#4a90d9]" />
                <span className="font-semibold">{benchLabel}</span>
                <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" className={`h-3 w-3 text-muted transition-transform ${benchOpen ? "rotate-180" : ""}`}><path d="m5 7 5 5 5-5" /></svg>
                {assetsVisible ? (benchDiff !== null ? <b className={`tabular-nums ${benchDiff >= 0 ? "text-up" : "text-down"}`}>{fmtPct(benchDiff)}</b> : <span className="text-faint">—</span>) : <b className="text-faint">******</b>}
              </button>
              {benchOpen && (
                <>
                  <div className="fixed inset-0 z-30" onClick={() => setBenchOpen(false)} />
                  <div className="absolute left-0 top-full z-40 mt-1 min-w-[150px] overflow-hidden rounded-xl border border-edge-strong bg-white p-1 shadow-xl dark:bg-[#1b2029]">
                    {BENCHMARKS.map((bench) => (
                      <button key={bench.key} type="button" onClick={() => { setBenchKey(bench.key); setBenchOpen(false); }} className={`flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left text-xs transition-colors ${benchKey === bench.key ? "bg-[#1e3a8a] font-bold text-white" : "text-ink hover:bg-bg-gray"}`}>
                        <span>{bench.label}</span>
                        {benchKey === bench.key && <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3"><path d="m2.4 6.4 2.5 2.5 4.7-5.8" /></svg>}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>}
          {trendLoading ? <div className="mx-4 mb-4 h-[330px] animate-pulse rounded-xl bg-bg-gray" aria-hidden /> : filteredTrend.length > 1 ? <PnlTrendChart points={filteredTrend} tab={chartTab} weighting={weighting} benchLabel={benchLabel} /> : <div className="flex h-[330px] flex-col items-center justify-center gap-3 px-8 text-center text-sm text-muted"><span>历史行情不足，后续交易日会自动补全趋势</span><button type="button" onClick={() => setRetryTick((tick) => tick + 1)} className="rounded-full border border-edge px-3.5 py-1.5 text-xs font-semibold text-ink-2 transition-colors hover:bg-brand-hover dark:border-white/20">重新获取</button></div>}
        </section>

        <section className="card overflow-hidden">
          <div className="border-b border-edge px-4 py-4">
            <div className="flex items-center justify-between gap-3"><h3 className="text-base font-bold">持仓盈亏排行</h3><span className="text-[11px] text-muted">更新至 {formatRangeDate(activeRange.end)}</span></div>
            <div className="mt-2"><MarketPills value={pnlMarket} onChange={(key) => { setPnlMarket(key); setPnlExpanded(false); }} /></div>
          </div>
          <div className="grid grid-cols-[48px_minmax(0,1fr)_110px] bg-bg-gray px-4 py-2.5 text-[11px] font-semibold text-muted"><span>序号</span><span>名称 / 代码</span><span className="text-right">盈亏 / 明细</span></div>
          <div>{shownPnlPositions.map(({ record, pnl }, index) => {
            const icon = stockIcons[`${record.market.toUpperCase()}:${record.code.toUpperCase()}`];
            return <div key={record.id} className="grid grid-cols-[48px_minmax(0,1fr)_110px] items-center border-t border-edge px-4 py-3 text-xs transition-colors first:border-t-0 hover:bg-bg-gray/60 dark:hover:bg-[#1b2230]">
              <span className="font-semibold tabular-nums">{String(index + 1).padStart(2, "0")}</span>
              <span className="flex min-w-0 items-center gap-2">
                {icon ? <img src={icon} alt="" className="h-7 w-7 shrink-0 rounded-full object-cover" /> : <i className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-bg-gray not-italic text-ink-2">{record.name.slice(0, 1)}</i>}
                <span className="min-w-0"><b className="block truncate">{record.name}</b><small className="mt-0.5 flex min-w-0 items-center gap-1.5 text-muted"><MarketCodeBadge market={record.market} code={record.code} /><span className="truncate">{record.code}</span></small></span>
              </span>
              <span className={`text-right font-bold tabular-nums ${pnl >= 0 ? "text-up" : "text-down"}`}>{pnl >= 0 ? "+" : "−"}{compactMoney(Math.abs(pnl))}</span>
            </div>;
          })}</div>
          {shownPnlPositions.length === 0 && <div className="py-10 text-center text-xs text-muted">当前市场暂无可计算的持仓盈亏</div>}
          {pnlPositions.length > 10 && <button type="button" onClick={() => setPnlExpanded((expanded) => !expanded)} className="flex w-full items-center justify-center gap-1 border-t border-edge py-3 text-xs font-semibold text-muted transition-colors hover:bg-bg-gray hover:text-ink">{pnlExpanded ? "收起" : `显示更多（另 ${pnlPositions.length - 10} 只）`}<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" className={`h-3 w-3 transition-transform ${pnlExpanded ? "rotate-180" : ""}`}><path d="m5 7 5 5 5-5" /></svg></button>}
        </section>

        <FundsPanel holdingAssets={holdingAssetsByCurrency} balanceOverrides={effectiveFundBalances} onBalancesChange={handleFundBalances} />
      </aside>

      <button type="button" className="asset-analysis-resizer" onPointerDown={startResize} onDoubleClick={resetSplit} title="左右拖动调整布局宽度，双击恢复默认" aria-label="调整资产分析左右布局宽度"><span /><i>⋮</i></button>

      <main className="min-w-0 space-y-4">
        <section className="mobile-hide-duplicate-summary card p-5">
          <div className="mb-2"><h3 className="text-base font-bold">账户总览</h3></div>
          <MarketPills value={assetMarket} onChange={setAssetMarket} />
          <div className="mt-5 grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">{[["净资产", accountNetAsset], ["当日盈亏", accountSummary.day], ["持仓市值", accountSummary.asset], ["浮动盈亏", accountSummary.pnl], ["可用现金", accountAvailableCash], ["冻结现金", accountFrozenCash]].map(([label, value]) => <div key={String(label)} className="min-w-0"><span className="block truncate text-[11px] text-muted">{label === "净资产" ? `净资产(${accountCurrency})` : label}</span><strong className={`mt-1 block min-w-0 text-sm tabular-nums ${label === "当日盈亏" || label === "浮动盈亏" ? Number(value) >= 0 ? "text-up" : "text-down" : ""}`}><AccountOverviewValue value={Number(value)} hidden={!assetsVisible} pending={(label === "净资产" || label === "可用现金") && !effectiveBalancesReady} forceCompact={currencyDisplayUnit === "compact"} /></strong></div>)}</div>
        </section>

        <section className="card overflow-hidden">
          <div className="border-b border-edge px-5 py-4">
            <h3 className="mb-3 text-base font-bold">持仓分布</h3>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0"><MarketPills value={holdingsMarket} onChange={(key) => { setHoldingsMarket(key); setHoldingSearch(""); setHoldingPage(1); }} /></div>
              <div className="flex items-center gap-1.5">
                <RefreshButton onClick={() => void handleRefresh("holdings")} title="刷新持仓" />
                <label className="relative block">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted"><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></svg>
                  <input value={holdingSearch} onChange={(event) => { setHoldingSearch(event.target.value); setHoldingPage(1); }} className="h-8 w-[150px] rounded-full border border-edge-strong bg-white pl-8 pr-3 text-xs text-ink placeholder:text-faint dark:bg-[#1c222d]" placeholder="代码 / 名称" />
                </label>
                <HoldingColumnsButton onClick={() => setColumnManagerOpen(true)} />
              </div>
            </div>
          </div>
          <div className="overflow-x-auto"><table className="mobile-analysis-holdings w-full text-xs" style={{ minWidth: `${Math.max(760, enabledHoldingColumns.length * 130)}px` }}><thead><tr className="bg-bg-gray text-muted">{enabledHoldingColumns.map((column) => { const active = holdingSort?.key === column.key; return <th key={column.key} data-holding-column={column.key} className={`px-4 py-3 ${column.key === "identity" ? "text-left" : "text-right"}`}><button type="button" onClick={() => toggleHoldingSort(column.key)} className={`inline-flex items-center gap-1 whitespace-nowrap transition-colors hover:text-ink ${column.key === "identity" ? "" : "flex-row-reverse"} ${active ? "text-ink" : ""}`}>{HOLDING_COLUMN_LABELS[column.key]}<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" className={`h-3 w-3 ${active ? "opacity-100" : "opacity-25"}`}><path d={active && holdingSort?.dir === "asc" ? "m5 12 5-5 5 5" : "m5 8 5 5 5-5"} /></svg></button></th>; })}</tr></thead><tbody>{pagedPositions.map((record) => <tr key={record.id} className="cursor-pointer border-t border-edge transition-colors hover:bg-bg-gray/60 dark:hover:bg-[#1b2230]" onClick={(e) => setCtxMenu({ x: e.clientX, y: e.clientY, record })} onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY, record }); }}>{enabledHoldingColumns.map((column) => <td key={column.key} data-holding-column={column.key} className={`px-4 py-3 tabular-nums ${column.key === "identity" ? "text-left" : "text-right"}`}>{holdingCell(record, column.key)}</td>)}</tr>)}</tbody></table>{visiblePositions.length === 0 && <div className="py-14 text-center text-sm text-muted">{holdingSearch ? "没有匹配的持仓" : "当前市场暂无持仓"}</div>}</div>
          {holdingPageCount > 1 && <div className="border-t border-edge bg-bg-gray/50 px-4 py-3"><div className="text-left text-xs text-muted">共 {visiblePositions.length} 项 · 每页 {HOLDINGS_PAGE_SIZE} 项</div><Pagination page={safeHoldingPage} total={holdingPageCount} onChange={setHoldingPage} /></div>}
        </section>

        <TradeOrdersPanel
          orders={orders}
          stockIcons={stockIcons}
          storageKey="fire:asset-order-tab"
          onRefresh={() => handleRefresh("orders")}
        />
      </main>
    </div>
    {columnManagerOpen && <HoldingColumnManager columns={holdingColumns} onSave={saveHoldingColumns} onClose={() => setColumnManagerOpen(false)} />}
    {dailyShareOpen && <DailyPnlShareModal dayPnl={summary.day} totalPnl={summary.pnl} totalAsset={totalAsset} currency={displayCurrency} items={dailyShareItems} initialProfile={{ name: user?.nickname || user?.username || "我的投资记录", avatar: user?.avatar || "" }} onClose={() => setDailyShareOpen(false)} />}
    {ctxMenu && (
      <div className="fixed inset-0 z-[130]" onClick={() => setCtxMenu(null)} onContextMenu={(e) => { e.preventDefault(); setCtxMenu(null); }}>
        <div style={{ left: Math.min(ctxMenu.x, window.innerWidth - 100), top: Math.min(ctxMenu.y, window.innerHeight - 168) }} className="fixed z-[131] w-[88px] overflow-hidden rounded-xl border border-[#ececef] bg-white p-1 shadow-2xl dark:border-white/10 dark:bg-[#20232b]">
          <button type="button" onClick={() => { setTradeTarget({ record: ctxMenu.record, side: "buy" }); setCtxMenu(null); }} className="block w-full rounded-lg px-2 py-1.5 text-center text-[13px] font-medium text-[#1d1d1f] transition-colors hover:bg-[#2f6fed] hover:text-white dark:text-white">买入</button>
          <button type="button" onClick={() => { setTradeTarget({ record: ctxMenu.record, side: "sell" }); setCtxMenu(null); }} className="block w-full rounded-lg px-2 py-1.5 text-center text-[13px] font-medium text-[#1d1d1f] transition-colors hover:bg-[#2f6fed] hover:text-white dark:text-white">卖出</button>
          <button type="button" onClick={() => { setTradeTarget({ record: ctxMenu.record, side: "sell", qty: Number(ctxMenu.record.qty) || 0, intent: "close" }); setCtxMenu(null); }} className="block w-full rounded-lg px-2 py-1.5 text-center text-[13px] font-medium text-[#1d1d1f] transition-colors hover:bg-[#2f6fed] hover:text-white dark:text-white">平仓</button>
          <button type="button" onClick={() => { setDividendTarget(ctxMenu.record); setCtxMenu(null); }} className="block w-full rounded-lg px-2 py-1.5 text-center text-[13px] font-medium text-[#1d1d1f] transition-colors hover:bg-[#2f6fed] hover:text-white dark:text-white">股息</button>
        </div>
      </div>
    )}
    <QuickTradeDialog open={!!tradeTarget} record={tradeTarget?.record ?? null} initialSide={tradeTarget?.side ?? "buy"} initialQty={tradeTarget?.qty} intent={tradeTarget?.intent} livePrice={livePrice} maxBuyPower={Math.max(0, accountCash)} dayChange={tradeTarget?.record ? (quotes[tradeTarget.record.id]?.change ?? 0) : 0} stockIcons={stockIcons} onClose={() => setTradeTarget(null)} onDone={() => { void handleRefresh("holdings"); void handleRefresh("orders"); }} />
    {dividendTarget && <HoldingDividendDialog record={dividendTarget} onClose={() => setDividendTarget(null)} onSettled={() => { void handleRefresh("holdings"); void handleRefresh("orders"); }} />}
  </div>;
}
