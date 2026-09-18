"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MCL_PARTS, MCL_PHASES } from "./phases";
import type { McLarenSceneHandle } from "./scene";
import "./mclaren.css";

const RPM_TICKS = 20;

/**
 * 首页迈凯伦（F1）滚动叙事舞台。
 *
 * three.js 场景在挂载后才动态 import，首屏 HTML / 首屏 JS 里没有 three，
 * 因此不会拖慢首页；滚动进度是唯一输入，章节文案与部件标注由 React 渲染，
 * 场景只负责每帧更新数值型 HUD（速度、档位、转速、ERS）与标注位置。
 */
export default function McLarenStage({ watermark = "FORMULA" }: { watermark?: string }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const markRef = useRef<HTMLDivElement | null>(null);
  const kmhRef = useRef<HTMLSpanElement | null>(null);
  const gearRef = useRef<HTMLSpanElement | null>(null);
  const rpmRef = useRef<HTMLDivElement | null>(null);
  const ersBarRef = useRef<HTMLElement | null>(null);
  const ersTextRef = useRef<HTMLElement | null>(null);
  const teleFootRef = useRef<HTMLDivElement | null>(null);
  const raceRef = useRef<HTMLButtonElement | null>(null);
  const zoomInRef = useRef<HTMLButtonElement | null>(null);
  const zoomOutRef = useRef<HTMLButtonElement | null>(null);
  const zoomModeRef = useRef<HTMLButtonElement | null>(null);
  const labelRefs = useRef<Array<HTMLDivElement | null>>([]);

  const [phase, setPhase] = useState(0);
  const [textVisible, setTextVisible] = useState(true);
  const [loadRatio, setLoadRatio] = useState(0);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const phaseRef = useRef(0);
  const fadeTimer = useRef<number | null>(null);

  const handlePhase = useCallback((index: number) => {
    if (index === phaseRef.current) return;
    phaseRef.current = index;
    setTextVisible(false);
    if (fadeTimer.current) window.clearTimeout(fadeTimer.current);
    fadeTimer.current = window.setTimeout(() => {
      setPhase(index);
      setTextVisible(true);
    }, 200);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    const scroll = scrollRef.current;
    if (!canvas || !stage || !scroll) return;

    let cancelled = false;
    let handle: McLarenSceneHandle | null = null;

    (async () => {
      try {
        const { createMcLarenScene } = await import("./scene");
        if (cancelled) return;
        handle = createMcLarenScene({
          canvas,
          hud: {
            scroll,
            stage,
            kmh: kmhRef.current,
            gear: gearRef.current,
            rpmTicks: rpmRef.current ? (Array.from(rpmRef.current.children) as HTMLElement[]) : [],
            ersBar: ersBarRef.current,
            ersText: ersTextRef.current,
            teleFoot: teleFootRef.current,
            mark: markRef.current,
            raceBtn: raceRef.current,
            zoomIn: zoomInRef.current,
            zoomOut: zoomOutRef.current,
            zoomMode: zoomModeRef.current,
            labels: MCL_PARTS.map((part, i) => ({ el: labelRefs.current[i], from: part.from, pos: part.pos })).filter(
              (item): item is { el: HTMLDivElement; from: number; pos: [number, number, number] } => Boolean(item.el)
            )
          },
          onProgress: (ratio) => setLoadRatio(ratio),
          onReady: () => setReady(true),
          onPhase: handlePhase,
          onError: (message) => setError(message)
        });
        // 开发环境留一个调试句柄，方便按进度截图与排查（生产不会写）
        if (process.env.NODE_ENV !== "production") {
          (window as unknown as { __mcl?: McLarenSceneHandle | null }).__mcl = handle;
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      cancelled = true;
      handle?.dispose();
      handle = null;
      if (process.env.NODE_ENV !== "production") {
        (window as unknown as { __mcl?: McLarenSceneHandle | null }).__mcl = null;
      }
      if (fadeTimer.current) window.clearTimeout(fadeTimer.current);
    };
  }, [handlePhase]);

  const current = MCL_PHASES[phase];

  return (
    <div className="mcl-scroll" ref={scrollRef}>
      <div className="mcl-stage" ref={stageRef}>
        <canvas className="mcl-canvas" ref={canvasRef} aria-label="迈凯伦 F1 3D 展示" />
        <div className="mcl-watermark" ref={markRef}>
          {watermark}
        </div>
        <div className="mcl-vignette" />

        <div className="mcl-hud">
          <div className="mcl-row mcl-kicker">BEYOND THE LIMIT</div>

          <div className="mcl-row mcl-sec">
            <b>{current.idx}</b>
            <i />
            <span>{current.name}</span>
          </div>
          <h2 className="mcl-row mcl-headline" style={{ opacity: textVisible ? 1 : 0 }}>
            {current.head.map((line, i) => (
              <span key={line}>
                {i > 0 && <br />}
                {line}
              </span>
            ))}
          </h2>
          <p className="mcl-row mcl-copy" style={{ opacity: textVisible ? 1 : 0 }}>
            {current.copy.map((line, i) => (
              <span key={line}>
                {i > 0 && <br />}
                {line}
              </span>
            ))}
          </p>

          <div className="mcl-row mcl-left-foot">
            <span className="mcl-pill">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                <path d="M12 5c5 0 9 4.5 9 7s-4 7-9 7-9-4.5-9-7 4-7 9-7z" />
                <circle cx="12" cy="12" r="2.6" />
              </svg>
              360° VIEW
            </span>
            <span className="mcl-pill">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
              </svg>
              STUDIO
            </span>
            <button
              type="button"
              className="mcl-pill mcl-zoom-mode"
              ref={zoomModeRef}
              aria-pressed="false"
              title="打开后普通滚轮 / 双指滚动就是放大缩小（快捷键 Z）"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <circle cx="11" cy="11" r="6.5" />
                <path d="m20 20-4.6-4.6M11 8.5v5M8.5 11h5" />
              </svg>
              ZOOM
            </button>
            <button type="button" className="mcl-zoom" ref={zoomOutRef} title="缩小（⌘/Ctrl + 滚轮）" aria-label="缩小">
              −
            </button>
            <button type="button" className="mcl-zoom" ref={zoomInRef} title="放大看细节（⌘/Ctrl + 滚轮）" aria-label="放大">
              ＋
            </button>
          </div>

          <div className="mcl-row mcl-tele">
            <div className="mcl-tele-cap">
              <em />
              LIVE TELEMETRY
            </div>
            <div className="mcl-speed-wrap">
              <span className="mcl-kmh" ref={kmhRef}>
                000
              </span>
              <span className="mcl-unit">KM/H</span>
            </div>
            <div className="mcl-line-row">
              <span>GEAR</span>
              <b ref={gearRef}>N</b>
            </div>
            <div className="mcl-ticks" ref={rpmRef}>
              {Array.from({ length: RPM_TICKS }, (_, i) => (
                <span key={i} />
              ))}
            </div>
            <div className="mcl-line-row">
              <span>ERS</span>
              <b ref={ersTextRef}>0%</b>
            </div>
            <div className="mcl-ers">
              <i ref={ersBarRef} />
            </div>
            <div className="mcl-tele-foot" ref={teleFootRef}>
              LIVE DATA
            </div>
          </div>

          <div className="mcl-row mcl-ctr">
            <div className="mcl-ctr-cap">{current.cap}</div>
            <button type="button" className="mcl-race" ref={raceRef}>
              <span>HOLD TO RACE</span>
              <em>→</em>
            </button>
            <div className="mcl-ctr-hint">
              HOLD <kbd>SPACE</kbd> OR PRESS &amp; HOLD
            </div>
          </div>

          <div className="mcl-row mcl-hint-drag">
            <span>↻ DRAG TO EXPLORE</span>
            <span>⌘ / CTRL + SCROLL TO ZOOM</span>
          </div>
          <div className="mcl-row mcl-nav">
            <span>▴ CAR</span>
            <span>▴ AERO</span>
            <span>▴ POWER</span>
            <span>▴ TYRES</span>
            <span>▴ TECH</span>
          </div>
          <div className="mcl-row mcl-meta-l">MCL35M / 2021 · FORMULA 1</div>
          <div className="mcl-row mcl-meta-r">WEBGL SHOWCASE</div>
        </div>

        <div aria-hidden="true">
          {MCL_PARTS.map((part, i) => (
            <div
              key={part.title}
              className={part.rev ? "mcl-part rev" : "mcl-part"}
              ref={(el) => {
                labelRefs.current[i] = el;
              }}
            >
              <b>{part.title}</b>
              <i>{part.value}</i>
            </div>
          ))}
        </div>

        {!ready && (
          <div className="mcl-loading" style={{ opacity: error ? 1 : 0.9 }}>
            <span className={error ? "mcl-loading-error" : undefined}>{error ?? "LOADING CHASSIS"}</span>
            {!error && (
              <>
                <span className="mcl-loading-bar">
                  <i style={{ width: `${Math.round(loadRatio * 100)}%` }} />
                </span>
                <span>{Math.round(loadRatio * 100)}%</span>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
