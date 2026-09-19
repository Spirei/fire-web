"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import ShowcaseStage from "./ShowcaseStage";
import { DEFAULT_SHOWCASE_MODEL } from "./presets/models";
import type { ShowcaseConfig } from "./types";
import { fetchAssetBuffer, isAssetCached, prefetchAsset } from "./assetCache";
import { usePersistedState } from "@/lib/usePersistedState";

type ModelStatus = "idle" | "loading" | "ready";

export interface HomeShowcaseModel {
  id: string;
  label: string;
  note: string;
  config: ShowcaseConfig;
}

/**
 * 首页展示台 + 右下角车型切换。
 *
 * 车型素材有大有小（20 MB ～ 105 MB），所以默认只加载当前选中的那一辆：
 * 1. 鼠标划过 / 键盘聚焦 / 手指按下某个车型 → 后台静默预取（进 Cache Storage / IndexedDB）；
 * 2. 点选时若已就绪立即切换；若还在下载，按钮上显示进度，等就绪再切 —— 旧车不会先消失；
 * 3. 选中的车型记在 fire:showcase:model，刷新保持（那一辆会随首屏一起加载）。
 *
 * 车型清单由服务端给（内置 MCL35M + 手动导入的 uploads 车型，见 lib/showcaseModels.ts），
 * 这样手动放进 uploads 卷的新车不用改代码、也不用重新发版。
 */
export default function HomeShowcase({
  models,
  canImport = false,
  defaultModelId,
  initialTheme = "dark"
}: {
  models: HomeShowcaseModel[];
  canImport?: boolean;
  defaultModelId?: string;
  /** 服务端从主题 cookie 读出来的首帧主题：浅色用户刷新时不会先闪深色 */
  initialTheme?: "dark" | "light";
}) {
  const router = useRouter();
  const list = useMemo(() => (models.length ? models : []), [models]);
  const fallbackId = defaultModelId ?? DEFAULT_SHOWCASE_MODEL;
  const [storedId, setModelId] = usePersistedState<string>("fire:showcase:model", fallbackId);
  // 选中的车可能已经被删掉 / 素材缺失：回落到默认那辆，避免整页空白
  const modelId = list.some((item) => item.id === storedId) ? storedId : (list[0]?.id ?? fallbackId);
  const [status, setStatus] = useState<Record<string, ModelStatus>>({});
  const [progress, setProgress] = useState<Record<string, number>>({});
  const pendingRef = useRef<string | null>(null);

  const current = useMemo(
    () => list.find((item) => item.id === modelId) ?? list[0],
    [list, modelId]
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
      const model = list.find((item) => item.id === id);
      if (!model || id === modelId || status[id] === "ready" || status[id] === "loading") return;
      const onProgress = attachProgress(id);
      void prefetchAsset(model.config.assets.model, onProgress).catch(() => {
        setStatus((prev) => ({ ...prev, [id]: "idle" }));
      });
    },
    [attachProgress, list, modelId, status]
  );

  const select = useCallback(
    async (id: string) => {
      if (id === modelId) return;
      const model = list.find((item) => item.id === id);
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
    [attachProgress, list, modelId, setModelId, status]
  );

  const options = useMemo(
    () =>
      list.map(({ id, label, note }) => ({
        id,
        label,
        note,
        status: status[id] ?? "idle",
        progress: progress[id] ?? 0
      })),
    [list, progress, status]
  );

  return (
    <ShowcaseStage
      config={current.config}
      models={options}
      currentModel={current.id}
      onModelChange={(id) => void select(id)}
      onModelIntent={warmUp}
      onImport={canImport ? () => router.push("/showcase/import") : undefined}
      initialTheme={initialTheme}
    />
  );
}
