import type { ShowcaseConfig, ShowcaseHandle } from "./types";

function structureSignature(config: ShowcaseConfig) {
  const { emissiveIntensity: _emissive, clearcoatRoughness: _clearcoat, envMapIntensity: _env, ...model } = config.model ?? {};
  return JSON.stringify({ asset: config.assets.model, model }, (_key, value) => value instanceof RegExp ? { source: value.source, flags: value.flags } : value);
}

/** 按最新参数串行更新，只有成功挂载的模型才能成为材质快速更新的基准。 */
export function createPreviewUpdates(
  handle: Pick<ShowcaseHandle, "setModel" | "updateModelMaterials">,
  initial: ShowcaseConfig,
  callbacks: { ready: (config: ShowcaseConfig) => void; error: (message: string) => void }
) {
  let applied: ShowcaseConfig | null = initial;
  let pending: ShowcaseConfig | null = null;
  let running = false;
  let disposed = false;
  async function drain() {
    if (running || disposed) return;
    running = true;
    try {
      while (pending && !disposed) {
        const next: ShowcaseConfig = pending;
        pending = null;
        try {
          if (applied && structureSignature(applied) === structureSignature(next)) handle.updateModelMaterials(next.model);
          else if (!await handle.setModel({ asset: next.assets.model, model: next.model })) throw new Error("模型更新失败，请重试预览");
          if (disposed) return;
          applied = next;
          if (!pending) callbacks.ready(next);
        } catch (error) {
          applied = null;
          if (!disposed && !pending) callbacks.error(error instanceof Error ? error.message : "模型更新失败，请重试预览");
        }
      }
    } finally { running = false; }
  }
  return {
    update(config: ShowcaseConfig) { pending = config; void drain(); },
    dispose() { disposed = true; pending = null; }
  };
}
