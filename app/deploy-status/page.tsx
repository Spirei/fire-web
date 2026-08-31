"use client";

import { useCallback, useEffect, useState } from "react";
import ThemeToggle from "@/components/ThemeToggle";

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
  const [repository, setRepository] = useState("owner/repository");
  const [checkedAt, setCheckedAt] = useState("");
  const [error, setError] = useState("");
  const [triggering, setTriggering] = useState(false);
  const [notice, setNotice] = useState("");
  const [config, setConfig] = useState({ repository: "", hasToken: false, githubAccount: "" });
  const [configOpen, setConfigOpen] = useState(false);
  const [token, setToken] = useState("");
  const [configError, setConfigError] = useState("");
  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/deploy-status", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "读取失败");
      setRuns(data.runs || []); setRepository(data.repository); setCheckedAt(data.checkedAt); setError("");
    } catch (err) { setError(err instanceof Error ? err.message : "暂时无法读取发布状态"); }
  }, []);
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 60000); return () => window.clearInterval(timer); }, [load]);
  useEffect(() => { fetch("/api/deploy-status/config").then(async (response) => response.ok ? setConfig(await response.json()) : null).catch(() => {}); }, []);
  const saveConfig = async () => {
    setConfigError("");
    try {
      const response = await fetch("/api/deploy-status/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ repository: config.repository, token }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "保存失败");
      setConfig(data); setToken(""); setConfigOpen(false); setNotice("发布配置已保存，Token 仅保存在服务端");
    } catch (err) { setConfigError(err instanceof Error ? err.message : "保存失败"); }
  };
  const triggerPublish = async () => {
    if (triggering) return;
    setTriggering(true); setNotice(""); setError("");
    try {
      const response = await fetch("/api/deploy-status", { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "触发失败");
      setNotice("已触发手动发布，状态将在几秒后出现");
      window.setTimeout(() => void load(), 4000);
    } catch (err) { setError(err instanceof Error ? err.message : "触发失败"); }
    finally { setTriggering(false); }
  };
  const latest = runs[0];
  const latestState = latest ? stateOf(latest) : { label: "待发布", className: "bg-slate-400", ring: "ring-slate-400/15" };
  return (
    <main className="min-h-screen bg-[#0b0f16] px-5 py-10 text-slate-100 sm:px-8">
      <div className="mx-auto max-w-3xl">
        <div className="mb-8 flex items-start justify-between gap-4">
          <div><p className="mb-2 text-xs uppercase tracking-[.22em] text-slate-500">Fire deployment</p><h1 className="text-2xl font-semibold tracking-tight">本地 → 线上发布状态</h1><p className="mt-2 text-sm text-slate-400">源码以 main 为唯一来源，每日 00:00 自动发布，也可在 GitHub 手动运行。</p></div>
          <div className="flex items-center gap-2"><ThemeToggle /><button onClick={() => void load()} className="rounded-xl border border-slate-700 px-3 py-2 text-xs text-slate-300 transition hover:border-slate-500">刷新</button><button onClick={() => setConfigOpen((value) => !value)} className="rounded-xl border border-slate-700 px-3 py-2 text-xs text-slate-300 transition hover:border-slate-500">配置账号</button><button onClick={() => void triggerPublish()} disabled={triggering} className="rounded-xl bg-blue-400 px-3 py-2 text-xs font-medium text-slate-950 transition hover:bg-blue-300 disabled:cursor-wait disabled:opacity-60">{triggering ? "触发中…" : "立即手动推送"}</button></div>
        </div>
        {configOpen && <section className="mb-6 rounded-2xl border border-blue-400/30 bg-[#121923] p-5"><h2 className="text-sm font-medium">GitHub 发布配置</h2><p className="mt-1 text-xs text-slate-500">仅管理员可保存；OAuth 优先，手动 Token 作为兜底，密钥不会回显到网页。</p><div className="mt-4 grid gap-3 sm:grid-cols-2"><label className="text-xs text-slate-400">仓库（账号/仓库名）<input value={config.repository} onChange={(event) => setConfig({ ...config, repository: event.target.value })} className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950/40 px-3 py-2 text-sm text-slate-200 outline-none focus:border-blue-400" placeholder="owner/repository" /></label><label className="text-xs text-slate-400">备用 Token{config.hasToken ? "（已配置，留空保持）" : ""}<input value={token} onChange={(event) => setToken(event.target.value)} type="password" autoComplete="new-password" className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950/40 px-3 py-2 text-sm text-slate-200 outline-none focus:border-blue-400" placeholder="只读 Actions Token" /></label></div><div className="mt-4 flex flex-wrap items-center gap-3"><a href="/api/deploy-status/github/start" className="rounded-lg bg-white px-3 py-2 text-xs font-medium text-slate-900">{config.githubAccount ? `已授权：${config.githubAccount}` : "使用 GitHub 授权"}</a>{config.githubAccount && <button onClick={async () => { await fetch("/api/deploy-status/config", { method: "DELETE" }); setConfig({ ...config, githubAccount: "" }); }} className="text-xs text-red-300">撤销授权</button>}</div>{configError && <p className="mt-3 text-xs text-red-300">{configError}</p>}<div className="mt-4 flex justify-end gap-2"><button onClick={() => setConfigOpen(false)} className="rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-400">取消</button><button onClick={() => void saveConfig()} className="rounded-lg bg-blue-400 px-3 py-2 text-xs font-medium text-slate-950">保存配置</button></div></section>}
        <section className="mb-6 rounded-2xl border border-slate-800 bg-[#121923] p-5"><h2 className="mb-4 text-sm font-medium">发布流程</h2><div className="flex flex-wrap items-center gap-2 text-xs"><span className="rounded-lg border border-slate-700 px-3 py-2 text-slate-300">本地 main</span><span className="text-slate-600">→</span><span className="rounded-lg border border-slate-700 px-3 py-2 text-slate-300">安全 / 类型检查</span><span className="text-slate-600">→</span><span className="rounded-lg border border-blue-400/40 bg-blue-400/10 px-3 py-2 text-blue-200">每日 00:00 或手动</span><span className="text-slate-600">→</span><span className="rounded-lg border border-slate-700 px-3 py-2 text-slate-300">构建 GHCR</span><span className="text-slate-600">→</span><span className="rounded-lg border border-emerald-400/40 bg-emerald-400/10 px-3 py-2 text-emerald-200">线上容器</span></div><p className="mt-3 text-xs text-slate-500">手动推送只发布 main 当前最新提交；提交本身不会自动打断线上版本。</p></section>
        <section className="mb-6 rounded-2xl border border-slate-800 bg-[#121923] p-5">
          <div className="flex items-center gap-3"><span className={`h-3 w-3 rounded-full ${latestState.className} ring-8 ${latestState.ring}`} /><div><p className="text-lg font-medium">最新发布：{latestState.label}</p><p className="mt-1 text-xs text-slate-500">{latest ? `${latest.sha} · ${formatTime(latest.updatedAt)}` : "等待读取 GitHub Actions"}</p></div></div>
          {error && <p className="mt-4 rounded-xl bg-red-400/10 px-3 py-2 text-xs text-red-300">{error}</p>}
          {notice && <p className="mt-4 rounded-xl bg-emerald-400/10 px-3 py-2 text-xs text-emerald-300">{notice}</p>}
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
