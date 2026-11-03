import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { MigrationExportError, hashOriginal } from "./migrationExportFiles";
import { openExportContext, assertExpectedSource, type ExportContext, type ExportSource } from "./migrationExportSource";
import { buildMigrationBundle, migrationKey } from "./migrationExportSnapshot";

type ExportJob = { id: string; ownerId: string; source: ExportSource; process: string; state: "running" | "ready" | "failed"; stage: string; createdAt: string; completedAt?: string; error?: { code: string; message: string }; result?: Awaited<ReturnType<typeof buildMigrationBundle>> };
const globalState = globalThis as typeof globalThis & { __alcorMigrationProcess?: string };
const processId = globalState.__alcorMigrationProcess ??= randomBytes(16).toString("hex");
const JOB_ID = /^mex_[a-f0-9]{32}$/;
const rootFor = (context: ExportContext) => path.join(context.root, "data/migration-exports");
const headers = { "Cache-Control": "private, no-store", Pragma: "no-cache", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox; default-src 'none'" };

async function privateDirectory(directory: string, create = false) {
  if (create) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || await fs.realpath(directory) !== directory) throw new MigrationExportError("export_storage_unsafe", "导出保存目录权限或路径不安全");
}
async function saveJob(directory: string, job: ExportJob) {
  const temporary = path.join(directory, ".job-next.json");
  const output = await fs.open(temporary, "wx", 0o600);
  try { await output.writeFile(JSON.stringify(job) + "\n"); await output.sync(); } finally { await output.close(); }
  await fs.rename(temporary, path.join(directory, "job.json"));
}
async function readJob(context: ExportContext, id: string) {
  if (!JOB_ID.test(id)) throw new MigrationExportError("export_not_found", "导出不存在", 404);
  await privateDirectory(rootFor(context));
  const directory = path.join(rootFor(context), id); await privateDirectory(directory);
  const handle = await fs.open(path.join(directory, "job.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
  let job: ExportJob;
  try { job = JSON.parse(await handle.readFile("utf8")); } finally { await handle.close(); }
  if (job.id !== id || job.ownerId !== context.actor.id) throw new MigrationExportError("export_not_found", "导出不存在", 404);
  // User IDs can exist in several source databases. Ownership alone never grants cross-source access.
  const createdSource = job.source ?? job.result?.source;
  const identity = ["origin", "backend", "database", "schema", "migrationId", "instanceId", "driver"] as const;
  if (!createdSource || identity.some(key => createdSource[key] !== context.source[key])) throw new MigrationExportError("source_changed", "导出来源与当前数据库不一致，已保留原归档");
  return { job, directory };
}

export async function startMigrationExport(context: ExportContext, expected: unknown, encodedKey: unknown) {
  assertExpectedSource(expected, context.source);
  const key = migrationKey(encodedKey), exports = rootFor(context);
  let lock;
  try {
    await privateDirectory(exports, true);
    lock = await fs.open(path.join(exports, ".active-export"), "wx", 0o600);
  } catch (error) { key.fill(0); if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new MigrationExportError("export_busy", "已有导出任务或中断记录，请先核对现有任务"); throw error; }
  const id = "mex_" + randomBytes(16).toString("hex"), directory = path.join(exports, id);
  const job: ExportJob = { id, ownerId: context.actor.id, source: context.source, process: processId, state: "running", stage: "queued", createdAt: new Date().toISOString() };
  try {
    await fs.mkdir(directory, { mode: 0o700 });
    await lock.writeFile(JSON.stringify({ id, process: processId, pid: process.pid }) + "\n"); await lock.sync();
    await saveJob(directory, job);
  } catch (error) { key.fill(0); await lock.close(); await fs.unlink(path.join(exports, ".active-export")).catch(() => {}); throw error; }
  // Explicit admin operation only. A read, startup or cron never resumes/creates a task.
  void (async () => {
    try {
      job.result = await buildMigrationBundle(context, directory, id, key, async stage => { job.stage = stage; await saveJob(directory, job); });
      job.state = "ready"; job.stage = "ready";
    } catch (error) {
      job.state = "failed"; job.stage = "failed";
      job.error = error instanceof MigrationExportError ? { code: error.code, message: error.message } : { code: "export_failed", message: "完整迁移导出失败，未发布不完整结果" };
    } finally {
      key.fill(0); job.completedAt = new Date().toISOString();
      try { await saveJob(directory, job); }
      finally { await context.close().catch(() => {}); await lock.close(); await fs.unlink(path.join(exports, ".active-export")).catch(() => {}); }
    }
  })().catch(() => {});
  return { id, state: job.state, statusUrl: `/api/migration-export/${id}`, downloadUrl: `/api/migration-export/${id}/download` };
}

export async function migrationExportPreflight(request: Request) {
  const context = await openExportContext(request);
  try { return Response.json({ source: context.source, encryption: "32-random-bytes-base64url-separate-key", recentAuthenticationRequired: true }, { headers }); }
  finally { await context.close(); }
}
export async function migrationExportStart(request: Request) {
  if (Number(request.headers.get("content-length") || 0) > 8192) throw new MigrationExportError("body_large", "请求过大", 413);
  // Bounded read; this helper has no application/database imports.
  const { readLimitedJson } = await import("./requestBody");
  const body = await readLimitedJson<Record<string, unknown>>(request, 8192).catch(() => null);
  if (!body || body.confirm !== "export-complete-database" || Object.keys(body).some(key => !["confirm", "expectedSource", "encryptionKey"].includes(key))) throw new MigrationExportError("confirmation_required", "请明确确认完整数据库迁移导出", 400);
  const context = await openExportContext(request, true);
  try { return Response.json(await startMigrationExport(context, body.expectedSource, body.encryptionKey), { status: 202, headers }); }
  catch (error) { await context.close(); throw error; }
}
export async function migrationExportStatus(request: Request, id: string) {
  const context = await openExportContext(request);
  try {
    const { job } = await readJob(context, id);
    const active = await fs.readFile(path.join(rootFor(context), ".active-export"), "utf8").then(value => JSON.parse(value), () => null);
    let live = false;
    if (active?.id === job.id && active.process === job.process && Number.isSafeInteger(active.pid)) {
      if (active.pid === process.pid) live = active.process === processId;
      else try { process.kill(active.pid, 0); live = true; } catch { /* An orphan cannot serve unfinished data. */ }
    }
    const interrupted = job.state === "running" && !live;
    const { ownerId: _ownerId, process: _process, ...result } = job;
    return Response.json({ ...result, ...(interrupted ? { state: "failed", stage: "interrupted", error: { code: "export_interrupted", message: "导出进程曾中断；不能下载未完成结果" } } : {}) }, { headers });
  } finally { await context.close(); }
}
export async function migrationExportDownload(request: Request, id: string) {
  const context = await openExportContext(request, true);
  try {
    const { job, directory } = await readJob(context, id);
    if (job.state !== "ready" || !job.result) throw new MigrationExportError("export_not_ready", "导出尚未完成或已失败");
    const sealed = await hashOriginal(directory, "bundle.alcor-migration");
    if (sealed.sha256 !== job.result.sha256 || sealed.bytes !== job.result.bytes) throw new MigrationExportError("export_changed", "导出文件校验失败");
    const file = await fs.open(path.join(directory, "bundle.alcor-migration"), constants.O_RDONLY | constants.O_NOFOLLOW);
    return new Response(Readable.toWeb(file.createReadStream()) as ReadableStream, { headers: { ...headers, "Content-Type": "application/octet-stream", "Content-Length": sealed.bytes, "Content-Disposition": `attachment; filename="${id}.alcor-migration"`, "X-Alcor-Export-SHA256": sealed.sha256, "X-Alcor-Manifest-SHA256": job.result.manifestSha256 } });
  } finally { await context.close(); }
}
export function migrationExportFailure(error: unknown) {
  const detail = error instanceof MigrationExportError ? error : new MigrationExportError("export_unavailable", "完整迁移导出暂不可用", 503);
  return Response.json({ error: detail.message, code: detail.code }, { status: detail.status, headers });
}
