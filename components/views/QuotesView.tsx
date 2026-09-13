"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { fmtPct, fmtPrice } from "@/lib/format";
import { fmtUsd } from "@/lib/currency";
import { marketMeta, MARKET_LIST, type GroupConfig, type Quote, type RecordInput, type SearchMatch, type StockRecord } from "@/lib/types";
import type { Intraday } from "@/lib/quotes";
import StockSearch from "@/components/StockSearch";
import MarketIcon from "@/components/MarketIcon";
import AppModal from "@/components/AppModal";
import StockDetailView from "@/components/StockDetailView";
import WatchGroupSheet from "@/components/WatchGroupSheet";
import { showToast } from "@/lib/toast";
import { useAssetIcons } from "@/lib/useAssetIcons";
import { groupCount, groupVisible, migrateLegacyWatchGroups, type WatchGroup } from "@/lib/watchGroups";
import DeleteIcon from "@/components/DeleteIcon";
import ImportSnapshotModal from "@/components/ImportSnapshotModal";
import EtfDoubleBadge from "@/components/EtfDoubleBadge";
import RefreshButton from "@/components/RefreshButton";
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
  refreshQuotes: () => void;
  onAddMatch: (match: SearchMatch) => Promise<boolean>;
  onBatchDelete: (ids: string[]) => Promise<boolean>;
  onUpdate: (id: string, input: RecordInput) => Promise<boolean>;
  onRemove: (r: StockRecord) => void;
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

function QuotesCheckbox({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <label className="quotes-checkbox-wrap">
      <input type="checkbox" checked={checked} onChange={onChange} className="quotes-checkbox" aria-label={label} />
      <svg className="quotes-checkbox-mark" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M3.2 8.3 6.5 11.4 12.8 4.8" />
      </svg>
    </label>
  );
}

