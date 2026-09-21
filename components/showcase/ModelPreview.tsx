"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { ShowcaseConfig, ShowcaseHandle } from "./types";

function modelStructureSignature(config: ShowcaseConfig) {
  const raw = config.model ?? {};
  const { emissiveIntensity: _emissive, clearcoatRoughness: _clearcoat, envMapIntensity: _env, ...model } = raw;
  const regex = (value: string | RegExp | undefined) => value instanceof RegExp
    ? { source: value.source, flags: value.flags }
    : { source: value ?? "", flags: "" };
  return JSON.stringify({
    asset: config.assets.model,
    ...model,
    wheelPattern: regex(raw.wheelPattern),
    materialRules: (raw.materialRules ?? []).map(rule => ({ ...rule, match: regex(rule.match) }))
  });
}

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
  const configRef = useRef(config);
  const appliedConfigRef = useRef<ShowcaseConfig | null>(null);
  const updateSequenceRef = useRef(0);
  const activeRegionRef = useRef(activeRegion);
  const onDebugRef = useRef(onDebug);
  const markerRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  onDebugRef.current = onDebug;
  configRef.current = config;
  activeRegionRef.current = activeRegion;

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    let disposed = false;
    let handle: ShowcaseHandle | null = null;
    const initialConfig = configRef.current;
    const canvas = document.createElement("canvas");
    canvas.className = "sc-canvas";
    wrap.appendChild(canvas);
    setError(null);
    setProgress(0);
    setReady(false);
    void import("./engine")
      .then(({ createShowcaseScene }) =>
        createShowcaseScene({
          config: initialConfig,
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
        appliedConfigRef.current = initialConfig;
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
  }, [explore, onPartSelect, partRegions, showWireframe]);

  // 调参只原地替换车身，复用 renderer、环境贴图、后期链和 WebGL context。
  // 这样保留完整模型与原始像素倍率，同时避开每次参数稳定后重建整套 GPU 场景的停顿。
  useEffect(() => {
    const handle = handleRef.current;
    if (!ready || !handle || appliedConfigRef.current === config) return;
    const previous = appliedConfigRef.current;
    const sequence = ++updateSequenceRef.current;
    appliedConfigRef.current = config;
    if (previous && modelStructureSignature(previous) === modelStructureSignature(config)) {
      handle.updateModelMaterials(config.model);
      const dbg = handle.debug();
      onDebugRef.current?.({ carBox: dbg.carBox, carBoxRaw: dbg.carBoxRaw, carMaterials: dbg.carMaterials, carMeshes: dbg.carMeshes, wheelGroups: dbg.wheelGroups });
      return;
    }
    void handle.setModel({ asset: config.assets.model, model: config.model }).then((ok) => {
      if (!ok || sequence !== updateSequenceRef.current || handleRef.current !== handle) return;
      const region = activeRegionRef.current;
      if (region) handle.setInspectRegion(region as "overall" | "body" | "aero" | "wheels" | "cockpit");
      const dbg = handle.debug();
      onDebugRef.current?.({
        carBox: dbg.carBox,
        carBoxRaw: dbg.carBoxRaw,
        carMaterials: dbg.carMaterials,
        carMeshes: dbg.carMeshes,
        wheelGroups: dbg.wheelGroups
      });
    });
  }, [config, ready]);

  // 原地替换车身后恢复当前大类，避免调一个数后选区突然丢失、全车重新变绿。
  useEffect(() => {
    if (!ready || !activeRegion) return;
    handleRef.current?.setInspectRegion(activeRegion as "overall" | "body" | "aero" | "wheels" | "cockpit");
  }, [activeRegion, ready]);

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
