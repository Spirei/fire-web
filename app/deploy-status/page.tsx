"use client";

import { useCallback, useEffect, useState } from "react";

type Run = {
  id: number;
  name: string;
  title: string;
  sha: string;
  status: string;
  conclusion: string | null;
  event: string;
  startedAt: string;
  updatedAt: string;
  url: string;
};

function stateOf(run: Run) {
  if (run.status !== "completed") return { label: "待发布", className: "bg-slate-400", ring: "ring-slate-400/15" };
  if (run.conclusion === "success") return { label: "成功", className: "bg-emerald-400", ring: "ring-emerald-400/15" };
  return { label: "失败", className: "bg-red-400", ring: "ring-red-400/15" };
}

const formatTime = (value: string) => new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));

export default function DeployStatusPage() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [repository, setRepository] = useState("your-github-name/fire-web");
  const [checkedAt, setCheckedAt] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/deploy-status", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "读取失败");
      setRuns(data.runs || []); setRepository(data.repository); setCheckedAt(data.checkedAt); setError("");
    } catch (err) { setError(err instanceof Error ? err.message : "暂时无法读取发布状态"); }
  }, []);
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 60000); return () => window.clearInterval(timer); }, [load]);
  const latest = runs[0];
  const latestState = latest ? stateOf(latest) : { label: "待发布", className: "bg-slate-400", ring: "ring-slate-400/15" };
  return (
    <main className="min-h-screen bg-[#0b0f16] px-5 py-10 text-slate-100 sm:px-8">
      <div className="mx-auto max-w-3xl">
        <div className="mb-8 flex items-start justify-between gap-4">
          <div><p className="mb-2 text-xs uppercase tracking-[.22em] text-slate-500">Fire deployment</p><h1 className="text-2xl font-semibold tracking-tight">本地 → 线上发布状态</h1><p className="mt-2 text-sm text-slate-400">源码以 main 为唯一来源，每日 00:00 自动发布，也可在 GitHub 手动运行。</p></div>
          <button onClick={() => void load()} className="rounded-xl border border-slate-700 px-3 py-2 text-xs text-slate-300 transition hover:border-slate-500">刷新</button>
        </div>
        <section className="mb-6 rounded-2xl border border-slate-800 bg-[#121923] p-5">
          <div className="flex items-center gap-3"><span className={`h-3 w-3 rounded-full ${latestState.className} ring-8 ${latestState.ring}`} /><div><p className="text-lg font-medium">最新发布：{latestState.label}</p><p className="mt-1 text-xs text-slate-500">{latest ? `${latest.sha} · ${formatTime(latest.updatedAt)}` : "等待读取 GitHub Actions"}</p></div></div>
          {error && <p className="mt-4 rounded-xl bg-red-400/10 px-3 py-2 text-xs text-red-300">{error}</p>}
        </section>
        <section className="overflow-hidden rounded-2xl border border-slate-800 bg-[#121923]">
          <div className="border-b border-slate-800 px-5 py-4"><h2 className="text-sm font-medium">最近运行</h2><p className="mt-1 text-xs text-slate-500">{repository}{checkedAt ? ` · 检查于 ${formatTime(checkedAt)}` : ""}</p></div>
          <div className="divide-y divide-slate-800">{runs.map((run) => { const state = stateOf(run); return <a key={run.id} href={run.url} target="_blank" rel="noreferrer" className="flex items-center gap-3 px-5 py-4 transition hover:bg-white/[.03]"><span className={`h-2.5 w-2.5 shrink-0 rounded-full ${state.className}`} /><span className="min-w-0 flex-1"><span className="block truncate text-sm text-slate-200">{run.title}</span><span className="mt-1 block text-xs text-slate-500">{run.sha} · {run.event === "schedule" ? "定时发布" : run.event === "workflow_dispatch" ? "手动发布" : "提交检查"} · {formatTime(run.updatedAt)}</span></span><span className="text-xs text-slate-500">{state.label}</span></a>; })}</div>
          {!runs.length && !error && <p className="px-5 py-10 text-center text-sm text-slate-500">暂无运行记录</p>}
        </section>
        <p className="mt-5 text-xs leading-5 text-slate-500">绿色 = 构建并发布成功　灰色 = 排队/进行中，尚未完成　红色 = 构建或发布失败</p>
      </div>
    </main>
  );
}
