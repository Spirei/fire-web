"use client";

import { useMemo, useState } from "react";

import { fmtDateTime } from "@/lib/format";
import { marketMeta, type Activity } from "@/lib/types";

interface Props {
  activities: Activity[];
}

const ACTION_META: Record<Activity["action"], { label: string; cls: string }> = {
  created: { label: "新增", cls: "bg-brand-light text-brand-deep" },
  updated: { label: "修改", cls: "bg-[#fff4e5] text-[#b06a00]" },
  deleted: { label: "删除", cls: "bg-up-bg text-up" }
};

export default function ActivitiesView({ activities }: Props) {
  const [filter, setFilter] = useState<Activity["action"] | "all">("all");
  const filteredActivities = useMemo(
    () => filter === "all" ? activities : activities.filter((activity) => activity.action === filter),
    [activities, filter]
  );
  if (activities.length === 0) {
    return (
      <div className="card py-20 text-center text-sm text-faint shadow-card">
        暂无日志，添加、修改或删除股票后会记录在这里。
      </div>
    );
  }

  return (
    <div className="card overflow-hidden">
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
            {filteredActivities.map((a) => {
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
    </div>
  );
}
