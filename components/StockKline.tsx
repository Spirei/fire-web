"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import echarts, { type EChartsInstance } from "@/lib/echarts";
import RainbowNumberInput from "@/components/RainbowNumberInput";
import MarketCodeBadge from "@/components/MarketCodeBadge";

interface KlineItem { d: string; o: number; h: number; l: number; c: number; v: number }
interface IntradayPoint { time: string; price: number; volume?: number }
interface FiveDayPoint extends IntradayPoint { date: string }
/** 比较标的：与主图共用 X 轴，按相对区间首价归一化的涨跌幅%折线叠加。 */
export interface CompareItem { market: string; code: string; name: string; color: string }
interface Props { market: string; code: string; name?: string; height?: number }
interface ChartCacheEntry { at: number; items: KlineItem[]; intraday: IntradayPoint[]; fiveDay: FiveDayPoint[]; sessionDay: FiveDayPoint[] }
interface MAConfig { enabled: boolean; period: number; color: string }

type Range = "DAY" | "5D" | "DAILY" | "WEEK" | "MONTH" | "QUARTER" | "YEAR" | "YTD";
type Session = "ALL" | "OVERNIGHT" | "PRE" | "REGULAR" | "AFTER";
type ChartStyle = "area" | "line" | "marked" | "step" | "hlc" | "baseline" | "candle" | "hollow" | "ohlc";

const RANGES: { value: Range; label: string }[] = [
  { value: "5D", label: "5日" }, { value: "DAILY", label: "日K" }, { value: "WEEK", label: "周K" },
  { value: "MONTH", label: "月K" }, { value: "YEAR", label: "年K" }
];
const KLINE_VIEW_KEY = "fire:kline-view";
const RANGE_VALUES: Range[] = ["DAY", "5D", "DAILY", "WEEK", "MONTH", "QUARTER", "YEAR", "YTD"];
const SESSION_VALUES: Session[] = ["ALL", "OVERNIGHT", "PRE", "REGULAR", "AFTER"];
/** 涨跌幅比较候选（常见美股比较标的，贴近参考图）。 */
const COMPARE_CANDIDATES: { market: string; code: string; name: string }[] = [
  { market: "US", code: "AAPL", name: "苹果" },
  { market: "US", code: "TSLA", name: "特斯拉" },
  { market: "US", code: "MU", name: "美光科技" },
  { market: "US", code: "AVGO", name: "博通" },
  { market: "US", code: "MSFT", name: "微软" },
  { market: "US", code: "GOOGL", name: "谷歌-A" },
  { market: "US", code: "AMZN", name: "亚马逊" },
  { market: "US", code: "META", name: "Meta" }
];
/** 比较折线色板（循环使用）。 */
const COMPARE_COLORS = ["#4f7dff", "#f59e0b", "#a55eea", "#00b894", "#e84393", "#00cec9", "#d63031", "#6c5ce7"];
/** 比较候选市场中文名。 */
const COMPARE_MARKET_LABEL: Record<string, string> = { US: "美股", HK: "港股", CN: "A股", JP: "日股", KR: "韩股", SG: "新加坡" };
interface KlineView {
  range: Range;
  session: Session;
  minutes: number;
}
function readKlineView(): KlineView | null {
  try {
    const raw = localStorage.getItem(KLINE_VIEW_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<KlineView>;
    return {
      range: v.range && RANGE_VALUES.includes(v.range) ? v.range : "DAILY",
      session: v.session && SESSION_VALUES.includes(v.session) ? v.session : "ALL",
      minutes: typeof v.minutes === "number" && v.minutes > 0 ? v.minutes : 1
    };
  } catch {
    return null;
  }
}
function saveKlineView(view: KlineView) {
  try {
    localStorage.setItem(KLINE_VIEW_KEY, JSON.stringify(view));
  } catch {
    /* 忽略存储异常 */
  }
}

const KLINE_SETTINGS_KEY = "fire:kline-settings";
interface KlineSettings {
  indicators: string[];
  maConfigs: MAConfig[];
  adjust: "qfq" | "none" | "hfq";
  style: ChartStyle;
  maLinesVisible: boolean;
  showMAValues: boolean;
}
const INDICATOR_KEYS = ["MA", "EMA", "BOLL", "MACD", "KDJ", "RSI", "VOL", "AMT"] as const;
function readKlineSettings(): KlineSettings | null {
  try {
    const raw = localStorage.getItem(KLINE_SETTINGS_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<KlineSettings>;
    const indicators = Array.isArray(v.indicators)
      ? v.indicators.filter((x): x is string => typeof x === "string" && (INDICATOR_KEYS as readonly string[]).includes(x))
      : [];
    const maConfigs = Array.isArray(v.maConfigs)
      ? v.maConfigs.filter((c): c is MAConfig => !!c && typeof c.enabled === "boolean" && typeof c.period === "number" && typeof c.color === "string")
      : [];
    return {
      indicators: Array.isArray(v.indicators) ? Array.from(new Set(indicators)) : ["MA", "VOL"],
      maConfigs: maConfigs.length > 0 ? maConfigs : DEFAULT_MA_CONFIGS,
      adjust: v.adjust === "none" ? "none" : v.adjust === "hfq" ? "hfq" : "qfq",
      style: v.style && ALL_STYLES.includes(v.style) ? v.style : (readBasicStyleOrder()[0] || "area"),
      maLinesVisible: typeof v.maLinesVisible === "boolean" ? v.maLinesVisible : true,
      showMAValues: v.showMAValues === true
    };
  } catch {
    return null;
  }
}
function saveKlineSettings(s: KlineSettings) {
  try {
    localStorage.setItem(KLINE_SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* 忽略存储异常 */
  }
}
const SESSIONS: { value: Session; label: string; time?: string; available?: boolean }[] = [
  { value: "ALL", label: "全天" },
  { value: "OVERNIGHT", label: "夜盘", time: "20:00–03:59", available: true },
  { value: "PRE", label: "盘前", time: "04:00–09:29" },
  { value: "REGULAR", label: "盘中", time: "09:30–16:00" },
  { value: "AFTER", label: "盘后", time: "16:01–19:59" }
];
const STYLE_MENU_POSITION_KEY = "fire-web:stock-chart-style-menu-position";
const STYLE_ORDER_KEY = "fire-web:stock-chart-basic-style-order";
const BASIC_STYLES: ChartStyle[] = ["area", "line", "marked", "step"];
const ADVANCED_STYLES: ChartStyle[] = ["hlc", "baseline", "candle", "hollow", "ohlc"];
const ALL_STYLES: ChartStyle[] = [...BASIC_STYLES, ...ADVANCED_STYLES];
const chartCache = new Map<string, ChartCacheEntry>();
const DEFAULT_MA_CONFIGS: MAConfig[] = [
  { enabled: true, period: 5, color: "#ff8a1f" }, { enabled: true, period: 10, color: "#19a9dd" },
  { enabled: true, period: 20, color: "#df63d2" }, { enabled: true, period: 30, color: "#2481e8" },
  { enabled: false, period: 60, color: "#20c38a" }, { enabled: false, period: 120, color: "#10dce3" },
  { enabled: false, period: 250, color: "#ff595e" }, { enabled: false, period: 500, color: "#ffca35" }
];

function movingAverage(values: number[], period: number) {
  let sum = 0;
  return values.map((value, index) => {
    sum += value;
    if (index >= period) sum -= values[index - period];
    return index >= period - 1 ? Number((sum / period).toFixed(4)) : null;
  });
}

function exponentialAverage(values: number[], period: number) {
  const alpha = 2 / (period + 1);
  let previous = values[0] || 0;
  return values.map((value, index) => {
    previous = index === 0 ? value : value * alpha + previous * (1 - alpha);
    return Number(previous.toFixed(4));
  });
}

function bollinger(values: number[], period: number, multiple = 2) {
  const mid = movingAverage(values, period);
  return { mid, upper: values.map((_, index) => {
    if (index < period - 1 || mid[index] == null) return null;
    const window = values.slice(index - period + 1, index + 1);
    const mean = mid[index] as number;
    const deviation = Math.sqrt(window.reduce((sum, value) => sum + (value - mean) ** 2, 0) / period);
    return Number((mean + deviation * multiple).toFixed(4));
  }), lower: values.map((_, index) => {
    if (index < period - 1 || mid[index] == null) return null;
    const window = values.slice(index - period + 1, index + 1);
    const mean = mid[index] as number;
    const deviation = Math.sqrt(window.reduce((sum, value) => sum + (value - mean) ** 2, 0) / period);
    return Number((mean - deviation * multiple).toFixed(4));
  }) };
}

function readBasicStyleOrder(): ChartStyle[] {
  try {
    const raw = localStorage.getItem(STYLE_ORDER_KEY);
    if (!raw) return BASIC_STYLES;
    const saved = JSON.parse(raw);
    if (Array.isArray(saved)) {
      const valid = saved.filter((value): value is ChartStyle => ALL_STYLES.includes(value));
      if (valid.length) return [...new Set(valid)];
    }
  } catch {}
  return BASIC_STYLES;
}

function clampStyleMenuPosition(x: number, y: number, anchor?: DOMRect) {
  const width = 190;
  const height = 440;
  const left = anchor?.left || 0;
  const top = anchor?.top || 0;
  return {
    x: Math.max(8 - left, Math.min(x, window.innerWidth - width - 8 - left)),
    y: Math.max(8 - top, Math.min(y, window.innerHeight - Math.min(height, window.innerHeight - 16) - 8 - top))
  };
}

function LineIcon({ area = false }: { area?: boolean }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true">
    {area && <path className="chart-style-area-fill" d="M3 17l5-5 4 3 7-8 2 2v12H3z" />}
    <path className="chart-style-line" d="M3 17l5-5 4 3 7-8 2 2" />
  </svg>;
}
function CandleIcon({ hollow = false, ohlc = false }: { hollow?: boolean; ohlc?: boolean }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" className="candle-icon">
    {ohlc ? <><path d="M7 3v18M4 8h3M7 16h3M17 3v18M14 7h3M17 15h3" /></> : <><path d="M7 3v4M7 17v4M17 3v4M17 17v4" /><rect x="4" y="7" width="6" height="10" className={hollow ? "is-hollow" : ""} /><rect x="14" y="7" width="6" height="10" className={hollow ? "is-hollow" : ""} /></>}
  </svg>;
}
function MarkedLineIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path className="chart-style-line" d="M3 17l5-5 4 3 7-8 2 2" /><circle cx="8" cy="12" r="1.7" /><circle cx="12" cy="15" r="1.7" /><circle cx="19" cy="7" r="1.7" /></svg>;
}
function BaselineIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path className="chart-baseline-guide" d="M3 13h18" /><path className="chart-style-line" d="M3 17l5-8 4 7 7-10 2 4" /></svg>;
}
function EyeIcon({ hidden = false }: { hidden?: boolean }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" /><circle cx="12" cy="12" r="3" />{hidden && <path d="M4 4l16 16" />}</svg>;
}
function GearIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1Z" /></svg>;
}
function MonitoringIcon() {
  return <svg viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M120-120v-80l80-80v160h-80Zm160 0v-240l80-80v320h-80Zm160 0v-320l80 81v239h-80Zm160 0v-239l80-80v319h-80Zm160 0v-400l80-80v480h-80ZM120-327v-113l280-280 160 160 280-280v113L560-447 400-607 120-327Z" /></svg>;
}
function MiniChevron({ open }: { open: boolean }) {
  return <svg viewBox="0 0 20 20" aria-hidden="true" className={open ? "is-open" : ""}><path d="m6 8 4 4 4-4" /></svg>;
}
function StyleIcon({ style }: { style: ChartStyle }) {
  if (style === "candle") return <CandleIcon />;
  if (style === "hollow") return <CandleIcon hollow />;
  if (style === "ohlc") return <CandleIcon ohlc />;
  if (style === "hlc") return <LineIcon area />;
  if (style === "marked") return <MarkedLineIcon />;
  if (style === "baseline") return <BaselineIcon />;
  return <LineIcon area={style === "area"} />;
}
function Chevron({ open }: { open: boolean }) {
  return <svg viewBox="0 0 20 20" aria-hidden="true" className={open ? "is-open" : ""}><path d="m5.5 7.5 4.5 4.5 4.5-4.5" /></svg>;
}

