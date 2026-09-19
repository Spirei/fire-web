"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ShowcaseConfig, ShowcaseHandle } from "./types";
import { setThemeCookie } from "@/lib/theme";
import { usePersistedState } from "@/lib/usePersistedState";
import "./showcase.css";

const RPM_TICKS = 20;
/** 用户置顶的默认机位（进度 + 拖拽角度 + 缩放），刷新 / 重开页面都回到这里 */
const PIN_KEY = "fire:showcase:pose";
type ShowcasePose = { p: number; yaw: number; pitch: number; zoom: number };

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
  // 360° 环视（自动绕车）与影棚（明亮摄影棚）：两个胶囊以前只是文字，现在是真的开关
  const [orbit, setOrbit] = useState(false);
  const [studio, setStudio] = useState(false);
  // 引擎是异步创建的，点得比它早就先把状态存下来，创建完再补上
  const orbitRef = useRef(false);
  const studioRef = useRef(false);
  // 用户置顶的默认机位：默认隐藏，鼠标划过左下角胶囊才显示开关
  const [pinnedPose, setPinnedPose] = usePersistedState<ShowcasePose | null>(PIN_KEY, null);
  const pinnedPoseRef = useRef<ShowcasePose | null>(pinnedPose);
  useEffect(() => {
    pinnedPoseRef.current = pinnedPose;
  }, [pinnedPose]);
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
          // 置顶机位：引擎直接从置顶进度起步，不会先落到开场机位再弹回来
          startProgress: pinnedPoseRef.current?.p ?? 0,
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
        // 引擎是异步创建的：创建前点过的「360° 环视 / 影棚」要补上
        handle.setOrbit(orbitRef.current);
        handle.setStudio(studioRef.current);
        // 置顶机位：刷新 / 重建后直接把镜头放回用户存下的角度（滚动位置由下面的滚动守护负责）
        const pinned = pinnedPoseRef.current;
        if (pinned) {
          handle.applyPose(pinned);
        }
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

  // 刷新时浏览器会恢复上次的滚动位置（会话恢复、从别的页面回来、重新打开标签页都会触发），
  // 而这次恢复常常发生在我们重置之后 —— 于是「刷新」有时停在当时那个机位（车头朝左的侧视），
  // 有时才是默认机位（车头朝右的车尾 3/4），看着像默认姿势一直调不好。
  // 做法：关掉滚动恢复，并在开场把滚动位置持续钉在顶部（最多 12 秒）；
  // 用户一旦自己滚动（滚轮 / 触摸 / 键盘 / 按住滚动条）立刻交还控制权，之后不再干预。
  useEffect(() => {
    const prev = typeof history !== "undefined" && "scrollRestoration" in history ? history.scrollRestoration : null;
    try {
      if (prev !== null) history.scrollRestoration = "manual";
    } catch {
      /* 忽略 */
    }
    const mountAt = performance.now();
    // 首页的「默认机位」= 用户置顶的那一帧；没置顶就是开场（进度 0）。
    // 每帧都从 ref 取（置顶值可能晚一拍才从存储里读出来），所以这里不缓存成常量
    const homeTop = () => {
      const el = scrollRef.current;
      const stage = stageRef.current;
      if (!el || !stage) return 0;
      const total = Math.max(1, el.offsetHeight - stage.offsetHeight);
      const at = pinnedPoseRef.current?.p ?? 0;
      return el.getBoundingClientRect().top + window.scrollY + total * at;
    };
    window.scrollTo(0, homeTop());

    let released = false;
    const release = () => {
      released = true;
    };
    const releaseEvents: Array<keyof WindowEventMap> = ["wheel", "touchstart", "pointerdown", "mousedown", "keydown"];
    releaseEvents.forEach((name) => window.addEventListener(name, release, { passive: true }));

    let raf = 0;
    const pinTop = () => {
      // 钉到「用户自己滚动」为止；模型异常慢时最多钉 12 秒，避免长期占着页面
      const expired = performance.now() > mountAt + 12000;
      if (released || expired) return;
      if (Math.abs(window.scrollY - homeTop()) > 1) window.scrollTo(0, homeTop());
      raf = window.requestAnimationFrame(pinTop);
    };
    raf = window.requestAnimationFrame(pinTop);

    return () => {
      window.cancelAnimationFrame(raf);
      releaseEvents.forEach((name) => window.removeEventListener(name, release));
      if (prev !== null) {
        try {
          history.scrollRestoration = prev;
        } catch {
          /* 忽略 */
        }
      }
    };
  }, []);

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

  /** 360° 环视：自动绕车旋转，再点一次平滑回到叙事机位 */
  const toggleOrbit = useCallback(() => {
    setOrbit((prev) => {
      const next = !prev;
      orbitRef.current = next;
      handleRef.current?.setOrbit(next);
      return next;
    });
  }, []);

  /** 影棚：只切 3D 场景的光与背景（明亮摄影棚），不动深浅色主题 */
  const toggleStudio = useCallback(() => {
    setStudio((prev) => {
      const next = !prev;
      studioRef.current = next;
      handleRef.current?.setStudio(next);
      return next;
    });
  }, []);

  /** 底部章节导航：滚到该章节的进度（滚动本身驱动叙事，所以直接滚页面即可） */
  const goPhase = useCallback(
    (index: number) => {
      const el = scrollRef.current;
      const stage = stageRef.current;
      if (!el || !stage) return;
      const total = Math.max(1, el.offsetHeight - stage.offsetHeight);
      const top = el.getBoundingClientRect().top + window.scrollY;
      const at = config.phases[index]?.at ?? 0;
      // 多滚一点点：进度是弹簧跟随，正好停在章节边界上会判定为上一章
      window.scrollTo({ top: top + total * Math.min(0.999, at + 0.006), behavior: "smooth" });
    },
    [config.phases]
  );

  /** 置顶当前机位：把此刻的进度 / 角度 / 缩放存下来，刷新后回到这里 */
  const pinCurrentPose = useCallback(() => {
    const pose = handleRef.current?.readPose();
    if (!pose) return;
    setPinnedPose({
      p: +pose.p.toFixed(4),
      yaw: +pose.yaw.toFixed(2),
      pitch: +pose.pitch.toFixed(4),
      zoom: +pose.zoom.toFixed(3)
    });
  }, [setPinnedPose]);

  const clearPinnedPose = useCallback(() => setPinnedPose(null), [setPinnedPose]);

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

  // 影棚（明亮摄影棚）下画面是亮的，HUD 文字要跟着换成浅色系，否则白字压在白底上看不见
  return (
    <div className={`showcase ${theme === "light" || studio ? "light" : ""} ${className}`}>
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
                  {/* 双音符（♫）：播放时实心、暂停时描边，配色跟随深浅色主题 */}
                  {musicOn ? (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M9 17.4V6.6l9-1.8v10.6" />
                      <circle cx="6.7" cy="17.5" r="2.6" fill="currentColor" stroke="none" />
                      <circle cx="15.7" cy="15.6" r="2.6" fill="currentColor" stroke="none" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M9 17.4V6.6l9-1.8v10.6" />
                      <circle cx="6.7" cy="17.5" r="2.6" />
                      <circle cx="15.7" cy="15.6" r="2.6" />
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
              <button
                type="button"
                className={`sc-pill${orbit ? " on" : ""}`}
                onClick={toggleOrbit}
                aria-pressed={orbit}
                title={orbit ? "停止自动环视" : "自动绕车环视一圈"}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                  <path d="M12 5c5 0 9 4.5 9 7s-4 7-9 7-9-4.5-9-7 4-7 9-7z" />
                  <circle cx="12" cy="12" r="2.6" />
                </svg>
                {ui.view360}
              </button>
              <button
                type="button"
                className={`sc-pill${studio ? " on" : ""}`}
                onClick={toggleStudio}
                aria-pressed={studio}
                title={studio ? "回到夜间隧道光照" : "切到明亮摄影棚光照"}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                  <circle cx="12" cy="12" r="4" />
                  <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
                </svg>
                {ui.studio}
              </button>
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
              {/* 置顶机位：默认隐藏，鼠标划过胶囊才出现；置顶后刷新 / 重开都回到这一帧 */}
              <button
                type="button"
                className={`sc-pill sc-pin${pinnedPose ? " on" : ""}`}
                onClick={pinCurrentPose}
                aria-pressed={Boolean(pinnedPose)}
                title={pinnedPose ? "更新置顶机位：把当前视角存为默认" : "把当前视角置顶为默认机位（刷新后回到这里）"}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                  <path d="M12 17v5" />
                  <path d="M8 3h8l-1 6 3 3v2H6v-2l3-3-1-6z" />
                </svg>
                {pinnedPose ? "已置顶" : "置顶机位"}
              </button>
              {pinnedPose && (
                <button type="button" className="sc-pill sc-pin sc-pin-clear" onClick={clearPinnedPose} title="解除置顶，回到开场机位">
                  解除
                </button>
              )}
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
              {ui.nav.map((item, i) => (
                <button
                  type="button"
                  key={item}
                  className={phase === i ? "on" : undefined}
                  onClick={() => goPhase(i)}
                  aria-label={`跳到第 ${i + 1} 章 ${item}`}
                >
                  ▴ {item}
                </button>
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
