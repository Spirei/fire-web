"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ShowcaseConfig, ShowcaseHandle } from "./types";
import { setThemeCookie } from "@/lib/theme";
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
  const canvasWrapRef = useRef<HTMLDivElement | null>(null);
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
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [musicOn, setMusicOn] = useState(false);
  const [musicReady, setMusicReady] = useState(true);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const handleRef = useRef<ShowcaseHandle | null>(null);
  // WebGL 上下文丢了就重建一次场景（重建计数用作 key，触发重新挂载）
  const [rebuild, setRebuild] = useState(0);
  const [retry, setRetry] = useState(0);
  // 第二次重建开始主动降级：贴图最长边收到 2048（4K 贴图约占 236MB 显存），换取稳定
  const degraded = rebuild >= 2;
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
    const wrap = canvasWrapRef.current;
    const stage = stageRef.current;
    const scroll = scrollRef.current;
    if (!wrap || !stage || !scroll) return;

    // 每次实例化都新建 canvas：WebGL 上下文一旦丢失，同一个 canvas 上的上下文无法复活，
    // 复用 canvas 会导致「重建也还是白屏」。换新 canvas 才是真正可恢复的。
    const canvas = document.createElement("canvas");
    canvas.className = "sc-canvas";
    canvas.setAttribute("aria-label", `${config.watermark ?? "3D"} 3D 展示`);
    wrap.appendChild(canvas);

    let cancelled = false;
    let handle: ShowcaseHandle | null = null;

    (async () => {
      try {
        const { createShowcaseScene } = await import("./engine");
        if (cancelled) return;
        handle = createShowcaseScene({
          canvas,
          config: degraded
            ? { ...config, model: { ...config.model, maxTextureSize: 2048 } }
            : config,
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
          onContextLost: () => {
            if (cancelled) return;
            setReady(false);
            setRebuild((n) => (n > 3 ? n : n + 1));
          },
          onError: (message) => setError(message)
        });
        handle.setTheme(themeRef.current);
        handleRef.current = handle;
        // 开发环境留一个调试句柄，方便按进度截图与排查（生产不会写）
        if (process.env.NODE_ENV !== "production") {
          (window as unknown as { __mcl?: ShowcaseHandle | null }).__mcl = handle;
        }
      } catch (err) {
        // 上下文创建失败（例如同时打开太多 WebGL 页面）时不要就此放弃，隔一会儿再试一次
        setError(err instanceof Error ? err.message : String(err));
        if (!cancelled && rebuild < 4) {
          window.setTimeout(() => {
            if (!cancelled) setRebuild((n) => n + 1);
          }, 1200);
        }
      }
    })();

    return () => {
      cancelled = true;
      const win = window as unknown as { __mcl?: ShowcaseHandle | null; __mclDiag?: unknown };
      if (process.env.NODE_ENV !== "production") {
        // 保留最后一次诊断快照，白屏之后仍能取到数据
        try {
          win.__mclDiag = handle?.debug();
        } catch {
          /* 忽略 */
        }
        if (win.__mcl === handle) win.__mcl = null;
      }
      handle?.dispose();
      canvas.remove();
      handle = null;
      handleRef.current = null;
      if (fadeTimer.current) window.clearTimeout(fadeTimer.current);
    };
  }, [config, handlePhase, rebuild, degraded, retry]);

  // 首帧之后再读站点主题（服务端首帧固定深色，避免水合不一致）
  const themeRef = useRef<"dark" | "light">("dark");
  useEffect(() => {
    // 默认按深色展示（首页原本就是夜景）；只有用户自己选过浅色才用浅色，
    // 避免新访客第一次进来直接看到明亮摄影棚而认不出来。
    let saved: string | null = null;
    try {
      saved = localStorage.getItem("fire.theme");
    } catch {
      /* 忽略 */
    }
    const next: "dark" | "light" = saved === "light" ? "light" : "dark";
    themeRef.current = next;
    setTheme(next);
    handleRef.current?.setTheme(next);
  }, []);

  const toggleTheme = useCallback(() => {
    const next: "dark" | "light" = themeRef.current === "dark" ? "light" : "dark";
    themeRef.current = next;
    setTheme(next);
    document.documentElement.classList.toggle("dark", next === "dark");
    try {
      localStorage.setItem("fire.theme", next);
    } catch {
      /* 忽略 */
    }
    setThemeCookie(next === "dark");
    handleRef.current?.setTheme(next);
  }, []);

  // 背景音乐：默认不播放（浏览器不允许自动播放），点图标才播；循环、音量 0.45。
  // 开关记在 localStorage，下次进来会在首次交互后自动续播。
  const MUSIC_KEY = "fire:showcase:music";
  const ensureAudio = useCallback(() => {
    if (audioRef.current) return audioRef.current;
    const audio = new Audio(config.music ?? "/uploads/mclaren/theme.mp3");
    audio.loop = true;
    audio.volume = 0.45;
    audio.preload = "none";
    audio.addEventListener("error", () => {
      setMusicReady(false);
      setMusicOn(false);
    });
    audioRef.current = audio;
    // 开发环境留个引用，方便在控制台/自动化里检查播放状态
    if (process.env.NODE_ENV !== "production") {
      (window as unknown as { __mclAudioRef?: HTMLAudioElement }).__mclAudioRef = audio;
    }
    return audio;
  }, [config.music]);

  const startMusic = useCallback(async () => {
    const audio = ensureAudio();
    try {
      await audio.play();
      setMusicOn(true);
      try {
        localStorage.setItem(MUSIC_KEY, "on");
      } catch {
        /* 忽略 */
      }
    } catch {
      setMusicOn(false);
    }
  }, [ensureAudio]);

  const stopMusic = useCallback(() => {
    audioRef.current?.pause();
    setMusicOn(false);
    try {
      localStorage.setItem(MUSIC_KEY, "off");
    } catch {
      /* 忽略 */
    }
  }, []);

  const toggleMusic = useCallback(() => {
    if (musicOn) stopMusic();
    else void startMusic();
  }, [musicOn, startMusic, stopMusic]);

  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(MUSIC_KEY);
    } catch {
      /* 忽略 */
    }
    if (saved !== "on") return;
    // 上次开着：等第一次用户交互再续播（否则被自动播放策略拦下）
    const resume = () => {
      void startMusic();
      window.removeEventListener("pointerdown", resume);
      window.removeEventListener("keydown", resume);
    };
    window.addEventListener("pointerdown", resume, { once: true });
    window.addEventListener("keydown", resume, { once: true });
    return () => {
      window.removeEventListener("pointerdown", resume);
      window.removeEventListener("keydown", resume);
    };
  }, [startMusic]);

  useEffect(() => {
    // 切走标签页先暂停，回来再续上，避免后台一直响
    const onHidden = () => {
      const audio = audioRef.current;
      if (!audio) return;
      if (document.hidden) {
        if (!audio.paused) {
          audio.pause();
          audio.dataset.wasPlaying = "1";
        }
      } else if (audio.dataset.wasPlaying === "1" && musicOn) {
        audio.dataset.wasPlaying = "";
        void audio.play().catch(() => {});
      }
    };
    document.addEventListener("visibilitychange", onHidden);
    return () => document.removeEventListener("visibilitychange", onHidden);
  }, [musicOn]);

  useEffect(() => () => audioRef.current?.pause(), []);

  const current = config.phases[phase] ?? config.phases[0];
  // 界面文案：默认英文，preset 里传 ui 就按传入的显示（本站首页已改中文）
  const ui = {
    kicker: config.ui?.kicker ?? "BEYOND THE LIMIT",
    telemetry: config.ui?.telemetry ?? "LIVE TELEMETRY",
    gear: config.ui?.gear ?? "GEAR",
    energy: config.ui?.energy ?? "ERS",
    unit: config.ui?.unit ?? "KM/H",
    liveData: config.ui?.liveData ?? "LIVE DATA",
    liveDeploying: config.ui?.liveDeploying ?? "LIVE DATA · DEPLOYING",
    raceIdle: config.ui?.raceIdle ?? config.race?.idleLabel ?? "HOLD TO RACE",
    raceActive: config.ui?.raceActive ?? config.race?.label ?? "RE-ENGAGE TO SLOW",
    raceCap: config.ui?.raceCap ?? config.race?.cap ?? "CHASE THE LIMIT",
    raceHint: config.ui?.raceHint ?? "HOLD [SPACE] OR PRESS & HOLD",
    dragHint: config.ui?.dragHint ?? "↻ DRAG TO EXPLORE",
    zoomHint: config.ui?.zoomHint ?? "⌘ / CTRL + SCROLL TO ZOOM",
    zoomMode: config.ui?.zoomMode ?? "ZOOM",
    view360: config.ui?.view360 ?? "360° VIEW",
    studio: config.ui?.studio ?? "STUDIO",
    loading: config.ui?.loading ?? "LOADING MODEL",
    metaLeft: config.ui?.metaLeft ?? "MCL35M / 2021 · FORMULA 1",
    metaRight: config.ui?.metaRight ?? "WEBGL SHOWCASE",
    nav: config.ui?.nav ?? ["CAR", "AERO", "POWER", "TYRES", "TECH"]
  };

  return (
    <div className={`showcase ${theme === "light" ? "light" : ""} ${className}`}>
      <div className="sc-scroll" ref={scrollRef}>
        <div className="sc-stage" ref={stageRef}>
          <div className="sc-canvas-wrap" ref={canvasWrapRef} />
          <div className="sc-watermark" ref={markRef}>
            {config.watermark}
          </div>
          <div className="sc-vignette" />

          <div className="sc-hud">
            <div className="sc-row sc-tools">
              {musicReady && (
                <button
                  type="button"
                  className={`sc-tool${musicOn ? " on" : ""}`}
                  onClick={toggleMusic}
                  title={musicOn ? "关闭背景音乐" : "播放背景音乐"}
                  aria-label={musicOn ? "关闭背景音乐" : "播放背景音乐"}
                  aria-pressed={musicOn}
                >
                  {/* 音符图标：播放时实心、暂停时描边，配色跟随深浅色主题 */}
                  {musicOn ? (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M14 17V4.5c2.6.2 4.4 1.2 4.4 2.9" />
                      <circle cx="10.6" cy="17" r="3.4" fill="currentColor" stroke="none" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M14 17V4.5c2.6.2 4.4 1.2 4.4 2.9" />
                      <circle cx="10.6" cy="17" r="3.4" />
                    </svg>
                  )}
                </button>
              )}
              <button
                type="button"
                className="sc-tool"
                onClick={toggleTheme}
                title={theme === "dark" ? "切换到浅色（明亮摄影棚）" : "切换到深色（夜间隧道）"}
                aria-label="切换深浅色"
              >
                {theme === "dark" ? (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="4" />
                    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
                    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
                  </svg>
                )}
              </button>
            </div>
            <div className="sc-row sc-kicker">{ui.kicker}</div>

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
                {ui.view360}
              </span>
              <span className="sc-pill">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                  <circle cx="12" cy="12" r="4" />
                  <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
                </svg>
                {ui.studio}
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
                {ui.zoomMode}
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
                {ui.telemetry}
              </div>
              <div className="sc-speed-wrap">
                <span className="sc-kmh" ref={kmhRef}>
                  000
                </span>
                <span className="sc-unit">{ui.unit}</span>
              </div>
              <div className="sc-line-row">
                <span>{ui.gear}</span>
                <b ref={gearRef}>N</b>
              </div>
              <div className="sc-ticks" ref={rpmRef}>
                {Array.from({ length: RPM_TICKS }, (_, i) => (
                  <span key={i} />
                ))}
              </div>
              <div className="sc-line-row">
                <span>{ui.energy}</span>
                <b ref={ersTextRef}>0%</b>
              </div>
              <div className="sc-ers">
                <i ref={ersBarRef} />
              </div>
              <div className="sc-tele-foot" ref={teleFootRef}>
                {ui.liveData}
              </div>
            </div>

            <div className="sc-row sc-ctr">
              <div className="sc-ctr-cap">{racing ? ui.raceCap : current.cap}</div>
              <button type="button" className="sc-race" ref={raceRef}>
                <span>{racing ? ui.raceActive : ui.raceIdle}</span>
                <em>→</em>
              </button>
              <div className="sc-ctr-hint">{ui.raceHint}</div>
            </div>

            <div className="sc-row sc-hint-drag">
              <span>{ui.dragHint}</span>
              <span>{ui.zoomHint}</span>
            </div>
            <div className="sc-row sc-nav">
              {ui.nav.map((item) => (
                <span key={item}>▴ {item}</span>
              ))}
            </div>
            <div className="sc-row sc-meta-l">{ui.metaLeft}</div>
            <div className="sc-row sc-meta-r">{ui.metaRight}</div>
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
              <span className={error ? "sc-loading-error" : undefined}>{error ?? ui.loading}</span>
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
