"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import {
  MARKET_LIST,
  marketMeta,
  type Activity, type SystemLog, type TradeOrder,
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
// 视图按需懒加载：仅激活页签才下载对应代码，显著减小后端首屏包体积。
const TabLoading = () => (
  <div className="flex items-center justify-center py-24 text-sm text-faint">加载中…</div>
);

// 首屏默认页已有服务端注入的 records/settings，直接 SSR，避免应用壳渲染后长时间停在“加载中”。
const WatchlistView = dynamic(() => import("@/components/views/WatchlistView"), { ssr: true, loading: TabLoading });
const HoldingsView = dynamic(() => import("@/components/views/HoldingsView"), { ssr: true, loading: TabLoading });
const AssetAnalysisView = dynamic(() => import("@/components/views/AssetAnalysisView"), { ssr: true, loading: TabLoading });
const FireView = dynamic(() => import("@/components/views/FireView"), { ssr: true, loading: TabLoading });
const ActivitiesView = dynamic(() => import("@/components/views/ActivitiesView"), { ssr: false, loading: TabLoading });
const EarningsCalendarView = dynamic(() => import("@/components/views/EarningsCalendarView"), { ssr: false, loading: TabLoading });
const CelebsView = dynamic(() => import("@/components/views/CelebsView"), { ssr: false, loading: TabLoading });
const SettingsView = dynamic(() => import("@/components/views/SettingsView"), { ssr: false, loading: TabLoading });
const UsersView = dynamic(() => import("@/components/views/UsersView"), { ssr: false, loading: TabLoading });
const AssetLibraryView = dynamic(() => import("@/components/views/AssetLibraryView"), { ssr: false, loading: TabLoading });
const AttachmentsView = dynamic(() => import("@/components/views/AttachmentsView"), { ssr: false, loading: TabLoading });
const GlobalPreviewView = dynamic(() => import("@/components/views/GlobalPreviewView"), { ssr: false, loading: TabLoading });
const AssetPnlAnalysisView = dynamic(() => import("@/components/AssetPnlAnalysis"), { ssr: false, loading: TabLoading });

// 当前直达页与鉴权/记录请求并行加载，避免数据准备好后才开始下载视图组件，
// 从而在首次进入 FIRE、持仓、自选股等页面时额外出现一轮「加载中…」。
const VIEW_PRELOADERS: Record<string, () => Promise<unknown>> = {
  watchlist: () => import("@/components/views/WatchlistView"),
  holdings: () => import("@/components/views/HoldingsView"),
  assets: () => import("@/components/views/AssetAnalysisView"),
  fire: () => import("@/components/views/FireView"),
  activities: () => import("@/components/views/ActivitiesView"),
  global: () => import("@/components/views/GlobalPreviewView"),
  earnings: () => import("@/components/views/EarningsCalendarView"),
  celebs: () => import("@/components/views/CelebsView"),
  users: () => import("@/components/views/UsersView"),
  attachments: () => import("@/components/views/AttachmentsView"),
  library: () => import("@/components/views/AssetLibraryView"),
  settings: () => import("@/components/views/SettingsView"),
  pnl: () => import("@/components/AssetPnlAnalysis")
};
import { showToast } from "@/lib/toast";
import { activeQuoteMarkets } from "@/lib/marketSessions";
import SettingsWindow from "@/components/SettingsWindow";
import { primeStockIconCache, useAssetIcons } from "@/lib/useAssetIcons";
import { NAV_ICONS } from "@/lib/navIcons";
import SafeAssetImage from "@/components/SafeAssetImage";

