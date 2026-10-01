"use client";

import { useSearchParams } from "next/navigation";

import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import WorkspacePanel, { WorkspaceBoundary, WorkspaceLoading } from "@/components/WorkspacePanel";
import MobileBackGesture from "@/components/MobileBackGesture";
import { mobilePanelDirection } from "@/lib/mobileNavigation";
import { accountHoldingPrice } from "@/lib/accountCash";
import { currentAssistantPage, notifyAssistantPage, setAssistantPage } from "@/lib/assistantPage";
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
import { applyQuoteBatches, quoteInstrumentKey, readQuoteBatches, restoreQuoteSnapshot } from "@/lib/quoteBatches";
import SettingsWindow from "@/components/SettingsWindow";
import { primeFlagIconCache, primeMarketIconCache, primeNavIconCache, primeStockIconCache, useAssetIcons } from "@/lib/useAssetIcons";
import { pickStockIcon } from "@/lib/stockIconKey";
import { NAV_ICONS } from "@/lib/navIcons";
import SafeAssetImage from "@/components/SafeAssetImage";
import WorkspaceNavigation from "@/components/WorkspaceNavigation";
import type { WatchGroup } from "@/lib/watchGroups";
import { useDesktopViewport, useFourDoorViewport, useTabletDevice } from "@/lib/useDesktopViewport";
import { usePersistedState } from "@/lib/usePersistedState";
import { preloadView } from "@/lib/viewPreload";
import { mobileWorkspaceGroups } from "@/lib/workspaceNavigation";

