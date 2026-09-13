"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { marketMeta, type HomeNavItem, type SearchMatch, type SiteSettings, type User } from "@/lib/types";
import UserMenu from "@/components/UserMenu";
import IndexTicker from "@/components/IndexTicker";
import StockSearch from "@/components/StockSearch";
import MarketIcon from "@/components/MarketIcon";
import { primeFlagIconCache, primeMarketIconCache, primeStockIconCache, useAssetIcons } from "@/lib/useAssetIcons";
import { showToast } from "@/lib/toast";
import { setThemeCookie } from "@/lib/theme";
import { logoFontClass } from "@/lib/logoFont";
import { fmtMoneyAdaptive } from "@/lib/format";
import MiniTrendChart from "@/components/MiniTrendChart";

interface Dict {
  navPreview: string;
  navFeatures: string;
  navRecords: string;
  searchPh: string;
  chips: [string, string, string, string];
  addStock: string;
  tableHead: [string, string, string, string, string];
  sidebar: string[];
  f1Title: string;
  f1Desc: string;
  f2Title: string;
  f2Desc: string;
  f3Title: string;
  f3Desc: string;
  footerDesc: string;
  col1: string;
  col2: string;
  col3: string;
  col1Links: string[];
  col2Links: string[];
  col3Links: string[];
  copyright: string;
  serverNote: string;
  login: string;
  start: string;
}

const DICT: Dict = {
  navPreview: "产品预览",
    navFeatures: "功能介绍",
    navRecords: "自选记录",
    searchPh: "搜索股票代码或名称",
    chips: ["全部", "港股", "美股", "A股"],
    addStock: "＋ 添加自选",
    tableHead: ["股票", "现价", "涨跌幅", "近5日走势", "持仓盈亏"],
    sidebar: ["自选股", "持仓", "日志", "行情", "设置"],
    f1Title: "盈亏一目了然",
    f1Desc: "按现价自动计算每只股票与整体组合的市值、盈亏和盈亏率。",
    f2Title: "多市场支持",
    f2Desc: "港股、美股、A股都可以记录，自动区分币种，互不混淆。",
    f3Title: "数据保存在服务端",
    f3Desc: "记录通过后端 API 保存到 SQLite，刷新、换设备都能读到。",
    footerDesc: "一个轻量、免费的股票记录网站，帮你管理自选与持仓。",
    col1: "功能",
    col2: "支持",
    col3: "关于",
    col1Links: ["自选记录", "持仓汇总", "盈亏统计"],
    col2Links: ["使用指南", "常见问题", "数据导出"],
    col3Links: ["关于 Fire", "隐私说明", "免责声明"],
    copyright: "© 2026 Fire · 记录仅供参考，不构成任何投资建议",
    serverNote: "数据保存在服务端 SQLite",
    login: "登录",
    start: "仪表盘"
};

function Logo({ logo, text, font, small = false }: { logo?: string; text?: string; font?: string; small?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      {logo ? (
        <img src={logo} alt="logo" className={small ? "h-5 w-auto" : "h-7 w-auto"} />
      ) : (
        <span className={`inline-flex items-center justify-center bg-white text-ink-2 border border-edge-strong shadow-sm ${small ? "h-[26px] w-[26px] rounded-lg" : "h-[34px] w-[34px] rounded-[10px]"}`}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
            <path d="M3 17l5-6 4 3 6-8" />
            <path d="M15 6h3v3" />
          </svg>
        </span>
      )}
      {text && <span className={`text-[19px] tracking-[0.2px] text-ink ${logoFontClass(font)}`}>{text}</span>}
    </span>
  );
}

function Sparkline({ up }: { up: boolean }) {
  const points = up ? [10, 10.4, 10.1, 10.8, 10.5, 11.2, 10.9, 11.6, 11.5] : [11.5, 11.1, 11.6, 10.9, 11.1, 10.5, 10.8, 10.1, 10.3];
  return <MiniTrendChart points={points} baseline={points[0]} width={90} height={26} className="h-[26px] w-full" />;
}

const PREVIEW_ROWS = [
  { name: "腾讯控股", code: "00700 · HK", price: "HK$428.00", change: "+2.64%", up: true, profit: "+9,600" },
  { name: "阿里巴巴", code: "09988 · HK", price: "HK$92.50", change: "-3.17%", up: false, profit: "-6,250" },
  { name: "Apple", code: "AAPL · US", price: "$228.68", change: "+0.91%", up: true, profit: "+1,934" },
  { name: "NVIDIA", code: "NVDA · US", price: "$171.40", change: "+4.83%", up: true, profit: "+5,140" }
];

// 预览卡片筛选标签：全部 + 默认 3 个市场（美股 / 港股 / A股），自定义市场来自后端设置
const DEFAULT_PREVIEW_MARKETS = ["US", "HK", "CN"];

// 预览卡片视图：自选股 / 我的持仓 / 财报日历 / 全球预览 / 设置（设置在前端展示快捷入口，避免闪现后台）
type PreviewView = "自选股" | "我的持仓" | "财报日历" | "全球预览" | "设置";
const PREVIEW_VIEWS: PreviewView[] = ["自选股", "我的持仓", "财报日历", "全球预览", "设置"];
// 前端视图 → URL 参数：刷新 / 分享时保持当前视图
const VIEW_PARAM: Record<PreviewView, string> = {
  自选股: "watchlist",
  我的持仓: "holdings",
  财报日历: "earnings",
  全球预览: "global",
  设置: "settings"
};
const VIEW_FROM_PARAM: Record<string, PreviewView> = Object.fromEntries(
  Object.entries(VIEW_PARAM).map(([k, v]) => [v, k as PreviewView])
);
// 访客自选：未登录时保存到浏览器本地
const GUEST_KEY = "fire:home:guest";

