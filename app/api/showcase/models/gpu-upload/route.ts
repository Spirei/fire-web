import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getAuthUser, isAdmin, isTrustedMutationRequest } from "@/lib/auth";
import { inspectGlb } from "@/lib/glbInspect";
import { MODELS_DIR, SHOWROOM_DIR, readStoredModels, validModelId } from "@/lib/showcaseModels";
import { SHOWCASE_MODELS } from "@/components/showcase/presets/models";
import { readBinaryBody, RequestBodyTooLargeError } from "@/lib/requestBody";
import { clientIp, rateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";
const MAX_GPU_BYTES = 96 * 1024 * 1024;

async function sha256File(file: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/** Upload only a locally generated, same-model GPU derivative; never replace the source GLB. */
export async function POST(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!isAdmin(user) || !isTrustedMutationRequest(request)) return NextResponse.json({ error: "无权上传高清副本" }, { status: 403 });
  if (!rateLimit(`showcase-gpu-upload:${clientIp(request)}`, 12, 3_600_000)) return NextResponse.json({ error: "上传过于频繁" }, { status: 429 });
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!validModelId(id)) return NextResponse.json({ error: "车型不存在" }, { status: 404 });
  const builtin = SHOWCASE_MODELS.find(model => model.id === id);
  const stored = readStoredModels().find(model => model.id === id);
  if (!builtin && !stored) return NextResponse.json({ error: "车型不存在" }, { status: 404 });
  const source = builtin
    ? path.join(process.cwd(), "public", builtin.config.assets.model.split("?")[0])
    : path.join(MODELS_DIR, stored!.file);
  const filename = builtin ? `builtin-${id}-uastc.glb` : `${stored!.file.replace(/\.glb$/i, "")}-uastc.glb`;
  const directory = path.join(SHOWROOM_DIR, "gpu");
  const temporary = path.join(directory, `.${randomUUID()}.glb`);
  try {
    const bytes = await readBinaryBody(request, MAX_GPU_BYTES);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(temporary, bytes, { flag: "wx" });
    const [original, packed, sourceStat] = await Promise.all([inspectGlb(source), inspectGlb(temporary), fs.stat(source)]);
    const required = packed.info.extensionsRequired;
    const sameImages = original.info.images.length === packed.info.images.length
      && original.info.images.every((image, index) => image.width === packed.info.images[index]?.width && image.height === packed.info.images[index]?.height);
    const sameTopology = original.info.meshes.length === packed.info.meshes.length
      && original.info.meshes.every((mesh, index) => mesh.primitives === packed.info.meshes[index]?.primitives)
      && original.info.totalVertices === packed.info.totalVertices
      && original.info.totalTriangles === packed.info.totalTriangles;
    if (!original.ok || !packed.ok || !sameImages || !sameTopology || packed.info.images.length === 0
      || !required.includes("KHR_texture_basisu")
      || packed.info.images.some(image => image.mime !== "image/ktx2" || !image.width || !image.height)) {
      return NextResponse.json({ error: "高清副本与原车型的网格或贴图尺寸不一致，或不是完整的 KTX2/UASTC GLB" }, { status: 422 });
    }
    if (!builtin && readStoredModels().find(model => model.id === id)?.file !== stored!.file) {
      return NextResponse.json({ error: "车型已变更，请重新选择" }, { status: 409 });
    }
    const outputSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    const manifest = {
      sourceBytes: sourceStat.size,
      sourceMtimeMs: sourceStat.mtimeMs,
      sourceSha256: await sha256File(source),
      outputBytes: bytes.byteLength,
      outputSha256,
      mode: required.includes("EXT_meshopt_compression") ? "UASTC + Meshopt mobile RAW" : "UASTC mobile RAW",
      preservesTextureDimensions: true,
      preservesTopology: true,
      pixelLossless: false,
      verified: { textures: packed.info.images.map(image => ({ width: image.width, height: image.height })) },
      generatedAt: new Date().toISOString()
    };
    const destination = path.join(directory, filename);
    // Keep the previous validated sidecar as a one-step rollback, including its manifest.
    if (await fs.stat(destination).then(() => true, () => false)) {
      await fs.copyFile(destination, `${destination}.previous`);
      await fs.copyFile(`${destination}.json`, `${destination}.json.previous`);
    }
    const currentSource = await fs.stat(source);
    if (currentSource.size !== sourceStat.size || currentSource.mtimeMs !== sourceStat.mtimeMs) {
      return NextResponse.json({ error: "原车型在校验期间发生变化，请重试" }, { status: 409 });
    }
    await fs.rename(temporary, destination);
    await fs.writeFile(`${destination}.json`, JSON.stringify(manifest, null, 2));
    return NextResponse.json({ gpu: `/uploads/mclaren/gpu/${encodeURIComponent(filename)}?v=${Date.now()}`, bytes: bytes.byteLength });
  } catch (error) {
    return NextResponse.json({ error: error instanceof RequestBodyTooLargeError ? "高清副本不能超过 96 MiB" : "高清副本上传或校验失败" }, { status: error instanceof RequestBodyTooLargeError ? 413 : 400 });
  } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
}
