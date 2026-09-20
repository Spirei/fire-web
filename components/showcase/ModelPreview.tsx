"use client";

import { useEffect, useRef, useState } from "react";
import type { ShowcaseConfig, ShowcaseHandle } from "./types";

/**
 * 导入向导里的模型预览：直接跑真正的展示台引擎（同一份 config），
 * 所以预览里看到的比例、朝向、轮子转法就是首页上线后的样子。
 *
 * 只做一件事：把引擎的安全边界包起来 —— 加载失败、上下文丢失、字段缺省都不炸页面。
 */
export default function ModelPreview({
  config,
  onDebug,
  showWireframe = false
}: {
  config: ShowcaseConfig;
  showWireframe?: boolean;
  onDebug?: (info: {
    carBox: number[];
    carBoxRaw: number[];
    carMaterials: string[];
    carMeshes: string[];
    wheelGroups: number;
  }) => void;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [ready, setReady] = useState(false);
  const onDebugRef = useRef(onDebug);
  onDebugRef.current = onDebug;

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    let disposed = false;
    let handle: ShowcaseHandle | null = null;
    const canvas = document.createElement("canvas");
    canvas.className = "sc-canvas";
    wrap.appendChild(canvas);
    setError(null);
    setProgress(0);
    setReady(false);
    void import("./engine")
      .then(({ createShowcaseScene }) =>
        createShowcaseScene({
          config,
          canvas,
          // 预览不接 HUD：滚动手势用容器自己，遥测 / 按钮全部留空，引擎会跳过这些更新
          hud: {
            scroll: wrap,
            stage: wrap,
            kmh: null,
            gear: null,
            rpmTicks: [],
            ersBar: null,
            ersText: null,
            teleFoot: null,
            mark: null,
            raceBtn: null,
            labels: []
          },
          startProgress: 0,
          onProgress: (ratio) => {
            if (!disposed) setProgress(ratio);
          },
          onReady: () => {
            if (disposed) return;
            setReady(true);
            const dbg = handle?.debug();
            if (dbg) {
              onDebugRef.current?.({
                carBox: dbg.carBox,
                carBoxRaw: dbg.carBoxRaw,
                carMaterials: dbg.carMaterials,
                carMeshes: dbg.carMeshes,
                wheelGroups: dbg.wheelGroups
              });
            }
          },
          onError: (message) => {
            if (!disposed) setError(message);
          }
        })
      )
      .then((created) => {
        if (disposed) {
          created.dispose();
          return;
        }
        handle = created;
        if (showWireframe) created.setWireframe("overlay", "#00ff00");
      })
      .catch((err) => {
        if (!disposed) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      disposed = true;
      handle?.dispose();
      canvas.remove();
    };
  }, [config, showWireframe]);

  return (
    <div className="mp-preview" ref={wrapRef}>
      {!ready && !error && (
        <div className="mp-preview-loading">
          正在加载模型 {Math.round(progress * 100)}%
        </div>
      )}
      {error && <div className="mp-preview-error">{error}</div>}
    </div>
  );
}
