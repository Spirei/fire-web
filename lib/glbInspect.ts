/**
 * 车模体检：导入 .glb 之后先在服务端看一遍，把「导入后才发现不对」的问题挡在前面。
 *
 * 只读文件头与 JSON 块（不整份读进内存），因此上百 MB 的模型也能秒回：
 * 1) 12 字节 GLB 头 + 第一个 chunk（JSON）里的 glTF；
 * 2) 贴图尺寸只读每张图的前若干字节（PNG / JPEG / WebP / KTX2 头）；
 * 3) 归纳成「错误 / 提醒 / 建议参数」，导入向导照着显示。
 */
import fs from "fs";
import path from "path";
import { promisify } from "util";

const open = promisify(fs.open);
const read = promisify(fs.read);
const fstat = promisify(fs.stat);
const close = promisify(fs.close);

export interface GlbMaterialInfo {
  name: string;
  emissive?: [number, number, number];
  emissiveStrength?: number;
  clearcoat?: number;
  clearcoatRoughness?: number;
  metallic?: number;
  roughness?: number;
  alphaMode?: string;
  baseColorTexture?: boolean;
}

export interface GlbImageInfo {
  name: string;
  mime: string;
  bytes: number;
  width?: number;
  height?: number;
}

export interface GlbReport {
  file: string;
  bytes: number;
  ok: boolean;
  errors: string[];
  warnings: string[];
  notes: string[];
  info: {
    generator: string;
    materials: GlbMaterialInfo[];
    images: GlbImageInfo[];
    maxImageSize: number;
    imageBytes: number;
    meshes: Array<{ name: string; primitives: number; materials: string[] }>;
    nodeCount: number;
    animations: number;
    skins: number;
    extensionsUsed: string[];
    extensionsRequired: string[];
  };
  suggestions: {
    maxTextureSize: number;
    emissiveIntensity?: number;
    clearcoatRoughness?: number;
    wheelPattern?: string;
    materialNames: string[];
  };
}

const BLOCKING_EXTENSIONS: Record<string, string> = {
  KHR_draco_mesh_compression:
    "几何体用了 Draco 压缩，浏览器需要额外解码器。导出时关掉 Draco，或用 gltf-transform 解压后再导入。",
  EXT_meshopt_compression:
    "几何体用了 Meshopt 压缩，浏览器需要额外解码器。导出时关掉 Meshopt 压缩后再导入。",
  KHR_texture_basisu: "贴图是 KTX2/Basis 压缩格式，展示台不带解码器。导出时改成 PNG/JPG 贴图。",
  EXT_texture_webp: "贴图用了 WebP 扩展格式（部分浏览器解码失败），建议导出 PNG/JPG 版本。"
};

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  ktx2: "image/ktx2"
};

/** 只读几十字节就能拿到的贴图尺寸（PNG / JPEG / WebP / KTX2） */
function imageSize(buf: Buffer, mime: string): { width?: number; height?: number } {
  try {
    if (mime === "image/png" && buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (mime === "image/jpeg" && buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) {
          i += 1;
          continue;
        }
        const marker = buf[i + 1];
        const size = buf.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        i += 2 + size;
      }
    }
    if (mime === "image/webp" && buf.length > 30 && buf.toString("ascii", 0, 4) === "RIFF") {
      const format = buf.toString("ascii", 12, 16);
      if (format === "VP8X") return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      if (format === "VP8 ") return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      if (format === "VP8L") {
        const bits = buf.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
    }
    if (mime === "image/ktx2" && buf.length > 28) {
      return { width: buf.readUInt32LE(20), height: buf.readUInt32LE(24) };
    }
  } catch {
    /* 读不出尺寸不算致命 */
  }
  return {};
}

async function readAt(fd: number, offset: number, length: number) {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await read(fd, buf, 0, length, offset);
  return buf.subarray(0, bytesRead);
}

