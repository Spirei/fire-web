"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import Pagination from "@/components/Pagination";
import RefreshButton from "@/components/RefreshButton";
import CurrencySelect from "@/components/CurrencySelect";
import MarketIcon from "@/components/MarketIcon";
import SafeAssetImage from "@/components/SafeAssetImage";
import { usdCap } from "@/lib/currency";
import { useDisplayCurrency } from "@/lib/currencyPrefs";
import { fmtDateTime, fmtMoney, fmtPrice, fmtQty } from "@/lib/format";
import { marketMeta, type Activity, type SystemLog, type TradeOrder } from "@/lib/types";
import { useAssetIcons } from "@/lib/useAssetIcons";

interface Props {
  activities: Activity[];
  systemLogs?: SystemLog[];
  orders?: TradeOrder[];
  isAdmin?: boolean;
  onRefresh?: () => Promise<void> | void;
}

type Scope = "user" | "system";
type RowFilter = Activity["action"] | "trade" | "all";
type MarketFilter = "all" | "US" | "HK" | "CN";
type DailySummary = {
  date: string;
  holdings: number;
  markets: Record<string, { holdings: number; pnl: number; date: string }>;
  settlement: string;
};
type TimelineRow = {
  id: string;
  at: string;
  kind: "activity" | "order";
  action: Activity["action"] | TradeOrder["side"];
  market: string;
  name: string;
  code: string;
  userName: string;
  userAvatar: string;
  qty?: number;
  price?: number;
  status?: string;
};

const ACTION_META: Record<TimelineRow["action"], { label: string; cls: string }> = {
  created: { label: "新增", cls: "bg-brand-light text-brand-deep" },
  updated: { label: "修改", cls: "bg-[#fff4e5] text-[#b06a00]" },
  deleted: { label: "删除", cls: "bg-up-bg text-up" },
  buy: { label: "买入", cls: "bg-up-bg text-up" },
  sell: { label: "卖出", cls: "bg-down-bg text-down" },
  dividend: { label: "股息", cls: "bg-brand-light text-brand-deep" }
};

const MODULE_LABELS: Record<string, string> = {
  auth: "账户",
  security: "安全",
  permission: "权限",
  deploy: "部署",
  system: "系统"
};

const SUMMARY_MARKETS: Array<{ label: string; market: string }> = [
  { label: "合计", market: "TOTAL" },
  { label: "美股", market: "US" },
  { label: "港股", market: "HK" },
  { label: "A股", market: "CN" }
];

const PAGE_SIZE = 10;
const ORDER_STATUS: Record<string, string> = {
  filled: "已成交",
  pending: "待成交",
  cancelled: "已撤单",
  expired: "已失效"
};
const USER_FILTERS: Array<{ id: RowFilter; label: string }> = [
  { id: "all", label: "全部动态" },
  { id: "trade", label: "交易" },
  { id: "created", label: "新增" },
  { id: "updated", label: "修改" },
  { id: "deleted", label: "删除" }
];

