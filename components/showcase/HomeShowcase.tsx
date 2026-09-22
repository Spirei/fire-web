"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import ShowcaseStage from "./ShowcaseStage";
import { DEFAULT_SHOWCASE_MODEL } from "./presets/models";
import type { ShowcaseConfig } from "./types";
import { fetchAssetBuffer, isAssetCached, prefetchAsset, primeModelAsset } from "./assetCache";
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
 * 1. 鼠标划过 / 键盘聚焦 / 手指按下某个车型 → 静默预取轻量车；有悬停能力的设备停留片刻再预热所选高清文件；
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
  const [textureQuality] = usePersistedState<"fast" | "balanced" | "fine" | "original">("fire:showcase:texture-quality", "fast");
  const [wireMode] = usePersistedState<"native" | "overlay" | "wireframe">("fire:showcase:wire-mode", "native");
  // 选中的车可能已经被删掉 / 素材缺失：回落到默认那辆，避免整页空白
  const modelId = list.some((item) => item.id === storedId) ? storedId : (list[0]?.id ?? fallbackId);
  const [status, setStatus] = useState<Record<string, ModelStatus>>({});
  const [progress, setProgress] = useState<Record<string, number>>({});
  const pendingRef = useRef<string | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  /** 悬停 / 聚焦 / 触摸按下：优先预热预览；明确悬停才准备高清，不改变当前展示。 */
  const warmUp = useCallback(
    (id: string, inspectorIntent = false) => {
      const model = list.find((item) => item.id === id);
      if (!model || id === modelId) return;
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
      if (inspectorIntent && typeof matchMedia === "function" && matchMedia("(hover: hover) and (pointer: fine)").matches
        && (textureQuality !== "fast" || wireMode !== "native")) {
        hoverTimerRef.current = setTimeout(() => {
          primeModelAsset(textureQuality === "original" ? model.config.assets.gpuModel ?? model.config.assets.model : model.config.assets.model);
          hoverTimerRef.current = null;
        }, 350);
      }
      if (status[id] === "ready" || status[id] === "loading") return;
      const onProgress = attachProgress(id);
      const preview = model.config.assets.previewModel ?? model.config.assets.model;
      void prefetchAsset(preview, onProgress).catch(() => {
        setStatus((prev) => ({ ...prev, [id]: "idle" }));
      });
    },
    [attachProgress, list, modelId, status, textureQuality, wireMode]
  );
  const cancelWarmUp = useCallback(() => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = null;
  }, []);
  useEffect(() => cancelWarmUp, [cancelWarmUp]);

  const select = useCallback(
    async (id: string) => {
      if (id === modelId) return;
      const model = list.find((item) => item.id === id);
      if (!model) return;
      const preview = model.config.assets.previewModel ?? model.config.assets.model;
      if (status[id] === "ready" || (await isAssetCached(preview))) {
        setStatus((prev) => ({ ...prev, [id]: "ready" }));
        setModelId(id);
        return;
      }
      // 还没就绪：先把当前这辆留在画面上，等素材到位再切
      pendingRef.current = id;
      const onProgress = attachProgress(id);
      try {
        await fetchAssetBuffer(preview, onProgress);
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

  if (!current) return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-bg-gray p-6 text-ink dark:bg-[#111722] dark:text-white">
      <h1 className="text-xl">暂无展示车型</h1>
      {canImport && <button type="button" className="rounded-full border border-edge bg-white px-5 py-2 text-sm dark:border-white/20 dark:bg-white/10" onClick={() => router.push("/showcase/import")}>管理车型</button>}
    </main>
  );

  return (
    <ShowcaseStage
      config={current.config}
      models={options}
      currentModel={current.id}
      onModelChange={(id) => void select(id)}
      onModelIntent={warmUp}
      onModelIntentEnd={cancelWarmUp}
      onImport={canImport ? () => router.push("/showcase/import") : undefined}
      initialTheme={initialTheme}
    />
  );
}