export default function QuotesView({ initialSymbol, records, initialWatchGroups = [], quotes, quoteAt, refreshing, refreshQuotes, onAddMatch, onBatchDelete, onUpdate, onRemove, groups, onDetailChange, onToggleWatch }: Props) {
  const { brokerIcons, stockIcons, assetIcons } = useAssetIcons(["broker", "stock", "crypto", "metal"]);
  const [added, setAdded] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [charts, setCharts] = useState<Record<string, Intraday>>({});
  const [intervalMs, setIntervalMs] = useState(60000);
  const [lastRefreshAt, setLastRefreshAt] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showMoreGroups, setShowMoreGroups] = useState(false);
  const moreGroupsRef = useRef<HTMLDivElement>(null);

  // 恢复上次选择的刷新间隔（默认每分钟；挂载后应用，避免 SSR hydration 不匹配）
  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem("fire:watch-refresh-ms"));
      if (Number.isFinite(saved) && saved > 0) setIntervalMs(saved);
    } catch {
      /* 忽略存储不可用 */
    }
  }, []);
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
  const [filterId, setFilterId] = useState(() => {
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("filter") ?? "";
  });
  const [groupSheetOpen, setGroupSheetOpen] = useState(false);
  const [assignBusy, setAssignBusy] = useState(false);
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

  // 兼容旧 URL：?filter=M:US / G:名称 → 解析为分组 id
  useEffect(() => {
    if (!filterId || watchGroups.length === 0) return;
    const sp = new URLSearchParams(window.location.search);
    const raw = sp.get("filter") ?? "";
    if (raw === filterId) return;
    let resolved = "";
    if (raw.startsWith("M:")) {
      resolved = watchGroups.find((g) => g.kind === "market" && g.market === raw.slice(2))?.id ?? "";
    } else if (raw.startsWith("G:")) {
      resolved = watchGroups.find((g) => g.kind === "custom" && g.name === raw.slice(2))?.id ?? "";
    }
    if (resolved) setFilterId(resolved);
  }, [watchGroups, filterId]);

  // 分组 chips：全部 + 可见分组
  const groupChips = useMemo(() => {
    const markets = watchGroups
      .filter((g) => g.kind === "market")
      .map((g) => ({ id: g.id, label: g.name, count: groupCount(g, records) }));
    const customs = watchGroups
      .filter((g) => g.kind === "custom")
      .map((g) => ({ id: g.id, label: g.name, count: groupCount(g, records), g }));
    const defaultVisible = markets.slice(0, 3);
    const additional = [...markets.slice(3), ...customs];
    const visibleAdditional = additional.filter((c) => {
      const group = watchGroups.find((g) => g.id === c.id);
      return group ? groupVisible(group, c.count) : true;
    });
    return {
      all: [{ id: "", label: "全部", count: records.length }, ...markets, ...customs],
      visible: [
        { id: "", label: "全部", count: records.length },
        ...defaultVisible.filter((c) => {
          const group = watchGroups.find((g) => g.id === c.id);
          return group ? groupVisible(group, c.count) : true;
        })
      ],
      additional: visibleAdditional,
      moreCount: visibleAdditional.length
    };
  }, [records, watchGroups]);

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
  const [editRecord, setEditRecord] = useState<StockRecord | null>(null);
  const [deleteRecord, setDeleteRecord] = useState<StockRecord | null>(null);
  const [editMode, setEditMode] = useState(false);
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

  // 后端详情：无感进入视图。个股代码即唯一标识，URL 用路径 /watchlist/US.GOOGL
  // （不再使用 ?symbol= / ?filter=），刷新与前进后退都保持；?tab= 仍保留用于页签记忆。
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
          sp.delete("filter");
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
    sp.delete("filter");
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
    sp.delete("filter");
    const qs = sp.toString();
    window.history.replaceState(null, "", base + (qs ? `?${qs}` : ""));
    updateDetail(null);
  }
  const [editForm, setEditForm] = useState({ name: "", price: "", cost: "", qty: "", watchGroupId: "", note: "" });
  const [editSaving, setEditSaving] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const refreshAllRef = useRef<() => void>(() => {});
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

  const refreshAll = useCallback(() => {
    if (document.hidden) return;
    refreshQuotes();
    fetchCharts();
  }, [refreshQuotes, fetchCharts]);
  refreshAllRef.current = refreshAll;

  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => refreshAllRef.current(), intervalMs);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
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
      if (filterId === id) setFilterId("");
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
      fd.append("kind", "asset");
      fd.append("folder", "group");
      fd.append("name", watchGroups.find((g) => g.id === id)?.name ?? "分组");
      fd.append("file", file);
      const up = await fetch("/api/upload", { method: "POST", body: fd });
      const upData = await up.json().catch(() => null);
      if (!up.ok) throw new Error(upData?.error || "上传失败");
      return updateGroup(id, { icon: upData.url });
    } catch (err) {
      showToast(err instanceof Error ? err.message : "上传图标失败", "err");
      return false;
    }
  }

  async function assignGroup(ids: string[], groupId: string): Promise<boolean> {
    if (ids.length === 0) return false;
    setAssignBusy(true);
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
      setSelected(new Set());
      // 通知 RecordsApp 重新拉取记录（行内操作 / 分组计数立即更新）
      window.dispatchEvent(new Event("fire:records-updated"));
      return true;
    } catch (err) {
      showToast(err instanceof Error ? err.message : "分配分组失败", "err");
      return false;
    } finally {
      setAssignBusy(false);
    }
  }

  function moveSingleRecord(recordId: string, groupId: string) {
    void assignGroup([recordId], groupId === "__none__" ? "" : groupId);
  }

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) => {
      const allSelected = filtered.length > 0 && filtered.every((r) => prev.has(r.id));
      if (allSelected) return new Set();
      return new Set(filtered.map((r) => r.id));
    });
  }

  function toggleEditMode() {
    setEditMode((current) => !current);
    // 每次切换编辑态都从干净的选择状态开始，避免退出后残留批量操作上下文。
    setSelected(new Set());
  }

  async function batchDelete() {
    if (selected.size === 0) return;
    if (!confirm(`确定删除选中的 ${selected.size} 条记录吗？`)) return;
    const ok = await onBatchDelete([...selected]);
    if (ok) setSelected(new Set());
  }

  function openEdit(r: StockRecord) {
    setEditRecord(r);
    setEditForm({
      name: r.name,
      price: String(r.price ?? ""),
      cost: String(r.cost ?? ""),
      qty: String(r.qty ?? ""),
      watchGroupId: r.watchGroupId ?? "",
      note: r.note ?? ""
    });
  }

  async function saveEdit() {
    if (!editRecord) return;
    setEditSaving(true);
    const toNum = (s: string) => (s.trim() === "" ? "" : Number(s.trim()));
    const input: RecordInput = {
      name: editForm.name.trim() || editRecord.name,
      code: editRecord.code,
      market: editRecord.market,
      price: toNum(editForm.price),
      cost: toNum(editForm.cost),
      qty: toNum(editForm.qty),
      // 自选股编辑不再改券商：保留原值（券商归属我的持仓，编辑入口在持仓页）
      group: editRecord.group,
      watchGroupId: editForm.watchGroupId,
      note: editForm.note.trim()
    };
    const ok = await onUpdate(editRecord.id, input);
    setEditSaving(false);
    if (ok) {
      setEditRecord(null);
      showToast("保存成功");
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
          <button
            type="button"
            onClick={toggleEditMode}
            className={`quotes-edit-toggle inline-flex h-8 w-8 flex-none items-center justify-center rounded-[9px] border border-edge bg-bg-gray text-muted transition-all duration-200 hover:-translate-y-px hover:border-edge-strong hover:bg-brand-hover hover:text-ink active:scale-[.97] ${editMode ? "is-active" : ""}`}
            aria-label={editMode ? "取消编辑" : "编辑行情板"}
            title={editMode ? "取消编辑" : "编辑行情板"}
            aria-pressed={editMode}
          >
            {editMode ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="h-4 w-4" aria-hidden="true">
                <path d="m7 7 10 10M17 7 7 17" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
                <path d="M4 6h9M4 12h7M4 18h6" />
                <path d="m14.5 17.5 1-.2 5.1-5.1a1.7 1.7 0 0 0-2.4-2.4l-5.1 5.1-.3 2.8Z" />
              </svg>
            )}
          </button>
          <RefreshButton onClick={refreshQuotes} title="立即刷新行情" className="h-8 w-8 rounded-[9px]" />
          <select
            value={intervalMs}
            onChange={(e) => {
              const ms = Number(e.target.value);
              setIntervalMs(ms);
              try {
                localStorage.setItem("fire:watch-refresh-ms", String(ms));
              } catch {
                /* 忽略存储不可用 */
              }
            }}
            className="h-8 rounded-[9px] border border-edge bg-bg-gray px-2.5 text-[11px] font-semibold text-muted outline-none transition-colors hover:border-edge-strong focus:border-edge-strong"
            aria-label="刷新间隔"
            title="刷新间隔"
          >
            {INTERVALS.map((it) => (
              <option key={it.ms} value={it.ms}>每 {it.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* 分组筛选（全部 + 市场分组 + 自定义分组，末尾加号打开分组管理） */}
      <div className="quotes-control-groups flex min-w-0 items-center gap-2.5 px-4 py-4" style={showMoreGroups ? { overflow: "visible" } : undefined}>
        {groupChips.visible.map((chip) => {
          const selected = filterId === chip.id;
          const g = watchGroups.find((x) => x.id === chip.id);
          const customIcon = g && g.kind === "custom" ? g.icon || brokerIcons[g.name] || groupStockIcon[g.id] : undefined;
          return (
            <button
              key={chip.id}
              type="button"
              onClick={() => {
                setFilterId(chip.id);
                setPage(1);
              }}
              className={`flex min-h-9 flex-none items-center gap-1.5 rounded-full px-4 py-2 text-xs font-semibold transition-all duration-200 ${
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
        {groupChips.moreCount > 0 && (
          <div ref={moreGroupsRef} className="relative flex-none">
            <button
              type="button"
              onClick={() => setShowMoreGroups((v) => !v)}
              aria-expanded={showMoreGroups}
              aria-label="更多分组"
              title="更多分组"
              className={`grid h-9 w-9 place-items-center rounded-full border transition-all duration-200 ${showMoreGroups ? "border-edge-strong bg-white text-[#3297f6] shadow-sm dark:bg-[#2a3342]" : "border-transparent text-muted hover:border-edge hover:bg-brand-hover hover:text-ink"}`}
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
                      <button key={chip.id} type="button" onClick={() => { setFilterId(chip.id); setPage(1); setShowMoreGroups(false); }} className={`flex w-full items-center gap-2 rounded-[10px] px-3 py-2.5 text-left text-xs font-semibold transition-colors ${filterId === chip.id ? "bg-bg-gray text-ink" : "text-muted hover:bg-brand-hover hover:text-ink"}`}>
                        {!g ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><rect x="4" y="4" width="6" height="6" rx="1.5"/><rect x="14" y="4" width="6" height="6" rx="1.5"/><rect x="4" y="14" width="6" height="6" rx="1.5"/><rect x="14" y="14" width="6" height="6" rx="1.5"/></svg> : g.kind === "market" ? <MarketIcon market={g.market} size={16} /> : customIcon ? <img src={customIcon} alt="" className="h-4 w-4 rounded-full object-cover" /> : <span className="grid h-4 w-4 place-items-center rounded bg-bg-gray text-[9px]">{chip.label.slice(0, 1)}</span>}
                        <span className="min-w-0 flex-1 truncate">{chip.label}</span>
                        <span className="text-[11px] tabular-nums text-faint">{chip.count}</span>
                        {filterId === chip.id && <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className="h-3.5 w-3.5 text-[#3297f6]"><path d="m5 12 4 4L19 6" /></svg>}
                      </button>
                    );
                  })}
                </div>
                <div className="mt-2 border-t border-edge pt-2">
                  <button type="button" onClick={() => { setShowMoreGroups(false); setGroupSheetOpen(true); }} className="flex w-full items-center justify-center gap-2 rounded-[10px] bg-[#3297f6] px-3 py-2.5 text-xs font-semibold text-white transition-colors hover:bg-[#2589e8]">
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

      {editMode && selected.size > 0 && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-edge bg-bg-gray/50 px-3 py-2" role="region" aria-label="批量编辑工具栏">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-[#3297f6] px-2 text-[11px] font-bold text-white">{selected.size}</span>
            <span className="text-xs font-semibold text-ink-2">已选择股票</span>
            <button type="button" onClick={() => setSelected(new Set())} className="text-[11px] font-medium text-muted transition-colors hover:text-ink">取消选择</button>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <select
              value=""
              disabled={assignBusy || customWatchGroups.length === 0}
              onChange={(e) => {
                const value = e.target.value;
                if (value) void assignGroup([...selected], value === "__none__" ? "" : value);
              }}
              className="quotes-move-select h-8 cursor-pointer rounded-[9px] border border-edge-strong bg-white px-3 text-[11px] font-semibold text-muted outline-none transition-colors hover:bg-brand-hover focus:border-edge-strong disabled:cursor-not-allowed disabled:opacity-45"
              aria-label="移动到分组"
              title={customWatchGroups.length === 0 ? "请先新建自定义分组" : "选择目标分组"}
            >
              <option value="" disabled>移动到分组</option>
              <optgroup label="移入分组">
                {customWatchGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </optgroup>
              <optgroup label="其他">
                <option value="__none__">移出当前分组</option>
              </optgroup>
            </select>
            <button type="button" onClick={batchDelete} className="btn btn-ghost btn-sm text-down hover:border-down/40 hover:bg-down/10 dark:border-white/20">
              <DeleteIcon size={15} />
              批量删除
            </button>
          </div>
        </div>
      )}

      {/* 行情板表格 */}
      <div className="card overflow-hidden">
        {filtered.length === 0 ? (
          <div className="py-16 text-center text-sm text-faint">还没有自选股票，先用上方搜索添加吧。</div>
        ) : (
          <div className="data-table-scroll">
            <table className={`mobile-quotes-table w-full min-w-[860px] text-sm ${editMode ? "min-w-[1120px]" : ""}`}>
              <thead>
                <tr className="whitespace-nowrap bg-bg-gray text-xs font-semibold text-muted">
                  {editMode && <th className="w-10 px-4 py-[13px]">
                    <QuotesCheckbox checked={filtered.length > 0 && filtered.every((r) => selected.has(r.id))} onChange={toggleAll} label="全选" />
                  </th>}
                  <th className="quotes-rank-cell px-3 py-[13px] text-center">序号</th>
                  <th className="quotes-identity-cell min-w-[210px] px-4 py-[13px] text-left">股票</th>
                  <th className="min-w-[100px] px-4 py-[13px] text-right">现价</th>
                  <th className="min-w-[88px] px-4 py-[13px] text-right">涨跌幅</th>
                  <th className="min-w-[130px] px-4 py-[13px] text-left">当日走势</th>
                  <th className="px-4 py-[13px] text-right">最高</th>
                  <th className="px-4 py-[13px] text-right">最低</th>
                  <th className="min-w-[110px] px-4 py-[13px] text-right">市值</th>
                  {editMode && <th className="quotes-actions-cell px-3 py-[13px] text-right">操作</th>}
                </tr>
              </thead>
              <tbody>
                {pageRows.map((r, i) => {
                  const q = quotes[r.id];
                  return (
                    <tr key={r.id} className={`quotes-row group whitespace-nowrap border-t border-edge transition-colors ${selected.has(r.id) ? "is-selected" : "hover:bg-[#fafbfc] dark:hover:bg-[#1a212e]"}`}>
                      {editMode && <td className="px-4 py-3.5">
                        <QuotesCheckbox checked={selected.has(r.id)} onChange={() => toggleOne(r.id)} label={`选择 ${r.name}`} />
                      </td>}
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
                      {editMode && <td className={`quotes-actions-cell px-3 py-3.5 ${selected.has(r.id) ? "is-selected" : ""}`}>
                        <div className="quotes-row-actions flex justify-end gap-1">
                          <button type="button" title="编辑" onClick={() => openEdit(r)} className="quotes-action-btn inline-flex h-8 w-8 items-center justify-center rounded-[9px] border border-edge bg-bg-gray text-muted transition-colors hover:border-edge-strong hover:bg-brand-hover hover:text-ink">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-[15px] w-[15px]"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /></svg>
                          </button>
                          <select
                            value=""
                            disabled={assignBusy || customWatchGroups.length === 0}
                            onChange={(e) => {
                              const value = e.target.value;
                              if (value) moveSingleRecord(r.id, value);
                            }}
                            title={customWatchGroups.length === 0 ? "请先新建自定义分组" : "移动到分组"}
                            aria-label={`移动 ${r.name} 到分组`}
                            className="quotes-move-select quotes-action-btn h-8 w-[66px] cursor-pointer rounded-[9px] border border-edge bg-bg-gray px-1 text-center text-xs text-muted outline-none transition-colors hover:border-edge-strong hover:bg-brand-hover focus:border-edge-strong disabled:cursor-not-allowed disabled:opacity-45"
                          >
                            <option value="" disabled>移动</option>
                            <optgroup label="移入分组">
                              {customWatchGroups.map((g) => (
                                <option key={g.id} value={g.id}>{g.name}</option>
                              ))}
                            </optgroup>
                            <optgroup label="其他">
                              <option value="__none__">移出当前分组</option>
                            </optgroup>
                          </select>
                          <button type="button" title="删除" onClick={() => setDeleteRecord(r)} className="quotes-action-btn quotes-action-delete inline-flex h-8 w-8 items-center justify-center rounded-[9px] border border-edge bg-bg-gray text-muted transition-colors hover:border-down/40 hover:bg-down/10 hover:text-down">
                            <DeleteIcon size={15} />
                          </button>
                        </div>
                      </td>}
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

      {/* 编辑弹窗 */}
      {editRecord && (
        <AppModal title="编辑股票" desc={`${editRecord.name} · ${editRecord.code} · ${marketMeta(editRecord.market).label}`} onClose={() => setEditRecord(null)} size="md">
            <div className="grid grid-cols-2 gap-3.5">
              <label className="col-span-2 flex flex-col gap-1.5 text-[13px] font-semibold text-ink-2">
                股票名称
                <input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} className="field" />
              </label>
              <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-ink-2">
                现价
                <input type="number" step="0.001" value={editForm.price} onChange={(e) => setEditForm({ ...editForm, price: e.target.value })} className="field" />
              </label>
              <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-ink-2">
                成本价
                <input type="number" step="0.001" value={editForm.cost} onChange={(e) => setEditForm({ ...editForm, cost: e.target.value })} className="field" />
              </label>
              <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-ink-2">
                数量
                <input type="number" step="any" value={editForm.qty} onChange={(e) => setEditForm({ ...editForm, qty: e.target.value })} className="field" />
              </label>
              <label className="col-span-2 flex flex-col gap-1.5 text-[13px] font-semibold text-ink-2">
                分组
                <select
                  value={editForm.watchGroupId}
                  onChange={(e) => setEditForm({ ...editForm, watchGroupId: e.target.value })}
                  className="field"
                >
                  <option value="">未分组</option>
                  {watchGroups.filter((g) => g.kind === "custom").map((g) => (
                    <option key={g.id} value={g.id}>{g.name}</option>
                  ))}
                </select>
              </label>
              <label className="col-span-2 flex flex-col gap-1.5 text-[13px] font-semibold text-ink-2">
                备注
                <input value={editForm.note} onChange={(e) => setEditForm({ ...editForm, note: e.target.value })} className="field" />
              </label>
            </div>
            <div className="mt-5 flex justify-end gap-2.5">
              <button type="button" onClick={() => setEditRecord(null)} className="btn btn-ghost btn-sm">取消</button>
              <button type="button" disabled={editSaving} onClick={saveEdit} className="btn btn-line btn-sm disabled:opacity-60">
                {editSaving ? "保存中…" : "保存"}
              </button>
            </div>
        </AppModal>
      )}
      {deleteRecord && (
        <AppModal title="删除股票" desc="从自选股中移除这只股票" onClose={() => setDeleteRecord(null)} size="sm">
          <div className="space-y-4">
            <div className="flex items-start gap-3 rounded-xl border border-down/20 bg-down/5 px-4 py-3.5">
              <span className="mt-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-full bg-down/10 text-down" aria-hidden="true">
                <DeleteIcon size={16} />
              </span>
              <div>
                <p className="font-semibold text-ink">{deleteRecord.name}</p>
                <p className="mt-1 text-xs text-muted">{deleteRecord.code} · {marketMeta(deleteRecord.market).label}</p>
                <p className="mt-2 text-xs leading-5 text-muted">删除后不会影响历史订单或资金记录，但会从当前自选股列表中移除。</p>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setDeleteRecord(null)} className="btn btn-ghost btn-sm">取消</button>
              <button type="button" onClick={() => { const r = deleteRecord; setDeleteRecord(null); void onRemove(r); }} className="btn btn-sm bg-down text-white hover:bg-down/90">确认删除</button>
            </div>
          </div>
        </AppModal>
      )}

      {groupSheetOpen && (
        <WatchGroupSheet
          initialView="manage"
          groups={watchGroups}
          records={records}
          selectedId={filterId}
          onSelect={(id) => {
            setFilterId(id);
            setPage(1);
            setGroupSheetOpen(false);
          }}
          onClose={() => setGroupSheetOpen(false)}
          onCreate={createGroup}
          onUpdate={updateGroup}
          onDelete={deleteGroup}
          onReorder={reorderGroups}
          onUploadIcon={uploadGroupIcon}
          brokerIcons={brokerIcons}
        />
      )}

      {importOpen && (
        <ImportSnapshotModal
          mode="watchlist"
          watchGroups={customWatchGroups}
          onClose={() => setImportOpen(false)}
          onImported={() => {
            // 触发父层重拉记录 + 刷新行情，导入的自选股立即生效
            window.dispatchEvent(new Event("fire:records-updated"));
            refreshQuotes();
          }}
        />
      )}
    </div>
  );
}
