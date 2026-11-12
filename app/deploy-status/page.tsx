"use client";

import "./deploy-status.css";

import { DeploymentCommand, deploymentPending } from "@/lib/deploymentCommand";
import PasswordInput from "@/components/PasswordInput";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  IconAdjustmentsHorizontal,
  IconBrandGithub,
  IconChevronRight,
  IconExternalLink,
  IconGitBranch,
  IconPackage,
  IconPackageExport,
  IconRefresh,
  IconServerCog,
  IconShieldCheck
} from "@tabler/icons-react";
import ThemeToggle from "@/components/ThemeToggle";
import DeploymentBuildProgress from "@/components/DeploymentBuildProgress";
import type { ImageProgress } from "@/lib/deployProgress";
import { deploymentRunTitle } from "@/lib/deployRunTitle";

type Run = {
  id: number;
  name: string;
  title: string;
  sha: string;
  status: string;
  conclusion: string | null;
  event: string;
  workflowPath: string;
  publication?: string;
  startedAt: string;
  updatedAt: string;
  url: string;
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
  if (run.status !== "completed") return { label: run.event === "push" ? "检查中" : "发布中", className: "bg-slate-400", ring: "ring-slate-400/15" };
  if (run.conclusion === "cancelled") return { label: "已取消", className: "bg-slate-400", ring: "ring-slate-400/15" };
  if (run.publication === "reused") return { label: "复用已有镜像", className: "bg-slate-400", ring: "ring-slate-400/15" };
  if (run.publication === "unknown") return { label: "发布待核对", className: "bg-slate-400", ring: "ring-slate-400/15" };
  if (run.conclusion === "success") {
    const imageRun = run.event === "workflow_dispatch" || run.event === "schedule";
    return imageRun
      ? { label: "成功", className: "bg-emerald-400", ring: "ring-emerald-400/15" }
      : { label: "成功", className: "bg-blue-500", ring: "ring-blue-500/15" };
  }
  return { label: "失败", className: "bg-red-400", ring: "ring-red-400/15" };
}

const formatTime = (value: string) => `${new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Hong_Kong",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false
}).format(new Date(value))} 香港时间`;
const RUNS_PER_PAGE = 5;
type ContainerUpdateState = "idle" | "triggering" | "watching" | "healthy" | "failed";
type AutoUpdateSchedule = { key: string; deadline: number; triggered: boolean };

type HeatView = "day" | "week" | "month" | "total";
type HeatCell = { key: string; label: string; count: number; date?: Date; weekKey?: string; monthKey?: string; empty?: boolean };

function dayKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function UpdateHeatmap({ counts }: { counts: Record<string, number> }) {
  const [view, setView] = useState<HeatView>("day");
  const [selected, setSelected] = useState<HeatCell | null>(null);
  const today = useMemo(() => {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    return date;
  }, []);
  const { cells, monthLabels, weekCount } = useMemo(() => {
    const rangeStart = new Date(today.getFullYear(), 0, 1);
    const rangeEnd = new Date(today.getFullYear(), 11, 31);
    const gridStart = new Date(rangeStart);
    gridStart.setDate(gridStart.getDate() - gridStart.getDay());
    const gridEnd = new Date(rangeEnd);
    gridEnd.setDate(gridEnd.getDate() + (6 - gridEnd.getDay()));
    const result: HeatCell[] = [];
    const labels: { key: string; label: string; column: number }[] = [];
    let previousMonth = "";
    for (let date = new Date(gridStart), index = 0; date <= gridEnd; date.setDate(date.getDate() + 1), index += 1) {
      const current = new Date(date);
      const inYear = current >= rangeStart && current <= rangeEnd;
      const hasOccurred = inYear && current <= today;
      const key = dayKey(current);
      const monthKey = `${current.getFullYear()}-${current.getMonth() + 1}`;
      if (inYear && monthKey !== previousMonth) {
        labels.push({ key: monthKey, label: `${current.getMonth() + 1}月`, column: Math.floor(index / 7) });
        previousMonth = monthKey;
      }
      const weekStart = new Date(current);
      weekStart.setDate(weekStart.getDate() - weekStart.getDay());
      result.push({
        key: inYear ? key : `pad-${key}`,
        label: inYear ? `${current.getMonth() + 1}月${current.getDate()}日` : "",
        count: hasOccurred ? counts[key] || 0 : 0,
        date: inYear ? current : undefined,
        weekKey: `week-${dayKey(weekStart)}`,
        monthKey: `month-${monthKey}`,
        empty: !inYear
      });
    }
    return { cells: result, monthLabels: labels, weekCount: result.length / 7 };
  }, [counts, today]);
  const dayCells = cells.filter((cell) => cell.date);
  const max = Math.max(1, ...dayCells.map((cell) => cell.count));
  const tone = (count: number) => count === 0 ? "rgba(100,116,139,.14)" : `rgba(16,185,129,${(0.22 + 0.7 * Math.min(1, count / max)).toFixed(2)})`;
  const tabs: [HeatView, string][] = [["day", "每日"], ["week", "每周"], ["month", "每月"], ["total", "累计"]];
  return (
    <section className="mt-6 overflow-hidden rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-[#121923] dark:shadow-none sm:p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">更新热力图</h2>
          <p className="mt-1 text-xs text-slate-500">最近一年工作流更新频率</p>
        </div>
        <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1 text-xs dark:bg-white/[.06]" role="tablist" aria-label="热力图统计周期">
          {tabs.map(([key, label]) => (
            <button key={key} type="button" role="tab" aria-selected={view === key} onClick={() => { setView(key); setSelected(null); }} className={`rounded-md px-2 py-1 transition ${view === key ? "bg-white font-medium text-slate-900 shadow-sm dark:bg-white/10 dark:text-white" : "text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"}`}>{label}</button>
          ))}
        </div>
      </div>
      <div className="deploy-heatmap-continuous min-w-0">
        <div className="deploy-heatmap-labels" style={{ gridTemplateColumns: `repeat(${weekCount}, minmax(0, 1fr))` }}>
          {monthLabels.map((month) => <span key={month.key} style={{ gridColumnStart: month.column + 1 }}>{month.label}</span>)}
        </div>
        <div className="deploy-heatmap-grid grid w-full grid-flow-col grid-rows-7 gap-[2px]" style={{ gridTemplateColumns: `repeat(${weekCount}, minmax(0, 1fr))` }}>
              {cells.map((cell) => {
                if (!cell.date) return <span key={cell.key} className="min-w-0 rounded-[2px]" style={{ aspectRatio: "1 / 1" }} />;
                const groupKey = view === "week" ? cell.weekKey : view === "month" ? cell.monthKey : null;
                const highlighted = Boolean(groupKey && selected?.[view === "week" ? "weekKey" : "monthKey"] === groupKey);
                const total = groupKey ? dayCells.filter((item) => item[view === "week" ? "weekKey" : "monthKey"] === groupKey).reduce((sum, item) => sum + item.count, 0) : cell.count;
                return (
                  <button
                    key={cell.key}
                    type="button"
                    onClick={() => setSelected({ ...cell, count: total })}
                    aria-label={`${cell.label}，${total} 次 workflow`}
                    title={`${cell.label} · ${total} workflow`}
                    className={`min-w-0 rounded-[2px] p-0 transition hover:ring-2 hover:ring-emerald-400/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${highlighted ? "ring-2 ring-emerald-400/80" : ""}`}
                    style={{ backgroundColor: cell.empty ? "transparent" : tone(cell.count), aspectRatio: "1 / 1" }}
                  />
                );
              })}
        </div>
      </div>
      {selected && (
        <p className="mt-3 rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-700 dark:bg-white/[.06] dark:text-slate-200">
          {view === "week" ? `${selected.label}所在周` : view === "month" ? `${selected.date ? selected.date.getMonth() + 1 : ""}月` : selected.label} · {selected.count} workflow
        </p>
      )}
      <div className="mt-3 flex items-center justify-end gap-1.5 text-[10px] text-slate-500">
        <span>少</span>
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => <span key={ratio} className="h-2.5 w-2.5 rounded-[3px]" style={{ backgroundColor: tone(ratio * max) }} />)}
        <span>多</span>
      </div>
    </section>
  );
}

