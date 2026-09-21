import { randomUUID } from "node:crypto";
import { readJsonBody } from "@/lib/requestBody";
import { SHOWCASE_MODELS } from "@/components/showcase/presets/models";
import path from "node:path";
import { spawn } from "node:child_process";
import { NextResponse } from "next/server";
import { getAuthUser, isAdmin, isTrustedMutationRequest } from "@/lib/auth";
import { modelFileExists, modelUrlExists, readStoredModels, validModelId } from "@/lib/showcaseModels";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";
export const maxDuration = 3600;

type PreviewJob = { textureCount?: number; needsGpu?: boolean; phase?: string; gpuCount?: number; gpuReused?: number; reused?: number; failed?: number; total?: number; model?: string; fileBytes?: number; textureBytes?: number; status: "idle" | "running" | "done" | "error"; count: number; id?: string; jobId?: string; error?: string; startedAt?: number; finishedAt?: number };
const runtime = globalThis as typeof globalThis & { __showcasePreviewJob?: PreviewJob };
const job = () => runtime.__showcasePreviewJob ?? (runtime.__showcasePreviewJob = { status: "idle", count: 0 });

function authorize(request: Request) {
  const user = getAuthUser(request);
  if (!user) return { error: NextResponse.json({ error: "未登录" }, { status: 401 }) };
  if (!isAdmin(user)) return { error: NextResponse.json({ error: "只有管理员能生成车型预览" }, { status: 403 }) };
  return { user };
}

export async function GET(request: Request) {
  const auth = authorize(request);
  if (auth.error) return auth.error;
  const requested = new URL(request.url).searchParams.get("jobId");
  if (requested && requested !== job().jobId) return NextResponse.json({ error: "生成任务已更新，请检查对应车型预览状态" }, { status: 409 });
  return NextResponse.json(job());
}

export async function POST(request: Request) {
  const auth = authorize(request);
  if (auth.error) return auth.error;
  if (!isTrustedMutationRequest(request)) return NextResponse.json({ error: "请求来源不可信" }, { status: 403 });
  let id: string;
  try {
    const body = await readJsonBody(request, 1024) as { id?: unknown } | null;
    if (typeof body?.id !== "string" || !validModelId(body.id)) throw new Error();
    id = body.id;
  } catch { return NextResponse.json({ error: "请选择要生成预览的车型" }, { status: 400 }); }
  const builtin = SHOWCASE_MODELS.find(model => model.id === id);
  const stored = readStoredModels().find(model => model.id === id);
  if (!(builtin ? modelUrlExists(builtin.config.assets.model) : stored && modelFileExists(stored.file))) return NextResponse.json({ error: "车型不存在或素材缺失" }, { status: 404 });
  if (job().status === "running") return NextResponse.json({ ...job(), error: "已有车型正在生成预览，请完成后再试" }, { status: 409 });
  if (!rateLimit(`showcase-previews:${clientIp(request)}`, 6, 60 * 60 * 1000) || !rateLimitGlobal("showcase-previews", 12, 60 * 60 * 1000)) {
    return NextResponse.json({ error: "生成操作过于频繁，请稍后再试" }, { status: 429 });
  }
  runtime.__showcasePreviewJob = { status: "running", count: 0, id, jobId: randomUUID(), startedAt: Date.now() };
  const jobId = runtime.__showcasePreviewJob.jobId;
  const child = spawn(process.execPath, [path.join(process.cwd(), "scripts", "build-showcase-previews.mjs"), "--id", id], {
    cwd: process.cwd(), detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"]
  });
  let pending = "", detail = "";
  const timer = setTimeout(() => {
    detail = "生成任务超过 60 分钟，已停止；原模型和已完成副本保留";
    try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGTERM"); else child.kill(); }
    catch { child.kill(); }
  }, 60 * 60 * 1000);
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (job().jobId !== jobId) return;
    pending += chunk;
    const lines = pending.split("\n"); pending = lines.pop() ?? "";
    if (pending.length > 8192) pending = pending.slice(-8192);
    for (const line of lines) {
      if (!line.startsWith("SHOWCASE_PROGRESS ")) continue;
      try {
        const progress = JSON.parse(line.slice("SHOWCASE_PROGRESS ".length));
        runtime.__showcasePreviewJob = { ...job(), ...progress, status: "running" };
      } catch { /* 普通转码日志不影响任务状态 */ }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { detail = (detail + chunk).slice(-2000); });
  child.on("error", (error) => {
    clearTimeout(timer);
    if (job().jobId !== jobId) return;
    runtime.__showcasePreviewJob = { ...job(), status: "error", error: `生成失败：${error.message}`, finishedAt: Date.now() };
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    if (job().jobId !== jobId) return;
    if (code === 0 && job().phase === "done") {
      runtime.__showcasePreviewJob = { ...job(), status: "done", finishedAt: Date.now() };
    } else {
      runtime.__showcasePreviewJob = { ...job(), status: "error", error: job().error || `生成失败：${detail.slice(-500) || "转码进程未完成"}`, finishedAt: Date.now() };
    }
  });
  return NextResponse.json(runtime.__showcasePreviewJob, { status: 202 });
}
