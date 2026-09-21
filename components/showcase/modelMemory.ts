import type { Object3D, Material, Texture, BufferGeometry } from "three";
import type { GLTFParser } from "three/addons/loaders/GLTFLoader.js";

/** iPad 搭配鼠标时 primary pointer 可变成 fine，仍必须使用触屏内存预算。 */
export function constrainedGraphics(): boolean {
  if (typeof navigator === "undefined") return false;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return (typeof matchMedia === "function" && matchMedia("(any-pointer: coarse)").matches)
    || (navigator.maxTouchPoints > 1 && /Macintosh|iPad|iPhone|Android|Mobile/i.test(navigator.userAgent))
    || (typeof memory === "number" && memory <= 4);
}

/** 限制整辆车的解码像素总量，不能只检查 GPU 支持的单张纹理尺寸。 */
export function textureLimit(requested: number, hardware: number, images: number, constrained: boolean): number {
  // 原画不偷偷缩图；受限设备通过 GPU 压缩资源保留原尺寸。
  if (requested > 4096) return Math.min(requested, hardware);
  const budget = constrained ? 16 * 1024 * 1024 : Infinity;
  const perImage = Math.sqrt(budget / Math.max(1, images));
  const limit = Math.min(requested, hardware, constrained ? 2048 : Infinity, perImage);
  return Math.max(1, 2 ** Math.floor(Math.log2(Math.max(1, limit))));
}

/** PNG / JPEG 的像素预算只读文件头，不先解码大图；未知格式交给调用方保守处理。 */
export function decodedTextureBytes(buffer: ArrayBuffer): number | null {
  try {
    const view = new DataView(buffer);
    if (view.getUint32(0, true) !== 0x46546c67) return null;
    const length = view.getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, length)));
    const bin = 20 + length + 8;
    let bytes = 0;
    for (const image of json.images ?? []) {
      const range = json.bufferViews?.[image.bufferView];
      if (!range || (range.buffer ?? 0) !== 0) return null;
      const data = new DataView(buffer, bin + (range.byteOffset ?? 0), range.byteLength);
      let width = 0, height = 0;
      if (data.getUint32(0) === 0x89504e47) {
        width = data.getUint32(16); height = data.getUint32(20);
      } else if (data.getUint16(0) === 0xffd8) {
        let offset = 2;
        while (offset + 4 < data.byteLength) {
          if (data.getUint8(offset++) !== 0xff) return null;
          while (data.getUint8(offset) === 0xff) offset++;
          const marker = data.getUint8(offset++);
          if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
            height = data.getUint16(offset + 3); width = data.getUint16(offset + 5); break;
          }
          if (marker === 0xda || marker === 0xd9) break;
          offset += data.getUint16(offset);
        }
      }
      if (!width || !height) return null;
      bytes += width * height * 4 * 4 / 3; // RGBA + 完整 mip 链的保守估算
    }
    return bytes;
  } catch { return null; }
}

/** 跨场景串行：旧场景未完成的解码不能与重建 / 下一辆车同时抢内存。 */
let modelQueue: Promise<unknown> = Promise.resolve();
export function queueModelLoad<T>(load: () => Promise<T>): Promise<T> {
  const task = modelQueue.then(load);
  modelQueue = task.catch(() => {});
  return task;
}

function releaseImage(image: unknown) {
  if (!image || typeof image !== "object") return;
  if ("close" in image && typeof image.close === "function") image.close();
  else if (typeof HTMLCanvasElement !== "undefined" && image instanceof HTMLCanvasElement) {
    image.width = image.height = 1;
  }
}

export function releaseTextures(textures: Iterable<Texture>) {
  const images = new Set<unknown>();
  for (const texture of new Set(textures)) {
    images.add(texture.image);
    texture.dispose();
  }
  images.forEach(releaseImage);
}

/** 不动查看器的活动车状态，供过期解析结果与真正卸载共用。 */
export function disposeModel(model: Object3D) {
  model.removeFromParent?.();
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  model.traverse(object => {
    const mesh = object as Object3D & { geometry?: BufferGeometry; material?: Material | Material[] };
    if (mesh.geometry) geometries.add(mesh.geometry);
    for (const material of mesh.material ? (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) : []) materials.add(material);
  });
  for (const material of materials) {
    for (const [key, value] of Object.entries(material)) {
      // 环境纹理由场景共享，不能随车释放。
      if (key !== "envMap" && value?.isTexture) textures.add(value);
    }
    material.dispose();
  }
  geometries.forEach(geometry => geometry.dispose());
  releaseTextures(textures);
}

/** 原 loader 会并发解码全部 4K 图；在源图片级排队，缩完并释放原图才解下一张。
 * source 复用发生在缩图之后，法线 / 金属度等共享同一图时不会读到已关闭的 bitmap。
 */
export function budgetImageDecoding(parser: GLTFParser, limit: number, current: () => boolean, onError?: (error: unknown) => void) {
  const original = parser.loadImageSource.bind(parser);
  const sources = new Map<number, Promise<Texture>>();
  const loaded = new Set<Texture>();
  let queue: Promise<unknown> = Promise.resolve();
  parser.loadImageSource = (index, loader) => {
    const cached = sources.get(index);
    if (cached) return cached.then(texture => texture.clone());
    const task = queue.then(async () => {
      if (!current()) throw new Error("模型加载已取消");
      const texture = await original(index, loader);
      loaded.add(texture);
      if (!current()) { releaseTextures([texture]); throw new Error("模型加载已取消"); }
      if ((texture as Texture & { isCompressedTexture?: boolean }).isCompressedTexture) {
        if (Math.max(texture.image.width, texture.image.height) > limit) throw new Error("当前设备不支持源贴图尺寸，请使用流畅模式");
        return texture;
      }
      const image = texture.image as CanvasImageSource & { width: number; height: number };
      const scale = Math.min(1, limit / Math.max(image.width, image.height));
      if (scale < 1) {
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        const context = canvas.getContext("2d");
        if (!context) throw new Error("设备内存不足，无法处理模型贴图");
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        texture.image = canvas;
        texture.needsUpdate = true;
        releaseImage(image);
      }
      return texture;
    });
    sources.set(index, task);
    queue = task.catch(error => { onError?.(error); });
    return task;
  };
  return () => releaseTextures(loaded);
}

const LOAD_GUARD_KEY = "fire:showcase:pending-heavy-load";
export function beginHeavyLoad(asset: string): string {
  const token = `${Date.now()}:${Math.random()}`;
  try { sessionStorage.setItem(LOAD_GUARD_KEY, JSON.stringify({ asset, token })); } catch { /* 隐私模式仍可正常加载 */ }
  return token;
}
export function finishHeavyLoad(token: string) {
  try {
    if (JSON.parse(sessionStorage.getItem(LOAD_GUARD_KEY) ?? "null")?.token === token) sessionStorage.removeItem(LOAD_GUARD_KEY);
  } catch { /* 存储不可用 */ }
}
export function interruptedHeavyLoad(asset: string): boolean {
  try {
    const pending = JSON.parse(sessionStorage.getItem(LOAD_GUARD_KEY) ?? "null");
    if (pending?.asset !== asset) return false;
    sessionStorage.removeItem(LOAD_GUARD_KEY);
    return true;
  } catch { return false; }
}