/** 读 GLB 头 + JSON 块，返回 glTF、文件长度与 BIN 块起点（用于后续按需读贴图头） */
async function readGlb(abs: string) {
  const fd = await open(abs, "r");
  try {
    const header = await readAt(fd, 0, 12);
    if (header.length < 12 || header.readUInt32LE(0) !== 0x46546c67) throw new Error("不是 glb 文件（文件头不是 glTF）");
    const version = header.readUInt32LE(4);
    const length = header.readUInt32LE(8);
    if (version !== 2) throw new Error(`glTF 版本是 ${version}，只支持 2.0`);
    const chunkHeader = await readAt(fd, 12, 8);
    const jsonLength = chunkHeader.readUInt32LE(0);
    const jsonType = chunkHeader.readUInt32LE(4);
    if (jsonType !== 0x4e4f534a) throw new Error("glb 的第一个数据块不是 JSON");
    if (jsonLength <= 0 || jsonLength > 64 * 1024 * 1024) throw new Error("glb 的 JSON 块异常");
    const json = await readAt(fd, 20, jsonLength);
    const binOffset = 20 + jsonLength;
    const binHeader = await readAt(fd, binOffset, 8);
    let binStart = binOffset;
    if (binHeader.length === 8 && binHeader.readUInt32LE(4) === 0x004e4942) binStart = binOffset + 8;
    // 有的导出器用 0x00 而不是空格补齐 JSON 块，JSON.parse 会在这里报错 —— 先削掉尾部的空白与 0
    const text = json.toString("utf8").replace(/[\s\u0000]+$/, "");
    return { gltf: JSON.parse(text) as Record<string, any>, length, binStart, fd };
  } catch (err) {
    await close(fd).catch(() => undefined);
    throw err;
  }
}

