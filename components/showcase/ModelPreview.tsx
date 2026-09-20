"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
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
  showWireframe = false,
  explore = false,
  onPartSelect,
  partRegions = [],
  activeRegion,
  onRegionSelect
}: {
  config: ShowcaseConfig;
  showWireframe?: boolean;
  /** 使用模型展示同款探索镜头：全角度环视、平移、推进与双击聚焦。 */
  explore?: boolean;
  onPartSelect?: (part: { mesh: string; materials: string[]; position: [number, number, number] }) => void;
  partRegions?: Array<{ id: string; label: string; color: string; pos: [number, number, number] }>;
  activeRegion?: string;
  onRegionSelect?: (id: string) => void;
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
  const handleRef = useRef<ShowcaseHandle | null>(null);
  const onDebugRef = useRef(onDebug);
  const markerRefs = useRef<Record<string, HTMLButtonElement | null>>({});
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
            labels: [],
            inspectMarkers: partRegions.flatMap(region => {
              const el = markerRefs.current[region.id];
              return el ? [{ el, pos: region.pos }] : [];
            })
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
          onInspectPart: onPartSelect,
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
        handleRef.current = created;
        if (explore) created.setInspector(true);
        if (showWireframe) created.setWireframe("overlay", "#00ff00");
      })
      .catch((err) => {
        if (!disposed) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      disposed = true;
      handleRef.current = null;
      handle?.dispose();
      canvas.remove();
    };
  }, [config, explore, onPartSelect, partRegions, showWireframe]);

  return (
    <div className="mp-preview" ref={wrapRef}>
      {explore && partRegions.map(region => (
        <button
          key={region.id}
          ref={element => { markerRefs.current[region.id] = element; }}
          type="button"
          className={`mp-car-marker${activeRegion === region.id ? " on" : ""}`}
          style={{ "--marker-color": region.color } as CSSProperties}
          onClick={() => {
            handleRef.current?.setInspectRegion(region.id as "overall" | "body" | "aero" | "wheels" | "cockpit");
            onRegionSelect?.(region.id);
          }}
          aria-label={`${region.label}参数`}
          title={`打开${region.label}参数`}
        ><span /><b>{region.label}</b></button>
      ))}
      {ready && explore && (
        <div className="mp-explore-bar">
          <span><b>探索镜头</b> 左键环视 · Shift / 右键平移 · 滚轮推进 · 双击聚焦</span>
          <button type="button" className="fire-cap" onClick={() => handleRef.current?.resetCamera()}>复位镜头</button>
        </div>
      )}
      {!ready && !error && (
        <div className="mp-preview-loading">
          正在加载模型 {Math.round(progress * 100)}%
        </div>
      )}
      {error && <div className="mp-preview-error">{error}</div>}
    </div>
  );
}
