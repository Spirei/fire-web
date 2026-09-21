import fs from "fs";
import path from "path";
import os from "os";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { NextResponse } from "next/server";
import { getAuthUser, isAdmin, isTrustedMutationRequest } from "@/lib/auth";
import { inspectGlb } from "@/lib/glbInspect";
import { validModelFile } from "@/lib/showcaseModels";
import { commitShowcaseImport } from "@/lib/showcaseImport";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";
import { logSecurityEvent } from "@/lib/securityAudit";

export const dynamic = "force-dynamic";
/** 车模动辄上百 MB，上传要给足时间（Node runtime，不能跑在 Edge） */
export const maxDuration = 600;

const MAX_BYTES = 250 * 1024 * 1024;

/** 边收边写盘：不把整份模型读进内存，避免大文件把容器内存顶爆 */
async function streamToFile(body: ReadableStream<Uint8Array> | null, dest: string, maxBytes: number) {
  if (!body) throw new Error("没有收到文件内容");
  let total = 0;
  await pipeline(Readable.fromWeb(body as import("stream/web").ReadableStream), async function* (source) {
    for await (const chunk of source) {
      total += chunk.length;
      if (total > maxBytes) throw new Error(`文件超过 ${Math.round(maxBytes / 1048576)}MB 上限`);
      yield chunk;
    }
  }, fs.createWriteStream(dest, { flags: "wx" }));
  return total;
}

/** 只从文件名生成安全 slug：车型代号默认取文件名，导入向导里可改 */
function slugFromFile(file: string) {
  return file
    .replace(/\.glb$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "model";
}

export async function POST(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  // 车型是首页对外的公共内容（模型经 /uploads 公开可下载），导入 / 覆盖一律限管理员
  if (!isAdmin(user)) return NextResponse.json({ error: "只有管理员能导入车型" }, { status: 403 });
  if (!isTrustedMutationRequest(request)) return NextResponse.json({ error: "请求来源不可信" }, { status: 403 });
  if (!rateLimit(`showcase-model-upload:${clientIp(request)}`, 20, 60 * 60 * 1000)) {
    return NextResponse.json({ error: "上传过于频繁，请稍后再试" }, { status: 429 });
  }
  // 单个 IP 之外再加一道全站闸门：一次 250MB，防止换 IP 把 uploads 卷写满
  if (!rateLimitGlobal("showcase-model-upload", 40, 60 * 60 * 1000)) {
    return NextResponse.json({ error: "上传过于频繁，请稍后再试" }, { status: 429 });
  }
  const url = new URL(request.url);
  const rawName = (url.searchParams.get("name") ?? "").trim();
  if (!validModelFile(rawName)) {
    return NextResponse.json({ error: "只支持 .glb 单文件（文件名用英文、数字、-、_、.）" }, { status: 400 });
  }
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared && declared > MAX_BYTES) {
    return NextResponse.json({ error: `文件超过 ${Math.round(MAX_BYTES / 1048576)}MB 上限` }, { status: 413 });
  }
  let metadata: Parameters<typeof commitShowcaseImport>[2] | null = null;
  const saveHeader = request.headers.get("x-showcase-model");
  if (saveHeader) {
    try {
      if (saveHeader.length > 12_000) throw new Error();
      const input = JSON.parse(decodeURIComponent(saveHeader));
      if (!input || typeof input.id !== "string" || typeof input.label !== "string" || typeof input.note !== "string" || !input.params || typeof input.params !== "object") throw new Error();
      metadata = input;
    } catch { return NextResponse.json({ error: "车型参数格式不正确" }, { status: 400 }); }
  }
  // 体检文件不进入 uploads，也不提供公开地址；成功、取消和失败都在 finally 回收。
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "fire-model-inspect-"));
  const tmp = path.join(tempDir, "model.glb");
  try {
    const bytes = await streamToFile(request.body, tmp, MAX_BYTES);
    const report = await inspectGlb(tmp, rawName);
    if (!report.ok) return NextResponse.json({ error: "体检未通过，临时文件已删除", report }, { status: 422 });
    if (request.signal.aborted) throw new Error("上传已取消");
    if (metadata) {
      const model = commitShowcaseImport(tmp, rawName, metadata);
      try { logSecurityEvent(request, user.id, "showcase_model_upload", `${model.file}:${bytes}`); } catch { /* 审计写入失败不能把已提交的车型报告为保存失败。 */ }
      return NextResponse.json({ model });
    }
    return NextResponse.json({
      file: rawName,
      bytes,
      suggested: { id: slugFromFile(rawName), label: rawName.replace(/\.glb$/i, "").slice(0, 24), note: new Date().getFullYear().toString() },
      report
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "上传失败" }, { status: 400 });
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}
