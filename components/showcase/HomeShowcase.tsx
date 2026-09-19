"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import ShowcaseStage from "./ShowcaseStage";
import { DEFAULT_SHOWCASE_MODEL, SHOWCASE_MODELS } from "./presets/models";
import { fetchAssetBuffer, isAssetCached, prefetchAsset } from "./assetCache";
import { usePersistedState } from "@/lib/usePersistedState";

type ModelStatus = "idle" | "loading" | "ready";

/**
 * 首页展示台 + 右下角车型切换。
 *
 * 车型素材有大有小（20 MB ～ 105 MB），所以默认只加载当前选中的那一辆：
 * 1. 鼠标划过 / 键盘聚焦 / 手指按下某个车型 → 后台静默预取（进 Cache Storage / IndexedDB）；
 * 2. 点选时若已就绪立即切换；若还在下载，按钮上显示进度，等就绪再切 —— 旧车不会先消失；
 * 3. 选中的车型记在 fire:showcase:model，刷新保持（那一辆会随首屏一起加载）。
 */
export default function HomeShowcase() {
  const [modelId, setModelId] = usePersistedState<string>("fire:showcase:model", DEFAULT_SHOWCASE_MODEL);
  const [status, setStatus] = useState<Record<string, ModelStatus>>({});
  const [progress, setProgress] = useState<Record<string, number>>({});
  const pendingRef = useRef<string | null>(null);

  const current = useMemo(
    () => SHOWCASE_MODELS.find((item) => item.id === modelId) ?? SHOWCASE_MODELS[0],
    [modelId]
  );

  const attachProgress = useCallback((id: string) => {
    setStatus((prev) => (prev[id] === "ready" ? prev : { ...prev, [id]: "loading" }));
    return (ratio: number) => {
      setProgress((prev) => (prev[id] === ratio ? prev : { ...prev, [id]: ratio }));
      if (ratio >= 1) setStatus((prev) => ({ ...prev, [id]: "ready" }));
    };
  }, []);

  /** 悬停 / 聚焦 / 触摸按下：静默预热，不改变当前展示 */
  const warmUp = useCallback(
    (id: string) => {
      const model = SHOWCASE_MODELS.find((item) => item.id === id);
      if (!model || id === modelId || status[id] === "ready" || status[id] === "loading") return;
      const onProgress = attachProgress(id);
      void prefetchAsset(model.config.assets.model, onProgress).catch(() => {
        setStatus((prev) => ({ ...prev, [id]: "idle" }));
      });
    },
    [attachProgress, modelId, status]
  );

  const select = useCallback(
    async (id: string) => {
      if (id === modelId) return;
      const model = SHOWCASE_MODELS.find((item) => item.id === id);
      if (!model) return;
      if (status[id] === "ready" || (await isAssetCached(model.config.assets.model))) {
        setStatus((prev) => ({ ...prev, [id]: "ready" }));
        setModelId(id);
        return;
      }
      // 还没就绪：先把当前这辆留在画面上，等素材到位再切
      pendingRef.current = id;
      const onProgress = attachProgress(id);
      try {
        await fetchAssetBuffer(model.config.assets.model, onProgress);
      } catch {
        pendingRef.current = null;
        setStatus((prev) => ({ ...prev, [id]: "idle" }));
        return;
      }
      if (pendingRef.current !== id) return;
      pendingRef.current = null;
      setStatus((prev) => ({ ...prev, [id]: "ready" }));
      setModelId(id);
    },
    [attachProgress, modelId, setModelId, status]
  );

  const options = useMemo(
    () =>
      SHOWCASE_MODELS.map(({ id, label, note }) => ({
        id,
        label,
        note,
        status: status[id] ?? "idle",
        progress: progress[id] ?? 0
      })),
    [progress, status]
  );

  return (
    <ShowcaseStage
      config={current.config}
      models={options}
      currentModel={current.id}
      onModelChange={(id) => void select(id)}
      onModelIntent={warmUp}
    />
  );
}
