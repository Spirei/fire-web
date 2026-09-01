"use client";

import { useMemo, useState } from "react";

import { fmtDateTime } from "@/lib/format";
import { marketMeta, type Activity, type SystemLog } from "@/lib/types";

interface Props {
  activities: Activity[];
  systemLogs?: SystemLog[];
  isAdmin?: boolean;
}

const ACTION_META: Record<Activity["action"], { label: string; cls: string }> = {
  created: { label: "新增", cls: "bg-brand-light text-brand-deep" },
  updated: { label: "修改", cls: "bg-[#fff4e5] text-[#b06a00]" },
  deleted: { label: "删除", cls: "bg-up-bg text-up" }
};

export default function ActivitiesView({ activities, systemLogs = [], isAdmin = false }: Props) {
  const [scope, setScope] = useState<"user" | "system">("user");
  const [systemFilter, setSystemFilter] = useState("all");
  const [query, setQuery] = useState("");
  const visibleActivities = activities.filter((a) => `${a.stockName} ${a.stockCode} ${a.userName}`.toLowerCase().includes(query.toLowerCase()));
  const visibleSystemLogs = systemLogs.filter((log) => `${log.event} ${log.detail} ${log.userName} ${log.ip}`.toLowerCase().includes(query.toLowerCase()) && (systemFilter === "all" || log.event.split(/[.:/]/)[0] === systemFilter));
  const [filter, setFilter] = useState<Activity["action"] | "all">("all");
  const filteredActivities = useMemo(
    () => filter === "all" ? activities : activities.filter((activity) => activity.action === filter),
    [activities, filter]
  );
  if (scope === "user" && activities.length === 0) {
    return (
      <div className="card py-20 text-center text-sm text-faint shadow-card">
        暂无日志，添加、修改或删除股票后会记录在这里。
      </div>
    );
  }

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-edge px-4 py-3">
        <div className="inline-flex rounded-lg border border-edge bg-bg-gray p-1">{(["user", "system"] as const).map((key) => <button key={key} type="button" onClick={() => setScope(key)} className={`rounded-md px-3 py-1.5 text-sm font-semibold transition ${scope === key ? "bg-white text-ink shadow-sm dark:bg-[#252d3a] dark:text-white" : "text-muted"}`}>{key === "user" ? `用户日志 ${activities.length}` : `系统日志 ${systemLogs.length}`}</button>)}</div>
        <input value={query} onChange={(e) => setQuery(e.target.value)} aria-label="搜索日志" placeholder="搜索日志…" className="h-9 w-full rounded-lg border border-edge bg-transparent px-3 text-sm outline-none placeholder:text-faint focus:border-brand sm:w-64" />
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-edge px-4 py-2.5 text-xs text-muted"><span>用户事件 <b className="ml-1 text-ink dark:text-white">{activities.length}</b></span><span>系统事件 <b className="ml-1 text-ink dark:text-white">{systemLogs.length}</b></span><span>今日活动 <b className="ml-1 text-ink dark:text-white">{activities.filter((a) => a.createdAt.slice(0, 10) === new Date().toISOString().slice(0, 10)).length}</b></span><span>当前显示 <b className="ml-1 text-ink dark:text-white">{scope === "user" ? visibleActivities.length : visibleSystemLogs.length}</b></span></div>
      {scope === "system" && !isAdmin && <div className="p-8 text-center text-sm text-faint">系统日志仅管理员可见</div>}
      {scope === "system" && isAdmin && <>
        <div className="flex flex-wrap items-center gap-2 border-b border-edge px-4 py-3"><span className="mr-1 text-xs font-semibold text-muted">系统模块</span>{["all", ...Array.from(new Set(systemLogs.map((log) => log.event.split(/[.:/]/)[0]).filter(Boolean))).slice(0, 8)].map((key) => <button key={key} type="button" onClick={() => setSystemFilter(key)} aria-pressed={systemFilter === key} className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${systemFilter === key ? "border-brand bg-brand-light text-brand-deep" : "border-edge text-muted"}`}>{key === "all" ? "全部" : key}</button>)}</div>
        <div className="data-table-scroll"><table className="w-full min-w-[700px] text-sm"><thead><tr className="bg-bg-gray text-xs font-semibold text-muted"><th className="px-4 py-3 text-left">级别</th><th className="px-4 py-3 text-left">模块 / 事件</th><th className="px-4 py-3 text-left">详情</th><th className="px-4 py-3 text-left">用户 / IP</th><th className="px-4 py-3 text-left">时间</th></tr></thead><tbody>{visibleSystemLogs.map((log) => <tr key={log.id} className="border-t border-edge"><td className="px-4 py-3"><span className="rounded-full bg-slate-100 px-2 py-1 text-xs text-slate-600">审计</span></td><td className="px-4 py-3 font-semibold">{log.event}</td><td className="max-w-[320px] px-4 py-3 text-xs text-muted"><details><summary className="cursor-pointer truncate">{log.detail || "查看详情"}</summary><p className="mt-2 whitespace-pre-wrap break-words text-xs">{log.detail || "—"}</p></details></td><td className="px-4 py-3 text-xs text-muted">{log.userName}<br />{log.ip || "—"}</td><td className="whitespace-nowrap px-4 py-3 text-xs text-muted">{fmtDateTime(log.createdAt)}</td></tr>)}</tbody></table>{visibleSystemLogs.length === 0 && <div className="py-12 text-center text-sm text-faint">该模块暂无日志</div>}</div>
      </>}
      {scope === "system" ? null : <>
      <div className="flex flex-wrap items-center gap-2 border-b border-edge px-4 py-3">
        <span className="mr-1 text-xs font-semibold text-muted">操作分类</span>
        {(["all", "created", "updated", "deleted"] as const).map((key) => {
          const count = key === "all" ? activities.length : activities.filter((activity) => activity.action === key).length;
          const label = key === "all" ? "全部" : ACTION_META[key].label;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setFilter(key)}
              aria-pressed={filter === key}
              className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${filter === key ? "border-brand bg-brand-light text-brand-deep" : "border-edge text-muted hover:border-brand/50 hover:text-ink"}`}
            >
              {label} <span className="ml-1 text-[10px] opacity-70">{count}</span>
            </button>
          );
        })}
      </div>
      <div className="data-table-scroll">
        <table className="mobile-activities-table w-full min-w-[620px] text-sm">
          <thead>
            <tr className="whitespace-nowrap bg-bg-gray text-xs font-semibold text-muted">
              <th className="px-4 py-[13px] text-left">用户</th>
              <th className="px-4 py-[13px] text-left">操作</th>
              <th className="px-4 py-[13px] text-left">股票</th>
              <th className="px-4 py-[13px] text-left">操作时间</th>
            </tr>
          </thead>
          <tbody>
            {visibleActivities.filter((a) => filter === "all" || a.action === filter).map((a) => {
              const meta = ACTION_META[a.action];
              const market = a.market || "OTHER";
              const marketInfo = marketMeta(market);
              const displayName = a.userName || "?";
              return (
                <tr key={a.id} className="whitespace-nowrap border-t border-edge transition-colors hover:bg-[#fafbfc] dark:hover:bg-[#1a212e]">
                  <td className="px-4 py-3.5">
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
                  <td className="px-4 py-3.5">
                    <span className={`inline-block rounded-full px-2.5 py-[3px] text-xs font-semibold ${meta.cls}`}>{meta.label}</span>
                  </td>
                  <td className="px-4 py-3.5">
                    <div className="flex flex-col leading-[1.35]">
                      <b className="font-semibold">{a.stockName}</b>
                      <small className="text-xs text-muted">{a.stockCode} · {marketInfo.label}</small>
                    </div>
                  </td>
                  <td className="px-4 py-3.5 text-xs text-muted">{fmtDateTime(a.createdAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {filteredActivities.length === 0 && <div className="py-12 text-center text-sm text-faint">该分类暂无日志</div>}
      </>}
    </div>
  );
}
