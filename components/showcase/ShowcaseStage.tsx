"use client";

import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ShowcaseConfig, ShowcaseHandle } from "./types";
import { setThemeCookie } from "@/lib/theme";
import { usePersistedState } from "@/lib/usePersistedState";
import type { WireframeMode } from "./wireframe";
import MusicIcon from "./MusicIcon";
import "./showcase.css";
import "./capsule.css";

const WIRE_COLORS = [
  ["黑色", "#000000"], ["浅灰", "#cccccc"], ["红色", "#ff0000"],
  ["蓝色", "#0000ff"], ["绿色", "#00ff00"], ["黄色", "#ffff00"],
] as const;
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
export default function ShowcaseStage({
  config,
  className = "",
  models,
  currentModel,
  onModelChange,
  onModelIntent,
  onImport,
  initialTheme = "dark"
}: {
  config: ShowcaseConfig;
  /** 服务端主题（主题 cookie）：首帧就是用户选的那个，浅色刷新不会先闪深色 */
  initialTheme?: "dark" | "light";
  className?: string;
  /** 可切换的车型清单（不传就只展示当前这一辆）；status/progress 由外层按需加载逻辑给出 */
  models?: Array<{
    id: string;
    label: string;
    note?: string;
    status?: "idle" | "loading" | "ready";
    progress?: number;
  }>;
  currentModel?: string;
  onModelChange?: (id: string) => void;
  /** 悬停 / 聚焦 / 触摸按下：外层据此静默预取素材 */
  onModelIntent?: (id: string) => void;
  /** 传了才显示车型条末尾的「＋」：点进导入向导（只有管理员会拿到这个回调） */
  onImport?: () => void;
}) {
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
  /** 上一帧的冻结图：换车型时当背景板，顶到新场景就绪再淡出（避免中间露出空场） */
  const freezeRef = useRef<HTMLCanvasElement | null>(null);
  /** 最新一次传入的 config：主 effect 只在「外壳」变化时重建，取最新值走这里，避免把 config 放进依赖 */
  const configRef = useRef(config);
  configRef.current = config;
  /** 已经应用到场景里的车型签名：和当前 config 不一致时走原地换车（不重建场景） */
  const appliedModelRef = useRef<string | null>(null);

  const [phase, setPhase] = useState(0);
  const [textVisible, setTextVisible] = useState(true);
  const [loadRatio, setLoadRatio] = useState(0);
  const [ready, setReady] = useState(false);
  const [racing, setRacing] = useState(false);
  const [theme, setTheme] = useState<"dark" | "light">(initialTheme);
  const [musicOn, setMusicOn] = useState(false);
  const [musicReady, setMusicReady] = useState(true);
  /** 频谱可视化是否接手（接手后关掉 CSS 兜底动画，避免动画盖住每帧的 transform） */
  const [waveLive, setWaveLive] = useState(false);
  // 360° 环视（自动绕车）与影棚（明亮摄影棚）：两个胶囊以前只是文字，现在是真的开关
  const [orbit, setOrbit] = useState(false);
  const [freeCamera, setFreeCamera] = useState(false);
  const freeCameraRef = useRef(false);
  const [wirePanel, setWirePanel] = useState(false);
  const wirePanelRef = useRef(false);
  const toggleWirePanel = (on: boolean) => {
    setWirePanel(on); wirePanelRef.current = on;
    handleRef.current?.setInspector(on);
  };
  const [wireMode, setWireMode] = useState<WireframeMode>("native");
  const [wireColor, setWireColor] = useState("#00ff00");
  const wireRef = useRef({ mode: wireMode, color: wireColor });
  const changeWire = (mode: WireframeMode, color = wireColor) => {
    setWireMode(mode); setWireColor(color);
    wireRef.current = { mode, color };
    handleRef.current?.setWireframe(mode, color);
  };
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
  useEffect(() => {
    if (!wirePanel) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setWirePanel(false); wirePanelRef.current = false;
        handleRef.current?.setInspector(false);
      }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [wirePanel]);
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

  /**
   * 车型签名：素材 + 车型参数。只有这一串变化时走「原地换车」（引擎不重建、镜头不动、不出现空白期）；
   * 其余字段（镜头 / 灯光 / 地面 / 文案）变了才重建整个场景。
   */
  const modelKey = useMemo(() => JSON.stringify({ a: config.assets.model, m: config.model ?? null }), [config]);
  /** 外壳签名 = 去掉车型之后剩下的配置：变了才需要重建场景 */
  const shellKey = useMemo(() => {
    // 车型相关的两块（素材地址 + 车型参数）都要排掉，只留镜头 / 灯光 / 地面 / 文案这些「外壳」
    const { assets, model: _model, ...rest } = config;
    void _model;
    return JSON.stringify({ ...rest, assets: { ...assets, model: null } });
  }, [config]);

  /**
   * 首页的「固定机位」= 用户置顶的那一帧；没置顶就是开场（进度 0）。
   * 每帧都从 ref 取（置顶值可能晚一拍才从存储里读出来），所以不缓存成常量。
   * 开场的滚动守护与双击复位共用这一个。
   */
  const homeTop = useCallback(() => {
    const el = scrollRef.current;
    const stage = stageRef.current;
    if (!el || !stage) return 0;
    const total = Math.max(1, el.offsetHeight - stage.offsetHeight);
    const at = pinnedPoseRef.current?.p ?? 0;
    return el.getBoundingClientRect().top + window.scrollY + total * at;
  }, []);

  useEffect(() => {
    const wrap = canvasWrapRef.current;
    const stage = stageRef.current;
    const scroll = scrollRef.current;
    if (!wrap || !stage || !scroll) return;
    const cfg = configRef.current;

    // 每次实例化都新建 canvas：WebGL 上下文一旦丢失，同一个 canvas 上的上下文无法复活，
    // 复用 canvas 会导致「重建也还是白屏」。换新 canvas 才是真正可恢复的。
    const canvas = document.createElement("canvas");
    canvas.className = "sc-canvas";
    canvas.setAttribute("aria-label", `${cfg.watermark ?? "3D"} 3D 展示`);
    wrap.appendChild(canvas);

    // 换车型 / 重建：把上一帧冻结图铺在画布之上、HUD 之下，新场景就绪后淡出
    const frozen = freezeRef.current;
    freezeRef.current = null;
    /** 铺在画布上的冻结帧（可能正在淡出，所以一直留着引用，卸载时兜底移除） */
    let freezeEl: HTMLCanvasElement | null = null;
    let freezeTimer: number | null = null;
    let freezeFadeTimer: number | null = null;
    const dropFreeze = () => {
      if (!freezeEl || freezeEl.classList.contains("out")) return;
      freezeEl.classList.add("out");
      const el = freezeEl;
      freezeFadeTimer = window.setTimeout(() => el.remove(), 500);
    };
    if (frozen) {
      freezeEl = frozen;
      freezeEl.className = "sc-freeze";
      wrap.after(freezeEl);
      // 兜底：模型一直没就绪（加载失败 / 上下文异常）也不能让冻结帧一直盖着
      freezeTimer = window.setTimeout(dropFreeze, 10000);
    }

    let cancelled = false;
    let handle: ShowcaseHandle | null = null;

    (async () => {
      try {
        const { createShowcaseScene } = await import("./engine");
        if (cancelled) return;
        handle = createShowcaseScene({
          canvas,
          config: degraded
            ? { ...cfg, model: { ...cfg.model, maxTextureSize: 2048 } }
            : cfg,
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
            labels: (cfg.parts ?? [])
              .map((part, i) => ({ el: labelRefs.current[i], from: part.from, pos: part.pos }))
              .filter((item): item is { el: HTMLDivElement; from: number; pos: [number, number, number] } => Boolean(item.el))
          },
          onProgress: (ratio) => setLoadRatio(ratio),
          onReady: () => {
            setReady(true);
            dropFreeze();
          },
          onPhase: handlePhase,
          onRacing: (on) => setRacing(on),
          onResetView: () => {
            // 双击复位：置顶机位是「进度 + 角度 + 缩放」，角度引擎已经调好，
            // 这里把滚动位置带回置顶进度，才真的回到用户置顶的那一帧
            if (pinnedPoseRef.current) window.scrollTo({ top: homeTop(), behavior: "smooth" });
          },
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
        handle.setFreeCamera(freeCameraRef.current);
        handle.setWireframe(wireRef.current.mode, wireRef.current.color);
        handle.setStudio(studioRef.current);
        // 置顶机位：刷新 / 重建后直接把镜头放回用户存下的角度（滚动位置由下面的滚动守护负责）
        const pinned = pinnedPoseRef.current;
        if (pinned) {
          handle.applyPose(pinned);
          // 双击复位也回到这一帧（引擎自己归零会回到「不是我们设置的固定机位」）
          handle.setHomePose({ yaw: pinned.yaw, pitch: pinned.pitch, zoom: pinned.zoom });
        }
        handle.setInspector(wirePanelRef.current);
        handleRef.current = handle;
        // 记下这一轮挂的是哪辆车：之后 config 里只有车型变了就原地换车，不重建场景
        appliedModelRef.current = JSON.stringify({ a: cfg.assets.model, m: cfg.model ?? null });
        const now = configRef.current;
        const nowKey = JSON.stringify({ a: now.assets.model, m: now.model ?? null });
        if (nowKey !== appliedModelRef.current) {
          // 创建期间用户已经切了车：等引擎挂完这一次再补一次原地换车
          void handle.setModel({ asset: now.assets.model, model: now.model }).then((ok) => {
            if (ok) appliedModelRef.current = nowKey;
          });
        }
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
      // 先冻结这一帧：下一个实例（换车型 / 重建）拿它当背景板，避免中间露出空场
      try {
        const shot = handle?.snapshot();
        if (shot) freezeRef.current = shot;
      } catch {
        /* 快照失败就不铺背景板，只影响过渡观感 */
      }
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
      if (freezeTimer !== null) window.clearTimeout(freezeTimer);
      if (freezeFadeTimer !== null) window.clearTimeout(freezeFadeTimer);
      freezeEl?.remove();
      freezeEl = null;
      handle = null;
      handleRef.current = null;
      if (fadeTimer.current) window.clearTimeout(fadeTimer.current);
    };
    // 依赖里放的是「外壳签名」：只有镜头 / 灯光 / 地面 / 文案这些变了才重建场景，
    // 单纯换车型走下面的 setModel（原地换车，不重建、不空白）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shellKey, handlePhase, rebuild, degraded, retry, homeTop]);

  // 置顶机位变化就同步给引擎：双击复位回到用户置顶的那一帧（没置顶时传 null = 回到中立角度）
  useEffect(() => {
    handleRef.current?.setHomePose(
      pinnedPose ? { yaw: pinnedPose.yaw, pitch: pinnedPose.pitch, zoom: pinnedPose.zoom } : null
    );
  }, [pinnedPose]);

  // 换车型：原地换车（引擎、镜头、地面、HUD 都不动），切换过程没有空白期
  useEffect(() => {
    if (appliedModelRef.current === null || appliedModelRef.current === modelKey) return;
    const handle = handleRef.current;
    if (!handle) return;
    const previous = appliedModelRef.current;
    appliedModelRef.current = modelKey;
    const next = configRef.current;
    void handle.setModel({ asset: next.assets.model, model: next.model }).then((ok) => {
      // 失败（素材取不到 / 解析失败）就把标记退回去，下次变更还能重试
      if (!ok) appliedModelRef.current = previous;
    });
  }, [modelKey]);

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
  }, [homeTop]);

  /**
   * 主题首帧由服务端给（主题 cookie），所以浅色用户刷新时不会先渲染一屏深色再切过来。
   * 挂载后仍读一次 localStorage：两边不一致时以 localStorage 为准并回写 cookie（老数据自愈）。
   */
  const themeRef = useRef<"dark" | "light">(initialTheme);
  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem("fire.theme");
    } catch {
      /* 忽略 */
    }
    if (saved !== "light" && saved !== "dark") return;
    const next: "dark" | "light" = saved;
    if (next !== themeRef.current) {
      themeRef.current = next;
      setTheme(next);
      handleRef.current?.setTheme(next);
    }
    // localStorage 与 cookie 不一致时补写 cookie，下次刷新的首帧就是同一个值
    document.documentElement.classList.toggle("dark", next === "dark");
    setThemeCookie(next === "dark");
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
      setFreeCamera(false);
      freeCameraRef.current = false;
      handleRef.current?.setFreeCamera(false);
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

  // 音乐波纹：用 Web Audio 的频谱分析驱动每根条，跟着歌曲本身的起伏动
  //（平稳段落幅度小、高潮段落幅度大）；拿不到 AudioContext 时退回 CSS 循环动画。
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const waveRafRef = useRef(0);
  const waveDataRef = useRef<Uint8Array | null>(null);
  const waveLevelRef = useRef<number[]>([0, 0, 0, 0, 0, 0]);
  const bandMaxRef = useRef<number[]>([0.05, 0.05, 0.05, 0.05, 0.05, 0.05]);
  const globalMaxRef = useRef(0.05);

  const stopWaveVisualizer = useCallback(() => {
    if (waveRafRef.current) window.cancelAnimationFrame(waveRafRef.current);
    waveRafRef.current = 0;
    waveLevelRef.current = [0, 0, 0, 0, 0, 0];
    setWaveLive(false);
    document.querySelectorAll<SVGPathElement>(".sc-wave .sc-wave-bar").forEach((bar) => {
      bar.style.transform = "";
    });
  }, []);

  const startWaveVisualizer = useCallback((audio: HTMLAudioElement) => {
    try {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      if (!audioCtxRef.current) audioCtxRef.current = new Ctor();
      const ctx = audioCtxRef.current;
      if (!analyserRef.current) {
        // 一个 audio 元素只能建一次 MediaElementSource，所以只在这里建一次
        const source = ctx.createMediaElementSource(audio);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.72;
        source.connect(analyser);
        analyser.connect(ctx.destination);
        analyserRef.current = analyser;
      }
      void ctx.resume();
      setWaveLive(true);
      if (waveRafRef.current) return;
      const analyser = analyserRef.current;
      const tick = () => {
        if (!analyser) {
          waveRafRef.current = 0;
          return;
        }
        const bins = analyser.frequencyBinCount;
        const data =
          waveDataRef.current && waveDataRef.current.length === bins
            ? waveDataRef.current
            : (waveDataRef.current = new Uint8Array(bins));
        analyser.getByteFrequencyData(data);
        const bars = document.querySelectorAll<SVGPathElement>(".sc-wave .sc-wave-bar");
        // 频段边界覆盖 0–11 kHz（音乐能量集中区）：bin ≈ 172 Hz（44.1 kHz / fftSize 256）
        const EDGES = [0, 2, 5, 11, 21, 38, 64];
        const raws: number[] = [];
        let sumAll = 0;
        let countAll = 0;
        for (let i = 0; i < 6; i += 1) {
          const from = Math.min(bins - 1, EDGES[i]);
          const to = Math.max(from + 1, Math.min(bins, EDGES[i + 1]));
          let sum = 0;
          for (let k = from; k < to; k += 1) sum += data[k];
          const raw = sum / Math.max(1, to - from) / 255;
          raws.push(raw);
          sumAll += raw;
          countAll += 1;
        }
        const globalNow = sumAll / Math.max(1, countAll);
        // 邻近频段补值：这首歌高频几乎没有能量（第 6 段实测常年为 0），
        // 直接用原始值会让最后一根像静止；这里让每段至少借到邻居的一部分能量
        const leveled = raws.map((v, i) =>
          Math.max(v, (raws[i - 1] ?? 0) * 0.62, (raws[i + 1] ?? 0) * 0.52)
        );
        // 每段各自的峰值（缓降）＋整首的峰值：前者保证每根都有起伏、不会像静止，
        // 后者让「平稳段落幅度小、高潮幅度大」这件事在整体上看得出来
        const decay = 0.995;
        bandMaxRef.current = bandMaxRef.current.map((m, i) => Math.max(leveled[i] * 1.05, m * decay, 0.04));
        // 频率倾斜：低音压下去（不抢戏，柱子矮）、高音补上来
        const TILT = [0.32, 0.5, 0.72, 0.92, 1.1, 1.25];
        const tilted = leveled.map((v, i) => v * TILT[i]);
        const peakNow = Math.max(...tilted);
        const globalMax = Math.max(peakNow * 1.05, globalMaxRef.current * decay, 0.05);
        globalMaxRef.current = globalMax;
        // 整体强度：平稳段落幅度小、高潮段落幅度大
        const intensity = Math.min(1, Math.pow(globalNow / Math.max(globalMax * 0.6, 0.03), 0.7));
        const now = performance.now() / 1000;
        const next: number[] = [];
        for (let i = 0; i < 6; i += 1) {
          const rel = Math.pow(Math.min(1, tilted[i] / globalMax), 0.55);
          // 从左往右推进的相位包络：每根比左边晚 0.62 弧度，整排像一道波滚过去，
          // 幅度仍由音乐本身（rel × intensity）决定，所以换歌照样适用
          const envelope = 0.52 + 0.48 * Math.sin(now * 2.2 - i * 0.62);
          const target = Math.max(0, Math.min(1, rel * envelope * (0.55 + 0.45 * intensity)));
          const prev = waveLevelRef.current[i] ?? 0;
          // 涨得快、落得慢：保留「平稳 / 高潮」的起伏又保持流畅
          next.push(prev + (target - prev) * (target > prev ? 0.45 : 0.18));
        }
        waveLevelRef.current = next;
        // 调试用：把当前各段能量写在 svg 上（?mclhud=1 或控制台可直接看）
        const svg = document.querySelector<SVGSVGElement>(".sc-wave");
        if (svg) svg.dataset.bands = next.map((v) => v.toFixed(2)).join(",");
        bars.forEach((bar, i) => {
          const v = next[i] ?? 0;
          bar.style.transform = `scaleY(${(0.3 + v * 1.2).toFixed(3)})`;
        });
        waveRafRef.current = window.requestAnimationFrame(tick);
      };
      waveRafRef.current = window.requestAnimationFrame(tick);
    } catch {
      /* 拿不到音频上下文就让 CSS 动画兜底 */
    }
  }, []);

  const startMusic = useCallback(async () => {
    const audio = ensureAudio();
    try {
      await audio.play();
      startWaveVisualizer(audio);
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
    stopWaveVisualizer();
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
  }, [musicOn, startMusic, stopMusic, stopWaveVisualizer]);

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

  useEffect(() => () => {
    audioRef.current?.pause();
    stopWaveVisualizer();
  }, [stopWaveVisualizer]);

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
    touchHint: config.ui?.touchHint ?? "SWIPE TO LOOK · PINCH TO ZOOM · DOUBLE TAP RESET",
    zoomMode: config.ui?.zoomMode ?? "ZOOM",
    view360: config.ui?.view360 ?? "360° VIEW",
    studio: config.ui?.studio ?? "STUDIO",
    pinCamera: config.ui?.pinCamera ?? "PIN CAMERA",
    loading: config.ui?.loading ?? "LOADING MODEL",
    nav: config.ui?.nav ?? ["CAR", "AERO", "POWER", "TYRES", "TECH"]
  };

  // 影棚（明亮摄影棚）下画面是亮的，HUD 文字要跟着换成浅色系，否则白字压在白底上看不见
  return (
    <div className={`showcase ${freeCamera ? "sc-free" : ""} ${theme === "light" || studio || wirePanel ? "light" : ""} ${wirePanel ? "sc-inspecting" : ""} ${className}`}>
      <div className="sc-scroll" ref={scrollRef}>
        <div className="sc-stage" ref={stageRef}>
          <div className="sc-canvas-wrap" ref={canvasWrapRef} />
          <div className="sc-watermark" ref={markRef}>
            {config.watermark}
          </div>
          <div className="sc-vignette" />

          <div className="sc-hud">
            <div className="sc-row sc-tools">
              <div className="sc-wire-control" onKeyDown={(event) => {
                if (event.key === "Escape") { toggleWirePanel(false); event.currentTarget.querySelector("button")?.focus(); }
              }}>
                <button type="button" className={`sc-tool sc-glass-trigger${wirePanel ? " on" : ""}`}
                  aria-label="模型展示" title="模型展示" aria-expanded={wirePanel}
                  onClick={() => toggleWirePanel(!wirePanel)}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
                    <path d="m12 2 9 5v10l-9 5-9-5V7Zm0 0v20M3 7l18 10M21 7 3 17M3 7l9 5 9-5M3 17l9-5 9 5" />
                  </svg><span>模型</span>
                </button>
                {wirePanel && <div className="sc-wire-panel" role="group" aria-label="线框显示设置">
                  <div className="sc-wire-heading"><div><h3>模型展示</h3><p>每一处细节，自由探索。</p></div><button type="button" aria-label="关闭线框设置" onClick={() => toggleWirePanel(false)}>
                    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="m6 6 8 8M14 6l-8 8" /></svg>
                  </button></div>
                  <div className="sc-wire-modes" role="group" aria-label="显示模式" style={{ "--glass-index": ["native", "overlay", "wireframe"].indexOf(wireMode) } as CSSProperties}>
                    <span className="sc-mode-lens" aria-hidden="true"><i key={wireMode} /></span>
                    {([["native", "原生"], ["overlay", "叠加线框"], ["wireframe", "纯线框"]] as const).map(([mode, label]) =>
                      <button type="button" key={mode} aria-pressed={wireMode === mode} onClick={() => changeWire(mode)}>{label}</button>)}
                  </div>
                  <div className="sc-wire-color-label"><span>线框颜色</span><span>{WIRE_COLORS.find(([, color]) => color === wireColor)?.[0]}</span></div>
                  <div className={`sc-wire-colors${wireMode === "native" ? " is-native" : ""}`} role="group" aria-label="线框颜色"
                    style={{ "--glass-color-index": WIRE_COLORS.findIndex(([, color]) => color === wireColor) } as CSSProperties}>
                    <span className="sc-color-lens" aria-hidden="true"><i key={wireColor} /></span>
                    {WIRE_COLORS.map(([label, color]) => <button type="button" key={color}
                      title={label} aria-label={`${label}线框`} aria-pressed={wireMode !== "native" && wireColor === color}
                      onClick={() => changeWire(wireMode === "native" ? "overlay" : wireMode, color)}><span style={{ background: color }} /></button>)}
                  </div>
                  <p className="sc-wire-help">拖拽环视 <span>·</span> 滚轮或双指缩放</p>
                  <button type="button" className="sc-inspector-reset" onClick={() => handleRef.current?.resetCamera()}><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 8a6 6 0 1 1 0 4M4 4v4h4" /></svg>重置视角</button>
                </div>}
              </div>
              {musicReady && (
                <button
                  type="button"
                  className={`sc-tool fire-cap${musicOn ? " on" : ""}`}
                  onClick={toggleMusic}
                  title={musicOn ? "关闭背景音乐" : "播放背景音乐"}
                  aria-label={musicOn ? "关闭背景音乐" : "播放背景音乐"}
                  aria-pressed={musicOn}
                >
                  {/* 波纹图标（waveform.mid）：配色跟随主题，播放时每根条跟着舞动 */}
                  <MusicIcon playing={musicOn} live={waveLive} />
                </button>
              )}
              <button
                type="button"
                className="sc-tool fire-cap"
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
                className={`sc-pill fire-cap${orbit ? " on" : ""}`}
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
                className={`sc-pill fire-cap${studio ? " on" : ""}`}
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
                className="sc-pill sc-zoom-mode fire-cap"
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
              <button type="button" className="sc-zoom fire-cap" ref={zoomOutRef} title="缩小（⌘/Ctrl + 滚轮）" aria-label="缩小">
                −
              </button>
              <button type="button" className="sc-zoom fire-cap" ref={zoomInRef} title="放大看细节（⌘/Ctrl + 滚轮）" aria-label="放大">
                ＋
              </button>
              {/* 固定机位：图标 + 文字。点一下把当前视角固定下来（有底色），再点一下取消（底色消失） */}
              <button
                type="button"
                className={`sc-pill sc-pin fire-cap${pinnedPose ? " on" : ""}`}
                onClick={pinnedPose ? clearPinnedPose : pinCurrentPose}
                aria-pressed={Boolean(pinnedPose)}
                title={pinnedPose ? "已固定当前机位：再点一下取消固定" : "把当前视角固定为默认机位（刷新后回到这里）"}
                aria-label={pinnedPose ? "取消固定机位" : "固定当前机位"}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                  <path d="M12 17v5" />
                  <path d="M8 3h8l-1 6 3 3v2H6v-2l3-3-1-6z" />
                </svg>
                {ui.pinCamera}
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
              <span>{freeCamera ? "自由镜头 · 滚轮缩放 · 双击车身聚焦" : ui.zoomHint}</span>
            </div>
            <div className="sc-row sc-hint-touch">{freeCamera ? "单指环视 · 双指缩放 · 双击车身聚焦" : ui.touchHint}</div>
            {/* 章节导航：右侧竖排指示器（短横条 + 当前章节更长更亮），悬停 / 键盘聚焦显示章节名 */}
            <div className="sc-row sc-nav">
              {ui.nav.map((item, i) => (
                <button
                  type="button"
                  key={item}
                  className={!freeCamera && phase === i ? "on" : undefined}
                  onClick={() => goPhase(i)}
                  aria-label={`跳到第 ${i + 1} 章 ${item}`}
                  aria-current={!freeCamera && phase === i ? "true" : undefined}
                >
                  <span className="sc-nav-label" aria-hidden="true">
                    {item}
                  </span>
                  <span className="sc-nav-tick" aria-hidden="true" />
                </button>
              ))}
              <button type="button" className={`sc-free-camera${freeCamera ? " on" : ""}`}
                aria-label="自由镜头" aria-pressed={freeCamera}
                onClick={() => {
                  const next = !freeCamera;
                  setFreeCamera(next); freeCameraRef.current = next;
                  setOrbit(false); orbitRef.current = false;
                  handleRef.current?.setOrbit(false);
                  handleRef.current?.setFreeCamera(next);
                }}>
                <span className="sc-nav-label">自由镜头</span>
                <span className="sc-nav-tick" aria-hidden="true" />
              </button>
              {freeCamera && <button type="button" className="sc-camera-reset" onClick={() => handleRef.current?.resetCamera()} aria-label="重置自由镜头">复位</button>}
            </div>
            {models && models.length > 0 && (models.length > 1 || onImport) && (
              <div className="sc-row sc-models">
                <span className="sc-models-cap">车型</span>
                {models.map((item) => {
                  const loading = item.status === "loading" && item.id !== currentModel;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={`sc-model fire-cap${item.id === currentModel ? " on" : ""}${loading ? " loading" : ""}`}
                      onClick={() => onModelChange?.(item.id)}
                      onPointerEnter={() => onModelIntent?.(item.id)}
                      onFocus={() => onModelIntent?.(item.id)}
                      onTouchStart={() => onModelIntent?.(item.id)}
                      aria-pressed={item.id === currentModel}
                      title={item.note ? `${item.label} · ${item.note}` : item.label}
                    >
                      <span className="sc-model-label">{item.label}</span>
                      {loading && <span className="sc-model-bar" style={{ width: `${Math.round((item.progress ?? 0) * 100)}%` }} />}
                    </button>
                  );
                })}
                {/* 导入车型：排在车型条最后一位，管理员才看得到 */}
                {onImport && (
                  <button
                    type="button"
                    className="sc-model sc-model-add fire-cap"
                    onClick={onImport}
                    title="导入车型（.glb 放进 uploads 卷，不进仓库）"
                    aria-label="导入车型"
                  >
                    <span className="sc-model-label">＋</span>
                  </button>
                )}
              </div>
            )}
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
