import { randomUUID } from "node:crypto";
import { readJsonBody } from "@/lib/requestBody";
import { SHOWCASE_MODELS } from "@/components/showcase/presets/models";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NextResponse } from "next/server";
import { getAuthUser, isAdmin, isTrustedMutationRequest } from "@/lib/auth";
import { modelFileExists, modelUrlExists, readStoredModels, validModelId } from "@/lib/showcaseModels";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

const run = promisify(execFile);
type PreviewJob = { status: "idle" | "running" | "done" | "error"; count: number; id?: string; jobId?: string; error?: string; startedAt?: number; finishedAt?: number };
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
  if (job().status === "running") return NextResponse.json({ error: "已有车型正在生成预览，请完成后再试" }, { status: 409 });
  if (!rateLimit(`showcase-previews:${clientIp(request)}`, 6, 60 * 60 * 1000) || !rateLimitGlobal("showcase-previews", 12, 60 * 60 * 1000)) {
    return NextResponse.json({ error: "生成操作过于频繁，请稍后再试" }, { status: 429 });
  }
  runtime.__showcasePreviewJob = { status: "running", count: 0, id, jobId: randomUUID(), startedAt: Date.now() };
  void run(process.execPath, [path.join(process.cwd(), "scripts", "build-showcase-previews.mjs"), "--id", id], {
      cwd: process.cwd(),
      timeout: 9 * 60 * 1000,
      maxBuffer: 8 * 1024 * 1024
    }).then(() => {
    runtime.__showcasePreviewJob = { ...job(), status: "done", count: 1, finishedAt: Date.now() };
  }).catch((err) => {
    const detail = err instanceof Error ? err.message : String(err);
    runtime.__showcasePreviewJob = { ...job(), status: "error", count: 0, error: `生成失败：${detail.slice(0, 300)}`, startedAt: job().startedAt, finishedAt: Date.now() };
  });
  return NextResponse.json(runtime.__showcasePreviewJob, { status: 202 });
}
