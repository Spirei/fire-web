"use client";
import type { FxRatesInitial } from "@/lib/fxRatesClient";
import { IconCoin, IconExternalLink, IconRefresh } from "@tabler/icons-react";
import DataUnavailable from "@/components/DataUnavailable";
import { Capsule, CapsuleLink } from "@/components/Capsule";
import { readFailure } from "@/lib/readFailure";
import Pagination from "@/components/Pagination";

import { useWorkspaceSearchParams as useSearchParams, useWorkspaceLocationGuard } from "@/lib/workspacePanel";

import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import FxConverter from "@/components/FxConverter";
import MarketCalendarView from "@/components/MarketCalendarView";
import { fmtPct } from "@/lib/format";
import MarketIcon from "@/components/MarketIcon";
import { ensureStockIcons, useAssetIcons } from "@/lib/useAssetIcons";
import { marketCapLibraryIcon, marketCapStockKey, type RankedAsset } from "@/lib/marketCapIcons";
import { compareMarketCapRanks } from "@/lib/marketCapRankHistory";
import SafeAssetImage from "@/components/SafeAssetImage";
import CurrencySelect from "@/components/CurrencySelect";
import { useDisplayCurrency, type CurrencyCode } from "@/lib/currencyPrefs";
import MarketCodeBadge from "@/components/MarketCodeBadge";
import { sharedRead } from "@/lib/sharedRead";
import { readMiniKline, writeMiniKline, validCloses } from "@/lib/miniKlineCache";
import GlobalSectionNav, { type GlobalSection } from "@/components/GlobalSectionNav";
import { useWorkspaceForeground } from "@/lib/useWorkspaceForeground";

interface TopAsset extends RankedAsset {
  name: string;
  marketCap: number;
  price: number | null;
  changePct: number | null;
  logo: string;
}

type MarketCapSnapshot = { items: TopAsset[]; at: number; changes: (number | null)[]; comparedAt?: number };
const RANK_CACHE_KEY = "fire:topstocks:rank:v2";
const MARKET_CAP_SOURCE = "https://companiesmarketcap.com/assets-by-market-cap/";
const NO_MARKET_CAP_SNAPSHOT = "本站暂无可展示的市值快照";
const MARKET_CAP_TIME = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

// 全球资产中文名（覆盖榜单常见项，未收录的保持英文）
const NAME_ZH: Record<string, string> = {
  GOLD: "黄金", SILVER: "白银", PLATINUM: "铂金", PLAT: "铂金",
  BTC: "比特币", BITCOIN: "比特币", ETH: "以太坊", ETHEREUM: "以太坊",
  NVIDIA: "英伟达", APPLE: "苹果", MICROSOFT: "微软", AMAZON: "亚马逊",
  ALPHABET: "谷歌", GOOGLE: "谷歌", META: "Meta", "META PLATFORMS": "Meta",
  TSMC: "台积电", BROADCOM: "博通", "SAUDI ARAMCO": "沙特阿美", SAUDIARAMCO: "沙特阿美",
  TESLA: "特斯拉", "BERKSHIRE HATHAWAY": "伯克希尔", LVMH: "路威酩轩",
  "ELI LILLY": "礼来", WALMART: "沃尔玛", JPMORGAN: "摩根大通", VISA: "Visa",
  MASTERCARD: "万事达", "EXXON MOBIL": "埃克森美孚",
  UNITEDHEALTH: "联合健康", "HOME DEPOT": "家得宝", "JOHNSON & JOHNSON": "强生",
  ORACLE: "甲骨文", SALESFORCE: "赛富时", COSTCO: "好市多", NETFLIX: "奈飞",
  ADOBE: "Adobe", "COCA-COLA": "可口可乐", PEPSICO: "百事", MCDONALDS: "麦当劳",
  "MCDONALD'S": "麦当劳", NIKE: "耐克", DISNEY: "迪士尼", "WALT DISNEY": "迪士尼",
  INTEL: "英特尔", AMD: "AMD", QUALCOMM: "高通", "TEXAS INSTRUMENTS": "德州仪器",
  CISCO: "思科", IBM: "IBM", PAYPAL: "贝宝", UBER: "优步", AIRBNB: "爱彼迎",
  BOEING: "波音", CATERPILLAR: "卡特彼勒", "3M": "3M", HONEYWELL: "霍尼韦尔",
  "GENERAL ELECTRIC": "通用电气", GE: "通用电气", SIEMENS: "西门子", SAP: "SAP",
  NOVARTIS: "诺华", ROCHE: "罗氏", NESTLE: "雀巢", TOYOTA: "丰田", "TOYOTA MOTOR": "丰田",
  SONY: "索尼", HONDA: "本田", MITSUBISHI: "三菱", SOFTBANK: "软银",
  SAMSUNG: "三星", "SAMSUNG ELECTRONICS": "三星电子", LG: "LG", HYUNDAI: "现代",
  ICBC: "工商银行", "CHINA CONSTRUCTION BANK": "建设银行", "AGRICULTURAL BANK": "农业银行",
  "BANK OF CHINA": "中国银行", "CHINA MOBILE": "中国移动", PETROCHINA: "中国石油",
  SINOPEC: "中国石化", "KWEICHOW MOUTAI": "贵州茅台", MOUTAI: "贵州茅台",
  TENCENT: "腾讯", ALIBABA: "阿里巴巴", BAIDU: "百度", "JD.COM": "京东", PDD: "拼多多",
  MEITUAN: "美团", BYD: "比亚迪", CATL: "宁德时代", TSLA: "特斯拉",
  SPACEX: "SpaceX", VOO: "标普500ETF", IVV: "标普500ETF", VTI: "全市场ETF"
};

