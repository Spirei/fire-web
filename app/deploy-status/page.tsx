"use client";

import { useCallback, useEffect, useState } from "react";
import {
  IconAdjustmentsHorizontal,
  IconBrandGithub,
  IconChevronRight,
  IconCircleCheck,
  IconCircleX,
  IconClock,
  IconExternalLink,
  IconGitBranch,
  IconLoader2,
  IconPackage,
  IconPackageExport,
  IconRefresh,
  IconServerCog,
  IconShieldCheck
} from "@tabler/icons-react";
import ThemeToggle from "@/components/ThemeToggle";

type Run = {
  id: number;
  name: string;
  title: string;
  sha: string;
  status: string;
  conclusion: string | null;
  event: string;
  workflowPath: string;
  startedAt: string;
  updatedAt: string;
  url: string;
};

type BuildStep = {
  number: number;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
};

type BuildJob = {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  url: string;
  steps: BuildStep[];
};

type ImageProgress = {
  id: number;
  status: string;
  conclusion: string | null;
  sha: string;
  startedAt: string;
  updatedAt: string;
  url: string;
  jobs: BuildJob[];
};

type SourceVersion = { sha: string; shortSha: string; url: string };
type ImageVersion = {
  latestSuccessfulSha: string;
  latestSuccessfulShortSha: string;
  latestSuccessfulAt: string;
  latestSuccessfulUrl: string;
  matchesMain: boolean;
};
type RuntimeVersion = { sha: string; shortSha: string; matchesImage: boolean; matchesMain: boolean };

function stateOf(run: Run) {
  if (run.status !== "completed") return { label: "待发布", className: "bg-slate-400", ring: "ring-slate-400/15" };
  if (run.conclusion === "success") return { label: "成功", className: "bg-emerald-400", ring: "ring-emerald-400/15" };
  return { label: "失败", className: "bg-red-400", ring: "ring-red-400/15" };
}

