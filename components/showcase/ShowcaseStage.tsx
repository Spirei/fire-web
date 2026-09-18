"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ShowcaseConfig, ShowcaseHandle } from "./types";
import "./showcase.css";

const RPM_TICKS = 20;

/**
 * 通用 3D 展示台（滚动叙事）。
 *
 * 传一份 config（见 ./presets/mcl35m.ts）就能跑：镜头、地面刻度环、隧道光条、
 * 配色、后期、章节文案、部件标注全部来自配置，换车不用改组件与引擎。
 * three.js 与引擎在挂载后才动态加载，首屏包不含 3D 代码。
 */
export default function ShowcaseStage({ config, className = "" }: { config: ShowcaseConfig; className?: string }) {
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
  const [racing, setRacing] = useState(false);
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
    let handle: ShowcaseHandle | null = null;

    (async () => {
      try {
        const { createShowcaseScene } = await import("./engine");
        if (cancelled) return;
        handle = createShowcaseScene({
          canvas,
          config,
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
            labels: (config.parts ?? [])
              .map((part, i) => ({ el: labelRefs.current[i], from: part.from, pos: part.pos }))
              .filter((item): item is { el: HTMLDivElement; from: number; pos: [number, number, number] } => Boolean(item.el))
          },
          onProgress: (ratio) => setLoadRatio(ratio),
          onReady: () => setReady(true),
          onPhase: handlePhase,
          onRacing: (on) => setRacing(on),
          onError: (message) => setError(message)
        });
        // 开发环境留一个调试句柄，方便按进度截图与排查（生产不会写）
        if (process.env.NODE_ENV !== "production") {
          (window as unknown as { __mcl?: ShowcaseHandle | null }).__mcl = handle;
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
        (window as unknown as { __mcl?: ShowcaseHandle | null }).__mcl = null;
      }
      if (fadeTimer.current) window.clearTimeout(fadeTimer.current);
    };
  }, [config, handlePhase]);

  const current = config.phases[phase] ?? config.phases[0];

  return (
    <div className={`showcase ${className}`}>
      <div className="sc-scroll" ref={scrollRef}>
        <div className="sc-stage" ref={stageRef}>
          <canvas className="sc-canvas" ref={canvasRef} aria-label={`${config.watermark ?? "3D"} 3D 展示`} />
          <div className="sc-watermark" ref={markRef}>
            {config.watermark}
          </div>
          <div className="sc-vignette" />

          <div className="sc-hud">
            <div className="sc-row sc-kicker">BEYOND THE LIMIT</div>

            <div className="sc-row sc-sec">
              <b>{current.idx}</b>
              <i />
              <span>{current.name}</span>
            </div>
            <h2 className="sc-row sc-headline" style={{ opacity: textVisible ? 1 : 0 }}>
              {current.head.map((line, i) => (
                <span key={line}>
                  {i > 0 && <br />}
                  {line}
                </span>
              ))}
            </h2>
            <p className="sc-row sc-copy" style={{ opacity: textVisible ? 1 : 0 }}>
              {current.copy.map((line, i) => (
                <span key={line}>
                  {i > 0 && <br />}
                  {line}
                </span>
              ))}
            </p>

            <div className="sc-row sc-left-foot">
              <span className="sc-pill">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                  <path d="M12 5c5 0 9 4.5 9 7s-4 7-9 7-9-4.5-9-7 4-7 9-7z" />
                  <circle cx="12" cy="12" r="2.6" />
                </svg>
                360° VIEW
              </span>
              <span className="sc-pill">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                  <circle cx="12" cy="12" r="4" />
                  <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
                </svg>
                STUDIO
              </span>
              <button
                type="button"
                className="sc-pill sc-zoom-mode"
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
              <button type="button" className="sc-zoom" ref={zoomOutRef} title="缩小（⌘/Ctrl + 滚轮）" aria-label="缩小">
                −
              </button>
              <button type="button" className="sc-zoom" ref={zoomInRef} title="放大看细节（⌘/Ctrl + 滚轮）" aria-label="放大">
                ＋
              </button>
            </div>

            <div className="sc-row sc-tele">
              <div className="sc-tele-cap">
                <em />
                LIVE TELEMETRY
              </div>
              <div className="sc-speed-wrap">
                <span className="sc-kmh" ref={kmhRef}>
                  000
                </span>
                <span className="sc-unit">KM/H</span>
              </div>
              <div className="sc-line-row">
                <span>GEAR</span>
                <b ref={gearRef}>N</b>
              </div>
              <div className="sc-ticks" ref={rpmRef}>
                {Array.from({ length: RPM_TICKS }, (_, i) => (
                  <span key={i} />
                ))}
              </div>
              <div className="sc-line-row">
                <span>ERS</span>
                <b ref={ersTextRef}>0%</b>
              </div>
              <div className="sc-ers">
                <i ref={ersBarRef} />
              </div>
              <div className="sc-tele-foot" ref={teleFootRef}>
                LIVE DATA
              </div>
            </div>

            <div className="sc-row sc-ctr">
              <div className="sc-ctr-cap">{racing ? config.race?.cap ?? "CHASE THE LIMIT" : current.cap}</div>
              <button type="button" className="sc-race" ref={raceRef}>
                <span>{racing ? config.race?.label ?? "RE-ENGAGE TO SLOW" : config.race?.idleLabel ?? "HOLD TO RACE"}</span>
                <em>→</em>
              </button>
              <div className="sc-ctr-hint">
                HOLD <kbd>SPACE</kbd> OR PRESS &amp; HOLD
              </div>
            </div>

            <div className="sc-row sc-hint-drag">
              <span>↻ DRAG TO EXPLORE</span>
              <span>⌘ / CTRL + SCROLL TO ZOOM</span>
            </div>
            <div className="sc-row sc-nav">
              <span>▴ CAR</span>
              <span>▴ AERO</span>
              <span>▴ POWER</span>
              <span>▴ TYRES</span>
              <span>▴ TECH</span>
            </div>
            <div className="sc-row sc-meta-l">MCL35M / 2021 · FORMULA 1</div>
            <div className="sc-row sc-meta-r">WEBGL SHOWCASE</div>
          </div>

          <div aria-hidden="true">
            {(config.parts ?? []).map((part, i) => (
              <div
                key={part.title}
                className={part.rev ? "sc-part rev" : "sc-part"}
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
            <div className="sc-loading" style={{ opacity: error ? 1 : 0.9 }}>
              <span className={error ? "sc-loading-error" : undefined}>{error ?? "LOADING MODEL"}</span>
              {!error && (
                <>
                  <span className="sc-loading-bar">
                    <i style={{ width: `${Math.round(loadRatio * 100)}%` }} />
                  </span>
                  <span>{Math.round(loadRatio * 100)}%</span>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