function rangeStart(range: Range): Date | null {
  const now = new Date();
  if (["DAILY", "WEEK", "MONTH", "QUARTER", "YEAR"].includes(range)) return null;
  if (range === "YTD") return new Date(now.getFullYear(), 0, 1);
  return new Date(now.getTime() - 10 * 86400000);
}

function cutoffMonths(months: number) {
  const date = new Date();
  date.setMonth(date.getMonth() - months);
  return date.toISOString().slice(0, 10);
}

function aggregateKline(rows: KlineItem[], period: "WEEK" | "MONTH" | "QUARTER" | "YEAR") {
  const groups = new Map<string, KlineItem[]>();
  for (const row of rows) {
    const date = new Date(`${row.d}T00:00:00Z`);
    let key = row.d.slice(0, 7);
    if (period === "WEEK") {
      const day = date.getUTCDay() || 7;
      date.setUTCDate(date.getUTCDate() - day + 1);
      key = date.toISOString().slice(0, 10);
    } else if (period === "QUARTER") {
      key = `${date.getUTCFullYear()}-Q${Math.floor(date.getUTCMonth() / 3) + 1}`;
    } else if (period === "YEAR") {
      key = String(date.getUTCFullYear());
    }
    const group = groups.get(key) || [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    d: group[group.length - 1].d,
    o: group[0].o,
    c: group[group.length - 1].c,
    h: Math.max(...group.map((row) => row.h)),
    l: Math.min(...group.map((row) => row.l)),
    v: group.reduce((sum, row) => sum + row.v, 0)
  }));
}

function aggregateIntraday(rows: Array<IntradayPoint & { date?: string }>, minutes: number) {
  const groups = new Map<string, Array<IntradayPoint & { date?: string }>>();
  rows.forEach((row) => {
    const [hour, minute] = row.time.split(":").map(Number);
    const bucket = Math.floor((hour * 60 + minute) / minutes) * minutes;
    const label = `${row.date ? `${row.date} ` : ""}${String(Math.floor(bucket / 60) % 24).padStart(2, "0")}:${String(bucket % 60).padStart(2, "0")}`;
    const group = groups.get(label) || [];
    group.push(row); groups.set(label, group);
  });
  return [...groups.entries()].map(([label, group]) => {
    const prices = group.map((row) => row.price);
    return { label, open: prices[0], close: prices[prices.length - 1], low: Math.min(...prices), high: Math.max(...prices), volume: group.reduce((sum, row) => sum + (row.volume || 0), 0) };
  });
}

function sessionMatch(time: string, session: Session) {
  if (session === "ALL") return true;
  const [h, m] = time.split(":").map(Number);
  const minute = h * 60 + m;
  if (session === "OVERNIGHT") return minute >= 1200 || minute < 240;
  if (session === "PRE") return minute >= 240 && minute < 570;
  if (session === "REGULAR") return minute >= 570 && minute <= 960;
  return minute > 960 && minute < 1200;
}

function fmtVolume(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "—";
  if (value >= 1e8) return `${trimZero((value / 1e8).toFixed(2))}亿`;
  if (value >= 1e4) return `${trimZero((value / 1e4).toFixed(2))}万`;
  return Math.round(value).toLocaleString();
}

function fmtAmount(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "—";
  if (value >= 1e8) return `${trimZero((value / 1e8).toFixed(2))}亿`;
  if (value >= 1e4) return `${trimZero((value / 1e4).toFixed(2))}万`;
  return value.toLocaleString();
}

/** 价格格式化：美股(US)保留 3 位小数、其余 2 位；无效值返回 —。 */
function fmtNumMarket(n: number | null | undefined, market?: string) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return Number(n).toLocaleString("zh-CN", { minimumFractionDigits: market === "US" ? 3 : 2, maximumFractionDigits: market === "US" ? 3 : 2 });
}

/** Google Finance 空状态占位图：水平灰线 + 蓝色节点 + 浅蓝虚线波浪 + 「无数据」。 */
function GoogleEmptyState({ text = "无数据" }: { text?: string }) {
  return (
    <div className="stock-chart-empty" aria-hidden="true">
      <svg viewBox="0 0 528 300" className="stock-chart-empty-svg" preserveAspectRatio="xMidYMid meet">
        {/* 水平基线 */}
        <line x1="5" y1="176" x2="519" y2="176" stroke="#cbcfd4" strokeWidth="1.4" />
        {/* 浅蓝虚线波浪（跨越基线上下） */}
        <path
          d="M20 150 C34 128, 44 118, 58 116 C72 114, 82 120, 92 130 C102 140, 110 108, 120 84 C130 60, 148 44, 164 52 C180 60, 186 92, 190 122 C194 152, 198 160, 210 168 C240 196, 250 240, 268 254 C286 268, 302 246, 310 216 C314 200, 316 184, 322 172 C344 124, 360 80, 376 80 C392 80, 402 120, 410 148 C416 168, 420 168, 428 168"
          fill="none" stroke="#a6c6ff" strokeWidth="2" strokeDasharray="7 7" strokeLinecap="round"
        />
        {/* 基线节点 */}
        <circle cx="20" cy="168" r="7" fill="#4c8df6" />
        <circle cx="210" cy="168" r="7" fill="#4c8df6" />
        <circle cx="322" cy="168" r="7" fill="#4c8df6" />
        <circle cx="428" cy="168" r="7" fill="#4c8df6" />
      </svg>
      <span className="stock-chart-empty-text">{text}</span>
    </div>
  );
}

function trimZero(raw: string) {
  return raw.replace(/\.00$/, "");
}

function tooltipDate(label: string, intradayMode: boolean, marketName: string) {
  const [labelDate, labelTime] = label.split(" ");
  const dayOnly = /^\d{4}-\d{2}-\d{2}$/.test(labelDate);
  const dateText = dayOnly ? labelDate.replaceAll("-", "/") : new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
  const date = dayOnly ? new Date(`${labelDate}T00:00:00`) : new Date();
  const weekday = Number.isNaN(date.getTime()) ? "" : ` 星期${"日一二三四五六"[date.getDay()]}`;
  return `${dateText}${intradayMode ? ` ${labelTime || label}` : ""} ${marketName === "US" ? "美东" : ""}${weekday}`;
}

