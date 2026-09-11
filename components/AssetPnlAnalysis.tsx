"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { FALLBACK_RATES, type Quote, type StockRecord, type TradeOrder } from "@/lib/types";
import { MARKET_CURRENCY } from "@/lib/currency";
import PnlTrendChart, { type PnlTrendPoint } from "@/components/PnlTrendChart";
import PnlCalendar from "@/components/PnlCalendar";
import MarketIcon from "@/components/MarketIcon";
import CurrencyFlag from "@/components/CurrencyFlag";
import { useAssetIcons } from "@/lib/useAssetIcons";
import { getMarketBadge } from "@/lib/marketBadge";
import { useMarketBadge, useMarketBadgeVisible } from "@/lib/useMarketBadge";
import { showToast } from "@/lib/toast";
import { buildPortfolioLedger } from "@/lib/portfolioLedger";
import { CURRENCIES, CURRENCY_SYMBOLS, useDisplayCurrency } from "@/lib/currencyPrefs";
import { fmtMoney, fmtMoneyCompact, localDateKey } from "@/lib/format";
import { buildDailyAssetSeries, buildDayDetailRows, buildMonthCells, buildYearSummary, readPnlCalendarPrefs, savePnlCalendarPref, type CalendarDayRow } from "@/lib/pnlCalendar";


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
  // 本页偏好全部走「首帧用默认值 + 挂载后（绘制前）恢复本地偏好」，
  // 原因：本页会被服务端渲染（/pnl 直接进），首帧读 localStorage 会造成水合不一致。
  const [calMarket, setCalMarket] = useState<string>("全部");
  const [chartTab, setChartTab] = useState<"return" | "asset">("return");
  const [rankMode, setRankMode] = useState<"profit" | "loss">("profit");
  const [detailMode, setDetailMode] = useState<"profit" | "loss">("profit");
  // 盈亏总额卡片：货币（与资产分析页共用 key）、基准（多市场）、加权
  const { currency: displayCurrency, setCurrency: setDisplayCurrency } = useDisplayCurrency();
  const [benchKey, setBenchKey] = useState<string>("spy");
  const [weighting, setWeighting] = useState<"simple" | "time">("simple");
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
  const [dayDetail, setDayDetail] = useState<{ date: string; rows: CalendarDayRow[] } | null>(null);
  const [calendarMode, setCalendarMode] = useState<"收益" | "收益率">("收益");
  const [calView, setCalView] = useState<"year" | "month">("month");
  const [calMonth, setCalMonth] = useState<{ y: number; m: number }>(() => {
    const now = new Date();
    return { y: now.getFullYear(), m: now.getMonth() + 1 };
  });
  useLayoutEffect(() => {
    try {
      const prefs = readPnlCalendarPrefs();
      if (prefs.market) setCalMarket(prefs.market);
      if (prefs.month) setCalMonth(prefs.month);
      if (prefs.view) setCalView(prefs.view);
      if (prefs.mode) setCalendarMode(prefs.mode);
      const savedBench = localStorage.getItem("fire:asset-pnl-bench");
      if (BENCHMARKS.some((item) => item.key === savedBench)) setBenchKey(savedBench as string);
      if (localStorage.getItem("fire:asset-pnl-weighting") === "time") setWeighting("time");
    } catch {
      /* 读取失败保留默认偏好 */
    }
  }, []);
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
      // 口径已抽到 lib/pnlCalendar：与资产分析页共用同一份日资产序列算法
      return buildDailyAssetSeries({
        positions: rows.map((row) => ({ id: row.id, name: row.name, code: row.code, market: row.market, qty: row.qty })),
        closesMap,
        orders,
        rates
      });
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

  const calDays = useMemo(() => buildMonthCells(calDailyAsset, calMonth.y, calMonth.m), [calMonth, calDailyAsset]);

  // 年视图：展示所选年份每个月的收益 / 收益率（收益=当月日盈亏合计，收益率=相对上月月末资产）
  const yearSummary = useMemo(
    () => buildYearSummary(calDailyAsset, calMonth.y, calMonth.m),
    [calMonth, calDailyAsset]
  );

  // 收益日历某天 → 每只股票的当日盈亏（当日收盘 − 前一日收盘）× 数量，按日历市场筛选，USD
  const openDayDetail = (date: string) => {
    const rows = buildDayDetailRows({ date, positions: calPositions, closesMap, rates });
    if (rows.length === 0) return;
    setDayDetail({ date, rows });
  };

  const updatedAt = new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
  const dateRange = klineLoading
    ? ""
    : dailyAssetFiltered.length > 1
      ? `${dailyAssetFiltered[0].date.replace(/-/g, "/")} - ${dailyAssetFiltered[dailyAssetFiltered.length - 1].date.replace(/-/g, "/")}`
      : "暂无数据";


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
      link.download = `盈亏总额-${localDateKey()}.png`;
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

            <PnlCalendar
              className="mt-5 card p-5"
              days={calDays}
              yearSummary={yearSummary}
              loading={klineLoading}
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
              mode={calendarMode}
              onModeChange={(next) => {
                setCalendarMode(next);
                savePnlCalendarPref({ mode: next });
              }}
              market={calMarket}
              onMarketChange={(next) => {
                setCalMarket(next);
                savePnlCalendarPref({ market: next });
              }}
              formatAmount={moneyDisp}
              formatCompact={compactDisp}
              stockIcons={stockIcons}
              onDayClick={openDayDetail}
              dayDetail={dayDetail}
              onDayDetailClose={() => setDayDetail(null)}
              renderMarketBadge={(row) => <MarketBadge market={row.market as PnlRow["market"]} code={row.code} />}
            />

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