const AUTO_UPDATE_DELAY_MS = 5 * 60 * 1000;
const AUTO_UPDATE_STORAGE_KEY = "fire:deploy-auto-update";
const readApiJson = async <T extends Record<string, unknown>>(response: Response): Promise<T> => {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    throw new Error(`接口返回异常（HTTP ${response.status}），请确认线上容器已更新`);
  }
  return response.json() as Promise<T>;
};

export default function DeployStatusPage() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [heatmap, setHeatmap] = useState<Record<string, number>>({});
  const [hasLoaded, setHasLoaded] = useState(false);
  const [imageProgress, setImageProgress] = useState<ImageProgress | null>(null);
  const [sourceVersion, setSourceVersion] = useState<SourceVersion | null>(null);
  const [imageVersion, setImageVersion] = useState<ImageVersion | null>(null);
  const [runtimeVersion, setRuntimeVersion] = useState<RuntimeVersion | null>(null);
  const [packageName, setPackageName] = useState("fire-web");
  const [workflowRunCount, setWorkflowRunCount] = useState(0);
  const [page, setPage] = useState(1);
  const [repository, setRepository] = useState("owner/repository");
  const [checkedAt, setCheckedAt] = useState("");
  const [error, setError] = useState("");
  const [runsError, setRunsError] = useState("");
  const [buildError, setBuildError] = useState("");
  const [observedCheck, setObservedCheck] = useState<Pick<Run, "sha" | "status" | "conclusion" | "url"> | null>(null);
  const loadController = useRef<AbortController | null>(null);
  const loadedRepository = useRef("");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshTurns, setRefreshTurns] = useState(0);
  const [triggering, setTriggering] = useState(false);
  const [containerUpdateState, setContainerUpdateState] = useState<ContainerUpdateState>("idle");
  const [updaterAvailable, setUpdaterAvailable] = useState(false);
  const [updaterReason, setUpdaterReason] = useState("正在检查更新服务");
  const [notice, setNotice] = useState("");
  const [config, setConfig] = useState({ repository: "", hasToken: false, githubAccount: "", revision: null as string | null });
  const [configBusy, setConfigBusy] = useState(false);
  const commands = useMemo(() => ({
    save: new DeploymentCommand("/api/deploy-status/config", "PUT", "/api/deploy-status/config/receipts"),
    disconnect: new DeploymentCommand("/api/deploy-status/config", "DELETE", "/api/deploy-status/config/receipts"),
    publish: new DeploymentCommand("/api/deploy-status", "POST", "/api/deploy-status/builds"),
    update: new DeploymentCommand("/api/deploy-status/container-update", "POST", "/api/deploy-status/requests"),
  }), []);
  const [release, setRelease] = useState<Record<string,string> | null>(null);
  const [configOpen, setConfigOpen] = useState(false);
  const [token, setToken] = useState("");
  const [configError, setConfigError] = useState("");
  const autoUpdateKeyRef = useRef("");
  const [autoUpdateDeadline, setAutoUpdateDeadline] = useState<number | null>(null);
  const [autoUpdateSeconds, setAutoUpdateSeconds] = useState<number | null>(null);
  const load = useCallback(async () => {
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    setRefreshing(true);
    try {
      const response = await fetch("/api/deploy-status", { cache: "no-store", signal: controller.signal });
      const data = await readApiJson<{
        runsError?: string | null; buildError?: string | null; heatmapError?: string | null; sourceError?: string | null; releaseError?: string | null; configured?: boolean; check?: Pick<Run, "sha" | "status" | "conclusion" | "url"> | null;
        repository?: string; error?: string; release?: Record<string,string> | null; runs?: Run[]; imageProgress?: ImageProgress | null;
        source?: SourceVersion | null; image?: ImageVersion | null; runtime?: RuntimeVersion | null;
        packageName?: string; workflowRunCount?: number; checkedAt?: string; heatmap?: Record<string, number>;
        updateRequests?: Array<Record<string, unknown>>;
      }>(response);
      if (controller.signal.aborted) return;
      const changedRepository = !!loadedRepository.current && loadedRepository.current !== data.repository;
      if (data.repository) { setRepository(data.repository); loadedRepository.current = data.repository; }
      if (!response.ok) throw new Error(data.error || "读取失败");
      setRelease(data.release || null);
      if (Array.isArray(data.runs)) setRuns(data.runs);
      else if (changedRepository || data.configured === false) setRuns([]);
      setRunsError(data.runsError || (data.configured === false ? "尚未配置发布仓库" : ""));
      if (data.heatmap) setHeatmap(data.heatmap);
      else if (changedRepository || data.configured === false) setHeatmap({});
      if (!data.buildError || changedRepository) setImageProgress(data.imageProgress || null);
      setBuildError(data.buildError || "");
      setObservedCheck(data.check || null);
      setSourceVersion(data.source || null);
      setImageVersion(data.image || null);
      setRuntimeVersion(data.runtime || null);
      const updates = Array.isArray(data.updateRequests) ? data.updateRequests : [];
      const update = updates.find(item => item.request_id === commands.update.requestId)
        || updates.find(item => deploymentPending(item.status));
      if (update && commands.update.observe(update)) {
        const pending = deploymentPending(update.status);
        setContainerUpdateState(pending ? "watching" : update.status === "succeeded" ? "healthy" : "failed");
        setNotice(pending ? "正在核对原更新请求与运行版本" : update.status === "succeeded" ? "目标容器与后台服务已就绪，版本校验通过" : "原更新请求已结束，请核对结果");
      }
      setPackageName(data.packageName || "fire-web");
      if (typeof data.workflowRunCount === "number") setWorkflowRunCount(data.workflowRunCount);
      else if (changedRepository || data.configured === false) setWorkflowRunCount(0);
      setCheckedAt(data.checkedAt || "");
      setError([data.sourceError, data.releaseError, data.heatmapError].filter(Boolean).join("；"));
    } catch (err) { if (!controller.signal.aborted) { setNotice(""); setError(err instanceof Error ? err.message : "暂时无法读取发布状态"); } }
    finally { if (loadController.current === controller) { setRefreshing(false); setHasLoaded(true); } }
  }, [commands]);
  const loadUpdater = useCallback(async () => {
    try {
      const response = await fetch("/api/deploy-status/container-update", { cache: "no-store" });
      if (!response.ok) throw new Error("unavailable");
      const data = await readApiJson<{ available?: boolean; reason?: string }>(response);
      setUpdaterAvailable(Boolean(data.available));
      setUpdaterReason(data.reason || "更新服务不可用");
    } catch {
      setUpdaterAvailable(false);
      setUpdaterReason("无法连接更新服务");
    }
  }, []);
  const currentMainCheck = observedCheck?.sha === sourceVersion?.sha ? observedCheck : runs.find((run) => run.workflowPath === ".github/workflows/docker-publish.yml" && run.event === "push" && run.sha === sourceVersion?.shortSha);
  const refreshInterval = commands.update.pending || (imageProgress && imageProgress.status !== "completed") || (sourceVersion && (!currentMainCheck || currentMainCheck.status !== "completed")) ? 10000 : 60000;
  const refreshIntervalRef = useRef(refreshInterval);
  refreshIntervalRef.current = refreshInterval;
  useEffect(() => {
    let stopped = false;
    let cycle = 0;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (stopped || document.hidden) return;
      const currentCycle = cycle;
      await load();
      if (!stopped && currentCycle === cycle && !document.hidden) timer = setTimeout(tick, refreshIntervalRef.current);
    };
    const visibility = () => {
      cycle++;
      clearTimeout(timer);
      if (document.hidden) loadController.current?.abort();
      else void tick();
    };
    void tick();
    document.addEventListener("visibilitychange", visibility);
    return () => { stopped = true; clearTimeout(timer); loadController.current?.abort(); document.removeEventListener("visibilitychange", visibility); };
  }, [load]);
  useEffect(() => { fetch("/api/deploy-status/config").then(async (response) => response.ok ? setConfig(await readApiJson<typeof config>(response)) : null).catch(() => {}); }, []);
  useEffect(() => { void loadUpdater(); const timer = window.setInterval(() => void loadUpdater(), 15000); return () => window.clearInterval(timer); }, [loadUpdater]);
  const totalPages = Math.max(1, Math.ceil(runs.length / RUNS_PER_PAGE));
  const pagedRuns = runs.slice((page - 1) * RUNS_PER_PAGE, page * RUNS_PER_PAGE);
  useEffect(() => { if (page > totalPages) setPage(totalPages); }, [page, totalPages]);
  const refreshNow = () => {
    if (refreshing) return;
    setRefreshTurns((value) => value + 1);
    void load();
    void loadUpdater();
  };
  const saveConfig = async () => {
    if (configBusy) return;
    setConfigBusy(true); setConfigError("");
    try {
      const data = await commands.save.execute<typeof config>({ repository: config.repository, token, revision: config.revision });
      setConfig(data); setToken(""); setConfigOpen(false); setNotice("发布配置已保存");
    } catch (err) { setConfigError(err instanceof Error ? err.message : "保存失败"); }
    finally { setConfigBusy(false); }
  };
  const disconnectGithub = async () => {
    if (configBusy || !config.revision) return;
    setConfigBusy(true); setConfigError("");
    try { const data = await commands.disconnect.execute<typeof config>({ revision: config.revision }); setConfig(data); }
    catch (err) { setConfigError(err instanceof Error ? err.message : "撤销失败"); }
    finally { setConfigBusy(false); }
  };
  const triggerPublish = async () => {
    if (triggering || runs.some((run) => run.workflowPath === ".github/workflows/docker-publish.yml" && (run.event === "workflow_dispatch" || run.event === "schedule") && run.status !== "completed")) return;
    setTriggering(true); setNotice(""); setError("");
    try {
      const data = await commands.publish.execute({});
      setNotice(data.status === "submitted" ? "已提交镜像构建" : "构建请求已记录，正在核对状态");
      window.setTimeout(() => void load(), 2000);
      window.setTimeout(() => void load(), 5000);
    } catch (err) { setError(err instanceof Error ? err.message : "触发失败"); }
    finally { setTriggering(false); }
  };
  const updateContainer = async () => {
    if (containerUpdateState === "triggering") return;
    if (autoUpdateKeyRef.current) {
      try { localStorage.setItem(AUTO_UPDATE_STORAGE_KEY, JSON.stringify({ key: autoUpdateKeyRef.current, deadline: autoUpdateDeadline, triggered: true })); } catch { /* storage unavailable */ }
    }
    setAutoUpdateDeadline(null);
    setAutoUpdateSeconds(null);
    setContainerUpdateState("triggering"); setNotice(""); setError("");
    try {
      if (!release && !commands.update.pending) throw new Error("尚未读取到已发布的镜像，请刷新核对");
      const data = await commands.update.execute(release ? { release } : {});
      if (["failed", "rejected"].includes(String(data.status))) throw new Error("更新未完成，请核对原请求");
      setContainerUpdateState(deploymentPending(data.status) ? "watching" : data.status === "succeeded" ? "healthy" : "failed");
      setNotice(typeof data.message === "string" ? data.message : "更新请求已记录，正在核对运行版本");
      void load();
    } catch (err) {
      setContainerUpdateState(commands.update.pending ? "watching" : "failed");
      setError(commands.update.pending ? "更新结果尚未确认，请核对原请求" : err instanceof Error ? err.message : "无法触发群晖更新");
    }
  };
  const containerBusy = containerUpdateState === "triggering" || commands.update.pending;
  const containerButtonLabel = containerUpdateState === "triggering" ? "正在核对…" : "核对更新";
  const manualPublishActive = runs.some((run) => run.workflowPath === ".github/workflows/docker-publish.yml" && (run.event === "workflow_dispatch" || run.event === "schedule") && run.status !== "completed");
  const imageAlreadyBuilt = Boolean(imageVersion?.matchesMain);
  const publishBusy = triggering || manualPublishActive;
  const publishDisabled = publishBusy || imageAlreadyBuilt;
  const publishLabel = imageAlreadyBuilt ? "镜像已是最新" : manualPublishActive ? "镜像构建进行中…" : triggering ? "正在触发…" : "立即构建镜像";
  const publishTitle = imageAlreadyBuilt ? "当前 main 提交已有可用镜像，无需重复构建" : manualPublishActive ? "镜像构建进行中" : triggering ? "正在触发镜像构建" : "生成并推送 GHCR 镜像";
  const latest = runs.find((run) => run.workflowPath === ".github/workflows/docker-publish.yml" && (run.event === "schedule" || run.event === "workflow_dispatch"));
  const latestMainCheck = currentMainCheck;
  const latestState = latest ? stateOf(latest) : { label: hasLoaded ? "未知" : "读取中", className: "bg-slate-400", ring: "ring-slate-400/15" };
  const imageBuilding = Boolean(imageProgress && ["schedule", "workflow_dispatch"].includes(imageProgress.event || "") && imageProgress.status !== "completed");
  const autoUpdateEligible = Boolean(
    !error && !buildError && !runsError && latest?.status === "completed" && latest.conclusion === "success" &&
    imageVersion?.matchesMain && updaterAvailable && runtimeVersion &&
    !runtimeVersion.matchesImage && !imageBuilding
  );
  useEffect(() => {
    if (!autoUpdateEligible) {
      autoUpdateKeyRef.current = "";
      setAutoUpdateDeadline(null);
      setAutoUpdateSeconds(null);
      return;
    }
    const key = imageVersion?.latestSuccessfulSha || "";
    if (!key || autoUpdateKeyRef.current === key) return;
    autoUpdateKeyRef.current = key;
    let saved: AutoUpdateSchedule | null = null;
    try { saved = JSON.parse(localStorage.getItem(AUTO_UPDATE_STORAGE_KEY) || "null") as AutoUpdateSchedule | null; } catch { /* replace invalid state below */ }
    if (saved?.key === key && saved.triggered) return;
    const completedAt = Date.parse(imageVersion?.latestSuccessfulAt || latest?.updatedAt || "");
    const canonicalDeadline = Number.isFinite(completedAt) ? completedAt + AUTO_UPDATE_DELAY_MS : Date.now() + AUTO_UPDATE_DELAY_MS;
    const deadline = saved?.key === key && typeof saved.deadline === "number" && Number.isFinite(saved.deadline) ? saved.deadline : canonicalDeadline;
    try { localStorage.setItem(AUTO_UPDATE_STORAGE_KEY, JSON.stringify({ key, deadline, triggered: false })); } catch { /* countdown still works for this page */ }
    setAutoUpdateDeadline(deadline);
    setAutoUpdateSeconds(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
  }, [autoUpdateEligible, imageVersion?.latestSuccessfulAt, imageVersion?.latestSuccessfulSha, latest?.id, latest?.updatedAt]);
  useEffect(() => {
    if (autoUpdateDeadline === null) return;
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((autoUpdateDeadline - Date.now()) / 1000));
      setAutoUpdateSeconds(remaining);
      if (remaining === 0) {
        window.clearInterval(timer);
        void updateContainer();
      }
    };
    const timer = window.setInterval(tick, 1000);
    tick();
    return () => window.clearInterval(timer);
  }, [autoUpdateDeadline]);
  const latestAttemptFailed = Boolean(imageProgress && imageProgress.status === "completed" && !!imageProgress.conclusion && !["success", "skipped", "cancelled"].includes(imageProgress.conclusion) && sourceVersion && imageProgress.sha === sourceVersion.shortSha);
  const sourceState = sourceVersion
    ? { label: `main ${sourceVersion.shortSha}`, dot: "bg-slate-400", text: "text-slate-600 dark:text-slate-300" }
    : { label: "main 未知", dot: "bg-slate-400", text: "text-slate-500" };
  const checkState = !sourceVersion
    ? { label: "检查未知", dot: "bg-slate-400", text: "text-slate-500" }
    : !latestMainCheck
      ? { label: "等待检查", dot: "bg-amber-500 motion-safe:animate-pulse", text: "text-amber-700 dark:text-amber-300" }
    : latestMainCheck.status !== "completed"
      ? { label: "检查中", dot: "bg-amber-500 motion-safe:animate-pulse", text: "text-amber-700 dark:text-amber-300" }
      : latestMainCheck.conclusion === "success"
        ? { label: "检查通过", dot: "bg-emerald-500", text: "text-emerald-700 dark:text-emerald-300" }
        : { label: latestMainCheck.conclusion === "cancelled" ? "检查已取消" : latestMainCheck.conclusion ? "检查失败" : "检查待核对", dot: "bg-red-500", text: "text-red-700 dark:text-red-300" };
  const imageState = imageBuilding
    ? { label: "镜像生成中", dot: "bg-amber-500 motion-safe:animate-pulse", text: "text-amber-700 dark:text-amber-300" }
    : latestAttemptFailed
      ? { label: "镜像构建失败", dot: "bg-red-500", text: "text-red-700 dark:text-red-300" }
      : imageVersion?.matchesMain
        ? { label: "镜像已构建完成", dot: "bg-emerald-500", text: "text-emerald-700 dark:text-emerald-300" }
        : imageVersion?.latestSuccessfulSha
          ? { label: "立即构建", dot: "bg-emerald-400 deploy-breathe", text: "text-emerald-700 dark:text-emerald-300" }
        : { label: "尚无镜像", dot: "bg-slate-400", text: "text-slate-500" };
  const runtimeState = runtimeVersion?.matchesMain
    ? { label: `线上 ${runtimeVersion.shortSha}`, dot: "bg-emerald-500", text: "text-emerald-700 dark:text-emerald-300" }
    : runtimeVersion?.sha && runtimeVersion.sha !== "unknown"
      ? { label: runtimeVersion.matchesImage ? `运行旧镜像 ${runtimeVersion.shortSha}` : `待更新 ${runtimeVersion.shortSha}`, dot: "bg-slate-400", text: "text-slate-600 dark:text-slate-300" }
      : { label: "线上版本未知", dot: "bg-slate-400", text: "text-slate-500" };
  const canUpdateContainer = updaterAvailable && Boolean(imageVersion?.matchesMain) && !runtimeVersion?.matchesImage && !imageBuilding;
  const showImageProgress = Boolean(imageProgress && ["schedule", "workflow_dispatch"].includes(imageProgress.event || ""));
  const updaterDot = updaterReason === "正在检查更新服务" ? "bg-slate-400" : updaterAvailable ? "bg-emerald-500" : "bg-red-500";
  const runActionLabel = (run: Run) => {
    if (run.publication === "reused") return "复用已有镜像 · 跳过构建";
    if (run.publication === "unknown") return "发布结果待核对";
    const imageRun = run.event === "workflow_dispatch" || run.event === "schedule";
    const prefix = imageRun ? "镜像发布" : "代码检查";
    if (run.status !== "completed") return `${prefix}中`;
    if (run.conclusion === "cancelled") return `${prefix}已取消`;
    if (run.conclusion === "success") return `${prefix}成功`;
    if (run.conclusion === "skipped") return `${prefix}跳过`;
    return `${prefix}失败`;
  };
  return (
    <main className="deploy-status-page min-h-[100dvh] bg-slate-50 px-4 py-6 text-slate-900 dark:bg-[#0b0f16] dark:text-slate-100 sm:px-8 sm:py-10">
      <style jsx global>{`.deploy-status-page section button, .deploy-status-page section a { transition-timing-function: cubic-bezier(.22,1,.36,1); } .deploy-status-page section button:active, .deploy-status-page section a:active { transform: translateY(1px) scale(.985); } @keyframes deploy-breathe { 0%,100% { opacity:.66; transform:scale(.86); box-shadow:0 0 0 0 rgb(52 211 153 / .18); } 50% { opacity:1; transform:scale(1); box-shadow:0 0 0 5px rgb(52 211 153 / 0); } } .deploy-breathe { animation: deploy-breathe 2.6s cubic-bezier(.45,0,.55,1) infinite; } @media (prefers-reduced-motion:reduce) { .deploy-breathe { animation:none; } }`}</style>
      <div className="mx-auto max-w-[720px]">
        <div className="mb-7 sm:mb-8 sm:flex sm:items-start sm:justify-between sm:gap-6">
          <div className="min-w-0"><p className="mb-2 hidden text-xs uppercase tracking-[.22em] text-slate-500 sm:block">Alcor deployment</p><div className="flex flex-wrap items-center gap-2"><h1 className="text-xl font-semibold leading-tight tracking-tight sm:text-2xl"><span className="sm:hidden">发布状态</span><span className="hidden sm:inline">GitHub main 到线上发布状态</span></h1></div><p className="mt-1.5 max-w-[30rem] text-[13px] leading-5 text-slate-500 sm:mt-2 sm:text-sm dark:text-slate-400"><span className="sm:hidden">每日 00:07 检查更新，有新提交才构建镜像。</span><span className="hidden sm:inline">GitHub main 是发布源，每日 00:07 检查更新，有新提交才构建镜像。</span></p></div>
          <div className="mt-4 flex w-full items-center justify-end gap-2 sm:mt-0 sm:w-auto">
            <ThemeToggle />
            <button onClick={refreshNow} title={refreshing ? "正在刷新" : "刷新状态"} aria-label={refreshing ? "正在刷新" : "刷新状态"} disabled={refreshing} className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-slate-300 text-slate-700 transition hover:border-slate-400 hover:bg-slate-100 disabled:cursor-wait dark:border-slate-700 dark:text-slate-300 dark:hover:border-slate-500 dark:hover:bg-white/[.04]">
              <IconRefresh aria-hidden="true" size={16} stroke={1.8} style={{ transform: `rotate(${refreshTurns * 360}deg)`, transition: "transform 720ms cubic-bezier(.22,.75,.2,1)" }} />
            </button>
            <a href="/api/deploy-status/github/start" target="_blank" rel="noreferrer" title="使用 GitHub 授权" aria-label="使用 GitHub 授权，新窗口打开" className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-slate-300 text-slate-800 transition hover:border-slate-400 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:border-slate-500 dark:hover:bg-white/[.04]"><IconBrandGithub aria-hidden="true" size={17} stroke={1.8} /></a>
            <a href={`https://github.com/${repository}/pkgs/container/${packageName}`} target="_blank" rel="noreferrer" title="查看 GHCR 镜像" aria-label="查看 GHCR 镜像，新窗口打开" className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-slate-300 text-slate-700 transition hover:border-slate-400 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:border-slate-500 dark:hover:bg-white/[.04]"><IconPackage aria-hidden="true" size={17} stroke={1.8} /></a>
            <button onClick={() => setConfigOpen((value) => !value)} title="配置账号" aria-label="配置账号" className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-slate-300 text-slate-700 transition hover:border-slate-400 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:border-slate-500 dark:hover:bg-white/[.04]"><IconAdjustmentsHorizontal aria-hidden="true" size={17} stroke={1.8} /></button>
          </div>
        </div>
        {configOpen && <section className="mb-6 rounded-2xl border border-blue-200 bg-white dark:border-blue-400/30 dark:bg-[#121923] p-5"><h2 className="text-sm font-medium text-slate-900 dark:text-slate-100">GitHub 发布配置</h2><div className="mt-4 grid gap-3 sm:grid-cols-2"><label className="text-xs text-slate-600 dark:text-slate-400">仓库（账号/仓库名）<input disabled={configBusy || commands.save.pending} value={config.repository} onChange={(event) => setConfig({ ...config, repository: event.target.value })} className="mt-2 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-950/40 dark:text-slate-200 outline-none focus:border-blue-400" placeholder="owner/repository" /></label><label className="text-xs text-slate-400">发布 Token{config.hasToken ? "（已配置，留空保持）" : ""}<PasswordInput disabled={configBusy || commands.save.pending} value={token} onChange={(event) => setToken(event.target.value)} type="password" autoComplete="new-password" className="mt-2 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-400 dark:border-slate-700 dark:bg-slate-950/40 dark:text-slate-200" placeholder="Actions: Read and write" /></label></div><div className="mt-4 flex flex-wrap items-center gap-3"><a href="/api/deploy-status/github/start" target="_blank" rel="noreferrer" aria-label="使用 GitHub 授权，新窗口打开" className="rounded-lg bg-slate-900 px-3 py-2 text-xs font-medium text-white transition hover:bg-slate-700 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200">{config.githubAccount ? `已授权：${config.githubAccount}` : "使用 GitHub 授权"}</a>{config.githubAccount && <button disabled={configBusy} onClick={() => void disconnectGithub()} className="text-xs text-red-600 dark:text-red-300">撤销授权</button>}</div>{configError && <p className="mt-3 text-xs text-red-300">{configError}</p>}<div className="mt-4 flex justify-end gap-2"><button onClick={() => setConfigOpen(false)} className="rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-600 dark:border-slate-700 dark:text-slate-400">取消</button><button disabled={configBusy} onClick={() => void saveConfig()} className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-medium text-white transition hover:bg-blue-500 active:scale-[.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200">{configBusy ? "保存中…" : commands.save.pending ? "核对保存结果" : "保存配置"}</button></div></section>}
        <section className="mb-6 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-[#121923] dark:shadow-none sm:p-5">
          <div className="mb-4 flex min-h-6 items-center justify-between gap-3">
            <h2 className="text-sm font-medium">发布流程</h2>
            {runtimeVersion?.sha && runtimeVersion.sha !== "unknown" && <a href="/" target="_blank" rel="noreferrer" title="打开当前线上容器" className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50/80 px-2.5 py-1 font-mono text-[10px] font-medium leading-none text-slate-950 ring-1 ring-inset ring-white/70 transition hover:border-slate-300 hover:bg-white dark:border-white/10 dark:bg-[#0d1117] dark:text-white dark:ring-white/[.04] dark:hover:border-white/20 dark:hover:bg-[#161b22]"><span className={`h-1.5 w-1.5 rounded-full ${runtimeState.dot}`} /><span className="font-sans text-slate-500 dark:text-slate-400">线上</span>{runtimeVersion.shortSha}</a>}
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs sm:flex sm:flex-wrap sm:items-center">
            <a href={sourceVersion?.url || `https://github.com/${repository}`} target="_blank" rel="noreferrer" title="查看 fire-web main 最新提交" className={`inline-flex min-h-10 w-full items-center justify-center gap-2 whitespace-nowrap rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 font-medium transition hover:border-slate-400 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/50 sm:w-auto dark:border-slate-700 dark:bg-transparent dark:hover:border-slate-600 dark:hover:bg-white/[.04] ${sourceState.text}`}><span className={`h-2.5 w-2.5 rounded-full ${sourceState.dot}`} /><IconGitBranch aria-hidden="true" size={16} stroke={1.8} />fire-web main</a>
            <IconChevronRight aria-hidden="true" className="hidden text-slate-400 sm:block dark:text-slate-600" size={15} stroke={1.8} />
            <a href={latestMainCheck?.url || `https://github.com/${repository}/actions`} target="_blank" rel="noreferrer" title="查看当前 main 的类型与安全检查" className={`inline-flex min-h-10 w-full items-center justify-center gap-2 whitespace-nowrap rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 font-medium transition hover:border-slate-400 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/50 sm:w-auto dark:border-slate-700 dark:bg-transparent dark:hover:border-slate-600 dark:hover:bg-white/[.04] ${checkState.text}`}><span className={`h-2.5 w-2.5 rounded-full ${checkState.dot}`} /><IconShieldCheck aria-hidden="true" size={16} stroke={1.8} />{checkState.label}</a>
            <IconChevronRight aria-hidden="true" className="hidden text-slate-400 sm:block dark:text-slate-600" size={15} stroke={1.8} />
            <button onClick={() => void triggerPublish()} disabled={publishDisabled} title={publishTitle} className="deploy-publish inline-flex min-h-10 w-full items-center justify-center gap-2 whitespace-nowrap rounded-xl border border-blue-600 bg-blue-600 px-3.5 py-2.5 font-semibold text-white shadow-sm shadow-blue-600/15 transition hover:border-blue-500 hover:bg-blue-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto dark:border-blue-400 dark:bg-blue-400 dark:text-slate-950 dark:shadow-none dark:hover:border-blue-300 dark:hover:bg-blue-300"><span className={`h-2.5 w-2.5 rounded-full ${imageState.dot}`} /><IconPackageExport aria-hidden="true" className={publishBusy ? "animate-pulse" : ""} size={16} stroke={1.8} />{publishDisabled ? publishLabel : imageState.label}</button>
            <IconChevronRight aria-hidden="true" className="hidden text-slate-400 sm:block dark:text-slate-600" size={15} stroke={1.8} />
            <button onClick={() => void updateContainer()} disabled={(!canUpdateContainer && !commands.update.pending) || containerUpdateState === "triggering"} title={commands.update.pending ? "仅核对原更新请求与运行版本" : !updaterAvailable ? updaterReason : imageBuilding ? "请等待镜像构建完成" : !imageVersion?.matchesMain ? "当前 main 尚无可部署镜像" : runtimeVersion?.matchesImage ? "Watchtower 在线，容器已运行最新镜像" : "Watchtower 在线，可拉取最新 GHCR 镜像并重启 Alcor"} className="inline-flex min-h-10 w-full items-center justify-center gap-2 whitespace-nowrap rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 font-medium text-slate-700 transition hover:border-slate-400 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/50 disabled:cursor-not-allowed sm:w-auto dark:border-slate-700 dark:bg-transparent dark:text-slate-200 dark:hover:border-slate-600 dark:hover:bg-white/[.04]"><span className={`h-2.5 w-2.5 rounded-full ${updaterDot}`} /><IconServerCog aria-hidden="true" className={containerBusy ? "animate-pulse" : ""} size={16} stroke={1.8} />{containerBusy ? containerButtonLabel : updaterReason === "正在检查更新服务" ? "服务检测中" : !updaterAvailable ? "服务离线" : runtimeVersion?.matchesImage ? "容器已是最新" : "有新镜像"}</button>
          </div>
          {autoUpdateSeconds !== null && <p className="mt-3 text-xs text-emerald-700 dark:text-emerald-300">镜像已构建成功，将在 {Math.floor(autoUpdateSeconds / 60)} 分 {String(autoUpdateSeconds % 60).padStart(2, "0")} 秒后自动更新容器</p>}
        </section>
        {buildError && <p role="alert" className="deploy-observation-error mb-4 text-sm">{buildError}{imageProgress ? " · 显示上次记录" : ""}</p>}
        {imageProgress && showImageProgress && <DeploymentBuildProgress key={imageProgress.id} progress={imageProgress} checkedAt={checkedAt} />}
        <section className="mb-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-[#121923] dark:shadow-none">
          <div><div className="flex items-center gap-2.5"><span className={`h-3 w-3 shrink-0 rounded-full ${latestState.className} ring-4 ${latestState.ring} ${latest && latest.status !== "completed" ? "animate-pulse" : ""}`} /><p className="text-lg font-medium">最新发布 <span className="text-slate-400">·</span> {latestState.label}</p></div><p className="mt-1.5 pl-[22px] text-xs text-slate-500">{latest ? `${latest.sha} · ${formatTime(latest.updatedAt)}` : "等待读取 GitHub Actions"}</p></div>
          {error && <p role="alert" className="mt-4 rounded-xl bg-red-400/10 px-3 py-2 text-xs text-red-600 dark:text-red-300">{error}</p>}
          {notice && <p role="status" className="mt-4 rounded-xl bg-emerald-400/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">{notice}</p>}
        </section>
        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-[#121923] dark:shadow-none">
          <div className="border-b border-slate-200 px-5 py-4 dark:border-slate-800"><div className="flex items-center gap-2"><h2 className="text-sm font-medium">最近运行</h2>{hasLoaded && workflowRunCount > 0 && <span aria-label={`共 ${workflowRunCount} 次运行`} title={`${workflowRunCount} workflow runs`} className="inline-flex h-6 min-w-6 items-center justify-center rounded-full border border-slate-200 bg-slate-100 px-1.5 text-[10px] font-semibold tabular-nums text-slate-600 ring-1 ring-inset ring-white/70 dark:border-white/10 dark:bg-white/[.06] dark:text-slate-300 dark:ring-white/[.04]">{workflowRunCount}</span>}</div><p className="mt-1 text-xs text-slate-500">{repository}{checkedAt ? ` · 检查于 ${formatTime(checkedAt)}` : ""}</p></div>
          {!hasLoaded ? <div className="divide-y divide-slate-200 dark:divide-slate-800" aria-label="正在读取运行记录">{[0, 1, 2].map((item) => <div key={item} className="flex items-center gap-3 px-5 py-4 motion-safe:animate-pulse"><span className="h-2.5 w-2.5 rounded-full bg-slate-200 dark:bg-slate-700" /><span className="flex-1"><span className="block h-3 w-2/5 rounded bg-slate-200 dark:bg-slate-700" /><span className="mt-2 block h-2.5 w-1/4 rounded bg-slate-100 dark:bg-slate-800" /></span></div>)}</div> : <div className="divide-y divide-slate-200 dark:divide-slate-800">{pagedRuns.map((run) => { const state = stateOf(run); return <a key={run.id} href={run.url} target="_blank" rel="noreferrer" className="flex items-center gap-3 px-5 py-4 transition hover:bg-slate-50 dark:hover:bg-white/[.03]"><span className={`h-2.5 w-2.5 shrink-0 rounded-full ${state.className}`} /><span className="min-w-0 flex-1"><span className="block truncate text-sm text-slate-800 dark:text-slate-200">{deploymentRunTitle(run)}</span><span className="mt-1 block text-xs text-slate-500">{run.sha} · {runActionLabel(run)} · {formatTime(run.updatedAt)}</span></span></a>; })}</div>}
          {runsError && <p role="alert" className="deploy-observation-error px-5 py-4 text-sm">{runsError}{runs.length ? " · 显示上次记录" : ""}</p>}
          {hasLoaded && !runs.length && !error && !runsError && <p className="px-5 py-10 text-center text-sm text-slate-500">暂无运行记录</p>}
          {runs.length > RUNS_PER_PAGE && <div className="flex items-center justify-between border-t border-slate-200 px-5 py-3 text-xs text-slate-500 dark:border-slate-800"><span>第 {page} / {totalPages} 页 · 共 {runs.length} 条</span><div className="flex gap-2"><button onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={page === 1} className="rounded-lg border border-slate-300 px-3 py-1.5 text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-35 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-white/[.04]">上一页</button><button onClick={() => setPage((value) => Math.min(totalPages, value + 1))} disabled={page === totalPages} className="rounded-lg border border-slate-300 px-3 py-1.5 text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-35 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-white/[.04]">下一页</button></div></div>}
        </section>
        <UpdateHeatmap counts={heatmap} />
      </div>
    </main>
  );
}