export default function StockKline({ market, code, name, height = 420 }: Props) {
  // 服务端与浏览器首帧使用同一默认值；持久化偏好在 layout effect 中恢复，避免详情直达时 hydration 差异。
  const [initialView] = useState<KlineView | null>(null);
  const [initialSettings] = useState<KlineSettings | null>(null);
  const [range, setRange] = useState<Range>("DAY");
  const [allDayView, setAllDayView] = useState(true);
  const [intradayMinutes, setIntradayMinutes] = useState(initialView?.minutes ?? 1);
  const [session, setSession] = useState<Session>("ALL");
  const [style, setStyle] = useState<ChartStyle>(initialSettings?.style ?? (readBasicStyleOrder()[0] || "area"));
  const [items, setItems] = useState<KlineItem[]>([]);
  /** 当前 items 对应的数据形态：daily=日K / week / month / quarter / year=富途周期K */
  const [itemsKind, setItemsKind] = useState<"daily" | "week" | "month" | "quarter" | "year">("daily");
  /** 前复权 / 后复权 */
  const [adjust, setAdjust] = useState<"qfq" | "none" | "hfq">(initialSettings?.adjust ?? "qfq");
  const [itemsAdjust, setItemsAdjust] = useState<"qfq" | "none" | "hfq">("qfq");
  const [intraday, setIntraday] = useState<IntradayPoint[]>([]);
  const [fiveDay, setFiveDay] = useState<FiveDayPoint[]>([]);
  const [sessionDay, setSessionDay] = useState<FiveDayPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [longRangeLoading, setLongRangeLoading] = useState(false);
  /** 比较标的价格序列（按主图 labels 对齐后的绝对价格 + 归一化涨跌幅%）。 */
  const [compareSeries, setCompareSeries] = useState<{ key: string; values: (number | null)[]; prices: (number | null)[] }[]>([]);
  /** 主图当前悬停时点的索引（供对比表格联动显示该时点的价格/涨跌）。 */
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  /** 比较功能内部状态：已选标的 + 候选/搜索行情 + 下拉开关。 */
  const [compareItems, setCompareItems] = useState<CompareItem[]>([]);
  const [compareQuotes, setCompareQuotes] = useState<Record<string, { price?: number | null; change?: number | null; changePct?: number | null; prevClose?: number | null } | null>>({});
  const [compareOpen, setCompareOpen] = useState(false);
  const [compareSearch, setCompareSearch] = useState("");
  const [compareSearchResults, setCompareSearchResults] = useState<{ symbol: string; code: string; name: string; market: string; price: number | null; changePct: number | null }[]>([]);
  const [compareSearchLoading, setCompareSearchLoading] = useState(false);
  // 首次打开展示的候选：常用比较标的，过滤掉本股（不可与自己比较），去重。
  const compareCandidates = useMemo(() => {
    const list = COMPARE_CANDIDATES;
    const seen = new Set<string>();
    return list.filter((item) => {
      const key = `${item.market.toUpperCase()}:${item.code.toUpperCase()}`;
      if (item.market.toUpperCase() === market.toUpperCase() && item.code.toUpperCase() === code.toUpperCase()) return false;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [market, code]);
  // 默认显示成交量（VOL）；成交额（AMT）由用户手动开启
  const [selectedIndicators, setSelectedIndicators] = useState<string[]>(initialSettings?.indicators ?? ["MA", "VOL"]);
  const [maConfigs, setMaConfigs] = useState<MAConfig[]>(initialSettings?.maConfigs ?? DEFAULT_MA_CONFIGS);
  const [maPanelOpen, setMaPanelOpen] = useState(false);
  const [maSettingsOpen, setMaSettingsOpen] = useState(false);
  const [chartSettingsOpen, setChartSettingsOpen] = useState(false);
  const [showMAValues, setShowMAValues] = useState<boolean>(initialSettings?.showMAValues ?? false);
  const [maLinesVisible, setMaLinesVisible] = useState<boolean>(initialSettings?.maLinesVisible ?? true);
  const [maLegendPosition, setMaLegendPosition] = useState({ x: 16, y: 8 });
  const [error, setError] = useState("");
  const [sessionOpen, setSessionOpen] = useState(false);
  const [periodOpen, setPeriodOpen] = useState(false);
  const [styleOpen, setStyleOpen] = useState(false);
  const [basicStyleOrder, setBasicStyleOrder] = useState<ChartStyle[]>(BASIC_STYLES);
  const [draggedStyle, setDraggedStyle] = useState<ChartStyle | null>(null);
  const [styleNotice, setStyleNotice] = useState("");
  const [styleMenuPosition, setStyleMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  const chartInst = useRef<EChartsInstance | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const styleTriggerRef = useRef<HTMLButtonElement>(null);
  const styleDragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null);
  const suppressStyleClickRef = useRef(false);
  const maDragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null);
  const rangeScrollRef = useRef<HTMLDivElement>(null);
  const rangeDragRef = useRef<{ pointerId: number; startX: number; startLeft: number; moved: boolean } | null>(null);
  const suppressRangeClickRef = useRef(false);

  // 每次进入个股或切换股票，概览默认展示全天分时 K 线；其他时段仅由用户主动选择。
  useLayoutEffect(() => {
    const restored = readKlineView();
    setRange("DAY");
    setAllDayView(true);
    setSession("ALL");
    if (restored) setIntradayMinutes(restored.minutes);
    const restoredSettings = readKlineSettings();
    setStyle(restoredSettings?.style ?? (readBasicStyleOrder()[0] || "area"));
    if (restoredSettings) {
      setAdjust(restoredSettings.adjust);
      setSelectedIndicators(restoredSettings.indicators);
      setMaConfigs(restoredSettings.maConfigs);
      setMaLinesVisible(restoredSettings.maLinesVisible);
      setShowMAValues(restoredSettings.showMAValues);
    }
    setSessionOpen(false);
  }, [market, code]);

  // 记住上次的周期/时段/分钟视图，刷新或切换股票后自动还原
  useEffect(() => {
    saveKlineView({ range, session, minutes: intradayMinutes });
  }, [range, session, intradayMinutes]);

  // 记住技术指标与图表设置（复权/样式/MA），刷新或切换股票后自动还原
  useEffect(() => {
    saveKlineSettings({ indicators: selectedIndicators, maConfigs, adjust, style, maLinesVisible, showMAValues });
  }, [selectedIndicators, maConfigs, adjust, style, maLinesVisible, showMAValues]);

  useEffect(() => {
    const order = readBasicStyleOrder();
    setBasicStyleOrder(order);
    // 样式由上方设置持久化负责，这里只恢复菜单顺序，避免把用户上次选的样式覆盖回第一个基础样式
    setStyle(readKlineSettings()?.style ?? readBasicStyleOrder()[0] ?? "area");
  }, []);

  useEffect(() => {
    if (!styleNotice) return;
    const timer = window.setTimeout(() => setStyleNotice(""), 1800);
    return () => window.clearTimeout(timer);
  }, [styleNotice]);

  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!toolbarRef.current?.contains(event.target as Node)) {
        setSessionOpen(false);
        setPeriodOpen(false);
        setStyleOpen(false);
        setCompareOpen(false);
        setChartSettingsOpen(false);
      }
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);

  useEffect(() => {
    if (!styleOpen || !styleMenuPosition) return;
    const keepInView = () => setStyleMenuPosition((position) => position ? clampStyleMenuPosition(position.x, position.y, styleTriggerRef.current?.getBoundingClientRect()) : position);
    window.addEventListener("resize", keepInView);
    return () => window.removeEventListener("resize", keepInView);
  }, [styleOpen, styleMenuPosition]);

  const toggleStyleMenu = () => {
    setPeriodOpen(false);
    setCompareOpen(false);
    setChartSettingsOpen(false);
    if (styleOpen) {
      setStyleOpen(false);
      return;
    }
    const rect = styleTriggerRef.current?.getBoundingClientRect();
    let position = rect ? { x: rect.width - 190, y: rect.height + 8 } : { x: -122, y: 46 };
    try {
      const saved = JSON.parse(localStorage.getItem(STYLE_MENU_POSITION_KEY) || "null");
      if (Number.isFinite(saved?.x) && Number.isFinite(saved?.y)) {
        // relative=true 为新版相对坐标；旧版保存的是视窗绝对坐标，打开时自动迁移。
        position = saved.relative || !rect ? saved : { x: saved.x - rect.left, y: saved.y - rect.top };
      }
    } catch {}
    setStyleMenuPosition(clampStyleMenuPosition(position.x, position.y, rect));
    setStyleOpen(true);
    setSessionOpen(false);
  };

  const beginStyleDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    // 所有菜单按钮都保留原生点击 / 排序交互；仅菜单空白区域用于拖动整个浮层。
    if ((event.target as HTMLElement).closest("button")) return;
    if (!styleMenuPosition || event.button !== 0) return;
    styleDragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: styleMenuPosition.x, originY: styleMenuPosition.y, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveStyleMenu = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = styleDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    suppressStyleClickRef.current = true;
    setStyleMenuPosition(clampStyleMenuPosition(drag.originX + dx, drag.originY + dy, styleTriggerRef.current?.getBoundingClientRect()));
  };

  const endStyleDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = styleDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    styleDragRef.current = null;
    if (drag.moved && styleMenuPosition) localStorage.setItem(STYLE_MENU_POSITION_KEY, JSON.stringify({ ...styleMenuPosition, relative: true }));
    window.setTimeout(() => { suppressStyleClickRef.current = false; }, 0);
  };

  const chooseStyle = (nextStyle: ChartStyle) => {
    if (suppressStyleClickRef.current) return;
    setStyle(nextStyle);
    setStyleOpen(false);
  };

  const moveBasicStyle = (target: ChartStyle) => {
    if (!draggedStyle || draggedStyle === target) return;
    setBasicStyleOrder((current) => {
      const next = current.filter((item) => item !== draggedStyle);
      next.splice(next.indexOf(target), 0, draggedStyle);
      localStorage.setItem(STYLE_ORDER_KEY, JSON.stringify(next));
      setStyle(next[0] || "area");
      setStyleNotice("拖动成功，排序已自动保存");
      return next;
    });
    setDraggedStyle(null);
  };

  const renderBasicStyle = (item: ChartStyle) => {
    const labels: Record<ChartStyle, string> = { area: "面积图", line: "折线图", marked: "带标记线", step: "阶梯线", hlc: "HLC 区域", baseline: "基准线", candle: "实心 K 线", hollow: "空心 K 线", ohlc: "OHLC" };
    const icon = item === "area" ? <LineIcon area /> : item === "line" ? <LineIcon /> : item === "marked" ? <MarkedLineIcon /> : item === "step" ? <span className="chart-type-glyph step">⌜</span> : item === "hlc" ? <span className="chart-type-glyph hlc">≋</span> : item === "baseline" ? <BaselineIcon /> : <CandleIcon hollow={item === "hollow"} ohlc={item === "ohlc"} />;
    return <button key={item} type="button" draggable className={`${style === item ? "is-selected" : ""} ${draggedStyle === item ? "is-sorting" : ""}`} onDragStart={(event) => { setDraggedStyle(item); event.dataTransfer.effectAllowed = "move"; }} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }} onDrop={(event) => { event.preventDefault(); moveBasicStyle(item); }} onDragEnd={() => setDraggedStyle(null)} onClick={() => chooseStyle(item)} title="拖动调整顺序，减号移出常用区">
      {icon}<span>{labels[item]}</span><span className="style-item-actions"><span className="style-sort-grip" aria-hidden="true">⋮⋮</span><span className="style-remove-mark" role="button" tabIndex={0} aria-label={`移除${labels[item]}`} title="移出常用区" onClick={(event) => { event.stopPropagation(); removeStyleFromFavorites(item); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); removeStyleFromFavorites(item); } }}>−</span></span>
    </button>;
  };

  const removeStyleFromFavorites = (item: ChartStyle) => {
    setBasicStyleOrder((current) => {
      if (current.length <= 1) {
        setStyleNotice("至少保留一种常用图形");
        return current;
      }
      const index = current.indexOf(item);
      const next = current.filter((value) => value !== item);
      localStorage.setItem(STYLE_ORDER_KEY, JSON.stringify(next));
      if (style === item) setStyle(next[Math.min(index, next.length - 1)] || "area");
      setStyleNotice("已移出常用区并自动保存");
      return next;
    });
  };

  const addStyleToFavorites = (item: ChartStyle) => {
    setBasicStyleOrder((current) => {
      if (current.includes(item)) return current;
      const next = [...current, item];
      localStorage.setItem(STYLE_ORDER_KEY, JSON.stringify(next));
      return next;
    });
    setStyle(item);
    setStyleNotice("已加入常用区并自动保存");
  };

  useLayoutEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const key = `${market}:${code}`;
    const storageKey = `fire-web:stock-chart:${key}`;
    let cached = chartCache.get(key);
    if (!cached) {
      try {
        const stored = JSON.parse(localStorage.getItem(storageKey) || sessionStorage.getItem(storageKey) || "null") as ChartCacheEntry | null;
        if (stored) cached = stored;
      } catch {}
    }
    const fresh = cached ?? null;
    if (fresh) {
      setItems(fresh.items); setIntraday(fresh.intraday); setFiveDay(fresh.fiveDay); setSessionDay(fresh.sessionDay);
      setLoading(false); setError("");
    } else {
      setItems([]); setIntraday([]); setFiveDay([]); setSessionDay([]);
      setLoading(true); setError("");
    }

    let hasVisibleData = !!fresh && (fresh.sessionDay.length > 0 || fresh.intraday.length > 0 || fresh.fiveDay.length > 0);
    const snapshot: ChartCacheEntry = fresh ? { ...fresh, at: Date.now() } : { at: Date.now(), items: [], intraday: [], fiveDay: [], sessionDay: [] };
    const persistSnapshot = () => {
      const value = { ...snapshot };
      chartCache.set(key, value);
      try { sessionStorage.setItem(storageKey, JSON.stringify(value)); } catch {}
      try { localStorage.setItem(storageKey, JSON.stringify(value)); } catch {}
    };
    const reveal = () => { hasVisibleData = true; if (!cancelled) { setLoading(false); setError(""); } };
    const getJson = async (url: string, init?: RequestInit) => {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    };

    const tasks = [
      getJson(`/api/kline/session-day?market=${encodeURIComponent(market)}&code=${encodeURIComponent(code)}`).then((data) => {
        const rows = Array.isArray(data?.points) ? data.points : [];
        if (rows.length) { snapshot.sessionDay = rows; snapshot.at = Date.now(); persistSnapshot(); }
        if (!cancelled) setSessionDay(rows);
        if (rows.length) reveal();
      }),
      getJson("/api/charts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: [{ id: "detail", market, code }] }) }).then((data) => {
        const rows = Array.isArray(data?.charts?.detail?.points) ? data.charts.detail.points : [];
        if (rows.length) { snapshot.intraday = rows; snapshot.at = Date.now(); persistSnapshot(); }
        if (!cancelled) setIntraday(rows);
        if (rows.length) reveal();
      }),
      getJson(`/api/kline/five-day?market=${encodeURIComponent(market)}&code=${encodeURIComponent(code)}`).then((data) => {
        const rows = Array.isArray(data?.points) ? data.points : [];
        if (rows.length) { snapshot.fiveDay = rows; snapshot.at = Date.now(); persistSnapshot(); }
        if (!cancelled) setFiveDay(rows);
        if (rows.length) reveal();
      })
    ];
    Promise.allSettled(tasks).then(() => {
      if (cancelled) return;
      setLoading(false);
      if (!hasVisibleData) setError("暂无走势数据");
    });
    return () => { cancelled = true; controller.abort(); };
  }, [market, code]);

  // 长周期数据较大，首屏不回源；用户选择日/周/月/季/年 K 时才加载一次并复用缓存。
  // 周/月/季/年K 走富途周期接口（qfq 前复权，与富途行情一致），日K/YTD 走日线接口。
  useEffect(() => {
    const need =
      range === "WEEK" ? "week" :
      range === "MONTH" ? "month" :
      range === "QUARTER" ? "quarter" :
      range === "YEAR" ? "year" :
      range === "DAILY" || range === "YTD" ? "daily" : "";
    if (!need || range === "DAY" || range === "5D" || (items.length && itemsKind === need && itemsAdjust === adjust)) {
      setLongRangeLoading(false);
      return;
    }
    const controller = new AbortController();
    const key = `${market}:${code}:${need}:${adjust}`;
    setLongRangeLoading(true);
    const periodQuery = need === "daily" ? "" : `&period=${need}`;
    fetch(`/api/kline/full?market=${encodeURIComponent(market)}&code=${encodeURIComponent(code)}&limit=3200${periodQuery}&adjust=${adjust}`, { signal: controller.signal })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`)))
      .then((data) => {
        const rows = Array.isArray(data?.items) ? data.items : [];
        setItems(rows);
        setItemsKind(need);
        setItemsAdjust(adjust);
        setLongRangeLoading(false);
        const cached = chartCache.get(key) || { at: Date.now(), items: [], intraday: [], fiveDay: [], sessionDay: [] };
        const value = { ...cached, items: rows, at: Date.now() };
        chartCache.set(key, value);
        try { sessionStorage.setItem(`fire-web:stock-chart:${key}`, JSON.stringify(value)); } catch {}
        try { localStorage.setItem(`fire-web:stock-chart:${key}`, JSON.stringify(value)); } catch {}
      })
      .catch((error) => { if (error?.name !== "AbortError") { setLongRangeLoading(false); setError("长周期数据加载失败"); } });
    return () => controller.abort();
  }, [range, market, code, items.length, itemsKind, adjust, itemsAdjust]);

  const data = useMemo(() => {
    const effectiveStyle = style;
    const needsOhlc = effectiveStyle === "hlc" || effectiveStyle === "candle" || effectiveStyle === "hollow" || effectiveStyle === "ohlc";
    if (range === "DAY") {
      const latestDay = fiveDay[fiveDay.length - 1]?.date;
      const dayFallback = latestDay ? fiveDay.filter((point) => point.date === latestDay) : [];
      const source = sessionDay.length ? sessionDay : intraday.length ? intraday : dayFallback;
      const filtered = source.filter((point) => sessionMatch(point.time, session));
      // 全天是独立视图，不读写周期选择；仅蜡烛类图形在内部按 5 分钟聚合，避免整日 1 分钟 K 线被压到不足一个像素。
      const minutes = allDayView ? (needsOhlc ? 5 : 1) : intradayMinutes;
      if (needsOhlc || minutes > 1) {
        const buckets = aggregateIntraday(filtered, minutes);
        return { labels: buckets.map((p) => p.label), values: buckets.map((p) => p.close), volumes: buckets.map((p) => p.volume), previous: buckets.map((p, i) => i ? buckets[i - 1].close : p.open), ohlc: buckets.map((p) => [p.open, p.close, p.low, p.high]) };
      }
      return { labels: filtered.map((p) => p.time), values: filtered.map((p) => p.price), volumes: filtered.map((p) => p.volume || 0), previous: filtered.map((_p, i) => i ? filtered[i - 1].price : filtered[0]?.price || 0), ohlc: [] as number[][] };
    }
    if (range === "5D" && fiveDay.length) {
      if (needsOhlc) {
        const buckets = aggregateIntraday(fiveDay, 30);
        return { labels: buckets.map((p) => p.label), values: buckets.map((p) => p.close), volumes: buckets.map((p) => p.volume), previous: buckets.map((p, i) => i ? buckets[i - 1].close : p.open), ohlc: buckets.map((p) => [p.open, p.close, p.low, p.high]) };
      }
      return { labels: fiveDay.map((p) => `${p.date} ${p.time}`), values: fiveDay.map((p) => p.price), volumes: fiveDay.map((p) => p.volume || 0), previous: fiveDay.map((_p, i) => i ? fiveDay[i - 1].price : fiveDay[0]?.price || 0), ohlc: [] as number[][] };
    }
    const start = rangeStart(range);
    let filtered = start ? items.filter((item) => new Date(`${item.d}T00:00:00`) >= start) : items;
    if (range === "5D") filtered = items.slice(-5);
    // 周期切换时防止用旧周期数据按新周期聚合出错误K线：仅当 itemsKind 与当前周期匹配时才聚合，
    // 否则保持空等待新数据返回（避免日K→周K切换闪现单根异常红K）。
    if (range === "DAILY") filtered = itemsKind === "daily" ? items.filter((item) => item.d >= cutoffMonths(4)) : [];
    if (range === "WEEK") filtered = itemsKind === "week" ? aggregateKline(items.filter((item) => item.d >= cutoffMonths(19)), range) : [];
    if (range === "MONTH") filtered = itemsKind === "month" ? aggregateKline(items.filter((item) => item.d >= cutoffMonths(72)), range) : [];
    if (range === "QUARTER") filtered = itemsKind === "quarter" ? aggregateKline(items.filter((item) => item.d >= cutoffMonths(144)), range) : [];
    if (range === "YEAR") filtered = itemsKind === "year" ? aggregateKline(items, range) : [];
    return { labels: filtered.map((p) => p.d), values: filtered.map((p) => p.c), volumes: filtered.map((p) => p.v || 0), previous: filtered.map((p, i) => i ? filtered[i - 1].c : p.o), ohlc: filtered.map((p) => [p.o, p.c, p.l, p.h]) };
  }, [range, session, style, items, intraday, fiveDay, sessionDay, intradayMinutes, allDayView]);

  // 主图时点变化时，对比表格默认定位到最后一个（最新）时点；鼠标悬停时联动更新。
  useEffect(() => {
    if (data.labels.length) setHoverIndex(data.labels.length - 1);
  }, [data.labels.length]);

  // 比较标的价格序列：与主图共用 X 轴，按各自 source 的首个有效价归一化为涨跌幅%。
  useEffect(() => {
    if (compareItems.length === 0) {
      setCompareSeries([]);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    // 主图 X 轴：DAY→session-day 的 time(HH:mm) / intraday；5D→five-day 的 `date time`；其余→item.d(YYYY-MM-DD)。
    const buildOne = async (item: CompareItem) => {
      const key = `${item.market.toUpperCase()}:${item.code.toUpperCase()}`;
      try {
        let points: { k: string; price: number }[] = [];
        if (range === "DAY" || range === "5D") {
          const resp = await fetch(`/api/kline/session-day?market=${encodeURIComponent(item.market)}&code=${encodeURIComponent(item.code)}`, { signal: controller.signal });
          const payload = resp.ok ? await resp.json().catch(() => null) : null;
          const rows = Array.isArray(payload?.points) ? payload.points as FiveDayPoint[] : [];
          points = rows.map((p) => ({ k: `${p.date} ${p.time}`, price: p.price }));
          if (range === "DAY") {
            const latestDay = points[points.length - 1]?.k.slice(0, 10);
            points = points.filter((p) => p.k.startsWith(latestDay || ""));
          }
        } else {
          const periodQuery = range === "WEEK" ? "&period=week" : range === "MONTH" ? "&period=month" : range === "QUARTER" ? "&period=quarter" : range === "YEAR" ? "&period=year" : "";
          const resp = await fetch(`/api/kline/full?market=${encodeURIComponent(item.market)}&code=${encodeURIComponent(item.code)}&limit=3200${periodQuery}&adjust=qfq`, { signal: controller.signal });
          const payload = resp.ok ? await resp.json().catch(() => null) : null;
          const rows = Array.isArray(payload?.items) ? payload.items as KlineItem[] : [];
          points = rows.map((p) => ({ k: p.d, price: p.c }));
        }
        if (points.length === 0) return { key, values: data.labels.map(() => null), prices: data.labels.map(() => null) };
        const byKey = new Map(points.map((p) => [p.k, p.price]));
        let base: number | null = null;
        for (const label of data.labels) {
          const price = byKey.get(label);
          if (price != null) { base = price; break; }
        }
        const prices = data.labels.map((label) => byKey.get(label) ?? null);
        const values = prices.map((price) => {
          if (price == null || !base) return null;
          return (price - base) / base * 100;
        });
        return { key, values, prices };
      } catch {
        return { key, values: data.labels.map(() => null), prices: data.labels.map(() => null) };
      }
    };
    // 并行拉取所有比较标的，避免串行等待；先到先渲染。
    Promise.all(compareItems.map((item) => buildOne(item))).then((results) => {
      if (!cancelled) setCompareSeries(results);
    });
    return () => { cancelled = true; controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compareItems, range, data.labels.length]);

  /** 添加比较标的（自动分配折线颜色，已在列表则不重复）。 */
  const addCompare = (item: { market: string; code: string; name: string }) => {
    // 不允许与自己比较：本股作为比较标的无意义，直接拦截。
    if (item.market.toUpperCase() === market.toUpperCase() && item.code.toUpperCase() === code.toUpperCase()) return;
    setCompareItems((current) => {
      if (current.some((c) => c.market.toUpperCase() === item.market.toUpperCase() && c.code.toUpperCase() === item.code.toUpperCase())) return current;
      if (current.length >= COMPARE_COLORS.length) return current;
      return [...current, { market: item.market, code: item.code, name: item.name, color: COMPARE_COLORS[current.length] }];
    });
    setCompareOpen(false);
    setCompareSearch("");
    setCompareSearchResults([]);
  };

  /** 移除比较标的，并回收后续折线颜色。 */
  const removeCompare = (item: CompareItem) => {
    setCompareItems((current) => {
      const next = current.filter((c) => !(c.market.toUpperCase() === item.market.toUpperCase() && c.code.toUpperCase() === item.code.toUpperCase()));
      return next.map((c, i) => ({ ...c, color: COMPARE_COLORS[i % COMPARE_COLORS.length] }));
    });
  };

  // 比较候选 + 已选标的统一拉取实时行情（价格 / 涨跌额 / 涨跌幅 / 昨收）用于表格与候选列表。
  useEffect(() => {
    const dedupe = new Map<string, { id: string; market: string; code: string }>();
    // 本股 + 候选 + 已选标的统一拉取，保证对比表格的本股行也能显示真实涨跌（而非 0）。
    [{ market, code }, ...compareCandidates, ...compareItems].forEach((item: { market: string; code: string }) => {
      const id = `${item.market.toUpperCase()}:${item.code.toUpperCase()}`;
      if (!dedupe.has(id)) dedupe.set(id, { id, market: item.market, code: item.code });
    });
    const items = [...dedupe.values()];
    if (items.length === 0) { setCompareQuotes({}); return; }
    const controller = new AbortController();
    fetch("/api/v1/quotes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
      cache: "no-store",
      signal: controller.signal
    })
      .then((r) => r.json().catch(() => null))
      .then((payload) => {
        if (controller.signal.aborted) return;
        setCompareQuotes(payload?.data?.quotes ?? {});
      })
      .catch(() => { if (!controller.signal.aborted) setCompareQuotes({}); });
    return () => controller.abort();
  }, [compareCandidates, compareItems, compareOpen]);

  // 比较搜索（防抖）：输入时调 /api/v1/search。
  useEffect(() => {
    if (!compareOpen) return;
    const q = compareSearch.trim();
    if (!q) { setCompareSearchResults([]); return; }
    const controller = new AbortController();
    setCompareSearchLoading(true);
    const timer = setTimeout(() => {
      fetch(`/api/v1/search?q=${encodeURIComponent(q)}`, { cache: "no-store", signal: controller.signal })
        .then((r) => r.json().catch(() => null))
        .then((payload) => {
          if (controller.signal.aborted) return;
          const results = Array.isArray(payload?.data?.results) ? payload.data.results : [];
          setCompareSearchResults(results.map((r: { symbol?: string; code?: string; name?: string; market?: string; price?: number | null; changePct?: number | null }) => ({
            symbol: String(r.symbol ?? ""), code: String(r.code ?? ""), name: String(r.name ?? ""), market: String(r.market ?? "US"), price: r.price ?? null, changePct: r.changePct ?? null
          })).filter((r: { symbol: string }) => r.symbol));
        })
        .catch(() => { if (!controller.signal.aborted) setCompareSearchResults([]); })
        .finally(() => { if (!controller.signal.aborted) setCompareSearchLoading(false); });
    }, 250);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [compareSearch, compareOpen]);

  useEffect(() => {
    const render = () => {
      if (!chartRef.current) return;
      if (data.values.length === 0) { chartInst.current?.clear(); return; }
      if (!chartInst.current) chartInst.current = echarts.init(chartRef.current, null, { renderer: "canvas" });
      const dark = document.documentElement.classList.contains("dark");
      const ink = dark ? "#e7ebf1" : "#4d5562";
      const muted = dark ? "#8993a2" : "#89919e";
      const grid = dark ? "rgba(255,255,255,.075)" : "rgba(25,35,48,.07)";
      const accent = "#0bb4b4";
      const baseline = Number(data.values[0]);
      const latestPrice = Number(data.values[data.values.length - 1]);
      // 比较模式：主图也统一为折线，并把主序列与各比较标的都归一化为「相对区间首价的涨跌幅%」，
      // 共用同一个 % y 轴，避免主图用价格轴、比较线用 % 轴的双轴混排。
      const isComparing = compareItems.length > 0;
      const mainNorm = baseline ? data.values.map((value) => (value - baseline) / baseline * 100) : data.values.map(() => null as number | null);
      // 副图与主图共用同一套 grid 边距 / boundaryGap / containLabel，确保蜡烛与成交量/成交额柱横向严格对齐
      const gap = range !== "DAY" && range !== "5D";
      // ECharts 会对“显示 X 轴日期标签的副图 grid”自动向左内缩约 24px（即使 containLabel:false），
      // 导致只开单副图（或底部成交量板）时首根柱比蜡烛左移约 3 根。把统一 left 设为 30 可让所有 grid
      // 停在同一个“天然内缩位”，主图/成交量/成交额柱横向逐根对齐（实测残差 < 0.5px）。
      const gridLeft = 30;
      const gridRight = 64;
      const gridContain = false;
      const effectiveStyle = style;
      const candleMode = effectiveStyle === "candle" || effectiveStyle === "hollow" || effectiveStyle === "ohlc";
      // 标注当前周期内的最低点：蜡烛用最低价(l)，折线用收盘价(c)。
      const lowVals = candleMode ? data.ohlc.map((v) => v[2]) : data.values;
      let lowIdx = -1; let lowVal = Infinity;
      lowVals.forEach((v, i) => { if (v != null && Number.isFinite(v) && v > 0 && v < lowVal) { lowVal = v; lowIdx = i; } });
      const lowMark = lowIdx >= 0 ? { coord: [lowIdx, lowVal], value: fmtNumMarket(lowVal, market), name: "最低", label: { position: "bottom" as const } } : null;
      const highVals = candleMode ? data.ohlc.map((v) => v[3]) : data.values;
      let highIdx = -1; let highVal = -Infinity;
      highVals.forEach((v, i) => { if (v != null && Number.isFinite(v) && v > 0 && v > highVal) { highVal = v; highIdx = i; } });
      const highMark = highIdx >= 0 ? { coord: [highIdx, highVal], value: fmtNumMarket(highVal, market), name: "最高", label: { position: "top" as const } } : null;
      // 最低点/最高点标记：确定性的手动坐标（蜡烛用最低价/最高价，折线用收盘价），
      // 在标记点处画蓝色小圆点，并在其下方/上方带蓝框数值标签（参考富途年K）。
      const extremaData = [lowMark, highMark].filter(Boolean);
      const extremaMarkPoint = {
        symbol: "circle",
        symbolSize: 8,
        label: { show: true, formatter: "{c}", fontSize: 11, fontWeight: 700, color: "#1b6de0", backgroundColor: "rgba(255,255,255,.85)", padding: [2, 5], borderRadius: 8, borderColor: "#1b6de0", borderWidth: 1 },
        itemStyle: { color: "#1b6de0" },
        tooltip: { formatter: () => "" }
      };
      const candleSeries = {
        name: name || code,
        type: "candlestick",
        data: data.ohlc,
        barMinWidth: 2,
        markPoint: extremaData.length ? { ...extremaMarkPoint, data: extremaData as { coord: (string | number)[]; value: string }[] } : undefined,
        itemStyle: {
          color: effectiveStyle === "hollow" ? (dark ? "#171b22" : "#fff") : "#e5484d",
          color0: effectiveStyle === "ohlc" ? "transparent" : "#0aa77d",
          borderColor: "#e5484d",
          borderColor0: "#0aa77d",
          borderWidth: effectiveStyle === "ohlc" ? 2 : 1
        }
      };
      const lineSeries = {
        name: name || code, type: "line", data: data.values, smooth: false, showSymbol: style === "marked", connectNulls: true,
        step: effectiveStyle === "step" ? "end" : false,
        // 带标记线即“折线 + 数据节点”；长周期点数过多时自动抽稀，避免整图变成实心圆带。
        showAllSymbol: effectiveStyle === "marked" && data.values.length <= 220,
        symbol: "circle",
        symbolSize: effectiveStyle === "marked" ? (data.values.length > 220 ? 3 : 5) : 0,
        lineStyle: { color: accent, width: 2 }, itemStyle: { color: accent },
        areaStyle: effectiveStyle === "area" ? { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: "rgba(73,145,234,.3)" }, { offset: 1, color: "rgba(73,145,234,.025)" }]) } : undefined,
        markPoint: extremaData.length ? { ...extremaMarkPoint, data: extremaData as { coord: (string | number)[]; value: string }[] } : undefined,
        // 普通图形显示最新价线；“基准线”样式才使用区间首价作为比较基准。
        // 只有最新价为有限数字才画（行情可能是字符串/空，传给 yAxis 会被当成轴名引用而报 yAxis not found）。
        markLine: Number.isFinite(latestPrice) ? { silent: true, symbol: "none", lineStyle: { color: accent, type: "dashed", width: 1 }, label: { show: false }, data: [{ yAxis: latestPrice }] } : undefined
      };
      const hlcSeries = [
        { name: "HLC低点", type: "line", data: data.ohlc.map((v) => v[2]), stack: "hlc", showSymbol: false, lineStyle: { color: "rgba(11,180,180,.45)", width: 1 }, areaStyle: { opacity: 0 } },
        { name: "HLC区间", type: "line", data: data.ohlc.map((v) => Math.max(0, v[3] - v[2])), stack: "hlc", showSymbol: false, lineStyle: { color: "rgba(11,180,180,.45)", width: 1 }, areaStyle: { color: "rgba(11,180,180,.2)" } },
        { name: name || code, type: "line", data: data.values, showSymbol: false, lineStyle: { color: accent, width: 2 }, itemStyle: { color: accent } }
      ];
      const baselineSeries = [{
        name: name || code,
        type: "line",
        data: data.values.map((value, index) => value >= baseline || data.values[index - 1] >= baseline || data.values[index + 1] >= baseline ? value : null),
        showSymbol: false,
        connectNulls: false,
        lineStyle: { color: "#e85d04", width: 2 },
        itemStyle: { color: "#e85d04" },
        areaStyle: { color: "rgba(232,93,4,.09)", origin: Number.isFinite(baseline) ? baseline : undefined },
        markLine: { silent: true, symbol: "none", label: { show: false }, data: [
          ...(Number.isFinite(baseline) ? [{ yAxis: baseline, lineStyle: { color: muted, type: "dotted", width: 1 } }] : []),
          ...(Number.isFinite(latestPrice) ? [{ yAxis: latestPrice, lineStyle: { color: "#e85d04", type: "dotted", width: 1 } }] : [])
        ] }
      }, {
        name: name || code,
        type: "line",
        data: data.values.map((value, index) => value < baseline || data.values[index - 1] < baseline || data.values[index + 1] < baseline ? value : null),
        showSymbol: false,
        connectNulls: false,
        lineStyle: { color: "#0aa77d", width: 2 },
        itemStyle: { color: "#0aa77d" },
        areaStyle: { color: "rgba(10,167,125,.08)", origin: baseline }
      }];
      // 成交额（= 成交量 × 现价估算；与详情页口径一致），柱状图与悬浮提示统一使用
      const amounts = data.volumes.map((value, i) => (value || 0) * (data.values[i] || 0));
      const showAmount = selectedIndicators.includes("AMT");
      const showVolume = selectedIndicators.includes("VOL");
      // 副图面板：成交额在上、成交量在下，可独立开关
      const subPanels: { name: string; data: number[] }[] = [];
      // 比较模式下隐藏成交量/成交额副图，保持折线对比纯净（与 Google 一致）。
      if (!isComparing && showAmount) subPanels.push({ name: "成交额", data: amounts });
      if (!isComparing && showVolume) subPanels.push({ name: "成交量", data: data.volumes });
      const subCount = subPanels.length;
      // 比较模式：主图统一为折线 + 归一化 %；其余（HLC/基准线/蜡烛）仅非比较模式生效。
      const priceSeries = isComparing
        ? [{ ...lineSeries, data: mainNorm, yAxisIndex: subCount + 1, areaStyle: undefined, showSymbol: true, showAllSymbol: true, symbol: "circle", symbolSize: 4, emphasis: { scale: true }, markLine: undefined }]
        : effectiveStyle === "hlc" ? hlcSeries : effectiveStyle === "baseline" ? baselineSeries : [candleMode ? candleSeries : lineSeries];
      const showMA = !(allDayView && range === "DAY" && session === "ALL") && !isComparing && selectedIndicators.includes("MA");
      const enabledMAs = maConfigs.filter((item) => item.enabled);
      const maSeries = showMA && maLinesVisible ? enabledMAs.map((item) => ({
        name: `MA${item.period}`,
        type: "line",
        data: movingAverage(data.values, item.period),
        showSymbol: false,
        symbol: "none",
        connectNulls: false,
        silent: true,
        lineStyle: { color: item.color, width: 1.25, opacity: .95 },
        emphasis: { disabled: true }
      })) : [];
      const emaSeries = !isComparing && selectedIndicators.includes("EMA") ? [{ name: "EMA20", type: "line", data: exponentialAverage(data.values, 20), showSymbol: false, symbol: "none", silent: true, lineStyle: { color: "#22a7e8", width: 1.4 } }] : [];
      const boll = !isComparing && selectedIndicators.includes("BOLL") ? bollinger(data.values, 20) : null;
      const bollSeries = boll ? [
        { name: "BOLL中轨", type: "line", data: boll.mid, showSymbol: false, symbol: "none", silent: true, lineStyle: { color: "#d65ac1", width: 1.2 } },
        { name: "BOLL上轨", type: "line", data: boll.upper, showSymbol: false, symbol: "none", silent: true, lineStyle: { color: "#f59e0b", width: 1 } },
        { name: "BOLL下轨", type: "line", data: boll.lower, showSymbol: false, symbol: "none", silent: true, lineStyle: { color: "#f59e0b", width: 1 } }
      ] : [];
      const lastLabelIndex = Math.max(0, data.labels.length - 1);
      const sessionAxisLabel = (value: string, index: number) => {
        if (range !== "DAY" || session === "ALL") return value;
        if (session === "PRE") return index === 0 ? "04:00" : index === lastLabelIndex ? "☼09:30" : "";
        if (session === "REGULAR") {
          if (index === 0) return "09:30";
          if (index === lastLabelIndex) return "☾16:00";
          if (Math.abs(index - Math.round(lastLabelIndex / 2)) <= 1) return "12:00";
          return "";
        }
        if (session === "AFTER") return index === 0 ? "16:00" : index === lastLabelIndex ? "20:00" : "";
        return value;
      };
      // 5 日数据包含大量分钟点。ECharts 的 auto 抽样会先抽索引、再执行 formatter，
      // 因而很容易只命中第一天。先找出每天的首个点，横轴固定显示各交易日。
      const fiveDayTickIndexes = new Set<number>();
      if (range === "5D") {
        let previousDay = "";
        data.labels.forEach((label, index) => {
          const day = label.slice(0, 10);
          if (day && day !== previousDay) {
            fiveDayTickIndexes.add(index);
            previousDay = day;
          }
        });
      }
      const sessionGraphic = range === "DAY" && (session === "PRE" || session === "AFTER") ? [{
        type: "text",
        left: session === "AFTER" ? undefined : 16,
        right: session === "AFTER" ? 18 : undefined,
        bottom: "22%",
        silent: true,
        style: { text: session === "PRE" ? "盘前" : "盘后", fill: muted, font: "600 12px -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif", textAlign: session === "AFTER" ? "right" : "left" }
      }] : [];
      chartInst.current.setOption({
        animationDuration: 280,
        backgroundColor: "transparent",
        textStyle: { color: ink, fontFamily: "-apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif" },
        graphic: sessionGraphic,
        // TradingView 类交互：滚轮以指针位置缩放，按住鼠标拖动平移；价格与成交额同步。
        dataZoom: [{
          type: "inside",
          xAxisIndex: [0, ...subPanels.map((_, i) => i + 1)],
          filterMode: "none",
          zoomOnMouseWheel: true,
          moveOnMouseWheel: false,
          moveOnMouseMove: true,
          preventDefaultMouseMove: true,
          throttle: 24,
          start: 0,
          end: 100
        }],
        axisPointer: { link: [{ xAxisIndex: "all" }], lineStyle: { color: muted, type: "dashed" }, label: { show: false } },
        tooltip: isComparing ? { trigger: "axis", confine: true, enterable: false, axisPointer: { type: "cross", crossStyle: { color: muted, type: "dashed" } }, backgroundColor: "transparent", borderColor: "transparent", borderWidth: 0, padding: 0, extraCssText: "box-shadow:none;", formatter: (raw: unknown) => { const arr = raw as { dataIndex: number }[]; if (arr && arr.length > 0 && typeof arr[0].dataIndex === "number") { setHoverIndex(arr[0].dataIndex); } return ""; } } : { trigger: "axis", confine: true, enterable: true, axisPointer: { type: "cross", crossStyle: { color: muted, type: "dashed" } }, padding: [10, 12], backgroundColor: dark ? "#20252d" : "#fff", borderColor: dark ? "rgba(255,255,255,.16)" : "#d6dbe2", borderWidth: 1, extraCssText: "border-radius:4px;box-shadow:0 12px 30px rgba(18,25,38,.14)", textStyle: { color: ink }, formatter: (raw: unknown) => {
          const rows = raw as { seriesName: string; axisValue: string; dataIndex: number; data: number }[];
          const p = rows.find((row) => row.seriesName === (name || code)) || rows.find((row) => !["成交量", "成交额", "HLC低点", "HLC区间"].includes(row.seriesName));
          if (!p) return "";
          const price = Number(data.values[p.dataIndex] || 0);
          const previous = Number(data.previous[p.dataIndex] || price);
          const change = price - previous;
          const pct = previous ? change / previous * 100 : 0;
          const color = change >= 0 ? "#e5484d" : "#0aa77d";
          const ohlc = data.ohlc[p.dataIndex] || [];
          const amount = amounts[p.dataIndex] || 0;
          const compact = typeof window !== "undefined" && window.innerWidth <= 767;
          const line = (label: string, value: string, valueColor = ink) => `<div style="display:flex;justify-content:space-between;gap:${compact ? 14 : 26}px;margin-top:${compact ? 2 : 3}px"><span style="color:${muted}">${label}</span><b style="color:${valueColor};font-variant-numeric:tabular-nums">${value}</b></div>`;
          const fullCore = `${ohlc.length ? line("开盘", Number(ohlc[0]).toFixed(3), Number(ohlc[0]) >= previous ? "#e5484d" : "#0aa77d") + line("最高", Number(ohlc[3]).toFixed(3), "#e5484d") + line("最低", Number(ohlc[2]).toFixed(3), "#0aa77d") + line("收盘", Number(ohlc[1]).toFixed(3), color) : line("价格", price.toFixed(3))}${line("涨跌额", `${change >= 0 ? "+" : ""}${change.toFixed(3)}`, color)}${line("涨跌幅", `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`, color)}${line("成交额", fmtAmount(amount))}${line("成交量", fmtVolume(data.volumes[p.dataIndex] || 0))}`;
          const compactCore = `${line("收盘", price.toFixed(3), color)}${line("涨跌额", `${change >= 0 ? "+" : ""}${change.toFixed(3)}`, color)}${line("涨跌幅", `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`, color)}`;
          return `<div style="min-width:${compact ? 132 : 174}px;font-size:${compact ? 11 : 12}px"><div style="font-weight:700;margin-bottom:${compact ? 3 : 5}px">${tooltipDate(p.axisValue, range === "DAY" || range === "5D", market)}</div>${compact ? compactCore : fullCore}</div>`;
        } },
        grid: [
          { left: gridLeft, right: gridRight, top: 16, height: subCount === 0 ? "82%" : subCount === 1 ? "66%" : "56%", containLabel: gridContain },
          ...subPanels.map((_, i) => ({
            left: gridLeft,
            right: gridRight,
            top: subCount === 1 ? "70%" : i === 0 ? "60%" : "81%",
            height: subCount === 1 ? "20%" : i === 0 ? "19%" : "14%",
            containLabel: gridContain
          }))
        ],
        xAxis: [{ type: "category", boundaryGap: gap, data: data.labels, axisLine: { show: false }, axisTick: { show: false }, axisLabel: subCount > 0 ? { show: false } : { color: muted, fontSize: 11, hideOverlap: true, margin: 14, interval: range === "5D" ? (index: number) => fiveDayTickIndexes.has(index) : range === "DAY" && session !== "ALL" ? 0 : "auto", formatter: (value: string, index: number) => { if (range === "DAY" && session !== "ALL") return sessionAxisLabel(value, index); if (range !== "5D" || !value.includes(" ")) return value; return value.slice(5, 10).replace("-", "."); } }, axisPointer: { label: { show: true } } },
          ...subPanels.map((_, i) => ({
            type: "category",
            gridIndex: i + 1,
            boundaryGap: gap,
            data: data.labels,
            axisLine: { lineStyle: { color: grid } },
            axisTick: { show: false },
            axisLabel: i === subCount - 1 ? { color: muted, fontSize: 11, hideOverlap: true, margin: 14, interval: range === "5D" ? (index: number) => fiveDayTickIndexes.has(index) : range === "DAY" && session !== "ALL" ? 0 : "auto", formatter: (value: string, index: number) => { if (range === "DAY" && session !== "ALL") return sessionAxisLabel(value, index); if (range !== "5D" || !value.includes(" ")) return value; return value.slice(5, 10).replace("-", "."); } } : { show: false },
            axisPointer: { label: { show: false } }
          }))
        ],
        yAxis: [
          { type: "value", scale: true, position: "right", axisLine: { show: false }, axisTick: { show: false }, axisLabel: isComparing ? { show: false } : { color: muted, fontSize: 11, formatter: (v: number) => (market === "US" ? Number(v).toFixed(3).replace(/\.?0+$/, "") : Number(v).toFixed(2)) }, splitLine: isComparing ? { show: false } : { lineStyle: { color: grid, type: "dotted" } } },
          ...subPanels.map((_, i) => ({
            type: "value",
            gridIndex: i + 1,
            scale: true,
            axisLine: { show: false },
            axisTick: { show: false },
            axisLabel: { show: false },
            // 隐藏副图 Y 轴十字线标签，避免出现原始长串数字或“—”跟 tooltip 对不上；数值以 tooltip 为准
            axisPointer: { label: { show: false } },
            splitLine: { show: false }
          })),
          ...(isComparing ? [{
            type: "value" as const,
            gridIndex: 0 as const,
            scale: true as const,
            position: "left" as const,
            splitNumber: 3,
            axisLine: { show: false },
            axisTick: { show: false },
            axisLabel: { color: muted, fontSize: 11, formatter: (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)}%` },
            splitLine: { show: false }
          }] : [])
        ],
        series: [...priceSeries, ...maSeries, ...emaSeries, ...bollSeries, ...subPanels.map((panel, i) => ({
          name: panel.name,
          type: "bar",
          xAxisIndex: i + 1,
          yAxisIndex: i + 1,
          data: panel.data.map((value, j) => ({ value, itemStyle: { color: data.values[j] >= data.previous[j] ? "rgba(229,72,77,.9)" : "rgba(10,167,125,.88)" } })),
          barMaxWidth: 13,
          barMinHeight: 2
        })), ...(isComparing && compareSeries.length > 0 ? compareSeries.map((cs) => {
          const meta = compareItems.find((c) => `${c.market.toUpperCase()}:${c.code.toUpperCase()}` === cs.key);
          return {
            name: meta?.name || cs.key,
            type: "line" as const,
            xAxisIndex: 0,
            yAxisIndex: subCount + 1,
            data: cs.values,
            smooth: false,
            showSymbol: true,
            showAllSymbol: true,
            symbol: "circle",
            symbolSize: 4,
            connectNulls: true,
            lineStyle: { color: meta?.color || "#f59e0b", width: 1.8 },
            itemStyle: { color: meta?.color || "#f59e0b" },
            emphasis: { scale: true },
            z: 3
          };
        }) : [])]
      }, { notMerge: true });
      chartInst.current.resize();
    };
    render();
    const observer = new ResizeObserver(render);
    if (chartRef.current) observer.observe(chartRef.current);
    const theme = new MutationObserver(render);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => { observer.disconnect(); theme.disconnect(); };
  }, [data, style, code, name, market, range, session, selectedIndicators, maConfigs, maLinesVisible, compareSeries, compareItems, allDayView]);

  useEffect(() => () => {
    chartInst.current?.dispose();
    chartInst.current = null;
  }, []);

  const sessionLabel = SESSIONS.find((x) => x.value === session)?.label || "全天";
  const intradayPeriodLabel = intradayMinutes < 60 ? `${intradayMinutes}分` : `${intradayMinutes / 60}小时`;
  const noSessionData = range === "DAY" && !loading && (sessionDay.length > 0 || intraday.length > 0 || fiveDay.length > 0) && data.values.length === 0;
  const maLegend = maConfigs.filter((item) => item.enabled).map((item) => {
    const values = movingAverage(data.values, item.period);
    const latest = [...values].reverse().find((value) => value != null);
    return { ...item, latest };
  });
  const toggleIndicator = (key: string) => setSelectedIndicators((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key]);
  const updateMA = (index: number, patch: Partial<MAConfig>) => setMaConfigs((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
  const startMADrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
    maDragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: maLegendPosition.x, originY: maLegendPosition.y, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveMADrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = maDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !chartRef.current) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    const bounds = chartRef.current.getBoundingClientRect();
    setMaLegendPosition({ x: Math.max(6, Math.min(drag.originX + dx, bounds.width - 220)), y: Math.max(5, Math.min(drag.originY + dy, bounds.height - 50)) });
  };
  const endMADrag = (event: React.PointerEvent<HTMLDivElement>) => { if (maDragRef.current?.pointerId === event.pointerId) maDragRef.current = null; };
  const startRangeDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!rangeScrollRef.current) return;
    rangeDragRef.current = { pointerId: event.pointerId, startX: event.clientX, startLeft: rangeScrollRef.current.scrollLeft, moved: false };
  };
  const moveRangeDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = rangeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !rangeScrollRef.current) return;
    const dx = event.clientX - drag.startX;
    if (Math.abs(dx) > 4 && !drag.moved) {
      drag.moved = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    rangeScrollRef.current.scrollLeft = drag.startLeft - dx;
  };
  const endRangeDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (rangeDragRef.current?.pointerId === event.pointerId) {
      if (rangeDragRef.current.moved) suppressRangeClickRef.current = true;
      rangeDragRef.current = null;
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  useLayoutEffect(() => {
    const scroller = rangeScrollRef.current;
    const activeIndex = RANGES.findIndex((item) => item.value === range);
    if (!scroller || activeIndex < 0) return;
    const itemStart = 2 + activeIndex * 42;
    const itemEnd = itemStart + 40;
    if (itemStart < scroller.scrollLeft) scroller.scrollLeft = Math.max(0, itemStart - 2);
    else if (itemEnd > scroller.scrollLeft + scroller.clientWidth) scroller.scrollLeft = itemEnd - scroller.clientWidth + 2;
  }, [range]);

  return <div className="stock-chart-shell w-full">
    <div ref={toolbarRef} className="stock-chart-toolbar" aria-label="走势图控制栏">
      <div className="stock-chart-ranges">
        <button type="button" className={`stock-chart-range stock-chart-all-day ${allDayView && range === "DAY" && session === "ALL" ? "is-active" : ""}`} onClick={() => { setAllDayView(true); setRange("DAY"); setSession("ALL"); setSessionOpen(false); setPeriodOpen(false); setStyleOpen(false); }}>
          全天
        </button>
        <div className="stock-chart-popover-wrap">
          <button type="button" className={`stock-chart-range ${range === "DAY" && session !== "ALL" ? "is-active" : ""}`} onClick={() => { setSessionOpen((v) => !v); setPeriodOpen(false); setStyleOpen(false); }} aria-expanded={sessionOpen}>
            {session === "ALL" ? "时段" : sessionLabel}<Chevron open={sessionOpen} />
          </button>
          {sessionOpen && <div className="stock-chart-menu session-menu" role="menu">
            {SESSIONS.filter((item) => item.value !== "ALL").map((item) => <button key={item.value} type="button" disabled={item.available === false} className={`${session === item.value ? "is-selected" : ""} ${item.available === false ? "is-unavailable" : ""}`} title={item.available === false ? "当前行情源暂无夜盘数据" : undefined} onClick={() => { setAllDayView(false); setSession(item.value); setRange("DAY"); setSessionOpen(false); }}>
              <span>{item.label}</span>{item.time && <small>{item.time}</small>}
            </button>)}
          </div>}
        </div>
        <div ref={rangeScrollRef} className="stock-chart-range-scroll stock-chart-primary-ranges" style={{ "--range-index": Math.max(0, RANGES.findIndex((item) => item.value === range)), "--range-active": RANGES.some((item) => item.value === range) ? 1 : 0 } as CSSProperties} onPointerDown={startRangeDrag} onPointerMove={moveRangeDrag} onPointerUp={endRangeDrag} onPointerCancel={endRangeDrag}>
          <span className="stock-chart-range-indicator" aria-hidden="true" />
          {RANGES.map((item) => <button key={item.value} type="button" data-range={item.value} className={`stock-chart-range ${range === item.value ? "is-active" : ""}`} onClick={() => { if (suppressRangeClickRef.current) { suppressRangeClickRef.current = false; return; } setAllDayView(false); setRange(item.value); setSession("ALL"); setSessionOpen(false); setPeriodOpen(false); }}>{item.label}</button>)}
        </div>
        <div className="stock-chart-popover-wrap period-picker-wrap">
            <button type="button" className={`stock-chart-range period-picker-trigger ${periodOpen ? "is-open" : ""} ${range === "QUARTER" || (!allDayView && range === "DAY") ? "has-value" : ""}`} aria-label="更多 K 线周期" aria-expanded={periodOpen} onClick={() => { setPeriodOpen((open) => !open); setSessionOpen(false); setStyleOpen(false); }}><span>{range === "QUARTER" ? "季K" : !allDayView && range === "DAY" ? intradayPeriodLabel : "周期"}</span><Chevron open={periodOpen} /></button>
            {periodOpen && <div className="stock-chart-menu period-menu" role="menu" aria-label="K 线周期">
              <div className="period-menu-head"><b>K线周期</b></div>
              <section><h4>分钟</h4><div className="period-option-grid is-minutes">{[1,2,3,5,10,15,20,30,45].map((minutes) => <button key={minutes} type="button" className={!allDayView && range === "DAY" && intradayMinutes === minutes ? "is-selected" : ""} onClick={() => { setAllDayView(false); setIntradayMinutes(minutes); setRange("DAY"); setPeriodOpen(false); }}>{minutes}分</button>)}</div></section>
              <section><h4>小时</h4><div className="period-option-grid is-hours">{[60,120,180,240].map((minutes) => <button key={minutes} type="button" className={!allDayView && range === "DAY" && intradayMinutes === minutes ? "is-selected" : ""} onClick={() => { setAllDayView(false); setIntradayMinutes(minutes); setRange("DAY"); setPeriodOpen(false); }}>{minutes / 60}小时</button>)}</div></section>
              <section><h4>长周期</h4><div className="period-option-grid is-long">
                <button type="button" className={range === "QUARTER" ? "is-selected" : ""} onClick={() => { setAllDayView(false); setRange("QUARTER"); setSession("ALL"); setPeriodOpen(false); }}>季K</button>
                <button type="button" className={range === "YEAR" ? "is-selected" : ""} onClick={() => { setAllDayView(false); setRange("YEAR"); setSession("ALL"); setPeriodOpen(false); }}>年K</button>
                <button type="button" className={range === "YTD" ? "is-selected" : ""} onClick={() => { setAllDayView(false); setRange("YTD"); setSession("ALL"); setPeriodOpen(false); }}>今年以来</button>
              </div></section>
            </div>}
        </div>
      </div>
      <div className="stock-chart-action-group">
      <div className="stock-chart-popover-wrap">
        <button type="button" className={`stock-chart-adjust-trigger ${compareItems.length > 0 ? "has-compare" : ""}`} aria-label="涨跌幅比较" aria-expanded={compareOpen} onClick={() => { setCompareOpen((o) => !o); setChartSettingsOpen(false); setStyleOpen(false); setSessionOpen(false); setPeriodOpen(false); }}>
          <svg viewBox="0 0 24 24" fill="currentColor" className="stock-chart-compare-trigger-icon" aria-hidden="true"><path d="M2,19.99l7.5-7.51l4,4l7.09-7.97L22,9.92l-8.5,9.56l-4-4l-6,6.01L2,19.99z M3.5,15.49l6-6.01l4,4L22,3.92l-1.41-1.41 l-7.09,7.97l-4-4L2,13.99L3.5,15.49z" /></svg>
          比较{compareItems.length > 0 ? ` · ${compareItems.length}` : ""}
          <Chevron open={compareOpen} />
        </button>
        {compareOpen && (
          <div className="stock-chart-menu chart-compare-menu" role="menu" aria-label="涨跌幅比较">
            <div className="chart-compare-menu-head"><b>涨跌幅比较</b>{compareItems.length > 0 && <span>{compareItems.length} 只</span>}</div>
            <div className="chart-compare-search">
              <input value={compareSearch} onChange={(event) => setCompareSearch(event.target.value)} placeholder="搜索股票代码..." className="chart-compare-search-input" />
            </div>
            {compareItems.length > 0 && (
              <div className="chart-compare-chips">
                {compareItems.map((item) => (
                  <span key={`${item.market.toUpperCase()}:${item.code.toUpperCase()}`} className="chart-compare-chip">
                    <span className="chart-compare-chip-dot" style={{ backgroundColor: item.color }} />
                    {item.name}
                    <button type="button" aria-label={`移除 ${item.name}`} className="chart-compare-chip-x" onClick={() => removeCompare(item)}>×</button>
                  </span>
                ))}
              </div>
            )}
            <div className="chart-compare-list">
              {compareSearch.trim() ? (
                <>
                  {compareSearchLoading && <div className="chart-compare-empty">搜索中…</div>}
                  {!compareSearchLoading && compareSearchResults.length === 0 && <div className="chart-compare-empty">无匹配结果</div>}
                  {compareSearchResults.map((result) => {
                    const symbolKey = `${result.market.toUpperCase()}:${result.code.toUpperCase()}`;
                    const added = compareItems.some((item) => `${item.market.toUpperCase()}:${item.code.toUpperCase()}` === symbolKey);
                    const isCurrent = result.market.toUpperCase() === market.toUpperCase() && result.code.toUpperCase() === code.toUpperCase();
                    const q = compareQuotes[symbolKey];
                    const pct = q?.changePct ?? result.changePct;
                    const isUp = (pct ?? 0) >= 0;
                    return (
                      <button key={symbolKey} type="button" disabled={added || isCurrent} className={`chart-compare-item ${(added || isCurrent) ? "is-added" : ""}`} onClick={() => addCompare({ market: result.market, code: result.code, name: result.name })}>
                        <span className="chart-compare-item-name">
                          <b className="flex items-center gap-1.5"><MarketCodeBadge market={result.market} code={result.code} />{result.code}{isCurrent ? " (本股)" : ""}</b>
                          <small>{result.name} · {COMPARE_MARKET_LABEL[result.market.toUpperCase()] || result.market.toUpperCase()}(US)</small>
                        </span>
                        <span className="chart-compare-item-quote">
                          <span className="chart-compare-item-price">{q?.price != null ? (result.market.toUpperCase() === "US" ? "$" : "") + fmtNumMarket(q.price, result.market) : (result.price != null ? result.price.toFixed(2) : "—")}</span>
                          {pct != null && (
                            <span className="chart-compare-item-pct" style={{ color: isUp ? "#e5484d" : "#0aa77d" }}>
                              {`${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`}
                              <svg viewBox="0 0 12 12" fill="currentColor" className="chart-compare-item-arrow" aria-hidden="true">
                                {isUp ? <path d="M6 2.75 L9.72 9.25 L2.28 9.25 Z" /> : <path d="M6 9.25 L2.28 2.75 L9.72 2.75 Z" />}
                              </svg>
                            </span>
                          )}
                        </span>
                      </button>
                    );
                  })}
                </>
              ) : (
                <>
                  <div className="chart-compare-empty">所有股票代码</div>
                  {compareCandidates.map((candidate) => {
                    const symbolKey = `${candidate.market.toUpperCase()}:${candidate.code.toUpperCase()}`;
                    const added = compareItems.some((item) => `${item.market.toUpperCase()}:${item.code.toUpperCase()}` === symbolKey);
                    const q = compareQuotes[symbolKey];
                    const pct = q?.changePct;
                    const isUp = (pct ?? 0) >= 0;
                    return (
                      <button key={symbolKey} type="button" disabled={added} className={`chart-compare-item ${added ? "is-added" : ""}`} onClick={() => addCompare(candidate)}>
                        <span className="chart-compare-item-name">
                          <b className="flex items-center gap-1.5"><MarketCodeBadge market={candidate.market} code={candidate.code} />{candidate.code}</b>
                          <small>{candidate.name} · {COMPARE_MARKET_LABEL[candidate.market.toUpperCase()] || candidate.market.toUpperCase()}(US)</small>
                        </span>
                        <span className="chart-compare-item-quote">
                          <span className="chart-compare-item-price">
                            {q?.price != null ? (candidate.market.toUpperCase() === "US" ? "$" : "") + fmtNumMarket(q.price, candidate.market) : "—"}
                          </span>
                          {pct != null && (
                            <span className="chart-compare-item-pct" style={{ color: isUp ? "#e5484d" : "#0aa77d" }}>
                              {`${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`}
                              <svg viewBox="0 0 12 12" fill="currentColor" className="chart-compare-item-arrow" aria-hidden="true">
                                {isUp ? <path d="M6 2.75 L9.72 9.25 L2.28 9.25 Z" /> : <path d="M6 9.25 L2.28 2.75 L9.72 2.75 Z" />}
                              </svg>
                            </span>
                          )}
                        </span>
                      </button>
                    );
                  })}
                </>
              )}
            </div>
          </div>
        )}
      </div>
      <div className="stock-chart-popover-wrap">
        <button ref={styleTriggerRef} type="button" className="stock-chart-style-trigger" onClick={toggleStyleMenu} aria-label={style === "area" ? "山型图" : "折线图"} aria-expanded={styleOpen}>
          <StyleIcon style={style} /><Chevron open={styleOpen} />
        </button>
        {styleOpen && styleMenuPosition && <div className="stock-chart-menu style-menu is-draggable" role="menu" aria-label="可拖动的图表类型菜单" style={{ left: styleMenuPosition.x, top: styleMenuPosition.y }} onPointerDown={beginStyleDrag} onPointerMove={moveStyleMenu} onPointerUp={endStyleDrag} onPointerCancel={endStyleDrag}>
          {basicStyleOrder.map(renderBasicStyle)}
          {ALL_STYLES.some((item) => !basicStyleOrder.includes(item)) && <>
            <div className="chart-style-divider" />
            {ALL_STYLES.filter((item) => !basicStyleOrder.includes(item)).map((item) => {
              const labels: Record<ChartStyle, string> = { area: "面积图", line: "折线图", marked: "带标记线", step: "阶梯线", hlc: "HLC 区域", baseline: "基准线", candle: "实心 K 线", hollow: "空心 K 线", ohlc: "OHLC" };
              const icon = item === "area" ? <LineIcon area /> : item === "line" ? <LineIcon /> : item === "marked" ? <MarkedLineIcon /> : item === "step" ? <span className="chart-type-glyph step">⌜</span> : item === "hlc" ? <span className="chart-type-glyph hlc">≋</span> : item === "baseline" ? <BaselineIcon /> : <CandleIcon hollow={item === "hollow"} ohlc={item === "ohlc"} />;
              return <button key={item} type="button" className="style-add-option" onClick={() => addStyleToFavorites(item)} title="点击加入上方常用区">{icon}<span>{labels[item]}</span><span className="style-add-mark" aria-hidden="true">＋</span></button>;
            })}
          </>}
        </div>}
      </div>
      <div className="stock-chart-popover-wrap">
        <button type="button" className="stock-chart-adjust-trigger" aria-label="指标与复权" aria-expanded={chartSettingsOpen} onClick={() => { setChartSettingsOpen((open) => !open); setCompareOpen(false); setStyleOpen(false); setSessionOpen(false); setPeriodOpen(false); }}><MonitoringIcon />指标<Chevron open={chartSettingsOpen} /></button>
        {chartSettingsOpen && <div className="stock-chart-menu chart-settings-menu" role="menu" aria-label="指标与复权">
          <div className="chart-settings-title"><b>指标与复权</b></div>
          <section className="chart-settings-adjust-section">
            <h4>复权方式</h4>
            <div className="chart-settings-segmented">
              {([["qfq", "前复权"], ["none", "不复权"], ["hfq", "后复权"]] as const).map(([value, label]) => <button key={value} type="button" className={adjust === value ? "is-selected" : ""} onClick={() => setAdjust(value)}>{label}</button>)}
            </div>
          </section>
          <section className="chart-settings-ma-section">
            <h4>均线设置</h4>
            <button type="button" className="chart-settings-detail" onClick={() => { setChartSettingsOpen(false); setMaSettingsOpen(true); }}>
              <span><b>MA</b><small>周期与颜色</small></span><GearIcon />
            </button>
          </section>
          <div className="chart-settings-options"><label><span>显示 MA 均线</span><input type="checkbox" checked={maLinesVisible} onChange={(event) => setMaLinesVisible(event.target.checked)} /></label><label><span>显示 MA 数值</span><input type="checkbox" checked={showMAValues} onChange={(event) => setShowMAValues(event.target.checked)} /></label></div>
        </div>}
      </div>
      </div>
    </div>
    {compareItems.length > 0 && (
      <div className="stock-chart-compare-legend">
        {[{ market, code, name: name || code, color: "#0bb4b4" }, ...compareItems].filter((item, index, arr) => {
          const key = `${item.market.toUpperCase()}:${item.code.toUpperCase()}`;
          return arr.findIndex((other) => `${other.market.toUpperCase()}:${other.code.toUpperCase()}` === key) === index;
        }).map((item) => {
          const key = `${item.market.toUpperCase()}:${item.code.toUpperCase()}`;
          const isMain = item.market.toUpperCase() === market.toUpperCase() && item.code.toUpperCase() === code.toUpperCase();
          return (
            <span key={key} className="stock-chart-compare-legend-chip">
              <span className="chart-compare-chip-dot" style={{ backgroundColor: item.color }} />
              {item.name}
              {!isMain && <button type="button" aria-label={`移除 ${item.name}`} className="chart-compare-chip-x" onClick={() => removeCompare(item as CompareItem)}>×</button>}
            </span>
          );
        })}
      </div>
    )}
    <div className="stock-chart-canvas relative" style={{ height }}>
      <div ref={chartRef} className="h-full w-full" />
      {selectedIndicators.includes("MA") && showMAValues && <div className="ma-chart-legend" style={{ transform: `translate3d(${maLegendPosition.x}px,${maLegendPosition.y}px,0)` }} onPointerDown={startMADrag} onPointerMove={moveMADrag} onPointerUp={endMADrag} onPointerCancel={endMADrag}>
        <div className="ma-chart-legend-main"><b>MA</b>{maLegend.map((item) => <span key={item.period} style={{ color: item.color }}>MA{item.period}:{item.latest == null ? "--" : item.latest.toFixed(3)}</span>)}</div>
      </div>}
      {(loading || (!loading && error) || noSessionData) && (
        <GoogleEmptyState
          text={
            loading ? "加载走势…"
            : !loading && error ? error
            : noSessionData ? `当前行情源暂无${sessionLabel}数据`
            : "暂无走势数据"
          }
        />
      )}
    </div>
    {compareItems.length > 0 && (
      <div className="stock-chart-compare">
        <div className="stock-chart-compare-table">
          <div className="stock-chart-compare-row is-head">
            <span>股票代码</span><span className="is-right">价格</span><span className="is-right">涨跌额</span><span className="is-right">涨跌幅</span><span className="is-right">昨收盘</span>
          </div>
          {[{ market, code, name: name || code, color: "#0bb4b4" }, ...compareItems].filter((item, index, arr) => {
            const key = `${item.market.toUpperCase()}:${item.code.toUpperCase()}`;
            return arr.findIndex((other) => `${other.market.toUpperCase()}:${other.code.toUpperCase()}` === key) === index;
          }).map((item) => {
            const symbolKey = `${item.market.toUpperCase()}:${item.code.toUpperCase()}`;
            const isCurrent = item.market.toUpperCase() === market.toUpperCase() && item.code.toUpperCase() === code.toUpperCase();
            const idx = hoverIndex;
            // 从主图/比较标的的绝对价格序列取该时点的价格，相对区间首个有效价计算涨跌额/涨跌幅。
            let price: number | null = null;
            let base: number | null = null;
            let prev: number | null = null;
            if (isCurrent) {
              price = idx != null ? data.values[idx] ?? null : null;
              base = data.values.find((v) => v != null) ?? null;
              prev = idx != null ? data.previous[idx] ?? null : null;
            } else {
              const cs = compareSeries.find((c) => c.key === symbolKey);
              price = cs && idx != null ? cs.prices[idx] ?? null : null;
              base = cs ? cs.prices.find((v) => v != null) ?? null : null;
              prev = cs && idx != null ? (cs.prices[idx - 1] ?? null) : null;
            }
            const chg = price != null && base != null ? price - base : 0;
            const pct = price != null && base ? chg / base * 100 : 0;
            const isUp = chg >= 0;
            const itMarket = item.market.toUpperCase();
            return (
              <div key={symbolKey} className="stock-chart-compare-row">
                <span className="stock-chart-compare-stock">
                  <i className="stock-chart-compare-dot" style={{ backgroundColor: item.color }} />
                  <span className="stock-chart-compare-name"><span className="flex items-center gap-1.5"><MarketCodeBadge market={item.market} code={item.code} />{item.code.toUpperCase()}</span><small>{item.name}</small></span>
                </span>
                <span className="is-right">{price != null ? (itMarket === "US" ? "$" : "") + fmtNumMarket(price, item.market) : "—"}</span>
                <span className="is-right stock-chart-compare-chg" style={{ color: isUp ? "#e5484d" : "#0aa77d" }}>{chg >= 0 ? "+" : ""}{(chg ?? 0).toFixed(2)}<svg viewBox="0 0 12 12" fill="currentColor" className="stock-chart-compare-arrow" aria-hidden="true">{isUp ? <path d="M6 2.75 L9.72 9.25 L2.28 9.25 Z" /> : <path d="M6 9.25 L2.28 2.75 L9.72 2.75 Z" />}</svg></span>
                <span className="is-right stock-chart-compare-chg" style={{ color: isUp ? "#e5484d" : "#0aa77d" }}>{`${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`}<svg viewBox="0 0 12 12" fill="currentColor" className="stock-chart-compare-arrow" aria-hidden="true">{isUp ? <path d="M6 2.75 L9.72 9.25 L2.28 9.25 Z" /> : <path d="M6 9.25 L2.28 2.75 L9.72 2.75 Z" />}</svg></span>
                <span className="is-right">{prev != null ? (itMarket === "US" ? "$" : "") + fmtNumMarket(prev, item.market) : "—"}</span>
              </div>
            );
          })}
        </div>
      </div>
    )}
    <div className="stock-chart-indicators" aria-label="技术指标">
      <div className="stock-chart-indicator-half stock-chart-indicator-left"><div className="stock-chart-indicator-scroll"><span>技术指标</span>{[["MA", "MA"], ["EMA", "EMA"], ["BOLL", "BOLL"], ["MACD", "MACD"], ["KDJ", "KDJ"], ["RSI", "RSI"]].map(([key, label]) => <button key={key} type="button" className={selectedIndicators.includes(key) ? "is-active" : ""} aria-pressed={selectedIndicators.includes(key)} onClick={() => toggleIndicator(key)}>{label}</button>)}</div></div>
      <div className="stock-chart-indicator-half stock-chart-indicator-right">
        <div className="stock-chart-indicator-scroll">
          <button type="button" className={selectedIndicators.includes("VOL") ? "is-active" : ""} aria-pressed={selectedIndicators.includes("VOL")} onClick={() => toggleIndicator("VOL")}>成交量</button>
          <button type="button" className={selectedIndicators.includes("AMT") ? "is-active" : ""} aria-pressed={selectedIndicators.includes("AMT")} onClick={() => toggleIndicator("AMT")}>成交额</button>
        </div>
      </div>
    </div>
    {maSettingsOpen && <div className="ma-settings-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setMaSettingsOpen(false); }}><section className="ma-settings-dialog" role="dialog" aria-modal="true" aria-label="MA 设置"><header><button type="button" aria-label="关闭" onClick={() => setMaSettingsOpen(false)}>×</button><div><b>MA</b><span title="移动平均线周期设置">ⓘ</span></div><button type="button" className="ma-settings-done" onClick={() => setMaSettingsOpen(false)}>完成</button></header><h3>移动平均周期</h3><div className="ma-settings-list">{maConfigs.map((item, index) => <div className="ma-settings-row" key={index}><label><input type="checkbox" checked={item.enabled} onChange={(event) => updateMA(index, { enabled: event.target.checked })} /><span>MA{index + 1}</span></label><input className="ma-color-input" type="color" value={item.color} aria-label={`MA${index + 1} 颜色`} onChange={(event) => updateMA(index, { color: event.target.value })} /><div className="ma-period-stepper"><button type="button" onClick={() => updateMA(index, { period: Math.max(1, item.period - 1) })}>−</button><RainbowNumberInput allowDecimal={false} grouping={false} min={1} max={1000} value={item.period} onChange={(event) => updateMA(index, { period: Math.max(1, Math.min(1000, Number(event.target.value) || 1)) })} /><button type="button" onClick={() => updateMA(index, { period: Math.min(1000, item.period + 1) })}>＋</button></div></div>)}</div></section></div>}
    {styleNotice && <div className="stock-chart-toast" role="status"><span>✓</span>{styleNotice}</div>}
  </div>;
}
