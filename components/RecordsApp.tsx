"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  MARKET_LIST,
  marketMeta,
  type SystemLog,
  type GroupConfig,
  type Market,
  type MarketOption,
  type Quote,
  type RecordInput,
  type SearchMatch,
  type SiteSettings,
  type StockRecord,
  type TabConfig,
  type User
} from "@/lib/types";
import { showToast } from "@/lib/toast";
import { applyMarketBadges, primeMarketBadges } from "@/lib/marketBadge";
import { activeQuoteMarkets } from "@/lib/marketSessions";
import SettingsWindow from "@/components/SettingsWindow";
import { primeFlagIconCache, primeMarketIconCache, primeNavIconCache, primeStockIconCache, useAssetIcons, usePrefetchFlagIcons } from "@/lib/useAssetIcons";
import { pickStockIcon } from "@/lib/stockIconKey";
import { NAV_ICONS } from "@/lib/navIcons";
import SafeAssetImage from "@/components/SafeAssetImage";
import WatchlistView from "@/components/views/WatchlistView";
import type { WatchGroup } from "@/lib/watchGroups";
import HoldingsView from "@/components/views/HoldingsView";
import AssetAnalysisView from "@/components/views/AssetAnalysisView";
import FireView from "@/components/views/FireView";
import ActivitiesView from "@/components/views/ActivitiesView";
import EarningsCalendarView from "@/components/views/EarningsCalendarView";
import CelebsView from "@/components/views/CelebsView";
import TradingSquareView from "@/components/views/TradingSquareView";
import SettingsView from "@/components/views/SettingsView";
import UsersView from "@/components/views/UsersView";
import AssetLibraryView from "@/components/views/AssetLibraryView";
import CardLibraryView from "@/components/views/CardLibraryView";
import AttachmentsView from "@/components/views/AttachmentsView";
import GlobalPreviewView from "@/components/views/GlobalPreviewView";
import AssetPnlAnalysisView from "@/components/AssetPnlAnalysis";
import ContextAssistant from "@/components/ContextAssistant";
import AssistantView from "@/components/views/AssistantView";
import FourDoorNavigator, { type FourDoorKey } from "@/components/FourDoorNavigator";

// 后台页签全部同步引入：next/dynamic 的 loading 会在刷新水合时盖住已 SSR 的内容，整页闪「加载中…」。

type TabKey = "watchlist" | "holdings" | "assets" | "fire" | "activities" | "global" | "trading" | "earnings" | "assistant" | "celebs" | "users" | "attachments" | "library" | "cards" | "settings" | "pnl";

function NoPermission() {
  return (
    <div className="rounded-card border border-edge bg-white p-10 text-center shadow-card">
      <p className="text-sm font-semibold text-ink">没有访问权限</p>
      <p className="mt-1 text-xs text-muted">该功能仅管理员可用</p>
    </div>
  );
}

const DEFAULT_TABS: TabConfig[] = [
  { key: "holdings", label: "账户资产", url: "/holdings", default: true },
  { key: "assets", label: "资产分析", url: "/asset-analysis" },
  { key: "fire", label: "FIRE", url: "/fire" },
  { key: "watchlist", label: "自选股", url: "/watchlist" },
  { key: "global", label: "全球经济", url: "/global" },
  { key: "trading", label: "交易广场", url: "/trading" },
  { key: "quotes", label: "股票添加", url: "/quotes" },
  { key: "earnings", label: "财报日历", url: "/earnings" },
  { key: "assistant", label: "智能助手", url: "/assistant" },
  { key: "celebs", label: "名人持仓", url: "/celebs" },
  { key: "users", label: "用户管理", url: "/users" },
  { key: "attachments", label: "附件管理", url: "/attachments" },
  { key: "library", label: "素材库", url: "/library" },
  { key: "cards", label: "卡面库", url: "/cards" },
  { key: "activities", label: "日志", url: "/activities" },
  { key: "settings", label: "设置", url: "/settings" }
];

// 保证 FIRE 页签始终存在且固定在「资产分析」下方（即使数据库里的导航菜单未包含它）。
function withFireTab(tabs: TabConfig[]): TabConfig[] {
  if (tabs.some((t) => t.key === "fire")) return tabs;
  const idx = tabs.findIndex((t) => t.key === "assets");
  const fireTab: TabConfig = { key: "fire", label: "FIRE", url: "/fire" };
  if (idx >= 0) return [...tabs.slice(0, idx + 1), fireTab, ...tabs.slice(idx + 1)];
  return [...tabs, fireTab];
}

