"use client";
import { Capsule, IconButton } from "@/components/Capsule";

import { GlobalSettingsEditor, mergeVisibleOrder } from "@/lib/globalSettingsEditor";
import VisibilityIcon from "@/components/VisibilityIcon";

import { usePnlCalendarState } from "@/lib/usePnlCalendarState";
import { useWorkspaceForeground } from "@/lib/useWorkspaceForeground";
import { usePrivateReadRevision } from "@/lib/usePrivateReadRevision";
import { accountReadHeaders, privateReadEpoch, recordsReadSignature } from "@/lib/privateReadContext";
import { platformRequest, PlatformRequestError } from "@/lib/platformRequest";
import { readAnalysisOrders } from "@/lib/analysisOrders";
import { useWorkspaceLocationGuard } from "@/lib/workspacePanel";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import CurrencyFlag from "@/components/CurrencyFlag";
import { fmtMoney, fmtMoneyCalendarCell, fmtMoneyCalendarCompact, fmtMoneyCompact, fmtNumMarket, fmtPct, fmtQty } from "@/lib/format";
import { marketMeta, type Quote, type StockRecord, type TradeOrder } from "@/lib/types";
import { showToast } from "@/lib/toast";
import { HoldingColumnManager, HoldingColumnsButton, useHoldingColumns } from "@/components/HoldingColumnManager";
import { HOLDING_COLUMN_LABELS, type HoldingColumnKey } from "@/lib/holdingColumns";
import { usePersistedState } from "@/lib/usePersistedState";
import { ensureStockIcon } from "@/lib/useAssetIcons";
import { CURRENCIES, CURRENCY_SYMBOLS, useCurrencyDisplayUnit, useDisplayCurrency, type CurrencyCode } from "@/lib/currencyPrefs";
import { emptyFundBalances, type FundCurrency } from "@/lib/fundCurrencies";
import TradeOrdersPanel from "@/components/TradeOrdersPanel";
import RefreshButton from "@/components/RefreshButton";
import AssetHoldingList from "@/components/AssetHoldingList";
import { preloadView } from "@/lib/viewPreload";
import DailyPnlShareModal, { preloadDailyPnlTemplates, waitForDailyPnlTemplates, type DailyPnlShareItem } from "@/components/DailyPnlShareModal";
import dynamic from "next/dynamic";
// 图表按需加载：echarts 不小，等趋势卡片真正需要渲染时再拉这块 JS
const PnlTrendChart = dynamic(() => import("@/components/PnlTrendChart"), {
  ssr: false,
  loading: () => <div className="mx-4 mb-4 h-[330px] animate-pulse rounded-xl bg-bg-gray" />
});
import QuickTradeDialog from "@/components/QuickTradeDialog";
import HoldingDividendDialog from "@/components/HoldingDividendDialog";
import { buildPortfolioLedger } from "@/lib/portfolioLedger";
import { ACCOUNT_MARKET_CURRENCY, accountTotals, convertAccountAmount, reconcileAccountCash, positionFigures, positionWeight } from "@/lib/accountCash";
import FundsPanel from "@/components/FundsPanel";
import CashBalanceEditor from "@/components/CashBalanceEditor";
import { holdingAccountMarket, holdingAccountCurrency, holdingMoneyFactor, isStockConnect } from "@/lib/stockAccount";
import StockConnectBadge from "@/components/StockConnectBadge";
import MarketCodeBadge from "@/components/MarketCodeBadge";
import Pagination from "@/components/Pagination";
import QuoteSourceBadge, { QuoteRowHint } from "@/components/QuoteSourceBadge";
import PnlCalendar from "@/components/PnlCalendar";
import EtfDoubleBadge from "@/components/EtfDoubleBadge";
import { registeredPnlCalendar, buildDailyAssetSeries, buildDayDetailRows, buildMonthCells, buildYearSummary, savePnlCalendarPref, type CalendarDayRow } from "@/lib/pnlCalendar";
import { fetchBenchmarkKline, fetchPortfolioBundle, type SeriesClose } from "@/lib/portfolioSeries";
import { buildVerifiedAssetTrend, verifiedAssetDays } from "@/lib/assetAnalysisTrend";
import { validObservedDate } from "@/lib/observedDate";

type Period = "month" | "1m" | "6m" | "ytd" | "1y" | "all" | "custom";
type ChartTab = "return" | "asset";
const WEIGHT_OPTIONS = [
  ["simple", "收益率·简单加权"],
  ["time", "收益率·时间加权"]
] as const;
interface HoldingSort { key: HoldingColumnKey; dir: "asc" | "desc" }
interface DateRange { start: string; end: string }
/** 资金余额按资金系统的币种清单（比展示币种多：含卡面库里会出现的台币 / 英镑等） */
const EMPTY_CURRENCY_BALANCES: Record<FundCurrency, number> = emptyFundBalances();


interface Props {
  readSignature?: string;
  initialModuleOrder?: { left: string[]; right: string[] };
  sessionCsrf: string;
  positions: StockRecord[];
  quotes: Record<string, Quote>;
  livePrice: (record: StockRecord) => number;
  rates: Record<string, number>;
  currency: "USD" | "CNY" | "HKD";
  stockIcons: Record<string, string>;
  user?: { id?: string; role?: string; username?: string; nickname?: string; avatar?: string };
  /** 刷新行情 / 汇率 / 持仓记录（账户资产、持仓刷新按钮调用） */
  onRefreshMarketData?: () => Promise<void>;
  /** 进入资产盈亏分析页 */
  onOpenPnlAnalysis?: () => void;
}

const PERIODS: Array<[Period, string]> = [["month", "本月"], ["1m", "近 1 月"], ["6m", "近 6 月"], ["ytd", "本年"], ["1y", "近 1 年"], ["all", "全部"]];
const ISO_BY_MARKET = ACCOUNT_MARKET_CURRENCY;
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
const EMPTY_CHART_POINTS: [] = [];
const HOLDINGS_PAGE_SIZE = 10;

/** 资产分析页模块 id 与默认顺序（左右两栏各一组）；自定义顺序存 site_settings.assetAnalysisOrder */
const ASSET_MODULE_IDS = {
  left: ["account", "trend", "pnlRank", "funds"],
  right: ["overview", "holdings", "orders", "calendar"]
} as const;
const ASSET_MODULE_ORDER_DEFAULT = { left: [...ASSET_MODULE_IDS.left], right: [...ASSET_MODULE_IDS.right] };

/** 服务端顺序与默认顺序合并：丢掉已不存在的模块，缺的按默认顺序补在末尾 */
function mergeModuleOrder(saved: { left?: unknown; right?: unknown } | null | undefined) {
  const merge = (column: "left" | "right") => {
    const defaults = ASSET_MODULE_IDS[column] as readonly string[];
    const list = Array.isArray(saved?.[column])
      ? (saved?.[column] as unknown[]).filter((id): id is string => typeof id === "string" && defaults.includes(id))
      : [];
    return [...list, ...defaults.filter((id) => !list.includes(id))];
  };
  return { left: merge("left"), right: merge("right") };
}

function clampSplitPct(value: number) {
  if (!Number.isFinite(value)) return ASSET_SPLIT_DEFAULT;
  return Math.min(ASSET_SPLIT_MAX, Math.max(ASSET_SPLIT_MIN, value));
}

function splitPaneStyle(pct: number): React.CSSProperties {
  const left = clampSplitPct(pct);
  return {
    "--asset-left-fr": `${left}fr`,
    "--asset-right-fr": `${(100 - left).toFixed(2)}fr`
  } as React.CSSProperties;
}

function AccountOverviewValue({ value, hidden, pending = false, forceCompact = false, symbol = "", signed = false }: { value: number; hidden: boolean; pending?: boolean; forceCompact?: boolean; symbol?: string; signed?: boolean }) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const sign = signed && Number.isFinite(value) ? value >= 0 ? "+" : "−" : "";
  const full = `${sign}${fmtMoney(signed ? Math.abs(value) : value, symbol)}`;
  const compact = `${sign}${fmtMoneyCompact(signed ? Math.abs(value) : value, symbol)}`;

  useLayoutEffect(() => {
    const host = hostRef.current;
    const measure = measureRef.current;
    if (!host || !measure) return;
    const update = () => setOverflowing(measure.getBoundingClientRect().width + 4 > host.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(host);
    document.fonts?.ready.then(update).catch(() => undefined);
    return () => observer.disconnect();
  }, [full]);

  const content = pending ? "—" : hidden ? "******" : forceCompact || overflowing ? compact : full;
  return <span ref={hostRef} className="relative block min-w-0 max-w-full overflow-hidden whitespace-nowrap" title={!pending && !hidden ? full : undefined}>{content}<span ref={measureRef} aria-hidden className="pointer-events-none absolute left-0 top-0 invisible whitespace-nowrap">{full}</span></span>;
}

/**
 * 素材地址可能来自旧缓存或刚被替换：首次加载失败时先用重试参数绕过失败的
 * 缓存请求，并强制重新读取该股票的当前素材地址；新地址或重试可用时继续显示
 * 真实图标，只有确实仍不可用才回退名称首字母。
 */
