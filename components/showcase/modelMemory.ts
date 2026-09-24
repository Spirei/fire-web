import type { Object3D, Material, Texture, BufferGeometry } from "three";
import type { GLTFParser } from "three/addons/loaders/GLTFLoader.js";

/** iPad 搭配鼠标时 primary pointer 可变成 fine，仍需识别为触屏设备控制加载峰值。 */
export function constrainedGraphics(): boolean {
  if (typeof navigator === "undefined") return false;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return (typeof matchMedia === "function" && matchMedia("(any-pointer: coarse)").matches)
    || (navigator.maxTouchPoints > 1 && /Macintosh|iPad|iPhone|Android|Mobile/i.test(navigator.userAgent))
    || (typeof memory === "number" && memory <= 4);
}

/** 所有档位尊重用户选择，只服从 GPU 的真实硬件尺寸上限。 */
export function textureLimit(requested: number, hardware: number): number {
  return Math.min(requested, hardware);
}

/** 仅已确认有问题的 MP4/5 原画需要移动端 GPU 压缩副本。 */
export function requiresOriginalGpu(asset: string, requested: number, constrained: boolean): boolean {
  return constrained && requested > 4096 && /(?:^|\/)mclaren_mp45__formula_1(?:-uastc)?\.glb(?:[?#]|$)/i.test(asset);
}

type Quality = "fast" | "balanced" | "fine" | "original";
type QualityHistory = { working: Quality[]; failed: Quality[] };
const QUALITY_HISTORY_KEY = "fire:showcase:working-quality:";
function qualityHistory(asset: string): QualityHistory {
  try {
    const value = JSON.parse(sessionStorage.getItem(QUALITY_HISTORY_KEY + asset) ?? "null");
    const valid = (q: unknown): q is Quality => ["fast", "balanced", "fine", "original"].includes(q as string);
    return { working: (value?.working ?? []).filter(valid), failed: (value?.failed ?? []).filter(valid) };
  } catch { return { working: [], failed: [] }; }
}
function saveQualityHistory(asset: string, value: QualityHistory) {
  try { sessionStorage.setItem(QUALITY_HISTORY_KEY + asset, JSON.stringify(value)); } catch { /* 无成功记录就提示重试，不猜测低画质 */ }
}
/** 只有模型成功挂载并渲染后，才登记这辆车实际可用的画质。 */
export function rememberWorkingQuality(asset: string, quality: Quality) {
  const history = qualityHistory(asset);
  history.working = [quality, ...history.working.filter(q => q !== quality)].slice(0, 4);
  history.failed = history.failed.filter(q => q !== quality);
  saveQualityHistory(asset, history);
}
/** 仅由已确认的图形上下文/渲染异常调用；普通刷新绝不调用。 */
export function recoveryQuality(asset: string, failed: Quality): Quality | null {
  const history = qualityHistory(asset);
  if (!history.failed.includes(failed)) history.failed.push(failed);
  saveQualityHistory(asset, history);
  return history.working.find(q => !history.failed.includes(q)) ?? null;
}

/** 跨场景串行：旧场景未完成的解码不能与重建 / 下一辆车同时抢内存。 */
let modelQueue: Promise<unknown> = Promise.resolve();
export function queueModelLoad<T>(load: () => Promise<T>, timeoutMs = 0, signal?: AbortSignal): Promise<T> {
  const task = modelQueue.then(() => {
    if (signal?.aborted) throw new Error("模型加载已取消");
    if (timeoutMs <= 0 && !signal) return load();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const racers: Promise<T>[] = [load()];
    if (timeoutMs > 0) racers.push(new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("高清模型解析超时，请重试或切回 4K")), timeoutMs);
    }));
    if (signal) racers.push(new Promise<T>((_resolve, reject) => {
      onAbort = () => reject(new Error("模型加载已取消"));
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    }));
    return Promise.race(racers).finally(() => {
      if (timer) clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    });
  });
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
export function budgetImageDecoding(parser: GLTFParser, limit: number, current: () => boolean, onError?: (error: unknown) => void, yieldBetweenImages = false, onSourceSize?: (size: number) => void) {
  const original = parser.loadImageSource.bind(parser);
  const sources = new Map<number, Promise<Texture>>();
  const loaded = new Set<Texture>();
  let queue: Promise<unknown> = Promise.resolve();
  let imageCount = 0;
  parser.loadImageSource = (index, loader) => {
    const cached = sources.get(index);
    if (cached) return cached.then(texture => texture.clone());
    const task = queue.then(async () => {
      // 手机高清模型的贴图逐张处理，任务之间交还一帧给输入和渲染，避免连续解码锁住页面。
      if (yieldBetweenImages && imageCount++ > 0) {
        await new Promise<void>(resolve => {
          if (document.hidden) window.setTimeout(resolve, 0);
          else window.requestAnimationFrame(() => resolve());
        });
      }
      if (!current()) throw new Error("模型加载已取消");
      const texture = await original(index, loader);
      loaded.add(texture);
      if (!current()) { releaseTextures([texture]); throw new Error("模型加载已取消"); }
      onSourceSize?.(Math.max(texture.image?.width ?? 0, texture.image?.height ?? 0));
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
