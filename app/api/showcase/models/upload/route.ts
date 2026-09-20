import fs from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { getAuthUser, isAdmin, isTrustedMutationRequest } from "@/lib/auth";
import { inspectGlb } from "@/lib/glbInspect";
import { MODELS_DIR, draftModelFile, validModelFile } from "@/lib/showcaseModels";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";
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
  // 车型是首页对外的公共内容（模型经 /uploads 公开可下载），导入 / 覆盖一律限管理员
  if (!isAdmin(user)) return NextResponse.json({ error: "只有管理员能导入车型" }, { status: 403 });
  if (!isTrustedMutationRequest(request)) return NextResponse.json({ error: "请求来源不可信" }, { status: 403 });
  if (!rateLimit(`showcase-model-upload:${clientIp(request)}`, 20, 60 * 60 * 1000)) {
    return NextResponse.json({ error: "上传过于频繁，请稍后再试" }, { status: 429 });
  }
  // 单个 IP 之外再加一道全站闸门：一次 260MB，防止换 IP 把 uploads 卷写满
  if (!rateLimitGlobal("showcase-model-upload", 40, 60 * 60 * 1000)) {
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
  // 先落草稿：只有完成预览并点“保存上线”才会原子改名进正式清单；放弃操作不会误上线或覆盖旧车。
  const draftName = draftModelFile(rawName);
  const dest = path.join(MODELS_DIR, draftName);
  // 临时名带随机后缀：同名并发上传不会互相写同一个 .part（否则可能双双落成半截文件）
  const tmp = `${dest}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.part`;
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
    file: draftName,
    url: `/uploads/mclaren/models/${encodeURIComponent(draftName)}`,
    bytes,
    suggested: {
      id: slugFromFile(rawName),
      label: rawName.replace(/\.glb$/i, "").slice(0, 24),
      note: new Date().getFullYear().toString()
    },
    report
  });
}
