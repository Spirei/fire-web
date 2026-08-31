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
const RUNS_PER_PAGE = 10;
type ContainerUpdateState = "idle" | "triggering" | "watching" | "restarting" | "healthy" | "unchanged" | "failed";

const sleep = (milliseconds: number) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

export default function DeployStatusPage() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [page, setPage] = useState(1);
  const [repository, setRepository] = useState("owner/repository");
  const [checkedAt, setCheckedAt] = useState("");
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [triggering, setTriggering] = useState(false);
  const [containerUpdateState, setContainerUpdateState] = useState<ContainerUpdateState>("idle");
  const [updaterAvailable, setUpdaterAvailable] = useState(false);
  const [notice, setNotice] = useState("");
  const [config, setConfig] = useState({ repository: "", hasToken: false, githubAccount: "" });
  const [configOpen, setConfigOpen] = useState(false);
  const [token, setToken] = useState("");
  const [configError, setConfigError] = useState("");
  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const response = await fetch("/api/deploy-status", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "读取失败");
      setRuns(data.runs || []); setRepository(data.repository); setCheckedAt(data.checkedAt); setError("");
    } catch (err) { setError(err instanceof Error ? err.message : "暂时无法读取发布状态"); }
    finally { setRefreshing(false); }
  }, []);
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 60000); return () => window.clearInterval(timer); }, [load]);
  useEffect(() => { fetch("/api/deploy-status/config").then(async (response) => response.ok ? setConfig(await response.json()) : null).catch(() => {}); }, []);
  useEffect(() => { fetch("/api/deploy-status/container-update", { cache: "no-store" }).then(async (response) => response.ok ? setUpdaterAvailable(Boolean((await response.json()).available)) : null).catch(() => {}); }, []);
  const totalPages = Math.max(1, Math.ceil(runs.length / RUNS_PER_PAGE));
  const pagedRuns = runs.slice((page - 1) * RUNS_PER_PAGE, page * RUNS_PER_PAGE);
  useEffect(() => { if (page > totalPages) setPage(totalPages); }, [page, totalPages]);
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
    if (triggering || runs.some((run) => run.event === "workflow_dispatch" && run.status !== "completed")) return;
    setTriggering(true); setNotice(""); setError("");
    try {
      const response = await fetch("/api/deploy-status", { method: "POST" });
      const data = await response.json();
      if (response.status === 409) { setNotice(data.error || "已有 Push image 正在运行"); void load(); return; }
      if (!response.ok) throw new Error(data.error || "触发失败");
      setNotice("已触发 Push image，GitHub 正在生成并推送 GHCR 镜像");
      window.setTimeout(() => void load(), 4000);
    } catch (err) { setError(err instanceof Error ? err.message : "触发失败"); }
    finally { setTriggering(false); }
  };
  const updateContainer = async () => {
    if (containerUpdateState === "triggering" || containerUpdateState === "watching" || containerUpdateState === "restarting") return;
    setContainerUpdateState("triggering"); setNotice(""); setError("");
    try {
      const response = await fetch("/api/deploy-status/container-update", { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "无法触发群晖更新");
      setContainerUpdateState("watching");
      setNotice(data.message || "已通知群晖拉取最新镜像");
      let sawRestart = false;
      for (let attempt = 0; attempt < 18; attempt += 1) {
        await sleep(2000);
        try {
          const health = await fetch(`/api/health?deployCheck=${Date.now()}`, { cache: "no-store" });
          if (!health.ok) throw new Error("unhealthy");
          if (sawRestart) {
            setContainerUpdateState("healthy");
            setNotice("群晖容器已完成重启，并恢复健康");
            void load();
            return;
          }
        } catch {
          sawRestart = true;
          setContainerUpdateState("restarting");
          setNotice("检测到 Fire 正在重启，正在等待健康恢复…");
        }
      }
      setContainerUpdateState(sawRestart ? "failed" : "unchanged");
      if (sawRestart) setError("容器重启后尚未恢复，请查看 fire 与 fire-updater 日志");
      else setNotice("更新检查完成，未检测到重启；当前镜像可能已是最新版本");
    } catch (err) {
      setContainerUpdateState("failed");
      setError(err instanceof Error ? err.message : "无法触发群晖更新");
    }
  };
  const containerBusy = containerUpdateState === "triggering" || containerUpdateState === "watching" || containerUpdateState === "restarting";
  const containerButtonLabel = containerUpdateState === "triggering" ? "正在通知…" : containerUpdateState === "watching" ? "等待重启…" : containerUpdateState === "restarting" ? "健康恢复中…" : containerUpdateState === "healthy" ? "容器已更新" : containerUpdateState === "unchanged" ? "已是最新" : "更新群晖";
  const manualPublishActive = runs.some((run) => run.event === "workflow_dispatch" && run.status !== "completed");
  const publishBusy = triggering || manualPublishActive;
  const publishLabel = manualPublishActive ? "镜像生成中…" : triggering ? "正在触发…" : "Push image";
  const publishTitle = manualPublishActive ? "已有 Push image 正在运行" : triggering ? "正在触发镜像构建" : "生成并推送 GHCR 镜像";
  const latest = runs.find((run) => run.event === "schedule" || run.event === "workflow_dispatch");
  const latestState = latest ? stateOf(latest) : { label: "待发布", className: "bg-slate-400", ring: "ring-slate-400/15" };
  return (
    <main className="min-h-[100dvh] bg-slate-50 px-4 py-6 text-slate-900 dark:bg-[#0b0f16] dark:text-slate-100 sm:px-8 sm:py-10">
      <style jsx>{`button[aria-label="刷新中"] svg { animation: deploy-refresh-spin .9s cubic-bezier(.45,.05,.55,.95) infinite; } main section button, main section a { transition-timing-function: cubic-bezier(.22,1,.36,1); } main section button:active, main section a:active { transform: translateY(1px) scale(.985); } @keyframes deploy-refresh-spin { to { transform: rotate(360deg); } }`}</style>
      <div className="mx-auto max-w-3xl">
        <div className="mb-7 sm:mb-8 sm:flex sm:items-start sm:justify-between sm:gap-6">
          <div className="min-w-0"><p className="mb-2 hidden text-xs uppercase tracking-[.22em] text-slate-500 sm:block">Fire deployment</p><h1 className="text-xl font-semibold leading-tight tracking-tight sm:text-2xl"><span className="sm:hidden">发布状态</span><span className="hidden sm:inline">本地到线上发布状态</span></h1><p className="mt-1.5 max-w-[30rem] text-[13px] leading-5 text-slate-500 sm:mt-2 sm:text-sm dark:text-slate-400"><span className="sm:hidden">每日 00:00 自动生成镜像，也可手动 Push image。</span><span className="hidden sm:inline">源码以 main 为唯一来源，每日 00:00 自动生成镜像，也可手动 Push image。</span></p></div>
          <div className="mt-4 flex w-full items-center justify-between gap-2 sm:mt-0 sm:w-auto sm:justify-end"><ThemeToggle /><button onClick={() => void load()} title={refreshing ? "刷新中" : "刷新状态"} aria-label={refreshing ? "刷新中" : "刷新状态"} disabled={refreshing} className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-slate-300 text-slate-700 transition hover:border-slate-400 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:border-slate-500 dark:hover:bg-white/[.04]"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`}><path d="M20 11a8 8 0 1 0 1 4"/><path d="M20 4v7h-7"/></svg></button><a href="/api/deploy-status/github/start" title="使用 GitHub 授权" aria-label="使用 GitHub 授权" className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-slate-300 text-slate-800 transition hover:border-slate-400 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:border-slate-500 dark:hover:bg-white/[.04]"><svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4" aria-hidden="true"><path d="M12 .7a11.3 11.3 0 0 0-3.58 22.02c.57.1.78-.25.78-.55v-2.13c-3.17.69-3.84-1.34-3.84-1.34-.52-1.31-1.27-1.66-1.27-1.66-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.75 2.68 1.25 3.33.96.1-.74.4-1.25.73-1.54-2.53-.29-5.2-1.27-5.2-5.66 0-1.25.45-2.27 1.18-3.07-.12-.29-.51-1.45.11-3.03 0 0 .96-.31 3.13 1.17a10.8 10.8 0 0 1 5.7 0c2.17-1.48 3.13-1.17 3.13-1.17.62 1.58.23 2.74.11 3.03.73.8 1.18 1.82 1.18 3.07 0 4.4-2.68 5.36-5.22 5.65.41.36.78 1.08.78 2.18v3.23c0 .3.2.66.79.55A11.3 11.3 0 0 0 12 .7Z"/></svg></a><button onClick={() => setConfigOpen((value) => !value)} title="配置账号" aria-label="配置账号" className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-slate-300 text-slate-700 transition hover:border-slate-400 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:border-slate-500 dark:hover:bg-white/[.04]"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true"><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="2"/><circle cx="15" cy="17" r="2"/></svg></button><button onClick={() => void triggerPublish()} disabled={publishBusy} title={publishTitle} aria-label={publishTitle} className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-blue-500 text-white transition hover:bg-blue-400 disabled:cursor-wait disabled:opacity-60 dark:bg-blue-400 dark:text-slate-950"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={`h-4 w-4 ${publishBusy ? "animate-pulse" : ""}`} aria-hidden="true"><path d="M12 16V4m0 0-4 4m4-4 4 4"/><path d="M5 14v5h14v-5"/></svg></button></div>
        </div>
        {configOpen && <section className="mb-6 rounded-2xl border border-blue-200 bg-white dark:border-blue-400/30 dark:bg-[#121923] p-5"><h2 className="text-sm font-medium text-slate-900 dark:text-slate-100">GitHub 发布配置</h2><p className="mt-1 text-xs text-slate-500">仅管理员可保存；OAuth 优先，手动 Token 作为兜底，密钥不会回显到网页。</p><div className="mt-4 grid gap-3 sm:grid-cols-2"><label className="text-xs text-slate-600 dark:text-slate-400">仓库（账号/仓库名）<input value={config.repository} onChange={(event) => setConfig({ ...config, repository: event.target.value })} className="mt-2 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-950/40 dark:text-slate-200 outline-none focus:border-blue-400" placeholder="owner/repository" /></label><label className="text-xs text-slate-400">发布 Token{config.hasToken ? "（已配置，留空保持）" : ""}<input value={token} onChange={(event) => setToken(event.target.value)} type="password" autoComplete="new-password" className="mt-2 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-400 dark:border-slate-700 dark:bg-slate-950/40 dark:text-slate-200" placeholder="Actions: Read and write" /></label></div><div className="mt-4 flex flex-wrap items-center gap-3"><a href="/api/deploy-status/github/start" className="rounded-lg bg-slate-900 px-3 py-2 text-xs font-medium text-white transition hover:bg-slate-700 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200">{config.githubAccount ? `已授权：${config.githubAccount}` : "使用 GitHub 授权"}</a>{config.githubAccount && <button onClick={async () => { await fetch("/api/deploy-status/config", { method: "DELETE" }); setConfig({ ...config, githubAccount: "" }); }} className="text-xs text-red-600 dark:text-red-300">撤销授权</button>}</div>{configError && <p className="mt-3 text-xs text-red-300">{configError}</p>}<div className="mt-4 flex justify-end gap-2"><button onClick={() => setConfigOpen(false)} className="rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-600 dark:border-slate-700 dark:text-slate-400">取消</button><button onClick={() => void saveConfig()} className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-medium text-white transition hover:bg-blue-500 active:scale-[.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200">保存配置</button></div></section>}
        <section className="mb-6 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-[#121923] dark:shadow-none sm:p-5"><h2 className="mb-4 text-sm font-medium">发布流程</h2><div className="grid grid-cols-2 gap-2 text-xs sm:flex sm:flex-wrap sm:items-center"><a href={`https://github.com/${repository}`} target="_blank" rel="noreferrer" className="w-full whitespace-nowrap rounded-lg border border-slate-300 px-3 py-2 text-center text-slate-700 transition hover:border-slate-500 hover:bg-slate-50 sm:w-auto dark:border-slate-700 dark:text-slate-300 dark:hover:bg-white/[.04]">本地 main ↗</a><span className="hidden text-slate-400 sm:inline dark:text-slate-600">→</span><button onClick={() => void load()} className="w-full whitespace-nowrap rounded-lg border border-slate-300 px-3 py-2 text-slate-700 transition hover:border-slate-500 hover:bg-slate-50 sm:w-auto dark:border-slate-700 dark:text-slate-300 dark:hover:bg-white/[.04]">安全 / 类型检查</button><span className="hidden text-slate-400 sm:inline dark:text-slate-600">→</span><button onClick={() => void triggerPublish()} disabled={publishBusy} title={publishTitle} className="w-full whitespace-nowrap rounded-lg border border-blue-300 bg-blue-50 px-3 py-2 font-medium text-blue-700 transition hover:bg-blue-100 disabled:cursor-wait disabled:opacity-60 sm:w-auto dark:border-blue-400/40 dark:bg-blue-400/10 dark:text-blue-200 dark:hover:bg-blue-400/20">{publishLabel}</button><span className="hidden text-slate-400 sm:inline dark:text-slate-600">→</span><a href={`https://github.com/${repository}/pkgs/container/fire-web`} target="_blank" rel="noreferrer" className="w-full whitespace-nowrap rounded-lg border border-slate-300 px-3 py-2 text-center text-slate-700 transition hover:border-slate-500 hover:bg-slate-50 sm:w-auto dark:border-slate-700 dark:text-slate-300 dark:hover:bg-white/[.04]">查看 GHCR ↗</a><span className="hidden text-slate-400 sm:inline dark:text-slate-600">→</span><button onClick={() => void updateContainer()} disabled={!updaterAvailable || containerBusy} title={updaterAvailable ? "拉取最新 GHCR 镜像并重启 Fire" : "群晖尚未配置 Watchtower Token"} className="w-full whitespace-nowrap rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-amber-700 transition hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-45 sm:w-auto dark:border-amber-400/40 dark:bg-amber-400/10 dark:text-amber-200 dark:hover:bg-amber-400/20">{containerButtonLabel}</button><span className="hidden text-slate-400 sm:inline dark:text-slate-600">→</span><a href="/" target="_blank" rel="noreferrer" className="w-full whitespace-nowrap rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-center text-emerald-700 transition hover:bg-emerald-100 sm:w-auto dark:border-emerald-400/40 dark:bg-emerald-400/10 dark:text-emerald-200 dark:hover:bg-emerald-400/20">线上容器 ↗</a></div><p className="mt-3 text-xs leading-5 text-slate-500">Push image 生成并推送 GHCR 镜像；“更新群晖”负责拉取镜像并重启 Fire。Compose 配置变化仍需手动执行 compose up。</p></section>
        <section className="mb-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-[#121923] dark:shadow-none">
          <div><div className="flex items-center gap-2.5"><span className={`h-3 w-3 shrink-0 rounded-full ${latestState.className} ring-4 ${latestState.ring} ${latest && latest.status !== "completed" ? "animate-pulse" : ""}`} /><p className="text-lg font-medium">最新发布 <span className="text-slate-400">·</span> {latestState.label}</p></div><p className="mt-1.5 pl-[22px] text-xs text-slate-500">{latest ? `${latest.sha} · ${formatTime(latest.updatedAt)}` : "等待读取 GitHub Actions"}</p></div>
          {error && <p className="mt-4 rounded-xl bg-red-400/10 px-3 py-2 text-xs text-red-300">{error}</p>}
          {notice && <p className="mt-4 rounded-xl bg-emerald-400/10 px-3 py-2 text-xs text-emerald-300">{notice}</p>}
        </section>
        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-[#121923] dark:shadow-none">
          <div className="border-b border-slate-200 px-5 py-4 dark:border-slate-800"><h2 className="text-sm font-medium">最近运行</h2><p className="mt-1 text-xs text-slate-500">{repository}{checkedAt ? ` · 检查于 ${formatTime(checkedAt)}` : ""}</p></div>
          <div className="divide-y divide-slate-200 dark:divide-slate-800">{pagedRuns.map((run) => { const state = stateOf(run); return <a key={run.id} href={run.url} target="_blank" rel="noreferrer" className="flex items-center gap-3 px-5 py-4 transition hover:bg-slate-50 dark:hover:bg-white/[.03]"><span className={`h-2.5 w-2.5 shrink-0 rounded-full ${state.className}`} /><span className="min-w-0 flex-1"><span className="block truncate text-sm text-slate-800 dark:text-slate-200">{run.title}</span><span className="mt-1 block text-xs text-slate-500">{run.sha} · {run.event === "schedule" ? "定时构建" : run.event === "workflow_dispatch" ? "Push image" : "提交检查"} · {formatTime(run.updatedAt)}</span></span><span className="text-xs text-slate-500">{state.label}</span></a>; })}</div>
          {!runs.length && !error && <p className="px-5 py-10 text-center text-sm text-slate-500">暂无运行记录</p>}
          {runs.length > RUNS_PER_PAGE && <div className="flex items-center justify-between border-t border-slate-200 px-5 py-3 text-xs text-slate-500 dark:border-slate-800"><span>第 {page} / {totalPages} 页 · 共 {runs.length} 条</span><div className="flex gap-2"><button onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={page === 1} className="rounded-lg border border-slate-300 px-3 py-1.5 text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-35 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-white/[.04]">上一页</button><button onClick={() => setPage((value) => Math.min(totalPages, value + 1))} disabled={page === totalPages} className="rounded-lg border border-slate-300 px-3 py-1.5 text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-35 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-white/[.04]">下一页</button></div></div>}
        </section>
        <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-3 text-xs text-slate-500"><span className="inline-flex items-center gap-2"><i className="h-2.5 w-2.5 rounded-full bg-emerald-400 ring-4 ring-emerald-400/15" />发布成功</span><span className="inline-flex items-center gap-2"><i className="h-2.5 w-2.5 animate-pulse rounded-full bg-slate-400 ring-4 ring-slate-400/15" />排队 / 进行中</span><span className="inline-flex items-center gap-2"><i className="h-2.5 w-2.5 rounded-full bg-red-400 ring-4 ring-red-400/15" />构建 / 发布失败</span></div>
      </div>
    </main>
  );
}