function systemLevel(event: string) {
  if (event.includes("rate_limited")) return { label: "警告", cls: "bg-amber-500/10 text-amber-700 dark:text-amber-300" };
  if (event.includes("failed") || event.includes("denied") || event.includes("error")) return { label: "失败", cls: "bg-red-500/10 text-red-600 dark:text-red-300" };
  if (event.includes("success")) return { label: "成功", cls: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300" };
  if (event.includes("logout")) return { label: "退出", cls: "bg-slate-500/10 text-muted" };
  return { label: "记录", cls: "bg-amber-500/10 text-amber-700 dark:text-amber-300" };
}

function systemEventLabel(event: string) {
  const labels: Record<string, string> = {
    "auth.login.success": "登录成功",
    "auth.login.failed": "登录失败",
    "auth.login.rate_limited": "登录限流",
    "auth.register.success": "注册成功",
    "auth.logout": "退出登录"
  };
  const [module, action] = event.split(/[.:/]/);
  return labels[event] || `${MODULE_LABELS[module] || "系统"} · ${(action || event).replace(/[._]/g, " ")}`;
}

const isKeySystemEvent = (event: string) => /^(auth\.|security\.|permission\.|deploy\.|system\.)/.test(event);

function readQuery(): { scope: Scope; filter: RowFilter; systemFilter: string; market: MarketFilter; page: number; query: string } {
  if (typeof window === "undefined") return { scope: "user", filter: "all", systemFilter: "all", market: "all", page: 1, query: "" };
  const params = new URLSearchParams(window.location.search);
  const op = params.get("op");
  const market = params.get("market");
  const page = Number(params.get("page") || "1");
  return {
    scope: params.get("scope") === "system" ? "system" : "user",
    filter: op === "created" || op === "updated" || op === "deleted" || op === "trade" ? op : "all",
    systemFilter: params.get("mod") || "all",
    market: market === "US" || market === "HK" || market === "CN" ? market : "all",
    page: Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1,
    query: params.get("q") || ""
  };
}

function writeQuery(scope: Scope, filter: RowFilter, systemFilter: string, market: MarketFilter, page: number, query: string) {
  const url = new URL(window.location.href);
  if (scope === "system") url.searchParams.set("scope", "system");
  else url.searchParams.delete("scope");
  if (scope === "user" && filter !== "all") url.searchParams.set("op", filter);
  else url.searchParams.delete("op");
  if (scope === "user" && market !== "all") url.searchParams.set("market", market);
  else url.searchParams.delete("market");
  if (scope === "system" && systemFilter !== "all") url.searchParams.set("mod", systemFilter);
  else url.searchParams.delete("mod");
  if (page > 1) url.searchParams.set("page", String(page));
  else url.searchParams.delete("page");
  if (query) url.searchParams.set("q", query);
  else url.searchParams.delete("q");
  const next = url.pathname + (url.searchParams.toString() ? `?${url.searchParams.toString()}` : "");
  window.history.replaceState(null, "", next);
}

function signedMoney(value: number, symbol: string) {
  const body = fmtMoney(Math.abs(value), symbol);
  return value >= 0 ? `+${body}` : `−${body.replace(/^-/, "")}`;
}

export default function ActivitiesView({ activities, systemLogs = [], orders = [], isAdmin = false, onRefresh }: Props) {
  const initial = readQuery();
  const [scope, setScope] = useState<Scope>(initial.scope);
  const [systemFilter, setSystemFilter] = useState(initial.systemFilter);
  const [query, setQuery] = useState(initial.query);
  const [page, setPage] = useState(initial.page);
  const [filter, setFilter] = useState<RowFilter>(initial.filter);
  const [marketFilter, setMarketFilter] = useState<MarketFilter>(initial.market);
  const [filterOpen, setFilterOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  const [lastRefreshed, setLastRefreshed] = useState("");
  const [dailySummary, setDailySummary] = useState<DailySummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const { currency, setCurrency, symbol, rates, fx } = useDisplayCurrency();
  const { stockIcons } = useAssetIcons(["stock"]);
  const profile = activities[0];

  const timeline = useMemo<TimelineRow[]>(() => {
    const activityRows: TimelineRow[] = activities.map((item) => ({
      id: `a-${item.id}`,
      at: item.createdAt,
      kind: "activity",
      action: item.action,
      market: item.market,
      name: item.stockName,
      code: item.stockCode,
      userName: item.userName,
      userAvatar: item.userAvatar
    }));
    const orderRows: TimelineRow[] = orders.map((order) => ({
      id: `o-${order.id}`,
      at: order.tradedAt || order.createdAt,
      kind: "order",
      action: order.side,
      market: order.market,
      name: order.name,
      code: order.code,
      userName: profile?.userName || "",
      userAvatar: profile?.userAvatar || "",
      qty: order.qty,
      price: order.price,
      status: order.status
    }));
    return [...activityRows, ...orderRows].sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || a.id.localeCompare(b.id));
  }, [activities, orders, profile?.userAvatar, profile?.userName]);

  const visibleSystemLogs = useMemo(
    () => systemLogs.filter((log) => isKeySystemEvent(log.event) && `${log.event} ${log.detail} ${log.userName} ${log.ip}`.toLowerCase().includes(query.toLowerCase()) && (systemFilter === "all" || log.event.split(/[.:/]/)[0] === systemFilter)),
    [query, systemFilter, systemLogs]
  );
  const userRows = useMemo(() => timeline.filter((item) => {
    if (filter === "trade" && item.kind !== "order") return false;
    if (filter !== "all" && filter !== "trade" && item.action !== filter) return false;
    if (marketFilter !== "all" && item.market.toUpperCase() !== marketFilter) return false;
    const hay = `${item.name} ${item.code} ${item.userName} ${ACTION_META[item.action].label}`.toLowerCase();
    return hay.includes(query.toLowerCase());
  }), [filter, marketFilter, query, timeline]);
  const rows = scope === "user" ? userRows : visibleSystemLogs;
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = rows.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const systemModules = useMemo(
    () => Array.from(new Set(systemLogs.map((log) => log.event.split(/[.:/]/)[0]).filter(Boolean))).slice(0, 8),
    [systemLogs]
  );

  const convertedMarkets = useMemo(() => {
    const map: Record<string, number> = {};
    Object.entries(dailySummary?.markets ?? {}).forEach(([market, item]) => {
      map[market] = fx(usdCap(market, item.pnl, rates));
    });
    return map;
  }, [dailySummary, fx, rates]);
  const convertedTotal = Object.values(convertedMarkets).reduce((sum, value) => sum + value, 0);

  useEffect(() => { setPage(1); }, [scope, filter, systemFilter, marketFilter, query]);
  useEffect(() => { if (page !== safePage) setPage(safePage); }, [page, safePage]);
  useEffect(() => { writeQuery(scope, filter, systemFilter, marketFilter, safePage, query); }, [filter, marketFilter, query, safePage, scope, systemFilter]);

  useEffect(() => {
    if (!onRefresh) return;
    const timer = window.setInterval(() => { void refreshLogs(); }, 30_000);
    return () => window.clearInterval(timer);
  }, [isAdmin, onRefresh, scope]);

  useEffect(() => {
    if (scope !== "user") return;
    const controller = new AbortController();
    setSummaryLoading(true);
    fetch("/api/activities/daily-summary", { cache: "no-store", signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (data) setDailySummary(data); })
      .catch(() => {})
      .finally(() => { if (!controller.signal.aborted) setSummaryLoading(false); });
    return () => controller.abort();
  }, [lastRefreshed, scope]);

  const refreshLogs = async () => {
    if (!onRefresh || refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    try {
      await onRefresh();
      setLastRefreshed(new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }));
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  };

  const selectMarket = (market: string) => {
    if (market === "TOTAL") setMarketFilter("all");
    else setMarketFilter((current) => (current === market ? "all" : market as MarketFilter));
  };

  return (
    <div className="overflow-hidden rounded-[18px] border border-edge bg-white shadow-card dark:bg-[#151b26]">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-edge px-5 pt-4">
        <div className="flex gap-6">
          {(["user", "system"] as const).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => { setScope(key); setFilterOpen(false); }}
              className={`border-b-2 pb-3 text-sm font-semibold transition ${scope === key ? "border-ink text-ink dark:border-white dark:text-white" : "border-transparent text-muted hover:text-ink dark:hover:text-white"}`}
            >
              {key === "user" ? "用户日志" : "系统日志"}
              <span className="ml-1.5 text-xs font-normal text-faint">{key === "user" ? timeline.length : systemLogs.filter((log) => isKeySystemEvent(log.event)).length}</span>
            </button>
          ))}
        </div>
        <div className="mb-3 flex w-full items-center gap-2 sm:w-auto">
          {(scope === "user" || isAdmin) && (
            <div className="relative">
              <button
                type="button"
                title={scope === "user" ? (USER_FILTERS.find((item) => item.id === filter)?.label || "筛选动态") : (systemFilter === "all" ? "全部模块" : MODULE_LABELS[systemFilter] || systemFilter)}
                aria-label={scope === "user" ? "筛选动态" : "筛选模块"}
                aria-expanded={filterOpen}
                aria-pressed={scope === "user" ? filter !== "all" : systemFilter !== "all"}
                onClick={() => setFilterOpen((open) => !open)}
                className={`grid h-9 w-9 flex-none place-items-center rounded-lg border transition ${filterOpen || (scope === "user" ? filter !== "all" : systemFilter !== "all") ? "border-edge-strong bg-bg-gray text-ink dark:bg-white/10 dark:text-white" : "border-edge text-muted hover:bg-bg-gray hover:text-ink dark:hover:bg-white/10 dark:hover:text-white"}`}
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
                  <path d="M4 5h16l-6 7v5l-4 2v-7L4 5Z" />
                </svg>
              </button>
              {filterOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setFilterOpen(false)} />
                  <div className="absolute left-0 top-full z-50 mt-2 w-36 overflow-hidden rounded-xl border border-edge-strong bg-white p-1.5 shadow-pop dark:border-[#2a3140] dark:bg-[#1b2029]">
                    {scope === "user"
                      ? USER_FILTERS.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => { setFilter(item.id); setFilterOpen(false); }}
                          className={`flex w-full items-center rounded-lg px-3 py-2 text-left text-xs transition ${filter === item.id ? "bg-bg-gray font-semibold text-ink dark:bg-white/10 dark:text-white" : "text-ink hover:bg-bg-gray dark:text-slate-200 dark:hover:bg-white/10"}`}
                        >
                          {item.label}
                        </button>
                      ))
                      : [{ id: "all", label: "全部模块" }, ...systemModules.map((key) => ({ id: key, label: MODULE_LABELS[key] || key }))].map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => { setSystemFilter(item.id); setFilterOpen(false); }}
                          className={`flex w-full items-center rounded-lg px-3 py-2 text-left text-xs transition ${systemFilter === item.id ? "bg-bg-gray font-semibold text-ink dark:bg-white/10 dark:text-white" : "text-ink hover:bg-bg-gray dark:text-slate-200 dark:hover:bg-white/10"}`}
                        >
                          {item.label}
                        </button>
                      ))}
                  </div>
                </>
              )}
            </div>
          )}
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="搜索日志"
            placeholder="搜索名称、代码或事件"
            className="h-9 w-full rounded-lg border border-edge bg-transparent px-3 text-sm outline-none transition placeholder:text-faint focus:border-ink dark:focus:border-white sm:w-64"
          />
          {onRefresh && <RefreshButton onClick={() => void refreshLogs()} title={refreshing ? "正在刷新日志" : "刷新日志"} />}
          {lastRefreshed && <span className="hidden whitespace-nowrap text-[11px] text-faint sm:inline">更新于 {lastRefreshed}</span>}
        </div>
      </div>

      {scope === "system" && !isAdmin && <div className="p-8 text-center text-sm text-faint">系统日志仅管理员可见</div>}

      {scope === "user" && (
        <div className="mx-5 mt-4 rounded-xl border border-edge bg-bg-gray/50 px-4 py-3 dark:bg-white/[.04]">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-semibold text-muted">前一日持仓盈利</p>
              <p className="mt-1 text-[11px] text-faint">
                {summaryLoading ? "正在汇总上一交易日收盘盈亏" : `${dailySummary?.date || "暂无日期"} · ${dailySummary?.settlement || "上一交易日收盘相对前收盘"}`}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="text-[11px] text-faint">{dailySummary?.holdings ? `${dailySummary.holdings} 只持仓` : summaryLoading ? "…" : "暂无持仓"}</span>
              <CurrencySelect value={currency} onChange={setCurrency} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {SUMMARY_MARKETS.map(({ label, market }, index) => {
              const raw = market === "TOTAL" ? (dailySummary?.holdings ? convertedTotal : undefined) : dailySummary?.markets[market]?.pnl;
              const value = market === "TOTAL" ? raw : (raw === undefined ? undefined : convertedMarkets[market] ?? 0);
              const count = market === "TOTAL" ? dailySummary?.holdings : dailySummary?.markets[market]?.holdings;
              const date = market === "TOTAL" ? dailySummary?.date : dailySummary?.markets[market]?.date;
              const selected = market === "TOTAL" ? marketFilter === "all" : marketFilter === market;
              return (
                <button
                  key={market}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => selectMarket(market)}
                  className={`rounded-lg px-1 py-1 text-left transition ${index === 0 ? "" : "sm:border-l sm:border-edge sm:pl-3"} ${selected ? "bg-white shadow-sm dark:bg-[#1c222d]" : "hover:bg-white/70 dark:hover:bg-white/[.06]"}`}
                >
                  <p className="flex items-center gap-1.5 text-[11px] text-muted">
                    {market === "TOTAL" ? (
                      <span className="inline-flex h-[14px] w-[14px] shrink-0 items-center justify-center rounded-full bg-slate-200 text-[11px] font-bold leading-none text-slate-600 dark:bg-white/10 dark:text-slate-300" aria-hidden>Σ</span>
                    ) : (
                      <MarketIcon market={market} flag={marketMeta(market).flag} size={14} />
                    )}
                    {label}
                  </p>
                  <strong className={`mt-1 block text-sm tabular-nums ${value === undefined ? "text-faint" : value >= 0 ? "text-up" : "text-down"}`}>
                    {summaryLoading && value === undefined ? "…" : value === undefined ? "—" : signedMoney(value, symbol)}
                  </strong>
                  <span className="mt-0.5 block text-[10px] text-faint">{count ? `${count} 只${date ? ` · ${date.slice(5)}` : ""}` : "无持仓"}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {scope === "system" && isAdmin && (
        <>
          <div className="data-table-scroll">
            <table className="w-full min-w-[700px] text-sm">
              <thead>
                <tr className="bg-bg-gray text-xs font-semibold text-muted">
                  <th className="px-4 py-3 text-left">级别</th>
                  <th className="px-4 py-3 text-left">事件</th>
                  <th className="px-4 py-3 text-left">详情</th>
                  <th className="px-4 py-3 text-left">用户 / IP</th>
                  <th className="px-4 py-3 text-left">时间</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((log) => {
                  if (!("event" in log)) return null;
                  const level = systemLevel(log.event);
                  return (
                    <tr key={log.id} className="border-t border-edge">
                      <td className="px-4 py-3"><span className={`rounded-md px-2 py-1 text-xs font-semibold ${level.cls}`}>{level.label}</span></td>
                      <td className="px-4 py-3 font-semibold">{systemEventLabel(log.event)}</td>
                      <td className="max-w-[320px] px-4 py-3 text-xs text-muted">
                        <details>
                          <summary className="cursor-pointer truncate">{log.detail || "查看详情"}</summary>
                          <p className="mt-2 whitespace-pre-wrap break-words text-xs">{log.detail || "—"}</p>
                        </details>
                      </td>
                      <td className="px-4 py-3 text-xs text-muted">{log.userName}<br />{log.ip || "—"}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-xs text-muted">{fmtDateTime(log.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {visibleSystemLogs.length === 0 && <div className="py-12 text-center text-sm text-faint">该模块暂无日志</div>}
          </div>
          {visibleSystemLogs.length > PAGE_SIZE && (
            <div className="flex items-center justify-between border-t border-edge px-5 py-3 text-xs text-muted">
              <span>{`${(safePage - 1) * PAGE_SIZE + 1}-${Math.min(safePage * PAGE_SIZE, visibleSystemLogs.length)} / ${visibleSystemLogs.length}`}</span>
              <Pagination page={safePage} total={totalPages} onChange={setPage} />
            </div>
          )}
        </>
      )}

      {scope === "user" && (
        <>
          <div className="mt-4 data-table-scroll">
            <table className="mobile-activities-table w-full min-w-[620px] text-[13px]">
              <thead>
                <tr className="whitespace-nowrap bg-bg-gray text-xs font-semibold text-muted">
                  <th className="px-5 py-3 text-left text-[11px] font-medium uppercase tracking-wide">用户</th>
                  <th className="px-5 py-3 text-left text-[11px] font-medium uppercase tracking-wide">操作</th>
                  <th className="px-5 py-3 text-left text-[11px] font-medium uppercase tracking-wide">股票</th>
                  <th className="px-5 py-3 text-left text-[11px] font-medium uppercase tracking-wide">操作时间</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((item) => {
                  if (!("kind" in item)) return null;
                  const meta = ACTION_META[item.action];
                  const market = item.market || "OTHER";
                  const marketInfo = marketMeta(market);
                  const displayName = item.userName || "?";
                  const icon = stockIcons[`${market.toUpperCase()}:${item.code.toUpperCase()}`];
                  return (
                    <tr key={item.id} className="whitespace-nowrap border-t border-edge transition-colors hover:bg-bg-gray/50 dark:hover:bg-white/[.03]">
                      <td className="px-5 py-3.5">
                        {item.userAvatar ? (
                          <img src={item.userAvatar} alt={displayName} title={displayName} className="h-8 w-8 cursor-default rounded-full object-cover ring-2 ring-edge-strong" />
                        ) : (
                          <span className="inline-flex h-8 w-8 cursor-default items-center justify-center rounded-full bg-brand-light text-[12px] font-bold text-brand-deep ring-2 ring-edge-strong" title={displayName}>
                            {displayName.slice(0, 1).toUpperCase()}
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-3.5">
                        <span className={`inline-block rounded-md px-2 py-1 text-[11px] font-semibold ${meta.cls}`}>{meta.label}</span>
                      </td>
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-2">
                          {icon ? (
                            <SafeAssetImage src={icon} alt="" className="h-6 w-6 shrink-0 rounded-full object-cover" fallback={<span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-bg-gray text-[10px] font-bold text-muted">{item.name.slice(0, 1)}</span>} />
                          ) : null}
                          <div className="flex min-w-0 flex-col leading-[1.35]">
                            <b className="font-semibold">{item.name}</b>
                            <small className="text-xs text-muted">
                              {item.code} · {marketInfo.label}
                              {item.kind === "order" && item.qty != null ? ` · ${fmtQty(item.qty)} × ${fmtPrice(item.price ?? "", marketInfo.currency, market)}` : ""}
                              {item.status ? ` · ${ORDER_STATUS[item.status] || item.status}` : ""}
                            </small>
                          </div>
                        </div>
                      </td>
                      <td className="px-5 py-3.5 text-xs tabular-nums text-muted">{fmtDateTime(item.at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {userRows.length > PAGE_SIZE && (
            <div className="flex items-center justify-between gap-3 border-t border-edge px-4 py-3 text-xs text-muted">
              <span>{`${(safePage - 1) * PAGE_SIZE + 1}-${Math.min(safePage * PAGE_SIZE, userRows.length)} / ${userRows.length}`}</span>
              <Pagination page={safePage} total={totalPages} onChange={setPage} />
            </div>
          )}
          {userRows.length === 0 && <div className="py-12 text-center text-sm text-faint">没有符合条件的日志</div>}
        </>
      )}
    </div>
  );
}
