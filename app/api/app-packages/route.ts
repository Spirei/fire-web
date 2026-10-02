import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getAuthUser, isAdmin, isTrustedMutationRequest } from "@/lib/auth";
import { PACKAGE_LIMIT, packageRoot, metadataRoot, listPackages } from "@/lib/appPackages";
import { rateLimit } from "@/lib/rateLimit";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  if (!isAdmin(getAuthUser(request))) return Response.json({ error: "仅管理员可访问内部安装包" }, { status: 403 });
  return Response.json({ packages: await listPackages(), maxBytes: PACKAGE_LIMIT, canUpload: isAdmin(getAuthUser(request)) });
}
export async function POST(request: Request) {
  const user = getAuthUser(request);
  if (!user) return Response.json({ error: "请先登录管理员账号" }, { status: 401 });
  if (!isAdmin(user)) return Response.json({ error: "仅管理员可以上传安装包" }, { status: 403 });
  if (!isTrustedMutationRequest(request)) return Response.json({ error: "请求来源不可信" }, { status: 403 });
  if (!rateLimit(`app-package:${user.id}`, 20, 3600000)) return Response.json({ error: "上传过于频繁" }, { status: 429 });
  let name: string;
  try { name = decodeURIComponent(request.headers.get("x-file-name") || ""); } catch { return Response.json({ error: "文件名无效" }, { status: 400 }); }
  if (!name || name.length > 240 || /[\\/\x00-\x1f\x7f]/.test(name) || !/\.(apk|ipa)$/i.test(name)) return Response.json({ error: "请选择 APK 或 IPA 安装包" }, { status: 400 });
  const size = Number(request.headers.get("content-length"));
  if (!Number.isSafeInteger(size) || size <= 0 || size > PACKAGE_LIMIT || !request.body) return Response.json({ error: "安装包需大于 0 字节且不超过 2 GB" }, { status: 413 });
  const id = randomUUID().replaceAll("-", "");
  // Pending bytes stay outside public uploads until the complete stream is validated.
  await fs.mkdir(metadataRoot, { recursive: true });
  await fs.mkdir(packageRoot, { recursive: true });
  const pending = path.join(metadataRoot, id + ".part");
  const target = path.join(packageRoot, id);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let moved = false;
  const reader = request.body.getReader();
  try {
    handle = await fs.open(pending, "wx");
    let received = 0; let signature = Buffer.alloc(0);
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      received += value.byteLength;
      if (received > size || received > PACKAGE_LIMIT) throw new Error("安装包大小超出限制");
      if (signature.length < 4) signature = Buffer.concat([signature, Buffer.from(value)]).subarray(0, 4);
      let offset = 0;
      while (offset < value.length) { const result = await handle.write(value, offset, value.length - offset); offset += result.bytesWritten; }
    }
    await handle.close(); handle = undefined;
    if (received !== size || !signature.equals(Buffer.from([0x50,0x4b,0x03,0x04]))) throw new Error("安装包不完整或不是有效的 ZIP 格式");
    const current = getAuthUser(request);
    if (!current || current.id !== user.id || !isAdmin(current)) throw new Error("管理员登录已失效");
    const item = { id, name, size, platform: /\.apk$/i.test(name) ? "Android" : "iOS", createdAt: new Date().toISOString() };
    // data and uploads are separate Docker mounts; rename across them can fail with EXDEV.
    await fs.copyFile(pending, target + ".part", fs.constants.COPYFILE_EXCL);
    await fs.rename(target + ".part", target); moved = true;
    await fs.rm(pending);
    await fs.writeFile(path.join(metadataRoot, id + ".json"), JSON.stringify(item), { flag: "wx" });
    return Response.json(item, { status: 201 });
  } catch (error) {
    await reader.cancel().catch(() => {}); await handle?.close().catch(() => {});
    await fs.rm(pending, { force: true }); await fs.rm(target + ".part", { force: true }); if (moved) await fs.rm(target, { force: true });
    return Response.json({ error: error instanceof Error && !('code' in error) ? error.message : "保存失败，请稍后重试" }, { status: 400 });
  } finally { reader.releaseLock(); }
}
