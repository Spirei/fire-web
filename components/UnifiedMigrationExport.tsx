"use client";

import { useEffect, useState } from "react";
import AppModal from "./AppModal";
import PasswordInput from "./PasswordInput";
import type { ExportSource } from "@/lib/migrationExportSource";
import { useWorkspaceLocationGuard } from "@/lib/workspacePanel";

type Job = { id: string; state: "running" | "ready" | "failed"; stage: string; error?: { message: string }; result?: { sha256: string; manifestSha256: string; bytes: string; tables: string; originals: string; source: ExportSource } };
const phases: Record<string, string> = { queued: "等待导出", "checking-originals": "核对原件", "snapshot-open": "读取一致快照", "dumping-database": "导出完整数据库", "copying-originals": "核对并复制原件", encrypting: "加密封装", ready: "导出完成", failed: "导出失败", interrupted: "导出中断" };
export default function UnifiedMigrationExport() {
  const canUseLocation = useWorkspaceLocationGuard();
  const [open, setOpen] = useState(false), [source, setSource] = useState<ExportSource | null>(null);
  const [key, setKey] = useState(""), [saved, setSaved] = useState(false), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const displayedSource = job?.result?.source || source;
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void fetch("/api/migration-export", { cache: "no-store", signal: controller.signal }).then(async response => {
      const result = await response.json(); if (!response.ok) throw new Error(result.error || "来源核对失败");
      if (!controller.signal.aborted) { setSource(result.source); setError(""); }
    }).catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "来源核对失败"); });
    const retained = new URLSearchParams(window.location.search).get("migrationExport");
    if (retained && /^mex_[a-f0-9]{32}$/.test(retained)) setJob({ id: retained, state: "running", stage: "queued" });
    return () => controller.abort();
  }, [open]);
  useEffect(() => {
    if (!open || !job || job.state !== "running") return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      if (document.hidden) { timer = setTimeout(check, 2500); return; }
      try {
        const response = await fetch(`/api/migration-export/${job.id}`, { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
        const result = await response.json(); if (!response.ok) throw new Error(result.error || "状态读取失败");
        if (!controller.signal.aborted) { setJob(result); setError(""); if (result.state === "running") timer = setTimeout(check, 2500); }
      } catch (error) { if (!controller.signal.aborted) { setError(error instanceof Error ? error.message : "状态读取失败"); timer = setTimeout(check, 5000); } }
    };
    void check(); return () => { controller.abort(); clearTimeout(timer); };
  }, [open, job?.id, job?.state]);
  function generate() {
    try { const bytes = crypto.getRandomValues(new Uint8Array(32)); setKey(btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")); bytes.fill(0); setSaved(false); }
    catch { setError("当前浏览器无法安全生成导出密钥"); }
  }
  function downloadKey() {
    const blob = new Blob([key + "\n"], { type: "application/octet-stream" }), url = URL.createObjectURL(blob), link = document.createElement("a");
    link.href = url; link.download = `alcor-migration-${source?.buildSha.slice(0, 12) || "source"}-${Date.now()}.key`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function start() {
    if (!source || !key || !saved || busy) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/migration-export", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: "export-complete-database", expectedSource: source, encryptionKey: key }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error || "导出创建失败");
      setKey(""); setSaved(false); setJob({ ...result, stage: "queued" });
      if (canUseLocation()) { const url = new URL(window.location.href); url.searchParams.set("migrationExport", result.id); window.history.replaceState(null, "", url); }
    } catch (error) { setError(error instanceof Error ? error.message : "导出创建失败"); }
    finally { setBusy(false); }
  }
  function close() { setOpen(false); setKey(""); setSaved(false); setSource(null); }
  return <>
    <div className="sw-row"><div className="sw-row-label"><b>统一迁移导出</b><span>完整数据库、交易执行状态与登记原件</span></div><button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(true)}>准备导出</button></div>
    {open && <AppModal title="统一迁移导出" desc="包含所有用户。导出包密钥与原库加密密钥都需单独保管、交接。" onClose={close}>
      {displayedSource && <dl className="text-sm leading-6 break-all"><dt>来源实例</dt><dd>{displayedSource.origin}</dd><dt>运行版本</dt><dd>{displayedSource.appVersion} · {displayedSource.buildSha}</dd><dt>数据库</dt><dd>PostgreSQL {displayedSource.serverVersion} · {displayedSource.database}/{displayedSource.schema} · pg</dd></dl>}
      {job && <div className="mt-4 text-sm break-all" role="status">{phases[job.stage] || "导出处理中"} · {job.id}{job.error && <p role="alert">{job.error.message}</p>}</div>}
      {job?.state === "ready" && job.result ? <div className="mt-4 text-sm break-all"><p>{job.result.tables} 张表 · {job.result.originals} 个原件 · {job.result.bytes} 字节</p><p>SHA-256：{job.result.sha256}</p><p>清单 SHA-256：{job.result.manifestSha256}</p><a className="btn btn-primary mt-4" href={`/api/migration-export/${job.id}/download`}>下载加密迁移包</a></div> : job?.state !== "running" && source && <div className="mt-4 flex flex-col gap-4">
        <div className="flex flex-wrap gap-3"><button type="button" className="btn btn-line" onClick={generate}>生成独立导出密钥</button>{key && <button type="button" className="btn btn-line" onClick={downloadKey}>单独保存密钥</button>}</div>
        {key && <PasswordInput type="password" readOnly allowReveal={false} value={key} aria-label="独立导出密钥" />}
        {key && <label className="text-sm"><input type="checkbox" checked={saved} onChange={event => setSaved(event.target.checked)} /> 已另外保存导出密钥</label>}
        <button type="button" className="btn btn-primary" disabled={!saved || !key || busy} onClick={() => void start()}>{busy ? "创建中…" : "导出完整数据库与原件"}</button>
      </div>}
      {error && <p role="alert" className="mt-4 text-sm">{error}</p>}
    </AppModal>}
  </>;
}
