import type { ShowcaseConfig } from "./types";
import { constrainedGraphics, requiresOriginalGpu } from "./modelMemory";

type Quality = "fast" | "balanced" | "fine" | "original";

/** 4K 与同源原画共用完整 GLB；只在触屏设备确实需要高于 4K 的压缩源时换文件。 */
export function fullQualityAsset(config: ShowcaseConfig, quality: Quality): string {
  if (quality !== "original" || !config.assets.gpuModel || !constrainedGraphics()) return config.assets.model;
  const mustUseGpu = requiresOriginalGpu(config.assets.model, 16384, true);
  if (mustUseGpu || (config.assets.gpuTextureMax ?? 0) > 4096) return config.assets.gpuModel;
  return config.assets.model;
}
