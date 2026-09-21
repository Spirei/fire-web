import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getAuthUser, isAdmin, isTrustedMutationRequest } from "@/lib/auth";
import { PREVIEWS_DIR, readStoredModels, validModelId } from "@/lib/showcaseModels";
import { SHOWCASE_MODELS } from "@/components/showcase/presets/models";
import { inspectGlb } from "@/lib/glbInspect";
import { readBinaryBody, RequestBodyTooLargeError } from "@/lib/requestBody";
import { clientIp, rateLimit } from "@/lib/rateLimit";
export const dynamic = "force-dynamic";

/** Store a locally generated preview. No encoder, subprocess or background task. */
export async function POST(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!isAdmin(user) || !isTrustedMutationRequest(request)) return NextResponse.json({ error: "无权上传预览" }, { status: 403 });
  if (!rateLimit(`showcase-preview-upload:${clientIp(request)}`, 30, 3600000)) return NextResponse.json({ error: "上传过于频繁" }, { status: 429 });
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!validModelId(id)) return NextResponse.json({ error: "车型不存在" }, { status: 404 });
  const builtin = SHOWCASE_MODELS.find(model => model.id === id);
  const model = readStoredModels().find(model => model.id === id);
  if (!builtin && !model) return NextResponse.json({ error: "车型不存在" }, { status: 404 });
  const filename = builtin ? `builtin-${id}-preview.glb` : `${model!.file.replace(/\.glb$/i, "")}-preview.glb`;
  const temporary = path.join(PREVIEWS_DIR, `.${randomUUID()}.glb`);
  try {
    const bytes = await readBinaryBody(request, 32 * 1024 * 1024);
    const header = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (header.length < 20 || header.readUInt32LE(0) !== 0x46546c67 || header.readUInt32LE(4) !== 2 || header.readUInt32LE(8) !== header.length) return NextResponse.json({ error: "GLB 文件不完整或格式不正确" }, { status: 400 });
    await fs.mkdir(PREVIEWS_DIR, { recursive: true });
    await fs.writeFile(temporary, bytes, { flag: "wx" });
    const report = await inspectGlb(temporary);
    if (!report.ok || !report.info.meshes.length) return NextResponse.json({ error: report.errors.join("；") || "预览中没有模型" }, { status: 400 });
    if (report.info.maxImageSize > 1024) return NextResponse.json({ error: "请选择本地导出的 1K 首页预览，不要上传高清优化版" }, { status: 400 });
    if (!builtin && readStoredModels().find(item => item.id === id)?.file !== model!.file) return NextResponse.json({ error: "车型已变更，请重新选择" }, { status: 409 });
    await fs.rename(temporary, path.join(PREVIEWS_DIR, filename));
    // Offline fingerprints describe the old preview and must not outlive replacement.
    await fs.rm(path.join(PREVIEWS_DIR, `${filename}.json`), { force: true }).catch(() => {});
    return NextResponse.json({ preview: `/uploads/mclaren/previews/${encodeURIComponent(filename)}?v=${Date.now()}` });
  } catch (error) {
    return NextResponse.json({ error: error instanceof RequestBodyTooLargeError ? "首页预览不能超过 32 MiB" : "预览保存失败，请检查 GLB 文件" }, { status: error instanceof RequestBodyTooLargeError ? 413 : 400 });
  } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
}