const formatTime = (value: string) => new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
const formatDuration = (startedAt: string | null, completedAt: string | null, fallback: string) => {
  if (!startedAt) return "等待中";
  const end = new Date(completedAt || fallback).getTime();
  const seconds = Math.max(0, Math.round((end - new Date(startedAt).getTime()) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分 ${seconds % 60} 秒`;
};

function StatusIcon({ status, conclusion, size = 18 }: { status: string; conclusion: string | null; size?: number }) {
  if (status !== "completed") {
    if (status === "in_progress") return <IconLoader2 aria-hidden="true" className="motion-safe:animate-spin text-amber-500" size={size} stroke={2} />;
    return <IconClock aria-hidden="true" className="text-slate-400" size={size} stroke={1.8} />;
  }
  if (conclusion === "success") return <IconCircleCheck aria-hidden="true" className="text-emerald-500" size={size} stroke={2} />;
  if (conclusion === "skipped") return <IconClock aria-hidden="true" className="text-slate-400" size={size} stroke={1.8} />;
  return <IconCircleX aria-hidden="true" className="text-red-500" size={size} stroke={2} />;
}

const buildStatusLabel = (status: string, conclusion: string | null) => {
  if (status === "queued") return "等待中";
  if (status === "in_progress") return "构建中";
  if (conclusion === "success") return "已完成";
  if (conclusion === "skipped") return "已跳过";
  return "失败";
};
const RUNS_PER_PAGE = 5;
type ContainerUpdateState = "idle" | "triggering" | "watching" | "restarting" | "healthy" | "unchanged" | "failed";

const sleep = (milliseconds: number) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

export default function DeployStatusPage() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [imageProgress, setImageProgress] = useState<ImageProgress | null>(null);
  const [sourceVersion, setSourceVersion] = useState<SourceVersion | null>(null);
  const [imageVersion, setImageVersion] = useState<ImageVersion | null>(null);
  const [runtimeVersion, setRuntimeVersion] = useState<RuntimeVersion | null>(null);
  const [packageName, setPackageName] = useState("fire-web");
  const [page, setPage] = useState(1);
  const [repository, setRepository] = useState("owner/repository");
  const [checkedAt, setCheckedAt] = useState("");
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshTurns, setRefreshTurns] = useState(0);
  const [triggering, setTriggering] = useState(false);
  const [containerUpdateState, setContainerUpdateState] = useState<ContainerUpdateState>("idle");
  const [updaterAvailable, setUpdaterAvailable] = useState(false);
  const [updaterReason, setUpdaterReason] = useState("正在检查更新服务");
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
      if (data.repository) setRepository(data.repository);
      if (!response.ok) throw new Error(data.error || "读取失败");
      setRuns(data.runs || []);
      setImageProgress(data.imageProgress || null);
      setSourceVersion(data.source || null);
      setImageVersion(data.image || null);
      setRuntimeVersion(data.runtime || null);
      setPackageName(data.packageName || "fire-web");
      setCheckedAt(data.checkedAt);
      setError("");
    } catch (err) { setError(err instanceof Error ? err.message : "暂时无法读取发布状态"); }
    finally { setRefreshing(false); setHasLoaded(true); }
  }, []);
  const refreshInterval = imageProgress && imageProgress.status !== "completed" ? 10000 : 60000;
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), refreshInterval); return () => window.clearInterval(timer); }, [load, refreshInterval]);
  useEffect(() => { fetch("/api/deploy-status/config").then(async (response) => response.ok ? setConfig(await response.json()) : null).catch(() => {}); }, []);
  useEffect(() => { fetch("/api/deploy-status/container-update", { cache: "no-store" }).then(async (response) => { if (!response.ok) return; const data = await response.json(); setUpdaterAvailable(Boolean(data.available)); setUpdaterReason(data.reason || "更新服务不可用"); }).catch(() => setUpdaterReason("无法检查更新服务")); }, []);
  const totalPages = Math.max(1, Math.ceil(runs.length / RUNS_PER_PAGE));
  const pagedRuns = runs.slice((page - 1) * RUNS_PER_PAGE, page * RUNS_PER_PAGE);
  useEffect(() => { if (page > totalPages) setPage(totalPages); }, [page, totalPages]);
  const refreshNow = () => {
    if (refreshing) return;
    setRefreshTurns((value) => value + 1);
    void load();
  };
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
    if (triggering || runs.some((run) => run.workflowPath === ".github/workflows/docker-publish.yml" && run.event === "workflow_dispatch" && run.status !== "completed")) return;
    setTriggering(true); setNotice(""); setError("");
    try {
      const response = await fetch("/api/deploy-status", { method: "POST" });
      const data = await response.json();
      if (response.status === 409) { setNotice(data.error || "已有 Push image 正在运行"); void load(); return; }
      if (!response.ok) throw new Error(data.error || "触发失败");
      setNotice("已触发 Push image，GitHub 正在生成并推送 GHCR 镜像");
      window.setTimeout(() => void load(), 2000);
      window.setTimeout(() => void load(), 5000);
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
      const targetSha = imageVersion?.latestSuccessfulSha || "";
      let sawRestart = false;
      for (let attempt = 0; attempt < 18; attempt += 1) {
        await sleep(2000);
        try {
          const health = await fetch(`/api/health?deployCheck=${Date.now()}`, { cache: "no-store" });
          if (!health.ok) throw new Error("unhealthy");
          const healthPayload = await health.json() as { data?: { buildSha?: string } };
          const runningSha = healthPayload.data?.buildSha || "unknown";
          if (targetSha && runningSha === targetSha) {
            setContainerUpdateState("healthy");
            setNotice("群晖已运行目标镜像，版本校验通过");
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
      if (sawRestart) setError("容器恢复后版本仍未确认，请查看 fire 与 fire-updater 日志");
      else setNotice("更新请求已完成，但运行版本尚未变更");
    } catch (err) {
      setContainerUpdateState("failed");
      setError(err instanceof Error ? err.message : "无法触发群晖更新");
    }
  };
  const containerBusy = containerUpdateState === "triggering" || containerUpdateState === "watching" || containerUpdateState === "restarting";
  const containerButtonLabel = containerUpdateState === "triggering" ? "正在通知…" : containerUpdateState === "watching" ? "等待重启…" : containerUpdateState === "restarting" ? "健康恢复中…" : containerUpdateState === "healthy" ? "容器已更新" : containerUpdateState === "unchanged" ? "已是最新" : "更新群晖";
  const manualPublishActive = runs.some((run) => run.workflowPath === ".github/workflows/docker-publish.yml" && run.event === "workflow_dispatch" && run.status !== "completed");
  const publishBusy = triggering || manualPublishActive;
  const publishLabel = manualPublishActive ? "镜像生成中…" : triggering ? "正在触发…" : "Push image";
  const publishTitle = manualPublishActive ? "已有 Push image 正在运行" : triggering ? "正在触发镜像构建" : "生成并推送 GHCR 镜像";
  const latest = runs.find((run) => run.workflowPath === ".github/workflows/docker-publish.yml" && (run.event === "schedule" || run.event === "workflow_dispatch"));
  const latestMainCheck = runs.find((run) => run.workflowPath === ".github/workflows/docker-publish.yml" && run.event === "push" && run.sha === sourceVersion?.shortSha);
  const latestState = latest ? stateOf(latest) : { label: hasLoaded ? "未知" : "读取中", className: "bg-slate-400", ring: "ring-slate-400/15" };
  const finishedJobCount = imageProgress?.jobs.filter((job) => job.status === "completed").length || 0;
  const imageBuilding = Boolean(imageProgress && imageProgress.status !== "completed");
  const latestAttemptFailed = Boolean(imageProgress && imageProgress.status === "completed" && imageProgress.conclusion !== "success" && sourceVersion && imageProgress.sha === sourceVersion.shortSha);
  const sourceState = sourceVersion
    ? { label: `main ${sourceVersion.shortSha}`, dot: "bg-slate-400", text: "text-slate-600 dark:text-slate-300" }
    : { label: "main 未知", dot: "bg-slate-400", text: "text-slate-500" };
  const checkState = !latestMainCheck
    ? { label: "检查未知", dot: "bg-slate-400", text: "text-slate-500" }
    : latestMainCheck.status !== "completed"
      ? { label: "检查中", dot: "bg-amber-500 motion-safe:animate-pulse", text: "text-amber-700 dark:text-amber-300" }
      : latestMainCheck.conclusion === "success"
        ? { label: "检查通过", dot: "bg-emerald-500", text: "text-emerald-700 dark:text-emerald-300" }
        : { label: "检查失败", dot: "bg-red-500", text: "text-red-700 dark:text-red-300" };
  const imageState = imageBuilding
    ? { label: "镜像生成中", dot: "bg-amber-500 motion-safe:animate-pulse", text: "text-amber-700 dark:text-amber-300" }
    : latestAttemptFailed
      ? { label: "镜像构建失败", dot: "bg-red-500", text: "text-red-700 dark:text-red-300" }
      : imageVersion?.latestSuccessfulSha
        ? { label: "镜像已构建完成", dot: "bg-emerald-500", text: "text-emerald-700 dark:text-emerald-300" }
        : { label: "尚无镜像", dot: "bg-slate-400", text: "text-slate-500" };
  const runtimeState = runtimeVersion?.matchesMain
    ? { label: `线上 ${runtimeVersion.shortSha}`, dot: "bg-emerald-500", text: "text-emerald-700 dark:text-emerald-300" }
    : runtimeVersion?.sha && runtimeVersion.sha !== "unknown"
      ? { label: runtimeVersion.matchesImage ? `运行旧镜像 ${runtimeVersion.shortSha}` : `待更新 ${runtimeVersion.shortSha}`, dot: "bg-orange-500", text: "text-orange-700 dark:text-orange-300" }
      : { label: "线上版本未知", dot: "bg-slate-400", text: "text-slate-500" };
  const canUpdateContainer = updaterAvailable && Boolean(imageVersion?.matchesMain) && !runtimeVersion?.matchesImage && !imageBuilding;
  const runActionLabel = (run: Run) => {
    const imageRun = run.event === "workflow_dispatch" || run.event === "schedule";
    const prefix = imageRun ? "镜像构建" : "推送";
    if (run.status !== "completed") return `${prefix}中`;
    if (run.conclusion === "success") return `${prefix}成功`;
    if (run.conclusion === "skipped") return `${prefix}跳过`;
    return `${prefix}失败`;
  };
  return (
    <main className="min-h-[100dvh] bg-slate-50 px-4 py-6 text-slate-900 dark:bg-[#0b0f16] dark:text-slate-100 sm:px-8 sm:py-10">
      <style jsx>{`main section button, main section a { transition-timing-function: cubic-bezier(.22,1,.36,1); } main section button:active, main section a:active { transform: translateY(1px) scale(.985); }`}</style>
      <div className="mx-auto max-w-[720px]">
        <div className="mb-7 sm:mb-8 sm:flex sm:items-start sm:justify-between sm:gap-6">
          <div className="min-w-0"><p className="mb-2 hidden text-xs uppercase tracking-[.22em] text-slate-500 sm:block">Fire deployment</p><div className="flex flex-wrap items-center gap-2"><h1 className="text-xl font-semibold leading-tight tracking-tight sm:text-2xl"><span className="sm:hidden">发布状态</span><span className="hidden sm:inline">GitHub main 到线上发布状态</span></h1></div><p className="mt-1.5 max-w-[30rem] text-[13px] leading-5 text-slate-500 sm:mt-2 sm:text-sm dark:text-slate-400"><span className="sm:hidden">每日 00:00 自动生成镜像，也可手动 Push image。</span><span className="hidden sm:inline">GitHub main 是发布源，每日 00:00 自动生成镜像，也可手动 Push image。</span></p></div>
          <div className="mt-4 flex w-full items-center justify-between gap-2 sm:mt-0 sm:w-auto sm:justify-end">
            <ThemeToggle />
            <button onClick={refreshNow} title={refreshing ? "正在刷新" : "刷新状态"} aria-label={refreshing ? "正在刷新" : "刷新状态"} disabled={refreshing} className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-slate-300 text-slate-700 transition hover:border-slate-400 hover:bg-slate-100 disabled:cursor-wait dark:border-slate-700 dark:text-slate-300 dark:hover:border-slate-500 dark:hover:bg-white/[.04]">
              <IconRefresh aria-hidden="true" size={16} stroke={1.8} style={{ transform: `rotate(${refreshTurns * 360}deg)`, transition: "transform 720ms cubic-bezier(.22,.75,.2,1)" }} />
            </button>
            <a href="/api/deploy-status/github/start" target="_blank" rel="noreferrer" title="使用 GitHub 授权" aria-label="使用 GitHub 授权，新窗口打开" className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-slate-300 text-slate-800 transition hover:border-slate-400 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:border-slate-500 dark:hover:bg-white/[.04]"><IconBrandGithub aria-hidden="true" size={17} stroke={1.8} /></a>
            <a href={`https://github.com/${repository}/pkgs/container/${packageName}`} target="_blank" rel="noreferrer" title="查看 GHCR 镜像" aria-label="查看 GHCR 镜像，新窗口打开" className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-slate-300 text-slate-700 transition hover:border-slate-400 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:border-slate-500 dark:hover:bg-white/[.04]"><IconPackage aria-hidden="true" size={17} stroke={1.8} /></a>
            <button onClick={() => setConfigOpen((value) => !value)} title="配置账号" aria-label="配置账号" className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-slate-300 text-slate-700 transition hover:border-slate-400 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:border-slate-500 dark:hover:bg-white/[.04]"><IconAdjustmentsHorizontal aria-hidden="true" size={17} stroke={1.8} /></button>
          </div>
        </div>
        {configOpen && <section className="mb-6 rounded-2xl border border-blue-200 bg-white dark:border-blue-400/30 dark:bg-[#121923] p-5"><h2 className="text-sm font-medium text-slate-900 dark:text-slate-100">GitHub 发布配置</h2><p className="mt-1 text-xs text-slate-500">仅管理员可保存；OAuth 优先，手动 Token 作为兜底，密钥不会回显到网页。</p><div className="mt-4 grid gap-3 sm:grid-cols-2"><label className="text-xs text-slate-600 dark:text-slate-400">仓库（账号/仓库名）<input value={config.repository} onChange={(event) => setConfig({ ...config, repository: event.target.value })} className="mt-2 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-950/40 dark:text-slate-200 outline-none focus:border-blue-400" placeholder="owner/repository" /></label><label className="text-xs text-slate-400">发布 Token{config.hasToken ? "（已配置，留空保持）" : ""}<input value={token} onChange={(event) => setToken(event.target.value)} type="password" autoComplete="new-password" className="mt-2 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-400 dark:border-slate-700 dark:bg-slate-950/40 dark:text-slate-200" placeholder="Actions: Read and write" /></label></div><div className="mt-4 flex flex-wrap items-center gap-3"><a href="/api/deploy-status/github/start" target="_blank" rel="noreferrer" aria-label="使用 GitHub 授权，新窗口打开" className="rounded-lg bg-slate-900 px-3 py-2 text-xs font-medium text-white transition hover:bg-slate-700 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200">{config.githubAccount ? `已授权：${config.githubAccount}` : "使用 GitHub 授权"}</a>{config.githubAccount && <button onClick={async () => { await fetch("/api/deploy-status/config", { method: "DELETE" }); setConfig({ ...config, githubAccount: "" }); }} className="text-xs text-red-600 dark:text-red-300">撤销授权</button>}</div>{configError && <p className="mt-3 text-xs text-red-300">{configError}</p>}<div className="mt-4 flex justify-end gap-2"><button onClick={() => setConfigOpen(false)} className="rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-600 dark:border-slate-700 dark:text-slate-400">取消</button><button onClick={() => void saveConfig()} className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-medium text-white transition hover:bg-blue-500 active:scale-[.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200">保存配置</button></div></section>}
        <section className="mb-6 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-[#121923] dark:shadow-none sm:p-5">
          <h2 className="mb-4 text-sm font-medium">发布流程</h2>
          <div className="grid grid-cols-2 gap-2 text-xs sm:flex sm:flex-wrap sm:items-center">
            <a href={sourceVersion?.url || `https://github.com/${repository}`} target="_blank" rel="noreferrer" title="查看 fire-web main 最新提交" className={`relative inline-flex min-h-10 w-full items-center justify-center gap-2 whitespace-nowrap rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 font-medium transition hover:border-slate-400 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/50 sm:w-auto dark:border-slate-700 dark:bg-transparent dark:hover:border-slate-600 dark:hover:bg-white/[.04] ${sourceState.text}`}><span className={`h-2.5 w-2.5 rounded-full ${sourceState.dot}`} /><IconGitBranch aria-hidden="true" size={16} stroke={1.8} />fire-web main{runtimeVersion?.sha && runtimeVersion.sha !== "unknown" && <span className="absolute -right-1 -top-3 inline-flex items-center gap-1 rounded-full border border-slate-300 bg-white px-2 py-1 text-[10px] font-medium leading-none text-slate-950 shadow-sm dark:border-white/15 dark:bg-[#0d1117] dark:text-white"><span className={`h-1.5 w-1.5 rounded-full ${runtimeState.dot}`} />{runtimeVersion.shortSha}</span>}</a>
            <IconChevronRight aria-hidden="true" className="hidden text-slate-400 sm:block dark:text-slate-600" size={15} stroke={1.8} />
            <a href={latestMainCheck?.url || `https://github.com/${repository}/actions`} target="_blank" rel="noreferrer" title="查看当前 main 的类型与安全检查" className={`inline-flex min-h-10 w-full items-center justify-center gap-2 whitespace-nowrap rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 font-medium transition hover:border-slate-400 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/50 sm:w-auto dark:border-slate-700 dark:bg-transparent dark:hover:border-slate-600 dark:hover:bg-white/[.04] ${checkState.text}`}><span className={`h-2.5 w-2.5 rounded-full ${checkState.dot}`} /><IconShieldCheck aria-hidden="true" size={16} stroke={1.8} />{checkState.label}</a>
            <IconChevronRight aria-hidden="true" className="hidden text-slate-400 sm:block dark:text-slate-600" size={15} stroke={1.8} />
            <button onClick={() => void triggerPublish()} disabled={publishBusy} title={publishTitle} className="inline-flex min-h-10 w-full items-center justify-center gap-2 whitespace-nowrap rounded-xl border border-blue-600 bg-blue-600 px-3.5 py-2.5 font-semibold text-white shadow-sm shadow-blue-600/15 transition hover:border-blue-500 hover:bg-blue-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60 disabled:cursor-wait disabled:opacity-60 sm:w-auto dark:border-blue-400 dark:bg-blue-400 dark:text-slate-950 dark:shadow-none dark:hover:border-blue-300 dark:hover:bg-blue-300"><span className={`h-2.5 w-2.5 rounded-full ${imageState.dot}`} /><IconPackageExport aria-hidden="true" className={publishBusy ? "animate-pulse" : ""} size={16} stroke={1.8} />{publishBusy ? publishLabel : imageState.label}</button>
            <IconChevronRight aria-hidden="true" className="hidden text-slate-400 sm:block dark:text-slate-600" size={15} stroke={1.8} />
            <button onClick={() => void updateContainer()} disabled={!canUpdateContainer || containerBusy} title={!updaterAvailable ? updaterReason : imageBuilding ? "请等待镜像构建完成" : !imageVersion?.matchesMain ? "当前 main 尚无可部署镜像" : runtimeVersion?.matchesImage ? "线上已运行最新镜像" : "拉取已校验的 GHCR 镜像并重启 Fire"} className="inline-flex min-h-10 w-full items-center justify-center gap-2 whitespace-nowrap rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 font-medium text-slate-700 transition hover:border-slate-400 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/50 disabled:cursor-not-allowed disabled:opacity-45 sm:w-auto dark:border-slate-700 dark:bg-transparent dark:text-slate-200 dark:hover:border-slate-600 dark:hover:bg-white/[.04]"><IconServerCog aria-hidden="true" className={containerBusy ? "animate-pulse" : ""} size={16} stroke={1.8} />{containerBusy ? containerButtonLabel : !updaterAvailable && updaterReason.includes("未启动") ? "更新服务离线" : runtimeVersion?.matchesImage ? "群晖已是最新" : "更新群晖"}</button>
          </div>
        </section>
        {imageProgress && <section aria-live="polite" aria-busy={imageProgress.status !== "completed"} className="mb-6 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-[#121923] dark:shadow-none">
          <div className="flex flex-col gap-3 border-b border-slate-200 px-4 py-4 dark:border-slate-800 sm:flex-row sm:items-center sm:justify-between sm:px-5">
            <div>
              <h2 className="text-sm font-medium">镜像构建进度</h2>
              <p className="mt-1 text-xs text-slate-500">{imageProgress.sha} · {finishedJobCount} / {imageProgress.jobs.length || 2} 阶段 · {formatDuration(imageProgress.startedAt, imageProgress.status === "completed" ? imageProgress.updatedAt : null, checkedAt || imageProgress.updatedAt)}</p>
            </div>
            <a href={imageProgress.url} target="_blank" rel="noreferrer" className="inline-flex w-fit items-center gap-2 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 transition hover:border-slate-300 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/50 dark:border-slate-700 dark:text-slate-300 dark:hover:border-slate-600 dark:hover:bg-white/[.04]">
              <StatusIcon status={imageProgress.status} conclusion={imageProgress.conclusion} size={16} />
              {buildStatusLabel(imageProgress.status, imageProgress.conclusion)}
              <IconExternalLink aria-hidden="true" size={14} stroke={1.8} />
            </a>
          </div>
          {imageProgress.jobs.length > 0 ? <div className="flex flex-col items-stretch gap-2 p-4 sm:flex-row sm:items-start sm:gap-3 sm:p-5">
            {imageProgress.jobs.map((job, index) => { const currentStep = job.steps.find((step) => step.status === "in_progress") || job.steps.find((step) => step.status === "queued"); const jobTone = job.status === "in_progress" ? "border-amber-300 bg-amber-50/60 dark:border-amber-400/35 dark:bg-amber-400/[.05]" : job.status === "completed" && job.conclusion !== "success" && job.conclusion !== "skipped" ? "border-red-300 bg-red-50/60 dark:border-red-400/35 dark:bg-red-400/[.05]" : "border-slate-200 bg-slate-50/70 dark:border-slate-700 dark:bg-slate-950/20"; return <div key={job.id} className="contents">
              <details open={job.status !== "completed" ? true : undefined} className={`group min-w-0 flex-1 rounded-xl border ${jobTone} open:bg-white dark:open:bg-white/[.025]`}>
                <summary className="flex min-h-16 cursor-pointer list-none items-center gap-3 px-3.5 py-3 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400/50 [&::-webkit-details-marker]:hidden">
                  <StatusIcon status={job.status} conclusion={job.conclusion} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-slate-800 dark:text-slate-200">{job.name}</span>
                    <span className="mt-0.5 block truncate text-xs text-slate-500">{currentStep ? currentStep.name : buildStatusLabel(job.status, job.conclusion)} · {job.conclusion === "skipped" ? "已跳过" : formatDuration(job.startedAt, job.completedAt, checkedAt || imageProgress.updatedAt)}</span>
                  </span>
                  <IconChevronRight aria-hidden="true" className="shrink-0 text-slate-400 transition-transform duration-200 group-open:rotate-90" size={16} stroke={1.8} />
                </summary>
                {job.steps.length > 0 && <div className="border-t border-slate-200 px-3.5 py-2.5 dark:border-slate-800">
                  {job.steps.map((step) => <div key={step.number} className="flex items-center gap-2.5 py-2 text-xs">
                    <StatusIcon status={step.status} conclusion={step.conclusion} size={15} />
                    <span className={`min-w-0 flex-1 truncate ${step.status === "in_progress" ? "font-medium text-slate-800 dark:text-slate-200" : "text-slate-500 dark:text-slate-400"}`}>{step.name}</span>
                    <span className="shrink-0 text-slate-400">{step.conclusion === "skipped" ? "已跳过" : formatDuration(step.startedAt, step.completedAt, checkedAt || imageProgress.updatedAt)}</span>
                  </div>)}
                </div>}
              </details>
              {index < imageProgress.jobs.length - 1 && <IconChevronRight aria-hidden="true" className="mx-auto shrink-0 rotate-90 self-center text-slate-300 sm:mx-0 sm:mt-6 sm:rotate-0 dark:text-slate-700" size={18} stroke={1.8} />}
            </div>})}
          </div> : <p className="px-5 py-8 text-center text-sm text-slate-500">GitHub 正在创建构建任务…</p>}
        </section>}
        <section className="mb-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-[#121923] dark:shadow-none">
          <div><div className="flex items-center gap-2.5"><span className={`h-3 w-3 shrink-0 rounded-full ${latestState.className} ring-4 ${latestState.ring} ${latest && latest.status !== "completed" ? "animate-pulse" : ""}`} /><p className="text-lg font-medium">最新发布 <span className="text-slate-400">·</span> {latestState.label}</p></div><p className="mt-1.5 pl-[22px] text-xs text-slate-500">{latest ? `${latest.sha} · ${formatTime(latest.updatedAt)}` : "等待读取 GitHub Actions"}</p></div>
          {error && <p role="alert" className="mt-4 rounded-xl bg-red-400/10 px-3 py-2 text-xs text-red-600 dark:text-red-300">{error}</p>}
          {notice && <p role="status" className="mt-4 rounded-xl bg-emerald-400/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">{notice}</p>}
        </section>
        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-[#121923] dark:shadow-none">
          <div className="border-b border-slate-200 px-5 py-4 dark:border-slate-800"><h2 className="text-sm font-medium">最近运行</h2><p className="mt-1 text-xs text-slate-500">{repository}{checkedAt ? ` · 检查于 ${formatTime(checkedAt)}` : ""}</p></div>
          {!hasLoaded ? <div className="divide-y divide-slate-200 dark:divide-slate-800" aria-label="正在读取运行记录">{[0, 1, 2].map((item) => <div key={item} className="flex items-center gap-3 px-5 py-4 motion-safe:animate-pulse"><span className="h-2.5 w-2.5 rounded-full bg-slate-200 dark:bg-slate-700" /><span className="flex-1"><span className="block h-3 w-2/5 rounded bg-slate-200 dark:bg-slate-700" /><span className="mt-2 block h-2.5 w-1/4 rounded bg-slate-100 dark:bg-slate-800" /></span></div>)}</div> : <div className="divide-y divide-slate-200 dark:divide-slate-800">{pagedRuns.map((run) => { const state = stateOf(run); return <a key={run.id} href={run.url} target="_blank" rel="noreferrer" className="flex items-center gap-3 px-5 py-4 transition hover:bg-slate-50 dark:hover:bg-white/[.03]"><span className={`h-2.5 w-2.5 shrink-0 rounded-full ${state.className}`} /><span className="min-w-0 flex-1"><span className="block truncate text-sm text-slate-800 dark:text-slate-200">{run.title}</span><span className="mt-1 block text-xs text-slate-500">{run.sha} · {runActionLabel(run)} · {formatTime(run.updatedAt)}</span></span></a>; })}</div>}
          {hasLoaded && !runs.length && !error && <p className="px-5 py-10 text-center text-sm text-slate-500">暂无运行记录</p>}
          {runs.length > RUNS_PER_PAGE && <div className="flex items-center justify-between border-t border-slate-200 px-5 py-3 text-xs text-slate-500 dark:border-slate-800"><span>第 {page} / {totalPages} 页 · 共 {runs.length} 条</span><div className="flex gap-2"><button onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={page === 1} className="rounded-lg border border-slate-300 px-3 py-1.5 text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-35 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-white/[.04]">上一页</button><button onClick={() => setPage((value) => Math.min(totalPages, value + 1))} disabled={page === totalPages} className="rounded-lg border border-slate-300 px-3 py-1.5 text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-35 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-white/[.04]">下一页</button></div></div>}
        </section>
      </div>
    </main>
  );
}