// 默认保留服务端渲染：刷新当前页仍随 HTML 直接呈现内容；仅客户端代码按页签拆包。
// 首次下载页面代码时提供局部静态反馈，不把右侧工作区留白。
const WatchlistView = dynamic(() => import("@/components/views/WatchlistView"), { loading: WorkspaceLoading });
const HoldingsView = dynamic(() => import("@/components/views/HoldingsView"), { loading: WorkspaceLoading });
const AssetAnalysisView = dynamic(() => import("@/components/views/AssetAnalysisView"), { loading: WorkspaceLoading });
const FireView = dynamic(() => import("@/components/views/FireView"), { loading: WorkspaceLoading });
const ActivitiesView = dynamic(() => import("@/components/views/ActivitiesView"), { loading: WorkspaceLoading });
const EarningsCalendarView = dynamic(() => import("@/components/views/EarningsCalendarView"), { loading: WorkspaceLoading });
const CelebsView = dynamic(() => import("@/components/views/CelebsView"), { loading: WorkspaceLoading });
const FeedView = dynamic(() => import("@/components/views/FeedView"), { loading: WorkspaceLoading });
const SettingsView = dynamic(() => import("@/components/views/SettingsView"), { loading: WorkspaceLoading });
const UsersView = dynamic(() => import("@/components/views/UsersView"), { loading: WorkspaceLoading });
const AssetLibraryView = dynamic(() => import("@/components/views/AssetLibraryView"), { loading: WorkspaceLoading });
const CardLibraryView = dynamic(() => import("@/components/views/CardLibraryView"), { loading: WorkspaceLoading });
const AttachmentsView = dynamic(() => import("@/components/views/AttachmentsView"), { loading: WorkspaceLoading });
const GlobalPreviewView = dynamic(() => import("@/components/views/GlobalPreviewView"), { loading: WorkspaceLoading });
const AssetPnlAnalysisView = dynamic(() => import("@/components/AssetPnlAnalysis"), { loading: WorkspaceLoading });
const AssistantView = dynamic(() => import("@/components/views/AssistantView"), { loading: WorkspaceLoading });
const DeferredAssistant = dynamic(() => import("@/components/DeferredAssistant"));
const FloatingAssistant = memo(function FloatingAssistant({ symbol, userId, onNavigate }: { symbol?: string; userId: string; onNavigate: (path: string) => void }) {
  return <DeferredAssistant page={currentAssistantPage()} symbol={symbol} userId={userId} initialHistory={null} onNavigate={onNavigate} />;
});
const FourDoorNavigator = lazy(() => import("@/components/FourDoorNavigator"));
// 预览也按需下载：关闭时不把插图代码打入主页面；开启时与交互代码并行加载。
const FourDoorLoading = lazy(() => import("@/components/FourDoorLoading"));

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
  { key: "trading", label: "动态", url: "/trading" },
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
  initialNow,
  initialVersion,
  initialSymbol,
  initialCelebAvatars,
  initialCelebs,
  initialUser,
  initialRecords,
  initialWatchGroups = [],
  initialUserLogs,
  initialAssistantHistory = null,
  initialPasskeys = null,
  initialFundBalances,
  initialSettings,
  initialStockIcons,
  initialMarketIcons = {},
  initialNavIcons = {},
  initialFlagIcons = {},
  initialAssetLibrary = null,
  initialCardLibrary = null,
  initialFeed = null
}: {
  initialTab: string;
  initialNow: number;
  initialVersion: string;
  initialSymbol?: string;
  initialCelebAvatars?: Record<string, string>;
  initialCelebs?: import("@/lib/celebsData").CelebsResult | null;
  initialUser: User;
  initialRecords: StockRecord[];
  initialWatchGroups?: WatchGroup[];
  initialUserLogs: SystemLog[];
  initialAssistantHistory?: import("@/lib/assistantHistory").AssistantHistoryState | null;
  initialPasskeys?: import("@/lib/passkeySettingsData").PasskeySettingsSnapshot | null;
  initialFundBalances: Record<string, number>;
  initialSettings: Pick<SiteSettings, "assetAnalysisOrder" | "tabs" | "mobileNavigationOrder" | "groups" | "markets" | "marketLabels" | "stockIconCdn" | "marketBadges" | "marketBadgesVisible" | "allowRegister" | "translationEnabled" | "modelServices" | "modelServicesRevision" | "modelServicesInitialized" | "modelServicesError" | "title" | "logoText" | "siteLogo" | "ico" | "pwaIcon" | "appDisplayName" | "appDisplayIcon">;
  initialStockIcons: Record<string, string>;
  initialMarketIcons?: Record<string, string>;
  initialNavIcons?: Record<string, string>;
  initialFlagIcons?: Record<string, string>;
  initialAssetLibrary?: { assets: import("@/lib/useAssetIcons").Asset[]; total: number } | null;
  initialCardLibrary?: import("@/lib/cardLibrary").CardLibraryPayload | null;
  initialFeed?: import("@/lib/feedTypes").FeedPayload | null;
}) {
  const router = useRouter();
  const desktopViewport = useDesktopViewport();
  const fourDoorViewport = useFourDoorViewport();
  const tabletDevice = useTabletDevice();
  const [user] = useState<User>(initialUser);
  const [records, setRecords] = useState<StockRecord[]>(initialRecords);
  const recordsRef = useRef(records);
  recordsRef.current = records;
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const quotesRef = useRef<Record<string, Quote>>({});
  const [valuationReady, setValuationReady] = useState(() => !initialRecords.some(record => Number(record.qty) > 0 && record.code.trim()));
  const [quoteAt, setQuoteAt] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  const quoteRequestRef = useRef<AbortController | null>(null);
  const initialQuoteLoadRef = useRef(false);
  const loadedQuoteKeysRef = useRef(new Set<string>());
  const quoteCacheKeyRef = useRef("");
  const desktopNavRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const assetReturnRef = useRef<{ url: string; top: number; innerTop: number } | null>(null);
  const restoreAssetScrollRef = useRef(false);
  const [fourDoorEnabled] = usePersistedState("fire:four-door-enabled", false);
  const [fourDoorPinned, setFourDoorPinned] = usePersistedState("fire:four-door-pinned", false);
  const [tabletSidebarCollapsed, setTabletSidebarCollapsed] = usePersistedState("fire:tablet-sidebar-collapsed", false);
  const [tabletSidebarSide, setTabletSidebarSide] = usePersistedState<"left" | "right">("fire:tablet-sidebar-side", "left");
  const [sidebarScroll, setSidebarScroll] = useState({ top: 0, height: 0, visible: false });
  const [userLogs, setUserLogs] = useState<SystemLog[]>(initialUserLogs);
  const [systemLogs, setSystemLogs] = useState<SystemLog[]>([]);
  const [activeTab, setActiveTab] = useState<TabKey>(initialTab as TabKey);
  const [panelDirection, setPanelDirection] = useState("none");
  const [mountedTabs, setMountedTabs] = useState<TabKey[]>(() => [initialTab as TabKey]);
  const [panelEpoch, setPanelEpoch] = useState<Partial<Record<TabKey, number>>>({});
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  const pageMemory = useRef(new Map<string, string>());
  const scrollMemory = useRef(new Map<string, { top: number; inner: number }>());
  const scrollIntentRef = useRef(false);
  const quoteFetchedAtRef = useRef(0);
  const panels = useRef(new Map<TabKey, ReactNode>());
  const panelBuiltStamp = useRef(new Map<TabKey, object>());
  const restoreAssetPosition = useCallback(() => {
    if (!restoreAssetScrollRef.current || !assetReturnRef.current) return;
    const position = assetReturnRef.current;
    const frame = requestAnimationFrame(() => {
      restoreAssetScrollRef.current = false;
      window.scrollTo({ top: position.top, behavior: "instant" });
      contentRef.current?.scrollTo({ top: position.innerTop, behavior: "instant" });
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  // 只在本次换页是我们发起时，于绘制前恢复该页自己的滚动。首帧没有意图，刷新位置保持浏览器原来的地方。
  useLayoutEffect(() => {
    try {
      if (!scrollIntentRef.current) return;
      scrollIntentRef.current = false;
      if (activeTab === "assets" && restoreAssetScrollRef.current && assetReturnRef.current) {
        const position = assetReturnRef.current;
        restoreAssetScrollRef.current = false;
        window.scrollTo({ top: position.top, behavior: "instant" });
        contentRef.current?.scrollTo({ top: position.innerTop, behavior: "instant" });
        return;
      }
      const spot = scrollMemory.current.get(activeTab) ?? { top: 0, inner: 0 };
      window.scrollTo({ top: spot.top, behavior: "instant" });
      contentRef.current?.scrollTo({ top: spot.inner, behavior: "instant" });
    } finally {
      document.documentElement.classList.remove("fire-workspace-switching");
    }
  }, [activeTab]);
  useLayoutEffect(() => {
    notifyAssistantPage();
  }, [activeTab]);
  const skipInitialActivityFetchRef = useRef(initialTab === "activities");
  const [navTabs, setNavTabs] = useState<TabConfig[]>(() => withFireTab(initialSettings.tabs));
  const [mobileNavigationOrder, setMobileNavigationOrder] = useState(initialSettings.mobileNavigationOrder ?? []);
  const settingsReloadGeneration = useRef(0);
  const mobilePrimaryOrder = useMemo(() => mobileWorkspaceGroups(navTabs, mobileNavigationOrder).primary.map(tab => tab.key), [navTabs, mobileNavigationOrder]);
  const [navReady, setNavReady] = useState(true);
  const searchParams = useSearchParams();
  const [settingsSub, setSettingsSub] = useState<string | null>(() => searchParams.get("sub"));
  const [settingsSubReady, setSettingsSubReady] = useState(true);
  const [groups, setGroups] = useState<GroupConfig[]>(initialSettings.groups);
  const [markets, setMarkets] = useState<Market[]>(initialSettings.markets);
  const [marketLabels, setMarketLabels] = useState<{ key: string; label: string; flag: string }[]>(initialSettings.marketLabels);
  const { assetIcons, stockIcons } = useAssetIcons(["icon", "stock"], { stockIconCdn: initialSettings.stockIconCdn });
  const [navIconsHydrated, setNavIconsHydrated] = useState(false);
  const [floatingAssistantReady, setFloatingAssistantReady] = useState(false);
  const attemptedIconBackfillRef = useRef(new Set<string>());

  // 市场色块是模块级 store（不是 React 状态）：必须在水合首帧之前按服务端设置初始化。
  // 只在 effect 里 apply 的话，SSR 会用默认值（默认显示）渲染出色块，浏览器先画出这版 HTML，
  // 等水合 + effect 才隐藏 —— 关了色块的人刷新时就会闪一下（服务端与首帧都走这里，值没变时是空操作）。
  primeMarketBadges(initialSettings.marketBadges, initialSettings.marketBadgesVisible);

  // 服务端注入的股票图标表必须在「渲染期」就地预热：primeStockIconCache 只写缓存、不通知订阅者，
  // 不会打断水合；放到 useLayoutEffect 里就晚了 —— 子组件先渲染首帧（拿不到图标，画首字母），
  // 之后 effect 才补上，刷新时就会看到「图标闪一下才出来」。服务端同一份渲染路径也会带上图标，
  // 首屏 HTML 直接就是图标；浏览器仅请求当前视图实际渲染的图片。
  useMemo(() => primeStockIconCache(initialStockIcons), [initialStockIcons]);
  useMemo(() => primeMarketIconCache(initialMarketIcons), [initialMarketIcons]);
  useMemo(() => primeNavIconCache(initialNavIcons), [initialNavIcons]);
  useMemo(() => primeFlagIconCache(initialFlagIcons), [initialFlagIcons]);
  useEffect(() => setNavIconsHydrated(true), []);
  useEffect(() => {
    if (!desktopViewport || activeTab === "assistant") return;
    const win = window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
    const start = () => {
      setFloatingAssistantReady(true);
    };
    if (typeof win.requestIdleCallback === "function") {
      const id = win.requestIdleCallback(start, { timeout: 2500 });
      return () => win.cancelIdleCallback?.(id);
    }
    const id = window.setTimeout(start, 1200);
    return () => window.clearTimeout(id);
  }, [desktopViewport, activeTab]);
  useLayoutEffect(() => {
    applyMarketBadges(initialSettings.marketBadges, initialSettings.marketBadgesVisible);
  }, [initialSettings.marketBadges, initialSettings.marketBadgesVisible]);

  // 兼容升级前已经加入但仍为首字母占位的股票；每个标的本次会话只尝试一次，双 worker 后台补齐。
  useEffect(() => {
    if (!["holdings", "watchlist", "assets", "pnl", "fire", "earnings"].includes(activeTab)) return;
    const missing = records.filter((record) => {
      const market = record.market.toUpperCase();
      const key = `${market}:${record.code.toUpperCase()}`;
      if (!["US", "HK", "CN", "JP", "KR"].includes(market) || attemptedIconBackfillRef.current.has(key)) return false;
      return !pickStockIcon(stockIcons, market, record.code) && !pickStockIcon(initialStockIcons, market, record.code);
    });
    if (!missing.length) return;
    let cursor = 0;
    let cancelled = false;
    const worker = async () => {
      while (!cancelled && cursor < missing.length) {
        const record = missing[cursor++];
        attemptedIconBackfillRef.current.add(`${record.market.toUpperCase()}:${record.code.toUpperCase()}`);
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
    return () => { cancelled = true; };
  }, [activeTab, initialStockIcons, records, stockIcons]);

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
    (r: StockRecord) => accountHoldingPrice(r, quotes),
    [quotes]
  );

  const reloadActivities = useCallback(() => {
    if (activeTabRef.current !== "activities") return;
    fetch("/api/activities")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.userLogs) setUserLogs(data.userLogs);
        if (data?.systemLogs) setSystemLogs(data.systemLogs);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (activeTab !== "activities") return;
    // 直达日志页已有服务端首屏数据，其他页切入日志时才请求。
    if (skipInitialActivityFetchRef.current) {
      skipInitialActivityFetchRef.current = false;
      return;
    }
    reloadActivities();
  }, [activeTab, reloadActivities]);

  const reloadSettings = useCallback(() => {
    const generation = ++settingsReloadGeneration.current;
    fetch("/api/settings")
      .then((res) => (res.ok ? res.json() : null))
      .then((st) => {
        if (generation !== settingsReloadGeneration.current) return;
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
        if (s.mobileNavigationOrder) setMobileNavigationOrder(s.mobileNavigationOrder);
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
      const cached = JSON.parse(localStorage.getItem(quoteCacheKey) || "null") as { updatedAt?: number; quotes?: Record<string, Quote>; instruments?: Record<string, string> } | null;
      // 完整成功快照不因时间过期而丢弃：它只承担刷新首帧兜底，挂载后仍会立即请求最新行情。
      // 数据库里的录入价通常更旧，回退到它会让总资产先闪出完全错误的中间值。
      if (cached?.quotes) {
        const validQuotes = restoreQuoteSnapshot(cached.quotes, cached.instruments, records);
        quotesRef.current = validQuotes;
        setQuotes(validQuotes);
        const positionIds = records.filter((record) => Number(record.qty) > 0 && record.code.trim()).map((record) => record.id);
        setValuationReady(positionIds.every((id) => Number.isFinite(Number(validQuotes[id]?.price))));
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
    const quoteRecords = records.filter((record) => record.code.trim() && (
      options?.force || !initialQuoteLoadRef.current || !loadedQuoteKeysRef.current.has(quoteInstrumentKey(record)) || (!options?.missingOnly && activeMarkets.has(record.market.toUpperCase()))
    ));
    // 首次进入拉取全部市场的收盘快照；后续仅轮询当前处于盘前/盘中/盘后的市场。
    if (quoteRecords.length === 0) return;
    refreshingRef.current = true;
    const controller = new AbortController();
    quoteRequestRef.current = controller;
    setRefreshing(true);
    try {
      const result = await readQuoteBatches(quoteRecords.map(r => ({ id: r.id, market: r.market, code: r.code })), controller.signal);
      // 无有效返回不刷新时间，也不把旧值当作本次新行情。
      if (!Object.keys(result.quotes).length) return;
      const currentRecords = recordsRef.current;
      const merged = applyQuoteBatches(quotesRef.current, result, quoteRecords, currentRecords);
      const positionIds = currentRecords.filter((record) => Number(record.qty) > 0 && record.code.trim()).map((record) => record.id);
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
          localStorage.setItem(quoteCacheKeyRef.current, JSON.stringify({ updatedAt: Date.now(), quotes: merged, instruments: Object.fromEntries(currentRecords.map(record => [record.id, quoteInstrumentKey(record)])) }));
        }
      } catch {
        /* localStorage 不可用时不影响实时行情 */
      }
      currentRecords.forEach(record => {
        if (merged[record.id] === result.quotes[record.id] && result.quotes[record.id]) loadedQuoteKeysRef.current.add(quoteInstrumentKey(record));
      });
      setQuoteAt(new Date().toLocaleTimeString("zh-CN", { hour12: false }));
      quoteFetchedAtRef.current = Date.now();
      try {
        const refreshedAt = new Date();
        localStorage.setItem("fire:last-quotes-refresh", refreshedAt.toLocaleTimeString("zh-CN", { hour12: false }));
        localStorage.setItem("fire:last-quotes-refresh-at", String(refreshedAt.getTime()));
      } catch {
        /* 忽略存储不可用 */
      }
      initialQuoteLoadRef.current = true;
    } catch {
      /* 行情失败时保留原价 */
    } finally {
      if (quoteRequestRef.current === controller) quoteRequestRef.current = null;
      refreshingRef.current = false;
      setRefreshing(false);
    }
  }, [records]);

  useEffect(() => () => quoteRequestRef.current?.abort(), []);

  useEffect(() => {
    // 自选股页面由自身的刷新间隔控件管理定时器，避免这里的 30 秒兜底计时器覆盖用户选择。
    if (records.length === 0 || !["holdings", "assets", "fire", "pnl", "watchlist"].includes(activeTab)) return;
    if (activeTab === "watchlist") { void refreshQuotes({ missingOnly: true }); return; }
    // 刚拿到的行情不因为换页再请求一轮，免得新页面刚出现就跟着重绘。
    const elapsed = quoteFetchedAtRef.current ? Date.now() - quoteFetchedAtRef.current : 30_000;
    const wait = Math.max(0, 30_000 - elapsed);
    let interval = 0;
    const start = window.setTimeout(() => {
      void refreshQuotes();
      interval = window.setInterval(() => { void refreshQuotes(); }, 30_000);
    }, wait);
    return () => {
      window.clearTimeout(start);
      window.clearInterval(interval);
    };
  }, [records.length, refreshQuotes, activeTab]);

  const rememberPage = useCallback((key: string) => {
    pageMemory.current.set(key, `${window.location.pathname}${window.location.search}${window.location.hash}`);
  }, []);
  const rememberLeaving = useCallback((from: string) => {
    rememberPage(from);
    scrollMemory.current.set(from, {
      top: window.scrollY,
      inner: contentRef.current?.scrollTop || 0
    });
  }, [rememberPage]);
  const preparePageSwitch = useCallback(() => {
    document.documentElement.classList.add("fire-workspace-switching");
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && contentRef.current?.contains(focused)) focused.blur();
  }, []);
  const retainTab = useCallback((key: TabKey) => {
    setMountedTabs((current) => current.includes(key) ? current : [...current, key]);
  }, []);
  const reopenTab = useCallback((key: TabKey) => {
    panels.current.delete(key);
    panelBuiltStamp.current.delete(key);
    setPanelEpoch((current) => ({ ...current, [key]: (current[key] ?? 0) + 1 }));
  }, []);

  // 统一的无感导航：只改状态 + 地址栏，不触发路由重载
  const navigateTo = useCallback(
    (key: TabKey, sub?: string | null) => {
      const from = activeTabRef.current;
      if (from !== key) {
        preparePageSwitch();
        rememberLeaving(from);
        scrollIntentRef.current = true;
      }
      setPanelDirection(mobilePanelDirection(from, key, mobilePrimaryOrder));
      activeTabRef.current = key;
      setActiveTab(key);
      retainTab(key);
      const tab = navTabs.find((t) => t.key === key);
      const fallback = key === "pnl" ? "/asset-pnl-analysis" : tab?.url || `/${key}`;
      if (key === "settings") {
        setSettingsSub(sub ?? null);
        pageMemory.current.delete(key);
        scrollMemory.current.set(key, { top: 0, inner: 0 });
        reopenTab(key);
        window.history.pushState({}, "", fallback + (sub ? `?sub=${sub}` : ""));
      } else {
        window.history.pushState({}, "", pageMemory.current.get(key) || fallback);
      }
    },
    [navTabs, mobilePrimaryOrder, preparePageSwitch, rememberLeaving, retainTab, reopenTab]
  );

  const selectTab = useCallback(
    (key: TabKey) => {
      // Re-selecting the workspace is not a reset: retain its filters, detail URL and scroll position.
      if (key === activeTabRef.current) return;
      // The workspace tab opens the settings home. Only an explicit deep link
      // should reopen a detail panel; a previous sub-page must not be sticky.
      navigateTo(key, null);
    },
    [navigateTo]
  );

  const returnFromAssetPnl = useCallback(() => {
    restoreAssetScrollRef.current = Boolean(assetReturnRef.current);
    selectTab("assets");
    if (assetReturnRef.current) window.history.replaceState({}, "", assetReturnRef.current.url);
  }, [selectTab]);

  const navigateFromAssistant = useCallback((path: string) => {
    const url = new URL(path, window.location.origin);
    const target = url.pathname === "/asset-pnl-analysis"
      ? "pnl"
      : navTabs.find((tab) => (tab.url || `/${tab.key}`) === url.pathname)?.key;
    if (!target) return;
    const next = target as TabKey;
    if (activeTabRef.current !== next) {
      preparePageSwitch();
      rememberLeaving(activeTabRef.current);
      scrollIntentRef.current = true;
    }
    const nextUrl = `${url.pathname}${url.search}${url.hash}`;
    pageMemory.current.set(next, nextUrl);
    setPanelDirection(mobilePanelDirection(activeTabRef.current, next, mobilePrimaryOrder));
    activeTabRef.current = next;
    setActiveTab(next);
    retainTab(next);
    window.history.pushState({}, "", nextUrl);
  }, [navTabs, mobilePrimaryOrder, preparePageSwitch, rememberLeaving, retainTab]);

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
    function showFromHistory(key: TabKey) {
      const here = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      pageMemory.current.set(key, here);
      reopenTab(key);
      setPanelDirection(mobilePanelDirection(activeTabRef.current, key, mobilePrimaryOrder));
      if (activeTabRef.current === "pnl" && key === "assets") restoreAssetScrollRef.current = Boolean(assetReturnRef.current);
      if (activeTabRef.current !== key) {
        preparePageSwitch();
        scrollIntentRef.current = true;
      }
      activeTabRef.current = key;
      setActiveTab(key);
      retainTab(key);
      if (key === "settings") setSettingsSub(new URLSearchParams(window.location.search).get("sub"));
    }
    function onPop() {
      if (window.location.pathname === "/asset-pnl-analysis") {
        showFromHistory("pnl");
        return;
      }
      const tab = navTabs.find((t) => (t.url || `/${t.key}`) === window.location.pathname);
      if (tab) showFromHistory(tab.key as TabKey);
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [navTabs, mobilePrimaryOrder, preparePageSwitch, reopenTab, retainTab]);

  useEffect(() => {
    function onVisibility() {
      if (document.hidden) { quoteRequestRef.current?.abort(); return; }
      // 自选页有独立的刷新间隔控件；切回标签页时不能绕过用户选择额外刷新。
      if (!document.hidden && ["holdings", "watchlist", "assets", "pnl", "fire"].includes(activeTab)) void refreshQuotes(activeTab === "watchlist" ? { initialOnly: true } : undefined);
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [activeTab, refreshQuotes]);

  useEffect(() => {
    function reloadRecords() {
      fetch("/api/records")
        .then((res) => (res.ok ? res.json() : null))
        .then((d) => d && setRecords(d));
      if (activeTabRef.current === "activities") reloadActivities();
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
    a.download = `alcor-backup-${stamp}.json`;
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
          const custom = key === "TRADING" ? undefined : initialNavIcons[key] || (navIconsHydrated ? assetIcons[key] : undefined);
          return {
            key: t.key as TabKey,
            label: t.label,
            icon: (
              <SafeAssetImage
                src={custom}
                loading="lazy"
                fallback={NAV_ICONS[t.key]}
                className="nav-custom-icon h-[17px] w-[17px] flex-none object-contain"
              />
            )
          };
        }),
    [navTabs, user, assetIcons, initialNavIcons, navIconsHydrated]
  );
  const randomWorkspaceKeys = useMemo(
    () => sidebarTabs.filter((tab) => !["users", "attachments", "library", "cards", "activities", "settings"].includes(tab.key)).map((tab) => tab.key),
    [sidebarTabs]
  );
  useEffect(() => {
    const keys = sidebarTabs.map((tab) => tab.key).filter((key) => key !== activeTabRef.current);
    let index = 0;
    let handle = 0;
    const win = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    const pump = () => {
      if (index >= keys.length) return;
      preloadView(keys[index]);
      index += 1;
      handle = schedule(pump);
    };
    function schedule(task: () => void) {
      if (typeof win.requestIdleCallback === "function") return win.requestIdleCallback(task, { timeout: 1200 });
      return window.setTimeout(task, 180);
    }
    handle = schedule(pump);
    return () => {
      if (typeof win.cancelIdleCallback === "function" && typeof win.requestIdleCallback === "function") win.cancelIdleCallback(handle);
      else window.clearTimeout(handle);
    };
  }, [sidebarTabs]);

  const updateSidebarScroll = useCallback(() => {
    const nav = desktopNavRef.current;
    if (!nav) return;
    const railHeight = nav.clientHeight;
    const scrollable = nav.scrollHeight > railHeight + 1;
    const visible = scrollable;
    const height = scrollable ? Math.max(32, railHeight * railHeight / nav.scrollHeight) : 0;
    const top = scrollable ? nav.scrollTop / (nav.scrollHeight - railHeight) * (railHeight - height) : 0;
    setSidebarScroll(previous => previous.top === top && previous.height === height && previous.visible === visible
      ? previous : { top, height, visible });
  }, []);

  useEffect(() => {
    const nav = desktopNavRef.current;
    if (!desktopViewport || !nav) return;
    const observer = new ResizeObserver(updateSidebarScroll);
    observer.observe(nav);
    window.addEventListener("resize", updateSidebarScroll);
    const frame = window.requestAnimationFrame(updateSidebarScroll);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateSidebarScroll);
      window.cancelAnimationFrame(frame);
    };
  }, [desktopViewport, sidebarTabs, updateSidebarScroll]);

  // 行情、持仓等没变时戳保持不变。换页就能沿用上次的节点，不再把整页重算一遍。
  const panelDataStamp = useMemo(() => ({}), [
    records, quotes, quoteAt, refreshing, livePrice, valuationReady,
    groups, markets, marketLabels, marketOptions, userLogs, systemLogs, user,
    navTabs, mobileNavigationOrder, settingsSub, settingsSubReady,
    initialNow, initialVersion, initialSymbol, initialCelebAvatars, initialCelebs, initialUser,
    initialWatchGroups, initialAssistantHistory, initialPasskeys, initialFundBalances,
    initialSettings, initialAssetLibrary, initialCardLibrary, initialFeed
  ]);

  const settingsPanel = (
    <div className="relative h-full min-h-0">
      {!settingsSubReady && (
        <div className="settings-first-frame" aria-hidden="true">
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
          initialPasskeys={initialPasskeys}
          initialSettings={initialSettings}
        />
      </div>
    </div>
  );

  if (typeof document !== "undefined") setAssistantPage(activeTab);
  // translate="no" + notranslate：整页禁止机器翻译。<html> 上已经声明过一次，这里在应用主体上再标一次——
  // 翻译扩展通常按「最近的祖先」判断要不要翻。翻译器会在水合前改写 DOM（连 title 属性都会动：
  // 实测把「繁體」改成了「繁体」），React 一比对就报 Hydration failed。站内的繁简 / 英文切换不受影响。
  return (
    <>
    <div translate="no" data-tablet-device={tabletDevice ? "true" : "false"} data-tablet-sidebar-collapsed={tabletSidebarCollapsed === true ? "true" : "false"} data-tablet-sidebar-side={tabletSidebarSide === "right" ? "right" : "left"} className={`records-app notranslate flex items-start${activeTab === "settings" ? " is-settings" : ""}`}>
      {/* 桌面侧边导航 */}
      <aside className={`fire-sidebar sticky top-[88px] hidden w-[240px] flex-none lg:block ${activeTab === "settings" ? "is-settings" : ""}`}>
        <nav id="fire-desktop-nav" ref={desktopNavRef} onScroll={updateSidebarScroll} className="fire-sidebar-panel relative flex min-h-0 flex-col overflow-y-auto rounded-2xl px-2 pb-7">
          {fourDoorEnabled === true && fourDoorViewport && (
            <div className={`four-door-anchor ${fourDoorPinned ? "is-pinned" : ""}`}>
              {/* 预览自身也可能等待下载；失败只收起装饰，不影响侧栏入口。 */}
              <WorkspaceBoundary fallback={<></>}><Suspense fallback={null}>
                <WorkspaceBoundary fallback={<FourDoorLoading activeKey={activeTab} />}><Suspense fallback={<FourDoorLoading activeKey={activeTab} />}><FourDoorNavigator activeKey={activeTab} randomKeys={randomWorkspaceKeys} onSelect={(key) => selectTab(key as TabKey)} pinned={fourDoorPinned} onTogglePinned={() => setFourDoorPinned(value => !value)} /></Suspense></WorkspaceBoundary>
              </Suspense></WorkspaceBoundary>
            </div>
          )}
          <div className="fire-sidebar-section-label">资产</div>
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
                  onPointerEnter={(event) => { if (event.pointerType === "mouse" && t.key !== activeTab) preloadView(t.key); }}
                  onPointerDown={() => { if (t.key !== activeTab) preloadView(t.key); }}
                  onFocus={() => { if (t.key !== activeTab) preloadView(t.key); }}
                  draggable
                  onDragStart={() => { tabDragKeyRef.current = t.key; }}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => onTabDrop(t.key)}
                  onDragEnd={() => { tabDragKeyRef.current = null; }}
                  title={`${t.label}（可拖动排序）`}
                  aria-label={t.label}
                  aria-current={activeTab === t.key ? "page" : undefined}
                  className={`fire-sidebar-item flex h-[42px] w-full cursor-grab items-center gap-3 rounded-[10px] px-3 text-[15px] font-medium active:cursor-grabbing ${
                    activeTab === t.key
                      ? "fire-sidebar-item-active text-ink dark:text-white"
                      : "text-muted hover:bg-black/[.05] hover:text-ink dark:hover:bg-[#2a2a2a]"
                  }`}
                >
                  {t.icon}
                  <span className="fire-sidebar-label truncate">{t.label}</span>
                </button>
              </div>
            );
          })}
        </nav>
        <div className="fire-sidebar-tablet-controls" aria-label="平板侧栏设置">
          <button type="button" onClick={() => setTabletSidebarCollapsed(value => !value)} aria-label={tabletSidebarCollapsed ? "展开侧栏" : "收回侧栏"} aria-controls="fire-desktop-nav" aria-expanded={!tabletSidebarCollapsed} title={tabletSidebarCollapsed ? "展开侧栏" : "收回侧栏"}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M9 4v16m7-11-3 3 3 3" /></svg>
            <span>{tabletSidebarCollapsed ? "展开侧栏" : "收回侧栏"}</span>
          </button>
          <button type="button" onClick={() => setTabletSidebarSide(value => value === "left" ? "right" : "left")} aria-label={tabletSidebarSide === "right" ? "移到左侧" : "移到右侧"} title={tabletSidebarSide === "right" ? "移到左侧" : "移到右侧"}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3" /><path d={tabletSidebarSide === "right" ? "M15 4v16m-4-11-3 3 3 3" : "M9 4v16m4-11 3 3-3 3"} /></svg>
            <span>{tabletSidebarSide === "right" ? "移到左侧" : "移到右侧"}</span>
          </button>
        </div>
        {sidebarScroll.visible && <span aria-hidden="true" className="fire-sidebar-scroll-indicator" style={{ top: sidebarScroll.top + 1, height: sidebarScroll.height }} />}
      </aside>

      {/* 内容区 */}
      <div ref={contentRef} className="records-content min-w-0 flex-1">
        {activeTab !== "settings" && <WorkspaceNavigation items={sidebarTabs} order={mobileNavigationOrder} activeKey={activeTab} onPrepare={key => preloadView(key as TabKey)} onSelect={key => {
          if (key === activeTab) return;
          selectTab(key as TabKey);
        }} />}
        {/* 设置采用独立的分层页面 */}
        {activeTab === "settings" && <div className="settings-mobile-toolbar"><button type="button" aria-label="关闭设置" onClick={() => selectTab("holdings")}><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></div>}

        {mountedTabs.map((tab) => {
          const active = tab === activeTab;
          // 隐藏页、以及数据未变的当前页，都沿用上次节点。换页只改隐藏，避免整页重算造成顿挫。
          let node = panels.current.get(tab) ?? null;
          if (active && (node == null || panelBuiltStamp.current.get(tab) !== panelDataStamp)) {
            node = (
            <>
          {activeTab === "watchlist" && (
            <WatchlistView
              initialSymbol={initialSymbol}
              initialNow={initialNow}
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
              initialModuleOrder={initialSettings.assetAnalysisOrder}
              records={records}
              quotes={quotes}
              livePrice={livePrice}
              user={{
                username: user?.username ?? "",
                nickname: user?.nickname ?? "",
                avatar: user?.avatar ?? ""
              }}
              refreshQuotes={refreshQuotes}
              onReady={restoreAssetPosition}
              onOpenPnlAnalysis={() => {
                assetReturnRef.current = { url: `${window.location.pathname}${window.location.search}${window.location.hash}`, top: window.scrollY, innerTop: contentRef.current?.scrollTop || 0 };
                scrollMemory.current.set("pnl", { top: 0, inner: 0 });
                selectTab("pnl");
              }}
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
            <MobileBackGesture onBack={returnFromAssetPnl}><AssetPnlAnalysisView
              onBack={returnFromAssetPnl}
              initialRecords={records}
              initialQuotes={quotes}
            /></MobileBackGesture>
          )}
          {activeTab === "activities" && <ActivitiesView userLogs={userLogs} systemLogs={systemLogs} isAdmin={user?.role === "admin"} onRefresh={reloadActivities} />}
          {activeTab === "global" && <GlobalPreviewView />}
          {activeTab === "trading" && <FeedView initial={initialFeed} initialNow={initialNow} />}
          {activeTab === "earnings" && <EarningsCalendarView records={records} canManage={initialUser.role === "admin"} initialNow={initialNow} />}
          {activeTab === "assistant" && <AssistantView page="assistant" symbol={initialSymbol} userId={user.id} initialHistory={initialAssistantHistory} onNavigate={navigateFromAssistant} />}
          {activeTab === "celebs" && <CelebsView isAdmin={user?.role === "admin"} initialAvatars={initialCelebAvatars} initialData={initialCelebs} />}
          {activeTab === "users" && (user?.role === "admin" ? <UsersView /> : <NoPermission />)}
          {activeTab === "attachments" && (user?.role === "admin" ? <AttachmentsView /> : <NoPermission />)}
          {activeTab === "library" && (user?.role === "admin" ? <AssetLibraryView initialCdnEnabled={initialSettings.stockIconCdn} initialAssets={initialAssetLibrary?.assets} initialTotal={initialAssetLibrary?.total} /> : <NoPermission />)}
          {activeTab === "cards" && <CardLibraryView initial={initialCardLibrary} />}
          {activeTab === "settings" && (
            <SettingsWindow version={initialVersion}>{settingsPanel}</SettingsWindow>
          )}
            </>
            );
            panels.current.set(tab, node);
            panelBuiltStamp.current.set(tab, panelDataStamp);
          }
          return (
            <div key={`${tab}:${panelEpoch[tab] ?? 0}`} hidden={!active} data-direction={active ? panelDirection : "none"} className="tab-panel min-w-0">
              <WorkspacePanel active={active} path={tab === "pnl" ? "/asset-pnl-analysis" : navTabs.find(item => item.key === tab)?.url || `/${tab}`} query={active ? searchParams.toString() : new URL(pageMemory.current.get(tab) || "/", "http://workspace.invalid").search}>{node}</WorkspacePanel>
            </div>
          );
        })}
      </div>
    </div>
    {desktopViewport && activeTab !== "assistant" && floatingAssistantReady && <FloatingAssistant symbol={initialSymbol} userId={user.id} onNavigate={navigateFromAssistant} />}
    </>
  );
}