export default function RecordsApp({
  initialTab,
  initialSymbol,
  initialCelebAvatars,
  initialUser,
  initialRecords,
  initialWatchGroups = [],
  initialUserLogs,
  initialAssistantHistory = { activeId: "", conversations: [] },
  initialFundBalances,
  initialSettings,
  initialStockIcons,
  initialMarketIcons = {},
  initialNavIcons = {},
  initialFlagIcons = {},
  initialAssetLibrary = null,
  initialCardLibrary = null
}: {
  initialTab: string;
  initialSymbol?: string;
  initialCelebAvatars?: Record<string, string>;
  initialUser: User;
  initialRecords: StockRecord[];
  initialWatchGroups?: WatchGroup[];
  initialUserLogs: SystemLog[];
  initialAssistantHistory?: import("@/lib/assistantHistory").AssistantHistoryState;
  initialFundBalances: Record<string, number>;
  initialSettings: Pick<SiteSettings, "tabs" | "groups" | "markets" | "marketLabels" | "stockIconCdn" | "marketBadges" | "marketBadgesVisible" | "allowRegister" | "translationEnabled">;
  initialStockIcons: Record<string, string>;
  initialMarketIcons?: Record<string, string>;
  initialNavIcons?: Record<string, string>;
  initialFlagIcons?: Record<string, string>;
  initialAssetLibrary?: { assets: import("@/lib/useAssetIcons").Asset[]; total: number } | null;
  initialCardLibrary?: import("@/lib/cardLibrary").CardLibraryPayload | null;
}) {
  const router = useRouter();
  const [user] = useState<User>(initialUser);
  const [records, setRecords] = useState<StockRecord[]>(initialRecords);
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const quotesRef = useRef<Record<string, Quote>>({});
  const [valuationReady, setValuationReady] = useState(false);
  const [quoteAt, setQuoteAt] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  const initialQuoteLoadRef = useRef(false);
  const loadedQuoteIdsRef = useRef(new Set<string>());
  const quoteCacheKeyRef = useRef("");
  const mobileNavRef = useRef<HTMLDivElement>(null);
  const [userLogs, setUserLogs] = useState<SystemLog[]>(initialUserLogs);
  const [systemLogs, setSystemLogs] = useState<SystemLog[]>([]);
  const [activeTab, setActiveTab] = useState<TabKey>(initialTab as TabKey);
  const [navTabs, setNavTabs] = useState<TabConfig[]>(() => withFireTab(initialSettings.tabs));
  const [navReady, setNavReady] = useState(true);
  const [settingsSub, setSettingsSub] = useState<string | null>(null);
  const [settingsSubReady, setSettingsSubReady] = useState(initialTab !== "settings");
  const [groups, setGroups] = useState<GroupConfig[]>(initialSettings.groups);
  const [markets, setMarkets] = useState<Market[]>(initialSettings.markets);
  const [marketLabels, setMarketLabels] = useState<{ key: string; label: string; flag: string }[]>(initialSettings.marketLabels);
  const { assetIcons, stockIcons } = useAssetIcons(["icon", "stock"], { stockIconCdn: initialSettings.stockIconCdn });
  const [navIconsHydrated, setNavIconsHydrated] = useState(false);
  const attemptedIconBackfillRef = useRef(new Set<string>());

  // 市场色块是模块级 store（不是 React 状态）：必须在水合首帧之前按服务端设置初始化。
  // 只在 effect 里 apply 的话，SSR 会用默认值（默认显示）渲染出色块，浏览器先画出这版 HTML，
  // 等水合 + effect 才隐藏 —— 关了色块的人刷新时就会闪一下（服务端与首帧都走这里，值没变时是空操作）。
  primeMarketBadges(initialSettings.marketBadges, initialSettings.marketBadgesVisible);

  // 服务端注入的股票图标表必须在「渲染期」就地预热：primeStockIconCache 只写缓存、不通知订阅者，
  // 不会打断水合；放到 useLayoutEffect 里就晚了 —— 子组件先渲染首帧（拿不到图标，画首字母），
  // 之后 effect 才补上，刷新时就会看到「图标闪一下才出来」。服务端同一份渲染路径也会带上图标，
  // 首屏 HTML 直接就是图标（layout 里还做了 preload）。
  useMemo(() => primeStockIconCache(initialStockIcons), [initialStockIcons]);
  useMemo(() => primeMarketIconCache(initialMarketIcons), [initialMarketIcons]);
  useMemo(() => primeNavIconCache(initialNavIcons), [initialNavIcons]);
  useMemo(() => primeFlagIconCache(initialFlagIcons), [initialFlagIcons]);
  usePrefetchFlagIcons(initialFlagIcons);
  useEffect(() => setNavIconsHydrated(true), []);
  useLayoutEffect(() => {
    applyMarketBadges(initialSettings.marketBadges, initialSettings.marketBadgesVisible);
  }, [initialSettings.marketBadges, initialSettings.marketBadgesVisible]);

  // 兼容升级前已经加入但仍为首字母占位的股票；每个标的本次会话只尝试一次，双 worker 后台补齐。
  useEffect(() => {
    const missing = records.filter((record) => {
      const market = record.market.toUpperCase();
      const key = `${market}:${record.code.toUpperCase()}`;
      if (!["US", "HK", "CN", "JP", "KR"].includes(market) || attemptedIconBackfillRef.current.has(key)) return false;
      return !pickStockIcon(stockIcons, market, record.code) && !pickStockIcon(initialStockIcons, market, record.code);
    });
    if (!missing.length) return;
    missing.forEach((record) => attemptedIconBackfillRef.current.add(`${record.market.toUpperCase()}:${record.code.toUpperCase()}`));
    let cursor = 0;
    const worker = async () => {
      while (cursor < missing.length) {
        const record = missing[cursor++];
        try {
          const response = await fetch("/api/assets/add-by-search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: "stock", market: record.market, code: record.code, name: record.name, onlyIfMissing: true })
          });
          const data = response.ok ? await response.json() : null;
          if (data?.asset?.url) window.dispatchEvent(new Event("fire:assets-updated"));
        } catch {
          /* 单个补图失败不影响其余标的 */
        }
      }
    };
    void Promise.all([worker(), worker()]);
  }, [initialStockIcons, records, stockIcons]);

  useLayoutEffect(() => {
    if (initialTab === "settings") {
      setSettingsSub(new URLSearchParams(window.location.search).get("sub"));
      setSettingsSubReady(true);
    }
  }, [initialTab]);

  const marketOptions = useMemo<MarketOption[]>(() => {
    const seen = new Set<string>();
    const opts: MarketOption[] = [];
    MARKET_LIST.forEach((k) => {
      seen.add(k);
      const meta = marketMeta(k);
      opts.push({ key: k, label: meta.label, flag: meta.flag });
    });
    [...markets, ...marketLabels.map((l) => l.key)].forEach((k) => {
      if (seen.has(k)) return;
      seen.add(k);
      const custom = marketLabels.find((l) => l.key === k);
      const meta = marketMeta(k);
      opts.push({
        key: k,
        label: custom?.label || meta.label,
        flag: custom?.flag || meta.flag
      });
    });
    return opts;
  }, [markets, marketLabels]);

  const applyMarkets = useCallback(
    (m: string[], l: { key: string; label: string; flag: string }[]) => {
      setMarkets(m);
      setMarketLabels(l);
    },
    []
  );

  const livePrice = useCallback(
    (r: StockRecord) => quotes[r.id]?.price ?? Number(r.price),
    [quotes]
  );

  const reloadActivities = useCallback(() => {
    fetch("/api/activities")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.userLogs) setUserLogs(data.userLogs);
        if (data?.systemLogs) setSystemLogs(data.systemLogs);
      })
      .catch(() => {});
  }, []);

  const reloadSettings = useCallback(() => {
    fetch("/api/settings")
      .then((res) => (res.ok ? res.json() : null))
      .then((st) => {
        const s = st?.settings;
        if (!s) return;
        if (s.tabs) {
          setNavTabs(
            withFireTab(
              s.tabs.some((t: TabConfig) => t.key === "settings")
                ? s.tabs
                : [...s.tabs, { key: "settings", label: "设置", url: "/settings" }]
            )
          );
        }
        if (s.groups) setGroups(s.groups);
        if (s.markets) setMarkets(s.markets);
        if (s.marketLabels) setMarketLabels(s.marketLabels);
      })
      .catch(() => {});
  }, []);

  useLayoutEffect(() => {
    // 行情快照在浏览器绘制前恢复；用户、持仓、现金和设置已由服务端首帧注入。
    const quoteCacheKey = `fire:quotes:v4:${initialUser.id}`;
    quoteCacheKeyRef.current = quoteCacheKey;
    try {
      const cached = JSON.parse(localStorage.getItem(quoteCacheKey) || "null") as { updatedAt?: number; quotes?: Record<string, Quote> } | null;
      // 完整成功快照不因时间过期而丢弃：它只承担刷新首帧兜底，挂载后仍会立即请求最新行情。
      // 数据库里的录入价通常更旧，回退到它会让总资产先闪出完全错误的中间值。
      if (cached?.quotes) {
        quotesRef.current = cached.quotes;
        setQuotes(cached.quotes);
        const positionIds = records.filter((record) => Number(record.qty) > 0).map((record) => record.id);
        setValuationReady(positionIds.every((id) => Number.isFinite(Number(cached.quotes?.[id]?.price))));
      }
    } catch {
      /* 缓存损坏时由行情刷新覆盖 */
    }
  }, [initialUser.id]);

  const refreshQuotes = useCallback(async (options?: { force?: boolean; missingOnly?: boolean; initialOnly?: boolean }) => {
    // 手动刷新绕过休市过滤；所有请求共用互斥，避免慢请求相互覆盖。
    if ((refreshingRef.current) || records.length === 0 || (!options?.force && document.hidden)) return;
    if (options?.initialOnly && initialQuoteLoadRef.current) return;
    const activeMarkets = activeQuoteMarkets(records.map((record) => record.market));
    const quoteRecords = records.filter((record) =>
      options?.force || !initialQuoteLoadRef.current || !loadedQuoteIdsRef.current.has(record.id) || (!options?.missingOnly && activeMarkets.has(record.market.toUpperCase()))
    );
    // 首次进入拉取全部市场的收盘快照；后续仅轮询当前处于盘前/盘中/盘后的市场。
    if (quoteRecords.length === 0) return;
    refreshingRef.current = true;
    setRefreshing(true);
    try {
      const data = { quotes: {} as Record<string, Quote> };
      // The API accepts at most 100 symbols; imports may add up to 2000.
      for (let offset = 0; offset < quoteRecords.length; offset += 100) {
        const res = await fetch("/api/quotes", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items: quoteRecords.slice(offset, offset + 100).map(r => ({ id: r.id, market: r.market, code: r.code })) })
        });
        if (!res.ok) continue;
        const result = await res.json();
        if (result.quotes) Object.assign(data.quotes, result.quotes);
      }
      // An empty response is not a successful price update.
      if (!Object.keys(data.quotes).length) return;
      if (data.quotes) {
        const merged = { ...quotesRef.current };
        Object.entries(data.quotes as Record<string, Quote>).forEach(([id, quote]) => {
          merged[id] = quote;
        });
        // 本次请求了但未返回的标的：删除旧行情，资产估值回退 records.price，
        // 当日盈亏回退为 0；未参与本次请求的休市标继续保留已有行情。
        quoteRecords.forEach((r) => {
          if (!data.quotes[r.id]) delete merged[r.id];
        });
        const positionIds = records.filter((record) => Number(record.qty) > 0).map((record) => record.id);
        const completeSnapshot = positionIds.every((id) => {
          const quote = merged[id];
          return Boolean(quote) && Number.isFinite(Number(quote.price));
        });
        quotesRef.current = merged;
        setQuotes(merged);
        setValuationReady(completeSnapshot);
        try {
          // 只缓存完整后端快照，避免下次刷新先恢复一份缺股的资产数据。
          if (completeSnapshot && quoteCacheKeyRef.current) {
            localStorage.setItem(quoteCacheKeyRef.current, JSON.stringify({ updatedAt: Date.now(), quotes: merged }));
          }
        } catch {
          /* localStorage 不可用时不影响实时行情 */
        }
        Object.keys(data.quotes).forEach((id) => loadedQuoteIdsRef.current.add(id));
        setQuoteAt(new Date().toLocaleTimeString("zh-CN", { hour12: false }));
        try {
          const refreshedAt = new Date();
          localStorage.setItem("fire:last-quotes-refresh", refreshedAt.toLocaleTimeString("zh-CN", { hour12: false }));
          localStorage.setItem("fire:last-quotes-refresh-at", String(refreshedAt.getTime()));
        } catch {
          /* 忽略存储不可用 */
        }
        initialQuoteLoadRef.current = true;
      }
    } catch {
      /* 行情失败时保留原价 */
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  }, [records]);

  useEffect(() => {
    // 自选股页面由自身的刷新间隔控件管理定时器，避免这里的 30 秒兜底计时器覆盖用户选择。
    if (records.length === 0) return;
    if (activeTab === "watchlist") { void refreshQuotes({ missingOnly: true }); return; }
    refreshQuotes();
    // 交易时段 30 秒刷新；休市时回调只做本地会话判断，不发送行情请求。
    const timer = setInterval(refreshQuotes, 30000);
    return () => clearInterval(timer);
  }, [records.length, refreshQuotes, activeTab]);

  // 统一的无感导航：只改状态 + 地址栏，不触发路由重载
  const navigateTo = useCallback(
    (key: TabKey, sub?: string | null) => {
      setActiveTab(key);
      const tab = navTabs.find((t) => t.key === key);
      const url = key === "pnl" ? "/asset-pnl-analysis" : tab?.url || `/${key}`;
      if (key === "settings") {
        setSettingsSub(sub ?? null);
        window.history.pushState({}, "", url + (sub ? `?sub=${sub}` : ""));
      } else {
        window.history.pushState({}, "", url);
      }
    },
    [navTabs]
  );

  const selectTab = useCallback(
    (key: TabKey) => {
      if (key === "settings") navigateTo(key, settingsSub);
      else navigateTo(key, null);
    },
    [navigateTo, settingsSub]
  );

  const navigateFromAssistant = useCallback((path: string) => {
    const url = new URL(path, window.location.origin);
    const target = url.pathname === "/asset-pnl-analysis"
      ? "pnl"
      : navTabs.find((tab) => (tab.url || `/${tab.key}`) === url.pathname)?.key;
    if (!target) return;
    setActiveTab(target as TabKey);
    window.history.pushState({}, "", `${url.pathname}${url.search}`);
  }, [navTabs]);

  /* ---------- 导航页签可拖动排序 + 自动保存 ---------- */
  const tabDragKeyRef = useRef<TabKey | null>(null);

  async function persistTabOrder(nextSidebar: { key: TabKey }[]) {
    const byKey = new Map(navTabs.map((t) => [t.key, t]));
    const ordered = nextSidebar
      .map((t) => byKey.get(t.key))
      .filter((t): t is TabConfig => Boolean(t));
    const hidden = navTabs.filter((t) => !ordered.some((o) => o.key === t.key));
    const nextTabs = withFireTab([...ordered, ...hidden]);
    setNavTabs(nextTabs);
    try {
      await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tabs: nextTabs })
      });
      window.dispatchEvent(new Event("fire:settings-updated"));
    } catch {
      /* 自动保存失败时保留本地顺序 */
    }
  }

  function onTabDrop(targetKey: TabKey) {
    const fromKey = tabDragKeyRef.current;
    tabDragKeyRef.current = null;
    if (!fromKey || fromKey === targetKey) return;
    const keys = sidebarTabs.map((t) => t.key);
    const from = keys.indexOf(fromKey);
    const to = keys.indexOf(targetKey);
    if (from < 0 || to < 0) return;
    const next = [...sidebarTabs];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    void persistTabOrder(next);
  }

  // 右上角头像菜单 / 设置子分类发来的导航请求
  useEffect(() => {
    function onNavigate(e: Event) {
      const d = (e as CustomEvent).detail as { tab?: string; sub?: string } | undefined;
      if (!d?.tab) return;
      navigateTo(d.tab as TabKey, d.sub);
    }
    window.addEventListener("fire:navigate", onNavigate);
    return () => window.removeEventListener("fire:navigate", onNavigate);
  }, [navigateTo]);

  // 设置里改了导航 URL 后，让地址栏跟随当前页签（同样只改地址栏）
  useEffect(() => {
    if (!navReady) return; // 等待设置加载完，避免用默认 URL 覆盖地址
    const tab = navTabs.find((t) => t.key === activeTab);
    const url = activeTab === "pnl" ? "/asset-pnl-analysis" : tab?.url || `/${activeTab}`;
    // 个股详情路径（如 /watchlist/US.GOOGL）属于当前页签的子路径，不做整页改写
    const isDetailPath = url !== "/asset-pnl-analysis" && window.location.pathname.startsWith(url + "/");
    if (window.location.pathname !== url && !isDetailPath) {
      // 只修正路径，不带旧页面的查询参数，避免低级别参数跨页残留
      window.history.pushState({}, "", url);
    }
  }, [navTabs, activeTab, navReady]);

  // 浏览器前进/后退时同步页签
  useEffect(() => {
    function onPop() {
      if (window.location.pathname === "/asset-pnl-analysis") {
        setActiveTab("pnl");
        return;
      }
      const tab = navTabs.find((t) => (t.url || `/${t.key}`) === window.location.pathname);
      if (tab) {
        setActiveTab(tab.key as TabKey);
        if (tab.key === "settings") {
          setSettingsSub(new URLSearchParams(window.location.search).get("sub"));
        }
      }
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [navTabs]);

  useEffect(() => {
    function onVisibility() {
      // 自选页有独立的刷新间隔控件；切回标签页时不能绕过用户选择额外刷新。
      if (!document.hidden) void refreshQuotes(activeTab === "watchlist" ? { initialOnly: true } : undefined);
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [activeTab, refreshQuotes]);

  useEffect(() => {
    function reloadRecords() {
      fetch("/api/records")
        .then((res) => (res.ok ? res.json() : null))
        .then((d) => d && setRecords(d));
      reloadActivities();
    }
    window.addEventListener("fire:records-updated", reloadRecords);
    return () => window.removeEventListener("fire:records-updated", reloadRecords);
  }, [reloadActivities]);

  useEffect(() => {
    window.addEventListener("fire:settings-updated", reloadSettings);
    return () => window.removeEventListener("fire:settings-updated", reloadSettings);
  }, [reloadSettings]);

  /* ---------- CRUD ---------- */
  async function createRecord(input: RecordInput): Promise<boolean> {
    try {
      const res = await fetch("/api/records", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input)
      });
      if (res.status === 401) {
        router.replace("/login");
        return false;
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "保存失败");
      setRecords((prev) => [data, ...prev]);
      showToast(`已添加 ${data.name}`);
      window.dispatchEvent(new Event("fire:records-updated"));
      // 新增成功不等待外部图标源；后台仅在素材库缺图时解析 TradingView 并落盘。
      if (["US", "HK", "CN", "JP", "KR"].includes(String(data.market).toUpperCase())) {
        void fetch("/api/assets/add-by-search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "stock", market: data.market, code: data.code, name: data.name, onlyIfMissing: true })
        }).then((iconRes) => iconRes.ok ? iconRes.json() : null)
          .then((iconData) => {
            if (iconData?.asset?.url) window.dispatchEvent(new Event("fire:assets-updated"));
          })
          .catch(() => { /* 补图失败不影响新增股票 */ });
      }
      reloadActivities();
      return true;
    } catch (err) {
      showToast(err instanceof Error ? err.message : "保存失败", "err");
      return false;
    }
  }

  async function updateRecord(id: string, input: RecordInput): Promise<boolean> {
    try {
      const res = await fetch(`/api/records/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input)
      });
      if (res.status === 401) {
        router.replace("/login");
        return false;
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "保存失败");
      setRecords((prev) => prev.map((r) => (r.id === id ? data : r)));
      window.dispatchEvent(new Event("fire:records-updated"));
      reloadActivities();
      return true;
    } catch (err) {
      showToast(err instanceof Error ? err.message : "保存失败", "err");
      return false;
    }
  }

  async function removeRecord(r: StockRecord) {
    const res = await fetch(`/api/records/${r.id}`, { method: "DELETE" });
    if (res.ok) {
      setRecords((prev) => prev.filter((x) => x.id !== r.id));
      showToast(`已删除 ${r.name}`);
      window.dispatchEvent(new Event("fire:records-updated"));
      reloadActivities();
    } else {
      showToast("删除失败", "err");
    }
  }

  /** 详情页爱心关注 / 取消关注：加入自选股（不弹确认） */
  async function toggleWatch(r: StockRecord, follow: boolean): Promise<boolean> {
    if (follow) {
      // 关注：沿用搜索添加的最小字段 + 按市场默认券商
      const price = quotes[r.id]?.price ?? r.price ?? "";
      return createRecord({
        name: r.name,
        code: r.code,
        market: r.market,
        price,
        cost: "",
        qty: "",
        group:
          r.market === "US"
            ? "长桥证劵"
            : r.market === "HK" || r.market === "CN"
              ? "华泰证劵"
              : "",
        note: "",
        source: "watchlist"
      });
    }
    // 取消关注：静默移除（不走删除确认弹窗）
    try {
      const res = await fetch(`/api/records/${r.id}`, { method: "DELETE" });
      if (res.status === 401) {
        router.replace("/login");
        return false;
      }
      if (!res.ok) return false;
      setRecords((prev) => prev.filter((x) => x.id !== r.id));
      setQuotes((prev) => {
        const next = { ...prev };
        delete next[r.id];
        quotesRef.current = next;
        return next;
      });
      showToast(`已取消关注 ${r.name}`);
      window.dispatchEvent(new Event("fire:records-updated"));
      reloadActivities();
      return true;
    } catch {
      return false;
    }
  }

  async function batchDeleteRecords(ids: string[]): Promise<boolean> {
    if (ids.length === 0) return false;
    try {
      const res = await fetch("/api/records/batch-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids })
      });
      if (res.status === 401) {
        router.replace("/login");
        return false;
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "删除失败");
      setRecords((prev) => prev.filter((r) => !ids.includes(r.id)));
      showToast(`已删除 ${ids.length} 条记录`);
      window.dispatchEvent(new Event("fire:records-updated"));
      reloadActivities();
      return true;
    } catch (err) {
      showToast(err instanceof Error ? err.message : "删除失败", "err");
      return false;
    }
  }

  async function addFromSearch(match: SearchMatch, from?: "holdings" | "watchlist"): Promise<boolean> {
    return createRecord({
      name: match.name,
      code: match.code,
      market: match.market,
      price: match.price ?? "",
      cost: "",
      qty: "",
      // 按市场自动分配券商：美股 → 长桥证劵；港股 / A股 → 华泰证劵；其他市场不设券商
      group:
        match.market === "US"
          ? "长桥证劵"
          : match.market === "HK" || match.market === "CN"
            ? "华泰证劵"
            : "",
      note: "",
      source: from
    });
  }

  async function clearAllRecords(password: string): Promise<boolean> {
    const res = await fetch("/api/records", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
    if (res.ok) {
      setRecords([]);
      quotesRef.current = {};
      setQuotes({});
      showToast("已清空全部记录");
      window.dispatchEvent(new Event("fire:records-updated"));
      reloadActivities();
      return true;
    }
    const data = await res.json().catch(() => null);
    showToast(data?.error || "清空失败", "err");
    return false;
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify(records, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    a.href = url;
    a.download = `fire-backup-${stamp}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const sidebarTabs = useMemo(
    () =>
      navTabs
        .filter((t) => (user?.role === "admin") || (t.key !== "users" && t.key !== "attachments" && t.key !== "library"))
        .map((t) => {
          // SSR 与客户端水合首帧必须使用同一份服务端快照；本地缓存只在水合完成后补充。
          const key = t.key.toUpperCase();
          const custom = initialNavIcons[key] || (navIconsHydrated ? assetIcons[key] : undefined);
          return {
            key: t.key as TabKey,
            label: t.label,
            icon: (
              <SafeAssetImage
                src={custom}
                fallback={NAV_ICONS[t.key]}
                className="h-[17px] w-[17px] flex-none object-contain dark:brightness-0 dark:invert"
              />
            )
          };
        }),
    [navTabs, user, assetIcons, initialNavIcons, navIconsHydrated]
  );

  const activePageLabel = activeTab === "holdings"
    ? "账户资产"
    : activeTab === "pnl"
      ? "资产总盈亏"
      : sidebarTabs.find((tab) => tab.key === activeTab)?.label ?? "工作区";
  const doorStatus = activeTab === "holdings"
    ? { label: "蓝门 · 市场", accent: "#168aca" }
    : activeTab === "assets" || activeTab === "pnl"
      ? { label: "黑门 · 分析", accent: "#85898d" }
      : activeTab === "fire"
        ? { label: "红门 · 计划", accent: "#ef493d" }
        : activeTab === "global"
          ? { label: "绿门 · 发现", accent: "#66b746" }
          : null;

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia("(max-width: 1023px)").matches) return;
    const frame = window.requestAnimationFrame(() => {
      const nav = mobileNavRef.current;
      const activeButton = nav?.querySelector<HTMLElement>(`[data-nav-tab="${activeTab}"]`);
      if (!nav || !activeButton) return;
      nav.scrollLeft = Math.max(0, activeButton.offsetLeft - (nav.clientWidth - activeButton.offsetWidth) / 2);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeTab, sidebarTabs.length]);

  const settingsPanel = (
    <div className="relative h-full min-h-0">
      {!settingsSubReady && (
        <div className="settings-first-frame" aria-hidden="true">
          <div className="settings-first-frame-tabs"><i /><i /><i /><i /></div>
          <div className="settings-first-frame-title"><i /><span /></div>
          <div className="settings-first-frame-card"><i /><i /><i /><i /></div>
        </div>
      )}
      <div className={settingsSubReady ? "h-full" : "hidden h-full"} aria-hidden={!settingsSubReady}>
        <SettingsView
          user={{
            username: user?.username ?? "",
            nickname: user?.nickname ?? "",
            uid: user?.uid ?? "",
            email: user?.email ?? "",
            avatar: user?.avatar ?? "",
            role: user?.role ?? "user"
          }}
          recordsCount={records.length}
          onExport={exportJson}
          onClearAll={clearAllRecords}
          onTabsChange={setNavTabs}
          initialSub={settingsSub ?? undefined}
          initialSettings={initialSettings}
        />
      </div>
    </div>
  );

  // translate="no" + notranslate：整页禁止机器翻译。<html> 上已经声明过一次，这里在应用主体上再标一次——
  // 翻译扩展通常按「最近的祖先」判断要不要翻。翻译器会在水合前改写 DOM（连 title 属性都会动：
  // 实测把「繁體」改成了「繁体」），React 一比对就报 Hydration failed。站内的繁简 / 英文切换不受影响。
  return (
    <>
    <div translate="no" className="records-app notranslate flex items-start">
      {/* 桌面侧边导航 */}
      <aside className="fire-sidebar sticky top-[88px] hidden w-[240px] flex-none lg:block">
        <nav className="fire-sidebar-panel relative flex min-h-[calc(100vh-112px)] max-h-[calc(100vh-104px)] flex-col overflow-y-auto rounded-2xl px-2 pb-3">
          <FourDoorNavigator activeKey={activeTab} onSelect={(key: FourDoorKey) => selectTab(key)} />
          <div className="fire-sidebar-section-label">工作区</div>
          {sidebarTabs.map((t, index) => {
            const isManagement = ["users", "attachments", "library", "cards", "activities", "settings"].includes(t.key);
            const previous = sidebarTabs[index - 1];
            const startsManagement = isManagement && !previous?.key || isManagement && !["users", "attachments", "library", "cards", "activities", "settings"].includes(previous.key);
            return (
              <div key={t.key}>
                {startsManagement && <div className="fire-sidebar-section-label fire-sidebar-section-label-spaced">管理</div>}
                <button
                  type="button"
                  onClick={() => selectTab(t.key)}
                  draggable
                  onDragStart={() => { tabDragKeyRef.current = t.key; }}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => onTabDrop(t.key)}
                  onDragEnd={() => { tabDragKeyRef.current = null; }}
                  title={`${t.label}（可拖动排序）`}
                  className={`fire-sidebar-item flex h-[42px] w-full cursor-grab items-center gap-3 rounded-[10px] px-3 text-[15px] transition-all duration-200 active:cursor-grabbing ${
                    activeTab === t.key
                      ? "fire-sidebar-item-active font-semibold text-ink dark:text-white"
                      : "text-muted hover:bg-black/[.05] hover:text-ink dark:hover:bg-white/[.07]"
                  }`}
                >
                  {t.icon}
                  <span className="truncate">{t.label}</span>
                </button>
              </div>
            );
          })}
        </nav>
      </aside>

      {/* 内容区 */}
      <div className="records-content min-w-0 flex-1">
        {/* 移动端顶部标签 */}
        <div ref={mobileNavRef} className="mobile-tab-nav mb-6 flex overflow-x-auto rounded-2xl bg-bg-gray p-1 lg:hidden">
          {sidebarTabs.map((t) => (
            <button
              key={t.key}
              data-nav-tab={t.key}
              type="button"
              onClick={() => selectTab(t.key)}
              className={`flex min-w-[76px] flex-1 flex-col items-center gap-1 rounded-xl px-2 py-2.5 text-xs transition-all duration-200 ${
                activeTab === t.key ? "bg-white font-semibold text-ink shadow-[0_1px_4px_rgba(10,14,25,.08)] dark:bg-[#252c3a] dark:text-white" : "text-muted"
              }`}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>

        {activeTab !== "assistant" && (
          <header className="fire-workspace-context" style={{ "--workspace-accent": doorStatus?.accent ?? "#8b9199" } as React.CSSProperties}>
            <div className="fire-workspace-breadcrumb"><span>Fire</span><i>/</i><strong>{activePageLabel}</strong></div>
            {doorStatus && <div className="fire-workspace-status"><i />{doorStatus.label}</div>}
          </header>
        )}

        <div key={activeTab} className="tab-panel min-w-0">
          {activeTab === "watchlist" && (
            <WatchlistView
              initialSymbol={initialSymbol}
              records={records}
              initialWatchGroups={initialWatchGroups}
              quotes={quotes}
              quoteAt={quoteAt}
              refreshing={refreshing}
              refreshQuotes={refreshQuotes}
              onAddMatch={(m) => addFromSearch(m, "watchlist")}
              onToggleWatch={toggleWatch}
              groups={groups}
            />
          )}
          {activeTab === "holdings" && (
            <HoldingsView
              records={records}
              quotes={quotes}
              livePrice={livePrice}
              refreshQuotes={refreshQuotes}
              onAddMatch={(m) => addFromSearch(m, "holdings")}
              onUpdate={updateRecord}
              onRemove={removeRecord}
              groups={groups}
              markets={markets}
              marketLabels={marketLabels}
              marketOptions={marketOptions}
              onMarketsChange={applyMarkets}
              onOrdersChanged={reloadActivities}
              initialFundBalances={initialFundBalances}
              valuationReady={valuationReady}
            />
          )}
          {activeTab === "assets" && (
            <AssetAnalysisView
              records={records}
              quotes={quotes}
              livePrice={livePrice}
              user={{
                username: user?.username ?? "",
                nickname: user?.nickname ?? "",
                avatar: user?.avatar ?? ""
              }}
              refreshQuotes={refreshQuotes}
              onOpenPnlAnalysis={() => selectTab("pnl")}
            />
          )}
          {activeTab === "fire" && (
            <FireView
              records={records}
              quotes={quotes}
              livePrice={livePrice}
            />
          )}
          {activeTab === "pnl" && (
            <AssetPnlAnalysisView
              onBack={() => selectTab("assets")}
              initialRecords={records}
              initialQuotes={quotes}
            />
          )}
          {activeTab === "activities" && <ActivitiesView userLogs={userLogs} systemLogs={systemLogs} isAdmin={user?.role === "admin"} onRefresh={reloadActivities} />}
          {activeTab === "global" && <GlobalPreviewView />}
          {activeTab === "trading" && <TradingSquareView avatars={initialCelebAvatars} records={records} />}
          {activeTab === "earnings" && <EarningsCalendarView records={records} canManage={initialUser.role === "admin"} />}
          {activeTab === "assistant" && <AssistantView page="assistant" symbol={initialSymbol} userId={user.id} initialHistory={initialAssistantHistory} onNavigate={navigateFromAssistant} />}
          {activeTab === "celebs" && <CelebsView isAdmin={user?.role === "admin"} initialAvatars={initialCelebAvatars} />}
          {activeTab === "users" && (user?.role === "admin" ? <UsersView /> : <NoPermission />)}
          {activeTab === "attachments" && (user?.role === "admin" ? <AttachmentsView /> : <NoPermission />)}
          {activeTab === "library" && (user?.role === "admin" ? <AssetLibraryView initialCdnEnabled={initialSettings.stockIconCdn} initialAssets={initialAssetLibrary?.assets} initialTotal={initialAssetLibrary?.total} /> : <NoPermission />)}
          {activeTab === "cards" && <CardLibraryView initial={initialCardLibrary} />}
          {activeTab === "settings" && (
            <SettingsWindow>{settingsPanel}</SettingsWindow>
          )}
        </div>
      </div>
    </div>
    {activeTab !== "assistant" && <ContextAssistant page={activeTab} symbol={initialSymbol} userId={user.id} initialHistory={initialAssistantHistory} onNavigate={navigateFromAssistant} />}
    </>
  );
}
