"use client";

import { memo, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { fmtPct } from "@/lib/format";
import MarketIcon from "@/components/MarketIcon";
import { useAssetIcons } from "@/lib/useAssetIcons";
import CurrencySelect from "@/components/CurrencySelect";
import { useDisplayCurrency, type CurrencyCode } from "@/lib/currencyPrefs";
import { IconChartHistogram, IconMap2 } from "@tabler/icons-react";

interface TopAsset {
  market: string;
  code: string;
  name: string;
  marketCap: number;
  price: number | null;
  changePct: number | null;
  logo: string;
  type?: "stock" | "crypto" | "metal";
  rankChange?: number | null;
}

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
const klineCache = new Map<string, number[]>();
const TOP_CACHE_KEY = "fire:topstocks:cache";
const RANK_CACHE_KEY = "fire:topstocks:rank";
const klineCacheKey = (code: string) => `fire:kline:${code}`;

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function loadDailyRank(): { date: string; rank: Record<string, number> } | null {
  try {
    const raw = localStorage.getItem(RANK_CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { date?: unknown; rank?: unknown };
      if (parsed && typeof parsed.date === "string" && parsed.rank && typeof parsed.rank === "object") {
        return { date: parsed.date, rank: parsed.rank as Record<string, number> };
      }
    }
  } catch {
    /* 忽略 */
  }
  return null;
}

function saveDailyRank(date: string, rank: Record<string, number>) {
  try {
    localStorage.setItem(RANK_CACHE_KEY, JSON.stringify({ date, rank }));
  } catch {
    /* 忽略 */
  }
}

const MiniKline = memo(function MiniKline({ item }: { item: TopAsset }) {
  const [points, setPoints] = useState<number[] | null>(() => {
    if (typeof window === "undefined") return klineCache.get(item.code) ?? null;
    try {
      const raw = localStorage.getItem(klineCacheKey(item.code));
      if (raw) {
        const arr = JSON.parse(raw) as number[];
        if (Array.isArray(arr) && arr.length > 1) {
          klineCache.set(item.code, arr);
          return arr;
        }
      }
    } catch {
      /* 忽略 */
    }
    return klineCache.get(item.code) ?? null;
  });
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
    if (item.type === "crypto" || item.type === "metal") return;
    if (item.market !== "US" && item.market !== "CN") return;
    let cancelled = false;
    fetch(`/api/kline?market=${encodeURIComponent(item.market)}&code=${encodeURIComponent(item.code)}`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        const closes: number[] = Array.isArray(data?.closes) ? data.closes : [];
        if (closes.length > 1) {
          klineCache.set(item.code, closes);
          try {
            localStorage.setItem(klineCacheKey(item.code), JSON.stringify(closes));
          } catch {
            /* 忽略 */
          }
          setPoints(closes);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [item, points, inView]);

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
    <svg viewBox={`0 0 ${W} ${H}`} className="inline-block h-[22px] w-[60px] flex-none" aria-label="近30日走势">
      <polyline points={coords} fill="none" stroke={up ? "#e23d3d" : "#0fa07b"} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
});

// ---------- Logo（素材库优先，404 自动回退首字母） ----------
function AssetLogo({ item, custom }: { item: TopAsset; custom?: string }) {
  const [err, setErr] = useState(false);
  const src = custom || item.logo;
  if (!src || err) {
    return (
      <span className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-brand-light text-xs font-bold text-brand-deep">
        {zhName(item).slice(0, 1)}
      </span>
    );
  }
  return <img src={src} alt="" loading="lazy" onError={() => setErr(true)} className="h-8 w-8 flex-none rounded-full object-cover" />;
}

function EmptyMarketIcon() {
  return (
    <span
      className="inline-flex h-[18px] w-[18px] flex-none items-center justify-center text-[13px] leading-none text-faint"
      title="无所属市场"
      aria-label="无所属市场"
    >
      −
    </span>
  );
}

const GlobalEconomyHeatmap = dynamic(() => import("@/components/GlobalEconomyHeatmap"), {
  ssr: false,
  loading: () => <div className="h-[520px] animate-pulse rounded-card bg-bg-gray dark:bg-white/[.04]" />
});

function AssetMarketCapRanking({ pageSize }: { pageSize?: number }) {
  const { stockIcons, assetIcons } = useAssetIcons(["stock", "crypto", "metal", "icon"]);
  const [items, setItems] = useState<TopAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [page, setPage] = useState(1);
  const { currency, rate, symbol } = useDisplayCurrency();

  useEffect(() => {
    let cancelled = false;
    // 先用本地缓存秒出列表，再后台拉取最新数据，避免每次加载空等
    try {
      const raw = localStorage.getItem(TOP_CACHE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as TopAsset[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          setItems(parsed);
          setLoading(false);
        }
      }
    } catch {
      /* 缓存无效忽略 */
    }
    fetch("/api/top-stocks?market=ALL")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled) return;
        if (data?.items) {
          // 排名对比基准每天只更新一次：同一天内多次刷新都对比当日基准，跨天时用昨日基准并刷新为新一天
          const today = todayStr();
          const daily = loadDailyRank();
          const baseline = daily ? daily.rank : null;
          const nextRank: Record<string, number> = {};
          const rankedItems: TopAsset[] = data.items.map((it: TopAsset, i: number) => {
            nextRank[it.code] = i + 1;
            const prev = baseline ? baseline[it.code] : undefined;
            return { ...it, rankChange: prev === undefined ? null : prev - (i + 1) };
          });
          if (!daily || daily.date !== today) {
            saveDailyRank(today, nextRank);
          }
          setItems(rankedItems);
          setErr("");
          try {
            localStorage.setItem(TOP_CACHE_KEY, JSON.stringify(rankedItems));
          } catch {
            /* 忽略 */
          }
        } else {
          setErr("获取全球市值排行失败，请稍后重试");
        }
      })
      .catch(() => !cancelled && setErr("网络异常，无法获取全球市值排行"))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  function customLogo(it: TopAsset): string | undefined {
    if (it.type === "crypto") return assetIcons[it.code.toUpperCase()] ?? assetIcons["BTC"];
    if (it.type === "metal") return assetIcons[it.code.toUpperCase()];
    return stockIcons[`${it.market.toUpperCase()}:${it.code.toUpperCase()}`];
  }

  // 首页内嵌时每页展示 pageSize 条
  const totalPages = pageSize ? Math.max(1, Math.ceil(items.length / pageSize)) : 1;
  const safePage = Math.min(page, totalPages);
  const displayItems = pageSize ? items.slice((safePage - 1) * pageSize, safePage * pageSize) : items;
  useEffect(() => {
    setPage(1);
  }, [pageSize]);

  return (
    <div className="flex flex-col gap-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2.5">
          <h2 className="min-w-0 text-lg font-bold">全球资产市值排行</h2>
          <CurrencySelect align="left" />
        </div>
        <p className="mt-0.5 text-xs text-muted">
          全球市值前 {items.length || 100} 名 · 数据来源 CompaniesMarketCap · 市值与价格有延迟
        </p>
      </div>

      {loading ? (
        <div className="space-y-2.5">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-[60px] animate-pulse rounded-[12px] bg-bg-gray" />
          ))}
        </div>
      ) : err ? (
        <p className="rounded-[14px] border border-dashed border-edge-strong py-12 text-center text-sm text-faint">{err}</p>
      ) : (
        <div className="overflow-hidden rounded-card border border-edge bg-white shadow-card">
          <div className="data-table-scroll">
            <table className="mobile-global-table w-full min-w-[800px] table-fixed text-sm">
              <colgroup>
                <col className="w-[54px]" /><col className="w-[184px]" /><col className="w-[112px]" /><col className="w-[104px]" /><col className="w-[116px]" /><col className="w-[158px]" /><col className="w-[72px]" />
              </colgroup>
              <thead>
                <tr className="whitespace-nowrap bg-bg-gray text-xs font-semibold text-muted">
                  <th className="px-3 py-3 text-center">排名</th>
                  <th className="px-3 py-3 text-left">资产</th>
                  <th className="px-3 py-3 text-right">现价</th>
                  <th className="min-w-[96px] px-5 py-3 text-center">涨跌幅</th>
                  <th className="px-4 py-3 text-center">月K</th>
                  <th className="min-w-[128px] px-5 py-3 text-center">市值</th>
                  <th className="px-4 py-3 text-center">市场</th>
                </tr>
              </thead>
              <tbody>
                {displayItems.map((it, i) => {
                  const up = (it.changePct ?? 0) >= 0;
                  const rankNo = (safePage - 1) * (pageSize || 100) + i + 1;
                  const rankColor = rankNo === 1 ? "#f5a623" : rankNo === 2 ? "#9aa3ad" : rankNo === 3 ? "#c8864a" : "#9298a1";
                  const rankSize = rankNo === 1 ? "text-[18px] font-bold" : rankNo === 2 ? "text-[15px] font-bold" : rankNo === 3 ? "text-[12px] font-semibold" : "text-[12px] font-semibold";
                  return (
                    <tr key={`${it.market}-${it.code}`} className="whitespace-nowrap border-t border-edge transition-colors hover:bg-[#fafbfc] dark:hover:bg-[#1a212e]">
                      <td className="px-3 py-3 text-center">
                        <span className={`inline-block w-[28px] text-center tabular-nums leading-none ${rankSize}`} style={{ color: rankColor }}>
                          {rankNo}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-left">
                        <div className="flex items-center justify-start gap-2.5">
                          <AssetLogo item={it} custom={customLogo(it)} />
                          <span className="min-w-0 max-w-[126px]">
                            <span className="block truncate font-semibold text-ink">{zhName(it)}</span>
                            <span className="block text-[11px] text-faint">{it.code}</span>
                          </span>
                        </div>
                      </td>
                      <td className="px-3 py-3 text-right font-medium tabular-nums text-ink-2">{it.price != null ? fmtPrice(it.price, rate, symbol, currency) : "—"}</td>
                      <td className={`px-4 py-3 text-center tabular-nums ${it.changePct == null ? "text-faint" : up ? "text-up" : "text-down"}`}>
                        {it.changePct == null ? "—" : `${up ? "+" : ""}${fmtPct(it.changePct / 100)}`}
                      </td>
                      <td className="px-3 py-3 text-center">
                        <MiniKline item={it} />
                      </td>
                      <td className="px-4 py-3 text-center">
                        <div className="flex items-center justify-center gap-1.5">
                          <span className="font-semibold tabular-nums text-ink">{fmtMoney(it.marketCap, rate, symbol, currency)}</span>
                          {it.rankChange != null && (
                            <span
                              title={it.rankChange > 0 ? `较上次上升 ${it.rankChange} 位` : it.rankChange < 0 ? `较上次下降 ${Math.abs(it.rankChange)} 位` : "排名无变化"}
                              className={`inline-flex flex-none items-center gap-0.5 rounded-[5px] px-1 py-px text-[10px] font-bold leading-none ${
                                it.rankChange > 0 ? "bg-up-bg text-up" : it.rankChange < 0 ? "bg-down-bg text-down" : "bg-bg-gray text-faint"
                              }`}
                            >
                              {it.rankChange > 0 ? "↑" : it.rankChange < 0 ? "↓" : "—"}
                              {it.rankChange !== 0 && Math.abs(it.rankChange)}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span className="inline-flex h-[18px] w-[18px] items-center justify-center align-middle">
                          {it.type === "crypto" ? (
                            (assetIcons[it.code.toUpperCase()] ?? assetIcons["BTC"]) ? (
                              <img src={assetIcons[it.code.toUpperCase()] ?? assetIcons["BTC"]} alt="" title="加密货币" className="block h-[18px] w-[18px] rounded-full object-cover" />
                            ) : (
                              <span className="inline-flex h-[18px] w-[18px] items-center justify-center rounded-full bg-[#f7931a] text-[10px] font-bold text-white" title="加密货币">
                                ₿
                              </span>
                            )
                          ) : it.type === "metal" || !/^[A-Z]{2}$/.test(it.market.trim().toUpperCase()) ? (
                            <EmptyMarketIcon />
                          ) : (
                            <MarketIcon market={it.market} size={18} />
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
        <div className="flex items-center justify-center gap-2">
          <button
            type="button"
            disabled={safePage <= 1}
            onClick={() => setPage(safePage - 1)}
            className="rounded-full border border-edge px-3.5 py-1.5 text-xs font-semibold text-ink-2 transition-colors hover:bg-brand-hover hover:text-ink disabled:opacity-40 dark:border-[#3b4354] dark:text-[#e7ebf1] dark:hover:bg-white/5"
          >
            上一页
          </button>
          <span className="text-xs text-muted">第 {safePage} / {totalPages} 页</span>
          <button
            type="button"
            disabled={safePage >= totalPages}
            onClick={() => setPage(safePage + 1)}
            className="rounded-full border border-edge px-3.5 py-1.5 text-xs font-semibold text-ink-2 transition-colors hover:bg-brand-hover hover:text-ink disabled:opacity-40 dark:border-[#3b4354] dark:text-[#e7ebf1] dark:hover:bg-white/5"
          >
            下一页
          </button>
        </div>
      )}
    </div>
  );
}

type GlobalSection = "assets" | "heatmap";

function SectionIcon({ section }: { section: GlobalSection }) {
  const Icon = section === "assets" ? IconChartHistogram : IconMap2;
  return <Icon className="global-section-icon" size={18} stroke={1.65} aria-hidden="true" />;
}

export default function GlobalPreviewView({ pageSize }: { pageSize?: number }) {
  const [section, setSection] = useState<GlobalSection>(() => {
    if (typeof window === "undefined" || pageSize) return "assets";
    return new URLSearchParams(window.location.search).get("section") === "heatmap" ? "heatmap" : "assets";
  });

  useEffect(() => {
    if (pageSize) return;
    const params = new URLSearchParams(window.location.search);
    params.set("section", section);
    window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
  }, [pageSize, section]);

  if (pageSize) return <AssetMarketCapRanking pageSize={pageSize} />;

  return (
    <div className="global-economy-page flex flex-col gap-6">
      <nav className="global-section-nav" aria-label="全球经济功能">
        {([
          ["assets", "市值排行", "全球主要资产的市值、价格与走势"],
          ["heatmap", "经济热图", "按国家比较关键宏观经济指标"]
        ] as [GlobalSection, string, string][]).map(([key, label, description]) => (
          <button
            key={key}
            type="button"
            onClick={() => setSection(key)}
            title={label}
            aria-label={label}
            aria-current={section === key ? "page" : undefined}
            className={`global-section-button ${section === key ? "is-active" : ""}`}
          >
            <SectionIcon section={key} />
            <span>{label}</span>
            <span className="sr-only">：{description}</span>
          </button>
        ))}
      </nav>
      <div key={section} className="global-section-panel">
        {section === "assets" ? <AssetMarketCapRanking /> : <GlobalEconomyHeatmap />}
      </div>
    </div>
  );
}
