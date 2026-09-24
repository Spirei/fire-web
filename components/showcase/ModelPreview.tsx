"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { ShowcaseConfig, ShowcaseHandle, ShowcaseLoadPhase } from "./types";

import { createPreviewUpdates } from "./previewUpdates";
export type PreviewStatus = "loading" | "ready" | "error";
const EMPTY_REGIONS: Array<{ id: string; label: string; color: string; pos: [number, number, number] }> = [];
const STALLED_PHASE_MS = 180_000;

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
  partRegions = EMPTY_REGIONS,
  activeRegion,
  onRegionSelect,
  onStatus
}: {
  config: ShowcaseConfig;
  onStatus?: (status: PreviewStatus) => void;
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
  const [phase, setPhase] = useState<ShowcaseLoadPhase>("fetching");
  const [decoded, setDecoded] = useState<{ done: number; total: number }>({ done: 0, total: 0 });
  const [ready, setReady] = useState(false);
  const handleRef = useRef<ShowcaseHandle | null>(null);
  const configRef = useRef(config);
  const initialConfigRef = useRef(config);
  const updatesRef = useRef<ReturnType<typeof createPreviewUpdates> | null>(null);
  const updateWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [retry, setRetry] = useState(0);
  const statusRef = useRef(onStatus);
  statusRef.current = onStatus;
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
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    const clearWatchdog = () => { if (watchdog) clearTimeout(watchdog); watchdog = null; };
    const armWatchdog = (stage: string) => {
      clearWatchdog();
      watchdog = setTimeout(() => {
        if (disposed) return;
        disposed = true;
        handle?.dispose();
        setError(`${stage}超过 3 分钟没有进展。模型文件仍在本页，可点“重试预览”；若再次停在同一张贴图，请尝试低分辨率版本。`);
        statusRef.current?.("error");
      }, STALLED_PHASE_MS);
    };
    const initialConfig = configRef.current;
    initialConfigRef.current = initialConfig;
    statusRef.current?.("loading");
    const canvas = document.createElement("canvas");
    canvas.className = "sc-canvas";
    wrap.appendChild(canvas);
    setError(null);
    setProgress(0);
    setPhase("fetching");
    setDecoded({ done: 0, total: 0 });
    setReady(false);
    armWatchdog("预览初始化");
    void import("./engine")
      .then(({ createShowcaseScene }) =>
        createShowcaseScene({
          config: initialConfig,
          initialTheme: document.documentElement.classList.contains("dark") ? "dark" : "light",
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
            if (!disposed) { setProgress(ratio); armWatchdog("模型读取"); }
          },
          onModelPhase: (next) => {
            if (!disposed) { setPhase(next); armWatchdog(next === "mounting" ? "模型渲染" : "模型解析"); }
          },
          onDecodeProgress: (done, total) => {
            if (!disposed) { setDecoded({ done, total }); armWatchdog(`贴图解析 ${done}/${total}`); }
          },
          onReady: () => {
            if (disposed) return;
            clearWatchdog();
            setReady(true);
          },
          onInspectPart: onPartSelect,
          onContextLost: () => {
            if (!disposed) { clearWatchdog(); setError("图形资源暂时不可用，请重试预览"); statusRef.current?.("error"); }
          },
          onError: (message) => {
            if (!disposed) { clearWatchdog(); setError(message); statusRef.current?.("error"); }
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
        if (!disposed) { clearWatchdog(); setError(err instanceof Error ? err.message : String(err)); statusRef.current?.("error"); }
      });
    return () => {
      disposed = true;
      clearWatchdog();
      if (updateWatchdogRef.current) clearTimeout(updateWatchdogRef.current);
      updateWatchdogRef.current = null;
      updatesRef.current?.dispose();
      updatesRef.current = null;
      handleRef.current = null;
      handle?.dispose();
      canvas.remove();
    };
  }, [explore, onPartSelect, partRegions, showWireframe, retry]);

  // 串行应用最新参数，快速连续调参不会让旧结果覆盖新选择。
  useEffect(() => {
    const handle = handleRef.current;
    if (!ready || !handle) return;
    let active = true;
    if (updateWatchdogRef.current) clearTimeout(updateWatchdogRef.current);
    const timer = setTimeout(() => {
      if (!active || handleRef.current !== handle) return;
      updateWatchdogRef.current = null;
      updatesRef.current?.dispose();
      updatesRef.current = null;
      handle.dispose();
      handleRef.current = null;
      setError("参数更新超过 3 分钟没有进展。当前设置已保留，请点“重试预览”。");
      statusRef.current?.("error");
    }, STALLED_PHASE_MS);
    updateWatchdogRef.current = timer;
    setError(null);
    statusRef.current?.("loading");
    if (!updatesRef.current) updatesRef.current = createPreviewUpdates(handle, initialConfigRef.current, {
      ready: (applied) => {
        if (handleRef.current !== handle || configRef.current !== applied) return;
        if (updateWatchdogRef.current) clearTimeout(updateWatchdogRef.current);
        updateWatchdogRef.current = null;
        const region = activeRegionRef.current;
        if (region) handle.setInspectRegion(region as "overall" | "body" | "aero" | "wheels" | "cockpit");
        const dbg = handle.debug();
        onDebugRef.current?.({ carBox: dbg.carBox, carBoxRaw: dbg.carBoxRaw, carMaterials: dbg.carMaterials, carMeshes: dbg.carMeshes, wheelGroups: dbg.wheelGroups });
        setError(null);
        statusRef.current?.("ready");
      },
      error: (message) => {
        if (handleRef.current !== handle) return;
        if (updateWatchdogRef.current) clearTimeout(updateWatchdogRef.current);
        updateWatchdogRef.current = null;
        setError(message);
        statusRef.current?.("error");
      }
    });
    updatesRef.current.update(config);
    return () => { active = false; if (updateWatchdogRef.current === timer) { clearTimeout(timer); updateWatchdogRef.current = null; } };
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
          {phase === "mounting" ? "正在渲染模型首帧…" : progress >= 1
            ? decoded.total > 0 ? `正在解析模型与贴图 ${decoded.done}/${decoded.total}…` : "正在准备贴图解码…"
            : `正在读取模型 ${Math.round(progress * 100)}%`}
        </div>
      )}
      {error && <div className="mp-preview-error" role="alert"><span>{error}</span><button type="button" className="fire-cap mp-ghost" onClick={() => { setReady(false); setRetry(value => value + 1); }}>重试预览</button></div>}
    </div>
  );
}