// 每页展示条数（与后端模块一致）
const PREVIEW_PAGE_SIZE = 6;

// 真实迷你走势（登录后展示后端同步数据）
interface LiveRow {
  id: string;
  name: string;
  sub: string;
  market: string;
  qty: number;
  cost: number;
  price: number;
  changePct: number | null;
  prevClose: number | null;
  profit: number | null;
}

function fmtLivePrice(v: number): string {
  return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtLiveProfit(v: number, market: string): string {
  const currency = marketMeta(market).currency || "";
  const body = fmtMoneyAdaptive(Math.abs(v), currency, 1e7);
  return `${v >= 0 ? "+" : "-"}${body}`;
}

// 股票图标：素材库优先（唯一标识 市场:代码），无图标时回退首字母头像
function Fireo({ market, code, name }: { market: string; code: string; name: string }) {
  const { stockIcons } = useAssetIcons(["stock"]);
  const [err, setErr] = useState(false);
  const src = stockIcons[`${market.toUpperCase()}:${code.toUpperCase()}`];
  if (src && !err) {
    return (
      <img
        src={src}
        alt=""
        loading="lazy"
        onError={() => setErr(true)}
        className="h-6 w-6 flex-none rounded-full object-cover"
      />
    );
  }
  return (
    <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-brand-light text-[11px] font-bold text-brand-deep">
      {name.slice(0, 1)}
    </span>
  );
}

const CHIP_ORDER_KEY = "fire:home:chips-order";

const GlobalPreviewView = dynamic(() => import("@/components/views/GlobalPreviewView"), {
  ssr: false,
  loading: () => <div className="h-64 animate-pulse rounded-card bg-bg-gray dark:bg-white/[.04]" />
});
const EarningsCalendarView = dynamic(() => import("@/components/views/EarningsCalendarView"), {
  ssr: false,
  loading: () => <div className="h-64 animate-pulse rounded-card bg-bg-gray dark:bg-white/[.04]" />
});

const NAV_FALLBACK: Record<string, { label: string; href: string }> = {
  preview: { label: "产品预览", href: "#preview" },
  records: { label: "自选记录", href: "/records" }
};

export default function HomeContent({ settings, initialDark = false, initialUser = null, initialStockIcons = {}, initialMarketIcons = {}, initialFlagIcons = {} }: { settings: SiteSettings; initialDark?: boolean; initialUser?: User | null; initialStockIcons?: Record<string, string>; initialMarketIcons?: Record<string, string>; initialFlagIcons?: Record<string, string> }) {
  primeStockIconCache(initialStockIcons);
  primeMarketIconCache(initialMarketIcons);
  primeFlagIconCache(initialFlagIcons);
  // SSR 阶段直接使用服务端主题（Cookie），避免刷新时 hero 遮罩先按浅色渲染造成大片白色
  const [dark, setDark] = useState(initialDark);
  const [themeReady, setThemeReady] = useState(false);
  const [auth, setAuth] = useState<"in" | "out">(initialUser ? "in" : "out");
  const [liveBg, setLiveBg] = useState(settings.homepageBg);
  const [liveDomain, setLiveDomain] = useState(settings.domain);
  const [liveLogo, setLiveLogo] = useState(settings.siteLogo);
  const [liveLogoText, setLiveLogoText] = useState(settings.logoText);
  const [liveLogoFont, setLiveLogoFont] = useState(settings.logoFont);
  const [liveFooterDesc, setLiveFooterDesc] = useState(settings.footerDesc);
  const [liveNav, setLiveNav] = useState<HomeNavItem[]>(settings.homeNav ?? []);
  // 预览卡片：登录后展示后端真实数据（与自选股 / 持仓 / 行情模块一致），未登录展示静态示例
  const [view, setView] = useState<PreviewView>("自选股");
  useEffect(() => {
    const p = new URLSearchParams(window.location.search).get("view");
    if (p && VIEW_FROM_PARAM[p]) setView(VIEW_FROM_PARAM[p]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const changeView = (v: PreviewView) => {
    setView(v);
    const sp = new URLSearchParams(window.location.search);
    const p = VIEW_PARAM[v];
    if (p) sp.set("view", p);
    else sp.delete("view");
    window.history.replaceState(null, "", `?${sp.toString()}`);
  };
  const changeChip = (c: string) => {
    setChip(c);
    const sp = new URLSearchParams(window.location.search);
    if (c === "ALL") sp.delete("market");
    else sp.set("market", c);
    window.history.replaceState(null, "", `?${sp.toString()}`);
  };
  // 刷新 / 前进后退保持视图与市场筛选
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const p = sp.get("view");
    if (p && VIEW_FROM_PARAM[p]) setView(VIEW_FROM_PARAM[p]);
    const m = sp.get("market")?.toUpperCase();
    if (m && m !== "ALL") setChip(m);
    function sync() {
      const sp2 = new URLSearchParams(window.location.search);
      const v = sp2.get("view");
      if (v && VIEW_FROM_PARAM[v]) setView(VIEW_FROM_PARAM[v]);
      const mk = sp2.get("market")?.toUpperCase();
      if (mk && mk !== "ALL") setChip(mk);
      else if (!mk) setChip("ALL");
    }
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // 市场配置：来自后端设置（自定义市场），默认 美股 / 港股 / A股
  const [marketsCfg, setMarketsCfg] = useState<{
    markets: string[];
    labels: { key: string; label: string; flag: string }[];
  }>(() => ({
    markets: Array.isArray(settings.markets) && settings.markets.length > 0 ? settings.markets : DEFAULT_PREVIEW_MARKETS,
    labels: settings.marketLabels ?? []
  }));
  const chipMarkets = useMemo(() => {
    const seen = new Set<string>();
    const list: string[] = [];
    marketsCfg.markets.forEach((k) => {
      if (k && !seen.has(k)) {
        seen.add(k);
        list.push(k);
      }
    });
    DEFAULT_PREVIEW_MARKETS.forEach((k) => {
      if (!seen.has(k)) {
        seen.add(k);
        list.push(k);
      }
    });
    return list;
  }, [marketsCfg.markets]);
  const chipLabel = (k: string) => k === "US" ? "美股" : marketsCfg.labels.find((l) => l.key === k)?.label || marketMeta(k).label;
  const chipFlag = (k: string) => marketsCfg.labels.find((l) => l.key === k)?.flag || "";
  // 筛选：ALL = 全部，其余为市场代码
  const [chip, setChip] = useState<string>("ALL");
  useEffect(() => {
    const m = new URLSearchParams(window.location.search).get("market")?.toUpperCase();
    if (m && m !== "ALL") setChip(m);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // 初始值统一用默认（服务端 / 客户端首帧一致，避免 hydration 不匹配），
  // 已保存的拖动顺序在挂载后的客户端副作用里恢复
  const [chipOrder, setChipOrder] = useState<string[]>(() => ["ALL", ...chipMarkets]);
  useEffect(() => {
    try {
      const saved = localStorage.getItem(CHIP_ORDER_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as string[];
        const valid = ["ALL", ...chipMarkets];
        if (Array.isArray(parsed) && parsed.length === valid.length && parsed.every((c) => valid.includes(c))) {
          setChipOrder(parsed);
        }
      }
    } catch {
      /* 忽略 */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const chipDragIndex = useRef<number | null>(null);
  // 展示顺序：保存的拖动顺序优先，新增市场自动追加到末尾
  const orderedChips = useMemo(() => {
    const base = ["ALL", ...chipMarkets];
    const valid = chipOrder.filter((k) => base.includes(k));
    const rest = base.filter((k) => !valid.includes(k));
    return [...valid, ...rest];
  }, [chipMarkets, chipOrder]);
  const [marketEditor, setMarketEditor] = useState(false);
  const [newMarket, setNewMarket] = useState({ key: "", label: "" });
  const [pages, setPages] = useState<Record<string, number>>({});
  const [previewSort, setPreviewSort] = useState<{ key: "name" | "price" | "change" | "profit"; dir: "asc" | "desc" } | null>(null);
  const [liveRows, setLiveRows] = useState<LiveRow[] | null>(null);
  const [liveCharts, setLiveCharts] = useState<Record<string, number[]>>({});
  const [staleCharts, setStaleCharts] = useState<Record<string, boolean>>({});

  function dropChip(to: number) {
    if (chipDragIndex.current === null) return;
    const from = chipDragIndex.current;
    chipDragIndex.current = null;
    if (from === to) return;
    setChipOrder((prev) => {
      const next = [...prev];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      try {
        localStorage.setItem(CHIP_ORDER_KEY, JSON.stringify(next));
      } catch {
        /* 忽略 */
      }
      return next;
    });
  }

  // 新增市场：同步到后端设置（与我的资产市场编辑一致）
  async function addMarket() {
    const key = newMarket.key.trim().toUpperCase();
    const label = newMarket.label.trim();
    if (!key || !label) {
      showToast("请填写市场代码和名称", "err");
      return;
    }
    if (chipMarkets.includes(key)) {
      showToast("该市场已存在", "err");
      return;
    }
    try {
      const nextMarkets = [...marketsCfg.markets, key];
      const nextLabels = [...marketsCfg.labels.filter((l) => l.key !== key), { key, label, flag: "" }];
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markets: nextMarkets, marketLabels: nextLabels })
      });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        throw new Error(d?.error || "保存失败");
      }
      setMarketsCfg({ markets: nextMarkets, labels: nextLabels });
      setNewMarket({ key: "", label: "" });
      setMarketEditor(false);
      showToast(`已新增市场 ${key} ${label}`);
      window.dispatchEvent(new Event("fire:settings-updated"));
    } catch (err) {
      showToast(err instanceof Error ? err.message : "添加失败", "err");
    }
  }

  const loadLive = useCallback(async () => {
    try {
      // 数据源：登录 → 后端记录；未登录 → 本地访客自选
      let all: { id: string; name: string; code: string; market: string; price: number; cost?: number | ""; qty?: number | "" }[] = [];
      if (auth === "in") {
        // 首次失败自动重试一次（开发模式首请求可能较慢），仍失败则走 catch 保留旧数据
        let recsRes: Response | null = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          recsRes = await fetch("/api/records").catch(() => null);
          if (recsRes?.ok) break;
          if (attempt === 0) await new Promise((r) => setTimeout(r, 600));
        }
        if (!recsRes?.ok) throw new Error("获取记录失败");
        const recs = await recsRes.json();
        all = Array.isArray(recs) ? recs : [];
      } else {
        try {
          const raw = localStorage.getItem(GUEST_KEY);
          const parsed = raw ? JSON.parse(raw) : [];
          if (Array.isArray(parsed)) all = parsed;
        } catch {
          /* 忽略 */
        }
      }
      const items = all.map((r: { id: string; market: string; code: string }) => ({
        id: r.id,
        market: r.market,
        code: r.code
      }));
      // 行情接口单次最多 100 只。首页不能把全部记录一次提交，否则第 101 只开始会
      // 让整批现价 / 涨跌幅 / 走势一起消失；按 80 只分批并合并，单批失败也保留其余结果。
      const fetchBatched = async (path: "/api/quotes" | "/api/charts", field: "quotes" | "charts") => {
        const merged: Record<string, unknown> = {};
        for (let start = 0; start < items.length; start += 80) {
          const response = await fetch(path, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ items: items.slice(start, start + 80), sample: true })
          }).catch(() => null);
          if (!response?.ok) continue;
          const payload = await response.json().catch(() => null);
          if (payload?.[field] && typeof payload[field] === "object") Object.assign(merged, payload[field]);
        }
        return merged;
      };
      const [quotes, charts] = await Promise.all([
        fetchBatched("/api/quotes", "quotes"),
        fetchBatched("/api/charts", "charts")
      ]);
      const rows: LiveRow[] = all.map((r) => {
        const q = quotes[r.id] as { price?: number; changePct?: number; prevClose?: number } | undefined;
        const price = q?.price ?? Number(r.price);
        const cost = Number(r.cost) || 0;
        const qty = Number(r.qty) || 0;
        return {
          id: r.id,
          name: r.name,
          sub: `${r.code} · ${marketMeta(r.market).label}`,
          market: r.market,
          qty,
          cost,
          price,
          changePct: q?.changePct ?? null,
          prevClose: q?.prevClose ?? null,
          profit: cost && qty ? (price - cost) * qty : null
        };
      });
      setLiveRows(rows);
      const pointsMap: Record<string, number[]> = {};
      Object.entries(charts).forEach(([id, ch]) => {
        if (ch && Array.isArray((ch as { points?: unknown[] }).points)) {
          const pts = (ch as { points: { price?: number }[] }).points
            .map((p) => Number(p?.price))
            .filter((n) => Number.isFinite(n) && n > 0);
          if (pts.length > 0) pointsMap[id] = pts;
        }
      });
      setLiveCharts((previous) => {
        const next = { ...previous, ...pointsMap };
        try { localStorage.setItem("fire:home:live", JSON.stringify({ rows, charts: next, at: Date.now() })); } catch { /* 缓存写入失败忽略 */ }
        return next;
      });
      setStaleCharts((previous) => {
        const next = { ...previous };
        items.forEach((item) => { next[item.id] = !pointsMap[item.id] || Boolean((charts[item.id] as { stale?: boolean } | undefined)?.stale); });
        return next;
      });
    } catch {
      // 加载失败保留上一次数据（缓存 / 旧记录），避免误显示「暂无相关股票」空态
      setStaleCharts((previous) => Object.fromEntries(Object.keys(previous).map((id) => [id, true])));
    }
  }, [auth]);

  // 挂载即应用缓存（绘制前）：刷新时 auth 检查完成前先用缓存渲染，避免闪现「数据加载中」
  useLayoutEffect(() => {
    try {
      const raw = localStorage.getItem("fire:home:live");
      if (raw) {
        const parsed = JSON.parse(raw) as { rows?: LiveRow[]; charts?: Record<string, number[]> };
        if (Array.isArray(parsed?.rows)) {
          setLiveRows(parsed.rows);
          if (parsed.charts) {
            setLiveCharts(parsed.charts);
            setStaleCharts(Object.fromEntries(Object.keys(parsed.charts).map((id) => [id, true])));
          }
        }
      }
    } catch {
      /* 缓存无效忽略 */
    }
  }, []);

  useEffect(() => {
    if (auth === "in") {
      try {
        const raw = localStorage.getItem("fire:home:live");
        if (raw) {
          const parsed = JSON.parse(raw) as { rows?: LiveRow[]; charts?: Record<string, number[]> };
          if (Array.isArray(parsed?.rows)) {
            setLiveRows(parsed.rows);
            if (parsed.charts) {
              setLiveCharts(parsed.charts);
              setStaleCharts(Object.fromEntries(Object.keys(parsed.charts).map((id) => [id, true])));
            }
          }
        }
      } catch {
        /* 缓存无效忽略 */
      }
    } else {
      setLiveRows(null);
      setLiveCharts({});
    }
    void loadLive();
    window.addEventListener("fire:records-updated", loadLive);
    return () => window.removeEventListener("fire:records-updated", loadLive);
  }, [auth, loadLive]);

  // 前端直接添加自选：同步到后端 /api/records
  async function handleAdd(m: SearchMatch) {
    if (auth !== "in") {
      // 访客：保存到本地浏览器（登录后可在后台合并）
      try {
        const raw = localStorage.getItem(GUEST_KEY);
        const list: { id: string; name: string; code: string; market: string; price: number; cost: ""; qty: "" }[] = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(list)) return;
        if (list.some((g) => g.code.toUpperCase() === m.code.toUpperCase() && g.market === m.market)) {
          showToast(`${m.name} 已在本地自选`);
          return;
        }
        list.push({ id: `guest-${Date.now()}`, name: m.name, code: m.code, market: m.market, price: m.price ?? 0, cost: "", qty: "" });
        localStorage.setItem(GUEST_KEY, JSON.stringify(list));
        showToast(`已添加 ${m.name} 到本地自选`);
        changeChip("ALL");
        loadLive();
      } catch {
        showToast("添加失败", "err");
      }
      return;
    }
    try {
      const res = await fetch("/api/records", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: m.name,
          code: m.code,
          market: m.market,
          price: m.price ?? "",
          cost: "",
          qty: "",
          group: "",
          note: "首页添加"
        })
      });
      if (res.status === 401) {
        window.dispatchEvent(new Event("fire:open-login"));
        return;
      }
      if (!res.ok) throw new Error("添加失败");
      showToast(`已添加 ${m.name} 到自选`);
      changeChip("ALL");
      loadLive();
      window.dispatchEvent(new Event("fire:records-updated"));
    } catch {
      showToast("添加失败，请稍后再试", "err");
    }
  }

  useEffect(() => {
    try {
      const saved = localStorage.getItem("fire.theme");
      setDark(saved === "dark");
    } catch { /* ignore */ }
    setThemeReady(true);
  }, []);

  useEffect(() => {
    if (!themeReady) return;
    document.documentElement.classList.toggle("dark", dark);
    try {
      localStorage.setItem("fire.theme", dark ? "dark" : "light");
    } catch { /* ignore */ }
    setThemeCookie(dark);
  }, [dark, themeReady]);

  function checkLogin() {
    fetch("/api/auth/me", { cache: "no-store", credentials: "same-origin" })
      .then((res) => {
        if (res.ok) setAuth("in");
        else if (res.status === 401) setAuth("out");
      })
      .catch(() => {});
  }

  useEffect(() => {
    checkLogin();
    const onUserUpdated = () => setAuth("in");
    window.addEventListener("focus", checkLogin);
    window.addEventListener("fire:user-updated", onUserUpdated);
    return () => {
      window.removeEventListener("focus", checkLogin);
      window.removeEventListener("fire:user-updated", onUserUpdated);
    };
  }, []);

  useEffect(() => {
    function apply() {
      fetch("/api/settings/public")
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          const s = data?.settings;
          if (!s) return;
          if (s.title) document.title = s.title;
          if (s.homepageBg) setLiveBg(s.homepageBg);
          if (s.domain) setLiveDomain(s.domain);
          setLiveLogo(s.siteLogo ?? "");
          setLiveLogoText(s.logoText ?? "");
          setLiveLogoFont(s.logoFont ?? "diatype");
          if (s.footerDesc) setLiveFooterDesc(s.footerDesc);
          if (Array.isArray(s.homeNav)) setLiveNav(s.homeNav);
        })
        .catch(() => {});
    }
    apply();
    window.addEventListener("fire:settings-updated", apply);
    return () => window.removeEventListener("fire:settings-updated", apply);
  }, []);

  const t = DICT;
  const overlay = dark ? "rgba(10,14,25,.76)" : "rgba(255,255,255,.84)";
  const navItems = (liveNav.length > 0 ? liveNav : [
    { key: "preview", label: "", href: "#preview", enabled: true }
  ])
    .filter((i) => i.enabled !== false)
    .map((i) => ({
      label: i.label || NAV_FALLBACK[i.key]?.label || i.key,
      href: i.href || NAV_FALLBACK[i.key]?.href || "#"
    }));

  // 预览表格行：登录后使用后端真实数据（现价 / 涨跌幅 / 盈亏与模块一致），未登录展示静态示例
  const filterM = chip === "ALL" ? "" : chip;
  // 股票视图（自选股 / 我的持仓）数据：自选股 = 全部记录；我的持仓 = 有数量的记录（才有持仓盈亏）
  const showStockToolbar = view === "自选股" || view === "我的持仓";
  const viewPool = (() => {
    if (liveRows === null) return null;
    if (view === "我的持仓") return liveRows.filter((r) => r.qty > 0);
    return liveRows;
  })();
  const filteredRows = (viewPool === null ? [] : viewPool)
    .filter((r) => !filterM || r.market === filterM);
  const sortedRows = previewSort
    ? [...filteredRows].sort((a, b) => {
        let av: string | number = "";
        let bv: string | number = "";
        if (previewSort.key === "name") {
          av = a.name;
          bv = b.name;
        } else if (previewSort.key === "price") {
          av = a.price;
          bv = b.price;
        } else if (previewSort.key === "change") {
          av = a.changePct ?? Number.NEGATIVE_INFINITY;
          bv = b.changePct ?? Number.NEGATIVE_INFINITY;
        } else {
          av = a.profit ?? Number.NEGATIVE_INFINITY;
          bv = b.profit ?? Number.NEGATIVE_INFINITY;
        }
        const result = typeof av === "string" && typeof bv === "string"
          ? av.localeCompare(bv, "zh-CN")
          : Number(av) - Number(bv);
        return previewSort.dir === "asc" ? result : -result;
      })
    : filteredRows;
  const pageKey = `${view}:${chip}`;
  const totalPages = Math.max(1, Math.ceil(sortedRows.length / PREVIEW_PAGE_SIZE));
  const safePage = Math.min(pages[pageKey] ?? 1, totalPages);
  const pageRows = sortedRows.slice((safePage - 1) * PREVIEW_PAGE_SIZE, safePage * PREVIEW_PAGE_SIZE);
  const staticRows = PREVIEW_ROWS
    .filter((row) => {
      if (!filterM) return true;
      if (filterM === "HK") return row.code.endsWith("HK");
      if (filterM === "US") return row.code.endsWith("US");
      return false;
    })
    .map((row) => ({
      key: row.code,
      name: row.name,
      sub: row.code,
      market: row.code.endsWith("HK") ? "HK" : "US",
      code: row.code.split(" · ")[0],
      price: row.price,
      change: row.change,
      up: row.up,
      spark: [] as number[],
      sparkStale: false,
      baseline: null as number | null,
      profit: row.profit,
      profitUp: row.profit.startsWith("+"),
      live: false
    }));
  const isLive = viewPool !== null;
  const showRows = isLive
    ? pageRows.map((r) => ({
        key: r.id,
        name: r.name,
        sub: r.sub,
        market: r.market,
        code: r.sub.split(" · ")[0],
        price: `${marketMeta(r.market).currency}${fmtLivePrice(r.price)}`,
        change: r.changePct == null ? "--" : `${r.changePct >= 0 ? "+" : ""}${r.changePct.toFixed(2)}%`,
        up: (r.changePct ?? 0) >= 0,
        spark: liveCharts[r.id] ?? [],
        sparkStale: staleCharts[r.id] ?? true,
        baseline: r.prevClose,
        profit: r.profit == null ? "—" : fmtLiveProfit(r.profit, r.market),
        profitUp: (r.profit ?? 0) >= 0,
        live: true
      }))
    : staticRows;
  const togglePreviewSort = (key: "name" | "price" | "change" | "profit") => {
    setPreviewSort((current) => {
      if (!current || current.key !== key) return { key, dir: "desc" };
      if (current.dir === "desc") return { key, dir: "asc" };
      return null;
    });
  };
  const profitColumn = view === "我的持仓";
  // 表格网格：序号 36px、走势列固定 80px，避免过长
  const gridCls = profitColumn
    ? "grid-cols-[36px_1.5fr_.8fr_.8fr_80px_1fr]"
    : "grid-cols-[36px_1.5fr_.8fr_.8fr_80px]";
  const headerCells = profitColumn
    ? ["序号", "股票", "现价", "涨跌幅", "近5日走势", "持仓盈亏"]
    : ["序号", "股票", "现价", "涨跌幅", "近5日走势"];
  const headerSortKeys: Array<"name" | "price" | "change" | "profit" | null> = profitColumn
    ? [null, "name", "price", "change", null, "profit"]
    : [null, "name", "price", "change", null];

  return (
    <>
      {/* 顶部导航 */}
      <header className="home-header site-header sticky top-0 z-50 h-[72px] border-b border-edge/80">
        <div className="home-header-inner mx-auto flex h-full max-w-[1140px] items-center gap-4 px-6">
          <a href="#" className="flex-none hover:opacity-90"><Logo logo={liveLogo} text={liveLogoText} font={liveLogoFont} /></a>
          <div className="hidden min-w-0 lg:block">
            <IndexTicker />
          </div>
          <nav className="ml-auto hidden items-center gap-1 md:flex" aria-label="主导航">
            {navItems.map((item) => (
              <Link
                key={item.href + item.label}
                href={item.href}
                className="rounded-full px-3.5 py-2 text-[15px] font-medium text-ink-2 transition-colors hover:bg-brand-hover hover:text-ink"
              >
                {item.label}
              </Link>
            ))}
          </nav>

          <div className="home-header-actions ml-auto flex flex-none items-center gap-2.5 md:ml-0">
            {/* 登录后：B 站风格头像（点击跳转后台）；未登录才显示主题按钮 + 登录 */}
            {auth === "in" ? (
              <UserMenu goTo="/records" initialUser={initialUser} />
            ) : (
              <>
                {/* 浅色 / 深色切换（未登录也可调） */}
                <button
                  type="button"
                  onClick={() => setDark((d) => !d)}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-edge-strong text-muted transition-colors hover:bg-brand-hover hover:text-ink"
                  title={dark ? "切换到浅色" : "切换到深色"}
                  aria-label="切换深浅色"
                >
                  {dark ? (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                      <circle cx="12" cy="12" r="4" />
                      <path d="M12 2v2" /><path d="M12 20v2" /><path d="m4.9 4.9 1.4 1.4" /><path d="m17.7 17.7 1.4 1.4" />
                      <path d="M2 12h2" /><path d="M20 12h2" /><path d="m4.9 19.1 1.4-1.4" /><path d="m17.7 6.3 1.4-1.4" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
                    </svg>
                  )}
                </button>
                <button type="button" onClick={() => window.dispatchEvent(new Event("fire:open-login"))} className="btn btn-brand btn-sm">
                  {t.login}
                </button>
              </>
            )}
          </div>
        </div>
      </header>

      <main>
        {/* Hero */}
        <section
          className="px-6 pb-16 pt-[72px]"
          style={
            liveBg
              ? { backgroundImage: `linear-gradient(${overlay}, ${overlay}), url(${liveBg})`, backgroundSize: "cover", backgroundPosition: "center" }
              : { background: "radial-gradient(720px 320px at 50% -40px, rgba(107,114,128,.10), transparent 65%)" }
          }
        >
          {/* 产品预览 */}
          <div id="preview" className="home-preview mx-auto mt-16 max-w-[1140px] overflow-hidden rounded-[18px] border border-edge bg-white shadow-pop">
            <div className="flex items-center gap-[7px] border-b border-edge bg-[#f3f4f6] px-4 py-3">
              <span className="h-[11px] w-[11px] rounded-full bg-[#ff5f57]" />
              <span className="h-[11px] w-[11px] rounded-full bg-[#febc2e]" />
              <span className="h-[11px] w-[11px] rounded-full bg-[#28c840]" />
            </div>
            <div className="flex min-h-[520px]">
              <aside className="hidden w-[168px] flex-none border-r border-edge bg-bg-gray p-[18px] md:block">
                <div className="mb-[22px] flex items-center gap-2 font-bold text-[15px] text-ink"><Logo logo={liveLogo} text={liveLogoText} font={liveLogoFont} small /></div>
                <nav className="flex flex-col gap-1">
                  {PREVIEW_VIEWS.map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => changeView(v)}
                      className={`rounded-[10px] px-3 py-2 text-left text-sm transition-colors duration-200 ${
                        view === v
                          ? "bg-white font-semibold text-ink shadow-[0_1px_4px_rgba(10,14,25,.08)] dark:bg-white/10"
                          : "text-muted hover:bg-white/70 hover:text-ink dark:hover:bg-white/10"
                      }`}
                    >
                      {v}
                    </button>
                  ))}
                </nav>
              </aside>
              <div className="min-w-0 flex-1 p-5 pb-6">
                {showStockToolbar && (
                  <div className="home-preview-toolbar mb-[18px] flex flex-wrap items-center gap-2.5">
                    <div className="home-preview-search min-w-[190px] flex-1">
                      <StockSearch onSelect={handleAdd} placeholder={t.searchPh} />
                    </div>
                    {orderedChips.map((c, i) => (
                      <button
                        key={c}
                        type="button"
                        draggable
                        onDragStart={(e) => {
                          chipDragIndex.current = i;
                          e.dataTransfer.effectAllowed = "move";
                        }}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={() => dropChip(i)}
                        onDragEnd={() => {
                          chipDragIndex.current = null;
                        }}
                        onClick={() => changeChip(c)}
                        title="拖动排序"
                        className={`flex cursor-grab items-center gap-1.5 rounded-full border px-3.5 py-[7px] text-[13px] font-semibold transition-colors duration-200 active:cursor-grabbing ${
                          chip === c
                            ? "border-edge bg-white text-ink shadow-sm hover:bg-brand-hover hover:text-ink dark:border-[#4a5568] dark:bg-[#252c3a] dark:text-[#eef1f6] dark:hover:bg-white/10"
                            : "border-edge bg-transparent text-ink-2 hover:bg-brand-hover hover:text-ink active:bg-bg-gray dark:border-[#3b4354] dark:text-[#e7ebf1] dark:hover:bg-white/10"
                        }`}
                      >
                        {c !== "ALL" && <MarketIcon market={c} size={15} title="" flag={chipFlag(c)} />}
                        {c === "ALL" ? "全部" : chipLabel(c)}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => setMarketEditor((v) => !v)}
                      title={marketEditor ? "收起新增市场" : "新增市场"}
                      className="pill-spring flex h-[36px] w-[36px] items-center justify-center rounded-full border border-dashed border-edge-strong text-lg font-bold text-muted transition-colors hover:bg-brand-hover hover:text-ink dark:hover:bg-white/10"
                    >
                      +
                    </button>
                    <button
                      type="button"
                      onClick={() => document.querySelector<HTMLInputElement>("#preview input")?.focus()}
                      className="hidden h-[38px] items-center rounded-full border border-edge-strong bg-white px-[18px] text-[13px] font-semibold text-ink shadow-sm transition-colors hover:bg-brand-hover hover:text-ink sm:inline-flex dark:border-white/20 dark:bg-white dark:text-ink dark:hover:bg-[#e5e7eb]"
                    >
                      {view === "我的持仓" ? "＋ 添加持仓" : t.addStock}
                    </button>
                  </div>
                )}

                {showStockToolbar && marketEditor && (
                  <div className="mb-4 flex flex-wrap items-center gap-2 rounded-[14px] border border-edge bg-bg-gray/40 p-3.5 dark:bg-white/5">
                    <input
                      value={newMarket.key}
                      onChange={(e) => setNewMarket((p) => ({ ...p, key: e.target.value }))}
                      placeholder="市场代码，如 JP"
                      className="field h-9 w-[140px] px-3 text-[13px]"
                    />
                    <input
                      value={newMarket.label}
                      onChange={(e) => setNewMarket((p) => ({ ...p, label: e.target.value }))}
                      placeholder="市场名称，如 日股"
                      className="field h-9 w-[140px] px-3 text-[13px]"
                    />
                    <button
                      type="button"
                      onClick={addMarket}
                      className="btn btn-line btn-sm"
                    >
                      添加
                    </button>
                    <span className="text-[11px] text-faint">新增市场会同步到后端，并显示在标签栏</span>
                  </div>
                )}

                {view === "全球预览" ? (
                  <GlobalPreviewView pageSize={10} />
                ) : view === "财报日历" ? (
                  <EarningsCalendarView />
                ) : view === "设置" ? (
                  <div className="overflow-hidden rounded-[14px] border border-edge">
                    <div className="border-b border-edge bg-bg-gray/40 px-4 py-3.5 dark:bg-white/5">
                      <div className="text-sm font-bold text-ink">设置</div>
                      <p className="mt-0.5 text-xs text-muted">账户、网站与数据相关设置在后端完成，前端提供快捷入口</p>
                    </div>
                    <div className="grid gap-3 p-4 sm:grid-cols-2">
                      <Link
                        href="/settings?sub=site"
                        className="group rounded-[12px] border border-edge bg-bg-gray/40 p-4 transition-colors duration-200 hover:border-edge-strong/35 hover:bg-brand-hover dark:bg-white/5 dark:hover:bg-white/[0.08]"
                      >
                        <div className="flex items-center gap-2.5">
                          <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-edge text-muted">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                              <circle cx="12" cy="12" r="9" />
                              <path d="M3 12h18" />
                              <path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18Z" />
                            </svg>
                          </span>
                          <span className="text-[13px] font-bold text-ink">网站设置</span>
                        </div>
                        <p className="mt-2 text-xs text-muted">站点信息、首页文案、导航菜单、指数与股票设置</p>
                        <span className="mt-2.5 inline-flex items-center gap-1 text-[11px] font-semibold text-brand-deep dark:text-white">
                          前往后台
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3 transition-transform duration-200 group-hover:translate-x-0.5">
                            <path d="m9 6 6 6-6 6" />
                          </svg>
                        </span>
                      </Link>
                      <Link
                        href="/settings?sub=profile"
                        className="group rounded-[12px] border border-edge bg-bg-gray/40 p-4 transition-colors duration-200 hover:border-edge-strong/35 hover:bg-brand-hover dark:bg-white/5 dark:hover:bg-white/[0.08]"
                      >
                        <div className="flex items-center gap-2.5">
                          <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-edge text-muted">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                              <circle cx="12" cy="8" r="4" />
                              <path d="M4 21v-1.5a5 5 0 0 1 5-5h6a5 5 0 0 1 5 5V21" />
                            </svg>
                          </span>
                          <span className="text-[13px] font-bold text-ink">个人信息</span>
                        </div>
                        <p className="mt-2 text-xs text-muted">头像、昵称、邮箱、UID 与密码管理</p>
                        <span className="mt-2.5 inline-flex items-center gap-1 text-[11px] font-semibold text-brand-deep dark:text-white">
                          前往后台
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3 transition-transform duration-200 group-hover:translate-x-0.5">
                            <path d="m9 6 6 6-6 6" />
                          </svg>
                        </span>
                      </Link>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="home-preview-table data-table-scroll rounded-[14px] border border-edge">
                      <div className={`home-preview-grid ${profitColumn ? "home-preview-grid-profit" : ""} grid min-w-[720px] ${gridCls} items-center gap-3.5 bg-bg-gray px-[18px] py-2.5 text-xs font-semibold text-muted`}>
                        {headerCells.map((h, i) => (
                          headerSortKeys[i]
                            ? <button
                                key={h}
                                type="button"
                                onClick={() => togglePreviewSort(headerSortKeys[i]!)}
                                className={`inline-flex w-full items-center gap-1 transition-colors hover:text-ink ${i === headerCells.length - 1 ? "justify-end" : ""}`}
                              >
                                {h}
                                <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" className={`h-3 w-3 ${previewSort?.key === headerSortKeys[i] ? "opacity-100" : "opacity-25"}`}>
                                  {previewSort?.key === headerSortKeys[i] && previewSort.dir === "asc"
                                    ? <path d="m5 12 5-5 5 5" />
                                    : <path d="m5 8 5 5 5-5" />}
                                </svg>
                              </button>
                            : <span key={h} className={i === headerCells.length - 1 ? "text-right" : ""}>{h}</span>
                        ))}
                      </div>
                      {liveRows === null ? (
                        <div className="space-y-3 border-t border-edge px-[18px] py-5">
                          {[0, 1, 2].map((i) => (
                            <div key={i} className="flex items-center gap-3.5">
                              <span className="h-6 w-6 flex-none animate-pulse rounded-full bg-bg-gray dark:bg-white/10" />
                              <span className="h-4 w-1/4 animate-pulse rounded bg-bg-gray dark:bg-white/10" style={{ animationDelay: `${i * 120}ms` }} />
                              <span className="h-4 w-1/6 animate-pulse rounded bg-bg-gray dark:bg-white/10" style={{ animationDelay: `${i * 160}ms` }} />
                              <span className="ml-auto h-4 w-16 animate-pulse rounded bg-bg-gray dark:bg-white/10" style={{ animationDelay: `${i * 100}ms` }} />
                            </div>
                          ))}
                        </div>
                      ) : auth === "out" && view === "我的持仓" ? (
                        <div className="border-t border-edge px-[18px] py-9 text-center text-sm text-faint">
                          登录后展示你的持仓与持仓盈亏
                        </div>
                      ) : showRows.length === 0 ? (
                        <div className="border-t border-edge px-[18px] py-9 text-center text-sm text-faint">
                          {chip === "CN"
                            ? "暂无 A 股数据"
                            : view === "我的持仓"
                              ? "暂无持仓，添加股票并填写数量后计入持仓"
                              : auth === "out"
                                ? "暂无自选，使用上方搜索添加（仅保存在当前浏览器）"
                                : "暂无相关股票"}
                        </div>
                      ) : (
                        showRows.map((row, i) => (
                          <div key={row.key} className={`home-preview-grid ${profitColumn ? "home-preview-grid-profit" : ""} grid min-w-[720px] ${gridCls} items-center gap-3.5 border-t border-edge px-[18px] py-[13px] text-sm`}>
                            <span className="flex justify-center">
                              <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-bg-gray text-xs font-bold text-muted">
                                {(safePage - 1) * PREVIEW_PAGE_SIZE + i + 1}
                              </span>
                            </span>
                            <span className="home-preview-identity flex min-w-0 items-center gap-2.5">
                              <Fireo market={row.market} code={row.code} name={row.name} />
                              <span className="flex min-w-0 flex-col leading-[1.35]">
                                <b className="home-preview-name font-semibold text-ink">{row.name}</b>
                                <small className="truncate text-xs text-muted">{row.sub}</small>
                              </span>
                            </span>
                            <span className="font-semibold tabular-nums text-ink">{row.price}</span>
                            <span className={`font-semibold tabular-nums ${row.up ? "text-up" : "text-down"}`}>{row.change}</span>
                            {isLive ? <MiniTrendChart points={row.spark} baseline={row.baseline} stale={row.sparkStale} width={90} height={26} className="h-[26px] w-full" label={`${row.name} 当日走势`} /> : <Sparkline up={row.up} />}
                            {profitColumn && (
                              <span className={`text-right font-semibold tabular-nums ${row.profitUp ? "text-up" : "text-down"}`}>{row.profit}</span>
                            )}
                          </div>
                        ))
                      )}
                    </div>
                    {isLive && totalPages > 1 && (
                      <div className="mt-4 flex items-center justify-center gap-2">
                        <button type="button" disabled={safePage <= 1} onClick={() => setPages((p) => ({ ...p, [pageKey]: safePage - 1 }))} className="pg-btn">上一页</button>
                        <span className="text-xs text-muted">第 {safePage} / {totalPages} 页</span>
                        <button type="button" disabled={safePage >= totalPages} onClick={() => setPages((p) => ({ ...p, [pageKey]: safePage + 1 }))} className="pg-btn">下一页</button>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        </section>

      </main>

      {/* 页脚 */}
      <footer className="border-t border-edge bg-white px-6 pb-7 pt-14">
        <div className="mx-auto max-w-[1140px]">
          <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <Logo logo={liveLogo} text={liveLogoText} font={liveLogoFont} />
              <p className="mt-3.5 max-w-[240px] text-[13px] text-muted">{liveFooterDesc || t.footerDesc}</p>
            </div>
            {[
              [t.col1, t.col1Links],
              [t.col2, t.col2Links],
              [t.col3, t.col3Links]
            ].map(([title, links]) => (
              <div key={title as string}>
                <h4 className="mb-3.5 text-sm font-bold text-ink">{title}</h4>
                {(links as string[]).map((link) => (
                  <a key={link} href="#" className="block py-1 text-[13px] text-muted transition-colors hover:text-brand-deep">{link}</a>
                ))}
              </div>
            ))}
          </div>
          <hr className="my-8 border-edge" />
          <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-faint">
            <span>{t.copyright}</span>
            <span>{liveDomain} · {t.serverNote}</span>
          </div>
        </div>
      </footer>
    </>
  );
}
