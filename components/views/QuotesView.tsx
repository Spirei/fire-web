"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { usePersistedState } from "@/lib/usePersistedState";
import { createQuoteSchedule } from "@/lib/quoteSchedule";
import { fmtPct, fmtPrice } from "@/lib/format";
import { fmtUsd } from "@/lib/currency";
import { marketMeta, MARKET_LIST, type GroupConfig, type Quote, type SearchMatch, type StockRecord } from "@/lib/types";
import type { Intraday } from "@/lib/quotes";
import StockSearch from "@/components/StockSearch";
import MarketIcon from "@/components/MarketIcon";
import StockDetailView from "@/components/StockDetailView";
import WatchGroupSheet from "@/components/WatchGroupSheet";
import { showToast } from "@/lib/toast";
import { useAssetIcons } from "@/lib/useAssetIcons";
import { groupCount, groupVisible, migrateLegacyWatchGroups, type WatchGroup } from "@/lib/watchGroups";
import ImportSnapshotModal from "@/components/ImportSnapshotModal";
import WatchlistFileImportModal from "@/components/WatchlistFileImportModal";
import EtfDoubleBadge from "@/components/EtfDoubleBadge";
import RefreshButton from "@/components/RefreshButton";
import AppSelect from "@/components/AppSelect";
import MarketCodeBadge from "@/components/MarketCodeBadge";
import QuoteSourceBadge, { QuoteRowHint } from "@/components/QuoteSourceBadge";
import MiniTrendChart from "@/components/MiniTrendChart";

const WATCH_GROUP_CACHE_KEY = "fire:watch-groups";

interface Props {
  /** 个股详情直达代码（如 US.GOOGL），来自 /watchlist/US.GOOGL 路径 */
  initialSymbol?: string;
  records: StockRecord[];
  initialWatchGroups?: WatchGroup[];
  quotes: Record<string, Quote>;
  quoteAt: string;
  refreshing: boolean;
  refreshQuotes: (options?: { force?: boolean; missingOnly?: boolean }) => void;
  onAddMatch: (match: SearchMatch) => Promise<boolean>;
  groups: GroupConfig[];
  /** 详情视图开合回调（供外层在个股详情打开时隐藏顶部指数卡片等） */
  onDetailChange?: (open: boolean) => void;
  /** 关注 / 取消关注自选股回调（详情页爱心使用） */
  onToggleWatch: (r: StockRecord, follow: boolean) => Promise<boolean>;
}

const INTERVALS = [
  { label: "1秒", ms: 1000 },
  { label: "5秒", ms: 5000 },
  { label: "1分钟", ms: 60000 },
  { label: "5分钟", ms: 300000 },
  { label: "10分钟", ms: 600000 },
  { label: "30分钟", ms: 1800000 },
  { label: "1小时", ms: 3600000 },
  { label: "1日", ms: 86400000 }
];

const CHART_CACHE_KEY = "fire:watchlist:charts";

function compactFilterToken(groups: WatchGroup[], id: string): string {
  if (!id) return "";
  const group = groups.find((item) => item.id === id);
  if (!group) return "";
  if (group.kind === "market") return group.market.toLowerCase();
  const index = groups.filter((item) => item.kind === "custom").findIndex((item) => item.id === id);
  return index >= 0 ? String(index + 1) : "";
}

function filterIdFromToken(groups: WatchGroup[], raw: string): string {
  if (!raw) return "";
  const market = groups.find((item) => item.kind === "market" && item.market.toLowerCase() === raw.toLowerCase());
  if (market) return market.id;
  if (/^[1-9]\d*$/.test(raw)) return groups.filter((item) => item.kind === "custom")[Number(raw) - 1]?.id ?? "";
  return "";
}

