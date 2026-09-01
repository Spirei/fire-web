"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { MARKET_LIST, marketMeta } from "@/lib/types";
import { showToast } from "@/lib/toast";
import MarketIcon from "@/components/MarketIcon";
import SettingsHeader from "@/components/SettingsHeader";
import type { Asset } from "@/lib/useAssetIcons";
import { useAssetIcons } from "@/lib/useAssetIcons";
import { useRates, usdCap, fmtUsd } from "@/lib/useRates";
import Pagination from "@/components/Pagination";
import DeleteIcon from "@/components/DeleteIcon";
import type { WatchGroup } from "@/lib/watchGroups";
import type { CountryCatalogItem } from "@/lib/countryCatalog";
import { defaultFlagUrl } from "@/lib/flagAssets";

type TabKey = "stock" | "market" | "flag" | "broker" | "group" | "crypto" | "metal" | "icon";

interface TopStock {
  market: string;
  code: string;
  name: string;
  marketCap: number;
  price: number | null;
  changePct: number | null;
  logo: string;
  type?: "stock" | "crypto" | "metal";
}

interface MarketRow {
  id: string;
  key: string;
  label: string;
  url: string;
}

interface AssetRow {
  id: string;
  key: string;
  name: string;
  type: "crypto" | "metal";
  url: string;
  price?: number | null;
  marketCap?: number;
  changePct?: number | null;
}

const BASE_MARKETS = ["US", "HK", "CN", "JP", "KR", "SG", "UK", "DE", "FR", "AU", "CA", "IN", "TW", "BR"];
// 指数 / 非交易市场（如标普500 SPX、欧盟 EU）不作为可筛选市场，仅保留图标
const NON_TRADABLE_MARKETS = new Set(["SPX", "EU"]);
const TOP_MARKETS = [...BASE_MARKETS, "ALL"];
const UP = "text-up";
const DOWN = "text-down";

// 内置资产图标（贵金属 / 加密货币），可上传自定义图标全局替换
const BASE_ASSETS: { key: string; name: string; type: "crypto" | "metal" }[] = [
  { key: "GOLD", name: "黄金", type: "metal" },
  { key: "SILVER", name: "白银", type: "metal" },
  { key: "PALLAD", name: "钯金", type: "metal" },
  { key: "PLAT", name: "铂金", type: "metal" },
  { key: "BTC", name: "比特币", type: "crypto" },
  { key: "ETH", name: "以太坊", type: "crypto" }
];

// 内置 UI 图标规范顺序（与 lib/assets.ts DEFAULT_ICONS 保持一致，未知新增排后面）
const ICON_ORDER = [
  "settings", "holdings", "assets", "watchlist", "global", "earnings", "celebs", "activities",
  "users", "attachments", "library", "site", "sitemanage", "stocks", "profile", "database",
  "api", "cron", "about", "trade", "fire", "search", "plus", "refresh", "close", "check"
];

// 内置图标的规范展示名（与 lib/assets.ts ICON_NAMES 保持一致）
const ICON_NAMES: Record<string, string> = {
  settings: "设置",
  holdings: "持仓",
  assets: "资产",
  watchlist: "自选",
  global: "全球经济",
  earnings: "盈利",
  celebs: "名人",
  activities: "动态",
  users: "用户",
  attachments: "附件",
  library: "素材库",
  site: "网站",
  sitemanage: "网站管理",
  stocks: "股票",
  profile: "个人信息",
  database: "数据库",
  api: "接口",
  cron: "定时",
  about: "关于",
  trade: "交易",
  fire: "fire",
  search: "搜索",
  plus: "新增",
  refresh: "刷新",
  close: "关闭",
  check: "完成"
};

// 主流券商候选（素材库-券商图标 快速添加）
// 同一券商只保留一个规范名（name），其他写法 / 英文名放 aliases 用于去重（如 IBKR = 盈透证券）
const MAIN_BROKERS: { region: "A股" | "美股" | "港股"; items: { name: string; aliases?: string[] }[] }[] = [
  {
    region: "A股",
    items: [
      { name: "华泰证券", aliases: ["华泰证劵"] },
      { name: "东方财富", aliases: ["东财"] },
      { name: "同花顺" },
      { name: "中信证券", aliases: ["中信"] },
      { name: "国泰君安", aliases: ["国泰君安证券"] },
      { name: "招商证券", aliases: ["招商"] },
      { name: "广发证券", aliases: ["广发"] },
      { name: "平安证券", aliases: ["平安"] },
      { name: "银河证券", aliases: ["银河"] },
      { name: "海通证券", aliases: ["海通"] },
      { name: "申万宏源", aliases: ["申万宏源证券"] },
      { name: "兴业证券", aliases: ["兴业"] },
      { name: "中金公司", aliases: ["中金", "CICC"] },
      { name: "光大证券", aliases: ["光大"] },
      { name: "东方证券", aliases: ["东方"] }
    ]
  },
  {
    region: "美股",
    items: [
      { name: "盈透证券", aliases: ["IBKR", "Interactive Brokers", "盈透"] },
      { name: "嘉信理财", aliases: ["Schwab", "Charles Schwab", "嘉信"] },
      { name: "罗宾汉", aliases: ["Robinhood"] },
      { name: "富途证券", aliases: ["Futu"] },
      { name: "老虎证券", aliases: ["Tiger Brokers", "Tiger"] },
      { name: "微牛证券", aliases: ["Webull"] },
      { name: "第一证券", aliases: ["Firstrade"] },
      { name: "先锋领航", aliases: ["Vanguard"] },
      { name: "德美利", aliases: ["TD Ameritrade"] },
      { name: "亿创理财", aliases: ["E*TRADE", "E-Trade"] },
      { name: "SogoTrade", aliases: ["Sogo"] }
    ]
  },
  {
    region: "港股",
    items: [
      { name: "富途证券", aliases: ["富途牛牛", "Futu"] },
      { name: "老虎证券", aliases: ["Tiger"] },
      { name: "华盛证券", aliases: ["华盛", "VBrokers"] },
      { name: "辉立证券", aliases: ["辉立", "Phillip"] },
      { name: "耀才证券", aliases: ["耀才", "Bright Smart"] },
      { name: "中银国际", aliases: ["中银国际证券", "BOCI"] },
      { name: "海通国际", aliases: ["海通国际证券", "Haitong International"] },
      { name: "招证国际", aliases: ["招商证券国际"] },
      { name: "国泰君安国际", aliases: ["国泰君安国际证券"] },
      { name: "微牛证券", aliases: ["Webull"] },
      { name: "雪盈证券", aliases: ["雪盈", "Snowball Securities"] },
      { name: "青石证券", aliases: ["青石"] },
      { name: "盈立证券", aliases: ["盈立", "uSmart"] },
      { name: "立桥证券", aliases: ["立桥", "Well Link"] },
      { name: "宝盛证券", aliases: ["宝盛"] }
    ]
  }
];

// 券商名称归一化：证劵/证券、大小写统一，用于候选去重
function brokerNameKey(s: string): string {
  return s.replace(/证劵/g, "证券").trim().toLowerCase();
}

function toStockId(market: string, code: string) {
  return `stock:${market.toUpperCase()}:${code.toUpperCase()}`;
}

function toMarketId(key: string) {
  return `market:${key.toUpperCase()}`;
}

// 外部图标兜底模板（设置里开启「CDN 通道」后使用）：美股 foolcdn，其余 parqet
function externalLogo(market: string, code: string): string {
  if (market === "US") return `https://g.foolcdn.com/art/companylogos/square/${code.toUpperCase()}.png`;
  const norm = market === "HK" ? code.toUpperCase().padStart(5, "0") : code.toUpperCase();
  const suffix = market === "JP" ? ".T" : market === "KR" ? ".KS" : "";
  return `https://assets.parqet.com/logos/symbol/${norm}${suffix}`;
}

function fmtPrice(market: string, price: number): string {
  const v = price.toFixed(market === "US" ? 3 : 2);
  if (market === "US") return `$${v}`;
  if (market === "HK") return `HK$${v}`;
  if (market === "CN") return `¥${v}`;
  return `$${v}`;
}

const inputCls =
  "h-[36px] rounded-[9px] border border-edge-strong bg-white px-3 text-sm text-ink outline-none transition-shadow focus:border-edge-strong focus:shadow-[0_0_0_3px_rgba(107,114,128,.14)] dark:bg-[#151a26] dark:text-[#e5e7eb]";

function Avatar({
  src,
  name,
  size = 44,
  className = ""
}: {
  src: string;
  name: string;
  size?: number;
  className?: string;
}) {
  const [err, setErr] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const isRemote = !!src && /^https?:/i.test(src);
  const failKey = src ? `fire:logo-fail:${src}` : "";
  const [cachedFail] = useState(() => {
    if (!isRemote || !failKey) return false;
    try {
      return sessionStorage.getItem(failKey) === "1";
    } catch {
      return false;
    }
  });
  const showImg = !!src && !err && !timedOut && !cachedFail;

  // 外部 logo（foolcdn / parqet / cmc）：1.5s 未加载即降级为首字母并记忆，避免慢 CDN 阻塞列表
  useEffect(() => {
    if (!showImg || !isRemote || !failKey) return;
    const t = window.setTimeout(() => {
      setTimedOut(true);
      try {
        sessionStorage.setItem(failKey, "1");
      } catch {
        /* 忽略 */
      }
    }, 1500);
    return () => window.clearTimeout(t);
  }, [showImg, isRemote, failKey]);

  if (!showImg) {
    return (
      <span
        className={`inline-flex flex-none items-center justify-center overflow-hidden rounded-full bg-brand-light text-sm font-bold text-brand-deep ${className}`}
        style={{ width: size, height: size }}
      >
        {(name || "?").trim().slice(0, 1).toUpperCase()}
      </span>
    );
  }
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      onLoad={() => {
        try {
          if (failKey) sessionStorage.removeItem(failKey);
        } catch {
          /* 忽略 */
        }
      }}
      onError={() => {
        setErr(true);
        try {
          if (failKey) sessionStorage.setItem(failKey, "1");
        } catch {
          /* 忽略 */
        }
      }}
      className={`block flex-none rounded-full object-cover ${className}`}
      style={{ width: size, height: size }}
    />
  );
}

