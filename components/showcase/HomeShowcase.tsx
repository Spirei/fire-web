"use client";

import { useMemo } from "react";
import ShowcaseStage from "./ShowcaseStage";
import { DEFAULT_SHOWCASE_MODEL, SHOWCASE_MODELS } from "./presets/models";
import { usePersistedState } from "@/lib/usePersistedState";

/**
 * 首页展示台 + 右下角车型切换。
 * 选中的车型记在本机偏好里（刷新保持），切换时整台展示台会用新配置重建。
 */
export default function HomeShowcase() {
  const [modelId, setModelId] = usePersistedState<string>("fire:showcase:model", DEFAULT_SHOWCASE_MODEL);
  const current = useMemo(
    () => SHOWCASE_MODELS.find((item) => item.id === modelId) ?? SHOWCASE_MODELS[0],
    [modelId]
  );
  const options = useMemo(() => SHOWCASE_MODELS.map(({ id, label, note }) => ({ id, label, note })), []);
  return (
    <ShowcaseStage config={current.config} models={options} currentModel={current.id} onModelChange={setModelId} />
  );
}
