"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import Pagination from "@/components/Pagination";
import RefreshButton from "@/components/RefreshButton";
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
type OpFilter = Activity["action"] | "all";

const ACTION_META: Record<Activity["action"], { label: string; cls: string }> = {
  created: { label: "新增", cls: "bg-brand-light text-brand-deep" },
  updated: { label: "修改", cls: "bg-[#fff4e5] text-[#b06a00]" },
  deleted: { label: "删除", cls: "bg-up-bg text-up" }
};

const MODULE_LABELS: Record<string, string> = {
  auth: "账户",
  security: "安全",
  permission: "权限",
  deploy: "部署",
  system: "系统"
};

const SUMMARY_MARKETS: Array<{ label: string; market: string }> = [
  { label: "美股", market: "US" },
  { label: "港股", market: "HK" },
  { label: "A股", market: "CN" },
  { label: "总盈利", market: "TOTAL" }
];

const PAGE_SIZE = 10;
const ORDER_PREVIEW = 10;

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

function readQuery(): { scope: Scope; filter: OpFilter; systemFilter: string; page: number; query: string } {
  if (typeof window === "undefined") return { scope: "user", filter: "all", systemFilter: "all", page: 1, query: "" };
  const params = new URLSearchParams(window.location.search);
  const op = params.get("op");
  const page = Number(params.get("page") || "1");
  return {
    scope: params.get("scope") === "system" ? "system" : "user",
    filter: op === "created" || op === "updated" || op === "deleted" ? op : "all",
    systemFilter: params.get("mod") || "all",
    page: Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1,
    query: params.get("q") || ""
  };
}

function writeQuery(scope: Scope, filter: OpFilter, systemFilter: string, page: number, query: string) {
  const url = new URL(window.location.href);
  if (scope === "system") url.searchParams.set("scope", "system");
  else url.searchParams.delete("scope");
  if (scope === "user" && filter !== "all") url.searchParams.set("op", filter);
  else url.searchParams.delete("op");
  if (scope === "system" && systemFilter !== "all") url.searchParams.set("mod", systemFilter);
  else url.searchParams.delete("mod");
  if (page > 1) url.searchParams.set("page", String(page));
  else url.searchParams.delete("page");
  if (query) url.searchParams.set("q", query);
  else url.searchParams.delete("q");
  const next = url.pathname + (url.searchParams.toString() ? `?${url.searchParams.toString()}` : "");
  window.history.replaceState(null, "", next);
}