export default function QuotesView({ initialSymbol, records, initialWatchGroups = [], quotes, quoteAt, refreshing, refreshQuotes, onAddMatch, groups, onDetailChange, onToggleWatch }: Props) {
  const searchParams = useSearchParams();
  const filterToken = searchParams.get("filter") ?? "";
  const { brokerIcons, stockIcons, assetIcons } = useAssetIcons(["broker", "stock", "crypto", "metal"]);
  const [added, setAdded] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [importGroupId, setImportGroupId] = useState("");
  const [fileImportOpen, setFileImportOpen] = useState(false);
  const [charts, setCharts] = useState<Record<string, Intraday>>({});
  const [savedInterval, setIntervalMs] = usePersistedState("fire:watch-refresh-ms", 60000);
  const intervalMs = INTERVALS.some(i => i.ms === savedInterval) ? savedInterval : 60000;
  const scheduleRef = useRef<ReturnType<typeof createQuoteSchedule> | null>(null);
  const [lastRefreshAt, setLastRefreshAt] = useState("");
  const [showMoreGroups, setShowMoreGroups] = useState(false);
  const moreGroupsRef = useRef<HTMLDivElement>(null);
  const groupScrollRef = useRef<HTMLDivElement>(null);
  const groupChipRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  useEffect(() => {
    if (quoteAt) return;
    try {
      setLastRefreshAt(localStorage.getItem("fire:last-quotes-refresh") ?? "");
    } catch {
      /* 忽略存储不可用 */
    }
  }, [quoteAt]);
  // 我的行情板：分组筛选（全部 / 市场分组 / 自定义分组，服务端实体，URL 同步）+ 每页 6 条分页
  const [watchGroups, setWatchGroups] = useState<WatchGroup[]>(initialWatchGroups);
  // useSearchParams 在 SSR 与水合阶段提供同一个地址快照，既保留首帧筛选，又避免直接读 window
  // 造成 ?filter=us 刷新时 className 不一致和先闪出「全部」。
  const [filterId, setFilterId] = useState(() => filterIdFromToken(initialWatchGroups, filterToken));
  const lastUrlFilterRef = useRef(filterToken);
  const [groupSheetOpen, setGroupSheetOpen] = useState(false);
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 6;

  useEffect(() => {
    if (!showMoreGroups) return;
    const close = (event: MouseEvent) => {
      if (moreGroupsRef.current && !moreGroupsRef.current.contains(event.target as Node)) setShowMoreGroups(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [showMoreGroups]);

  // 个股行内移动只允许选择自定义分组；市场分组是按市场动态筛选，不保存到记录归属。
  const customWatchGroups = useMemo(
    () => watchGroups.filter((g) => g.kind === "custom"),
    [watchGroups]
  );

  // 服务端分组：加载 + 旧 localStorage 配置一次性迁移
  useLayoutEffect(() => {
    let cancelled = false;
    // 不限制快照年龄：分组是低频配置，旧快照也优先于刷新首帧只显示“全部”。
    try {
      const cached = JSON.parse(localStorage.getItem(WATCH_GROUP_CACHE_KEY) || "null") as { groups?: WatchGroup[]; at?: number } | null;
      if (Array.isArray(cached?.groups) && cached.groups.length > 0) {
        setWatchGroups(cached.groups);
      }
    } catch {
      /* 缓存损坏忽略 */
    }
    async function load() {
      try {
        const res = await fetch("/api/v1/watch-groups");
        if (!res.ok) return;
        const data = await res.json().catch(() => null);
        const list: WatchGroup[] = data?.data?.groups ?? [];
        if (cancelled) return;
        setWatchGroups(list);
        try {
          if (list.length > 0) localStorage.setItem(WATCH_GROUP_CACHE_KEY, JSON.stringify({ groups: list, at: Date.now() }));
        } catch {
          /* 存储不可用忽略 */
        }
        const migrated = await migrateLegacyWatchGroups(list, {
          create: async (name) => {
            const r = await fetch("/api/v1/watch-groups", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name })
            });
            const d = await r.json().catch(() => null);
            return r.ok ? (d?.data?.group ?? null) : null;
          },
          update: async (id, input) => {
            const r = await fetch(`/api/v1/watch-groups/${id}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(input)
            });
            return r.ok;
          },
          reorder: async (order) => {
            const r = await fetch("/api/v1/watch-groups/reorder", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ order })
            });
            return r.ok;
          }
        });
        if (migrated) {
          const res2 = await fetch("/api/v1/watch-groups");
          const d2 = await res2.json().catch(() => null);
          const migratedGroups: WatchGroup[] = d2?.data?.groups ?? [];
          if (!cancelled && migratedGroups.length > 0) {
            setWatchGroups(migratedGroups);
            try {
              localStorage.setItem(WATCH_GROUP_CACHE_KEY, JSON.stringify({ groups: migratedGroups, at: Date.now() }));
            } catch { /* 存储不可用时保留当前状态 */ }
          }
        }
      } catch {
        /* 加载失败时保留已恢复的分组快照 */
  }
}
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const reload = async () => {
      try {
        const response = await fetch("/api/v1/watch-groups", { cache: "no-store" });
        const data = await response.json().catch(() => null);
        const list: WatchGroup[] = data?.data?.groups ?? [];
        if (!cancelled && response.ok && list.length > 0) {
          setWatchGroups(list);
          localStorage.setItem(WATCH_GROUP_CACHE_KEY, JSON.stringify({ groups: list, at: Date.now() }));
        }
      } catch { /* 保留当前分组 */ }
    };
    window.addEventListener("fire:watch-groups-updated", reload);
    return () => { cancelled = true; window.removeEventListener("fire:watch-groups-updated", reload); };
  }, []);

  function writeFilterToUrl(id: string, mode: "push" | "replace" = "push") {
    const sp = new URLSearchParams(window.location.search);
    const token = compactFilterToken(watchGroups, id);
    if (token) sp.set("filter", token);
    else sp.delete("filter");
    const query = sp.toString();
    window.history[mode === "push" ? "pushState" : "replaceState"](
      null,
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}`
    );
  }

  // 市场使用 us/cn/hk 等市场码，自定义分组按当前顺序使用 1/2/3；其他格式直接清理。
  useLayoutEffect(() => {
    if (watchGroups.length === 0) return;
    const raw = filterToken;
    if (!raw) {
      if (filterId) setFilterId("");
      lastUrlFilterRef.current = "";
      return;
    }
    // 地址栏主动变化（助手同页切换、前进/后退）时以 URL 为准；仅分组重排时保留实体 id，
    // 再把数字序号替换成重排后的新序号。
    const urlChanged = raw !== lastUrlFilterRef.current;
    const resolved = urlChanged
      ? filterIdFromToken(watchGroups, raw)
      : watchGroups.some((item) => item.id === filterId) ? filterId : filterIdFromToken(watchGroups, raw);
    const canonical = compactFilterToken(watchGroups, resolved);
    if (resolved !== filterId) setFilterId(resolved);
    if (canonical !== raw) {
      lastUrlFilterRef.current = canonical;
      writeFilterToUrl(resolved, "replace");
    } else {
      lastUrlFilterRef.current = raw;
    }
    // writeFilterToUrl 只依赖浏览器当前地址。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchGroups, filterId, filterToken]);

  // 分组 chips：全部 + 可见分组
  const groupChips = useMemo(() => {
    const orderedGroups = watchGroups.map((g) => ({ id: g.id, label: g.name, count: groupCount(g, records), g }));
    const visibleGroups = orderedGroups.filter((c) => {
      const group = watchGroups.find((g) => g.id === c.id);
      return group ? groupVisible(group, c.count) : true;
    });
    const all = [{ id: "", label: "全部", count: records.length }, ...visibleGroups];
    const defaultVisible = all.slice(0, 5);
    const selected = all.find((chip) => chip.id === filterId);
    const visible = selected && !defaultVisible.some((chip) => chip.id === selected.id)
      ? [...defaultVisible.slice(0, 4), selected]
      : defaultVisible;
    return {
      all,
      visible,
      moreCount: Math.max(0, all.length - visible.length)
    };
  }, [filterId, records, watchGroups]);

  function selectGroupChip(id: string, fromMenu = false) {
    setFilterId(id);
    writeFilterToUrl(id);
    setPage(1);
    if (fromMenu) setShowMoreGroups(false);
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      const container = groupScrollRef.current;
      const selected = groupChipRefs.current[id || "__all"];
      if (!container || !selected) return;
      const chips = Array.from(container.children).filter((node): node is HTMLElement => node instanceof HTMLElement);
      const selectedIndex = chips.indexOf(selected);
      if (selectedIndex < 0) return;
      let firstVisible = selectedIndex;
      while (firstVisible > 0 && selected.offsetLeft + selected.offsetWidth - chips[firstVisible - 1].offsetLeft <= container.clientWidth) {
        firstVisible -= 1;
      }
      const containerLeft = container.getBoundingClientRect().left;
      const chipLeft = chips[firstVisible].getBoundingClientRect().left;
      container.scrollTo({ left: Math.max(0, container.scrollLeft + chipLeft - containerLeft), behavior: "smooth" });
    }));
  }

  // 自定义分组默认图标：无自传图标、且非券商分组时，取组内市值最高的股票图标
  const groupStockIcon = useMemo(() => {
    const map: Record<string, string> = {};
    for (const g of watchGroups) {
      if (g.kind !== "custom" || g.icon || brokerIcons[g.name]) continue;
      let best: { url: string; cap: number } | null = null;
      for (const r of records) {
        if (r.watchGroupId !== g.id) continue;
        const url = r.market.toUpperCase() === "ASSET" ? assetIcons[r.code.toUpperCase()] : stockIcons[`${r.market.toUpperCase()}:${r.code.toUpperCase()}`];
        if (!url) continue;
        const cap = quotes[r.id]?.marketCap ?? 0;
        if (!best || cap > best.cap) best = { url, cap };
      }
      if (best) map[g.id] = best.url;
    }
    return map;
  }, [watchGroups, records, quotes, stockIcons, brokerIcons, assetIcons]);

  const filtered = useMemo(
    () => {
      const active = watchGroups.find((g) => g.id === filterId);
      if (!active) return records;
      if (active.kind === "market") return records.filter((r) => r.market.toUpperCase() === active.market);
      return records.filter((r) => r.watchGroupId === active.id);
    },
    [records, watchGroups, filterId]
  );
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = useMemo(
    () => filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [filtered, safePage]
  );
  const [detail, setDetail] = useState<StockRecord | null>(() => {
    if (!initialSymbol) return null;
    const [market, code] = initialSymbol.split(".");
    if (!market || !code) return null;
    return records.find((item) => item.market.toUpperCase() === market && item.code.toUpperCase() === code) ?? {
      id: `symbol:${market}:${code}`,
      name: code,
      code,
      market,
      price: "",
      cost: "",
      qty: "",
      group: "",
      watchGroupId: "",
      note: "",
      source: "market",
      updatedAt: ""
    };
  });
  const notifyDetail = (next: StockRecord | null) => onDetailChange?.(!!next);
  const updateDetail = (next: StockRecord | null) => {
    setDetail(next);
    notifyDetail(next);
  };

  // 后端详情：个股代码用路径 /watchlist/US.GOOGL；当前分组继续保留在 ?filter=，
  // 返回列表、刷新与前进后退时均恢复原筛选；?tab= 保留详情页签记忆。
  const DETAIL_SEGMENT = /^([A-Za-z]{2,5})\.([A-Z0-9._-]+)$/;

  function codeFromPath(): { m: string; c: string } | null {
    const segs = window.location.pathname.split("/").filter(Boolean);
    const last = segs[segs.length - 1] ?? "";
    const match = DETAIL_SEGMENT.exec(last);
    return match ? { m: match[1].toUpperCase(), c: match[2].toUpperCase() } : null;
  }

  function openDetailFrom(m: string, c: string) {
    const r = records.find((x) => x.market.toUpperCase() === m && x.code.toUpperCase() === c);
    updateDetail(r ?? {
      id: `symbol:${m}:${c}`,
      name: c,
      code: c,
      market: m,
      price: "",
      cost: "",
      qty: "",
      group: "",
      watchGroupId: "",
      note: "",
      source: "market",
      updatedAt: ""
    });
  }

  useEffect(() => {
    function syncFromPath() {
      const rawFilter = new URLSearchParams(window.location.search).get("filter") ?? "";
      const nextFilterId = filterIdFromToken(watchGroups, rawFilter);
      setFilterId(nextFilterId);
      setPage(1);
      const hit = codeFromPath();
      if (hit) {
        openDetailFrom(hit.m, hit.c);
      } else {
        // 兼容旧链接 /watchlist?symbol=US.AAPL：打开详情并顺带清理成路径式 URL
        const sym = new URLSearchParams(window.location.search).get("symbol");
        const match = sym ? /^([A-Z]{2,5})[:.-](.+)$/i.exec(sym) : null;
        if (match) {
          const m = match[1].toUpperCase();
          const c = match[2].toUpperCase();
          const sp = new URLSearchParams(window.location.search);
          sp.delete("symbol");
          const qs = sp.toString();
          const base = window.location.pathname.replace(/\/+$/, "");
          window.history.replaceState(null, "", `${base}/${m}.${c}${qs ? `?${qs}` : ""}`);
          openDetailFrom(m, c);
        } else {
          updateDetail(null);
        }
      }
    }
    syncFromPath();
    window.addEventListener("popstate", syncFromPath);
    return () => window.removeEventListener("popstate", syncFromPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [records]);

  // SSR / 直达路径进入：布局层已解析出 initialSymbol（/watchlist/US.GOOGL）
  useEffect(() => {
    if (initialSymbol && !codeFromPath()) {
      const [m, c] = initialSymbol.split(".");
      if (m && c) openDetailFrom(m.toUpperCase(), c.toUpperCase());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSymbol]);

  function openDetail(r: StockRecord) {
    updateDetail(r);
    const sp = new URLSearchParams(window.location.search);
    const qs = sp.toString();
    const base = window.location.pathname.replace(/\/+$/, "");
    window.history.pushState(null, "", `${base}/${r.market.toUpperCase()}.${r.code.toUpperCase()}${qs ? `?${qs}` : ""}`);
  }

  function backToList() {
    const segs = window.location.pathname.split("/").filter(Boolean);
    segs.pop(); // 移除股票代码段
    const base = "/" + segs.join("/");
    const sp = new URLSearchParams(window.location.search);
    sp.delete("tab");
    const qs = sp.toString();
    window.history.replaceState(null, "", base + (qs ? `?${qs}` : ""));
    updateDetail(null);
  }
  const refreshAllRef = useRef<(force?: boolean) => void>(() => {});
  const chartFetchingRef = useRef(false);

  useEffect(() => {
    try {
      const cached = JSON.parse(localStorage.getItem(CHART_CACHE_KEY) || "{}") as Record<string, Intraday>;
      setCharts(Object.fromEntries(Object.entries(cached).map(([id, chart]) => [id, { ...chart, stale: true }])));
    } catch {
      /* 缓存损坏时等待重新获取 */
    }
  }, []);

  const fetchCharts = useCallback(async () => {
    if (chartFetchingRef.current || pageRows.length === 0) return;
    chartFetchingRef.current = true;
    try {
      const res = await fetch("/api/charts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: pageRows.map((r) => ({ id: r.id, market: r.market, code: r.code })),
          sample: true
        })
      });
      if (!res.ok) {
        setCharts((prev) => Object.fromEntries(Object.entries(prev).map(([id, chart]) => [id, pageRows.some((row) => row.id === id) ? { ...chart, stale: true } : chart])));
        return;
      }
      const data = await res.json();
      if (data.charts) setCharts((prev) => {
        const next = { ...prev };
        pageRows.forEach((row) => {
          const fresh = data.charts[row.id] as Intraday | undefined;
          if (fresh?.points?.length) next[row.id] = fresh;
          else if (next[row.id]) next[row.id] = { ...next[row.id], stale: true };
        });
        try { localStorage.setItem(CHART_CACHE_KEY, JSON.stringify(next)); } catch { /* 存储不可用 */ }
        return next;
      });
    } catch {
      setCharts((prev) => Object.fromEntries(Object.entries(prev).map(([id, chart]) => [id, pageRows.some((row) => row.id === id) ? { ...chart, stale: true } : chart])));
    } finally {
      chartFetchingRef.current = false;
    }
  }, [pageRows]);

  const refreshAll = useCallback((force = false) => {
    if (document.hidden) return;
    refreshQuotes({ force });
    fetchCharts();
  }, [refreshQuotes, fetchCharts]);
  refreshAllRef.current = refreshAll;

  useEffect(() => {
    const schedule = createQuoteSchedule({ interval: intervalMs, hidden: () => document.hidden, refresh: force => refreshAllRef.current(force) });
    scheduleRef.current = schedule;
    const onVisible = () => schedule.foreground();
    document.addEventListener("visibilitychange", onVisible);
    return () => { schedule.stop(); scheduleRef.current = null; document.removeEventListener("visibilitychange", onVisible); };
  }, [intervalMs]);

  // 挂载 / pageRows 变化时立即拉当日走势（不依赖定时器，保证一进页面就有图）
  useEffect(() => {
    fetchCharts();
  }, [fetchCharts]);

  async function handleSelect(m: SearchMatch) {
    const ok = await onAddMatch(m);
    if (ok) {
      setAdded(`${m.code} 已加入自选股`);
      setTimeout(() => setAdded(""), 2500);
    }
  }

  // 分组 API 封装（服务端实体）
  async function createGroup(name: string): Promise<boolean> {
    try {
      const res = await fetch("/api/v1/watch-groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message || "创建失败");
      setWatchGroups((prev) => [...prev, data.data.group]);
      showToast(`已新建分组「${name}」`);
      return true;
    } catch (err) {
      showToast(err instanceof Error ? err.message : "创建分组失败", "err");
      return false;
    }
  }

  async function updateGroup(id: string, input: { name?: string; icon?: string; visible?: number }): Promise<boolean> {
    try {
      const res = await fetch(`/api/v1/watch-groups/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input)
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message || "更新失败");
      setWatchGroups((prev) => prev.map((g) => (g.id === id ? data.data.group : g)));
      if (input.name) showToast(`分组已重命名为「${input.name}」`);
      return true;
    } catch (err) {
      showToast(err instanceof Error ? err.message : "更新分组失败", "err");
      return false;
    }
  }

  async function deleteGroup(id: string): Promise<boolean> {
    try {
      const res = await fetch(`/api/v1/watch-groups/${id}`, { method: "DELETE" });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message || "删除失败");
      setWatchGroups((prev) => prev.filter((g) => g.id !== id));
      if (filterId === id) {
        setFilterId("");
        writeFilterToUrl("", "replace");
      }
      showToast("分组已删除");
      return true;
    } catch (err) {
      showToast(err instanceof Error ? err.message : "删除分组失败", "err");
      return false;
    }
  }

  async function reorderGroups(order: string[]): Promise<boolean> {
    try {
      const res = await fetch("/api/v1/watch-groups/reorder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order })
      });
      if (!res.ok) return false;
      const byId = new Map(watchGroups.map((g) => [g.id, g]));
      setWatchGroups(order.map((id, i) => (byId.get(id) ? { ...byId.get(id)!, sort: i } : byId.get(id)!)).filter(Boolean));
      return true;
    } catch {
      return false;
    }
  }

  async function uploadGroupIcon(id: string, file: File): Promise<boolean> {
    try {
      const fd = new FormData();
      fd.append("file", file);
      const up = await fetch(`/api/v1/watch-groups/${encodeURIComponent(id)}/icon`, { method: "POST", body: fd });
      const upData = await up.json().catch(() => null);
      if (!up.ok) throw new Error(upData?.message || "上传失败");
      const group = upData?.data?.group;
      if (!group) throw new Error("分组图标保存失败");
      setWatchGroups(current => current.map(item => item.id === id ? group : item));
      window.dispatchEvent(new Event("fire:assets-updated"));
      return true;
    } catch (err) {
      showToast(err instanceof Error ? err.message : "上传图标失败", "err");
      return false;
    }
  }

  async function assignGroup(ids: string[], groupId: string): Promise<boolean> {
    if (ids.length === 0) return false;
    try {
      const res = await fetch("/api/v1/records/group-assign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, groupId })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message || "分配失败");
      const g = watchGroups.find((x) => x.id === groupId);
      showToast(g ? `已移入「${g.name}」` : "已移出分组");
      // 通知 RecordsApp 重新拉取记录（行内操作 / 分组计数立即更新）
      window.dispatchEvent(new Event("fire:records-updated"));
      return true;
    } catch (err) {
      showToast(err instanceof Error ? err.message : "分配分组失败", "err");
      return false;
    }
  }

  async function deleteWatchRecords(ids: string[]): Promise<boolean> {
    if (ids.length === 0) return false;
    try {
      const res = await fetch("/api/records/batch-delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }) });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "删除失败");
      window.dispatchEvent(new Event("fire:records-updated"));
      showToast("已删除自选股");
      return true;
    } catch (error) {
      showToast(error instanceof Error ? error.message : "删除失败", "err");
      return false;
    }
  }

  async function reorderGroupRecords(groupId: string, ids: string[]): Promise<boolean> {
    try {
      const res = await fetch("/api/v1/records/group-reorder", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ groupId, ids }) });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message || "排序失败");
      window.dispatchEvent(new Event("fire:records-updated"));
      return true;
    } catch (error) {
      showToast(error instanceof Error ? error.message : "排序失败", "err");
      return false;
    }
  }

  async function addRecordToGroup(groupId: string, match: SearchMatch): Promise<boolean> {
    try {
      const res = await fetch("/api/records/import-apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: [{ code: match.code, name: match.name, market: match.market, price: match.price ?? "" }], groupId })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "添加失败");
      const group = watchGroups.find((item) => item.id === groupId);
      showToast(`已添加 ${match.name}${group ? ` 至「${group.name}」` : ""}`, "ok");
      window.dispatchEvent(new Event("fire:records-updated"));
      return true;
    } catch (err) {
      showToast(err instanceof Error ? err.message : "添加失败", "err");
      return false;
    }
  }

  // 后端个股详情：无感进入视图（不弹窗、不刷新，URL /watchlist/US.GOOGL 路径同步）
  if (detail) {
    const q = quotes[detail.id];
    const followed = records.some(
      (record) => record.market.toUpperCase() === detail.market.toUpperCase() && record.code.toUpperCase() === detail.code.toUpperCase()
    );
    return (
      <div style={{ animation: "fade-in .25s ease" }}>
        <StockDetailView
          market={detail.market}
          code={detail.code}
          name={detail.name}
          quote={q}
          onBack={backToList}
          followed={followed}
          onToggleFollow={(follow, resolvedName) => onToggleWatch({ ...detail, name: resolvedName || detail.name }, follow)}
          onTabChange={(next) => {
            const sp = new URLSearchParams(window.location.search);
            sp.set("tab", next);
            window.history.replaceState(null, "", `?${sp.toString()}`);
          }}
        />
      </div>
    );
  }

  return (
    <div>
      {/* 搜索添加 */}
      <div className="card mb-6 p-6">
        <h2 className="mb-1.5 text-lg font-bold">股票添加</h2>
        <p className="mb-4 text-sm text-muted">输入名称或代码，实时价格自动带出，一键加入自选。</p>
        <div className="mx-auto max-w-[560px]">
          <StockSearch
            large
            rainbow
            onSelect={handleSelect}
            onCameraClick={() => setImportOpen(true)}
            cameraTitle="截图导入自选股"
            placeholder="如：腾讯 / 00700 / AAPL / 茅台"
            followed={(m) =>
              records.some(
                (r) => r.market.toUpperCase() === m.market.toUpperCase() && r.code.toUpperCase() === m.code.toUpperCase()
              )
            }
            onToggleFollow={async (m) => {
              const existing = records.find(
                (r) => r.market.toUpperCase() === m.market.toUpperCase() && r.code.toUpperCase() === m.code.toUpperCase()
              );
              return existing ? onToggleWatch(existing, false) : onAddMatch(m);
            }}
          />
          {added && <p className="mt-3 text-center text-sm font-semibold text-brand-deep">{added} ✓</p>}
        </div>
      </div>

      {/* 行情板控制面板：标题、刷新和分组筛选保持在同一层级 */}
      <section className="quotes-control-panel relative z-20 mb-5 overflow-visible">
      <div className="quotes-control-header flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
        <div className="quotes-control-title flex items-center gap-2">
          <h3 className="text-base font-bold">我的行情板</h3>
          <QuoteSourceBadge records={filtered} quotes={quotes} />
        </div>
        <div className="quotes-control-actions flex flex-wrap items-center gap-2">
          <span
            className="inline-flex h-8 items-center gap-1.5 rounded-full border border-edge bg-bg-gray/50 px-3 text-[11px] text-muted"
            aria-live="polite"
            title={quoteAt ? `最后一次行情刷新：${quoteAt}` : lastRefreshAt ? `上次行情刷新：${lastRefreshAt}` : "尚未刷新行情"}
          >
            <i className={`h-1.5 w-1.5 rounded-full ${refreshing ? "animate-pulse bg-[#3297f6]" : quoteAt ? "bg-down" : "bg-faint"}`} />
            {refreshing ? "刷新中…" : quoteAt ? `更新于 ${quoteAt}` : lastRefreshAt ? `上次刷新 ${lastRefreshAt}` : "等待行情"}
          </span>
          <RefreshButton onClick={() => scheduleRef.current?.manual()} title="立即刷新行情" className="h-8 w-8 rounded-[9px]" />
          <AppSelect value={intervalMs} onChange={(value) => setIntervalMs(Number(value))} options={INTERVALS.map((item) => ({ value: String(item.ms), label: `每 ${item.label}` }))} className="h-8 rounded-[9px] border border-edge bg-bg-gray px-2.5 text-[11px] font-semibold text-muted transition-colors hover:border-edge-strong" ariaLabel="刷新间隔" />
        </div>
      </div>

      {/* 分组筛选（全部 + 市场分组 + 自定义分组，末尾加号打开分组管理） */}
      <div className="quotes-control-groups flex min-w-0 items-center gap-2.5 !overflow-visible px-4 py-4">
        <div ref={groupScrollRef} className="flex min-w-0 w-fit max-w-[calc(100%-46px)] flex-none items-center gap-2.5 overflow-x-auto scroll-smooth [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {groupChips.visible.map((chip) => {
          const selected = filterId === chip.id;
          const g = watchGroups.find((x) => x.id === chip.id);
          const customIcon = g && g.kind === "custom" ? g.icon || brokerIcons[g.name] || groupStockIcon[g.id] : undefined;
          return (
            <button
              key={chip.id}
              ref={(node) => { groupChipRefs.current[chip.id || "__all"] = node; }}
              type="button"
              onClick={() => selectGroupChip(chip.id)}
              className={`flex min-h-9 w-auto flex-none items-center justify-center gap-1.5 rounded-full px-3 py-2 text-xs font-semibold whitespace-nowrap transition-[transform,box-shadow] duration-200 ${
                selected
                  ? "border border-edge-strong bg-white text-ink-2 shadow-sm dark:bg-[#2a3342] dark:text-white"
                  : "border border-edge-strong bg-white text-muted hover:bg-brand-hover hover:text-ink active:bg-bg-gray dark:bg-[#1b2230]"
              }`}
            >
              {!g ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden="true">
                  <rect x="4" y="4" width="6" height="6" rx="1.5" />
                  <rect x="14" y="4" width="6" height="6" rx="1.5" />
                  <rect x="4" y="14" width="6" height="6" rx="1.5" />
                  <rect x="14" y="14" width="6" height="6" rx="1.5" />
                </svg>
              ) : g.kind === "market" ? (
                <MarketIcon market={g.market} size={15} />
              ) : customIcon ? (
                <img src={customIcon} alt="" className="h-[15px] w-[15px] flex-none rounded-full object-cover" />
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
                  <path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0l-7.2-7.2A2 2 0 0 1 2.8 12V4a1 1 0 0 1 1-1h8a2 2 0 0 1 1.4.6l7.4 7.4a2 2 0 0 1 0 2.8z" />
                  <circle cx="7.5" cy="7.5" r="1" fill="currentColor" />
                </svg>
              )}
              {chip.label}
              <span className={`text-[11px] tabular-nums ${selected ? "opacity-80" : "text-faint"}`}>{chip.count}</span>
            </button>
          );
        })}
        </div>
        {groupChips.moreCount > 0 && (
          <div ref={moreGroupsRef} className="relative flex-none">
            <button
              type="button"
              onClick={() => setShowMoreGroups((v) => !v)}
              aria-expanded={showMoreGroups}
              aria-label="更多分组"
              title="更多分组"
              className={`grid h-9 w-9 place-items-center rounded-full border border-edge-strong bg-white transition-[transform,background-color,box-shadow,color] duration-200 dark:bg-[#1b2230] ${showMoreGroups ? "text-[#3297f6] shadow-sm dark:bg-[#2a3342]" : "text-muted hover:-translate-y-px hover:bg-brand-hover hover:text-ink active:scale-[.96]"}`}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" className="h-[18px] w-[18px]"><path d="M5 7h14M5 12h14M5 17h14" /></svg>
            </button>
            {showMoreGroups && (
              <div className="absolute right-0 top-full z-40 mt-2 min-w-[250px] rounded-[14px] border border-edge bg-white p-2 shadow-pop dark:bg-[#1b2230]">
                <div className="max-h-[420px] overflow-y-auto">
                  {groupChips.all.map((chip) => {
                    const g = watchGroups.find((item) => item.id === chip.id);
                    const customIcon = g?.kind === "custom" ? g.icon || brokerIcons[g.name] || groupStockIcon[g.id] : undefined;
                    return (
                      <button key={chip.id} type="button" onClick={() => selectGroupChip(chip.id, true)} className={`flex w-full items-center gap-2 rounded-[10px] px-3 py-2.5 text-left text-xs font-semibold transition-colors ${filterId === chip.id ? "bg-bg-gray text-ink" : "text-muted hover:bg-brand-hover hover:text-ink"}`}>
                        {!g ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><rect x="4" y="4" width="6" height="6" rx="1.5"/><rect x="14" y="4" width="6" height="6" rx="1.5"/><rect x="4" y="14" width="6" height="6" rx="1.5"/><rect x="14" y="14" width="6" height="6" rx="1.5"/></svg> : g.kind === "market" ? <MarketIcon market={g.market} size={16} /> : customIcon ? <img src={customIcon} alt="" className="h-4 w-4 rounded-full object-cover" /> : <span className="grid h-4 w-4 place-items-center rounded bg-bg-gray text-[9px]">{chip.label.slice(0, 1)}</span>}
                        <span className="min-w-0 flex-1 truncate">{chip.label}</span>
                        <span className="text-[11px] tabular-nums text-faint">{chip.count}</span>
                        {filterId === chip.id && <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className="h-3.5 w-3.5 text-[#3297f6]"><path d="m5 12 4 4L19 6" /></svg>}
                      </button>
                    );
                  })}
                </div>
                <div className="mt-2 border-t border-edge pt-2">
                  <button type="button" onClick={() => { setShowMoreGroups(false); setGroupSheetOpen(true); }} className="flex w-full items-center gap-2 rounded-[10px] px-3 py-2.5 text-left text-xs font-semibold text-muted transition-colors hover:bg-brand-hover hover:text-ink">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>
                    编辑分组
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      </section>

      {/* 行情板表格 */}
      <div className="card overflow-hidden">
        {filtered.length === 0 ? (
          <div className="py-16 text-center text-sm text-faint">还没有自选股票，先用上方搜索添加吧。</div>
        ) : (
          <div className="data-table-scroll">
            <table className="mobile-quotes-table w-full min-w-[860px] text-sm">
              <thead>
                <tr className="whitespace-nowrap bg-bg-gray text-xs font-semibold text-muted">
                  <th className="quotes-rank-cell px-3 py-[13px] text-center">序号</th>
                  <th className="quotes-identity-cell min-w-[210px] px-4 py-[13px] text-left">股票</th>
                  <th className="min-w-[100px] px-4 py-[13px] text-right">现价</th>
                  <th className="min-w-[88px] px-4 py-[13px] text-right">涨跌幅</th>
                  <th className="min-w-[130px] px-4 py-[13px] text-left">当日走势</th>
                  <th className="px-4 py-[13px] text-right">最高</th>
                  <th className="px-4 py-[13px] text-right">最低</th>
                  <th className="min-w-[110px] px-4 py-[13px] text-right">市值</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((r, i) => {
                  const q = quotes[r.id];
                  return (
                    <tr key={r.id} className="quotes-row group whitespace-nowrap border-t border-edge transition-colors hover:bg-[#fafbfc] dark:hover:bg-[#1a212e]">
                      <td className="quotes-rank-cell px-3 py-3.5 text-center text-xs tabular-nums text-ink">{(safePage - 1) * PAGE_SIZE + i + 1}</td>
                      <td className="quotes-identity-cell cursor-pointer px-4 py-3.5 transition-colors hover:bg-brand-hover/30 dark:hover:bg-[#202735]" onClick={() => openDetail(r)}>
                        <div className="flex items-center gap-2.5">
                          {(r.market.toUpperCase() === "ASSET" ? assetIcons[r.code.toUpperCase()] : stockIcons[`${r.market.toUpperCase()}:${r.code.toUpperCase()}`]) ? (
                            <span className="relative flex-none">
                              <img
                                src={r.market.toUpperCase() === "ASSET" ? assetIcons[r.code.toUpperCase()] : stockIcons[`${r.market.toUpperCase()}:${r.code.toUpperCase()}`]}
                                alt=""
                                className="h-9 w-9 flex-none rounded-full object-cover"
                              />
                              <EtfDoubleBadge market={r.market} code={r.code} name={r.name} />
                            </span>
                          ) : (
                            <span className="relative flex-none">
                              <span className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-bg-gray text-xs font-bold text-muted">
                                {(r.name || "?").slice(0, 1)}
                              </span>
                              <EtfDoubleBadge market={r.market} code={r.code} name={r.name} />
                            </span>
                          )}
                          <span className="min-w-0">
                            <span className="block truncate font-semibold text-ink">{r.name}</span>
                            <span className="mt-0.5 flex min-w-0 items-center gap-1.5"><MarketCodeBadge market={r.market} code={r.code} /><span className="truncate text-[11px] text-faint">{r.code}</span><QuoteRowHint market={r.market} quote={q} quotes={quotes} /></span>
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3.5 text-right font-semibold tabular-nums">
                        {fmtPrice(q ? q.price : r.price, marketMeta(r.market).currency, r.market)}
                      </td>
                      <td className={`px-4 py-3.5 text-right font-semibold tabular-nums ${q && q.changePct >= 0 ? "text-up" : q ? "text-down" : "text-faint"}`}>
                        {q ? `${q.changePct >= 0 ? "+" : ""}${fmtPct(q.changePct / 100)}` : "—"}
                      </td>
                      <td className="px-4 py-3.5"><MiniTrendChart points={charts[r.id]?.points.map((point) => point.price)} baseline={q?.prevClose} stale={!charts[r.id] || Boolean(charts[r.id]?.stale)} label={`${r.code} ${charts[r.id]?.date || ""} 当日走势`} /></td>
                      <td className="px-4 py-3.5 text-right tabular-nums">{q ? fmtPrice(q.high, marketMeta(r.market).currency, r.market) : "—"}</td>
                      <td className="px-4 py-3.5 text-right tabular-nums">{q ? fmtPrice(q.low, marketMeta(r.market).currency, r.market) : "—"}</td>
                      <td className="px-4 py-3.5 text-right tabular-nums">{(() => { const cap = q?.marketCap || (q?.totalShares && q?.price ? q.price * q.totalShares : 0); return cap ? fmtUsd(cap) : "—"; })()}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {/* 分页：每页 6 条 */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between border-t border-edge bg-bg-gray/50 px-4 py-3">
            <span className="text-xs tabular-nums text-muted">
              {groupChips.all.find((c) => c.id === filterId)?.label ?? "全部"} · {(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, filtered.length)} / {filtered.length}
            </span>
            <div className="flex gap-2">
              <button type="button" disabled={safePage <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))} className="inline-flex h-[38px] items-center justify-center gap-1.5 rounded-full border border-edge-strong bg-white px-5 text-sm font-semibold text-brand-deep whitespace-nowrap transition-all duration-200 hover:bg-brand-hover hover:text-ink active:bg-bg-gray disabled:cursor-not-allowed disabled:opacity-40">上一页</button>
              <button type="button" disabled={safePage >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))} className="inline-flex h-[38px] items-center justify-center gap-1.5 rounded-full border border-edge-strong bg-white px-5 text-sm font-semibold text-brand-deep whitespace-nowrap transition-all duration-200 hover:bg-brand-hover hover:text-ink active:bg-bg-gray disabled:cursor-not-allowed disabled:opacity-40">下一页</button>
            </div>
          </div>
        )}
      </div>

      {groupSheetOpen && (
        <WatchGroupSheet
          initialView="manage"
          groups={watchGroups}
          records={records}
          selectedId={filterId}
          onSelect={(id) => {
            selectGroupChip(id);
            setGroupSheetOpen(false);
          }}
          onClose={() => setGroupSheetOpen(false)}
          onCreate={createGroup}
          onUpdate={updateGroup}
          onDelete={deleteGroup}
          onReorder={reorderGroups}
          onUploadIcon={uploadGroupIcon}
          onAssignRecords={assignGroup}
          onRemoveRecords={(ids) => assignGroup(ids, "")}
          onDeleteRecords={deleteWatchRecords}
          onReorderRecords={reorderGroupRecords}
          onAddRecord={addRecordToGroup}
          onImport={(groupId) => {
            setImportGroupId(groupId);
            setGroupSheetOpen(false);
            setFileImportOpen(true);
          }}
          brokerIcons={brokerIcons}
          resolvedGroupIcons={groupStockIcon}
        />
      )}

      {importOpen && (
        <ImportSnapshotModal
          mode="watchlist"
          watchGroups={customWatchGroups}
          onClose={() => { setImportOpen(false); setImportGroupId(""); }}
          onImported={() => {
            // 触发父层重拉记录 + 刷新行情，导入的自选股立即生效
            window.dispatchEvent(new Event("fire:records-updated"));
            refreshQuotes();
          }}
        />
      )}
      {fileImportOpen && <WatchlistFileImportModal groups={watchGroups} initialGroupId={importGroupId} onClose={() => { setFileImportOpen(false); setImportGroupId(""); }} onBack={() => { setFileImportOpen(false); setGroupSheetOpen(true); }} onImported={() => { window.dispatchEvent(new Event("fire:records-updated")); refreshQuotes(); }} />}
    </div>
  );
}