type TabKey = "watchlist" | "holdings" | "assets" | "fire" | "activities" | "global" | "earnings" | "celebs" | "users" | "attachments" | "library" | "settings" | "pnl";

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
  { key: "quotes", label: "股票添加", url: "/quotes" },
  { key: "earnings", label: "财报日历", url: "/earnings" },
  { key: "celebs", label: "名人持仓", url: "/celebs" },
  { key: "users", label: "用户管理", url: "/users" },
  { key: "attachments", label: "附件管理", url: "/attachments" },
  { key: "library", label: "素材库", url: "/library" },
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
  initialActivities,
  initialSettings,
  initialStockIcons
}: {
  initialTab: string;
  initialSymbol?: string;
  initialCelebAvatars?: Record<string, string>;
  initialUser: User;
  initialRecords: StockRecord[];
  initialActivities: Activity[];
  initialSettings: Pick<SiteSettings, "tabs" | "groups" | "markets" | "marketLabels" | "stockIconCdn">;
  initialStockIcons: Record<string, string>;
}) {
  // 子页面首次渲染前先把 SSR 图标写入共享缓存，消除素材接口返回前的空白占位。
  primeStockIconCache(initialStockIcons);
  const router = useRouter();
  const [user] = useState<User>(initialUser);
  const [records, setRecords] = useState<StockRecord[]>(initialRecords);
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [quoteAt, setQuoteAt] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  const initialQuoteLoadRef = useRef(false);
  const loadedQuoteIdsRef = useRef(new Set<string>());
  const quoteCacheKeyRef = useRef("");
  const mobileNavRef = useRef<HTMLDivElement>(null);
  const [activities, setActivities] = useState<Activity[]>(initialActivities);
  const [systemLogs, setSystemLogs] = useState<SystemLog[]>([]);
  const [orders, setOrders] = useState<TradeOrder[]>([]);
  const [activeTab, setActiveTab] = useState<TabKey>(initialTab as TabKey);
  const [navTabs, setNavTabs] = useState<TabConfig[]>(() => withFireTab(initialSettings.tabs));
  const [navReady, setNavReady] = useState(true);
  const [settingsSub, setSettingsSub] = useState<string | null>(null);
  const [groups, setGroups] = useState<GroupConfig[]>(initialSettings.groups);
  const [markets, setMarkets] = useState<Market[]>(initialSettings.markets);
  const [marketLabels, setMarketLabels] = useState<{ key: string; label: string; flag: string }[]>(initialSettings.marketLabels);
  const { assetIcons } = useAssetIcons(["icon"], { stockIconCdn: initialSettings.stockIconCdn });

  useEffect(() => {
    void VIEW_PRELOADERS[initialTab]?.();
    if (initialTab === "settings") {
      setSettingsSub(new URLSearchParams(window.location.search).get("sub"));
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
        if (data?.activities) setActivities(data.activities);
        if (data?.systemLogs) setSystemLogs(data.systemLogs);
        if (data?.orders) setOrders(data.orders);
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

  useEffect(() => {
    // v3：行情快照只负责消除刷新闪屏；用户、持仓和设置已由服务端首帧注入。
    const quoteCacheKey = `fire:quotes:v4:${initialUser.id}`;
    quoteCacheKeyRef.current = quoteCacheKey;
    try {
      const cached = JSON.parse(localStorage.getItem(quoteCacheKey) || "null") as { updatedAt?: number; quotes?: Record<string, Quote> } | null;
      if (cached?.quotes && Date.now() - Number(cached.updatedAt || 0) < 30 * 60 * 1000) {
        setQuotes(cached.quotes);
      }
    } catch {
      /* 缓存损坏时由行情刷新覆盖 */
    }
  }, [initialUser.id]);

  const refreshQuotes = useCallback(async (options?: { force?: boolean }) => {
    // 手动刷新（force）绕过轮询互斥与后台标签页限制，保证点击必有效果
    if ((!options?.force && refreshingRef.current) || records.length === 0 || (!options?.force && document.hidden)) return;
    const activeMarkets = activeQuoteMarkets(records.map((record) => record.market));
    const quoteRecords = records.filter((record) =>
      !initialQuoteLoadRef.current || !loadedQuoteIdsRef.current.has(record.id) || activeMarkets.has(record.market.toUpperCase())
    );
    // 首次进入拉取全部市场的收盘快照；后续仅轮询当前处于盘前/盘中/盘后的市场。
    if (quoteRecords.length === 0) return;
    refreshingRef.current = true;
    setRefreshing(true);
    try {
      const res = await fetch("/api/quotes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: quoteRecords.map((r) => ({ id: r.id, market: r.market, code: r.code }))
        })
      });
      if (res.status === 401) {
        router.replace("/login");
        return;
      }
      const data = await res.json();
      if (data.quotes) {
        setQuotes((prev) => {
          const merged = { ...prev };
          Object.entries(data.quotes as Record<string, Quote>).forEach(([id, quote]) => {
            merged[id] = quote;
          });
          // 本次请求了但未返回的标的：删除旧行情，资产估值回退 records.price，
          // 当日盈亏回退为 0；未参与本次请求的休市标继续保留已有行情。
          quoteRecords.forEach((r) => {
            if (!data.quotes[r.id]) delete merged[r.id];
          });
          const positionIds = records
            .filter((record) => Number(record.qty) > 0)
            .map((record) => record.id);
          const completeSnapshot = positionIds.every((id) => {
            const quote = merged[id];
            return Boolean(quote) && Number.isFinite(Number(quote.price));
          });
          try {
            // 只缓存完整后端快照，避免下次刷新先恢复一份缺股的资产数据。
            if (completeSnapshot && quoteCacheKeyRef.current) {
              localStorage.setItem(quoteCacheKeyRef.current, JSON.stringify({ updatedAt: Date.now(), quotes: merged }));
            }
          } catch {
            /* localStorage 不可用时不影响实时行情 */
          }
          return merged;
        });
        Object.keys(data.quotes).forEach((id) => loadedQuoteIdsRef.current.add(id));
        setQuoteAt(new Date().toLocaleTimeString("zh-CN", { hour12: false }));
        try {
          localStorage.setItem("fire:last-quotes-refresh", new Date().toLocaleTimeString("zh-CN", { hour12: false }));
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
  }, [records, router]);

  useEffect(() => {
    // 自选股页面由自身的刷新间隔控件管理定时器，避免这里的 30 秒兜底计时器覆盖用户选择。
    if (records.length === 0 || activeTab === "watchlist") return;
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
      void VIEW_PRELOADERS[key]?.();
      if (key === "settings") navigateTo(key, settingsSub);
      else navigateTo(key, null);
    },
    [navigateTo, settingsSub]
  );

  const preloadTab = useCallback((key: TabKey) => {
    void VIEW_PRELOADERS[key]?.();
  }, []);

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
      if (!document.hidden) refreshQuotes();
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [refreshQuotes]);

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
      reloadActivities();
      return true;
    } catch (err) {
      alert(err instanceof Error ? err.message : "保存失败");
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
      alert(err instanceof Error ? err.message : "保存失败");
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
      alert("删除失败");
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
      alert(err instanceof Error ? err.message : "删除失败");
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
      setQuotes({});
      showToast("已清空全部记录");
      window.dispatchEvent(new Event("fire:records-updated"));
      reloadActivities();
      return true;
    }
    const data = await res.json().catch(() => null);
    alert(data?.error || "清空失败");
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
          const custom = assetIcons[t.key.toUpperCase()];
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
    [navTabs, user, assetIcons]
  );

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
    />
  );

  return (
    <>
    <div className="records-app flex items-start gap-6">
      {/* 桌面侧边导航 */}
      <aside className="sticky top-[88px] hidden w-[220px] flex-none lg:block">
        <nav className="relative rounded-2xl bg-bg-gray p-2">
          {sidebarTabs.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => selectTab(t.key)}
              onMouseEnter={() => preloadTab(t.key)}
              onFocus={() => preloadTab(t.key)}
              onTouchStart={() => preloadTab(t.key)}
              draggable
              onDragStart={() => { tabDragKeyRef.current = t.key; }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => onTabDrop(t.key)}
              onDragEnd={() => { tabDragKeyRef.current = null; }}
              title={`${t.label}（可拖动排序）`}
              className={`flex h-[44px] w-full cursor-grab items-center gap-3 rounded-[12px] px-4 text-sm transition-all duration-200 active:cursor-grabbing ${
                activeTab === t.key
                  ? "bg-white font-semibold text-ink shadow-[0_1px_4px_rgba(10,14,25,.08)] dark:bg-[#1c222d] dark:text-white"
                  : "text-muted hover:bg-white/60 hover:text-ink dark:hover:bg-white/10"
              }`}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </nav>
      </aside>

      {/* 内容区 */}
      <div className="min-w-0 flex-1">
        {/* 移动端顶部标签 */}
        <div ref={mobileNavRef} className="mobile-tab-nav mb-6 flex overflow-x-auto rounded-2xl bg-bg-gray p-1 lg:hidden">
          {sidebarTabs.map((t) => (
            <button
              key={t.key}
              data-nav-tab={t.key}
              type="button"
              onClick={() => selectTab(t.key)}
              onMouseEnter={() => preloadTab(t.key)}
              onFocus={() => preloadTab(t.key)}
              onTouchStart={() => preloadTab(t.key)}
              className={`flex min-w-[76px] flex-1 flex-col items-center gap-1 rounded-xl px-2 py-2.5 text-xs transition-all duration-200 ${
                activeTab === t.key ? "bg-white font-semibold text-ink shadow-[0_1px_4px_rgba(10,14,25,.08)]" : "text-muted"
              }`}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>

        <div key={activeTab} className="tab-panel min-w-0">
          {activeTab === "watchlist" && (
            <WatchlistView
              initialSymbol={initialSymbol}
              records={records}
              quotes={quotes}
              quoteAt={quoteAt}
              refreshing={refreshing}
              refreshQuotes={refreshQuotes}
              onAddMatch={(m) => addFromSearch(m, "watchlist")}
              onUpdate={updateRecord}
              onRemove={removeRecord}
              onToggleWatch={toggleWatch}
              onBatchDelete={batchDeleteRecords}
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
          {activeTab === "pnl" && <AssetPnlAnalysisView onBack={() => selectTab("assets")} />}
          {activeTab === "activities" && <ActivitiesView activities={activities} orders={orders} systemLogs={systemLogs} isAdmin={user?.role === "admin"} onRefresh={reloadActivities} />}
          {activeTab === "global" && <GlobalPreviewView />}
          {activeTab === "earnings" && <EarningsCalendarView records={records} />}
          {activeTab === "celebs" && <CelebsView isAdmin={user?.role === "admin"} initialAvatars={initialCelebAvatars} />}
          {activeTab === "users" && (user?.role === "admin" ? <UsersView /> : <NoPermission />)}
          {activeTab === "attachments" && (user?.role === "admin" ? <AttachmentsView /> : <NoPermission />)}
          {activeTab === "library" && (user?.role === "admin" ? <AssetLibraryView /> : <NoPermission />)}
          {activeTab === "settings" && (
            <SettingsWindow>{settingsPanel}</SettingsWindow>
          )}
        </div>
      </div>
    </div>
    </>
  );
}