function zhName(it: TopAsset): string {
  const key = it.name.toUpperCase();
  const base = key.replace(/\s*\(.*?\)\s*/g, " ").trim();
  return NAME_ZH[key] ?? NAME_ZH[base] ?? NAME_ZH[it.code.toUpperCase()] ?? it.name;
}

function fmtMoney(value: number, rate: number, symbol: string, currency: CurrencyCode) {
  const v = value * rate;
  if (currency === "USD") {
    if (v >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
    if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
    if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
    return `$${v.toFixed(0)}`;
  }
  if (v >= 1e12) return `${symbol}${(v / 1e12).toFixed(2)}万亿`;
  if (v >= 1e8) return `${symbol}${(v / 1e8).toFixed(1)}亿`;
  if (v >= 1e4) return `${symbol}${(v / 1e4).toFixed(0)}万`;
  return `${symbol}${v.toFixed(0)}`;
}

function fmtPrice(price: number, rate: number, symbol: string, currency: CurrencyCode) {
  const v = price * rate;
  if (currency === "USD") {
    return v >= 1000 ? `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}` : `$${v.toFixed(3)}`;
  }
  return v >= 1000 ? `${symbol}${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}` : `${symbol}${v.toFixed(2)}`;
}

// ---------- 月 K mini 图（后端代理新浪日 K 聚合月收盘，懒加载 + 缓存） ----------
const MiniKline = memo(function MiniKline({ market, code }: { market: string; code: string }) {
  // 首帧不画（服务端也没有本地缓存）：挂载后、绘制前再恢复缓存，避免水合不一致
  const [points, setPoints] = useState<number[] | null>(null);
  useLayoutEffect(() => {
    setPoints(readMiniKline(market, code));
  }, [market, code]);
  const holderRef = useRef<HTMLSpanElement>(null);
  const [inView, setInView] = useState(false);

  // 进入视口才加载，避免一次性并发几十个 K 线请求
  useEffect(() => {
    const el = holderRef.current;
    if (!el) return;
    const ob = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setInView(true);
          ob.disconnect();
        }
      },
      { rootMargin: "150px 0px" }
    );
    ob.observe(el);
    return () => ob.disconnect();
  }, []);

  useEffect(() => {
    if (points || !inView) return;
    let cancelled = false;
    sharedRead(`/api/kline?market=${encodeURIComponent(market)}&code=${encodeURIComponent(code)}`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (cancelled) return;
        const closes: number[] = Array.isArray(data?.closes) ? data.closes : [];
        if (validCloses(closes)) {
          writeMiniKline(market, code, closes);
          setPoints(closes);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [market, code, points, inView]);

  if (!points || points.length < 2) return <span ref={holderRef} className="inline-block h-[22px] w-[60px]" />;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const W = 60;
  const H = 22;
  const step = W / (points.length - 1);
  const coords = points.map((p, i) => `${(i * step).toFixed(1)},${(H - 2 - ((p - min) / span) * (H - 4)).toFixed(1)}`).join(" ");
  const up = points[points.length - 1] >= points[0];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="inline-block h-[22px] w-[60px] flex-none" aria-label="最近12个月月收盘走势">
      <polyline points={coords} fill="none" stroke={up ? "#e23d3d" : "#0fa07b"} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
});

// ---------- Logo（素材库优先，404 自动回退首字母） ----------
function AssetLogo({ item, custom }: { item: TopAsset; custom?: string }) {
  const src = custom || item.logo;
  return <SafeAssetImage src={src} loading="lazy" className="h-8 w-8 rounded-full object-cover" fallback={
      <span className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-brand-light text-xs font-bold text-brand-deep">
        {zhName(item).slice(0, 1)}
      </span>
  } />;
}

function EmptyMarketIcon({ label }: { label: string }) {
  return (
    <span
      className="inline-flex h-[18px] w-[18px] flex-none items-center justify-center text-[13px] leading-none text-faint"
      title={label}
      role="img"
      aria-label={label}
    >
      −
    </span>
  );
}

function AssetMarketCapRanking({ pageSize }: { pageSize?: number }) {
  const { stockIcons, assetIcons } = useAssetIcons(["stock", "crypto", "metal"]);
  const [snapshot, setSnapshot] = useState<MarketCapSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [readAttempt, setReadAttempt] = useState(0);
  const [page, setPage] = useState(1);
  const { currency, rate, symbol } = useDisplayCurrency();
  const foreground = useWorkspaceForeground();
  const rateReady = Number.isFinite(rate) && rate > 0;
  const retry = () => setReadAttempt(value => value + 1);

  useEffect(() => {
    if (!foreground) return;
    let cancelled = false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    setLoading(true);
    fetch("/api/top-stocks?market=ALL", { signal: controller.signal, cache: "no-store" })
      .then(async res => {
        const data = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok) {
          const detail = readFailure(data, "全球市值排行暂不可用");
          if (res.status === 401 || res.status === 403 || res.status === 503) {
            setSnapshot(null);
            if (res.status === 503 && detail.startsWith("公共发现")) throw new Error(NO_MARKET_CAP_SNAPSHOT);
          }
          throw new Error(detail);
        }
        if (!Array.isArray(data?.items)) throw new Error("榜单响应无法读取");
        if (!data.items.length) {
          setSnapshot(null);
          throw new Error(NO_MARKET_CAP_SNAPSHOT);
        }
        const items: TopAsset[] = data.items;
        const at = typeof data.updatedAt === "string" ? Date.parse(data.updatedAt) : NaN;
        let saved: unknown;
        try { saved = JSON.parse(localStorage.getItem(RANK_CACHE_KEY) ?? "null"); } catch { /* Storage is optional. */ }
        const { changes, history, comparedAt } = compareMarketCapRanks(items, at, saved);
        if (history) {
          try { localStorage.setItem(RANK_CACHE_KEY, JSON.stringify(history)); } catch { /* Storage is optional. */ }
        }
        setSnapshot({ items, at, changes, comparedAt });
        setErr("");
      })
      .catch(error => !cancelled && setErr(controller.signal.aborted ? "读取超时，请重新读取" : error instanceof TypeError ? "连接失败，请重新读取" : error instanceof Error ? error.message : "无法读取全球市值排行"))
      .finally(() => { clearTimeout(timer); if (!cancelled) setLoading(false); });
    return () => { cancelled = true; clearTimeout(timer); controller.abort(); };
  }, [foreground, readAttempt]);

  useEffect(() => {
    if (!foreground || !snapshot) return;
    void ensureStockIcons(snapshot.items.flatMap(item => { const key = marketCapStockKey(item); return key ? [key] : []; }));
  }, [foreground, snapshot]);

  // 首页内嵌时每页展示 pageSize 条
  const items = snapshot?.items ?? [];
  const totalPages = pageSize ? Math.max(1, Math.ceil(items.length / pageSize)) : 1;
  const safePage = Math.min(page, totalPages);
  const displayItems = pageSize ? items.slice((safePage - 1) * pageSize, safePage * pageSize) : items;
  useEffect(() => {
    setPage(1);
  }, [pageSize]);

  const comparedAt = snapshot?.comparedAt;
  const comparisonDate = comparedAt === undefined ? null : MARKET_CAP_TIME.format(comparedAt);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 space-y-1">
          <h2 className="min-w-0 text-lg font-bold">全球资产市值排行</h2>
          {snapshot && <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
            <a className="inline-flex items-center gap-1 hover:underline" href={MARKET_CAP_SOURCE} target="_blank" rel="noreferrer">
              CompaniesMarketCap <IconExternalLink size={12} aria-hidden="true" />
            </a>
            {Number.isFinite(snapshot.at) ? <time dateTime={new Date(snapshot.at).toISOString()}>
              {`采集于 ${MARKET_CAP_TIME.format(snapshot.at)}（北京时间）`}
            </time> : <span>采集时间未提供</span>}
          </p>}
        </div>
        {snapshot && <div className="flex w-full flex-none items-center gap-2 sm:w-auto">
          <CurrencySelect align="right" />
          <Capsule variant="secondary" size="sm" busy={loading} onClick={retry} aria-label="重新读取榜单" title="重新读取榜单">
            <IconRefresh size={16} className={loading ? "motion-safe:animate-spin" : undefined} aria-hidden="true" />
          </Capsule>
        </div>}
      </header>

      {err && snapshot && <p role="status" className="text-xs text-muted">{err}。正在显示上次读取的快照。</p>}
      {snapshot && !rateReady && <p role="status" className="text-xs text-muted">暂缺 {currency} 汇率，可切换到 USD 查看金额。</p>}
      {!snapshot ? (
        <div className="grid min-h-[224px] place-items-center rounded-card border border-edge bg-white">
          {err ? <DataUnavailable title={err === NO_MARKET_CAP_SNAPSHOT ? "暂无市值快照" : "市值排行暂不可用"}
            detail={err === NO_MARKET_CAP_SNAPSHOT ? undefined : err} onRetry={retry} retrying={loading}
            action={<CapsuleLink href={MARKET_CAP_SOURCE} target="_blank" rel="noreferrer" variant="secondary" size="sm">查看来源榜单 <IconExternalLink size={14} aria-hidden="true" /></CapsuleLink>} /> : (
            <p className="flex items-center gap-2 text-sm text-muted" role="status">
              <IconRefresh size={16} className="motion-safe:animate-spin" aria-hidden="true" /> 正在读取全球市值排行…
            </p>
          )}
        </div>
      ) : (
        <div className="overflow-hidden rounded-card border border-edge bg-white shadow-card">
          <div className="data-table-scroll focus-visible:outline-offset-[-2px]" tabIndex={0} role="region" aria-label="市值排行表格">
            <table className="mobile-global-table w-full min-w-[720px] table-fixed text-sm">
              <caption className="sr-only">全球资产市值排行，{items.length} 项</caption>
              <colgroup>
                <col className="w-[48px]" /><col className="w-[174px]" /><col className="w-[135px]" /><col className="w-[106px]" /><col className="w-[94px]" /><col className="w-[94px]" /><col className="w-[69px]" />
              </colgroup>
              <thead>
                <tr className="whitespace-nowrap bg-bg-gray text-xs font-semibold text-muted">
                  <th scope="col" className="py-3 text-center">排名</th>
                  <th scope="col" className="px-2 py-3 text-left">资产</th>
                  <th scope="col" className="px-2 py-3 text-right">市值 <span className="font-normal">{currency}</span></th>
                  <th scope="col" className="px-3 py-3 text-right">现价</th>
                  <th scope="col" className="px-2 py-3 text-center">涨跌幅</th>
                  <th scope="col" className="px-2 py-3 text-center">月 K</th>
                  <th scope="col" className="px-2 py-3 text-center">市场</th>
                </tr>
              </thead>
              <tbody>
                {displayItems.map((it, i) => {
                  const up = (it.changePct ?? 0) >= 0;
                  const rankNo = (safePage - 1) * (pageSize ?? 0) + i + 1;
                  const rankChange = snapshot.changes[rankNo - 1];
                  const stock = marketCapStockKey(it);
                  const libraryIcon = marketCapLibraryIcon(it, stockIcons, assetIcons);
                  const rankColor = rankNo === 1 ? "#f5a623" : rankNo === 2 ? "#9aa3ad" : rankNo === 3 ? "#c8864a" : "#9298a1";
                  const rankSize = rankNo === 1 ? "text-[18px] font-bold" : rankNo === 2 ? "text-[15px] font-bold" : "text-[12px] font-semibold";
                  return (
                    <tr key={`${it.type}-${it.market}-${it.code}-${rankNo}`} className="whitespace-nowrap border-t border-edge transition-colors hover:bg-bg-gray">
                      <td className="py-3 text-center">
                        <span className={`inline-block w-[28px] text-center tabular-nums leading-none ${rankSize}`} style={{ color: rankColor }}>
                          {rankNo}
                        </span>
                      </td>
                      <td className="px-2 py-3 text-left">
                        <div className="flex items-center gap-2">
                          <AssetLogo item={it} custom={libraryIcon} />
                          <span className="min-w-0 max-w-[126px]">
                            <span className="block truncate font-semibold text-ink" title={it.name}>{zhName(it)}</span>
                            <span className="mt-0.5 flex items-center gap-1.5">
                              {stock && <MarketCodeBadge market={stock.market} code={stock.code} />}
                              <span className="truncate text-[11px] text-muted" title={it.code}>{it.code}</span>
                            </span>
                          </span>
                        </div>
                      </td>
                      <td className="px-2 py-3 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          {rankChange && comparisonDate ? (
                            <span
                              title={`较 ${comparisonDate}（北京时间）${rankChange > 0 ? "上升" : "下降"} ${Math.abs(rankChange)} 位`}
                              className={`flex-none rounded px-1 py-0.5 text-[10px] font-semibold leading-none ${rankChange > 0 ? "bg-up-bg text-up" : "bg-down-bg text-down"}`}
                            >
                              {rankChange > 0 ? "↑" : "↓"}{Math.abs(rankChange)}
                            </span>
                          ) : null}
                          <span className="font-semibold tabular-nums text-ink">{rateReady ? fmtMoney(it.marketCap, rate, symbol, currency) : "—"}</span>
                        </div>
                      </td>
                      <td className="px-3 py-3 text-right font-medium tabular-nums text-ink-2">{rateReady && it.price != null ? fmtPrice(it.price, rate, symbol, currency) : "—"}</td>
                      <td className={`px-2 py-3 text-center tabular-nums ${it.changePct == null || it.changePct === 0 ? "text-muted" : up ? "text-up" : "text-down"}`}>
                        {it.changePct == null ? "—" : `${it.changePct > 0 ? "+" : ""}${fmtPct(it.changePct / 100)}`}
                      </td>
                      <td className="px-2 py-3 text-center">
                        {stock && (stock.market === "US" || stock.market === "CN") ? <MiniKline {...stock} /> : <span className="text-muted">—</span>}
                      </td>
                      <td className="px-2 py-3 text-center">
                        <span className="inline-flex h-[18px] w-[18px] items-center justify-center align-middle">
                          {stock ? <MarketIcon market={stock.market} size={18} /> : it.type === "crypto" ? (
                            <span role="img" aria-label="加密货币" title="加密货币" className="text-muted"><IconCoin size={18} aria-hidden="true" /></span>
                          ) : (
                            <EmptyMarketIcon label={it.type === "metal" ? "贵金属" : "市场未确认"} />
                          )}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {pageSize && totalPages > 1 && (
        <Pagination page={safePage} total={totalPages} onChange={setPage}/>
      )}
    </div>
  );
}

function parseGlobalSection(value: string | null): GlobalSection {
  return value === "convert" || value === "calendar" ? value : "assets";
}

export default function GlobalPreviewView({ pageSize, initialNow, onOpenQuotePool, initialFx }: { pageSize?: number; initialNow?: number; onOpenQuotePool?: () => void; initialFx?: FxRatesInitial }) {
  const canUseWorkspaceUrl = useWorkspaceLocationGuard();
  const searchParams = useSearchParams();
  const section = pageSize ? "assets" : parseGlobalSection(searchParams.get("section"));
  const selectSection = (next: GlobalSection) => {
    if (!canUseWorkspaceUrl()) return;
    if (pageSize) return;
    if (next === "quote-pool") { onOpenQuotePool?.(); return; }
    const params = new URLSearchParams(window.location.search);
    params.set("section", next);
    if (next !== "convert") {
      params.delete("from");
      params.delete("amount");
    }
    window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
  };

  if (pageSize) return <AssetMarketCapRanking pageSize={pageSize} />;

  return (
    <div className="global-economy-page flex flex-col gap-6">
      <GlobalSectionNav section={section} onSelect={selectSection} />
      <div key={section} className="global-section-panel">
        {section === "assets" ? <AssetMarketCapRanking /> : section === "calendar" ? <MarketCalendarView initialNow={initialNow} /> : <FxConverter initial={initialFx} />}
      </div>
    </div>
  );
}
