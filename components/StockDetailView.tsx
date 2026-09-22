"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { FALLBACK_RATES, marketMeta } from "@/lib/types";
import { fmtCap, fmtNum, fmtNumMarket, fmtPct, fmtPrice } from "@/lib/format";
import { marketSessionState } from "@/lib/marketSessions";
import type { Quote } from "@/lib/quotes";
import MarketIcon from "@/components/MarketIcon";
import StockKline from "@/components/StockKline";
import FinancialPanel from "@/components/FinancialPanel";
import CompanyProfilePanel from "@/components/CompanyProfilePanel";
import { ensureStockIcon, useAssetIcons } from "@/lib/useAssetIcons";
import { pickStockIcon } from "@/lib/stockIconKey";
import { MARKET_CURRENCY, MULTI_CURRENCIES, usdCap } from "@/lib/currency";
import { relatedETFs, relatedStock, type RelatedETF, type RelatedStock } from "@/lib/relatedEtfs";
import EtfDoubleBadge from "@/components/EtfDoubleBadge";
import DividendTable, { fmtDividendAmount, yearOfDividend } from "@/components/DividendTable";
import type { DividendRecord } from "@/lib/dividends";
import MarketCodeBadge from "@/components/MarketCodeBadge";
import StockSearch from "@/components/StockSearch";
import AppSelect from "@/components/AppSelect";
import { dividendClientCacheKey, readDividendClientCache, writeDividendClientCache } from "@/lib/dividendClientCache";

interface Props {
  market: string;
  code: string;
  name: string;
  quote?: Quote | null;
  /** 返回回调（传入后在头部行内、股票图标左侧渲染圆形返回按钮） */
  onBack?: () => void;
  /** 是否已关注（在自选股中） */
  followed?: boolean;
  /** 关注 / 取消关注回调，返回是否成功 */
  onToggleFollow?: (follow: boolean, resolvedName?: string) => Promise<boolean>;
  /** 初始页签（来自 URL ?tab=），刷新后保持所在页签 */
  initialTab?: Tab;
  /** 页签切换回调（用于同步 URL，防止刷新回到默认） */
  onTabChange?: (tab: Tab) => void;
}

type Tab = "overview" | "etf" | "dividend" | "financial" | "company";
type ExtendedSession = "PRE" | "REGULAR" | "AFTER";
interface ExtendedPoint { date: string; time: string; price: number; volume: number; session: ExtendedSession }
type UsMarketPhase = "PRE" | "REGULAR" | "AFTER" | "OVERNIGHT" | "WEEKEND";

const UP = "#e5484d";
const DOWN = "#1aa07a";
const NY_TIME_ZONE = "America/New_York";
const RELATED_ETF_QUOTE_CACHE_KEY = "fire:related-etf-quotes:v1";
const CUSTOM_RELATED_ETF_CACHE_KEY = "fire:custom-related-etfs:v1";
const STOCK_DETAIL_CACHE_PREFIX = "fire-web:stock-detail:v2";

type CustomRelatedETF = RelatedETF & { stockName?: string };

function readRelatedEtfQuoteCache() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RELATED_ETF_QUOTE_CACHE_KEY) || "null") as Record<string, Quote> | null;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function customRelatedEtfKey(market: string, code: string) {
  return `${market.trim().toUpperCase()}:${code.trim().toUpperCase()}`;
}

