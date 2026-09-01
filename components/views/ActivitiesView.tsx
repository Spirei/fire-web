"use client";

import { useEffect, useRef, useState } from "react";

import { fmtDateTime } from "@/lib/format";
import { marketMeta, type Activity, type SystemLog } from "@/lib/types";
import RefreshButton from "@/components/RefreshButton";

interface Props {
  activities: Activity[];
  systemLogs?: SystemLog[];
  isAdmin?: boolean;
  onRefresh?: () => Promise<void> | void;
}

const ACTION_META: Record<Activity["action"], { label: string; cls: string }> = {
  created: { label: "新增", cls: "bg-brand-light text-brand-deep" },
  updated: { label: "修改", cls: "bg-[#fff4e5] text-[#b06a00]" },
  deleted: { label: "删除", cls: "bg-up-bg text-up" }
};

function systemLevel(event: string) {
  if (event.includes("rate_limited")) return { label: "警告", cls: "bg-amber-500/10 text-amber-700 dark:text-amber-300" };
  if (event.includes("failed") || event.includes("denied") || event.includes("error")) return { label: "失败", cls: "bg-red-500/10 text-red-600 dark:text-red-300" };
  if (event.includes("success")) return { label: "成功", cls: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300" };
  if (event.includes("logout")) return { label: "退出", cls: "bg-slate-500/10 text-muted" };
  return { label: "记录", cls: "bg-amber-500/10 text-amber-700 dark:text-amber-300" };
}
function systemEventLabel(event: string) {
  const labels: Record<string, string> = { "auth.login.success": "登录成功", "auth.login.failed": "登录失败", "auth.login.rate_limited": "登录限流", "auth.register.success": "注册成功", "auth.logout": "退出登录" };
  const modules: Record<string, string> = { auth: "账户", security: "安全", permission: "权限", deploy: "部署", system: "系统" };
  const [module, action] = event.split(/[.:/]/);
  return labels[event] || `${modules[module] || "系统"} · ${(action || event).replace(/[._]/g, " ")}`;
}
const isKeySystemEvent = (event: string) => /^(auth\.|security\.|permission\.|deploy\.|system\.)/.test(event);

export default function ActivitiesView({ activities, systemLogs = [], isAdmin = false, onRefresh }: Props) {
  const [scope, setScope] = useState<"user" | "system">("user");
  const [systemFilter, setSystemFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState<Activity["action"] | "all">("all");
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  const [lastRefreshed, setLastRefreshed] = useState("");
  const [dailySummary, setDailySummary] = useState<{ date: string; trades: number; realized: number; currency: string; settlement: string } | null>(null);
  const pageSize = 10;
  const visibleActivities = activities.filter((a) => `${a.stockName} ${a.stockCode} ${a.userName}`.toLowerCase().includes(query.toLowerCase()));
  const visibleSystemLogs = systemLogs.filter((log) => isKeySystemEvent(log.event) && `${log.event} ${log.detail} ${log.userName} ${log.ip}`.toLowerCase().includes(query.toLowerCase()) && (systemFilter === "all" || log.event.split(/[.:/]/)[0] === systemFilter));
  const userRows = visibleActivities.filter((a) => filter === "all" || a.action === filter);
  const rows = scope === "user" ? userRows : visibleSystemLogs;
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const pageRows = rows.slice((Math.min(page, totalPages) - 1) * pageSize, Math.min(page, totalPages) * pageSize);
  useEffect(() => { setPage(1); }, [scope, filter, systemFilter, query]);
  useEffect(() => {
    if (!onRefresh) return;
    const timer = window.setInterval(() => { void refreshLogs(); }, 30_000);
    return () => window.clearInterval(timer);
  }, [scope, isAdmin, onRefresh]);
  useEffect(() => { if (scope !== "user") return; fetch("/api/activities/daily-summary", { cache: "no-store" }).then((res) => res.ok ? res.json() : null).then((data) => { if (data) setDailySummary(data); }).catch(() => {}); }, [scope, lastRefreshed]);
  const refreshLogs = async () => { if (!onRefresh || refreshingRef.current) return; refreshingRef.current = true; setRefreshing(true); try { await onRefresh(); setLastRefreshed(new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })); } finally { refreshingRef.current = false; setRefreshing(false); } };
  return (
    <div className="overflow-hidden rounded-[18px] border border-edge bg-white shadow-card dark:bg-[#151b26]">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-edge px-5 pt-4">
        <div className="flex gap-6">{(["user", "system"] as const).map((key) => <button key={key} type="button" onClick={() => setScope(key)} className={`border-b-2 pb-3 text-sm font-semibold transition ${scope === key ? "border-ink text-ink dark:border-white dark:text-white" : "border-transparent text-muted hover:text-ink dark:hover:text-white"}`}>{key === "user" ? "用户日志" : "系统日志"}<span className="ml-1.5 text-xs font-normal text-faint">{key === "user" ? activities.length : systemLogs.length}</span></button>)}</div>
        <div className="mb-3 flex w-full items-center gap-2 sm:w-auto"><input value={query} onChange={(e) => setQuery(e.target.value)} aria-label="搜索日志" placeholder="搜索名称、代码或事件" className="h-9 w-full rounded-lg border border-edge bg-transparent px-3 text-sm outline-none transition placeholder:text-faint focus:border-ink dark:focus:border-white sm:w-64" />{onRefresh && <RefreshButton onClick={() => void refreshLogs()} title={refreshing ? "正在刷新日志" : "刷新日志"} />}{lastRefreshed && <span className="hidden whitespace-nowrap text-[11px] text-faint sm:inline">更新于 {lastRefreshed}</span>}</div>
      </div>
      {scope === "system" && !isAdmin && <div className="p-8 text-center text-sm text-faint">系统日志仅管理员可见</div>}
      {scope === "user" && dailySummary && <div className="mx-5 mt-4 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-edge bg-bg-gray/50 px-4 py-3"><div><p className="text-xs font-semibold text-muted">前一交易日盈利摘要</p><p className="mt-1 text-[11px] text-faint">{dailySummary.date || "暂无日期"} · {dailySummary.settlement}</p></div><div className="flex items-center gap-5"><div><p className="text-[11px] text-muted">已实现盈亏</p><strong className={`text-base tabular-nums ${dailySummary.realized >= 0 ? "text-up" : "text-down"}`}>{dailySummary.realized >= 0 ? "+" : "−"}{Math.abs(dailySummary.realized).toFixed(2)} <span className="text-[11px] font-normal">{dailySummary.currency}</span></strong></div><div><p className="text-[11px] text-muted">成交笔数</p><strong className="text-base tabular-nums text-ink dark:text-white">{dailySummary.trades}</strong></div></div></div>}
      {scope === "system" && isAdmin && <>
        <div className="flex items-center justify-between border-b border-edge px-5 py-3"><select value={systemFilter} onChange={(e) => setSystemFilter(e.target.value)} className="h-8 rounded-lg border border-edge bg-transparent px-2.5 text-xs text-muted outline-none"><option value="all">全部模块</option>{Array.from(new Set(systemLogs.map((log) => log.event.split(/[.:/]/)[0]).filter(Boolean))).slice(0, 8).map((key) => <option key={key} value={key}>{key}</option>)}</select><span className="text-xs text-faint">{visibleSystemLogs.length} 条</span></div>
        <div className="data-table-scroll"><table className="w-full min-w-[700px] text-sm"><thead><tr className="bg-bg-gray text-xs font-semibold text-muted"><th className="px-4 py-3 text-left">级别</th><th className="px-4 py-3 text-left">事件</th><th className="px-4 py-3 text-left">详情</th><th className="px-4 py-3 text-left">用户 / IP</th><th className="px-4 py-3 text-left">时间</th></tr></thead><tbody>{pageRows.map((log) => { if (!("event" in log)) return null; const level = systemLevel(log.event); return <tr key={log.id} className="border-t border-edge"><td className="px-4 py-3"><span className={`rounded-md px-2 py-1 text-xs font-semibold ${level.cls}`}>{level.label}</span></td><td className="px-4 py-3 font-semibold">{systemEventLabel(log.event)}</td><td className="max-w-[320px] px-4 py-3 text-xs text-muted"><details><summary className="cursor-pointer truncate">{log.detail || "查看详情"}</summary><p className="mt-2 whitespace-pre-wrap break-words text-xs">{log.detail || "—"}</p></details></td><td className="px-4 py-3 text-xs text-muted">{log.userName}<br />{log.ip || "—"}</td><td className="whitespace-nowrap px-4 py-3 text-xs text-muted">{fmtDateTime(log.createdAt)}</td></tr>; })}</tbody></table>{visibleSystemLogs.length === 0 && <div className="py-12 text-center text-sm text-faint">该模块暂无日志</div>}</div>
        <div className="flex items-center justify-between border-t border-edge px-5 py-3 text-xs text-muted"><span>{visibleSystemLogs.length ? `${(Math.min(page, totalPages) - 1) * pageSize + 1}-${Math.min(Math.min(page, totalPages) * pageSize, visibleSystemLogs.length)} / ${visibleSystemLogs.length}` : "暂无记录"}</span><div className="flex gap-2"><button type="button" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))} className="rounded-lg border border-edge px-3 py-1.5 disabled:opacity-40">上一页</button><button type="button" disabled={page >= totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))} className="rounded-lg border border-edge px-3 py-1.5 disabled:opacity-40">下一页</button></div></div>
      </>}
      {scope === "system" ? null : <>
      <div className="flex items-center justify-between border-b border-edge px-5 py-3">
        <select value={filter} onChange={(e) => setFilter(e.target.value as Activity["action"] | "all")} className="h-8 rounded-lg border border-edge bg-transparent px-2.5 text-xs text-muted outline-none"><option value="all">全部操作</option><option value="created">新增</option><option value="updated">修改</option><option value="deleted">删除</option></select>
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
            {scope === "user" && pageRows.map((a) => {
              if (!("action" in a)) return null;
              const meta = ACTION_META[a.action];
              const market = a.market || "OTHER";
              const marketInfo = marketMeta(market);
              const displayName = a.userName || "?";
              return (
                <tr key={a.id} className="whitespace-nowrap border-t border-edge transition-colors hover:bg-bg-gray/50 dark:hover:bg-white/[.03]">
                  <td className="px-5 py-3.5">
                    {a.userAvatar ? (
                      <img src={a.userAvatar} alt={displayName} title={displayName} className="h-8 w-8 cursor-default rounded-full object-cover ring-2 ring-edge-strong" />
                    ) : (
                      <span
                        className="inline-flex h-8 w-8 cursor-default items-center justify-center rounded-full bg-brand-light text-[12px] font-bold text-brand-deep ring-2 ring-edge-strong"
                        title={displayName}
                      >
                        {displayName.slice(0, 1).toUpperCase()}
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-3.5">
                    <span className={`inline-block rounded-md px-2 py-1 text-[11px] font-semibold ${meta.cls}`}>{meta.label}</span>
                  </td>
                  <td className="px-5 py-3.5">
                    <div className="flex flex-col leading-[1.35]">
                      <b className="font-semibold">{a.stockName}</b>
                      <small className="text-xs text-muted">{a.stockCode} · {marketInfo.label}</small>
                    </div>
                  </td>
                  <td className="px-5 py-3.5 text-xs tabular-nums text-muted">{fmtDateTime(a.createdAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {scope === "user" && <div className="flex items-center justify-between gap-3 border-t border-edge px-4 py-3 text-xs text-muted"><span>{rows.length ? `${(Math.min(page, totalPages) - 1) * pageSize + 1}-${Math.min(page, totalPages) * pageSize > rows.length ? rows.length : Math.min(page, totalPages) * pageSize} / ${rows.length}` : "暂无记录"}</span><div className="flex gap-2"><button type="button" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))} className="rounded-lg border border-edge px-3 py-1.5 disabled:opacity-40">上一页</button><button type="button" disabled={page >= totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))} className="rounded-lg border border-edge px-3 py-1.5 disabled:opacity-40">下一页</button></div></div>}
      {userRows.length === 0 && <div className="py-12 text-center text-sm text-faint">没有符合条件的日志</div>}
      </>}
    </div>
  );
}
