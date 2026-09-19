import fs from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { getAuthUser, isTrustedMutationRequest } from "@/lib/auth";
import { inspectGlb } from "@/lib/glbInspect";
import { MODELS_DIR, validModelFile } from "@/lib/showcaseModels";
import { clientIp, rateLimit } from "@/lib/rateLimit";
import { logSecurityEvent } from "@/lib/securityAudit";

export const dynamic = "force-dynamic";
/** 车模动辄上百 MB，上传要给足时间（Node runtime，不能跑在 Edge） */
export const maxDuration = 600;

const MAX_BYTES = 260 * 1024 * 1024;

/** 边收边写盘：不把整份模型读进内存，避免大文件把容器内存顶爆 */
async function streamToFile(body: ReadableStream<Uint8Array> | null, dest: string, maxBytes: number) {
  if (!body) throw new Error("没有收到文件内容");
  const reader = body.getReader();
  const out = fs.createWriteStream(dest);
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error(`文件超过 ${Math.round(maxBytes / 1048576)}MB 上限`);
      if (!out.write(Buffer.from(value))) {
        await new Promise<void>((resolve) => out.once("drain", () => resolve()));
      }
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
    return total;
  } catch (err) {
    out.destroy();
    await fs.promises.rm(dest, { force: true });
    await reader.cancel().catch(() => undefined);
    throw err;
  }
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
  // 只要登录就能导入车型（素材落在 uploads 卷里，不对外分发）
  if (!isTrustedMutationRequest(request)) return NextResponse.json({ error: "请求来源不可信" }, { status: 403 });
  if (!rateLimit(`showcase-model-upload:${clientIp(request)}`, 20, 60 * 60 * 1000)) {
    return NextResponse.json({ error: "上传过于频繁，请稍后再试" }, { status: 429 });
  }
  const url = new URL(request.url);
  const rawName = decodeURIComponent(url.searchParams.get("name") ?? "").trim();
  if (!validModelFile(rawName)) {
    return NextResponse.json({ error: "只支持 .glb 单文件（文件名用英文、数字、-、_、.）" }, { status: 400 });
  }
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared && declared > MAX_BYTES) {
    return NextResponse.json({ error: `文件超过 ${Math.round(MAX_BYTES / 1048576)}MB 上限` }, { status: 413 });
  }
  fs.mkdirSync(MODELS_DIR, { recursive: true });
  const dest = path.join(MODELS_DIR, rawName);
  const tmp = `${dest}.part`;
  let bytes = 0;
  try {
    bytes = await streamToFile(request.body, tmp, MAX_BYTES);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "上传失败" }, { status: 400 });
  }
  // 先体检再落盘：不通过（Draco / KTX2 / 损坏）的直接丢掉，避免占着 uploads 卷还得手删
  let report;
  try {
    report = await inspectGlb(tmp, rawName);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true });
    return NextResponse.json(
      { error: `文件不是有效的 glb：${err instanceof Error ? err.message : String(err)}` },
      { status: 400 }
    );
  }
  if (!report.ok) {
    await fs.promises.rm(tmp, { force: true });
    return NextResponse.json({ error: "体检未通过，文件已丢弃", report }, { status: 422 });
  }
  await fs.promises.rename(tmp, dest);
  logSecurityEvent(request, user.id, "showcase_model_upload", `${rawName}:${bytes}`);
  return NextResponse.json({
    file: rawName,
    url: `/uploads/mclaren/models/${encodeURIComponent(rawName)}`,
    bytes,
    suggested: {
      id: slugFromFile(rawName),
      label: rawName.replace(/\.glb$/i, "").slice(0, 24),
      note: new Date().getFullYear().toString()
    },
    report
  });
}