function readCustomRelatedEtfs(market: string, code: string): CustomRelatedETF[] {
  try {
    const all = JSON.parse(localStorage.getItem(CUSTOM_RELATED_ETF_CACHE_KEY) || "{}") as Record<string, CustomRelatedETF[]>;
    const rows = all[customRelatedEtfKey(market, code)];
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function readCustomRelatedStock(market: string, code: string): RelatedStock | null {
  try {
    const normalizedMarket = market.trim().toUpperCase();
    const normalizedCode = code.trim().toUpperCase();
    const all = JSON.parse(localStorage.getItem(CUSTOM_RELATED_ETF_CACHE_KEY) || "{}") as Record<string, CustomRelatedETF[]>;
    for (const [key, rows] of Object.entries(all)) {
      const separator = key.indexOf(":");
      if (separator < 0 || key.slice(0, separator) !== normalizedMarket || !Array.isArray(rows)) continue;
      const match = rows.find((item) => item.code.trim().toUpperCase() === normalizedCode);
      if (match) {
        const stockCode = key.slice(separator + 1);
        return { code: stockCode, name: match.stockName?.trim() || stockCode, kind: "long", badge: "正股" };
      }
    }
  } catch { /* 忽略损坏的本地关系 */ }
  return null;
}

function writeCustomRelatedEtfs(market: string, code: string, rows: CustomRelatedETF[]) {
  try {
    const all = JSON.parse(localStorage.getItem(CUSTOM_RELATED_ETF_CACHE_KEY) || "{}") as Record<string, CustomRelatedETF[]>;
    all[customRelatedEtfKey(market, code)] = rows;
    localStorage.setItem(CUSTOM_RELATED_ETF_CACHE_KEY, JSON.stringify(all));
  } catch { /* 本地存储不可用时只保留当前会话 */ }
}

function nyMarketClock(at = Date.now()) {
  const parts: Record<string, string> = {};
  new Intl.DateTimeFormat("en-US", {
    timeZone: NY_TIME_ZONE,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(new Date(at)).forEach((part) => { parts[part.type] = part.value; });
  const minute = (Number(parts.hour) % 24) * 60 + Number(parts.minute);
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  return { minute, weekday };
}

function usMarketPhase(at = Date.now()): UsMarketPhase {
  const { minute, weekday } = nyMarketClock(at);
  if (weekday === 0 || weekday === 6) return "WEEKEND";
  if (minute >= 240 && minute < 570) return "PRE";
  if (minute >= 570 && minute <= 960) return "REGULAR";
  if (minute > 960 && minute < 1200) return "AFTER";
  // 美东 20:00-04:00 夜盘（24 小时行情）
  return "OVERNIGHT";
}

function phaseRetryDelay(phase: UsMarketPhase) {
  if (phase === "REGULAR") return 10_000;
  if (phase === "PRE" || phase === "AFTER" || phase === "OVERNIGHT") return 30_000;
  // 休市期间不请求行情；定时器直接对齐下一个工作日 04:00（美东），并用 6 小时上限规避夏令时切换误差。
  const { minute, weekday } = nyMarketClock();
  let days = 0;
  if (weekday === 6) days = 2;
  else if (weekday === 0) days = 1;
  else if (minute >= 1200) days = weekday === 5 ? 3 : 1;
  const minutesUntilPre = days * 1440 + 240 - minute;
  return Math.max(30_000, Math.min(6 * 60 * 60_000, minutesUntilPre * 60_000 + 2_000));
}

function compactMarketTime(raw: string, includeSeconds = true) {
  const match = raw?.match(/^(?:\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/)
    || raw?.match(/^\d{4}(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!match) return raw || "—";
  const seconds = includeSeconds ? `:${match[5] || "00"}` : "";
  return `${Number(match[1])}月${Number(match[2])}日 ${match[3]}:${match[4]}${seconds}`;
}

/** 市场当前相对 UTC 的偏移，如 US 夏季「UTC-4」、港股/A股「UTC+8」（用于状态行） */
function marketUtcOffset(market: string): string {
  const tz = market.toUpperCase() === "US" ? "America/New_York" : "Asia/Shanghai";
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" }).formatToParts(new Date());
    const raw = parts.find((p) => p.type === "timeZoneName")?.value || "";
    const m = raw.match(/GMT([+-])(\d{2}):(\d{2})/);
    if (!m) return "UTC";
    const h = Number(m[2]);
    if (m[1] === "-" && h === 0) return "UTC";
    return `UTC${m[1]}${h}`;
  } catch {
    return "UTC";
  }
}

/** 市场当地时区中文名（状态行结尾），如 美东 / 香港时间 / 北京时间 */
function marketTzName(market: string): string {
  switch (market.toUpperCase()) {
    case "US": return "美东";
    case "HK": return "香港时间";
    case "CN": return "北京时间";
    case "JP": return "东京时间";
    case "KR": return "首尔时间";
    case "SG": return "新加坡时间";
    default: return "当地时间";
  }
}

function stockDisplayName(code: string, ...candidates: (string | undefined)[]) {
  const key = (value: string) => value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  const codeKey = key(code);
  // 自选股名称 → 素材库名称 → 行情名称依次兜底，过滤只重复证券代码的伪名称。
  const names = candidates.map((value) => value?.trim() || "").filter(Boolean);
  return names.find((value) => key(value) !== codeKey) || names[0] || code;
}

function dividendStatus(item: DividendRecord) {
  const raw = item.process?.trim() || "";
  if (/完成|已派|实施/.test(raw)) return { label: raw, tone: "booked" as const };
  if (item.payDate) {
    const pending = new Date(`${item.payDate}T23:59:59`).getTime() >= Date.now();
    return pending ? { label: "待派发", tone: "pending" as const } : { label: "已派发", tone: "booked" as const };
  }
  return { label: raw || "已披露", tone: "info" as const };
}

export default function StockDetailView({ market, code, name, quote: propQuote, onBack, followed = false, onToggleFollow, initialTab = "overview", onTabChange }: Props) {
  const { assets, stockIcons } = useAssetIcons(["stock"]);
  const stockIconUrl = pickStockIcon(stockIcons, market, code);
  useEffect(() => {
    void ensureStockIcon(market, code);
  }, [market, code]);
  const [detailData, setDetailData] = useState<{
    quote: Quote | null;
    rates: Record<string, number>;
    marketCap: Record<string, number> | null;
    kline: { d: string; o: number; h: number; l: number; c: number; v: number }[];
  } | null>(null);
  const [faved, setFaved] = useState(false);
  const [following, setFollowing] = useState(false);
  const [showCur, setShowCur] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [showMetrics, setShowMetrics] = useState(false);
  const [tab, setTab] = useState<Tab>(initialTab);
  const [tabReady, setTabReady] = useState(false);
  const [extendedPrices, setExtendedPrices] = useState<{ pre: ExtendedPoint | null; after: ExtendedPoint | null; regular: ExtendedPoint | null }>({ pre: null, after: null, regular: null });
  const [marketClock, setMarketClock] = useState(() => Date.now());
  const quotePollingRef = useRef(false);
  const [selectedRelatedETF, setSelectedRelatedETF] = useState<RelatedETF | null>(null);
  const [etfQuotes, setEtfQuotes] = useState<Record<string, Quote | null>>({});
  const [etfLoading, setEtfLoading] = useState(false);
  const [etfFilter, setEtfFilter] = useState<"all" | "long" | "short" | "income">("all");
  const [customRelatedEtfs, setCustomRelatedEtfs] = useState<CustomRelatedETF[]>([]);
  const [customMainStock, setCustomMainStock] = useState<RelatedStock | null>(null);
  const [relatedEditorOpen, setRelatedEditorOpen] = useState(false);
  const [relatedDraft, setRelatedDraft] = useState({ code: "", name: "", kind: "long" as RelatedETF["kind"] });
  const [dividends, setDividends] = useState<DividendRecord[]>([]);
  const [dividendsOk, setDividendsOk] = useState(true);
  const [dividendsLoading, setDividendsLoading] = useState(false);
  const [dividendYear, setDividendYear] = useState<string | null>(null);
  const dividendCacheKey = dividendClientCacheKey(market, code);
  const mainStock = relatedStock(market, code) ?? customMainStock;

  // 股息是低频数据，绘制前先恢复最后一次成功快照，避免切入页签时闪现获取状态。
  useLayoutEffect(() => {
    const cached = readDividendClientCache(dividendClientCacheKey(market, code));
    setDividends(cached?.dividends ?? []);
    setDividendsOk(cached?.sourceOk ?? true);
    setDividendsLoading(!cached);
  }, [market, code]);

  useLayoutEffect(() => {
    setCustomRelatedEtfs(readCustomRelatedEtfs(market, code));
    setCustomMainStock(readCustomRelatedStock(market, code));
    setRelatedEditorOpen(false);
    setRelatedDraft({ code: "", name: "", kind: "long" });
  }, [market, code]);

  // URL 直达时在浏览器绘制前恢复页签，避免先闪现概览再切到目标页签。
  useLayoutEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("tab") as Tab | null;
    setTab(requested && ["overview", "etf", "dividend", "financial", "company"].includes(requested) ? requested : "overview");
    setTabReady(true);
  }, [market, code]);

  // 概览始终先展示最后一次成功快照；快照不因过期清空，最新数据在后台静默替换。
  useLayoutEffect(() => {
    const cacheKey = `${STOCK_DETAIL_CACHE_PREFIX}:${market.toUpperCase()}:${code.toUpperCase()}`;
    try {
      const cached = JSON.parse(localStorage.getItem(cacheKey) || "null");
      if (cached?.data) setDetailData(cached.data);
    } catch {
      /* 缓存损坏时等待后台行情 */
    }
  }, [market, code]);

  // 切换股票时重置关注状态（不随 followed 属性变化回写，避免打断乐观更新）
  useEffect(() => {
    setFaved(!!followed);
    setShowMore(false);
    setShowMetrics(false);
    setSelectedRelatedETF(null);
    setEtfFilter("all");
    setDividendYear(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [market, code]);

  // 首次绘制 ETF 页签前恢复最后一次成功行情；挂载后仍立即在后台请求最新值。
  useLayoutEffect(() => {
    if (tab !== "etf") return;
    const mainStock = relatedStock(market, code);
    const definitions = mainStock ? [mainStock] : [...relatedETFs(market, code), ...customRelatedEtfs];
    const cache = readRelatedEtfQuoteCache();
    const restored: Record<string, Quote | null> = {};
    definitions.forEach((item) => {
      restored[item.code] = cache[`${market.toUpperCase()}:${item.code}`] ?? null;
    });
    setEtfQuotes(restored);
  }, [tab, market, code, customRelatedEtfs]);

  // 正股展示相关 ETF；ETF 反向展示正股。两者共用同一份关系映射。
  useEffect(() => {
    if (tab !== "etf") return;
    const mainStock = relatedStock(market, code);
    const definitions = mainStock ? [mainStock] : [...relatedETFs(market, code), ...customRelatedEtfs];
    if (definitions.length === 0) {
      setEtfQuotes({});
      setEtfLoading(false);
      return;
    }
    const controller = new AbortController();
    setEtfLoading(true);
    const items = definitions.map((item) => ({ id: `${market.toUpperCase()}:${item.code}`, market, code: item.code }));
    fetch("/api/v1/quotes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
      cache: "no-store",
      signal: controller.signal
    })
      .then((response) => response.json().catch(() => null))
      .then((payload) => {
        if (controller.signal.aborted) return;
        const incoming = payload?.data?.quotes ?? {};
        setEtfQuotes((current) => {
          const next: Record<string, Quote | null> = {};
          definitions.forEach((item) => {
            next[item.code] = incoming[`${market.toUpperCase()}:${item.code}`] ?? current[item.code] ?? null;
          });
          return next;
        });
        try {
          const cache = readRelatedEtfQuoteCache();
          Object.entries(incoming as Record<string, Quote>).forEach(([key, quote]) => {
            if (quote && Number.isFinite(Number(quote.price))) cache[key] = quote;
          });
          localStorage.setItem(RELATED_ETF_QUOTE_CACHE_KEY, JSON.stringify(cache));
        } catch {
          /* 缓存写入失败不影响当前行情 */
        }
      })
      .catch((error) => {
        if ((error as Error)?.name === "AbortError") return;
        // 更新失败保留最后一次成功快照。
      })
      .finally(() => {
        if (!controller.signal.aborted) setEtfLoading(false);
      });
    return () => controller.abort();
  }, [tab, market, code, customRelatedEtfs]);

  // 股息记录：富途公司行动-分红派息（带缓存），切到「股息」页签时拉取
  useEffect(() => {
    if (tab !== "dividend") return;
    const controller = new AbortController();
    const cached = readDividendClientCache(dividendCacheKey);
    if (cached) {
      setDividends(cached.dividends);
      setDividendsOk(true);
    } else {
      setDividendsLoading(true);
    }
    fetch(`/api/v1/dividends?market=${encodeURIComponent(market)}&code=${encodeURIComponent(code)}`, {
      cache: "no-store",
      signal: controller.signal
    })
      .then((response) => response.json().catch(() => null))
      .then((payload) => {
        if (controller.signal.aborted) return;
        const next = Array.isArray(payload?.data?.dividends) ? payload.data.dividends : [];
        const sourceOk = Boolean(payload?.data?.source && payload.data.source !== "unavailable");
        if (sourceOk) {
          setDividends(next);
          setDividendsOk(true);
          writeDividendClientCache(dividendCacheKey, { dividends: next, sourceOk: true });
        } else if (!cached) {
          setDividendsOk(false);
        }
      })
      .catch((error) => {
        if ((error as Error)?.name !== "AbortError") {
          if (!cached) setDividendsOk(false);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setDividendsLoading(false);
      });
    return () => controller.abort();
  }, [tab, market, code, dividendCacheKey]);

  // 美股扩展时段价格独立刷新：不阻塞主行情，盘前 / 盘后按一分钟行情的最新有效点展示。
  useEffect(() => {
    setExtendedPrices({ pre: null, after: null, regular: null });
    if (market.toUpperCase() !== "US") return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;
    const schedule = () => {
      if (stopped) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(refreshExtendedPrices, phaseRetryDelay(usMarketPhase()));
    };
    const refreshExtendedPrices = async () => {
      const phase = usMarketPhase();
      setMarketClock(Date.now());
      // 常规盘外（盘前/盘后/夜盘/休市）都拉一次当日分钟点，用于渲染「盘后交易」扩展块；
      // 盘中实时价格由主行情轮询提供，此处无需扩展点。
      if (stopped || document.visibilityState !== "visible" || !navigator.onLine || phase === "REGULAR") { schedule(); return; }
      controller?.abort();
      controller = new AbortController();
      try {
        const response = await fetch(`/api/kline/session-day?market=US&code=${encodeURIComponent(code)}`, { cache: "no-store", signal: controller.signal });
        const payload = response.ok ? await response.json().catch(() => null) : null;
        const points = Array.isArray(payload?.points) ? payload.points as ExtendedPoint[] : [];
        const latest = (session: ExtendedSession) => [...points].reverse().find((point) => point.session === session) || null;
        if (!stopped && points.length) setExtendedPrices({ pre: latest("PRE"), after: latest("AFTER"), regular: latest("REGULAR") });
      } catch (error) {
        if ((error as Error)?.name !== "AbortError") console.debug("扩展时段行情刷新失败，将自动重试");
      } finally {
        schedule();
      }
    };
    const resume = () => { if (document.visibilityState === "visible") void refreshExtendedPrices(); };
    void refreshExtendedPrices();
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", resume);
    window.addEventListener("online", resume);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("focus", resume);
      window.removeEventListener("online", resume);
    };
  }, [market, code]);

  // 个股页可见时自动刷新实时行情；后台标签页暂停，重新聚焦后立即补一次。
  // 使用轻量 quotes 接口，避免重复请求汇率、财务和 K 线数据。
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;
    const id = `${market.toUpperCase()}.${code.toUpperCase()}`;
    const schedule = () => {
      if (stopped) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(refreshQuote, market.toUpperCase() === "US" ? phaseRetryDelay(usMarketPhase()) : 10_000);
    };
    const refreshQuote = async () => {
      const phase = market.toUpperCase() === "US" ? usMarketPhase() : "REGULAR";
      setMarketClock(Date.now());
      if (stopped || quotePollingRef.current || document.visibilityState !== "visible" || !navigator.onLine || (phase !== "REGULAR" && phase !== "OVERNIGHT")) { schedule(); return; }
      quotePollingRef.current = true;
      controller = new AbortController();
      try {
        const response = await fetch("/api/v1/quotes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items: [{ id, market, code }] }),
          cache: "no-store",
          signal: controller.signal
        });
        const payload = await response.json().catch(() => null);
        const fresh = payload?.data?.quotes?.[id] as Quote | undefined;
        if (!stopped && fresh?.price) {
          setDetailData((current) => current ? { ...current, quote: { ...(current.quote || {}), ...fresh } as Quote } : {
            quote: fresh, rates: {}, marketCap: null, kline: []
          });
        }
      } catch (error) {
        if ((error as Error)?.name !== "AbortError") console.debug("实时行情刷新失败，将自动重试");
      } finally {
        quotePollingRef.current = false;
        schedule();
      }
    };
    const resume = () => { if (document.visibilityState === "visible") void refreshQuote(); };
    timer = setTimeout(refreshQuote, 3_000);
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", resume);
    window.addEventListener("online", resume);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      controller?.abort();
      quotePollingRef.current = false;
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("focus", resume);
      window.removeEventListener("online", resume);
    };
  }, [market, code]);

  async function toggleFollow() {
    if (following) return;
    const next = !faved;
    setFaved(next);
    setFollowing(true);
    try {
      if (onToggleFollow) {
        const ok = await onToggleFollow(next, displayName);
        if (ok === false) setFaved(!next);
      }
    } finally {
      setFollowing(false);
    }
  }

  // 详情页统一走 v1 个股详情契约（实时行情 + 六币种市值 + 汇率，iOS 同款接口）
  useEffect(() => {
    let cancelled = false;
    const cacheKey = `${STOCK_DETAIL_CACHE_PREFIX}:${market.toUpperCase()}:${code.toUpperCase()}`;
    // K 线由 StockKline 按周期加载；摘要请求不再重复等待大体积日线。
    // 公司资料仅在用户点击「公司」时加载，避免刷新首屏回源 SEC。
    fetch(`/api/v1/stock-detail?market=${encodeURIComponent(market)}&code=${encodeURIComponent(code)}&includeKline=0`)
      .then((r) => r.json().catch(() => null))
      .then((d) => {
        if (!cancelled && d?.data) {
          setDetailData((current) => {
            const next = { ...current, ...d.data, quote: d.data.quote ?? current?.quote ?? null };
            try { localStorage.setItem(cacheKey, JSON.stringify({ at: Date.now(), data: next })); } catch {}
            return next;
          });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [market, code]);

  const quote = detailData?.quote ?? propQuote ?? null;
  // 直接通过 URL 打开全市场股票时，父级可能只有代码；行情返回后使用正式名称。
  const stockAsset = assets.find((asset) => asset.type === "stock" && asset.market.toUpperCase() === market.toUpperCase() && asset.code.toUpperCase() === code.toUpperCase());
  const displayName = stockDisplayName(code, name, stockAsset?.name, quote?.name);
  const rates = detailData?.rates ?? {};
  const r = { ...FALLBACK_RATES, ...rates };

  const meta = marketMeta(market);
  const assetCap = stockAsset?.marketCap;
  const marketCap = quote?.marketCap ?? assetCap ?? 0;
  const localCur = MARKET_CURRENCY[market] || "USD";
  const prevClose = quote ? quote.prevClose ?? quote.price - quote.change : 0;
  const currentPhase: UsMarketPhase =
    market.toUpperCase() === "US"
      ? usMarketPhase(marketClock)
      : (() => {
          // 港股/A股/日韩等按各自时区判时段：休市/午休不再误显示为「盘中」
          const s = marketSessionState(market.toUpperCase(), new Date()).session;
          return s === "pre" ? "PRE" : s === "regular" ? "REGULAR" : s === "post" ? "AFTER" : s === "overnight" ? "OVERNIGHT" : "WEEKEND";
        })();
  // 扩展块在常规盘外只要有最近一次扩展成交就展示：PREMARKET→盘前，AFTER→盘后；
  // 夜盘 / 休市（美东 20 点后）延续显示最近一次盘后交易（与 Google Finance 一致）。
  const activeExtendedPoint =
    currentPhase === "PRE" ? extendedPrices.pre
    : currentPhase === "AFTER" || currentPhase === "OVERNIGHT" || currentPhase === "WEEKEND" ? extendedPrices.after
    : null;
  // 主「今天」块的基准：扩展时段用当日常规收盘（否则会把扩展价当作今日价），平时用最新实时价。
  const regularClosePoint = activeExtendedPoint ? extendedPrices.regular ?? null : null;
  const todayPrice = regularClosePoint?.price ?? quote?.price ?? null;
  const todayChange = todayPrice != null && prevClose ? todayPrice - prevClose : quote?.change ?? 0;
  const todayChangePct = todayPrice != null && prevClose ? todayChange / prevClose * 100 : quote?.changePct ?? 0;
  const activeUp = todayChange >= 0;
  const activeColor = activeUp ? UP : DOWN;
  // 扩展时段（盘前/盘后）独立价格与涨跌（相对今日常规收盘，与 Google Finance 一致）。
  const extPrice = activeExtendedPoint?.price ?? null;
  const extChange = extPrice != null && todayPrice != null ? extPrice - todayPrice : 0;
  const extChangePct = extPrice != null && todayPrice != null ? extChange / todayPrice * 100 : 0;
  const extUp = extChange >= 0;
  const extColor = extUp ? UP : DOWN;
  const extSessionLabel = currentPhase === "PRE" ? "盘前" : "盘后";
  // 主状态行反映常规盘状态：盘中→盘中；常规盘外（收盘未开/已收/夜盘/休市）→休市，与 Google Finance 一致。
  const todayStatus = currentPhase === "REGULAR" ? "盘中" : "休市";
  const activeTime = regularClosePoint
    ? compactMarketTime(`${regularClosePoint.date} ${regularClosePoint.time}:00`)
    : compactMarketTime(quote?.time || "");
  // 状态行：「休市： 8月21日, UTC-4 16:00 (美东)」——日期后接 UTC 偏移 + 时间(不含秒) + 市场时区名。
  const todayStatusLine = activeTime !== "—" && activeTime.includes(" ")
    ? (() => {
        const [datePart, timePart] = activeTime.split(/\s+/);
        const clock = timePart.slice(0, 5);
        return `${todayStatus}： ${datePart}, ${marketUtcOffset(market)} ${clock} (${marketTzName(market)})`;
      })()
    : "暂无实时行情";
  const yearKline = (detailData?.kline || []).slice(-252);
  const yearHigh = yearKline.length ? Math.max(...yearKline.map((item) => item.h)) : null;
  const yearLow = yearKline.length ? Math.min(...yearKline.map((item) => item.l)) : null;
  const totalShares = quote?.totalShares || (marketCap && quote?.price ? marketCap / quote.price : null);
  const floatShares = quote?.floatShares || null;
  const floatMarketCap = floatShares && quote?.price ? floatShares * quote.price : null;
  const epsTtm = quote?.epsTtm || (quote?.pe && quote.pe > 0 ? quote.price / quote.pe : null);
  const bookValuePerShare = quote?.pb && quote.pb > 0 ? quote.price / quote.pb : null;
  const averagePrice = quote?.averagePrice || (quote?.amount && quote?.volume ? quote.amount / quote.volume : null);
  // 优先用 v1 接口预换算的六币种市值（Web / iOS 同源），行情缺失时按汇率现场换算兜底
  const capFor = (cur: string) => {
    const fromApi = detailData?.marketCap?.[cur];
    if (fromApi != null && fromApi > 0) return fromApi;
    const usd = usdCap(market, marketCap, r);
    return cur === localCur ? marketCap : usd * (r[cur] || 0);
  };

  const tabs: { key: Tab; label: string }[] = [
    { key: "overview", label: "概览" },
    { key: "etf", label: mainStock ? "正股" : "ETF" },
    { key: "dividend", label: "股息" },
    { key: "financial", label: "财务" },
    { key: "company", label: "公司" }
  ];

  const related = mainStock ? [mainStock] : [...relatedETFs(market, code), ...customRelatedEtfs]
    .filter((item, index, rows) => rows.findIndex((candidate) => candidate.code.toUpperCase() === item.code.toUpperCase()) === index);
  const addCustomRelatedEtf = () => {
    const nextCode = relatedDraft.code.trim().toUpperCase();
    if (!nextCode) return;
    const nextItem: CustomRelatedETF = {
      code: nextCode,
      name: relatedDraft.name.trim() || nextCode,
      kind: relatedDraft.kind,
      badge: relatedDraft.kind === "income" ? "期权收益" : relatedDraft.kind === "short" ? "做空" : "做多",
      stockName: displayName
    };
    const next = [...customRelatedEtfs.filter((item) => item.code.toUpperCase() !== nextCode), nextItem];
    setCustomRelatedEtfs(next);
    writeCustomRelatedEtfs(market, code, next);
    setRelatedEditorOpen(false);
    setRelatedDraft({ code: "", name: "", kind: "long" });
  };
  const visibleRelated = mainStock || etfFilter === "all" ? related : related.filter((item) => item.kind === etfFilter);
  // 排名规则：做多一组、做空一组、收益策略一组（组内按市值降序，缺市值排组尾）
  const KIND_ORDER: Record<string, number> = { long: 0, short: 1, income: 2 };
  const sortedVisibleRelated = [...visibleRelated].sort((a, b) => {
    const groupDiff = (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9);
    if (groupDiff !== 0) return groupDiff;
    const capA = etfQuotes[a.code]?.marketCap ?? 0;
    const capB = etfQuotes[b.code]?.marketCap ?? 0;
    return capB - capA;
  });
  const etfKindCounts = related.reduce(
    (counts, item) => ({ ...counts, [item.kind]: counts[item.kind] + 1 }),
    { long: 0, short: 0, income: 0 }
  );
  const dividendYears = [...new Set(dividends.map(yearOfDividend))].sort((a, b) => b.localeCompare(a));
  const visibleDividends = [...(dividendYear ? dividends.filter((item) => yearOfDividend(item) === dividendYear) : dividends)]
    .sort((a, b) => (b.exDate || b.payDate || "").localeCompare(a.exDate || a.payDate || ""));
  const cashDividends = visibleDividends.filter((item) => item.kind === "cash" && item.amount != null);
  const dividendCurrencies = [...new Set(cashDividends.map((item) => item.currency).filter(Boolean))];
  const activeYearCashTotal = dividendCurrencies.length <= 1
    ? cashDividends.reduce((sum, item) => sum + (item.amount || 0), 0)
    : null;
  const latestDividend = [...dividends]
    .filter((item) => item.amount != null)
    .sort((a, b) => String(b.exDate || b.pubDate || "").localeCompare(String(a.exDate || a.pubDate || "")))[0];
  const upcomingDividend = [...dividends]
    .filter((item) => item.payDate && new Date(`${item.payDate}T23:59:59`).getTime() >= Date.now())
    .sort((a, b) => String(a.payDate).localeCompare(String(b.payDate)))[0];

  // 点击相关 ETF 后进入同一套个股详情页，返回箭头回到当前股票的 ETF 聚合页。
  if (selectedRelatedETF) {
    return (
      <StockDetailView
        market="US"
        code={selectedRelatedETF.code}
        name={selectedRelatedETF.name}
        quote={etfQuotes[selectedRelatedETF.code]}
        onBack={() => setSelectedRelatedETF(null)}
      />
    );
  }

  const cell = (items: { label: string; value: string; color?: string; dots?: boolean }[], expandable = false) => {
    return (
      <div className="flex overflow-hidden rounded-[10px] border border-edge bg-bg-gray/40 dark:bg-white/[0.04]">
        <div className="min-w-0 flex-1 px-3 py-2">
          {items.map((it, idx) => (
            <div key={it.label} className={idx > 0 ? "mt-2 border-t border-edge/60 pt-2 dark:border-white/[0.08]" : ""}>
              <span className="text-[11px] text-muted">{it.label}</span>
              <div className="mt-0.5 flex min-w-0 items-center gap-1" style={{ color: it.color }}>
                <span className="truncate text-[13px] font-semibold tabular-nums">{it.value}</span>
                {it.dots && <button type="button" onClick={() => setShowCur(true)} className="flex h-5 w-4 flex-none items-center justify-center rounded text-muted transition-colors hover:bg-brand-hover hover:text-ink" aria-label="多币种市值" title="多币种市值"><svg viewBox="0 0 4 16" fill="currentColor" className="h-4 w-1"><circle cx="2" cy="3" r="1"/><circle cx="2" cy="8" r="1"/><circle cx="2" cy="13" r="1"/></svg></button>}
              </div>
            </div>
          ))}
        </div>
        {expandable && (
          <button type="button" onClick={() => setShowMore((value) => !value)} className="group flex w-9 flex-none items-center justify-center border-l border-edge/70 bg-bg-gray/60 text-muted transition-colors hover:bg-brand-hover hover:text-ink dark:border-white/[0.08] dark:bg-white/[0.05]" aria-label={showMore ? "收起更多指标" : "展开更多指标"} title={showMore ? "收起更多指标" : "展开更多指标"} aria-expanded={showMore}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`h-4 w-4 transition-transform duration-200 ${showMore ? "rotate-180" : "group-hover:translate-y-0.5"}`}><path d="m8 10 4 4 4-4" /></svg>
          </button>
        )}
      </div>
    );
  };

  return (
    <div data-testid="stock-detail-view" className="w-full max-w-[720px]">
      {/* ===== 头部 ===== */}
      <div className="stock-detail-heading flex min-w-0 items-center gap-2">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            aria-label="返回行情板"
            title="返回行情板"
            className="stock-detail-back -ml-1 mr-0.5 flex h-9 w-9 flex-none items-center justify-center rounded-full bg-bg-gray text-ink-2 transition-all duration-200 hover:-translate-y-px hover:bg-brand-hover active:scale-[.97] dark:text-white"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
              <path d="m15 18-6-6 6-6" />
            </svg>
          </button>
        )}
        <span className="relative flex-none">
          {(stockIconUrl || (mainStock && pickStockIcon(stockIcons, market, mainStock.code))) ? (
            <img src={stockIconUrl || pickStockIcon(stockIcons, market, mainStock!.code)} alt="" className="stock-detail-logo h-9 w-9 rounded-full object-cover" />
          ) : (
            <span className="stock-detail-logo flex h-9 w-9 items-center justify-center rounded-full bg-bg-gray text-xs font-bold text-muted">{(name || "?").slice(0, 1)}</span>
          )}
          <EtfDoubleBadge market={market} code={code} name={name} />
        </span>
        <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <h2 className="min-w-0 truncate text-xl font-bold text-ink" title={displayName}>{displayName}</h2>
          <MarketCodeBadge market={market} code={code} />
          <span className="stock-detail-code flex-none text-sm text-muted">{code}</span>
        </div>
        <div className="ml-auto flex flex-none items-center gap-1.5">
          <MarketIcon market={market} flag={meta.flag} size={18} />
          <button
            type="button"
            onClick={toggleFollow}
            className={`stock-follow-button group ${faved ? "is-followed" : ""}`}
            aria-label={faved ? "取消关注" : "关注"}
            title={faved ? "取消关注" : "关注"}
            disabled={following}
          >
            {faved && (
              <span className="heart-burst" aria-hidden>
                <i /><i /><i /><i /><i /><i />
              </span>
            )}
            {faved ? (
              <svg viewBox="0 0 32 32" fill="currentColor" className="stock-follow-heart heart-pop" aria-hidden="true">
                <path d="M16 27C8.3 22.4 4 18.2 4 12.7A6.7 6.7 0 0 1 16 8.8a6.7 6.7 0 0 1 12 3.9C28 18.2 23.7 22.4 16 27Z" />
              </svg>
            ) : (
              <svg viewBox="0 0 1185 1024" fill="currentColor" className="stock-follow-heart" aria-hidden="true">
                <path d="M815.157895 40.421053c175.427368 0 316.200421 140.773053 321.158737 313.667368v56.858947H1037.473684v-49.421473a221.399579 221.399579 0 0 0-222.315789-222.31579c-71.626105 0-135.814737 32.121263-177.852632 88.926316l-4.904421 4.958316L592.842105 289.899789l-39.504842-56.805052a221.453474 221.453474 0 0 0-182.810947-93.884632A221.399579 221.399579 0 0 0 148.210526 361.525895c0 200.111158 229.753263 442.152421 437.248 521.216l7.383579 2.479158h2.479158c19.779368-7.383579 39.558737-17.246316 61.763369-29.642106l9.862736-4.958315 42.037895-24.68379 49.367579 86.447158-41.984 24.737684c-34.600421 19.725474-66.667789 34.546526-96.309895 44.409263l-9.916631 4.958316-17.246316 2.479158-14.874947-4.958316c-103.747368-34.546526-212.399158-103.747368-303.804632-192.673684l-14.821053-14.821053c-121.047579-118.568421-209.973895-269.204211-209.973894-414.989473C49.421474 183.673263 192.673684 40.421053 370.526316 40.421053c81.542737 0 158.127158 29.642105 217.411368 83.968L592.842105 129.347368l4.958316-4.958315A318.679579 318.679579 0 0 1 805.295158 40.421053h9.862737zM988.106105 485.052632v148.210526h148.210527v98.789053h-148.210527v148.210526H889.263158v-148.210526h-148.210526V633.263158h148.210526V485.052632h98.842947z" />
              </svg>
            )}
          </button>
        </div>
      </div>

      {/* 现价 */}
      <div className={`stock-detail-price mt-3 ${onBack ? "pl-10" : ""}`}>
        <div className="flex flex-wrap items-start gap-x-8 gap-y-3">
          {/* 今天 / 常规盘 */}
          <div>
            <div className="stock-detail-price-line flex flex-wrap items-center gap-x-2 gap-y-1">
              <span
                className={`text-[34px] font-bold leading-none tabular-nums ${currentPhase === "REGULAR" ? "" : "text-ink"}`}
                style={currentPhase === "REGULAR" ? { color: activeColor } : undefined}
              >
                {todayPrice != null ? `${market.toUpperCase() === "US" ? "$" : ""}${fmtNumMarket(todayPrice, market)}` : "—"}
              </span>
              {todayPrice != null && (
                <span className="inline-flex items-baseline gap-1 whitespace-nowrap text-[15px] font-semibold tabular-nums" style={{ color: activeColor }}>
                  <svg viewBox="0 0 12 12" fill="currentColor" className="h-[13px] w-[13px] self-center" aria-hidden="true">
                    {activeUp ? <path d="M6 2.75 L9.72 9.25 L2.28 9.25 Z" /> : <path d="M6 9.25 L2.28 2.75 L9.72 2.75 Z" />}
                  </svg>
                  {todayChangePct >= 0 ? "+" : ""}{fmtPct(todayChangePct / 100)} (<span>{todayChange >= 0 ? "+" : ""}{todayChange.toFixed(2)}</span>)
                </span>
              )}
              {todayPrice != null && <span className="text-[13px] font-semibold" style={{ color: activeColor }}>今天</span>}
            </div>
            <p className="mt-1.5 text-xs font-medium text-muted">
              {todayStatusLine}
            </p>
          </div>

          {/* 盘前 / 盘后交易 */}
          {extPrice != null && (
            <div>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-[22px] font-bold leading-none tabular-nums" style={{ color: extColor }}>
                  {`${market.toUpperCase() === "US" ? "$" : ""}${fmtNumMarket(extPrice, market)}`}
                </span>
                <span className="inline-flex items-baseline gap-1 whitespace-nowrap text-[13px] font-semibold tabular-nums" style={{ color: extColor }}>
                  <svg viewBox="0 0 12 12" fill="currentColor" className="h-[12px] w-[12px] self-center" aria-hidden="true">
                    {extUp ? <path d="M6 2.75 L9.72 9.25 L2.28 9.25 Z" /> : <path d="M6 9.25 L2.28 2.75 L9.72 2.75 Z" />}
                  </svg>
                  {extChangePct >= 0 ? "+" : ""}{fmtPct(extChangePct / 100)} (<span>{extChange >= 0 ? "+" : ""}{extChange.toFixed(2)}</span>)
                </span>
              </div>
              <p className="mt-1.5 flex items-center gap-1 text-xs font-medium text-muted">
                <svg viewBox="0 0 24 24" fill="currentColor" className="h-3.5 w-3.5" aria-hidden="true">
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                </svg>
                {extSessionLabel}交易 · {activeExtendedPoint?.time?.slice(0, 5) ?? ""}
              </p>
            </div>
          )}
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between px-0.5">
        <span className="text-[11px] font-medium text-muted">行情指标</span>
        <button
          type="button"
          onClick={() => {
            setShowMetrics((value) => !value);
            if (showMetrics) setShowMore(false);
          }}
          className="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[11px] font-medium text-muted transition-colors hover:bg-bg-gray hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
          aria-expanded={showMetrics}
          aria-controls="stock-quote-metrics"
        >
          {showMetrics ? "隐藏" : "显示"}
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={`h-3.5 w-3.5 transition-transform ${showMetrics ? "" : "rotate-180"}`} aria-hidden="true"><path d="m6 12 4-4 4 4" /></svg>
        </button>
      </div>

      {/* 行情指标：手机端 2 × 2，桌面端 4 列。 */}
      {showMetrics && <div id="stock-quote-metrics" className="mt-1.5 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {cell([
          { label: "最高", value: quote ? fmtNumMarket(quote.high, market) : "—", color: quote && quote.high >= quote.open ? UP : undefined },
          { label: "最低", value: quote ? fmtNumMarket(quote.low, market) : "—", color: quote && quote.low <= quote.open ? DOWN : undefined }
        ])}
        {cell([
          { label: "今开", value: quote ? fmtNumMarket(quote.open, market) : "—" },
          { label: "昨收", value: quote ? fmtNumMarket(prevClose, market) : "—" }
        ])}
        {cell([
          { label: "换手率", value: quote?.turnover ? `${fmtNum(quote.turnover)}%` : "—" },
          { label: "成交额", value: quote?.amount ? fmtCap(quote.amount) : "—" }
        ])}
        {cell([
          { label: "市盈率TTM", value: quote?.pe ? (quote.pe > 0 ? fmtNum(quote.pe) : "亏损") : "—" },
          {
            label: `总市值${localCur}`,
            value: marketCap ? fmtCap(marketCap) : "—",
            dots: true
          }
        ], true)}
      </div>}

      {showMetrics && showMore && (
        <div className="mt-2 grid auto-rows-max content-start grid-cols-2 items-start gap-x-4 gap-y-2 rounded-[10px] border border-edge bg-bg-gray/25 px-4 py-3 sm:grid-cols-4 dark:bg-white/[0.025]">
          {[
            ["52 周高", quote?.weekHigh ? fmtNumMarket(quote.weekHigh, market) : yearHigh != null ? fmtNumMarket(yearHigh, market) : "—"],
            ["委比", "—"],
            ["成交量", quote?.volume ? fmtCap(quote.volume) : "—"],
            ["总股本", totalShares ? `${fmtCap(totalShares)}股` : "—"],
            ["52 周低", quote?.weekLow ? fmtNumMarket(quote.weekLow, market) : yearLow != null ? fmtNumMarket(yearLow, market) : "—"],
            ["量比", quote?.volumeRatio ? fmtNum(quote.volumeRatio) : "—"],
            ["振幅", quote?.amplitude ? `${fmtNum(quote.amplitude)}%` : quote && prevClose ? `${fmtNum(((quote.high - quote.low) / prevClose) * 100)}%` : "—"],
            ["流通股本", floatShares ? `${fmtCap(floatShares)}股` : "—"],
            [`流通市值${localCur}`, floatMarketCap ? fmtCap(floatMarketCap) : "—"],
            ["每股收益TTM", epsTtm != null ? fmtNum(epsTtm) : "—"],
            ["市净率", quote?.pb ? fmtNum(quote.pb) : "—"],
            ["股息率TTM", quote?.dividendYieldTtm ? `${fmtNum(quote.dividendYieldTtm)}%` : "—"],
            ["市盈率动", "—"],
            ["每股收益动", "—"],
            ["均价", averagePrice != null ? fmtNumMarket(averagePrice, market) : "—"],
            ["股息TTM", quote?.dividendTtm ? fmtNum(quote.dividendTtm) : "—"],
            ["市盈率静", quote?.staticPe ? fmtNum(quote.staticPe) : "—"],
            ["每股收益", epsTtm != null ? fmtNum(epsTtm) : "—"],
            ["每股净资产", bookValuePerShare != null ? fmtNum(bookValuePerShare) : "—"],
            ["每手", "1"],
            ["货币", localCur],
            ["帮助", "ⓘ"]
          ].map(([label, value]) => <div key={label} className="min-w-0 leading-tight"><span className="block truncate text-[10px] leading-4 text-muted">{label}</span><b className="mt-0.5 block truncate text-[12px] font-medium leading-4 tabular-nums text-ink">{value}</b></div>)}
        </div>
      )}

      {/* ===== K 线区 ===== */}
      <div className="mt-4 border-t border-edge pt-3">
        <div className="stock-detail-tabs">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => {
                setTab(t.key);
                onTabChange?.(t.key);
              }}
              className={`relative pb-2 text-sm transition-colors ${
                tab === t.key ? "font-semibold text-ink" : "text-muted hover:text-ink"
              }`}
            >
              {t.label}
              {tab === t.key && <span className="absolute inset-x-0 bottom-0 h-[2px] rounded-full bg-ink" />}
            </button>
          ))}
        </div>
        <div className="mt-2" style={tabReady ? undefined : { visibility: "hidden" }}>
          {tab === "overview" ? (
            <>
              <StockKline market={market} code={code} name={displayName} height={400} />
            </>
          ) : tab === "etf" ? (
            <section className="stock-detail-module stock-etf-module">
              <div className="stock-module-heading">
                <h3 className="text-sm font-semibold text-ink">{mainStock ? `${displayName} 正股` : `${displayName} 相关 ETF`}</h3>
                <span className="stock-module-count">{related.length} 只</span>
              </div>
              {!mainStock && related.length > 0 && (
                <div className="stock-etf-summary" aria-label="相关 ETF 分类概览">
                  {[
                    ["long", "做多产品", etfKindCounts.long, "#3b82f6"],
                    ["short", "反向产品", etfKindCounts.short, "#f05a67"],
                    ["income", "收益策略", etfKindCounts.income, "#9b6fe8"]
                  ].map(([kind, label, count, color]) => (
                    <button key={kind} type="button" onClick={() => setEtfFilter(kind as "long" | "short" | "income")} className={etfFilter === kind ? "is-active" : ""}>
                      <i style={{ background: color as string }} />
                      <span><small>{label}</small><b>{count}</b></span>
                    </button>
                  ))}
                </div>
              )}
              {!mainStock && related.length > 0 && (
                <div className="stock-module-filters">
                  {[
                    ["all", "全部"],
                    ["long", "做多"],
                    ["short", "做空"],
                    ["income", "收益策略"]
                  ].map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setEtfFilter(key as "all" | "long" | "short" | "income")}
                      className={`flex-none rounded-full border px-3 py-1.5 text-[11px] font-semibold transition-all duration-200 active:scale-[.97] ${
                        etfFilter === key
                          ? "border-edge-strong bg-white text-ink shadow-sm dark:bg-[#1c1c1e] dark:text-white"
                          : "border-edge bg-transparent text-muted hover:-translate-y-px hover:bg-brand-hover hover:text-ink"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
              <div className="stock-etf-list">
                {etfLoading && related.length > 0 && Object.keys(etfQuotes).length === 0 && (
                  <div className="stock-module-loading" aria-live="polite">
                    <span className="stock-module-spinner" />
                    正在更新行情
                  </div>
                )}
                {sortedVisibleRelated.map((item) => {
                  const itemQuote = etfQuotes[item.code];
                  const itemUp = (itemQuote?.changePct ?? 0) >= 0;
                  // 相关 ETF 与搜索结果保持一致：ETF 复用对应正股圆形图标，避免 ETF 方形素材露出白底。
                  const itemIcon = pickStockIcon(stockIcons, "US", mainStock ? item.code : code);
                  return (
                    <button
                      key={item.code}
                      type="button"
                      onClick={() => setSelectedRelatedETF(item)}
                      className="stock-etf-row group"
                    >
                      <span className="relative flex-none">
                        <span className="flex h-9 w-9 flex-none items-center justify-center overflow-hidden rounded-full bg-bg-gray text-[11px] font-bold tracking-tight text-ink-2 transition-transform duration-200 group-hover:scale-105 dark:text-white">
                          {itemIcon ? (
                            <img src={itemIcon} alt={`${mainStock ? item.name : displayName} 图标`} className="h-full w-full object-cover" />
                          ) : item.code.slice(0, 2)}
                        </span>
                        <EtfDoubleBadge market="US" code={item.code} name={item.name} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 items-center gap-2">
                          <b className="truncate text-[13px] text-ink">{item.name}</b>
                          <span className="flex-none rounded-full bg-bg-gray px-1.5 py-0.5 text-[10px] font-semibold text-muted">{item.badge}</span>
                        </span>
                        <span className="mt-1 flex items-center gap-1.5 text-[11px] font-medium text-muted"><MarketCodeBadge market="US" code={item.code} />{item.code} · {mainStock ? "基础股票" : item.kind === "income" ? "期权收益策略" : item.kind === "long" ? "杠杆做多" : "反向做空"}</span>
                      </span>
                      <span className="stock-etf-metric is-cap">
                        <small>市值</small>
                        <b>{itemQuote?.marketCap ? fmtCap(itemQuote.marketCap) : "—"}</b>
                      </span>
                      <span className="stock-etf-metric">
                        <small>最新价</small>
                        <b className="text-[13px] font-semibold text-ink">{itemQuote ? fmtPrice(itemQuote.price, "$", "US") : "—"}</b>
                        <span className={`text-[11px] font-semibold ${itemUp ? "text-up" : "text-down"}`}>
                          {itemQuote ? `${itemQuote.changePct >= 0 ? "+" : ""}${fmtPct(itemQuote.changePct / 100)}` : "行情暂缺"}
                        </span>
                      </span>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 flex-none text-faint transition-transform duration-200 group-hover:translate-x-0.5"><path d="m9 18 6-6-6-6" /></svg>
                    </button>
                  );
                })}
                {related.length === 0 && (
                  <div className="stock-module-empty">
                    暂无已收录的相关 ETF 或正股关系
                  </div>
                )}
                {related.length > 0 && visibleRelated.length === 0 && (
                  <div className="stock-module-empty">该筛选条件下暂无 ETF</div>
                )}
                {!mainStock && (
                  <div className="flex justify-center pt-3">
                    {!relatedEditorOpen ? (
                      <button type="button" onClick={() => setRelatedEditorOpen(true)} aria-label="添加相关股票" className="grid h-9 w-9 place-items-center rounded-full border border-dashed border-edge-strong text-muted transition hover:bg-bg-gray hover:text-ink">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5"><circle cx="12" cy="12" r="8"/><path d="M8 12h8M12 8v8"/></svg>
                      </button>
                    ) : (
                      <div className="grid w-full max-w-2xl grid-cols-1 gap-2 text-left sm:grid-cols-[minmax(240px,1fr)_110px_140px_auto]">
                        <StockSearch
                          autoFocus
                          marketFilter={market}
                          securitiesOnly
                          placeholder={relatedDraft.name ? `已选择：${relatedDraft.name} · ${relatedDraft.code}` : "搜索 ETF 代码、名称或中文名"}
                          onQueryChange={(query) => setRelatedDraft((draft) => ({ ...draft, code: query.trim().toUpperCase(), name: "" }))}
                          onSelect={(match) => setRelatedDraft((draft) => ({ ...draft, code: match.code.trim().toUpperCase(), name: match.name.trim() }))}
                        />
                        <AppSelect value={relatedDraft.kind} onChange={(value) => setRelatedDraft((draft) => ({ ...draft, kind: value as RelatedETF["kind"] }))} options={[{ value: "long", label: "做多" }, { value: "short", label: "做空" }, { value: "income", label: "收益策略" }]} className="h-9 rounded-lg border border-edge-strong bg-white px-2 text-xs text-ink dark:bg-[#1c1c1e]" ariaLabel="关联类型" />
                        <span className="flex h-9 min-w-0 items-center truncate rounded-lg border border-edge bg-bg-gray px-3 text-xs text-muted" title={`默认关联 ${displayName} ${code}`}>正股 · {displayName} {code}</span>
                        <div className="flex gap-2"><button type="button" onClick={addCustomRelatedEtf} className="btn btn-dark btn-sm">添加</button><button type="button" onClick={() => setRelatedEditorOpen(false)} className="btn btn-line btn-sm">取消</button></div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </section>
          ) : tab === "dividend" ? (
            <section className="stock-detail-module stock-dividend-module">
              <div className="stock-module-heading">
                <h3 className="text-sm font-semibold text-ink">{displayName} 股息记录</h3>
                <span className="stock-module-count">{dividends.length} 期</span>
              </div>
              {dividendsLoading && dividends.length === 0 ? (
                <div className="stock-module-loading mt-3" aria-live="polite">
                  <span className="stock-module-spinner" />
                  正在获取股息记录
                </div>
              ) : !dividendsOk ? (
                <div className="stock-module-empty mt-3">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M12 8v5M12 17h.01"/><circle cx="12" cy="12" r="9"/></svg>
                  股息数据源暂时不可用
                  <span>重新进入本页时将自动重试，不影响其他行情数据。</span>
                </div>
              ) : dividends.length === 0 ? (
                <div className="stock-module-empty mt-3">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M5 5h14v14H5zM8 9h8M8 13h5"/></svg>
                  暂无已披露的股息 / 收益分配记录
                </div>
              ) : (
                <div className="mt-3">
                  <div className="stock-dividend-summary">
                    <div><span>最近每股股息</span><b>{latestDividend?.amount != null ? fmtDividendAmount(latestDividend) : "—"}</b><small>{latestDividend?.exDate ? `除息 ${latestDividend.exDate}` : "暂无除息日期"}</small></div>
                    <div><span>{dividendYear || "披露"}累计</span><b>{activeYearCashTotal != null ? `${activeYearCashTotal.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${dividendCurrencies[0] || ""}` : "多币种"}</b><small>{cashDividends.length} 次现金</small></div>
                    <div><span>下一派付日</span><b>{upcomingDividend?.payDate || "暂无"}</b><small>{upcomingDividend?.amount != null ? fmtDividendAmount(upcomingDividend) : "以最新披露为准"}</small></div>
                  </div>
                  {dividendYears.length > 1 && (
                    <div className="mb-2.5 flex gap-1 overflow-x-auto pb-0.5">
                      {["全部", ...dividendYears].map((y) => {
                        const active = y === "全部" ? dividendYear === null : dividendYear === y;
                        return (
                          <button
                            key={y}
                            type="button"
                            onClick={() => setDividendYear(y === "全部" ? null : y)}
                            className={`flex-none rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-all duration-200 active:scale-[.97] ${
                              active
                                ? "border-edge-strong bg-white text-ink shadow-sm dark:bg-[#1c1c1e] dark:text-white"
                                : "border-edge bg-transparent text-muted hover:bg-brand-hover hover:text-ink"
                            }`}
                          >
                            {y === "全部" ? "全部" : y}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  <DividendTable
                    rows={visibleDividends}
                    showYear={dividendYear === null && dividendYears.length > 1}
                    statusOf={dividendStatus}
                  />
                </div>
              )}
            </section>
          ) : tab === "financial" ? (
            <FinancialPanel market={market} code={code} />
          ) : tab === "company" ? (
            <CompanyProfilePanel market={market} code={code} name={displayName} iconUrl={stockIconUrl} />
          ) : (
            <div className="flex h-[300px] flex-col items-center justify-center gap-2 rounded-[12px] border border-dashed border-edge-strong text-sm text-faint">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-8 w-8 opacity-50">
                <rect x="3" y="4" width="18" height="16" rx="2" />
                <path d="M7 15h10M7 9h4" />
              </svg>
              「{tabs.find((x) => x.key === tab)?.label}」内容规划中
            </div>
          )}
        </div>
      </div>

      {/* ===== 多币种市值弹层 ===== */}
      {showCur && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40" onClick={() => setShowCur(false)} />
          <div className="relative w-full max-w-[400px] rounded-[16px] border border-edge bg-white p-5 shadow-pop dark:bg-[#1c1c1e]">
            <div className="flex items-center justify-center gap-2">
              <MarketIcon market={market} flag={meta.flag} size={18} />
              <p className="text-sm font-bold text-ink">多币种市值</p>
              <span className="text-xs text-muted">{code}</span>
            </div>
            <div className="mt-3 space-y-1.5">
              {MULTI_CURRENCIES.map((cur) => {
                const rate = r[cur.code] || 0;
                const selected = cur.code === localCur;
                return (
                  <div
                    key={cur.code}
                    className={`group flex items-center justify-between rounded-[10px] px-3 py-2.5 transition-all duration-200 ${
                      selected
                        ? "bg-[#2a2f3a]"
                        : "hover:-translate-y-px hover:bg-brand-hover hover:shadow-[0_2px_10px_rgba(0,0,0,.06)] active:scale-[.98]"
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <MarketIcon
                        market={cur.market}
                        flag={cur.flag}
                        size={20}
                        className="transition-transform duration-300 ease-out group-hover:scale-110 group-hover:-rotate-6"
                      />
                      <div>
                        <p className={`text-[13px] ${selected ? "font-semibold text-white" : "text-ink"}`}>{cur.name}</p>
                        <p className={`mt-0.5 text-[11px] ${selected ? "text-white/75" : "text-faint"}`}>
                          1 {cur.code} = {rate ? (1 / rate).toFixed(4) : "—"} USD
                        </p>
                      </div>
                    </div>
                    <b className={`text-[13px] tabular-nums ${selected ? "text-white" : "text-ink"}`}>
                      {fmtCap(capFor(cur.code))}
                    </b>
                  </div>
                );
              })}
            </div>
            <p className="mt-3 text-center text-[11px] text-faint">当天非实时汇率，以上换算市值仅供参考</p>
            <button
              type="button"
              onClick={() => setShowCur(false)}
              className="mt-3 w-full rounded-full bg-ink py-2.5 text-sm font-semibold text-white transition-transform active:scale-[0.98] dark:bg-white dark:text-black"
            >
              知道了
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
