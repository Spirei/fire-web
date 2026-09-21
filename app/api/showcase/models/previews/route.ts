import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NextResponse } from "next/server";
import { getAuthUser, isAdmin, isTrustedMutationRequest } from "@/lib/auth";
import { modelPreviewExists, readStoredModels } from "@/lib/showcaseModels";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

const run = promisify(execFile);
type PreviewJob = { status: "idle" | "running" | "done" | "error"; count: number; error?: string; startedAt?: number; finishedAt?: number };
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
  return NextResponse.json(job());
}

export async function POST(request: Request) {
  const auth = authorize(request);
  if (auth.error) return auth.error;
  if (!isTrustedMutationRequest(request)) return NextResponse.json({ error: "请求来源不可信" }, { status: 403 });
  if (job().status === "running") return NextResponse.json(job(), { status: 202 });
  if (!rateLimit(`showcase-previews:${clientIp(request)}`, 6, 60 * 60 * 1000) || !rateLimitGlobal("showcase-previews", 12, 60 * 60 * 1000)) {
    return NextResponse.json({ error: "生成操作过于频繁，请稍后再试" }, { status: 429 });
  }
  runtime.__showcasePreviewJob = { status: "running", count: 0, startedAt: Date.now() };
  void run(process.execPath, [path.join(process.cwd(), "scripts", "build-showcase-previews.mjs")], {
      cwd: process.cwd(),
      timeout: 9 * 60 * 1000,
      maxBuffer: 8 * 1024 * 1024
    }).then(() => {
    const generated = readStoredModels().filter((model) => modelPreviewExists(model.file));
    runtime.__showcasePreviewJob = { status: "done", count: generated.length + 1, startedAt: job().startedAt, finishedAt: Date.now() };
  }).catch((err) => {
    const detail = err instanceof Error ? err.message : String(err);
    runtime.__showcasePreviewJob = { status: "error", count: 0, error: `生成失败：${detail.slice(0, 300)}`, startedAt: job().startedAt, finishedAt: Date.now() };
  });
  return NextResponse.json(runtime.__showcasePreviewJob, { status: 202 });
}