export default function AssetLibraryView() {
  const { assetIcons, stockIcons } = useAssetIcons();
  const rates = useRates();
  const [tab, setTab] = useState<TabKey>(() => {
    if (typeof window === "undefined") return "stock";
    const t = new URLSearchParams(window.location.search).get("tab");
    return (["stock", "market", "flag", "broker", "group", "crypto", "metal", "icon"] as string[]).includes(t ?? "") ? (t as TabKey) : "stock";
  });
  const [selected, setSelected] = useState(() => {
    if (typeof window === "undefined") return "ALL";
    return new URLSearchParams(window.location.search).get("market") || "ALL";
  });
  const [assets, setAssets] = useState<Asset[]>([]);
  const [assetsLoading, setAssetsLoading] = useState(true);
  const [marketRows, setMarketRows] = useState<MarketRow[]>([]);
  const [countryRows, setCountryRows] = useState<CountryCatalogItem[]>([]);
  const [flagQuery, setFlagQuery] = useState("");
  const [brokerGroups, setBrokerGroups] = useState<{ id: string; name: string; alias?: string }[]>([]);
  const [watchGroups, setWatchGroups] = useState<WatchGroup[]>([]);
  const loadWatchGroups = async () => {
    try {
      const res = await fetch("/api/v1/watch-groups");
      const d = await res.json().catch(() => null);
      if (d?.data?.groups) setWatchGroups(d.data.groups);
    } catch {
      /* 忽略 */
    }
  };
  useEffect(() => {
    if (tab === "group") void loadWatchGroups();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);
  // 分组图标列表：非券商自定义分组（券商分组图标走「券商图标」分类）
  const groupRows = useMemo(
    () => watchGroups.filter((g) => g.kind === "custom" && !assets.some((a) => a.type === "broker" && a.name === g.name)),
    [watchGroups, assets]
  );
  const [assetRows, setAssetRows] = useState<AssetRow[]>([]);
  const [marketMenuOpen, setMarketMenuOpen] = useState(false);
  const [marketLabels, setMarketLabels] = useState<{ key: string; label: string; flag: string }[]>([]);
  const [editingLabel, setEditingLabel] = useState<string | null>(null);
  const [labelDraft, setLabelDraft] = useState("");
  const [marketOrder, setMarketOrder] = useState<string[]>([]);
  const [cdnEnabled, setCdnEnabled] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [syncStatus, setSyncStatus] = useState<{ running: boolean; total: number; done: number; current: string; error: string; lastSyncAt: string } | null>(null);
  const [checkingDelisted, setCheckingDelisted] = useState(false);
  const [cleaningFiles, setCleaningFiles] = useState(false);
  const [sortKey, setSortKey] = useState<"rank" | "code" | "name" | "board" | "price" | "changePct" | "marketCap">(() => {
    if (typeof window === "undefined") return "rank";
    const s = new URLSearchParams(window.location.search).get("sort");
    return (["rank", "code", "name", "board", "price", "changePct", "marketCap"] as const).includes(s as never)
      ? (s as "rank" | "code" | "name" | "board" | "price" | "changePct" | "marketCap")
      : "rank";
  });
  const [sortDir, setSortDir] = useState<"asc" | "desc">(() => {
    if (typeof window === "undefined") return "desc";
    return new URLSearchParams(window.location.search).get("dir") === "asc" ? "asc" : "desc";
  });
  const [query, setQuery] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("q") ?? "";
  });
  const [topPage, setTopPage] = useState<number>(() => {
    if (typeof window === "undefined") return 1;
    const p = Number(new URLSearchParams(window.location.search).get("page"));
    return Number.isFinite(p) && p >= 1 ? Math.floor(p) : 1;
  });
  const [listPage, setListPage] = useState(1);
  const [names, setNames] = useState<Record<string, string>>({});
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [addCandidates, setAddCandidates] = useState<{
    type: "stock" | "crypto" | "metal";
    items: { symbol?: string; code: string; name: string; market: string; iconUrl?: string }[];
  } | null>(null);
  const [adding, setAdding] = useState(false);
  const [assetQuery, setAssetQuery] = useState("");
  const [iconQuery, setIconQuery] = useState("");
  const [editingIcon, setEditingIcon] = useState<string | null>(null);
  const [iconDraft, setIconDraft] = useState("");
  const [manualAdd, setManualAdd] = useState<{ market: "US" | "HK" | "CN"; code: string; name: string } | null>(null);
  const [brokerRegion, setBrokerRegion] = useState<"A股" | "美股" | "港股">("A股");
  const [newMarket, setNewMarket] = useState({ key: "", url: "" });
  const fileRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const dragIndex = useRef<number | null>(null);
  const brokerDragIndex = useRef<number | null>(null);
  const customMarkets = useRef<Set<string>>(new Set());
  const topMountedRef = useRef(false);

  // URL 状态同步：刷新/分享/前进后退都能保持选中的分类和市场
  useEffect(() => {
    function syncFromUrl() {
      const sp = new URLSearchParams(window.location.search);
      const t = sp.get("tab");
      if (t && (["stock", "market", "flag", "broker", "group", "crypto", "metal", "icon"] as string[]).includes(t)) setTab(t as TabKey);
      const m = sp.get("market");
      if (m) setSelected(m);
      const p = Number(sp.get("page"));
      if (Number.isFinite(p) && p >= 1) setTopPage(Math.floor(p));
      const s = sp.get("sort");
      if (s && (["rank", "code", "name", "board", "price", "changePct", "marketCap"] as const).includes(s as never)) setSortKey(s as never);
      if (sp.get("dir") === "asc") setSortDir("asc");
      const q = sp.get("q");
      if (q !== null) setQuery(q);
    }
    window.addEventListener("popstate", syncFromUrl);
    return () => window.removeEventListener("popstate", syncFromUrl);
  }, []);

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    if (sp.get("tab") !== tab) {
      sp.set("tab", tab);
      // 低级别的市场筛选只属于股票图标分类，切换分类时清除
      if (tab !== "stock") sp.delete("market");
      window.history.replaceState(null, "", `?${sp.toString()}`);
    }
  }, [tab]);

  useEffect(() => {
    setListPage(1);
  }, [tab, flagQuery, iconQuery, assetQuery]);

  useEffect(() => {
    if (tab !== "stock") return;
    const sp = new URLSearchParams(window.location.search);
    if (sp.get("market") !== selected) {
      sp.set("market", selected);
      window.history.replaceState(null, "", `?${sp.toString()}`);
    }
  }, [selected, tab]);

  // 搜索无本地匹配时：清空上一次的候选列表
  useEffect(() => {
    setAddCandidates(null);
    setManualAdd(null);
  }, [query, assetQuery]);

  // 搜索即添加：拉取行情源联想结果（腾讯），供用户选择后添加到素材库
  async function loadAddCandidates(type: "stock" | "crypto" | "metal") {
    const q = (type === "stock" ? query : assetQuery).trim();
    if (!q) return;
    setAdding(true);
    try {
      let results: { symbol?: string; code: string; name: string; market: string; iconUrl?: string }[] = [];
      if (type === "stock") {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        const data = await res.json().catch(() => null);
        results = (data?.results ?? []).filter(
          (r: { market?: string }) => r.market === "US" || r.market === "HK" || r.market === "CN"
        );
      } else {
        const res = await fetch(`/api/assets/search?type=${type}&q=${encodeURIComponent(q)}`);
        const data = await res.json().catch(() => null);
        results = data?.candidates ?? [];
      }
      setAddCandidates(results.length ? { type, items: results } : null);
      if (!results.length) {
        if (type === "stock") setManualAdd({ market: "US", code: "", name: q });
        else showToast("行情源未找到该产品，请检查输入", "err");
      } else {
        setManualAdd(null);
      }
    } catch {
      showToast("搜索失败，请稍后重试", "err");
    } finally {
      setAdding(false);
    }
  }

  // 添加候选：后端自动下载图标（尽力而为）并写入素材库
  async function addCandidate(c: { code: string; name: string; market: string; iconUrl?: string }, type: "stock" | "crypto" | "metal") {
    const busyKey = `add:${c.market}:${c.code}`;
    setBusy((b) => ({ ...b, [busyKey]: true }));
    try {
      const res = await fetch("/api/assets/add-by-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, market: c.market, code: c.code, name: c.name, iconUrl: c.iconUrl })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "添加失败");
      window.dispatchEvent(new Event("fire:assets-updated"));
      await loadAssets(true);
      setAddCandidates(null);
      showToast(`已添加 ${data.asset.name} (${data.asset.code})`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "添加失败", "err");
    } finally {
      setBusy((b) => ({ ...b, [busyKey]: false }));
    }
  }

  // 行情源未匹配到时的手动添加（股票）
  async function saveManualAdd() {
    if (!manualAdd) return;
    const code = manualAdd.code.trim().toUpperCase();
    const name = manualAdd.name.trim();
    if (!code) {
      showToast("请填写股票代码", "err");
      return;
    }
    setBusy((b) => ({ ...b, "manual-add": true }));
    try {
      const res = await fetch("/api/assets/add-by-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "stock", market: manualAdd.market, code, name: name || code })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "添加失败");
      window.dispatchEvent(new Event("fire:assets-updated"));
      await loadAssets(true);
      setManualAdd(null);
      setAddCandidates(null);
      showToast(`已添加 ${data.asset.name} (${data.asset.code})`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "添加失败", "err");
    } finally {
      setBusy((b) => ({ ...b, "manual-add": false }));
    }
  }

  async function loadAssets(silent = false) {
    if (!silent) setAssetsLoading(true);
    try {
      const res = await fetch("/api/assets");
      const data = await res.json().catch(() => null);
      const list: Asset[] = data?.assets ?? [];
      setAssets(list);
      const markets = list
        .filter((a) => a.type === "market")
        .map((a) => ({ id: a.id, key: a.market, label: marketMeta(a.market).label, url: a.url }));
      setMarketRows(markets);
      markets.forEach((m) => {
        if (!NON_TRADABLE_MARKETS.has(m.key)) customMarkets.current.add(m.key);
      });
      const customAssets = new Map(
        list
          .filter((a) => a.type === "crypto" || a.type === "metal")
          .map((a) => [a.code.toUpperCase(), a])
      );
      const rows: AssetRow[] = BASE_ASSETS.map((b) => {
        const custom = customAssets.get(b.key);
        return {
          id: custom?.id ?? "",
          key: b.key,
          name: custom?.name || b.name,
          type: b.type,
          url: custom?.url ?? "",
          price: custom?.price,
          marketCap: custom?.marketCap,
          changePct: custom?.changePct
        };
      });
      // 自定义新增的资产图标（超出内置列表）
      customAssets.forEach((a, code) => {
        if (!BASE_ASSETS.some((b) => b.key === code)) {
          rows.push({
            id: a.id,
            key: code,
            name: a.name || code,
            type: a.type as "crypto" | "metal",
            url: a.url,
            price: a.price,
            marketCap: a.marketCap,
            changePct: a.changePct
          });
        }
      });
      setAssetRows(rows);
    } catch {
      /* 忽略 */
    } finally {
      setAssetsLoading(false);
    }
  }

  useEffect(() => {
    loadAssets();
    fetch("/api/settings")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (Array.isArray(d?.settings?.assetMarketOrder)) setMarketOrder(d.settings.assetMarketOrder);
        if (Array.isArray(d?.settings?.marketLabels)) setMarketLabels(d.settings.marketLabels);
        if (Array.isArray(d?.settings?.groups)) setBrokerGroups(d.settings.groups);
        if (typeof d?.settings?.stockIconCdn === "boolean") setCdnEnabled(d.settings.stockIconCdn);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (tab !== "flag" || countryRows.length > 0) return;
    fetch("/api/countries")
      .then((response) => response.ok ? response.json() : null)
      .then((body) => {
        if (Array.isArray(body?.countries)) setCountryRows(body.countries);
      })
      .catch(() => {});
  }, [tab, countryRows.length]);

  const filteredCountryRows = useMemo(() => {
    const query = flagQuery.trim().toLowerCase();
    if (!query) return countryRows;
    return countryRows.filter((country) =>
      country.name.toLowerCase().includes(query) || country.iso2.toLowerCase().includes(query)
    );
  }, [countryRows, flagQuery]);

  // crypto / metal 行情由服务端后台刷新（CoinGecko / CMC）：数据未就绪时静默重取一次，避免一直显示 —
  useEffect(() => {
    if (tab !== "crypto" && tab !== "metal") return;
    if (assetRows.some((r) => r.price == null || !r.marketCap)) {
      const t = setTimeout(() => loadAssets(true), 2200);
      return () => clearTimeout(t);
    }
  }, [tab, assetRows]);

  // 加密货币 / 贵金属排序（市值 / 最新价 / 涨跌幅；未选择排序时保持默认顺序）
  const sortedAssetRows = useMemo(() => {
    const list = assetRows.filter((r) => r.type === tab);
    if (sortKey !== "marketCap" && sortKey !== "price" && sortKey !== "changePct") return list;
    const dir = sortDir === "asc" ? 1 : -1;
    const val = (r: AssetRow): number => {
      if (sortKey === "marketCap") return r.marketCap ?? 0;
      if (sortKey === "price") return r.price ?? -Infinity;
      return r.changePct ?? -Infinity;
    };
    return [...list].sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      if (va === -Infinity) return 1;
      if (vb === -Infinity) return -1;
      if (va === vb) return 0;
      return (va - vb) * dir;
    });
  }, [assetRows, tab, sortKey, sortDir]);

  // 加密货币 / 贵金属搜索过滤（名称 / 代码）
  const filteredAssetRows = useMemo(() => {
    const q = assetQuery.trim().toLowerCase();
    if (!q) return sortedAssetRows;
    return sortedAssetRows.filter(
      (r) => r.name.toLowerCase().includes(q) || r.key.toLowerCase().includes(q)
    );
  }, [sortedAssetRows, assetQuery]);

  // 图标素材：按内置规范顺序展示（settings / holdings / assets …），未知新增排后面
  const iconRows = useMemo(() => {
    const order = new Map(ICON_ORDER.map((c, i) => [c.toUpperCase(), i]));
    return [...assets.filter((a) => a.type === "icon")].sort((a, b) => {
      const ia = order.get(a.code) ?? 999;
      const ib = order.get(b.code) ?? 999;
      return ia - ib || a.code.localeCompare(b.code);
    });
  }, [assets]);

  const filteredIconRows = useMemo(() => {
    const q = iconQuery.trim().toLowerCase();
    if (!q) return iconRows;
    return iconRows.filter(
      (r) => r.name.toLowerCase().includes(q) || r.code.toLowerCase().includes(q)
    );
  }, [iconRows, iconQuery]);

  function marketLabelOf(key: string): string {
    if (key === "EU") return marketLabels.find((l) => l.key === "EU")?.label ?? "欧盟";
    if (BASE_MARKETS.includes(key)) return marketMeta(key).label;
    return key === "US" ? "美股" : marketLabels.find((l) => l.key === key)?.label ?? marketMeta(key).label;
  }

  async function saveMarketLabel(key: string, raw: string) {
    const label = raw.trim();
    if (!label) {
      showToast("市场名称不能为空", "err");
      return;
    }
    const exists = marketLabels.some((l) => l.key === key);
    const next = exists
      ? marketLabels.map((l) => (l.key === key ? { ...l, label } : l))
      : [...marketLabels, { key, label, flag: marketMeta(key).flag }];
    setBusy((b) => ({ ...b, [`label:${key}`]: true }));
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ marketLabels: next })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "保存失败");
      setMarketLabels(next);
      setEditingLabel(null);
      // 同步素材库市场记录名称（附件管理 / 素材库保持一致）
      const row = marketRows.find((r) => r.key === key);
      if (row?.id) {
        await fetch("/api/assets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "market", market: key, name: label, url: row.url, id: row.id })
        }).catch(() => {});
      }
      window.dispatchEvent(new Event("fire:assets-updated"));
      showToast("市场名称已更新");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "保存失败", "err");
    } finally {
      setBusy((b) => ({ ...b, [`label:${key}`]: false }));
    }
  }

  const orderedMarkets = useMemo(() => {
    const set = new Set<string>([...marketOrder, ...BASE_MARKETS, ...customMarkets.current]);
    return [...set].filter((m) => (BASE_MARKETS.includes(m) || customMarkets.current.has(m)) && !NON_TRADABLE_MARKETS.has(m));
  }, [marketOrder]);

  // 分页 URL 同步：?page=N，刷新 / 分享保持页码
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    if (topPage > 1) sp.set("page", String(topPage));
    else sp.delete("page");
    window.history.replaceState(null, "", `?${sp.toString()}`);
  }, [topPage]);

  // 排序状态写入 URL：?sort=price&dir=asc，刷新 / 分享保持排序
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    if (sortKey !== "rank") sp.set("sort", sortKey);
    else sp.delete("sort");
    if (sortDir !== "desc") sp.set("dir", sortDir);
    else sp.delete("dir");
    if (query.trim()) sp.set("q", query.trim());
    else sp.delete("q");
    window.history.replaceState(null, "", `?${sp.toString()}`);
  }, [sortKey, sortDir, query]);

  // 切换分类 / 市场时回到第一页
  useEffect(() => {
    if (!topMountedRef.current) {
      topMountedRef.current = true;
      return;
    }
    setTopPage(1);
  }, [tab, selected]);

  const customFor = (market: string, code: string) =>
    assets.find((a) => a.type === "stock" && a.market === market && a.code.toUpperCase() === code.toUpperCase());

  const customForAny = (code: string) =>
    assets.find(
      (a) =>
        a.type === "stock" &&
        (a.code.toUpperCase() === code.toUpperCase() ||
          a.code.toUpperCase().replace(/\..*$/, "") === code.toUpperCase().replace(/\..*$/, ""))
    );

  const displayName = (item: { market: string; code: string; name: string }) => {
    const key = `${item.market}:${item.code}`;
    return names[key] ?? (customFor(item.market, item.code) || customForAny(item.code))?.name ?? item.name;
  };

  const displayUrl = (item: { market: string; code: string; name: string; url?: string }) => {
    const key = `${item.market}:${item.code}`;
    const custom = customFor(item.market, item.code) || customForAny(item.code);
    return (
      urls[key] ??
      custom?.url ??
      item.url ??
      stockIcons[`${item.market.toUpperCase()}:${item.code.toUpperCase()}`] ??
      (cdnEnabled ? externalLogo(item.market, item.code) : "")
    );
  };

  async function uploadStock(item: { market: string; code: string; name: string }, file: File) {
    const key = `${item.market}:${item.code}`;
    setBusy((b) => ({ ...b, [key]: true }));
    try {
      const fd = new FormData();
      fd.append("kind", "asset");
      fd.append("folder", "stock");
      fd.append("market", item.market);
      fd.append("code", item.code);
      fd.append("name", item.name);
      fd.append("file", file);
      const up = await fetch("/api/upload", { method: "POST", body: fd });
      const upData = await up.json().catch(() => null);
      if (!up.ok) throw new Error(upData?.error || "上传失败");
      setUrls((prev) => ({ ...prev, [key]: upData.url }));
      await saveStock(item, upData.url);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "保存失败", "err");
    } finally {
      setBusy((b) => ({ ...b, [key]: false }));
    }
  }

  async function saveStock(item: { market: string; code: string; name: string }, urlOverride?: string) {
    const key = `${item.market}:${item.code}`;
    setBusy((b) => ({ ...b, [key]: true }));
    try {
      const existing = customFor(item.market, item.code) || customForAny(item.code);
      const url = (urlOverride ?? urls[key] ?? existing?.url ?? "").trim();
      const targetId = toStockId(item.market, item.code);
      // 素材 id 与当前市场/代码不一致时，先迁移（删除旧 id，避免重复与丢失头像）
      if (existing && existing.id !== targetId) {
        await fetch(`/api/assets?id=${encodeURIComponent(existing.id)}`, { method: "DELETE" }).catch(() => {});
      }
      const res = await fetch("/api/assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "stock",
          market: item.market,
          code: item.code,
          name: (names[key] ?? existing?.name ?? item.name).trim(),
          url,
          id: existing?.id || undefined
        })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "保存失败");
      window.dispatchEvent(new Event("fire:assets-updated"));
      await loadAssets();
      showToast(`已保存 ${item.code}，全局生效`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "保存失败", "err");
    } finally {
      setBusy((b) => ({ ...b, [key]: false }));
    }
  }

  async function removeStock(item: { market: string; code: string }) {
    const custom = customFor(item.market, item.code) || customForAny(item.code);
    if (!custom) return;
    if (!confirm(`确定恢复「${item.code}」为默认显示吗？`)) return;
    await fetch(`/api/assets?id=${encodeURIComponent(custom.id)}`, { method: "DELETE" });
    window.dispatchEvent(new Event("fire:assets-updated"));
    await loadAssets();
    showToast("已恢复默认");
  }

  async function refreshSyncStatus() {
    try {
      const res = await fetch("/api/assets/sync");
      const d = await res.json().catch(() => null);
      if (d?.status) setSyncStatus(d.status);
    } catch {
      /* 忽略 */
    }
  }

  async function startSync() {
    const res = await fetch("/api/assets/sync", { method: "POST" });
    const d = await res.json().catch(() => null);
    if (!res.ok) {
      showToast(d?.message || "同步失败", "err");
      return;
    }
    showToast("股票同步已开始");
    await refreshSyncStatus();
  }

  async function runDelistedCheck() {
    setCheckingDelisted(true);
    try {
      const res = await fetch("/api/assets/check-delisted", { method: "POST" });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error(d?.error || "检测失败");
      showToast(d.removed > 0 ? `已删除 ${d.removed} 只疑似退市股票` : "未发现疑似退市股票");
      window.dispatchEvent(new Event("fire:assets-updated"));
      await loadAssets();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "检测失败", "err");
    } finally {
      setCheckingDelisted(false);
    }
  }

  async function toggleCdn(v: boolean) {
    setCdnEnabled(v);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stockIconCdn: v })
      });
      if (!res.ok) throw new Error("保存失败");
      showToast(v ? "已开启 CDN 图标兜底" : "已关闭 CDN 图标兜底");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "保存失败", "err");
      setCdnEnabled(!v);
    }
  }

  async function runCleanup() {
    setCleaningFiles(true);
    try {
      const res = await fetch("/api/assets/cleanup", { method: "POST" });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error(d?.error || "清理失败");
      showToast(`已清理 ${d.removed} 个孤立文件${d.failed ? `（${d.failed} 个失败）` : ""}`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "清理失败", "err");
    } finally {
      setCleaningFiles(false);
    }
  }

  function toggleSort(key: "rank" | "code" | "name" | "board" | "price" | "changePct" | "marketCap") {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  const SortArrow = ({ k }: { k: typeof sortKey }) =>
    sortKey === k ? (
      <svg viewBox="0 0 24 24" fill="currentColor" className={`h-2.5 w-2.5 transition-transform ${sortDir === "asc" ? "rotate-180" : ""}`}>
        <path d="m6 9 6 6 6-6" />
      </svg>
    ) : null;

  // 归属市场前端兜底（手动添加的股票没有同步字段时按代码规则判断）
  const boardFallback = (item: Asset) => {
    if (item.board) return item.board;
    const c = item.code.toUpperCase().replace(/[.\-].*$/, "");
    if (item.market === "CN") {
      if (/^(688|689)/.test(c)) return "科创板";
      if (/^(300|301|302)/.test(c)) return "创业板";
      if (/^(8|4|920)/.test(c)) return "北交所";
      return /^6/.test(c) ? "沪主板" : "深主板";
    }
    if (item.market === "HK") return /^08/.test(c) ? "创业板" : "主板";
    // 美股无法从代码推断交易所（如 JPM 纽交所 / DJT 纳斯达克），兜底显示市场名，避免空列；
    // 精确交易所由后台同步 / backfill 补齐
    if (item.market === "US") return "美股";
    return "";
  };

  // 弹窗打开期间轮询同步进度
  useEffect(() => {
    if (!settingsOpen) return;
    refreshSyncStatus();
    const timer = window.setInterval(refreshSyncStatus, 3000);
    return () => window.clearInterval(timer);
  }, [settingsOpen]);

  async function saveMarketIcon(key: string, url: string, id?: string) {
    setBusy((b) => ({ ...b, [`market:${key}`]: true }));
    try {
      const res = await fetch("/api/assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "market", market: key, url: url.trim(), id })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "保存失败");
      window.dispatchEvent(new Event("fire:assets-updated"));
      await loadAssets();
      showToast("市场图标已保存，全局生效");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "保存失败", "err");
    } finally {
      setBusy((b) => ({ ...b, [`market:${key}`]: false }));
    }
  }

  async function saveCountryFlag(country: CountryCatalogItem, url: string, id?: string) {
    const busyKey = `flag:${country.iso2}`;
    setBusy((value) => ({ ...value, [busyKey]: true }));
    try {
      const response = await fetch("/api/assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "flag", market: "COUNTRY", code: country.iso2, name: country.name, url: url.trim(), id })
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error || "保存失败");
      window.dispatchEvent(new Event("fire:assets-updated"));
      await loadAssets(true);
      showToast("国旗已保存，地图与全站同步生效");
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : "保存失败", "err");
    } finally {
      setBusy((value) => ({ ...value, [busyKey]: false }));
    }
  }

  // 券商图标（分组管理中的券商分组）
  function brokerIconOf(groupId: string): string {
    return assets.find((a) => a.type === "broker" && a.code.toLowerCase() === groupId.toLowerCase())?.url ?? "";
  }

  async function saveBrokerIcon(group: { id: string; name: string }, url: string, id?: string) {
    setBusy((b) => ({ ...b, [`broker:${group.id}`]: true }));
    try {
      const res = await fetch("/api/assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "broker", market: "GROUP", code: group.id, name: group.name, url: url.trim(), id })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "保存失败");
      window.dispatchEvent(new Event("fire:assets-updated"));
      await loadAssets();
      showToast("券商图标已保存，全局生效");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "保存失败", "err");
    } finally {
      setBusy((b) => ({ ...b, [`broker:${group.id}`]: false }));
    }
  }

  // 分组图标（素材库-分组图标：非券商自定义分组，走 watch_groups.icon + type=group 素材）
  async function saveGroupIcon(g: WatchGroup, url: string) {
    const busyKey = `group:${g.id}`;
    setBusy((b) => ({ ...b, [busyKey]: true }));
    try {
      const res = await fetch(`/api/v1/watch-groups/${g.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ icon: url })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message || "保存失败");
      window.dispatchEvent(new Event("fire:assets-updated"));
      await loadWatchGroups();
      showToast("分组图标已保存，全局生效");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "保存失败", "err");
    } finally {
      setBusy((b) => ({ ...b, [busyKey]: false }));
    }
  }

  async function clearGroupIcon(g: WatchGroup) {
    const busyKey = `del-group:${g.id}`;
    setBusy((b) => ({ ...b, [busyKey]: true }));
    try {
      const res = await fetch(`/api/v1/watch-groups/${g.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ icon: "" })
      });
      if (!res.ok) throw new Error("清除失败");
      window.dispatchEvent(new Event("fire:assets-updated"));
      await loadWatchGroups();
      showToast("分组图标已清除");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "清除失败", "err");
    } finally {
      setBusy((b) => ({ ...b, [busyKey]: false }));
    }
  }

  // 券商是否已存在（规范名 + 别名 + 证劵/证券归一化，如 IBKR = 盈透证券）
  function brokerExists(name: string, aliases: string[] = []): boolean {
    const keys = new Set([name, ...aliases].map(brokerNameKey));
    return brokerGroups.some((g) => keys.has(brokerNameKey(g.name)));
  }

  // 新增主流券商（一键添加，图标随后在行内上传）
  async function addMainBroker(name: string, aliases: string[] = []) {
    if (brokerExists(name, aliases)) {
      showToast(`${name} 已在券商列表中（含别名）`, "err");
      return;
    }
    setBusy((b) => ({ ...b, [`add-broker:${name}`]: true }));
    try {
      const next = [...brokerGroups, { id: `g${Date.now()}-${brokerGroups.length}`, name, alias: aliases[0] ?? "" }];
      const res = await fetch("/api/v1/brokers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groups: next })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message || "添加失败");
      setBrokerGroups(next);
      await loadAssets();
      showToast(`已添加券商 ${name}，可点击行内图标上传`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "添加失败", "err");
    } finally {
      setBusy((b) => ({ ...b, [`add-broker:${name}`]: false }));
    }
  }

  // 拖动券商行排序（松开后自动保存顺序）
  async function dropBrokerRow(targetIndex: number) {
    const from = brokerDragIndex.current;
    brokerDragIndex.current = null;
    if (from === null || from === targetIndex) return;
    const next = [...brokerGroups];
    const [moved] = next.splice(from, 1);
    next.splice(targetIndex, 0, moved);
    setBrokerGroups(next);
    try {
      const res = await fetch("/api/v1/brokers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groups: next })
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.message || "保存失败");
      showToast("券商顺序已保存");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "保存顺序失败", "err");
    }
  }

  // 删除券商（同步清空对应持仓记录的券商并删除图标素材）
  async function removeBroker(g: { id: string; name: string }) {
    if (!confirm(`确定删除券商「${g.name}」吗？将同时清空该券商名下持仓记录的券商并删除其图标。`)) return;
    setBusy((b) => ({ ...b, [`del-broker:${g.id}`]: true }));
    try {
      const res = await fetch(`/api/v1/brokers?id=${encodeURIComponent(g.id)}`, { method: "DELETE" });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message || "删除失败");
      setBrokerGroups((prev) => prev.filter((x) => x.id !== g.id));
      window.dispatchEvent(new Event("fire:assets-updated"));
      await loadAssets(true);
      showToast(`已删除券商 ${g.name}`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "删除失败", "err");
    } finally {
      setBusy((b) => ({ ...b, [`del-broker:${g.id}`]: false }));
    }
  }

  async function removeMarketIcon(row: MarketRow) {
    if (!confirm(`确定恢复「${row.label}」为默认圆旗吗？`)) return;
    await fetch(`/api/assets?id=${encodeURIComponent(row.id)}`, { method: "DELETE" });
    window.dispatchEvent(new Event("fire:assets-updated"));
    await loadAssets();
    showToast("已恢复默认");
  }

  async function saveAssetIcon(row: AssetRow, url: string) {
    setBusy((b) => ({ ...b, [`asset:${row.key}`]: true }));
    try {
      const res = await fetch("/api/assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: row.type,
          market: "ASSET",
          code: row.key,
          name: row.name,
          url: url.trim(),
          id: row.id || undefined
        })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "保存失败");
      window.dispatchEvent(new Event("fire:assets-updated"));
      await loadAssets();
      showToast(`${row.name}图标已保存，全局生效`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "保存失败", "err");
    } finally {
      setBusy((b) => ({ ...b, [`asset:${row.key}`]: false }));
    }
  }

  async function removeAssetIcon(row: AssetRow) {
    if (!row.id) return;
    if (!confirm(`确定恢复「${row.name}」为默认图标吗？`)) return;
    await fetch(`/api/assets?id=${encodeURIComponent(row.id)}`, { method: "DELETE" });
    window.dispatchEvent(new Event("fire:assets-updated"));
    await loadAssets();
    showToast("已恢复默认");
  }

  // 图标素材（素材库-图标）：上传 / 改名 / 恢复默认，全局生效
  async function saveIconAsset(asset: Asset, patch: { url?: string; urlDark?: string; name?: string }) {
    const busyKey = `icon:${asset.code}`;
    setBusy((b) => ({ ...b, [busyKey]: true }));
    try {
      const name = (patch.name ?? asset.name).trim() || asset.code;
      const url = patch.url !== undefined ? patch.url.trim() : asset.url;
      const urlDark = patch.urlDark !== undefined ? patch.urlDark.trim() : asset.urlDark;
      const res = await fetch("/api/assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "icon",
          market: "OTHER",
          code: asset.code,
          name,
          url,
          urlDark,
          id: asset.id || undefined
        })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "保存失败");
      window.dispatchEvent(new Event("fire:assets-updated"));
      await loadAssets();
      return true;
    } catch (err) {
      showToast(err instanceof Error ? err.message : "保存失败", "err");
      return false;
    } finally {
      setBusy((b) => ({ ...b, [busyKey]: false }));
    }
  }

  async function saveIconName(asset: Asset, raw: string) {
    const name = raw.trim();
    if (!name) {
      showToast("名称不能为空", "err");
      return;
    }
    const ok = await saveIconAsset(asset, { name });
    if (ok) {
      setEditingIcon(null);
      setIconDraft("");
      showToast("图标名称已更新，全局生效");
    }
  }

  // 名称 / 代码点击复制（安全上下文用 Clipboard API，非安全上下文回退 execCommand）
  async function copyIconText(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      showToast(`已复制${label}`);
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        showToast(`已复制${label}`);
      } catch {
        showToast("复制失败，请手动选择复制", "err");
      }
    }
  }

  async function restoreIconAsset(asset: Asset) {
    const defaultIcon = ICON_ORDER.find((c) => c.toUpperCase() === asset.code);
    if (!defaultIcon) {
      // 非内置的新增图标：直接删除素材
      if (!confirm(`确定删除图标「${asset.name || asset.code}」吗？`)) return;
      const res = await fetch(`/api/assets?id=${encodeURIComponent(asset.id)}`, { method: "DELETE" });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        showToast(data?.error || "删除失败", "err");
        return;
      }
      window.dispatchEvent(new Event("fire:assets-updated"));
      await loadAssets();
      showToast("已删除图标");
      return;
    }
    if (!confirm(`确定恢复「${asset.name || asset.code}」为默认图标吗？`)) return;
    const ok = await saveIconAsset(asset, {
      url: `/uploads/asset/icon/${defaultIcon}.svg`,
      name: ICON_NAMES[defaultIcon] ?? defaultIcon,
      urlDark: ""
    });
    if (ok) showToast("已恢复默认图标");
  }

  async function persistOrder(next: string[]) {
    setMarketOrder(next);
    try {
      await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assetMarketOrder: next })
      });
      window.dispatchEvent(new Event("fire:settings-updated"));
    } catch {
      /* 忽略 */
    }
  }

  function dropChip(target: number) {
    const from = dragIndex.current;
    dragIndex.current = null;
    if (from === null || from === target) return;
    const next = [...orderedMarkets];
    const [moved] = next.splice(from, 1);
    next.splice(target, 0, moved);
    persistOrder(next);
  }

  // 股票图标列表：直接读本地素材库（type=stock），按市值排序，无外部请求
  const stockAssets = useMemo(() => {
    const list = assets.filter((a) => a.type === "stock");
    const q = query.trim().toLowerCase();
    const filtered = (selected === "ALL" ? list : list.filter((a) => a.market === selected)).filter(
      (a) => !q || a.code.toLowerCase().includes(q) || a.name.toLowerCase().includes(q)
    );
    const dir = sortDir === "asc" ? 1 : -1;
    const val = (a: Asset): number | string => {
      if (sortKey === "code") return a.code.toUpperCase();
      if (sortKey === "name") return (a.name || "").toLowerCase();
      if (sortKey === "board") return (a.board || "").toLowerCase();
      if (sortKey === "price") return a.price ?? -Infinity;
      if (sortKey === "changePct") return a.changePct ?? -Infinity;
      return a.marketCap;
    };
    return [...filtered].sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      if (typeof va === "number" && typeof vb === "number") {
        if (va === vb) return 0;
        if (va === -Infinity) return 1;
        if (vb === -Infinity) return -1;
        return (va - vb) * dir;
      }
      return String(va).localeCompare(String(vb), "zh-CN") * dir;
    });
  }, [assets, selected, sortKey, sortDir, query]);
  // 所有素材分类统一每页 10 条，保证信息密度与操作位置一致。
  const TOP_PAGE_SIZE = 10;
  const totalPages = Math.max(1, Math.ceil(stockAssets.length / TOP_PAGE_SIZE));
  const safePage = Math.min(topPage, totalPages);
  const pageStock = stockAssets.slice((safePage - 1) * TOP_PAGE_SIZE, safePage * TOP_PAGE_SIZE);
  const allMarketKeys = [...BASE_MARKETS, ...marketRows.map((row) => row.key).filter((key) => !BASE_MARKETS.includes(key) && !NON_TRADABLE_MARKETS.has(key))];
  const activeListCount = tab === "flag" ? filteredCountryRows.length
    : tab === "market" ? allMarketKeys.length
      : tab === "broker" ? brokerGroups.length
        : tab === "group" ? groupRows.length
          : tab === "icon" ? filteredIconRows.length
            : tab === "crypto" || tab === "metal" ? filteredAssetRows.length
              : 0;
  const listTotalPages = Math.max(1, Math.ceil(activeListCount / TOP_PAGE_SIZE));
  const safeListPage = Math.min(listPage, listTotalPages);
  const listStart = (safeListPage - 1) * TOP_PAGE_SIZE;
  const pageCountryRows = filteredCountryRows.slice(listStart, listStart + TOP_PAGE_SIZE);
  const pageMarketKeys = allMarketKeys.slice(listStart, listStart + TOP_PAGE_SIZE);
  const pageBrokerGroups = brokerGroups.slice(listStart, listStart + TOP_PAGE_SIZE);
  const pageGroupRows = groupRows.slice(listStart, listStart + TOP_PAGE_SIZE);
  const pageIconRows = filteredIconRows.slice(listStart, listStart + TOP_PAGE_SIZE);
  const pageAssetRows = filteredAssetRows.slice(listStart, listStart + TOP_PAGE_SIZE);
  return (
    <div className="asset-library-page flex flex-col gap-5">
      <SettingsHeader
        name="sitemanage"
        title="素材库"
        hideIcon
        action={
          <button
            type="button"
            title="素材库设置"
            onClick={() => setSettingsOpen(true)}
            className="flex h-7 w-7 flex-none items-center justify-center rounded-full text-muted transition-colors hover:bg-brand-hover hover:text-brand-deep dark:hover:bg-white/10 dark:hover:text-[#8ec2ff]"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
            </svg>
          </button>
        }
      />

      <div className="asset-library-card flex flex-col gap-5 rounded-card border border-edge bg-white p-3 shadow-card sm:p-6">
        <div className="asset-library-tabs flex max-w-full overflow-x-auto rounded-full border border-edge-strong bg-bg-gray/60 p-0.5 text-xs font-semibold">
          {([
            { key: "stock" as TabKey, label: "股票图标" },
            { key: "crypto" as TabKey, label: "加密货币" },
            { key: "metal" as TabKey, label: "贵金属" },
            { key: "market" as TabKey, label: "市场图标" },
            { key: "flag" as TabKey, label: "国家/地区旗帜" },
            { key: "broker" as TabKey, label: "券商图标" },
            { key: "group" as TabKey, label: "分组图标" },
            { key: "icon" as TabKey, label: "icon" }
          ]).map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`flex-none whitespace-nowrap rounded-full px-4 py-2 transition-colors duration-200 ${tab === t.key ? "seg-active" : "text-muted hover:text-ink"}`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === "stock" && (
          <div className="flex flex-col gap-4">
            {/* 可拖动市场（全部 + 各市场） */}
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[11px] font-semibold text-faint">市场（按住拖动排序）</span>
                <span className="text-[11px] text-faint">{stockAssets.length > 0 ? `${stockAssets.length} 只` : ""}</span>
              </div>
              <div className="asset-library-market-tools relative flex flex-wrap items-center gap-1.5">
                {(["ALL", ...orderedMarkets.slice(0, 5)] as string[]).map((m, i) => (
                  <button
                    key={m}
                    type="button"
                    draggable={m !== "ALL"}
                    onDragStart={(e) => {
                      if (m === "ALL") return;
                      dragIndex.current = i - 1;
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => dropChip(i - 1)}
                    onDragEnd={() => {
                      dragIndex.current = null;
                    }}
                    onClick={() => setSelected(m)}
                    title={m === "ALL" ? "全部股票" : "按住拖动排序"}
                    className={`flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition-all duration-200 ${
                      selected === m
                        ? "border-edge-strong/50 bg-brand-light text-brand-deep shadow-[0_0_0_3px_rgba(107,114,128,.07)]"
                        : "border-edge bg-white text-muted hover:bg-brand-hover hover:text-ink active:bg-bg-gray"
                    } ${m !== "ALL" ? "active:cursor-grabbing" : ""}`}
                  >
                    {m === "ALL" ? (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                        <rect x="3.5" y="3.5" width="7" height="7" rx="1.8" />
                        <rect x="13.5" y="3.5" width="7" height="7" rx="1.8" />
                        <rect x="3.5" y="13.5" width="7" height="7" rx="1.8" />
                        <rect x="13.5" y="13.5" width="7" height="7" rx="1.8" />
                      </svg>
                    ) : (
                      <MarketIcon market={m} size={16} />
                    )}
                    {m === "ALL" ? "全部" : marketLabelOf(m)}
                    {m !== "ALL" && (
                      <svg viewBox="0 0 24 24" fill="currentColor" className="h-3 w-3 opacity-40">
                        <circle cx="9" cy="6" r="1.2" /><circle cx="15" cy="6" r="1.2" />
                        <circle cx="9" cy="12" r="1.2" /><circle cx="15" cy="12" r="1.2" />
                        <circle cx="9" cy="18" r="1.2" /><circle cx="15" cy="18" r="1.2" />
                      </svg>
                    )}
                  </button>
                ))}
                {orderedMarkets.length > 5 && (
                  <>
                    {/* 点击外部关闭弹层 */}
                    {marketMenuOpen && <div className="fixed inset-0 z-30" onClick={() => setMarketMenuOpen(false)} />}
                    {/* 更多市场：圆形按钮 + 跟随按钮展开的下拉弹层（不再贴容器最右缘） */}
                    <div className="relative">
                      <button
                        type="button"
                        onClick={() => setMarketMenuOpen((v) => !v)}
                        title="更多市场"
                        aria-expanded={marketMenuOpen}
                        className={`flex h-9 w-9 cursor-pointer items-center justify-center rounded-full text-ink transition-all duration-200 ${
                          marketMenuOpen ? "bg-brand-hover text-ink dark:bg-white/10 dark:text-white" : "bg-bg-gray hover:bg-brand-hover hover:text-ink dark:bg-[#1c222d] dark:text-[#d9e1ec] dark:hover:bg-white/10"
                        }`}
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px]">
                          <rect x="3" y="3" width="7" height="7" rx="2" />
                          <rect x="14" y="3" width="7" height="7" rx="2" />
                          <rect x="3" y="14" width="7" height="7" rx="2" />
                          <rect x="14" y="14" width="7" height="7" rx="2" />
                        </svg>
                      </button>
                      {/* 下拉弹层：右对齐「更多」按钮展开（左侧空间充裕，不会溢出屏幕右侧） */}
                      {marketMenuOpen && (
                        <>
                          {/* 指向按钮的小三角 */}
                          <div className="absolute right-3.5 top-full z-40 mt-[5px] h-2 w-2 rotate-45 border-l border-t border-edge bg-white dark:border-[#3b4354] dark:bg-[#1c1c1e]" />
                          <div className="popover-in absolute right-0 top-full z-40 mt-3 w-56 overflow-hidden rounded-[14px] border border-edge bg-white p-2 shadow-pop dark:border-[#3b4354] dark:bg-[#1c1c1e]">
                            <div className="mb-1 flex items-center justify-between px-2 pt-0.5">
                              <p className="text-[11px] font-semibold text-faint">更多市场</p>
                              <span className="text-[10px] font-medium text-faint">{orderedMarkets.length - 5} 个</span>
                            </div>
                            <div className="max-h-80 overflow-y-auto">
                              {orderedMarkets.slice(5).map((m) => (
                                <button
                                  key={m}
                                  type="button"
                                  onClick={() => {
                                    setSelected(m);
                                    setMarketMenuOpen(false);
                                  }}
                                  className={`flex w-full items-center gap-2.5 rounded-[10px] px-2 py-1.5 text-left text-sm transition-colors ${
                                    selected === m
                                      ? "bg-[#3297f6] font-semibold text-white shadow-sm"
                                      : "text-ink-2 hover:bg-[#f2f3f5] dark:hover:bg-white/[0.07]"
                                  }`}
                                >
                                  <MarketIcon market={m} size={20} />
                                  <span className="min-w-0 flex-1 truncate">{marketLabelOf(m)}</span>
                                  {selected === m && (
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5 flex-none">
                                      <path d="m5 13 4 4L19 7" />
                                    </svg>
                                  )}
                                </button>
                              ))}
                            </div>
                          </div>
                        </>
                      )}
                    </div>
                  </>
                )}
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜索名称 / 代码"
                  className="ml-auto h-[34px] w-[180px] rounded-full border border-edge-strong bg-white px-3.5 text-xs outline-none transition-shadow focus:border-edge-strong focus:shadow-[0_0_0_3px_rgba(107,114,128,.14)] dark:bg-[#151a26] dark:text-[#e5e7eb]"
                />
              </div>
            </div>

            {/* 股票图标列表（微牛样式：白卡片 + 表头 + 行） */}
            {assetsLoading ? (
              <div className="asset-library-stock-list overflow-x-auto rounded-[14px] border border-edge bg-white shadow-card dark:bg-[#16181d]">
                <div className="asset-library-stock-row grid min-w-[680px] grid-cols-[56px_minmax(190px,1fr)_90px_82px_82px_140px] items-center gap-2 border-b border-edge bg-[#f6f7f9] px-4 py-2 text-[11px] font-semibold text-muted dark:bg-white/5">
                  <span>序号</span>
                  <span>名称 / 代码</span>
                  <span className="text-right">市值</span>
                  <span className="text-right">最新价</span>
                  <span className="text-right">涨跌幅</span>
                  <span>市场</span>
                </div>
                {Array.from({ length: 10 }).map((_, i) => (
                  <div key={i} className="asset-library-stock-row grid min-w-[680px] grid-cols-[56px_minmax(190px,1fr)_90px_82px_82px_140px] items-center gap-2 border-b border-edge px-4 py-2.5 dark:border-[#2a2f3a]">
                    <span className="h-4 w-4 animate-pulse rounded-full bg-bg-gray dark:bg-white/10" />
                    <span className="flex items-center gap-2.5">
                      <span className="h-9 w-9 animate-pulse rounded-full bg-bg-gray dark:bg-white/10" />
                      <span className="h-3 w-24 animate-pulse rounded bg-bg-gray dark:bg-white/10" />
                    </span>
                    <span className="h-3 w-14 animate-pulse justify-self-end rounded bg-bg-gray dark:bg-white/10" />
                    <span className="h-3 w-12 animate-pulse justify-self-end rounded bg-bg-gray dark:bg-white/10" />
                    <span className="h-3 w-12 animate-pulse justify-self-end rounded bg-bg-gray dark:bg-white/10" />
                    <span className="h-3 w-16 animate-pulse rounded bg-bg-gray dark:bg-white/10" />
                  </div>
                ))}
              </div>
            ) : pageStock.length === 0 ? (
              query.trim() ? (
                <div className="rounded-[12px] border border-dashed border-edge-strong p-4">
                  <div className="flex items-center justify-between gap-3">
                    <p className="min-w-0 truncate text-sm text-faint">素材库中没有找到「{query.trim()}」</p>
                    <button type="button" onClick={() => void loadAddCandidates("stock")} disabled={adding} className="btn btn-line btn-sm flex-none disabled:opacity-60">
                      {adding ? "匹配中…" : "+ 添加"}
                    </button>
                  </div>
                  {addCandidates?.type === "stock" && (
                    <div className="mt-3 space-y-1.5">
                      <p className="text-[11px] font-semibold text-faint">行情源匹配 {addCandidates.items.length} 个，选择添加：</p>
                      {addCandidates.items.map((c) => (
                        <div key={c.symbol ?? c.code} className="flex items-center justify-between gap-3 rounded-[10px] border border-edge px-3 py-2">
                          <span className="flex min-w-0 items-center gap-2">
                            <MarketIcon market={c.market} size={18} />
                            <span className="truncate font-semibold text-ink">{c.name}</span>
                            <span className="flex-none text-[11px] text-faint">{c.code}</span>
                            <span className="flex-none text-[11px] text-faint">{marketLabelOf(c.market)}</span>
                          </span>
                          <button
                            type="button"
                            disabled={!!busy[`add:${c.market}:${c.code}`]}
                            onClick={() => void addCandidate(c, "stock")}
                            className="btn btn-line btn-sm flex-none disabled:opacity-60"
                          >
                            {busy[`add:${c.market}:${c.code}`] ? "添加中…" : "添加"}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  {manualAdd && (
                    <div className="mt-3 rounded-[10px] border border-edge p-3">
                      <p className="mb-2 text-[11px] font-semibold text-faint">行情源未匹配到，可手动添加：</p>
                      <div className="flex flex-wrap items-center gap-2">
                        <select
                          value={manualAdd.market}
                          onChange={(e) => setManualAdd({ ...manualAdd, market: e.target.value as "US" | "HK" | "CN" })}
                          className={`${inputCls} h-8 w-[88px] px-2 text-xs`}
                        >
                          <option value="US">美股</option>
                          <option value="HK">港股</option>
                          <option value="CN">A股</option>
                        </select>
                        <input
                          value={manualAdd.code}
                          onChange={(e) => setManualAdd({ ...manualAdd, code: e.target.value })}
                          placeholder="代码，如 000610"
                          className={`${inputCls} h-8 w-[126px] px-2 text-xs`}
                        />
                        <input
                          value={manualAdd.name}
                          onChange={(e) => setManualAdd({ ...manualAdd, name: e.target.value })}
                          placeholder="名称（默认搜索词）"
                          className={`${inputCls} h-8 min-w-[140px] flex-1 px-2 text-xs`}
                        />
                        <button
                          type="button"
                          disabled={!!busy["manual-add"]}
                          onClick={() => void saveManualAdd()}
                          className="btn btn-line btn-sm flex-none disabled:opacity-60"
                        >
                          {busy["manual-add"] ? "添加中…" : "保存添加"}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <p className="rounded-[12px] border border-dashed border-edge-strong py-10 text-center text-sm text-faint">
                  暂无股票图标，可点击右上角「设置」同步大市值股票
                </p>
              )
            ) : (
              <div className="asset-library-stock-list overflow-x-auto rounded-[14px] border border-edge bg-white shadow-card dark:bg-[#16181d]">
                <div className="asset-library-stock-row grid min-w-[680px] grid-cols-[56px_minmax(190px,1fr)_90px_82px_82px_140px] items-center gap-2 border-b border-edge bg-[#f6f7f9] px-4 py-2 text-[11px] font-semibold text-muted dark:bg-white/5">
                  <button type="button" onClick={() => toggleSort("rank")} className={`inline-flex items-center gap-1 text-left transition-colors ${sortKey === "rank" ? "text-brand-deep" : "hover:text-ink"}`}>
                    序号 <SortArrow k="rank" />
                  </button>
                  <button type="button" onClick={() => toggleSort("name")} className={`inline-flex min-w-0 items-center gap-1 text-left transition-colors ${sortKey === "name" ? "text-brand-deep" : "hover:text-ink"}`}>
                    名称 / 代码 <SortArrow k="name" />
                  </button>
                  <button type="button" onClick={() => toggleSort("marketCap")} className={`inline-flex items-center justify-end gap-1 text-right transition-colors ${sortKey === "marketCap" ? "text-brand-deep" : "hover:text-ink"}`}>
                    市值 <SortArrow k="marketCap" />
                  </button>
                  <button type="button" onClick={() => toggleSort("price")} className={`inline-flex items-center justify-end gap-1 text-right transition-colors ${sortKey === "price" ? "text-brand-deep" : "hover:text-ink"}`}>
                    最新价 <SortArrow k="price" />
                  </button>
                  <button type="button" onClick={() => toggleSort("changePct")} className={`inline-flex items-center justify-end gap-1 text-right transition-colors ${sortKey === "changePct" ? "text-brand-deep" : "hover:text-ink"}`}>
                    涨跌幅 <SortArrow k="changePct" />
                  </button>
                  <button type="button" onClick={() => toggleSort("board")} className={`inline-flex items-center justify-end gap-1 text-right transition-colors ${sortKey === "board" ? "text-brand-deep" : "hover:text-ink"}`}>
                    市场 <SortArrow k="board" />
                  </button>
                </div>
                {pageStock.map((item, index) => {
                  const rank = stockAssets.indexOf(item) + 1;
                  const key = `${item.market}:${item.code}`;
                  const saving = busy[key];
                  const isUp = (item.changePct ?? 0) >= 0;
                  return (
                    <div
                      key={key}
                      className="asset-library-stock-row grid min-w-[680px] grid-cols-[56px_minmax(190px,1fr)_90px_82px_82px_140px] items-center gap-2 border-b border-edge px-4 py-2 text-sm last:border-0 hover:bg-brand-hover/40 dark:border-[#2a2f3a] dark:hover:bg-white/5"
                    >
                      <span
                        className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold ${
                          rank <= 3 ? "bg-brand-light text-brand-deep" : "bg-bg-gray text-muted"
                        }`}
                        title={`市值第 ${rank}`}
                      >
                        {rank}
                      </span>
                      <span className="flex min-w-0 items-center gap-2.5">
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() => fileRefs.current[key]?.click()}
                          className="group relative flex-none"
                          title="点击上传/更换图标"
                        >
                          <Avatar src={displayUrl(item)} name={displayName(item)} size={36} />
                          <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/45 text-white opacity-0 transition-opacity duration-200 group-hover:opacity-100">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
                              <path d="M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4z" />
                              <circle cx="12" cy="13" r="3" />
                            </svg>
                          </span>
                        </button>
                        <input
                          ref={(el) => {
                            fileRefs.current[key] = el;
                          }}
                          type="file"
                          accept="image/jpeg,image/png,image/gif,image/webp,image/svg+xml"
                          className="hidden"
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) uploadStock(item, f);
                            e.target.value = "";
                          }}
                        />
                      <span className="min-w-0">
                        <span className="block truncate font-semibold text-ink">{displayName(item)}</span>
                        <span className="block truncate text-[11px] text-faint">{item.code}</span>
                      </span>
                      </span>
                      <span className="text-right tabular-nums text-faint">{fmtUsd(usdCap(item.market, item.marketCap, rates)) || "—"}</span>
                      <span className="text-right tabular-nums text-ink-2">
                        {item.price != null ? fmtPrice(item.market, item.price) : "—"}
                      </span>
                      <span className={`text-right tabular-nums ${isUp ? UP : DOWN}`}>
                        {item.changePct != null ? `${item.changePct >= 0 ? "+" : ""}${item.changePct.toFixed(2)}%` : "—"}
                      </span>
                      <span className="flex min-w-0 items-center justify-end gap-1.5 text-xs text-muted">
                        <MarketIcon market={item.market} size={14} />
                        <span className="truncate">{boardFallback(item) || "—"}</span>
                      </span>
                    </div>
                  );
                })}
              </div>
            )}

            {/* 分页：智能页码 + 首页/末页/跳转 */}
            {stockAssets.length > TOP_PAGE_SIZE && (
              <Pagination page={safePage} total={totalPages} onChange={setTopPage} />
            )}

          </div>
        )}

        {(tab === "market" || tab === "flag" || tab === "broker" || tab === "group" || tab === "crypto" || tab === "metal" || tab === "icon") && (
          <div className="overflow-x-auto rounded-[14px] border border-edge bg-white shadow-card dark:bg-[#16181d]">
            {tab === "flag" ? (
              <>
                <div className="flex items-center justify-between gap-3 border-b border-edge bg-[#f6f7f9] px-4 py-2.5 dark:bg-white/5">
                  <span className="text-[11px] font-semibold text-faint">国家/地区旗帜 · {filteredCountryRows.length} 个</span>
                  <input
                    value={flagQuery}
                    onChange={(event) => setFlagQuery(event.target.value)}
                    placeholder="搜索中文名 / ISO2"
                    className="h-[34px] w-[190px] rounded-full border border-edge-strong bg-white px-3.5 text-xs outline-none transition-shadow focus:shadow-[0_0_0_3px_rgba(107,114,128,.14)] dark:bg-[#151a26] dark:text-[#e5e7eb]"
                  />
                </div>
                <div className="grid grid-cols-[40px_minmax(0,1fr)] items-center gap-2 border-b border-edge bg-[#f6f7f9] px-4 py-2 text-[11px] font-semibold text-muted dark:bg-white/5">
                  <span>序号</span>
                  <span>国家/地区</span>
                </div>
                {countryRows.length === 0 ? (
                  <div className="space-y-2 p-4" aria-label="加载国家和地区旗帜">
                    {Array.from({ length: 6 }).map((_, index) => <div key={index} className="h-11 animate-pulse rounded-lg bg-bg-gray dark:bg-white/5" />)}
                  </div>
                ) : filteredCountryRows.length === 0 ? (
                  <p className="py-10 text-center text-sm text-faint">没有匹配的国家或地区</p>
                ) : pageCountryRows.map((country, index) => {
                  const custom = assets.find((asset) => asset.type === "flag" && asset.code.toUpperCase() === country.iso2);
                  const busyKey = `flag:${country.iso2}`;
                  // 默认本地开源高清 SVG（lipis/flag-icons 4x3，public/uploads/asset/flag/{iso2}.svg）
                  const src = custom?.url || defaultFlagUrl(country.flagCode);
                  return (
                    <div key={country.iso2} className="grid grid-cols-[40px_minmax(0,1fr)] items-center gap-2 border-b border-edge px-4 py-2.5 text-sm last:border-0 hover:bg-brand-hover/40 dark:border-[#2a2f3a] dark:hover:bg-white/5">
                      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-bg-gray text-[10px] font-bold text-muted">{listStart + index + 1}</span>
                      <span className="flex min-w-0 items-center gap-2.5">
                        <button
                          type="button"
                          disabled={!!busy[busyKey]}
                          onClick={() => fileRefs.current[busyKey]?.click()}
                          className="group relative flex h-9 w-9 flex-none items-center justify-center overflow-hidden rounded-full border border-edge bg-white shadow-[0_1px_3px_rgba(10,14,25,.08)] dark:bg-[#1c1c1e]"
                          title="点击上传自定义旗帜"
                        >
                          <span className="absolute inset-0 grid place-items-center text-xl">{country.flag}</span>
                          <img src={src} alt="" className="relative h-full w-full rounded-full object-cover" onError={(event) => { event.currentTarget.style.display = "none"; }} />
                          <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/45 text-white opacity-0 transition-opacity duration-200 group-hover:opacity-100">
                            {busy[busyKey] ? (
                              <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.3" /><path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
                            ) : (
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4z" /><circle cx="12" cy="13" r="3" /></svg>
                            )}
                          </span>
                        </button>
                        <input
                          ref={(element) => { fileRefs.current[busyKey] = element; }}
                          type="file"
                          accept="image/jpeg,image/png,image/gif,image/webp,image/svg+xml"
                          className="hidden"
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            if (file) {
                              const form = new FormData();
                              form.append("kind", "asset");
                              form.append("folder", "flag");
                              form.append("code", country.iso2);
                              form.append("name", country.name);
                              form.append("file", file);
                              fetch("/api/upload", { method: "POST", body: form })
                                .then((response) => response.json())
                                .then((body) => { if (body?.url) void saveCountryFlag(country, body.url, custom?.id); })
                                .catch(() => showToast("上传失败", "err"));
                            }
                            event.target.value = "";
                          }}
                        />
                        <span className="min-w-0">
                          <span className="block truncate font-semibold text-ink">{country.name}</span>
                          <span className="block text-[11px] text-faint">{country.iso2}{custom ? " · 已自定义" : " · 内置"}</span>
                        </span>
                      </span>
                    </div>
                  );
                })}
              </>
            ) : tab === "market" ? (
              <>
                <div className="grid grid-cols-[40px_minmax(0,1fr)] items-center gap-2 border-b border-edge bg-[#f6f7f9] px-4 py-2 text-[11px] font-semibold text-muted dark:bg-white/5">
                  <span>序号</span>
                  <span>市场</span>
                </div>
                {pageMarketKeys.map((key, i) => {
                  const row = marketRows.find((r) => r.key === key);
                  const label = marketLabelOf(key);
                  const url = row?.url ?? "";
                  const busyKey = `market:${key}`;
                  return (
                    <div key={key} className="grid grid-cols-[40px_minmax(0,1fr)] items-center gap-2 border-b border-edge px-4 py-2.5 text-sm last:border-0 hover:bg-brand-hover/40 dark:border-[#2a2f3a] dark:hover:bg-white/5">
                      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-bg-gray text-[10px] font-bold text-muted">{listStart + i + 1}</span>
                      <span className="flex min-w-0 items-center gap-2.5">
                        <button
                          type="button"
                          disabled={!!busy[busyKey]}
                          onClick={(e) => (e.currentTarget.closest("div")?.querySelector('input[type="file"]') as HTMLInputElement | null)?.click()}
                          className="group relative flex h-9 w-9 flex-none items-center justify-center overflow-hidden rounded-full border border-edge bg-white shadow-[0_1px_3px_rgba(10,14,25,.08)] dark:bg-[#1c1c1e]"
                          title="点击上传/更换图标"
                        >
                          {url ? <img src={url} alt="" className="h-full w-full rounded-full object-cover" /> : <MarketIcon market={key} size={24} />}
                          <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/45 text-white opacity-0 transition-opacity duration-200 group-hover:opacity-100">
                            {busy[busyKey] ? (
                              <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.3" />
                                <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                              </svg>
                            ) : (
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                                <path d="M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4z" />
                                <circle cx="12" cy="13" r="3" />
                              </svg>
                            )}
                          </span>
                        </button>
                        {editingLabel === key ? (
                          <>
                            <input
                              autoFocus
                              value={labelDraft}
                              onChange={(e) => setLabelDraft(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  void saveMarketLabel(key, labelDraft);
                                }
                                if (e.key === "Escape") setEditingLabel(null);
                              }}
                              className={`${inputCls} h-8 w-28 px-2 text-sm`}
                            />
                            <span className="flex flex-none items-center gap-1">
                              <button
                                type="button"
                                disabled={!!busy[`label:${key}`]}
                                onClick={() => void saveMarketLabel(key, labelDraft)}
                                title="保存名称"
                                className="flex h-6 w-6 flex-none items-center justify-center rounded-full text-muted transition-colors hover:bg-brand-hover hover:text-ink"
                              >
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
                                  <path d="m5 13 4 4L19 7" />
                                </svg>
                              </button>
                              <button
                                type="button"
                                onClick={() => setEditingLabel(null)}
                                title="取消"
                                className="flex h-6 w-6 flex-none items-center justify-center rounded-full text-muted transition-colors hover:bg-brand-hover hover:text-ink"
                              >
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-3.5 w-3.5">
                                  <path d="M18 6 6 18" /><path d="m6 6 12 12" />
                                </svg>
                              </button>
                            </span>
                          </>
                        ) : (
                          <>
                            <span className="min-w-0">
                              <span className="block truncate font-semibold text-ink">{label}</span>
                              <span className="block truncate text-[11px] text-faint">{key}</span>
                            </span>
                            <button
                              type="button"
                              onClick={() => {
                                setEditingLabel(key);
                                setLabelDraft(label);
                              }}
                              title="编辑市场名称"
                              className="flex h-6 w-6 flex-none items-center justify-center rounded-full text-muted transition-colors hover:bg-brand-hover hover:text-ink"
                            >
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
                                <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                              </svg>
                            </button>
                          </>
                        )}
                      </span>
                      <input
                        ref={(el) => {
                          fileRefs.current[busyKey] = el;
                        }}
                        type="file"
                        accept="image/jpeg,image/png,image/gif,image/webp,image/svg+xml"
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) {
                            const fd = new FormData();
                            fd.append("kind", "asset");
                            fd.append("folder", "market");
                            fd.append("market", key);
                            fd.append("name", label);
                            fd.append("file", f);
                            fetch("/api/upload", { method: "POST", body: fd })
                              .then((r) => r.json())
                              .then((d) => {
                                if (d?.url) saveMarketIcon(key, d.url, row?.id);
                              })
                              .catch(() => showToast("上传失败", "err"));
                          }
                          e.target.value = "";
                        }}
                      />

                    </div>
                  );
                })}
              </>
            ) : tab === "broker" ? (
              <>
                <div className="grid grid-cols-[40px_minmax(0,1fr)_32px] items-center gap-2 border-b border-edge bg-[#f6f7f9] px-4 py-2 text-[11px] font-semibold text-muted dark:bg-white/5">
                  <span>序号</span>
                  <span>券商</span>
                  <span />
                </div>
                {brokerGroups.length === 0 ? (
                  <p className="py-10 text-center text-sm text-faint">
                    暂无券商，可在下方添加主流券商，或到 设置 → 股票设置 → 券商管理 中创建
                  </p>
                ) : (
                  pageBrokerGroups.map((g, i) => {
                    const url = brokerIconOf(g.id);
                    const busyKey = `broker:${g.id}`;
                    return (
                      <div
                        key={g.id}
                        draggable
                        onDragStart={(e) => {
                          brokerDragIndex.current = listStart + i;
                          e.dataTransfer.effectAllowed = "move";
                        }}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={() => void dropBrokerRow(listStart + i)}
                        onDragEnd={() => {
                          brokerDragIndex.current = null;
                        }}
                        className="grid cursor-grab grid-cols-[40px_minmax(0,1fr)_32px] items-center gap-2 border-b border-edge px-4 py-2.5 text-sm last:border-0 hover:bg-brand-hover/40 active:cursor-grabbing dark:border-[#2a2f3a] dark:hover:bg-white/5"
                        title="按住拖动排序"
                      >
                      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-bg-gray text-[10px] font-bold text-muted">{listStart + i + 1}</span>
                      <span className="flex min-w-0 items-center gap-2.5">
                        <svg viewBox="0 0 24 24" fill="currentColor" className="h-3.5 w-3.5 flex-none cursor-grab text-faint active:cursor-grabbing">
                          <circle cx="9" cy="6" r="1.2" /><circle cx="15" cy="6" r="1.2" />
                          <circle cx="9" cy="12" r="1.2" /><circle cx="15" cy="12" r="1.2" />
                          <circle cx="9" cy="18" r="1.2" /><circle cx="15" cy="18" r="1.2" />
                        </svg>
                        <button
                            type="button"
                            disabled={!!busy[busyKey]}
                            onClick={(e) => (e.currentTarget.closest("div")?.querySelector('input[type="file"]') as HTMLInputElement | null)?.click()}
                            className="group relative flex h-9 w-9 flex-none items-center justify-center overflow-hidden rounded-full border border-edge bg-white shadow-[0_1px_3px_rgba(10,14,25,.08)] dark:bg-[#1c1c1e]"
                            title="点击上传/更换券商图标"
                          >
                            {url ? (
                              <img src={url} alt="" className="h-full w-full rounded-full object-cover" />
                            ) : (
                              <span className="flex h-full w-full items-center justify-center rounded-full bg-bg-gray text-[11px] font-bold text-muted">
                                {(g.name || "?").slice(0, 1)}
                              </span>
                            )}
                            <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/45 text-white opacity-0 transition-opacity duration-200 group-hover:opacity-100">
                              {busy[busyKey] ? (
                                <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.3" />
                                  <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                                </svg>
                              ) : (
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                                  <path d="M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4z" />
                                  <circle cx="12" cy="13" r="3" />
                                </svg>
                              )}
                            </span>
                          </button>
                          <span className="min-w-0">
                            <span className="block truncate font-semibold text-ink">{g.name}</span>
                            {g.alias ? (
                              <span className="block truncate text-[11px] text-faint">{g.alias}</span>
                            ) : null}
                          </span>
                          <input
                            ref={(el) => {
                              fileRefs.current[busyKey] = el;
                            }}
                            type="file"
                            accept="image/jpeg,image/png,image/gif,image/webp,image/svg+xml"
                            className="hidden"
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              if (f) {
                                const fd = new FormData();
                                fd.append("kind", "asset");
                                fd.append("folder", "broker");
                                fd.append("name", g.name);
                                fd.append("file", f);
                                fetch("/api/upload", { method: "POST", body: fd })
                                  .then((r) => r.json())
                                  .then((d) => {
                                    if (d?.url) {
                                      const row = assets.find((a) => a.type === "broker" && a.code.toLowerCase() === g.id.toLowerCase());
                                      void saveBrokerIcon(g, d.url, row?.id);
                                    }
                                  })
                                  .catch(() => showToast("上传失败", "err"));
                              }
                              e.target.value = "";
                            }}
                          />
                        </span>
                        <span className="flex items-center justify-center">
                          <button
                            type="button"
                            disabled={!!busy[`del-broker:${g.id}`]}
                            onClick={() => void removeBroker(g)}
                            title="删除券商"
                            className="inline-flex h-7 w-7 flex-none items-center justify-center rounded-[8px] border border-edge text-muted transition-all duration-200 hover:border-down/40 hover:bg-down/10 hover:text-down active:scale-[.97] disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:hover:bg-down/20"
                          >
                            <DeleteIcon size={14} />
                          </button>
                        </span>
                      </div>
                    );
                  })
                )}
                {/* 新增主流券商 */}
                <div className="border-t border-edge p-4">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <p className="text-xs font-bold text-muted">新增主流券商</p>
                  </div>
                  <div className="mb-2.5 flex flex-wrap gap-1.5">
                    {MAIN_BROKERS.map((sec) => (
                      <button
                        key={sec.region}
                        type="button"
                        onClick={() => setBrokerRegion(sec.region)}
                        className={`rounded-full px-3 py-1 text-xs transition-colors ${
                          brokerRegion === sec.region ? "seg-active" : "text-muted hover:text-ink"
                        }`}
                      >
                        {sec.region}
                      </button>
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {MAIN_BROKERS.find((s) => s.region === brokerRegion)?.items.map((it) => {
                      const exists = brokerExists(it.name, it.aliases ?? []);
                      const adding = !!busy[`add-broker:${it.name}`];
                      return (
                        <button
                          key={it.name}
                          type="button"
                          disabled={exists || adding}
                          onClick={() => void addMainBroker(it.name, it.aliases ?? [])}
                          className={`rounded-full border px-3 py-1.5 text-xs transition-colors disabled:cursor-default ${
                            exists
                              ? "border-edge bg-bg-gray/50 text-faint dark:text-[#99a3b2]"
                              : "border-edge bg-white text-ink-2 hover:bg-brand-hover hover:text-ink dark:bg-[#151a26] dark:text-[#e5e7eb] dark:hover:bg-white/10"
                          } dark:bg-[#1c222d] dark:text-[#d9e1ec]`}
                        >
                          {adding ? "添加中…" : exists ? `✓ ${it.name}` : it.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </>
            ) : tab === "group" ? (
              <>
                <div className="grid grid-cols-[40px_minmax(0,1fr)_32px] items-center gap-2 border-b border-edge bg-[#f6f7f9] px-4 py-2 text-[11px] font-semibold text-muted dark:bg-white/5">
                  <span>序号</span>
                  <span>分组（非券商自定义分组）</span>
                  <span />
                </div>
                {groupRows.length === 0 ? (
                  <p className="py-10 text-center text-sm text-faint">
                    暂无分组图标，可到 自选股 → 全部分组 → 管理分组 上传
                  </p>
                ) : (
                  pageGroupRows.map((g, i) => {
                    const busyKey = `group:${g.id}`;
                    return (
                      <div
                        key={g.id}
                        className="grid grid-cols-[40px_minmax(0,1fr)_32px] items-center gap-2 border-b border-edge px-4 py-2.5 text-sm last:border-0 hover:bg-brand-hover/40 dark:border-[#2a2f3a] dark:hover:bg-white/5"
                      >
                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-bg-gray text-[10px] font-bold text-muted">{listStart + i + 1}</span>
                        <span className="flex min-w-0 items-center gap-2.5">
                          <button
                            type="button"
                            disabled={!!busy[busyKey]}
                            onClick={(e) => (e.currentTarget.closest("div")?.querySelector('input[type="file"]') as HTMLInputElement | null)?.click()}
                            className="group relative flex h-9 w-9 flex-none items-center justify-center overflow-hidden rounded-full border border-edge bg-white shadow-[0_1px_3px_rgba(10,14,25,.08)] dark:bg-[#1c1c1e]"
                            title="点击上传/更换分组图标"
                          >
                            {g.icon ? (
                              <img src={g.icon} alt="" className="h-full w-full rounded-full object-cover" />
                            ) : (
                              <span className="flex h-full w-full items-center justify-center rounded-full bg-bg-gray text-[11px] font-bold text-muted">
                                {(g.name || "?").slice(0, 1)}
                              </span>
                            )}
                            <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/45 text-white opacity-0 transition-opacity duration-200 group-hover:opacity-100">
                              {busy[busyKey] ? (
                                <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.3" />
                                  <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                                </svg>
                              ) : (
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                                  <path d="M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4z" />
                                  <circle cx="12" cy="13" r="3" />
                                </svg>
                              )}
                            </span>
                          </button>
                          <span className="min-w-0">
                            <span className="block truncate font-semibold text-ink">{g.name}</span>
                          </span>
                          <input
                            ref={(el) => {
                              fileRefs.current[busyKey] = el;
                            }}
                            type="file"
                            accept="image/jpeg,image/png,image/gif,image/webp,image/svg+xml"
                            className="hidden"
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              if (f) {
                                const fd = new FormData();
                                fd.append("kind", "asset");
                                fd.append("folder", "group");
                                fd.append("name", g.name);
                                fd.append("file", f);
                                fetch("/api/upload", { method: "POST", body: fd })
                                  .then((r) => r.json())
                                  .then((d) => {
                                    if (d?.url) return saveGroupIcon(g, d.url);
                                    throw new Error(d?.error || "上传失败");
                                  })
                                  .catch((err) => showToast(err instanceof Error ? err.message : "上传失败", "err"));
                              }
                              e.target.value = "";
                            }}
                          />
                        </span>
                        <span className="flex items-center justify-center">
                          <button
                            type="button"
                            disabled={!g.icon || !!busy[`del-group:${g.id}`]}
                            onClick={() => void clearGroupIcon(g)}
                            title="清除分组图标"
                            className="inline-flex h-7 w-7 flex-none items-center justify-center rounded-[8px] border border-edge text-muted transition-all duration-200 hover:border-down/40 hover:bg-down/10 hover:text-down active:scale-[.97] disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/10 dark:hover:bg-down/20"
                          >
                            <DeleteIcon size={14} />
                          </button>
                        </span>
                      </div>
                    );
                  })
                )}
              </>
            ) : tab === "icon" ? (
              <>
                {/* 搜索栏：图标素材 */}
                <div className="flex items-center justify-between gap-3 border-b border-edge px-4 py-2.5">
                  <span className="text-[11px] font-semibold text-faint">图标 · {filteredIconRows.length} 个</span>
                  <input
                    value={iconQuery}
                    onChange={(e) => setIconQuery(e.target.value)}
                    placeholder="搜索名称 / 代码"
                    className="ml-auto h-[34px] w-[180px] rounded-full border border-edge-strong bg-white px-3.5 text-xs outline-none transition-shadow focus:border-edge-strong focus:shadow-[0_0_0_3px_rgba(107,114,128,.14)] dark:bg-[#151a26] dark:text-[#e5e7eb]"
                  />
                </div>
                <div className="grid grid-cols-[40px_minmax(0,1fr)_88px] items-center gap-2 border-b border-edge bg-[#f6f7f9] px-4 py-2 text-[11px] font-semibold text-muted dark:bg-white/5">
                  <span>序号</span>
                  <span>名称 / 代码</span>
                  <span className="text-right">操作</span>
                </div>
                {filteredIconRows.length === 0 ? (
                  <p className="py-10 text-center text-sm text-faint">
                    {iconQuery.trim() ? `素材库中没有找到「${iconQuery.trim()}」` : "暂无图标素材"}
                  </p>
                ) : (
                  pageIconRows.map((row, i) => {
                    const busyKey = `icon:${row.code}`;
                    const saving = !!busy[busyKey];
                    const editing = editingIcon === row.code;
                    return (
                      <div
                        key={row.id}
                        className="grid grid-cols-[40px_minmax(0,1fr)_88px] items-center gap-2 border-b border-edge px-4 py-2.5 text-sm last:border-0 hover:bg-brand-hover/40 dark:border-[#2a2f3a] dark:hover:bg-white/5"
                      >
                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-bg-gray text-[10px] font-bold text-muted">{listStart + i + 1}</span>
                        <span className="flex min-w-0 items-center gap-2.5">
                          <button
                            type="button"
                            disabled={saving}
                            onClick={(e) => (e.currentTarget.closest("div")?.querySelector('input[type="file"]') as HTMLInputElement | null)?.click()}
                            className="group relative flex-none"
                            title="点击上传/更换图标"
                          >
                            <span className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-[10px] border border-[#d3d9e4] bg-[#f3f5f9] shadow-[0_1px_3px_rgba(10,14,25,.08)]">
                              {row.url ? (
                                <img src={row.url} alt="" className="h-6 w-6" />
                              ) : (
                                <span className="text-[10px] font-bold text-muted">?</span>
                              )}
                            </span>
                            <span className="absolute inset-0 flex items-center justify-center rounded-[10px] bg-black/45 text-white opacity-0 transition-opacity duration-200 group-hover:opacity-100">
                              {saving ? (
                                <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.3" />
                                  <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                                </svg>
                              ) : (
                                <span className="text-[10px] font-semibold text-white">浅色</span>
                              )}
                            </span>
                          </button>
                          <input
                            ref={(el) => {
                              fileRefs.current[busyKey] = el;
                            }}
                            type="file"
                            accept="image/jpeg,image/png,image/gif,image/webp,image/svg+xml"
                            className="hidden"
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              if (f) {
                                setBusy((b) => ({ ...b, [busyKey]: true }));
                                const fd = new FormData();
                                fd.append("kind", "asset");
                                fd.append("folder", "icon");
                                fd.append("code", row.code);
                                fd.append("name", row.name);
                                fd.append("file", f);
                                fetch("/api/upload", { method: "POST", body: fd })
                                  .then((r) => r.json())
                                  .then((d) => {
                                    if (d?.url) return saveIconAsset(row, { url: d.url });
                                    throw new Error(d?.error || "上传失败");
                                  })
                                  .then((ok) => {
                                    if (ok) showToast("图标已保存，全局生效");
                                  })
                                  .catch((err) => showToast(err instanceof Error ? err.message : "上传失败", "err"))
                                  .finally(() => setBusy((b) => ({ ...b, [busyKey]: false })));
                              }
                              e.target.value = "";
                            }}
                          />
                          {/* 深色模式图标 */}
                          <button
                            type="button"
                            disabled={saving}
                            title="深色模式下显示的图标（点击上传/更换）"
                            onClick={(e) => {
                              const el = (e.currentTarget.parentElement as HTMLElement | null)?.querySelector('input[data-variant="dark"]') as HTMLInputElement | null;
                              el?.click();
                            }}
                            className="group relative flex h-9 w-9 flex-none items-center justify-center overflow-hidden rounded-[10px] border border-dashed border-[#3a3f4b]/80 bg-gradient-to-br from-[#333844] to-[#1c212b] shadow-[0_1px_3px_rgba(0,0,0,.3)]"
                          >
                            {row.urlDark ? (
                              <img src={row.urlDark} alt="" className="h-6 w-6 object-contain" />
                            ) : (
                              <svg viewBox="0 0 24 24" fill="none" stroke="#dfe4ee" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
                              </svg>
                            )}
                            <span className="absolute inset-0 grid place-items-center rounded-[10px] bg-black/45 text-[10px] font-semibold text-white opacity-0 transition-opacity duration-200 group-hover:opacity-100">
                              {saving ? (
                                <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.3" />
                                  <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                                </svg>
                              ) : (
                                "深色"
                              )}
                            </span>
                            {row.urlDark && (
                              <span
                                role="button"
                                tabIndex={0}
                                title="移除深色图标（深色下使用默认图标）"
                                onClick={(ev) => { ev.stopPropagation(); void saveIconAsset(row, { urlDark: "" }); }}
                                className="absolute right-0 top-0 grid h-4 w-4 cursor-pointer place-items-center rounded-bl-lg bg-black/60 text-[9px] text-white hover:bg-[#e5484d]"
                              >
                                ×
                              </span>
                            )}
                          </button>
                          <input
                            data-variant="dark"
                            type="file"
                            accept="image/jpeg,image/png,image/gif,image/webp,image/svg+xml"
                            className="hidden"
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              if (f) {
                                setBusy((b) => ({ ...b, [busyKey]: true }));
                                const fd = new FormData();
                                fd.append("kind", "asset");
                                fd.append("folder", "icon");
                                fd.append("code", row.code);
                                fd.append("name", row.name);
                                fd.append("file", f);
                                fetch("/api/upload", { method: "POST", body: fd })
                                  .then((r) => r.json())
                                  .then((d) => {
                                    if (d?.url) return saveIconAsset(row, { urlDark: d.url });
                                    throw new Error(d?.error || "上传失败");
                                  })
                                  .then((ok) => {
                                    if (ok) showToast("深色图标已保存，全局生效");
                                  })
                                  .catch((err) => showToast(err instanceof Error ? err.message : "上传失败", "err"))
                                  .finally(() => setBusy((b) => ({ ...b, [busyKey]: false })));
                              }
                              e.target.value = "";
                            }}
                          />
                          {editing ? (
                            <>
                              <input
                                autoFocus
                                value={iconDraft}
                                onChange={(e) => setIconDraft(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") {
                                    e.preventDefault();
                                    void saveIconName(row, iconDraft);
                                  }
                                  if (e.key === "Escape") setEditingIcon(null);
                                }}
                                className={`${inputCls} h-8 w-28 px-2 text-sm`}
                              />
                              <span className="flex flex-none items-center gap-1">
                                <button
                                  type="button"
                                  disabled={saving}
                                  onClick={() => void saveIconName(row, iconDraft)}
                                  title="保存名称"
                                  className="flex h-6 w-6 flex-none items-center justify-center rounded-full text-muted transition-colors hover:bg-brand-hover hover:text-ink"
                                >
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
                                    <path d="m5 13 4 4L19 7" />
                                  </svg>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setEditingIcon(null)}
                                  title="取消"
                                  className="flex h-6 w-6 flex-none items-center justify-center rounded-full text-muted transition-colors hover:bg-brand-hover hover:text-ink"
                                >
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-3.5 w-3.5">
                                    <path d="M18 6 6 18" /><path d="m6 6 12 12" />
                                  </svg>
                                </button>
                              </span>
                            </>
                          ) : (
                            <>
                              <span className="min-w-0">
                                <span
                                  className="block cursor-pointer truncate font-semibold text-ink transition-colors hover:text-brand-deep"
                                  title="点击复制名称"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void copyIconText(row.name, "名称");
                                  }}
                                >
                                  {row.name}
                                </span>
                                <span
                                  className="block cursor-pointer truncate text-[11px] text-faint transition-colors hover:text-brand-deep"
                                  title="点击复制代码"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void copyIconText(row.code, "代码");
                                  }}
                                >
                                  {row.code}
                                </span>
                              </span>
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingIcon(row.code);
                                  setIconDraft(row.name);
                                }}
                                title="编辑图标名称"
                                className="inline-flex h-7 w-7 flex-none items-center justify-center rounded-[8px] border border-edge text-muted transition-all duration-200 hover:border-edge-strong hover:bg-brand-hover hover:text-ink active:scale-[.97]"
                              >
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
                                  <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                                </svg>
                              </button>
                            </>
                          )}
                        </span>
                        <span className="flex items-center justify-end gap-1.5">
                          <button
                            type="button"
                            disabled={saving}
                            onClick={() => void restoreIconAsset(row)}
                            title="恢复默认图标"
                            className="inline-flex h-7 w-7 flex-none items-center justify-center rounded-[8px] border border-edge text-muted transition-all duration-200 hover:border-down/40 hover:bg-down/10 hover:text-down active:scale-[.97] disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/10 dark:hover:bg-down/20"
                          >
                            <DeleteIcon size={14} />
                          </button>
                        </span>
                      </div>
                    );
                  })
                )}
              </>
            ) : (
              <>
                {/* 搜索栏：加密货币 / 贵金属共用，支持「搜索即添加」 */}
                <div className="flex items-center justify-between gap-3 border-b border-edge px-4 py-2.5">
                  <span className="text-[11px] font-semibold text-faint">
                    {tab === "crypto" ? "加密货币" : "贵金属"} · {filteredAssetRows.length} 只
                  </span>
                  <input
                    value={assetQuery}
                    onChange={(e) => setAssetQuery(e.target.value)}
                    placeholder="搜索名称 / 代码"
                    className="ml-auto h-[34px] w-[180px] rounded-full border border-edge-strong bg-white px-3.5 text-xs outline-none transition-shadow focus:border-edge-strong focus:shadow-[0_0_0_3px_rgba(107,114,128,.14)] dark:bg-[#151a26] dark:text-[#e5e7eb]"
                  />
                </div>
                <div className="grid min-w-[620px] grid-cols-[56px_minmax(190px,1fr)_110px_90px_90px] items-center gap-2 border-b border-edge bg-[#f6f7f9] px-4 py-2 text-[11px] font-semibold text-muted dark:bg-white/5">
                  <span>序号</span>
                  <span>名称 / 代码</span>
                  <button type="button" onClick={() => toggleSort("marketCap")} className={`inline-flex items-center justify-end gap-1 text-right transition-colors ${sortKey === "marketCap" ? "text-brand-deep" : "hover:text-ink"}`}>
                    市值 <SortArrow k="marketCap" />
                  </button>
                  <button type="button" onClick={() => toggleSort("price")} className={`inline-flex items-center justify-end gap-1 text-right transition-colors ${sortKey === "price" ? "text-brand-deep" : "hover:text-ink"}`}>
                    最新价 <SortArrow k="price" />
                  </button>
                  <button type="button" onClick={() => toggleSort("changePct")} className={`inline-flex items-center justify-end gap-1 text-right transition-colors ${sortKey === "changePct" ? "text-brand-deep" : "hover:text-ink"}`}>
                    涨跌幅 <SortArrow k="changePct" />
                  </button>
                </div>
                {filteredAssetRows.length === 0 ? (
                  assetQuery.trim() ? (
                    <div className="p-4">
                      <div className="flex items-center justify-between gap-3">
                        <p className="min-w-0 truncate text-sm text-faint">素材库中没有找到「{assetQuery.trim()}」</p>
                        <button type="button" onClick={() => void loadAddCandidates(tab)} disabled={adding} className="btn btn-line btn-sm flex-none disabled:opacity-60">
                          {adding ? "匹配中…" : "+ 添加"}
                        </button>
                      </div>
                      {addCandidates?.type === tab && (
                        <div className="mt-3 space-y-1.5">
                          <p className="text-[11px] font-semibold text-faint">行情源匹配 {addCandidates.items.length} 个，选择添加：</p>
                          {addCandidates.items.map((c) => (
                            <div key={`${c.market}:${c.code}`} className="flex items-center justify-between gap-3 rounded-[10px] border border-edge px-3 py-2">
                              <span className="flex min-w-0 items-center gap-2">
                                {c.iconUrl ? (
                                  <img src={c.iconUrl} alt="" className="h-[18px] w-[18px] flex-none rounded-full object-cover" />
                                ) : (
                                  <span className="flex h-[18px] w-[18px] flex-none items-center justify-center rounded-full bg-bg-gray text-[9px] font-bold text-muted">
                                    {(c.name || "?").slice(0, 1)}
                                  </span>
                                )}
                                <span className="truncate font-semibold text-ink">{c.name}</span>
                                <span className="flex-none text-[11px] text-faint">{c.code}</span>
                              </span>
                              <button
                                type="button"
                                disabled={!!busy[`add:${c.market}:${c.code}`]}
                                onClick={() => void addCandidate(c, tab)}
                                className="btn btn-line btn-sm flex-none disabled:opacity-60"
                              >
                                {busy[`add:${c.market}:${c.code}`] ? "添加中…" : "添加"}
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : (
                    <p className="py-10 text-center text-sm text-faint">
                      暂无{tab === "crypto" ? "加密货币" : "贵金属"}图标
                    </p>
                  )
                ) : (
                  pageAssetRows.map((row, i) => {
                  const busyKey = `asset:${row.key}`;
                  const saving = !!busy[busyKey];
                  const isUp = (row.changePct ?? 0) >= 0;
                  return (
                    <div key={row.key} className="grid min-w-[620px] grid-cols-[56px_minmax(190px,1fr)_110px_90px_90px] items-center gap-2 border-b border-edge px-4 py-2.5 text-sm last:border-0 hover:bg-brand-hover/40 dark:border-[#2a2f3a] dark:hover:bg-white/5">
                      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-bg-gray text-[10px] font-bold text-muted">{listStart + i + 1}</span>
                      <span className="flex min-w-0 items-center gap-2.5">
                        <button
                          type="button"
                          disabled={saving}
                          onClick={(e) => (e.currentTarget.closest("div")?.querySelector('input[type="file"]') as HTMLInputElement | null)?.click()}
                          className="group relative flex h-9 w-9 flex-none items-center justify-center overflow-hidden rounded-full border border-edge bg-white shadow-[0_1px_3px_rgba(10,14,25,.08)] dark:bg-[#1c1c1e]"
                          title="点击上传/更换图标"
                        >
                          {row.url ? (
                            <img src={row.url} alt="" className="h-full w-full rounded-full object-cover" />
                          ) : row.type === "crypto" ? (
                            <span className="inline-flex h-full w-full items-center justify-center rounded-full bg-[#f7931a] text-sm font-bold text-white">₿</span>
                          ) : (
                            <span className="flex h-full w-full items-center justify-center rounded-full bg-bg-gray text-[11px] font-bold text-muted">金</span>
                          )}
                          <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/45 text-white opacity-0 transition-opacity duration-200 group-hover:opacity-100">
                            {saving ? (
                              <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.3" />
                                <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                              </svg>
                            ) : (
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                                <path d="M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4z" />
                                <circle cx="12" cy="13" r="3" />
                              </svg>
                            )}
                          </span>
                        </button>
                        <span className="min-w-0">
                          <span className="block truncate font-semibold text-ink">{row.name}</span>
                          <span className="block truncate text-[11px] text-faint">{row.key}</span>
                        </span>
                      </span>
                      <input
                        ref={(el) => {
                          fileRefs.current[busyKey] = el;
                        }}
                        type="file"
                        accept="image/jpeg,image/png,image/gif,image/webp,image/svg+xml"
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) {
                            const fd = new FormData();
                          fd.append("kind", "asset");
                          fd.append("folder", row.type);
                          fd.append("code", row.key);
                          fd.append("name", row.name);
                          fd.append("file", f);
                            fetch("/api/upload", { method: "POST", body: fd })
                              .then((r) => r.json())
                              .then((d) => {
                                if (d?.url) saveAssetIcon(row, d.url);
                              })
                              .catch(() => showToast("上传失败", "err"));
                          }
                          e.target.value = "";
                        }}
                      />
                      <span className="text-right tabular-nums text-faint">{row.marketCap && row.marketCap > 0 ? fmtUsd(row.marketCap) : "—"}</span>
                      <span className="text-right tabular-nums text-ink-2">{row.price != null ? `$${row.price}` : "—"}</span>
                      <span className={`text-right tabular-nums ${row.changePct != null ? (isUp ? UP : DOWN) : "text-faint"}`}>
                        {row.changePct != null ? `${row.changePct >= 0 ? "+" : ""}${row.changePct.toFixed(2)}%` : "—"}
                      </span>

                    </div>
                  );
                  })
                )}
              </>
            )}
            {activeListCount > TOP_PAGE_SIZE && (
              <div className="border-t border-edge px-4 py-3 dark:border-[#2a2f3a]">
                <Pagination page={safeListPage} total={listTotalPages} onChange={setListPage} />
              </div>
            )}
          </div>
        )}
      </div>

      {/* 素材库设置弹窗 */}
      {settingsOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40" onClick={() => setSettingsOpen(false)} />
          <div className="relative w-full max-w-lg rounded-card border border-edge bg-white p-5 shadow-pop dark:border-[#3b4354] dark:bg-[#1c1c1e]">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-base font-bold text-ink">素材库设置</h3>
              <button
                type="button"
                onClick={() => setSettingsOpen(false)}
                className="flex h-7 w-7 items-center justify-center rounded-full text-muted transition-colors hover:bg-brand-hover hover:text-ink"
                title="关闭"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-4 w-4">
                  <path d="M18 6 6 18" /><path d="m6 6 12 12" />
                </svg>
              </button>
            </div>

            <div className="flex flex-col gap-4">
              {/* 股票图标同步 */}
              <div className="rounded-[12px] border border-edge bg-bg-gray/40 p-4 dark:bg-white/5">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-ink">股票图标同步</p>
                  </div>
                  <button
                    type="button"
                    onClick={startSync}
                    className="btn btn-line btn-sm flex-none disabled:opacity-60"
                  >
                    {syncStatus?.running ? "同步中…" : "立即同步"}
                  </button>
                </div>
                {syncStatus && (
                  <div className="mt-2.5 text-[11px] text-muted">
                    {syncStatus.running ? (
                      <span>
                        同步中 {syncStatus.done} / {syncStatus.total} · {syncStatus.current || "…"}
                      </span>
                    ) : (
                      <span>
                        {syncStatus.lastSyncAt
                          ? `上次同步：${new Date(syncStatus.lastSyncAt).toLocaleString("zh-CN", { hour12: false })}`
                          : "尚未同步"}
                        {syncStatus.error ? ` · ${syncStatus.error}` : ""}
                      </span>
                    )}
                  </div>
                )}
              </div>

              {/* 退市检测 */}
              <div className="flex items-center justify-between gap-3 rounded-[12px] border border-edge bg-bg-gray/40 p-4 dark:bg-white/5">
                <div>
                  <p className="text-sm font-semibold text-ink">退市检测</p>
                </div>
                <button
                  type="button"
                  disabled={checkingDelisted}
                  onClick={runDelistedCheck}
                  className="btn btn-line btn-sm flex-none disabled:opacity-60"
                >
                  {checkingDelisted ? "检测中…" : "立即检测"}
                </button>
              </div>

              {/* CDN 图标通道 */}
              <div className="flex items-center justify-between gap-3 rounded-[12px] border border-edge bg-bg-gray/40 p-4 dark:bg-white/5">
                <div>
                  <p className="text-sm font-semibold text-ink">CDN 图标通道</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={cdnEnabled}
                  onClick={() => toggleCdn(!cdnEnabled)}
                  className={`relative h-6 w-11 flex-none rounded-full transition-colors duration-200 ${cdnEnabled ? "bg-[#34c759]" : "bg-[#e9e9ea] dark:bg-[#3a3a3c]"}`}
                >
                  <span
                    className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full shadow-sm transition-transform duration-200 ${cdnEnabled ? "translate-x-5" : ""}`}
                    style={{ backgroundColor: "#ffffff" }}
                  />
                </button>
              </div>

              {/* 清理孤立文件 */}
              <div className="flex items-center justify-between gap-3 rounded-[12px] border border-edge bg-bg-gray/40 p-4 dark:bg-white/5">
                <div>
                  <p className="text-sm font-semibold text-ink">清理孤立文件</p>
                </div>
                <button
                  type="button"
                  disabled={cleaningFiles}
                  onClick={runCleanup}
                  className="btn btn-line btn-sm flex-none disabled:opacity-60"
                >
                  {cleaningFiles ? "清理中…" : "立即清理"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