function StockIconAvatar({ src, name, market, code }: { src?: string; name: string; market: string; code: string }) {
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const retryKey = useRef(0);
  useEffect(() => { setAttempt(0); setFailed(false); }, [src]);
  const retryable = Boolean(src && !/^(data|blob):/i.test(src));
  const source = src && attempt > 0 && retryable ? `${src}${src.includes("?") ? "&" : "?"}_alcor_retry=${retryKey.current}` : src;
  if (source && !failed) {
    return <img
      src={source}
      alt=""
      onError={() => {
        if (attempt === 0) {
          retryKey.current = Date.now();
          setAttempt(1);
          void ensureStockIcon(market.toUpperCase(), code.toUpperCase(), true);
        } else setFailed(true);
      }}
      className="h-7 w-7 rounded-full object-cover"
    />;
  }
  return <i className="flex h-7 w-7 items-center justify-center rounded-full bg-bg-gray not-italic text-ink-2">{name.slice(0, 1)}</i>;
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
function formatDateRange({ start, end }: DateRange) {
  return start === end && start ? formatRangeDate(start)
    : `${start ? formatRangeDate(start) : "开始日期"} – ${end ? formatRangeDate(end) : "结束日期"}`;
}
function defaultDateRange(): DateRange {
  const end = new Date();
  const start = new Date(end.getFullYear(), end.getMonth() - 1, 20);
  return { start: isoDate(start), end: isoDate(end) };
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
      return <button key={key} type="button" onClick={() => onPick(key)} aria-label={key} aria-pressed={edge} disabled={key > today} className={`relative flex aspect-square min-h-8 items-center justify-center rounded-lg text-xs transition-colors disabled:opacity-40 ${edge ? "bg-[#3297f6] font-bold text-white" : between ? "bg-[#3297f6]/15 text-ink" : inMonth ? "text-ink hover:bg-bg-gray" : "text-faint hover:bg-bg-gray"}`}>
        {date.getDate()}{isToday && !edge && <i className="absolute bottom-1 h-1 w-1 rounded-full bg-[#3297f6]" />}
      </button>;
    })}</div>
  </div>;
}