function orderTime(order: TradeOrder) {
  return Date.parse(order.tradedAt || order.createdAt) || 0;
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
  const [filter, setFilter] = useState<OpFilter>(initial.filter);
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  const [lastRefreshed, setLastRefreshed] = useState("");
  const [dailySummary, setDailySummary] = useState<{
    date: string;
    trades: number;
    realized: number;
    markets: Record<string, { trades: number; realized: number }>;
    currency: string;
    settlement: string;
  } | null>(null);
  const { symbol, rates, fx } = useDisplayCurrency();
  const { stockIcons } = useAssetIcons(["stock"]);

  const visibleActivities = useMemo(
    () => activities.filter((item) => `${item.stockName} ${item.stockCode} ${item.userName}`.toLowerCase().includes(query.toLowerCase())),
    [activities, query]
  );
  const visibleSystemLogs = useMemo(
    () => systemLogs.filter((log) => isKeySystemEvent(log.event) && `${log.event} ${log.detail} ${log.userName} ${log.ip}`.toLowerCase().includes(query.toLowerCase()) && (systemFilter === "all" || log.event.split(/[.:/]/)[0] === systemFilter)),
    [query, systemFilter, systemLogs]
  );
  const userRows = useMemo(
    () => visibleActivities.filter((item) => filter === "all" || item.action === filter),
    [filter, visibleActivities]
  );
  const rows = scope === "user" ? userRows : visibleSystemLogs;
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = rows.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const recentOrders = useMemo(
    () => [...orders].sort((a, b) => orderTime(b) - orderTime(a)).slice(0, ORDER_PREVIEW),
    [orders]
  );
  const systemModules = useMemo(
    () => Array.from(new Set(systemLogs.map((log) => log.event.split(/[.:/]/)[0]).filter(Boolean))).slice(0, 8),
    [systemLogs]
  );

  const convertedMarkets = useMemo(() => {
    const map: Record<string, number> = {};
    Object.entries(dailySummary?.markets ?? {}).forEach(([market, item]) => {
      map[market] = fx(usdCap(market, item.realized, rates));
    });
    return map;
  }, [dailySummary, fx, rates]);
  const convertedTotal = Object.values(convertedMarkets).reduce((sum, value) => sum + value, 0);

  useEffect(() => { setPage(1); }, [scope, filter, systemFilter, query]);
  useEffect(() => { if (page !== safePage) setPage(safePage); }, [page, safePage]);
  useEffect(() => { writeQuery(scope, filter, systemFilter, safePage, query); }, [filter, query, safePage, scope, systemFilter]);

  useEffect(() => {
    if (!onRefresh) return;
    const timer = window.setInterval(() => { void refreshLogs(); }, 30_000);
    return () => window.clearInterval(timer);
  }, [isAdmin, onRefresh, scope]);

  useEffect(() => {
    if (scope !== "user") return;
    fetch("/api/activities/daily-summary", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (data) setDailySummary(data); })
      .catch(() => {});
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

  return (
    <div className="overflow-hidden rounded-[18px] border border-edge bg-white shadow-card dark:bg-[#151b26]">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-edge px-5 pt-4">
        <div className="flex gap-6">
          {(["user", "system"] as const).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setScope(key)}
              className={`border-b-2 pb-3 text-sm font-semibold transition ${scope === key ? "border-ink text-ink dark:border-white dark:text-white" : "border-transparent text-muted hover:text-ink dark:hover:text-white"}`}
            >
              {key === "user" ? "用户日志" : "系统日志"}
              <span className="ml-1.5 text-xs font-normal text-faint">{key === "user" ? activities.length : systemLogs.filter((log) => isKeySystemEvent(log.event)).length}</span>
            </button>
          ))}
        </div>
        <div className="mb-3 flex w-full items-center gap-2 sm:w-auto">
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

      {scope === "user" && dailySummary && (
        <div className="mx-5 mt-4 rounded-xl border border-edge bg-bg-gray/50 px-4 py-3 dark:bg-white/[.04]">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold text-muted">最近交易日盈利摘要</p>
              <p className="mt-1 text-[11px] text-faint">{dailySummary.date || "暂无日期"} · {dailySummary.settlement}</p>
            </div>
            <span className="text-[11px] text-faint">{dailySummary.trades} 笔成交</span>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {SUMMARY_MARKETS.map(({ label, market }, index) => {
              const raw = market === "TOTAL" ? (dailySummary.trades ? convertedTotal : undefined) : dailySummary.markets[market]?.realized;
              const value = market === "TOTAL" ? raw : (raw === undefined ? undefined : convertedMarkets[market] ?? 0);
              const trades = market === "TOTAL" ? dailySummary.trades : dailySummary.markets[market]?.trades;
              return (
                <div key={market} className={`pl-3 ${index === 0 ? "border-0 pl-0" : "border-l border-edge"}`}>
                  <p className="flex items-center gap-1.5 text-[11px] text-muted">
                    {market === "TOTAL" ? (
                      <span className="grid h-3.5 w-3.5 place-items-center rounded-full bg-slate-200 text-[8px] font-bold text-slate-600 dark:bg-white/10 dark:text-slate-300">Σ</span>
                    ) : (
                      <MarketIcon market={market} flag={marketMeta(market).flag} size={14} />
                    )}
                    {label}
                  </p>
                  <strong className={`mt-1 block text-sm tabular-nums ${value === undefined ? "text-faint" : value >= 0 ? "text-up" : "text-down"}`}>
                    {value === undefined ? "—" : signedMoney(value, symbol)}
                  </strong>
                  <span className="mt-0.5 block text-[10px] text-faint">{trades ? `${trades} 笔` : "无成交"}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {scope === "user" && recentOrders.length > 0 && (
        <div className="mx-5 mt-4 overflow-hidden rounded-xl border border-edge">
          <div className="flex items-center justify-between border-b border-edge px-4 py-3">
            <span className="text-xs font-semibold text-muted">交易记录</span>
            <span className="text-[11px] text-faint">{orders.length > ORDER_PREVIEW ? `最近 ${ORDER_PREVIEW} 条 / 共 ${orders.length} 条` : `买卖与挂单 · ${orders.length} 条`}</span>
          </div>
          <div className="data-table-scroll">
            <table className="w-full min-w-[620px] text-[12px]">
              <thead>
                <tr className="bg-bg-gray text-[11px] text-muted">
                  <th className="px-4 py-2 text-left">市场</th>
                  <th className="px-4 py-2 text-left">方向</th>
                  <th className="px-4 py-2 text-left">股票</th>
                  <th className="px-4 py-2 text-right">数量</th>
                  <th className="px-4 py-2 text-right">价格</th>
                  <th className="px-4 py-2 text-left">状态</th>
                  <th className="px-4 py-2 text-right">时间</th>
                </tr>
              </thead>
              <tbody>
                {recentOrders.map((order) => {
                  const meta = marketMeta(order.market);
                  return (
                    <tr key={order.id} className="border-t border-edge">
                      <td className="px-4 py-2.5">
                        <span className="inline-flex items-center gap-1.5">
                          <MarketIcon market={order.market} flag={meta.flag} size={15} />
                          <span className="text-muted">{meta.label}</span>
                        </span>
                      </td>
                      <td className={`px-4 py-2.5 font-semibold ${order.side === "buy" ? "text-up" : order.side === "sell" ? "text-down" : "text-muted"}`}>
                        {order.side === "buy" ? "买入" : order.side === "sell" ? "卖出" : "股息"}
                      </td>
                      <td className="px-4 py-2.5 font-semibold">
                        {order.name}
                        <span className="ml-1 font-normal text-muted">{order.code}</span>
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{fmtQty(order.qty)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{fmtPrice(order.price, meta.currency, order.market)}</td>
                      <td className="px-4 py-2.5 text-muted">{order.status === "filled" ? "已成交" : order.status === "pending" ? "待成交" : order.status === "cancelled" ? "已撤单" : "已失效"}</td>
                      <td className="px-4 py-2.5 text-right text-muted">{fmtDateTime(order.tradedAt || order.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {scope === "system" && isAdmin && (
        <>
          <div className="flex items-center justify-between border-b border-edge px-5 py-3">
            <select value={systemFilter} onChange={(event) => setSystemFilter(event.target.value)} className="h-8 rounded-lg border border-edge bg-transparent px-2.5 text-xs text-muted outline-none">
              <option value="all">全部模块</option>
              {systemModules.map((key) => (
                <option key={key} value={key}>{MODULE_LABELS[key] || key}</option>
              ))}
            </select>
            <span className="text-xs text-faint">{visibleSystemLogs.length} 条</span>
          </div>
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
          <div className="flex items-center justify-between border-b border-edge px-5 py-3">
            <select value={filter} onChange={(event) => setFilter(event.target.value as OpFilter)} className="h-8 rounded-lg border border-edge bg-transparent px-2.5 text-xs text-muted outline-none">
              <option value="all">全部操作</option>
              <option value="created">新增</option>
              <option value="updated">修改</option>
              <option value="deleted">删除</option>
            </select>
            <span className="text-xs text-faint">{userRows.length} 条记录</span>
          </div>
          <div className="data-table-scroll">
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
                  if (!("action" in item)) return null;
                  const meta = ACTION_META[item.action];
                  const market = item.market || "OTHER";
                  const marketInfo = marketMeta(market);
                  const displayName = item.userName || "?";
                  const icon = stockIcons[`${market.toUpperCase()}:${item.stockCode.toUpperCase()}`];
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
                            <SafeAssetImage src={icon} alt="" className="h-6 w-6 shrink-0 rounded-full object-cover" fallback={<span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-bg-gray text-[10px] font-bold text-muted">{item.stockName.slice(0, 1)}</span>} />
                          ) : null}
                          <div className="flex min-w-0 flex-col leading-[1.35]">
                            <b className="font-semibold">{item.stockName}</b>
                            <small className="flex items-center gap-1 text-xs text-muted">
                              <MarketIcon market={market} flag={marketInfo.flag} size={13} />
                              {item.stockCode} · {marketInfo.label}
                            </small>
                          </div>
                        </div>
                      </td>
                      <td className="px-5 py-3.5 text-xs tabular-nums text-muted">{fmtDateTime(item.createdAt)}</td>
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