export async function inspectGlb(absPath: string, displayName?: string): Promise<GlbReport> {
  const file = displayName ?? path.basename(absPath);
  const stat = await fstat(absPath);
  const errors: string[] = [];
  const warnings: string[] = [];
  const notes: string[] = [];
  const opened = await readGlb(absPath);
  const gltf = opened.gltf;
  try {
    /**
     * 上限：JSON 块本身已被 readGlb 限制在 64MB，但一个 64MB 的 JSON 能塞进上百万条 images / meshes，
     * 逐条去磁盘读贴图头会把一次「上传体检」变成几十万次 IO。这里按参考模型的量级封顶，
     * 超出的条目直接忽略（不影响判定：模型早就不正常了）。
     */
    const MAX_ENTRIES = 400;
    const take = <T,>(list: unknown): T[] => (Array.isArray(list) ? (list.slice(0, MAX_ENTRIES) as T[]) : []);
    const views = take<{ byteOffset?: number; byteLength?: number }>(gltf.bufferViews);
    const images: GlbImageInfo[] = [];
    for (const [i, img] of take<Record<string, any>>(gltf.images).entries()) {
      const view = typeof img.bufferView === "number" ? views[img.bufferView] : undefined;
      const mime = String(img.mimeType ?? "unknown");
      let width: number | undefined;
      let height: number | undefined;
      const offset = Number(view?.byteOffset ?? 0);
      const viewBytes = Number(view?.byteLength ?? 0);
      // 偏移 / 长度必须是合理数字：负偏移或 NaN 会让 fs.read 抛错（并被当成「文件损坏」），
      // 超长偏移也没必要去读，直接跳过尺寸探测
      if (view && Number.isFinite(offset) && offset >= 0 && Number.isFinite(viewBytes) && viewBytes >= 0) {
        const head = await readAt(opened.fd, opened.binStart + offset, Math.min(viewBytes, 65536));
        ({ width, height } = imageSize(head, mime));
      }
      images.push({ name: String(img.name ?? `image_${i}`), mime, bytes: Number.isFinite(viewBytes) ? viewBytes : 0, width, height });
    }

    const materials: GlbMaterialInfo[] = take<Record<string, any>>(gltf.materials).map((mat) => {
      const pbr = mat.pbrMetallicRoughness ?? {};
      const ext = mat.extensions ?? {};
      return {
        name: String(mat.name ?? "未命名材质"),
        emissive: Array.isArray(mat.emissiveFactor) ? (mat.emissiveFactor as [number, number, number]) : undefined,
        emissiveStrength: ext.KHR_materials_emissive_strength?.emissiveStrength,
        clearcoat: ext.KHR_materials_clearcoat?.clearcoatFactor,
        clearcoatRoughness: ext.KHR_materials_clearcoat?.clearcoatRoughnessFactor,
        metallic: pbr.metallicFactor,
        roughness: pbr.roughnessFactor,
        alphaMode: mat.alphaMode,
        baseColorTexture: pbr.baseColorTexture !== undefined
      };
    });
    const materialNames = materials.map((m) => m.name);
    const meshes = take<Record<string, any>>(gltf.meshes).map((mesh) => {
      const mats = new Set<string>();
      for (const prim of mesh.primitives ?? []) {
        if (prim.material !== undefined && materialNames[prim.material]) mats.add(materialNames[prim.material]);
      }
      return { name: String(mesh.name ?? "未命名网格"), primitives: (mesh.primitives ?? []).length, materials: [...mats] };
    });
    const maxImageSize = images.reduce((max, img) => Math.max(max, img.width ?? 0, img.height ?? 0), 0);
    const imageBytes = images.reduce((sum, img) => sum + (img.bytes ?? 0), 0);
    const extensionsUsed: string[] = gltf.extensionsUsed ?? [];
    const extensionsRequired: string[] = gltf.extensionsRequired ?? [];

    for (const key of [...extensionsRequired, ...extensionsUsed]) {
      const hint = BLOCKING_EXTENSIONS[key];
      if (hint && !errors.includes(hint)) errors.push(hint);
    }
    if (opened.length !== stat.size) {
      notes.push(`文件头记录长度 ${opened.length} 字节、实际 ${stat.size} 字节，通常是导出中断，建议重新导出。`);
    }
    if (maxImageSize > 4096) {
      warnings.push(`贴图最长边 ${maxImageSize}px，超过 4096 会被自动压到 4096（显存与加载时间都会翻倍）。`);
    }
    const fat = images.filter((img) => (img.bytes ?? 0) > 12 * 1024 * 1024);
    if (fat.length) {
      warnings.push(
        `有 ${fat.length} 张贴图单张超过 12MB（最大 ${(Math.max(...fat.map((f) => f.bytes)) / 1048576).toFixed(1)}MB），首次加载会很慢。`
      );
    }
    if (!materials.length) errors.push("模型里没有任何材质，导入后会是纯灰模。");
    if (!meshes.length) errors.push("模型里没有任何网格。");
    if (!gltf.scenes || gltf.scene === undefined) errors.push("文件里没有默认场景，导入后看不到车（导出时请勾选场景）。");
    const emissive = materials.filter((m) => m.emissive && m.emissive.some((v) => v > 0.01));
    if (emissive.some((m) => (m.emissiveStrength ?? 1) > 1.2)) {
      warnings.push("发光材质强度大于 1.2（车灯 / 仪表容易糊成一团白），导入时会自动压到自然亮度。");
    }
    if ((gltf.animations ?? []).length > 0) {
      notes.push(`模型带 ${gltf.animations.length} 段动画：展示台只让轮子自转，其余动画会被忽略。`);
    }
    if (opened.length > 160 * 1024 * 1024) {
      warnings.push(`文件 ${(opened.length / 1048576).toFixed(0)}MB 偏大，手机端首次加载会比较久（贴图转无损 WebP 可以再压一截）。`);
    }
    const wheelMatches = materialNames.filter((name) => /wheel|tyre|tire|rim/i.test(name));
    if (!wheelMatches.length) {
      warnings.push("没有一眼认出的轮子材质名（wheel / tyre / rim）：导入向导里手动指定，否则轮子不会转。");
    }
    const mirrorCoat = materials.filter((m) => (m.clearcoat ?? 0) > 0.5 && (m.clearcoatRoughness ?? 1) < 0.12);
    if (mirrorCoat.length) {
      notes.push("清漆层接近镜面（clearcoatRoughness < 0.12）：导入后会自动抬到 0.3，避免灯光在车身上聚成一块死白。");
    }

    const wheelPattern = wheelMatches.length
      ? wheelMatches.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")
      : undefined;
    const emissiveStrength = emissive.length ? Math.min(...emissive.map((m) => m.emissiveStrength ?? 1)) : undefined;

    return {
      file,
      bytes: stat.size,
      ok: errors.length === 0,
      errors,
      warnings,
      notes,
      info: {
        generator: String(gltf.asset?.generator ?? "未知"),
        materials,
        images,
        maxImageSize,
        imageBytes,
        meshes,
        nodeCount: Array.isArray(gltf.nodes) ? gltf.nodes.length : 0,
        animations: (gltf.animations ?? []).length,
        skins: (gltf.skins ?? []).length,
        extensionsUsed,
        extensionsRequired
      },
      suggestions: {
        maxTextureSize: maxImageSize > 4096 ? 2048 : 4096,
        emissiveIntensity: emissiveStrength !== undefined && emissiveStrength > 1.2 ? 0.45 : undefined,
        clearcoatRoughness: mirrorCoat.length ? 0.3 : undefined,
        wheelPattern,
        materialNames
      }
    };
  } finally {
    await close(opened.fd).catch(() => undefined);
  }
}