function DateRangePicker({ id, range, onApply, onClose }: { id: string; range: DateRange; onApply: (range: DateRange) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(range);
  const [month, setMonth] = useState(() => monthStart(parseIsoDate(range.start || isoDate(new Date()))));
  const picker = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => picker.current?.focus({ preventScroll: true }), []);
  const pick = (date: string) => setDraft((current) => !current.start || current.end ? { start: date, end: "" } : date < current.start ? { start: date, end: current.start } : { start: current.start, end: date });
  return <div id={id} ref={picker} role="group" aria-label="选择日期区间" tabIndex={-1}
    className="absolute inset-x-0 top-full z-40 mt-2 max-h-[72dvh] overflow-y-auto overscroll-contain rounded-2xl border border-edge-strong bg-white p-4 shadow-2xl xl:right-auto xl:w-[min(640px,calc(100vw-3rem))] dark:bg-[#1b2029]"
    onKeyDown={(event) => {
      if (event.key === "Escape") { event.stopPropagation(); onClose(); }
    }}>
    <div className="mb-4 flex items-center justify-between">
      <IconButton size="sm" framed type="button" onClick={() => setMonth((value) => shiftMonth(value, -1))} className="" label="上个月"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4"><path d="m12 15-5-5 5-5" /></svg></IconButton>
      <strong className="text-sm">选择日期区间</strong>
      <IconButton size="sm" framed type="button" disabled={month >= monthStart(new Date())} onClick={() => setMonth((value) => shiftMonth(value, 1))} className="" label="下个月"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4"><path d="m8 5 5 5-5 5" /></svg></IconButton>
    </div>
    <div className="grid gap-5 xl:grid-cols-2"><CalendarMonth month={month} range={draft} onPick={pick} /><div className="hidden xl:block"><CalendarMonth month={shiftMonth(month, 1)} range={draft} onPick={pick} /></div></div>
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-edge pt-4"><span className="text-xs text-muted">{formatDateRange(draft)}</span><div className="flex gap-2"><button type="button" onClick={onClose} className="rounded-lg border border-edge px-3 py-1.5 text-xs text-muted hover:bg-bg-gray">取消</button><button type="button" disabled={!draft.start || !draft.end} onClick={() => onApply(draft)} className="rounded-lg border border-edge-strong bg-white px-3 py-1.5 text-xs font-semibold text-ink disabled:opacity-40 dark:bg-[#252c39]">应用区间</button></div></div>
  </div>;
}

export default function AssetAnalysisDashboard({ initialModuleOrder, readSignature, sessionCsrf, positions, quotes, livePrice, rates, currency, stockIcons, user, onRefreshMarketData, onOpenPnlAnalysis }: Props) {
  const canUseWorkspaceUrl = useWorkspaceLocationGuard();
  const foreground = useWorkspaceForeground();
  const readRevision = usePrivateReadRevision();
  const ownerId = user?.id || "";
  const signature = readSignature || recordsReadSignature(positions);
  const [period, setPeriod] = usePersistedState<Period>("fire:asset-period", "ytd");
  const [chartTab, setChartTab] = usePersistedState<ChartTab>("fire:asset-chart-tab", "return");
  const [weighting, setWeighting] = usePersistedState<"simple" | "time">("fire:asset-weighting", "simple");
  const [savedAssetMarket, setAssetMarket] = usePersistedState("fire:asset-asset-market", "ALL");
  const [savedHoldingsMarket, setHoldingsMarket] = usePersistedState("fire:asset-holdings-market", "ALL");
  const accountMarkets = useMemo(() => new Set(positions.map(record => holdingAccountMarket(record).toUpperCase())), [positions]);
  // Migration can remove a market while its cookie/local preference still names it.
  const assetMarket = accountMarkets.has(savedAssetMarket) ? savedAssetMarket : "ALL";
  const holdingsMarket = accountMarkets.has(savedHoldingsMarket) ? savedHoldingsMarket : "ALL";
  const { currency: displayCurrency, setCurrency: setDisplayCurrency } = useDisplayCurrency();
  const { unit: currencyDisplayUnit } = useCurrencyDisplayUnit();
  const [assetsVisible, setAssetsVisible] = useState(true);
  const [savedPanePct,setSavedPanePct] = usePersistedState(ASSET_SPLIT_STORAGE_KEY,ASSET_SPLIT_DEFAULT);
  const [draftPanePct,setDraftPanePct] = useState<number|null>(null);
  const leftPanePct=clampSplitPct(draftPanePct ?? savedPanePct);
  const leftPanePctRef = useRef(ASSET_SPLIT_DEFAULT);
  const splitRef = useRef<HTMLDivElement>(null);
  const trendScope = JSON.stringify([ownerId, signature, readRevision]);
  const [trendRead, setTrendRead] = useState<{ scope: string; days: ReturnType<typeof verifiedAssetDays>; failed: boolean }>();
  const [benchmarkRead, setBenchmarkRead] = useState<{ scope: string; items: SeriesClose[] }>();
  const [retryTick, setRetryTick] = useState(0);
  const lastRetryTick = useRef(0);
  const [recordCloses, setRecordCloses] = useState<Record<string, SeriesClose[]>>({});
  const [closesLoading, setClosesLoading] = useState(true);
  const [savedCustomRange, setCustomRange] = usePersistedState<DateRange>("fire:asset-trend-date-range", defaultDateRange);
  const customRange = useMemo(() => (
    validObservedDate(savedCustomRange?.start) && validObservedDate(savedCustomRange?.end)
    && savedCustomRange.start <= savedCustomRange.end && savedCustomRange.end <= isoDate(new Date())
      ? savedCustomRange : defaultDateRange()
  ), [savedCustomRange]);
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const datePickerId = useId();
  const datePickerTrigger = useRef<HTMLButtonElement>(null);
  const periodList = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const list = periodList.current;
    const selected = list?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]');
    if (!list || !selected) return;
    const reveal = () => {
      const visible = list.getBoundingClientRect();
      const button = selected.getBoundingClientRect();
      if (button.left < visible.left) list.scrollLeft += button.left - visible.left;
      else if (button.right > visible.right) list.scrollLeft += button.right - visible.right;
    };
    reveal();
    const resize = new ResizeObserver(reveal);
    resize.observe(list);
    return () => resize.disconnect();
  }, [period]);
  const closeDatePicker = () => {
    setDatePickerOpen(false);
    datePickerTrigger.current?.focus({ preventScroll: true });
  };
  const [currencyMenuOpen, setCurrencyMenuOpen] = useState<"asset" | "trend" | null>(null);
  const [benchKey, setBenchKey] = usePersistedState<BenchKey>("fire:asset-benchmark", "spy");
  const [benchOpen, setBenchOpen] = useState(false);
  const [weightMenuOpen, setWeightMenuOpen] = useState(false);
  const [savedPnlMarket, setPnlMarket] = usePersistedState("fire:asset-pnl-market", "ALL");
  const pnlMarket = accountMarkets.has(savedPnlMarket) ? savedPnlMarket : "ALL";
  useEffect(() => {
    if (!positions.length) return;
    if (savedAssetMarket !== assetMarket) setAssetMarket(assetMarket);
    if (savedHoldingsMarket !== holdingsMarket) setHoldingsMarket(holdingsMarket);
    if (savedPnlMarket !== pnlMarket) setPnlMarket(pnlMarket);
  }, [positions.length, savedAssetMarket, savedHoldingsMarket, savedPnlMarket, assetMarket, holdingsMarket, pnlMarket, setAssetMarket, setHoldingsMarket, setPnlMarket]);
  const [pnlExpanded, setPnlExpanded] = useState(false);
  const [displayOrders, setOrders] = useState<TradeOrder[]>([]);
  const orders = useMemo(() => displayOrders.filter(order => order.executionModel !== "app_order_mirror"), [displayOrders]);
  const [ordersLoading,setOrdersLoading]=useState(true);
  const [ordersError,setOrdersError]=useState("");
  useLayoutEffect(()=>{setOrders([]);setOrdersLoading(true);setOrdersError("");},[ownerId,signature,readRevision]);
  // Historical orders are independent from licensed price history. A missing
  // benchmark or bar must not erase the owner's recorded order calendar.
  useEffect(() => {
    if (!foreground || !ownerId) return;
    const controller=new AbortController(),epoch=privateReadEpoch();
    setOrdersLoading(true);
    void readAnalysisOrders(ownerId,controller.signal,true).then(data=>{
      if(controller.signal.aborted || epoch!==privateReadEpoch())return;
      setOrders(data);setOrdersError("");
    }).catch(error=>{
      if(controller.signal.aborted || epoch!==privateReadEpoch())return;
      if(error instanceof PlatformRequestError && [401,403].includes(error.status ?? 0))setOrders([]);
      setOrdersError(error instanceof Error?error.message:"历史订单读取失败");
    }).finally(()=>{if(!controller.signal.aborted && epoch===privateReadEpoch())setOrdersLoading(false);});
    return ()=>controller.abort();
  },[ownerId,signature,readRevision,foreground]);

  // 模块顺序：拖动手柄调整后写回 site_settings.assetAnalysisOrder（左右两栏各一组）
  const [moduleOrder, setModuleOrder] = useState<{ left: string[]; right: string[] }>(() => mergeModuleOrder(initialModuleOrder));
  const layoutEditor=useMemo(()=>new GlobalSettingsEditor(ownerId),[ownerId]);
  const [layoutSaving,setLayoutSaving]=useState(false);
  const canReorder=user?.role === "admin" && !layoutSaving;
  const [dragModule, setDragModule] = useState<{ column: "left" | "right"; id: string } | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const moduleHandlePressed = useRef<string | null>(null);

  // 收益日历（与资产盈亏分析共用 lib/pnlCalendar 口径）
  const { market: calMarket, setMarket: setCalMarket, month: calMonth, setMonth: setCalMonth, view: calView, setView: setCalView, mode: calMode, setMode: setCalMode } = usePnlCalendarState();
  const [dayDetail, setDayDetail] = useState<{ date: string; rows: CalendarDayRow[] } | null>(null);


  const [holdingSearch, setHoldingSearch] = useState("");
  const [holdingPage, setHoldingPage] = useState(1);
  const [holdingSort, setHoldingSort] = usePersistedState<HoldingSort | null>("fire:asset-holdings-sort", null);
  const [columnManagerOpen, setColumnManagerOpen] = useState(false);
  const [dailyShareOpen, setDailyShareOpen] = useState(false);
  const effectiveBalanceCacheKey = `fire:recorded-cash-balances:v2:${user?.username || "current"}`;
  const [fundBalances, setFundBalances] = useState<Record<FundCurrency, number>>(EMPTY_CURRENCY_BALANCES);
  const [fundBalancesReady, setFundBalancesReady] = useState(false);
  /** 银行卡现金（借记卡 / 预付卡余额，按卡币种）：用来解释可用现金里有多少来自银行卡 */
  const [cardCash, setCardCash] = useState<Record<string, number>>({});
  const handleFundBalances = useCallback((balances: Record<FundCurrency, number|null>, nextCardCash: Record<string, number|null>) => {
    setFundBalances(Object.fromEntries(Object.entries(balances).map(([key,value])=>[key,typeof value==='number'&&Number.isFinite(value)?value:NaN])) as Record<FundCurrency,number>);
    setCardCash(Object.fromEntries(Object.entries(nextCardCash||{}).map(([key,value])=>[key,typeof value==='number'&&Number.isFinite(value)?value:NaN])));
    setFundBalancesReady(true);
  }, []);

  useLayoutEffect(() => {
    try { localStorage.removeItem(effectiveBalanceCacheKey); } catch { /* discard only obsolete view cache */ }
  }, [effectiveBalanceCacheKey]);

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
    const epoch=privateReadEpoch();
    if(kind==="orders")setOrdersLoading(true);
    try {
      if (kind === "orders") {
        // 与组合聚合接口保持同一口径（limit=5000），否则刷新后订单列表会从 5000 缩到 500
        const data=await readAnalysisOrders(ownerId, undefined, true);
        if(epoch===privateReadEpoch()){setOrders(data);setOrdersError("");}
      } else {
        await onRefreshMarketData?.();
      }
    } catch (error) {
      if(kind==="orders" && epoch===privateReadEpoch())setOrdersError(error instanceof Error?error.message:"历史订单读取失败");
      showToast(error instanceof Error ? error.message : "刷新失败", "err");
    } finally {
      if(kind==="orders" && epoch===privateReadEpoch())setOrdersLoading(false);
      setRefreshing(null);
    }
  };

  // 货币选择写入 URL ?cur=，与我的持仓页保持一致（该页按 URL 初始化货币）
  useEffect(() => {
    if (!canUseWorkspaceUrl()) return;
    const sp = new URLSearchParams(window.location.search);
    if (sp.get("cur") !== displayCurrency) {
      sp.set("cur", displayCurrency);
      window.history.replaceState(null, "", `?${sp.toString()}`);
    }
  }, [displayCurrency]);

  // 绘制前恢复分栏，避免 SSR 默认 29% 先画出再跳到本地保存值。
  // 首帧不写 inline 变量，让 <head> 同步脚本 / CSS 默认值先生效，避免刷新闪扩。

  useLayoutEffect(() => {
    setRecordCloses({});
    setClosesLoading(true);
    try { localStorage.removeItem("fire:asset-analysis:trend-cache-v4"); } catch { /* Remove obsolete derived history. */ }
  }, [trendScope]);

  const applySplitPct = (value: number) => {
    const next = Number(clampSplitPct(value).toFixed(2));
    leftPanePctRef.current = next;
    setDraftPanePct(next);
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
      setSavedPanePct(leftPanePctRef.current); setDraftPanePct(null);
      showToast("布局宽度已自动保存");
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", stop, { once: true });
  };

  const resetSplit = () => {
    applySplitPct(ASSET_SPLIT_DEFAULT);
    setSavedPanePct(ASSET_SPLIT_DEFAULT); setDraftPanePct(null);
    showToast("布局宽度已恢复默认");
  };

  /* ---------- 模块拖拽排序：手柄按住才可拖，落下即写回服务端 ---------- */
  useEffect(() => {
    if(!foreground)return;
    let controller:AbortController|undefined;
    const sync=()=>{controller?.abort();controller=new AbortController();const current=controller;
      void platformRequest<{settings:{assetAnalysisOrder?:{left:string[];right:string[]}}}>("/api/settings",{signal:current.signal,headers:ownerId?{"X-Alcor-Expected-Account":ownerId}:{}},10000)
        .then(data=>{if(!current.signal.aborted&&data?.settings)setModuleOrder(mergeModuleOrder(data.settings.assetAnalysisOrder));}).catch(()=>{});
    };
    sync();window.addEventListener("fire:settings-updated",sync);
    return()=>{controller?.abort();window.removeEventListener("fire:settings-updated",sync);};
  },[ownerId,foreground]);

  const moduleOrderIndex = (column: "left" | "right", id: string) => {
    const index = moduleOrder[column].indexOf(id);
    return index < 0 ? moduleOrder[column].length : index;
  };

  const persistModuleOrder = async (next: { left: string[]; right: string[] }) => {
    if (!canReorder) return;
    const previous=moduleOrder;
    setModuleOrder(next); setLayoutSaving(true);
    try {
      const result=await layoutEditor.save(current=>{
        const saved=mergeModuleOrder(current.assetAnalysisOrder);
        return {assetAnalysisOrder:{left:next.left.join()===previous.left.join()?saved.left:mergeVisibleOrder(saved.left,next.left),right:next.right.join()===previous.right.join()?saved.right:mergeVisibleOrder(saved.right,next.right)}};
      });
      if (!result) {setModuleOrder(previous);return;}
      setModuleOrder(mergeModuleOrder(result.settings.assetAnalysisOrder));
      showToast(result.recovered?"已核对上次保存结果":"模块顺序已保存");
    } catch(error) {setModuleOrder(previous);showToast(error instanceof Error?error.message:"模块顺序保存失败","err");}
    finally {setLayoutSaving(false);}
  };

  const moveModule = (column: "left" | "right", fromId: string, toId: string) => {
    const list = [...moduleOrder[column]];
    const from = list.indexOf(fromId);
    const to = list.indexOf(toId);
    if (from < 0 || to < 0 || from === to) return;
    list.splice(from, 1);
    list.splice(to, 0, fromId);
    void persistModuleOrder({ ...moduleOrder, [column]: list });
  };

  const moduleDragProps = (column: "left" | "right", id: string) => ({
    draggable: canReorder,
    onDragStart: (event: React.DragEvent<HTMLDivElement>) => {
      // 只有从手柄按下才能拖，避免在卡片里选文字 / 拖输入框时误触发
      if (!canReorder || moduleHandlePressed.current !== id) {
        event.preventDefault();
        return;
      }
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", id);
      setDragModule({ column, id });
    },
    onDragOver: (event: React.DragEvent<HTMLDivElement>) => {
      if (!dragModule || dragModule.column !== column || dragModule.id === id) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setDragOverId(id);
    },
    onDragLeave: () => setDragOverId((current) => (current === id ? null : current)),
    onDrop: (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      if (dragModule && dragModule.column === column) moveModule(column, dragModule.id, id);
      setDragModule(null);
      setDragOverId(null);
      moduleHandlePressed.current = null;
    },
    onDragEnd: () => {
      setDragModule(null);
      setDragOverId(null);
      moduleHandlePressed.current = null;
    }
  });

  const moduleWrapperClass = (column: "left" | "right", id: string) =>
    `group relative rounded-card border border-transparent transition-colors ${
      dragOverId === id && dragModule && dragModule.id !== id ? "!border-[var(--site-action)]" : ""
    }`;

  const renderModuleHandle = (_column: "left" | "right", id: string) => !canReorder ? null : (
    <span
      role="button"
      tabIndex={-1}
      aria-label="按住拖动排序"
      title="按住拖动排序"
      onMouseDown={() => {
        moduleHandlePressed.current = id;
      }}
      onMouseUp={() => {
        moduleHandlePressed.current = null;
      }}
      onMouseLeave={() => {
        if (!dragModule) moduleHandlePressed.current = null;
      }}
      className={`absolute -left-2.5 top-4 z-10 hidden h-7 w-5 cursor-grab items-center justify-center rounded-md border border-edge bg-white text-muted shadow-sm transition-opacity duration-200 group-hover:opacity-100 active:cursor-grabbing md:flex dark:border-white/10 dark:bg-[#1c222d] dark:text-white/60 ${
        dragModule?.id === id ? "opacity-100" : "opacity-0"
      }`}
    >
      <svg viewBox="0 0 24 24" fill="currentColor" className="h-3 w-3">
        <circle cx="9" cy="6" r="1.4" /><circle cx="15" cy="6" r="1.4" />
        <circle cx="9" cy="12" r="1.4" /><circle cx="15" cy="12" r="1.4" />
        <circle cx="9" cy="18" r="1.4" /><circle cx="15" cy="18" r="1.4" />
      </svg>
    </span>
  );
  const currencyFactor = rates[displayCurrency] ?? Number.NaN;
  const symbol = CURRENCY_SYMBOLS[displayCurrency] || displayCurrency;
  const toDisplay = (record: StockRecord, value: number) => {
    return convertAccountAmount(value, ISO_BY_MARKET[record.market], rates, displayCurrency);
  };

  /* ---------- 收益日历：数据口径与资产盈亏分析页完全一致（lib/pnlCalendar） ---------- */
  const calendarPositions = useMemo(
    () =>
      positions.map((record) => ({
        id: record.id,
        name: record.name,
        code: record.code,
        market: record.market,
        accountMarket: holdingAccountMarket(record),
        qty: Number(record.qty) || 0
      })),
    [positions]
  );
  const calendarMarketCode = calMarket === "美股" ? "US" : calMarket === "港股" ? "HK" : calMarket === "A股" ? "CN" : "";
  const calendarRows = useMemo(
    () => (calendarMarketCode ? calendarPositions.filter((row) => row.accountMarket.toUpperCase() === calendarMarketCode) : calendarPositions),
    [calendarPositions, calendarMarketCode]
  );
  const calendarSeries = useMemo(
    () => buildDailyAssetSeries({ positions: calendarRows, closesMap: recordCloses, orders, rates }),
    [calendarRows, recordCloses, orders, rates]
  );
  const registeredCalendar = useMemo(() => orders.some(order => order.executionModel === "source_registered_history") ? registeredPnlCalendar(orders, rates, calMonth.y, calMonth.m, calMarket) : null, [orders, rates, calMonth, calMarket]);
  const calendarDays = useMemo(() => registeredCalendar?.days ?? buildMonthCells(calendarSeries, calMonth.y, calMonth.m), [registeredCalendar, calendarSeries, calMonth]);
  const calendarYear = useMemo(() => registeredCalendar?.months ?? buildYearSummary(calendarSeries, calMonth.y, calMonth.m), [registeredCalendar, calendarSeries, calMonth]);
  const calendarAmount = (usd: number) => {
    const value = usd * currencyFactor;
    if (!Number.isFinite(value)) return "—";
    const body = fmtMoneyCalendarCompact(Math.abs(value), symbol, 1e4);
    return `${value >= 0 ? "+" : "−"}${body}`;
  };
  const calendarCompact = (usd: number) => {
    const value = usd * currencyFactor;
    if (!Number.isFinite(value)) return "—";
    return `${value < 0 ? "−" : "+"}${fmtMoneyCalendarCompact(Math.abs(value), symbol)}`;
  };
  const calendarNarrow = (usd: number) => {
    const value = usd * currencyFactor;
    if (!Number.isFinite(value)) return "—";
    return `${value < 0 ? "−" : "+"}${fmtMoneyCalendarCell(Math.abs(value), symbol)}`;
  };

  const summary = useMemo(() => positions.reduce((acc, record) => {
    const figure = positionFigures(record, quotes);
    acc.asset += toDisplay(record, figure.marketValue);
    acc.cost += toDisplay(record, figure.costValue);
    acc.pnl += toDisplay(record, figure.holdingPnl);
    acc.day += toDisplay(record, figure.dayPnl);
    const key = holdingAccountMarket(record).toUpperCase();
    const marketSummary = acc.markets[key] || { asset: 0, cost: 0, pnl: 0, day: 0 };
    marketSummary.asset += toDisplay(record, figure.marketValue);
    marketSummary.cost += toDisplay(record, figure.costValue);
    marketSummary.pnl += toDisplay(record, figure.holdingPnl);
    marketSummary.day += toDisplay(record, figure.dayPnl);
    acc.markets[key] = marketSummary;
    return acc;
  }, { asset: 0, cost: 0, pnl: 0, day: 0, markets: {} as Record<string, { asset: number; cost: number; pnl: number; day: number }> }), [positions, quotes, rates, displayCurrency, livePrice]);
  const nativeSummary = useMemo(() => positions.reduce((acc, record) => {
    const figure = positionFigures(record, quotes);
    const key = holdingAccountMarket(record).toUpperCase();
    const marketSummary = acc[key] || { asset: 0, cost: 0, pnl: 0, day: 0 };
    const factor = holdingMoneyFactor(record, rates, holdingAccountCurrency(record));
    marketSummary.asset += figure.marketValue * factor;
    marketSummary.cost += figure.costValue * factor;
    marketSummary.pnl += figure.holdingPnl * factor;
    marketSummary.day += figure.dayPnl * factor;
    acc[key] = marketSummary;
    return acc;
  }, {} as Record<string, { asset: number; cost: number; pnl: number; day: number }>), [positions, quotes, livePrice, rates]);
  const portfolioLedger = useMemo(() => buildPortfolioLedger(positions, orders, livePrice,rates), [positions, orders, livePrice,rates]);
  const reconciledFundBalances = useMemo(() => reconcileAccountCash(fundBalances, cardCash, [], {}), [fundBalances, cardCash]);
  const effectiveFundBalances = reconciledFundBalances;
  const effectiveBalancesReady = fundBalancesReady;
  const accountSummaryTotals = useMemo(() => accountTotals(summary.asset, effectiveFundBalances, rates, displayCurrency, Number.isFinite(summary.asset), fundBalancesReady), [summary.asset, effectiveFundBalances, rates, displayCurrency, fundBalancesReady]);
  const cashTotal = accountSummaryTotals.totalCash ?? Number.NaN;
  // 银行卡现金：服务端已把它并进 balances（所以 cashTotal / 可用现金 / 净资产都含它），
  // 这里单独折算出显示货币的金额，用来在「账户资产」里说明这部分来源
  const cardCashTotal = useMemo(() => Object.entries(cardCash).reduce((total, [iso, value]) => total + (value === 0 ? 0 : convertAccountAmount(value, iso, rates, displayCurrency)), 0), [cardCash, rates, displayCurrency]);
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
  const totalAsset = accountSummaryTotals.totalAsset ?? Number.NaN;

  const dailyShareItems = useMemo<DailyPnlShareItem[]>(() => positions.map((record) => {
    const qty = Number(record.qty) || 0;
    return {
      id: record.id,
      name: record.name,
      code: record.code,
      market: record.market,
      dayPnl: toDisplay(record, positionFigures(record, quotes).dayPnl),
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

  // The holdings calendar and rank still read their own market evidence.
  useEffect(() => {
    if (!foreground || !ownerId) return;
    const controller = new AbortController();
    const epoch = privateReadEpoch();
    const deferred = window.setTimeout(() => {
      void fetchPortfolioBundle({ days: 330, ownerId, signature, signal: controller.signal })
        .then(bundle => {
          if (!controller.signal.aborted && epoch === privateReadEpoch()) {
            setRecordCloses(bundle?.closes ?? {});
            setClosesLoading(false);
          }
        })
        .catch(() => {
          if (!controller.signal.aborted && epoch === privateReadEpoch()) setClosesLoading(false);
        });
    }, 150);
    return () => { window.clearTimeout(deferred); controller.abort(); };
  }, [ownerId, signature, readRevision, foreground]);

  useEffect(() => {
    if (!foreground || !ownerId) return;
    const controller = new AbortController();
    const epoch = privateReadEpoch();
    void platformRequest<unknown>("/api/fire/asset-analysis/trend", {
      headers: { ...accountReadHeaders(ownerId), "X-CSRF-Token": sessionCsrf }, signal: controller.signal, cache: "no-store",
    }).then(data => {
      if (!controller.signal.aborted && epoch === privateReadEpoch()) {
        setTrendRead({ scope: trendScope, days: verifiedAssetDays(data, ownerId), failed: false });
      }
    }).catch(error => {
      if (controller.signal.aborted || epoch !== privateReadEpoch()) return;
      setTrendRead(previous => ({
        scope: trendScope,
        days: error instanceof PlatformRequestError && error.transient && previous?.scope === trendScope ? previous.days : [],
        failed: true,
      }));
    });
    return () => controller.abort();
  }, [foreground, ownerId, sessionCsrf, trendScope, retryTick]);

  const selectedBenchmark = BENCHMARKS.find(item => item.key === benchKey) ?? BENCHMARKS[0];
  const benchmarkDays = period === "all" ? 1200 : period === "custom"
    ? Math.min(1200, Math.max(330, Math.ceil((Date.now() - Date.parse(customRange.start)) / 86400000)))
    : 330;
  const benchmarkScope = JSON.stringify([ownerId, readRevision, selectedBenchmark.key, benchmarkDays]);
  const benchLabel = selectedBenchmark.label;
  useEffect(() => {
    if (!foreground || !ownerId) return;
    const controller = new AbortController();
    const epoch = privateReadEpoch();
    const force = retryTick !== lastRetryTick.current;
    lastRetryTick.current = retryTick;
    void fetchBenchmarkKline(selectedBenchmark.market, selectedBenchmark.code, benchmarkDays, selectedBenchmark.index, {
      ownerId, signal: controller.signal, force,
    }).then(items => {
      if (!controller.signal.aborted && epoch === privateReadEpoch()) setBenchmarkRead({ scope: benchmarkScope, items });
    }).catch(error => {
      if (controller.signal.aborted) return;
      if (error instanceof PlatformRequestError && [401, 403].includes(error.status ?? 0)) {
        setTrendRead({ scope: trendScope, days: [], failed: true });
      }
      setBenchmarkRead({ scope: benchmarkScope, items: [] });
    });
    return () => controller.abort();
  }, [foreground, ownerId, selectedBenchmark, benchmarkDays, benchmarkScope, trendScope, retryTick]);

  const activeRange = useMemo(() => period === "custom"
    ? customRange
    : { start: periodStart(period), end: isoDate(new Date()) }, [period, customRange]);
  const observed = trendRead?.scope === trendScope ? trendRead : undefined;
  const benchmark = benchmarkRead?.scope === benchmarkScope ? benchmarkRead.items : undefined;
  const { relative, absolute, returnRate, cumulative, comparisonDay, benchmarkDifference: benchDiff } = useMemo(
    () => buildVerifiedAssetTrend(observed?.days ?? [], benchmark ?? [], activeRange.start, activeRange.end, displayCurrency, weighting),
    [observed, benchmark, activeRange, displayCurrency, weighting],
  );
  const chart = chartTab === "return" ? relative : absolute;
  const latestAssetIndex = absolute.portfolio.findLastIndex(value => value !== null);
  const latestAssetDate = absolute.dates[latestAssetIndex];
  const latestAsset = absolute.portfolio[latestAssetIndex];
  const hasPersonalTrend = chart.portfolio.some(value => value !== null);
  const hasTrend = hasPersonalTrend || chart.benchmark.some(value => value !== null);
  const trendLoading = !hasTrend && (!observed || (chartTab === "return" && !benchmark));
  const marketPositions = holdingsMarket === "ALL" ? positions : positions.filter((item) => holdingAccountMarket(item) === holdingsMarket);
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
        case "pnlRate": return cost ? (price - cost) / Math.abs(cost) : 0;
        case "weight": return positionWeight(marketValue, holdingAssetTotal);
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
  const accountCash = assetMarket === "ALL" ? cashTotal : accountSummaryTotals.cashComplete && marketCurrency ? convertAccountAmount(effectiveFundBalances[marketCurrency], marketCurrency, rates, displayCurrency) : Number.NaN;
  const accountFrozenCash = assetMarket === "ALL" ? frozenCashTotal : orders.reduce((total, order) => {
    const record = positions.find((item) => item.id === order.recordId);
    return record && holdingAccountMarket(record).toUpperCase() === assetMarket && record && isCashReservedOrder(order, record) ? total + orderReservedAmount(order, record) : total;
  }, 0);
  const accountAvailableCash = Math.max(0, accountCash - accountFrozenCash);
  const frozenByCurrency = orders.reduce<Partial<Record<FundCurrency, number>>>((totals, order) => {
    const record = positions.find(item => item.id === order.recordId);
    const currency = record && ISO_BY_MARKET[record.market] as FundCurrency | undefined;
    if (record && currency && isCashReservedOrder(order, record)) {
      totals[currency] = (totals[currency] ?? 0) + Math.max(0, Number(order.amount) || Number(order.qty) * Number(order.price)) + Math.max(0, Number(order.fees) || 0);
    }
    return totals;
  }, {});
  // 只读展示：借记卡 / 预付卡余额（信用卡额度不算），口径与并进现金的那部分完全一致
  const accountCardCash = cardCashTotal;
  const accountNetAsset = accountSummary.asset + accountCash;
  const accountOverviewItems: Array<[string, number]> = [
    ["净资产", accountNetAsset], ["当日盈亏", accountSummary.day], ["持仓市值", accountSummary.asset],
    ["浮动盈亏", accountSummary.pnl], ["可用现金", accountAvailableCash],
    ...(assetMarket === "ALL" ? [["银行卡现金", accountCardCash], ["冻结现金", accountFrozenCash]] as Array<[string, number]> : [])
  ];
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
  // 各市场持仓按结算币种归类（资金系统的币种清单，其余币种留 0）
  const holdingAssetsByCurrency = useMemo<Record<FundCurrency, number>>(() => ({ ...emptyFundBalances(), USD: nativeSummary.US?.asset ?? 0, HKD: nativeSummary.HK?.asset ?? 0, CNY: nativeSummary.CN?.asset ?? 0, JPY: nativeSummary.JP?.asset ?? 0, KRW: nativeSummary.KR?.asset ?? 0, SGD: nativeSummary.SG?.asset ?? 0 }), [nativeSummary]);
  const summaryMarketKeys = Object.keys(summary.markets);
  const marketKeys = ["US", "HK", "CN", ...summaryMarketKeys.filter((key) => !["US", "HK", "CN"].includes(key))]
    .filter((key, index, keys) => summary.markets[key] && keys.indexOf(key) === index);
  const pnlPositions = useMemo(() => {
    const rows = (pnlMarket === "ALL" ? positions : positions.filter((record) => holdingAccountMarket(record).toUpperCase() === pnlMarket)).map((record) => {
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
  const maskMoney = (value: number, signed = false, withSymbol = false) => !assetsVisible ? "******" : !Number.isFinite(value) ? "—" : `${signed ? (value >= 0 ? "+" : "−") : ""}${compactMoney(Math.abs(value), withSymbol)}`;
  const MarketPills = ({ value, onChange, includeAll = true }: { value: string; onChange: (key: string) => void; includeAll?: boolean }) => <div className="flex gap-2 overflow-x-auto px-0.5 pb-1 pt-1.5">
    {(includeAll ? ["ALL", ...marketKeys] : marketKeys).map((key) => <Capsule variant="secondary" aria-pressed={value === key} key={key} type="button" onClick={() => onChange(key)} className={`flex-none rounded-full border px-4 py-1.5 text-xs font-bold transition-colors ${value === key ? "border-[#3297f6] bg-[#3297f6]/15 text-[#3297f6] shadow-sm" : "border-edge-strong bg-bg-gray text-muted hover:bg-brand-hover hover:text-ink"}`}>{key === "ALL" ? "全部" : marketMeta(key).label}</Capsule>)}
  </div>;
  const CurrencyPicker = ({ context, prefix }: { context: "asset" | "trend"; prefix: string }) => {
    const open = currencyMenuOpen === context;
    return <div className="relative inline-block">
      <button type="button" onClick={() => setCurrencyMenuOpen(open ? null : context)} className="inline-flex items-center gap-1 rounded-lg px-1 py-1 text-xs font-semibold text-muted transition-colors hover:bg-bg-gray hover:text-ink" aria-expanded={open}>{prefix} ({displayCurrency})<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" className={`ml-0.5 h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`}><path d="m5 7 5 5 5-5" /></svg></button>
      {open && <><div className="fixed inset-0 z-30" onClick={() => setCurrencyMenuOpen(null)} /><div className="absolute left-0 top-full z-40 mt-1 min-w-[150px] overflow-hidden rounded-xl border border-edge-strong bg-white p-1.5 shadow-xl dark:bg-[#1b2029]">{CURRENCIES.map((option) => <button key={option.code} type="button" onClick={() => { setDisplayCurrency(option.code); setCurrencyMenuOpen(null); }} className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-xs transition-colors ${displayCurrency === option.code ? "bg-[var(--capsule-fill)] font-bold text-white" : "text-ink hover:bg-bg-gray"}`}><span className="flex items-center gap-2"><CurrencyFlag market={option.market} size={14} />{option.label}</span><small className="text-muted">{option.code}</small></button>)}</div></>}
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
    const cost = record.cost === "" || record.cost == null ? Number.NaN : Number(record.cost);
    const pnl = positionFigures(record, quotes).holdingPnl;
    const pnlRate = cost ? (price - cost) / Math.abs(cost) : 0;
    const quote = quotes[record.id];
    const dayPnl = positionFigures(record, quotes).dayPnl;
    const dayPnlRate = quote && Number.isFinite(quote.changePct) ? quote.changePct / 100 : Number.NaN;
    const weight = positionWeight(toDisplay(record, price * qty), holdingAssetTotal);
    const displayMarketValue = toDisplay(record, price * qty);
    const displayDayPnl = toDisplay(record, dayPnl);
    const displayPnl = toDisplay(record, pnl);
    if (key === "identity") {
      const icon = stockIcons[`${record.market.toUpperCase()}:${record.code.toUpperCase()}`];
      return <span className="flex min-w-[150px] items-center gap-2"><span className="relative flex-none"><StockIconAvatar src={icon} name={record.name} market={record.market} code={record.code} /><EtfDoubleBadge market={record.market} code={record.code} name={record.name} /></span><span className="min-w-0"><b className="block truncate">{record.name}</b><small className="mt-0.5 flex min-w-0 items-center gap-1.5 text-muted"><MarketCodeBadge market={record.market} code={record.code} /><span className="truncate">{record.code}</span><StockConnectBadge variant="label" market={record.market} accountMarket={record.accountMarket} /><QuoteRowHint market={record.market} quote={quote} quotes={quotes} /></small></span></span>;
    }
    if (key === "marketValue") return Number.isFinite(displayMarketValue) ? compactMoney(displayMarketValue) : Number.isFinite(price * qty) ? <>{fmtMoney(price * qty, marketMeta(record.market).currency)}</> : "—";
    if (key === "cost") return <>{fmtNumMarket(cost, record.market)}{isStockConnect(record) && <small className="ml-1 text-faint">HKD</small>}</>;
    if (key === "price") return <>{fmtNumMarket(price, record.market)}{isStockConnect(record) && <small className="ml-1 text-faint">HKD</small>}</>;
    if (key === "qty") return fmtQty(qty);
    if (key === "dayPnl") return Number.isFinite(displayDayPnl) ? <span className={displayDayPnl >= 0 ? "text-up" : "text-down"}>{displayDayPnl >= 0 ? "+" : "−"}{compactMoney(Math.abs(displayDayPnl))}</span> : "—";
    if (key === "dayPnlRate") return <span className={dayPnlRate >= 0 ? "text-up" : "text-down"}>{dayPnlRate >= 0 ? "+" : ""}{fmtPct(dayPnlRate)}</span>;
    if (key === "pnl") return Number.isFinite(displayPnl) ? <span className={displayPnl >= 0 ? "text-up" : "text-down"}>{displayPnl >= 0 ? "+" : "−"}{compactMoney(Math.abs(displayPnl))}</span> : "—";
    if (key === "pnlRate") return <span className={pnlRate >= 0 ? "text-up" : "text-down"}>{pnlRate >= 0 ? "+" : ""}{fmtPct(pnlRate)}</span>;
    return <span className="font-semibold">{fmtPct(weight)}</span>;
  };

  return <div className="asset-analysis-page space-y-4">
    <div data-workspace-reveal className="asset-analysis-heading">
      <h2 className="text-lg font-extrabold">资产分析</h2>
      <nav className="asset-analysis-shortcuts" aria-label="资产分析区块">
        <a href="#asset-trend"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 17 10 11l4 3 6-8M15 6h5v5"/></svg>趋势</a>
        <a href="#asset-holdings"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="6" width="18" height="14" rx="3"/><path d="M8 6V4h8v2M3 12h18M10 12v3h4v-3"/></svg>持仓</a>
        <a href="#asset-calendar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4M17 3v4M3 10h18m-13 6 3 2 5-4"/></svg>盈亏日历</a>
      </nav>
    </div>

    <div ref={splitRef} className="asset-analysis-split" style={splitPaneStyle(leftPanePct)}>
      <aside className="flex min-w-0 flex-col gap-4">
        <div {...moduleDragProps("left", "account")} className={moduleWrapperClass("left", "account")} style={{ order: moduleOrderIndex("left", "account") }}>
          <section data-workspace-reveal className="asset-account-card card p-5">
            <div className="mb-5 flex items-center justify-between"><div className="flex min-w-0 items-center gap-2"><h3 className="text-base font-bold">账户资产</h3><QuoteSourceBadge records={positions} quotes={quotes} /></div><div className="flex items-center gap-1.5"><button type="button" disabled={shareOpening} onClick={async () => { if (shareOpening) return; setShareOpening(true); try { preloadDailyPnlTemplates(summary.day >= 0); await waitForDailyPnlTemplates(); setDailyShareOpen(true); } finally { setShareOpening(false); } }} title={shareOpening ? "正在准备分享图…" : "分享当日盈亏"} aria-label="分享当日盈亏" className="inline-flex h-6 w-6 flex-none items-center justify-center rounded-[7px] border border-edge bg-white text-muted shadow-sm transition-all duration-200 hover:-translate-y-px hover:bg-brand-hover hover:text-ink active:scale-[.97] disabled:opacity-50 dark:border-white/10 dark:bg-[#1c222d] dark:text-white/70 dark:hover:bg-white/10 dark:hover:text-white"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3"><circle cx="18" cy="5" r="2.2" /><circle cx="6" cy="12" r="2.2" /><circle cx="18" cy="19" r="2.2" /><path d="m8 11 8-5M8 13l8 5" /></svg></button><RefreshButton busy={refreshing === "assets"} disabled={refreshing !== null} onClick={() => void handleRefresh("assets")} title="刷新账户资产" /></div></div>
            <div className="asset-account-highlight">
              <div className="asset-account-primary">
                <div className="asset-account-primary-label"><CurrencyPicker context="asset" prefix="总资产" /></div>
                <div className="asset-account-total"><strong className="asset-account-amount tabular-nums"><AccountOverviewValue value={totalAsset} symbol={symbol} hidden={!assetsVisible} pending={!effectiveBalancesReady} forceCompact={currencyDisplayUnit === "compact"} /></strong><button type="button" onClick={() => setAssetsVisible((visible) => !visible)} className="asset-privacy-button text-muted" title={assetsVisible ? "隐藏资产金额" : "显示资产金额"} aria-label={assetsVisible ? "隐藏资产金额" : "显示资产金额"}><VisibilityIcon hidden={!assetsVisible} className="h-4 w-4" /></button></div>
              </div>
              <div className="asset-account-day"><span className="block text-xs text-muted">当日盈亏</span><strong className={`mt-1 block text-sm tabular-nums ${summary.day >= 0 ? "text-up" : "text-down"}`}><AccountOverviewValue value={summary.day} hidden={!assetsVisible} signed forceCompact={currencyDisplayUnit === "compact"} /></strong></div>
            </div>
            <div className="asset-account-metrics">
              <div><span className="text-xs text-muted">持仓总市值</span><strong className="mt-1 block text-sm tabular-nums"><AccountOverviewValue value={summary.asset} hidden={!assetsVisible} forceCompact={currencyDisplayUnit === "compact"} /></strong></div>
              <button
                type="button"
                disabled={!onOpenPnlAnalysis}
                onClick={onOpenPnlAnalysis}
                title="查看资产盈亏分析"
                className="asset-pnl-shortcut text-left"
                onPointerDown={() => preloadView("pnl")}
                onPointerEnter={event => { if (event.pointerType === "mouse") preloadView("pnl"); }}
                onFocus={() => preloadView("pnl")}
              >
                <span className="text-xs text-muted">
                  持仓总盈亏
                  {onOpenPnlAnalysis && <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="ml-1 inline-block h-3 w-3">
                    <path d="m9 18 6-6-6-6" />
                  </svg>}
                </span>
                <strong className={`mt-1 block text-sm tabular-nums ${!Number.isFinite(summary.pnl) ? "text-muted" : summary.pnl >= 0 ? "text-up" : "text-down"}`}><AccountOverviewValue value={summary.pnl} hidden={!assetsVisible} signed forceCompact={currencyDisplayUnit === "compact"} /></strong>
              </button>
              <div><div className="flex items-center gap-1"><span className="text-xs text-muted"><span className="md:hidden">可用现金</span><span className="hidden md:inline">现金</span></span><span className="md:hidden"><CashBalanceEditor preferredCurrency={displayCurrency} frozenByCurrency={frozenByCurrency} onSaved={handleFundBalances} /></span></div><strong className="mt-1 block text-sm tabular-nums"><span className="md:hidden"><AccountOverviewValue value={Math.max(0, cashTotal - frozenCashTotal)} hidden={!assetsVisible} pending={!effectiveBalancesReady} forceCompact={currencyDisplayUnit === "compact"} /></span><span className="hidden md:inline"><AccountOverviewValue value={cashTotal} hidden={!assetsVisible} pending={!effectiveBalancesReady} forceCompact={currencyDisplayUnit === "compact"} /></span></strong></div>
            </div>
            <div className="mt-6"><div className="mb-2 flex items-center justify-between"><span className="text-xs font-semibold">资产分布</span><span className="text-[11px] text-muted">按市场</span></div><div className="flex h-2 overflow-hidden rounded-full bg-bg-gray">{marketEntries.map(([key, value], index) => <span key={key} style={{ width: `${Number.isFinite(summary.asset) && summary.asset > 0 && Number.isFinite(value.asset) ? value.asset / summary.asset * 100 : 0}%`, background: ["#f071b8", "#5579ed", "#31c2ad", "#f3b94f"][index % 4] }} />)}</div><div className="mt-3 grid grid-cols-2 gap-2">{marketEntries.map(([key, value], index) => <div key={key} className="flex items-center justify-between text-xs"><span className="flex items-center gap-1.5 text-muted"><i className="h-2 w-2 rounded-full" style={{ background: ["#f071b8", "#5579ed", "#31c2ad", "#f3b94f"][index % 4] }} />{marketMeta(key).label}</span><b>{Number.isFinite(summary.asset) && summary.asset > 0 && Number.isFinite(value.asset) ? `${(value.asset / summary.asset * 100).toFixed(1)}%` : "—"}</b></div>)}</div></div>
          </section>
          {renderModuleHandle("left", "account")}
        </div>

        <div id="asset-trend" {...moduleDragProps("left", "trend")} className={moduleWrapperClass("left", "trend")} style={{ order: moduleOrderIndex("left", "trend") }}>
          <section data-workspace-reveal className="card relative overflow-visible">
            <div role="group" aria-label="趋势类型" className="flex items-end gap-4 border-b border-edge px-4 pt-3 sm:gap-6">
              {([["return", "收益率趋势图"], ["asset", "总资产趋势图"]] as const).map(([key, label]) => (
                <button key={key} type="button" aria-pressed={chartTab === key} onClick={() => setChartTab(key)}
                  className={`relative shrink-0 whitespace-nowrap px-0.5 pb-3 transition-colors ${chartTab === key ? "text-[15px] font-bold text-ink" : "text-sm font-medium text-muted hover:text-ink"}`}>
                  {label}
                  {chartTab === key && <i className="absolute inset-x-1 bottom-0 h-[2px] rounded-full bg-[#3297f6]" />}
                </button>
              ))}
            </div>
            <div className="relative flex items-center gap-2 px-4 py-3">
              <div ref={periodList} role="group" aria-label="趋势周期" className="asset-trend-periods flex min-w-0 flex-1 gap-2 overflow-x-auto pr-1">
                {PERIODS.map(([key, label]) => (
                  <Capsule key={key} variant="secondary" aria-pressed={period === key} type="button"
                    onClick={() => { setPeriod(key); setDatePickerOpen(false); setPnlExpanded(false); }}
                    className={`flex-none rounded-full border px-3 py-1.5 text-xs font-semibold ${period === key ? "border-[#3297f6] bg-[#3297f6]/10 text-[#3297f6]" : "border-edge text-muted hover:bg-bg-gray"}`}>
                    {label}
                  </Capsule>
                ))}
              </div>
              <button ref={datePickerTrigger} type="button" aria-expanded={datePickerOpen} aria-controls={datePickerOpen ? datePickerId : undefined}
                onClick={() => setDatePickerOpen(open => !open)}
                className={`inline-flex h-8 w-10 flex-none items-center justify-center rounded-full border transition-colors ${period === "custom" || datePickerOpen ? "border-[#3297f6] bg-[#3297f6]/10 text-[#3297f6]" : "border-edge text-muted hover:bg-bg-gray hover:text-ink"}`}
                title="选择日期区间" aria-label="选择日期区间">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4" aria-hidden="true">
                  <path d="M4 5h16M7 3v4m10-4v4M5 9h14v11H5z" /><path d="m9 14 2 2 4-5" />
                </svg>
              </button>
              {datePickerOpen && <DateRangePicker id={datePickerId} range={customRange} onClose={closeDatePicker}
                onApply={(range) => { setCustomRange(range); setPeriod("custom"); closeDatePicker(); setPnlExpanded(false); }} />}
            </div>
            {period === "custom" && <div className="px-4 pb-2 text-xs font-semibold text-muted">
              {customRange.start === customRange.end
                ? <time dateTime={customRange.start}>{formatDateRange(customRange)}</time>
                : formatDateRange(customRange)}
            </div>}
            {chartTab === "return" && <div className="flex items-start justify-between gap-3 px-4"><div className="min-w-0 flex-1"><CurrencyPicker context="trend" prefix="已核验区间盈亏" /><strong className={`mt-1 block max-w-[15rem] text-xl tabular-nums ${!Number.isFinite(cumulative) ? "text-muted" : cumulative >= 0 ? "text-up" : "text-down"}`}><AccountOverviewValue value={cumulative} hidden={!assetsVisible} forceCompact={currencyDisplayUnit === "compact"} /></strong></div><div className="relative flex-none text-right"><button type="button" onClick={() => setWeightMenuOpen((open) => !open)} aria-expanded={weightMenuOpen} className="inline-flex items-center gap-1 rounded-lg px-1 py-1 text-xs font-semibold text-muted transition-colors hover:bg-bg-gray hover:text-ink">收益率·{weighting === "simple" ? "简单加权" : "时间加权"}<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" className={`h-3 w-3 transition-transform ${weightMenuOpen ? "rotate-180" : ""}`}><path d="m5 7 5 5 5-5" /></svg></button>{weightMenuOpen && <><div className="fixed inset-0 z-30" onClick={() => setWeightMenuOpen(false)} /><div className="absolute right-0 top-full z-40 mt-1 min-w-[160px] overflow-hidden rounded-xl border border-edge-strong bg-white p-1 shadow-xl dark:bg-[#1b2029]">{WEIGHT_OPTIONS.map(([key, label]) => <button key={key} type="button" onClick={() => { setWeighting(key); setWeightMenuOpen(false); }} className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-xs transition-colors ${weighting === key ? "bg-[var(--capsule-fill)] font-bold text-white" : "text-ink hover:bg-bg-gray"}`}><span>{label}</span>{weighting === key && <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3"><path d="m2.4 6.4 2.5 2.5 4.7-5.8" /></svg>}</button>)}</div></>}<strong className={`mt-1 block text-base tabular-nums ${!Number.isFinite(returnRate) ? "text-muted" : returnRate >= 0 ? "text-up" : "text-down"}`}>{assetsVisible ? fmtPct(returnRate) : "******"}</strong></div></div>}
            {chartTab === "asset" && (
              <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-1 px-4">
                <div className="min-w-0">
                  <CurrencyPicker context="trend" prefix="最近日终估值" />
                  {latestAsset != null && <strong className="mt-1 block text-xl tabular-nums">
                    <AccountOverviewValue value={latestAsset} hidden={!assetsVisible} forceCompact={currencyDisplayUnit === "compact"} />
                  </strong>}
                </div>
                {latestAssetDate && !(period === "custom" && customRange.start === customRange.end) &&
                  <time dateTime={latestAssetDate} className="pb-1 text-xs tabular-nums text-muted">{formatRangeDate(latestAssetDate)}</time>}
              </div>
            )}
            {chartTab === "return" && <div className="mx-4 mt-3 flex items-center justify-between gap-3 rounded-lg bg-bg-gray px-3 py-2 text-xs">
              <div className="relative">
                <button type="button" onClick={() => setBenchOpen((open) => !open)} aria-expanded={benchOpen} className="inline-flex items-center gap-1.5 text-ink transition-colors hover:text-ink">
                  <i className="h-2 w-2 rounded-full bg-[#ef5b19]" />
                  <span>{Number.isFinite(benchDiff) ? (benchDiff! >= 0 ? "跑赢" : "跑输") : "基准对比"}</span>
                  <i className="h-2 w-2 rounded-full bg-[#4a90d9]" />
                  <span className="font-semibold">{benchLabel}</span>
                  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" className={`h-3 w-3 text-muted transition-transform ${benchOpen ? "rotate-180" : ""}`}><path d="m5 7 5 5 5-5" /></svg>
                  {assetsVisible ? (benchDiff !== null ? <b title={comparisonDay ? `对比日期 ${comparisonDay}` : undefined} className={`tabular-nums ${benchDiff >= 0 ? "text-up" : "text-down"}`}>{fmtPct(benchDiff)}</b> : <span className="text-faint">—</span>) : <b className="text-faint">******</b>}
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
            {trendLoading ? <div className="mx-4 mb-4 h-[330px] animate-pulse rounded-xl bg-bg-gray" aria-hidden /> : hasTrend ? <><PnlTrendChart points={EMPTY_CHART_POINTS} tab={chartTab} weighting={weighting} benchLabel={benchLabel} observed={chart} currency={displayCurrency} maskValues={!assetsVisible} />{!hasPersonalTrend && observed && <p className="px-4 pb-3 text-center text-xs text-muted">{observed.failed ? "个人历史估值暂时无法读取" : "暂无可比较的个人历史估值"}</p>}</> : <div className="flex h-[330px] flex-col items-center justify-center gap-3 px-8 text-center text-sm text-muted"><span>{observed?.failed ? "日终趋势暂时无法读取" : chartTab === "asset" ? "暂无已核验的总资产估值" : "暂无可比较的历史收益率"}</span><button type="button" onClick={() => setRetryTick((tick) => tick + 1)} className="rounded-full border border-edge px-3.5 py-1.5 text-xs font-semibold text-ink-2 transition-colors hover:bg-brand-hover dark:border-white/20">重新获取</button></div>}
          </section>
          {renderModuleHandle("left", "trend")}
        </div>

        <div {...moduleDragProps("left", "pnlRank")} className={moduleWrapperClass("left", "pnlRank")} style={{ order: moduleOrderIndex("left", "pnlRank") }}>
          <section className="card overflow-hidden">
            <div className="border-b border-edge px-4 py-4">
              <div className="asset-ranking-heading flex flex-wrap items-center justify-between gap-3"><h3 className="whitespace-nowrap text-base font-bold">持仓盈亏排行</h3><span className="text-[11px] text-muted">更新至 {formatRangeDate(activeRange.end)}</span></div>
              <div className="mt-2"><MarketPills value={pnlMarket} onChange={(key) => { setPnlMarket(key); setPnlExpanded(false); }} /></div>
            </div>
            <div className="grid grid-cols-[48px_minmax(0,1fr)_110px] bg-bg-gray px-4 py-2.5 text-[11px] font-semibold text-muted"><span>序号</span><span>名称 / 代码</span><span className="text-right">盈亏 / 明细</span></div>
            <div>{shownPnlPositions.map(({ record, pnl }, index) => {
              const icon = stockIcons[`${record.market.toUpperCase()}:${record.code.toUpperCase()}`];
              return <div key={record.id} className="grid grid-cols-[48px_minmax(0,1fr)_110px] items-center border-t border-edge px-4 py-3 text-xs transition-colors first:border-t-0 hover:bg-bg-gray/60 dark:hover:bg-[#1b2230]">
                <span className="font-semibold tabular-nums">{String(index + 1).padStart(2, "0")}</span>
                <span className="flex min-w-0 items-center gap-2">
                  <span className="relative flex-none"><StockIconAvatar src={icon} name={record.name} market={record.market} code={record.code} /><EtfDoubleBadge market={record.market} code={record.code} name={record.name} /></span>
                  <span className="min-w-0"><b className="block truncate">{record.name}</b><small className="mt-0.5 flex min-w-0 items-center gap-1.5 text-muted"><MarketCodeBadge market={record.market} code={record.code} /><span className="truncate">{record.code}</span><StockConnectBadge variant="label" market={record.market} accountMarket={record.accountMarket} /><QuoteRowHint market={record.market} quote={quotes[record.id]} quotes={quotes} /></small></span>
                </span>
                <span className={`text-right font-bold tabular-nums ${pnl >= 0 ? "text-up" : "text-down"}`}>{pnl >= 0 ? "+" : "−"}{compactMoney(Math.abs(pnl))}</span>
              </div>;
            })}</div>
            {shownPnlPositions.length === 0 && <div className="py-10 text-center text-xs text-muted">当前市场暂无可计算的持仓盈亏</div>}
            {pnlPositions.length > 10 && <button type="button" onClick={() => setPnlExpanded((expanded) => !expanded)} className="flex w-full items-center justify-center gap-1 border-t border-edge py-3 text-xs font-semibold text-muted transition-colors hover:bg-bg-gray hover:text-ink">{pnlExpanded ? "收起" : `显示更多（另 ${pnlPositions.length - 10} 只）`}<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" className={`h-3 w-3 transition-transform ${pnlExpanded ? "rotate-180" : ""}`}><path d="m5 7 5 5 5-5" /></svg></button>}
          </section>
          {renderModuleHandle("left", "pnlRank")}
        </div>

        <div {...moduleDragProps("left", "funds")} className={moduleWrapperClass("left", "funds")} style={{ order: moduleOrderIndex("left", "funds") }}>
          <FundsPanel ownerId={ownerId} holdingAssets={holdingAssetsByCurrency} balanceOverrides={effectiveFundBalances} onBalancesChange={handleFundBalances} />
          {renderModuleHandle("left", "funds")}
        </div>
      </aside>

      <button type="button" className="asset-analysis-resizer" onPointerDown={startResize} onDoubleClick={resetSplit} title="左右拖动调整布局宽度，双击恢复默认" aria-label="调整资产分析左右布局宽度"><span /><i>⋮</i></button>

      <main className="flex min-w-0 flex-col gap-4">
        <div {...moduleDragProps("right", "overview")} className={moduleWrapperClass("right", "overview")} style={{ order: moduleOrderIndex("right", "overview") }}>
          <section data-workspace-reveal className="mobile-hide-duplicate-summary card p-5">
            <div className="mb-2"><h3 className="text-base font-bold">账户总览</h3></div>
            <MarketPills value={assetMarket} onChange={setAssetMarket} />
            <div className="mt-5 grid max-w-[1120px] grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-7">{accountOverviewItems.map(([label, value]) => <div key={label} className="min-w-0" title={label === "可用现金" ? "现金余额已含借记卡 / 预付卡余额（信用卡额度不计）" : label === "银行卡现金" ? "「我的卡」里借记卡 / 预付卡余额折算成显示货币；信用卡额度属于可透支额度，不计入现金" : undefined}><div className="flex h-7 items-center gap-1"><span className="block truncate text-[11px] text-muted">{label === "净资产" ? `净资产(${accountCurrency})` : label}</span>{label === "可用现金" && <CashBalanceEditor preferredCurrency={marketCurrency || displayCurrency} frozenByCurrency={frozenByCurrency} onSaved={handleFundBalances} />}</div><strong className={`mt-1 block min-w-0 text-sm tabular-nums ${label === "当日盈亏" || label === "浮动盈亏" ? Number(value) >= 0 ? "text-up" : "text-down" : ""}`}><AccountOverviewValue value={Number(value)} hidden={!assetsVisible} pending={label === "银行卡现金" ? !fundBalancesReady : (label === "净资产" || label === "可用现金") && !effectiveBalancesReady} forceCompact={currencyDisplayUnit === "compact"} /></strong></div>)}</div>
          </section>
          {renderModuleHandle("right", "overview")}
        </div>

        <div id="asset-holdings" {...moduleDragProps("right", "holdings")} className={moduleWrapperClass("right", "holdings")} style={{ order: moduleOrderIndex("right", "holdings") }}>
          <section className="card overflow-hidden">
            <div className="border-b border-edge px-5 py-4">
              <h3 className="mb-3 text-base font-bold">持仓分布</h3>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0"><MarketPills value={holdingsMarket} onChange={(key) => { setHoldingsMarket(key); setHoldingSearch(""); setHoldingPage(1); }} /></div>
                <div className="flex items-center gap-1.5">
                  <RefreshButton busy={refreshing === "holdings"} disabled={refreshing !== null} onClick={() => void handleRefresh("holdings")} title="刷新持仓" />
                  <label className="relative block">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted"><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></svg>
                    <input value={holdingSearch} onChange={(event) => { setHoldingSearch(event.target.value); setHoldingPage(1); }} className="h-8 w-[150px] rounded-full border border-edge-strong bg-white pl-8 pr-3 text-xs text-ink placeholder:text-faint dark:bg-[#1c222d]" placeholder="代码 / 名称" />
                  </label>
                  <HoldingColumnsButton onClick={() => setColumnManagerOpen(true)} />
                </div>
              </div>
            </div>
            <AssetHoldingList records={pagedPositions} columns={enabledHoldingColumns.map(column => column.key)} cell={holdingCell} currency={displayCurrency} sort={holdingSort} onSort={key => { if (key) toggleHoldingSort(key); else { setHoldingSort(null); setHoldingPage(1); } }} onAction={(record, action) => {
              if (action === "dividend") setDividendTarget(record);
              else setTradeTarget({ record, side: action === "buy" ? "buy" : "sell", ...(action === "close" ? { qty: Number(record.qty) || 0, intent: "close" as const } : {}) });
            }} />
            <div className="asset-desktop-holdings overflow-x-auto"><table className="mobile-analysis-holdings w-full text-xs" style={{ minWidth: `${Math.max(760, enabledHoldingColumns.length * 130)}px` }}><thead><tr className="bg-bg-gray text-muted">{enabledHoldingColumns.map((column) => { const active = holdingSort?.key === column.key; return <th key={column.key} data-holding-column={column.key} className={`px-4 py-3 ${column.key === "identity" ? "text-left" : "text-right"}`}><button type="button" onClick={() => toggleHoldingSort(column.key)} className={`inline-flex items-center gap-1 whitespace-nowrap transition-colors hover:text-ink ${column.key === "identity" ? "" : "flex-row-reverse"} ${active ? "text-ink" : ""}`}>{HOLDING_COLUMN_LABELS[column.key]}<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" className={`h-3 w-3 ${active ? "opacity-100" : "opacity-25"}`}><path d={active && holdingSort?.dir === "asc" ? "m5 12 5-5 5 5" : "m5 8 5 5 5-5"} /></svg></button></th>; })}</tr></thead><tbody>{pagedPositions.map((record) => <tr key={record.id} className="cursor-pointer border-t border-edge transition-colors hover:bg-bg-gray/60 dark:hover:bg-[#1b2230]" onClick={(e) => setCtxMenu({ x: e.clientX, y: e.clientY, record })} onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY, record }); }}>{enabledHoldingColumns.map((column) => <td key={column.key} data-holding-column={column.key} className={`px-4 py-3 tabular-nums ${column.key === "identity" ? "text-left" : "text-right"}`}>{holdingCell(record, column.key)}</td>)}</tr>)}</tbody></table>{visiblePositions.length === 0 && <div className="py-14 text-center text-sm text-muted">{holdingSearch ? "没有匹配的持仓" : "当前市场暂无持仓"}</div>}</div>
            {visiblePositions.length === 0 && <div className="asset-mobile-holdings py-14 text-center text-sm text-muted">{holdingSearch ? "没有匹配的持仓" : "当前市场暂无持仓"}</div>}
            {holdingPageCount > 1 && <div className="border-t border-edge bg-bg-gray/50 px-4 py-3"><div className="text-left text-xs text-muted">共 {visiblePositions.length} 项 · 每页 {HOLDINGS_PAGE_SIZE} 项</div><Pagination page={safeHoldingPage} total={holdingPageCount} onChange={setHoldingPage} /></div>}
          </section>
          {renderModuleHandle("right", "holdings")}
        </div>

        <div {...moduleDragProps("right", "orders")} className={moduleWrapperClass("right", "orders")} style={{ order: moduleOrderIndex("right", "orders") }}>
          {ordersError && !displayOrders.length ? <div role="alert" className="rounded-2xl border border-edge bg-white p-4 text-sm text-muted"><span>{ordersError}</span><button type="button" className="ml-3 font-semibold text-ink" disabled={ordersLoading} onClick={()=>void handleRefresh("orders")}>{ordersLoading?"读取中…":"重新读取"}</button></div> : <TradeOrdersPanel
            ownerId={ownerId}
            orders={displayOrders}
            quotes={quotes}
            loading={ordersLoading}
            stockIcons={stockIcons}
            storageKey="fire:asset-order-tab"
            onRefresh={() => handleRefresh("orders")}
          />}
          {renderModuleHandle("right", "orders")}
        </div>
        <div id="asset-calendar" {...moduleDragProps("right", "calendar")} className={moduleWrapperClass("right", "calendar")} style={{ order: moduleOrderIndex("right", "calendar") }}>
          <PnlCalendar
            title="盈亏日历"
            className="card p-5"
            days={calendarDays}
            yearSummary={calendarYear}
            loading={closesLoading}
            month={calMonth}
            onMonthChange={(next) => {
              setCalMonth(next);
              savePnlCalendarPref({ month: next });
            }}
            view={calView}
            onViewChange={(next) => {
              setCalView(next);
              savePnlCalendarPref({ view: next });
            }}
            mode={calMode}
            onModeChange={(next) => {
              setCalMode(next);
              savePnlCalendarPref({ mode: next });
            }}
            market={calMarket}
            onMarketChange={(next) => {
              setCalMarket(next);
              savePnlCalendarPref({ market: next });
            }}
            formatAmount={calendarAmount}
            formatCompact={calendarCompact}
            formatNarrow={calendarNarrow}
            stockIcons={stockIcons}
            onDayClick={(date) => {
              const rows = registeredCalendar?.details[date] ?? buildDayDetailRows({ date, positions: calendarRows, closesMap: recordCloses, rates });
              if (rows.length > 0) setDayDetail({ date, rows });
            }}
            dayDetail={dayDetail}
            onDayDetailClose={() => setDayDetail(null)}
          />
          {renderModuleHandle("right", "calendar")}
        </div>
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
