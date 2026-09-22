"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ShowcaseConfig, ShowcaseDiscStyle, ShowcaseDriveCamera, ShowcaseHandle } from "./types";
import { setThemeCookie } from "@/lib/theme";
import { usePersistedState } from "@/lib/usePersistedState";
import type { WireframeMode } from "./wireframe";
import LiquidGlassControl from "@/components/LiquidGlassControl";
import { hasLoadedModel, rememberLoadedModel } from "./loadHistory";
import MusicIcon from "./MusicIcon";
import { constrainedGraphics, rememberWorkingQuality, recoveryQuality } from "./modelMemory";
import "./showcase.css";
import "./capsule.css";

const WIRE_COLORS = [
  ["黑色", "#000000"], ["浅灰", "#cccccc"], ["红色", "#ff0000"],
  ["蓝色", "#0000ff"], ["绿色", "#00ff00"], ["黄色", "#ffff00"],
] as const;
const RPM_TICKS = 20;
const DRIVE_CAMERA_OPTIONS: Array<{ key: ShowcaseDriveCamera; label: string }> = [
  { key: "follow", label: "车尾跟随" },
  { key: "left", label: "左侧" },
  { key: "right", label: "右侧" },
  { key: "top", label: "俯视" },
  { key: "classic", label: "原镜头" },
  { key: "free", label: "自由镜头" },
];
/** 用户置顶的默认机位（进度 + 拖拽角度 + 缩放），刷新 / 重开页面都回到这里 */
const PIN_KEY = "fire:showcase:pose";
const WIRE_MODE_KEY = "fire:showcase:wire-mode";
const WIRE_COLOR_KEY = "fire:showcase:wire-color";
const DISC_STYLE_KEY = "fire:showcase:disc-style";
const DISC_CHOSEN_KEY = "fire:showcase:disc-chosen";
const DISC_LABELS: Record<ShowcaseDiscStyle, string> = { none: "无圆盘", chrono: "刻度盘", track: "赛道盘" };
const TEXTURE_QUALITY_KEY = "fire:showcase:texture-quality";
const RESUME_FRAME_KEY = "fire:showcase:resume-frame:v1";
type TextureQuality = "fast" | "balanced" | "fine" | "original";
const TEXTURE_QUALITY: Record<TextureQuality, { label: string; badge: string; size: number }> = {
  fast: { label: "流畅", badge: "1K", size: 1024 },
  balanced: { label: "均衡", badge: "2K", size: 2048 },
  fine: { label: "精细", badge: "4K", size: 4096 },
  original: { label: "原画", badge: "RAW", size: 16384 }
};
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
  const qualitySwitchRef = useRef(0);

  const [phase, setPhase] = useState(0);
  const [textVisible, setTextVisible] = useState(true);
  const [loadRatio, setLoadRatio] = useState(0);
  const [ready, setReady] = useState(false);
  const [qualityLoading, setQualityLoading] = useState(false);
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [noticeKey, setNoticeKey] = useState<string | null>(null);
  useEffect(() => {
    setNoticeKey(null);
    if (!loadingKey || hasLoadedModel(loadingKey)) return;
    const timer = window.setTimeout(() => setNoticeKey(loadingKey), 350);
    return () => window.clearTimeout(timer);
  }, [loadingKey]);
  const showLoadingNotice = loadingKey !== null && noticeKey === loadingKey;
  const [qualityError, setQualityError] = useState(false);
  const [textureLimitNotice, setTextureLimitNotice] = useState<number | null>(null);
  const [memoryNotice, setMemoryNotice] = useState<string | null>(null);
  const [racing, setRacing] = useState(false);
  const [driving, setDriving] = useState(false);
  const [driveCamera, setDriveCamera] = useState<ShowcaseDriveCamera>("follow");
  const driveCameraRef = useRef<ShowcaseDriveCamera>("follow");
  const [driveCameraOpen, setDriveCameraOpen] = useState(false);
  useEffect(() => { if (!racing && !driving) setDriveCameraOpen(false); }, [racing, driving]);
  const [selectionHint, setSelectionHint] = useState<string | null>(null);
  const selectionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showSelectionHint = useCallback((key: string) => {
    if (selectionTimerRef.current) clearTimeout(selectionTimerRef.current);
    setSelectionHint(key);
    selectionTimerRef.current = setTimeout(() => setSelectionHint(null), 2400);
  }, []);
  useEffect(() => () => {
    if (selectionTimerRef.current) clearTimeout(selectionTimerRef.current);
  }, []);
  const [leftDrawerOpen, setLeftDrawerOpen] = useState(false);
  const [rightDrawerOpen, setRightDrawerOpen] = useState(false);
  const leftDrawerRef = useRef<HTMLDivElement | null>(null);
  const rightDrawerRef = useRef<HTMLDivElement | null>(null);
  const [theme, setTheme] = useState<"dark" | "light">(initialTheme);
  const [musicOn, setMusicOn] = useState(false);
  const [musicReady, setMusicReady] = useState(true);
  /** 频谱可视化是否接手（接手后关掉 CSS 兜底动画，避免动画盖住每帧的 transform） */
  const [waveLive, setWaveLive] = useState(false);
  // 360° 环视（自动绕车）与影棚（明亮摄影棚）：两个胶囊以前只是文字，现在是真的开关
  const [orbit, setOrbit] = useState(false);
  const [freeCamera, setFreeCamera] = useState(false);
  const freeCameraRef = useRef(false);
  const [inspector, setInspector] = useState(false);
  const inspectorRef = useRef(false);
  const [wirePanel, setWirePanel] = useState(false);
  const wirePanelRef = useRef(false);
  const wireControlRef = useRef<HTMLDivElement | null>(null);
  const setWirePanelOpen = (on: boolean) => {
    setWirePanel(on); wirePanelRef.current = on;
  };
  const enterInspector = () => {
    setInspector(true); inspectorRef.current = true;
    setWirePanelOpen(true);
    handleRef.current?.setInspector(true);
    // 首页先用轻量模型获得很快的可交互首帧；进入展示后在后台换回完整模型。
    // 完整模型挂好后再生成线框，避免对低清、高清各算一遍边线。
    const current = configRef.current;
    const switchId = ++qualitySwitchRef.current;
    setQualityLoading(true);
    const fullKey = JSON.stringify({ a: (textureQualityRef.current === "original" ? current.assets.gpuModel ?? current.assets.model : current.assets.model), m: current.model ?? null, q: textureQualityRef.current });
    setLoadingKey(fullKey);
    const promote = appliedModelRef.current === fullKey
      ? Promise.resolve(true)
      : handleRef.current?.setModel({ asset: (textureQualityRef.current === "original" ? current.assets.gpuModel ?? current.assets.model : current.assets.model), model: qualityModel(current.model) }) ?? Promise.resolve(false);
    void promote.then((ok) => {
      if (switchId !== qualitySwitchRef.current) return;
      setQualityLoading(false);
      setLoadingKey(null);
      setQualityError(!ok);
      if (ok) { appliedModelRef.current = fullKey; rememberLoadedModel(fullKey); }
      window.requestAnimationFrame(() => {
        if (inspectorRef.current) handleRef.current?.setWireframe(wireRef.current.mode, wireRef.current.color);
      });
    });
  };
  const exitInspector = () => {
    qualitySwitchRef.current += 1;
    setQualityLoading(false);
    setLoadingKey(null);
    setWirePanelOpen(false);
    setInspector(false); inspectorRef.current = false;
    handleRef.current?.setInspector(false);
    // 展示里选的叠加 / 纯线框也是首页的当前形态；不能在返回时强制清成原生。
    // 线框需要完整网格，只有原生 + 流畅档才回到轻量预览模型。
    if (textureQualityRef.current === "fast" && wireRef.current.mode === "native") {
      const current = configRef.current;
      const asset = current.assets.previewModel ?? current.assets.model;
      const key = JSON.stringify({ a: asset, m: current.model ?? null, q: textureQualityRef.current });
      void handleRef.current?.setModel({ asset, model: qualityModel(current.model) }).then((ok) => {
        if (ok) appliedModelRef.current = key;
      });
    }
  };
  const toggleInspectorPanel = () => {
    if (!inspectorRef.current) {
      enterInspector();
      return;
    }
    setWirePanelOpen(!wirePanelRef.current);
  };
  const [wireMode, setWireMode] = usePersistedState<WireframeMode>(WIRE_MODE_KEY, "native");
  const [wireColor, setWireColor] = usePersistedState(WIRE_COLOR_KEY, "#00ff00");
  const wireRef = useRef({ mode: wireMode, color: wireColor });
  // 本地偏好在挂载后恢复；每次渲染同步 ref，并把恢复后的形态补到已创建的场景。
  wireRef.current = { mode: wireMode, color: wireColor };
  useEffect(() => {
    handleRef.current?.setWireframe(wireMode, wireColor);
  }, [wireMode, wireColor]);
  const changeWire = (mode: WireframeMode, color = wireColor) => {
    setWireMode(mode); setWireColor(color);
    wireRef.current = { mode, color };
    if (inspectorRef.current) handleRef.current?.setWireframe(mode, color);
  };
  const [studio, setStudio] = useState(false);
  const [discStyle, setDiscStyle] = usePersistedState<ShowcaseDiscStyle>(DISC_STYLE_KEY, "chrono");
  const [discChosen, setDiscChosen] = usePersistedState(DISC_CHOSEN_KEY, false);
  const [mobileDiscDefault, setMobileDiscDefault] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 640px), (max-height: 500px) and (pointer: coarse)");
    const update = () => setMobileDiscDefault(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const activeDiscStyle: ShowcaseDiscStyle = !discChosen && discStyle === "chrono" && mobileDiscDefault ? "none" : discStyle;
  const discStyleRef = useRef<ShowcaseDiscStyle>(discStyle);
  discStyleRef.current = activeDiscStyle;
  const toggleDiscStyle = () => {
    const next: ShowcaseDiscStyle = discStyleRef.current === "chrono" ? "track" : discStyleRef.current === "track" ? "none" : "chrono";
    discStyleRef.current = next;
    setDiscChosen(true);
    setDiscStyle(next);
    handleRef.current?.setDiscStyle(next);
  };
  useEffect(() => { handleRef.current?.setDiscStyle(activeDiscStyle); }, [activeDiscStyle]);
  const [textureQuality, setTextureQuality] = usePersistedState<TextureQuality>(TEXTURE_QUALITY_KEY, "fast");
  const textureQualityRef = useRef<TextureQuality>(textureQuality);
  textureQualityRef.current = textureQuality;
  const qualityModel = useCallback((model: ShowcaseConfig["model"]) => ({
    ...model,
    maxTextureSize: TEXTURE_QUALITY[textureQualityRef.current].size
  }), []);
  useEffect(() => {
    // 旧版把正常刷新 / 取消加载误判为崩溃。清除旧标记，不改写画质偏好。
    try { sessionStorage.removeItem("fire:showcase:pending-heavy-load"); } catch { /* 存储不可用 */ }
  }, []);
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
  const coordinateRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    let frame = 0;
    let lastPaint = 0;
    const paint = (now: number) => {
      if (now - lastPaint >= 160) {
        lastPaint = now;
        const el = coordinateRef.current;
        const handle = handleRef.current;
        if (el && handle) {
          const data = handle.debug();
          const title = `${data.inspector ? "模型展示" : "首页"} · ${models?.find(item => item.id === currentModel)?.label ?? config.watermark ?? "车型"}`;
          el.textContent = `${title}\n水平角 ${data.viewAzimuth.toFixed(2)}°  俯仰角 ${data.viewElevation.toFixed(2)}°\n缩放 ${data.zoom.toFixed(3)}  距离 ${data.viewDistance.toFixed(3)}  页面 ${data.progress.toFixed(4)}`;
        }
      }
      frame = window.requestAnimationFrame(paint);
    };
    frame = window.requestAnimationFrame(paint);
    return () => window.cancelAnimationFrame(frame);
  }, [config.watermark, currentModel, models]);
  useEffect(() => {
    if (!wirePanel) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !wireControlRef.current?.contains(event.target)) {
        setWirePanelOpen(false);
      }
    };
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setWirePanelOpen(false);
        wireControlRef.current?.querySelector<HTMLButtonElement>(".sc-glass-trigger")?.focus();
      }
    };
    document.addEventListener("pointerdown", closeOutside, true);
    window.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", closeOutside, true);
      window.removeEventListener("keydown", close);
    };
  }, [wirePanel]);
  useEffect(() => {
    if (!leftDrawerOpen && !rightDrawerOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (leftDrawerRef.current?.contains(event.target) || rightDrawerRef.current?.contains(event.target)) return;
      setLeftDrawerOpen(false);
      setRightDrawerOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside, true);
    return () => document.removeEventListener("pointerdown", closeOutside, true);
  }, [leftDrawerOpen, rightDrawerOpen]);
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || wirePanelRef.current) return;
      setLeftDrawerOpen(false);
      setRightDrawerOpen(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, []);
  // WebGL 上下文丢了就重建一次场景（重建计数用作 key，触发重新挂载）
  const [rebuild, setRebuild] = useState(0);
  const [retry, setRetry] = useState(0);
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
  const modelKey = useMemo(() => JSON.stringify({
    a: textureQuality !== "fast" || wireMode !== "native" ? (textureQuality === "original" ? config.assets.gpuModel ?? config.assets.model : config.assets.model) : (config.assets.previewModel ?? config.assets.model),
    m: config.model ?? null,
    q: textureQuality
  }), [config, textureQuality, wireMode]);
  /** 外壳签名 = 去掉车型之后剩下的配置：变了才需要重建场景 */
  const shellKey = useMemo(() => {
    // 车型相关的两块（素材地址 + 车型参数）都要排掉，只留镜头 / 灯光 / 地面 / 文案这些「外壳」
    const { assets, model: _model, ...rest } = config;
    void _model;
    return JSON.stringify({ ...rest, assets: { ...assets, model: null, previewModel: null, gpuModel: null } });
  }, [config]);

  useEffect(() => {
    const wrap = canvasWrapRef.current;
    const stage = stageRef.current;
    const scroll = scrollRef.current;
    if (!wrap || !stage || !scroll) return;
    setDriving(false);
    const cfg = configRef.current;
    const resumeKey = JSON.stringify({ model: cfg.assets.model, theme: themeRef.current });

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
    let freezeEl: HTMLCanvasElement | HTMLImageElement | null = null;
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
    } else {
      // 同一标签页刷新时先展示上一张成功渲染的画面，等轻量车真正可操作后淡出。
      try {
        const saved = JSON.parse(sessionStorage.getItem(RESUME_FRAME_KEY) ?? "null") as { key?: string; image?: string } | null;
        if (saved?.key === resumeKey && saved.image?.startsWith("data:image/jpeg;base64,")) {
          freezeEl = new Image();
          freezeEl.src = saved.image;
        }
      } catch { /* 存储受限时照常加载 3D */ }
    }
    if (freezeEl) {
      freezeEl.className = "sc-freeze";
      wrap.after(freezeEl);
      // 兜底：模型一直没就绪（加载失败 / 上下文异常）也不能让冻结帧一直盖着
      freezeTimer = window.setTimeout(dropFreeze, 10000);
    }

    let cancelled = false;
    let recoveryRequested = false;
    let handle: ShowcaseHandle | null = null;
    let initialReady = false;
    let upgradeTimer: number | null = null;
    const saveResumeFrame = () => {
      if (cancelled || !handle || !initialReady || configRef.current.assets.model !== cfg.assets.model || themeRef.current !== initialTheme) return;
      try {
        const shot = handle.snapshot();
        if (shot) sessionStorage.setItem(RESUME_FRAME_KEY, JSON.stringify({ key: resumeKey, image: shot.toDataURL("image/jpeg", 0.72) }));
      } catch { /* 截图或存储失败不影响模型交互 */ }
    };
    setReady(false);
    setLoadRatio(0);
    setError(null);

    (async () => {
      try {
        const { createShowcaseScene } = await import("./engine");
        if (cancelled) return;
        const requestedQuality = textureQualityRef.current;
        const requestedAsset = inspectorRef.current || requestedQuality !== "fast" || wireRef.current.mode !== "native"
          ? (textureQualityRef.current === "original" ? cfg.assets.gpuModel ?? cfg.assets.model : cfg.assets.model)
          : (cfg.assets.previewModel ?? cfg.assets.model);
        // 所有设备先显示轻量车；手机若直接解析用户记住的 RAW，会在十多秒内一直空白。
        const bootstrapPreview = !inspectorRef.current && wireRef.current.mode === "native"
          && requestedQuality !== "fast" && !!cfg.assets.previewModel && cfg.assets.previewModel !== requestedAsset;
        const initialAsset = bootstrapPreview ? cfg.assets.previewModel! : requestedAsset;
        const initialQuality = bootstrapPreview ? "fast" : requestedQuality;
        const initialKey = JSON.stringify({ a: initialAsset, m: cfg.model ?? null, q: initialQuality });
        setLoadingKey(initialKey);
        handle = createShowcaseScene({
          canvas,
          initialTheme: themeRef.current,
          config: { ...cfg, assets: { ...cfg.assets, model: initialAsset }, model: { ...cfg.model, maxTextureSize: TEXTURE_QUALITY[initialQuality].size } },
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
          onProgress: (ratio) => {
            if (cancelled || recoveryRequested) return;
            // 下载完成后还要解析贴图、挂载模型；只有 onReady 才表示整轮就绪。
            setLoadRatio(Math.min(0.99, Math.max(0, ratio)));
          },
          onReady: () => {
            if (cancelled || recoveryRequested || initialReady) return;
            initialReady = true;
            setLoadRatio(1);
            setError(null);
            setReady(true);
            rememberLoadedModel(initialKey);
            setLoadingKey(null);
            rememberWorkingQuality(cfg.assets.model, initialQuality);
            dropFreeze();
            window.setTimeout(saveResumeFrame, 250);
            // 先给手机一个真正可交互的预览窗口；高清解码不能紧贴首帧把主线程占满。
            if (bootstrapPreview) upgradeTimer = window.setTimeout(() => window.requestAnimationFrame(() => {
              if (cancelled || recoveryRequested || !handle || handleRef.current !== handle
                || inspectorRef.current || wireRef.current.mode !== "native"
                || textureQualityRef.current !== requestedQuality || configRef.current.assets.model !== cfg.assets.model) return;
              const fullKey = JSON.stringify({ a: requestedAsset, m: cfg.model ?? null, q: requestedQuality });
              const switchId = ++qualitySwitchRef.current;
              appliedModelRef.current = fullKey;
              setQualityLoading(true);
              setLoadingKey(fullKey);
              void handle.setModel({ asset: requestedAsset, model: qualityModel(cfg.model) }).then((ok) => {
                if (cancelled || switchId !== qualitySwitchRef.current) return;
                if (!ok) appliedModelRef.current = initialKey;
                else {
                  rememberLoadedModel(fullKey);
                  rememberWorkingQuality(cfg.assets.model, requestedQuality);
                  window.setTimeout(saveResumeFrame, 250);
                }
                setQualityLoading(false);
                setQualityError(!ok);
                setLoadingKey(null);
              });
            }), constrainedGraphics() ? 1800 : 400);
          },
          onTextureBudget: limit => { if (!cancelled && !recoveryRequested) setTextureLimitNotice(limit); },
          onPhase: handlePhase,
          onRacing: (on) => setRacing(on),
          onDriving: (on) => setDriving(on),
          onResetView: () => {
            // 双击复位：置顶机位是「进度 + 角度 + 缩放」，角度引擎已经调好，
            // 这里同步章节进度，才真的回到用户置顶的那一帧
            if (pinnedPoseRef.current) {
              handleRef.current?.setProgress(pinnedPoseRef.current.p);
            }
          },
          onContextLost: () => {
            if (cancelled || recoveryRequested) return;
            recoveryRequested = true;
            setReady(false);
            setLoadRatio(0);
            const fallback = recoveryQuality(configRef.current.assets.model, textureQualityRef.current);
            if (!fallback || rebuild >= 4) {
              setError("模型显示中断，未找到其他已成功加载的画质；请手动重试");
              return;
            }
            textureQualityRef.current = fallback;
            setTextureQuality(fallback);
            wireRef.current.mode = "native";
            setWireMode("native");
            inspectorRef.current = false;
            setInspector(false);
            setWirePanelOpen(false);
            setMemoryNotice(`模型显示异常，已恢复此前加载成功的${TEXTURE_QUALITY[fallback].label}画质`);
            setError(null);
            setRebuild((n) => n + 1);
          },
          onError: (message) => {
            if (cancelled || recoveryRequested) return;
            if (message.startsWith("日间环境贴图加载失败")) {
              console.warn("[showcase]", message);
              return;
            }
            if (initialReady) {
              // 已成功显示的车不能因为高清升级失败重新盖上全屏加载层。
              setQualityLoading(false);
              setQualityError(true);
              setLoadingKey(null);
              setMemoryNotice(message);
              return;
            }
            setError(message);
            setReady(false);
            setMemoryNotice(message);
          }
        });
        handle.setTheme(themeRef.current);
        // 引擎是异步创建的：创建前点过的「360° 环视 / 影棚」要补上
        handle.setOrbit(orbitRef.current);
        handle.setFreeCamera(freeCameraRef.current);
        handle.setWireframe(wireRef.current.mode, wireRef.current.color);
        handle.setDiscStyle(discStyleRef.current);
        handle.setDriveCamera(driveCameraRef.current);
        handle.setStudio(studioRef.current);
        // 置顶机位：刷新 / 重建后直接把镜头放回用户存下的角度（滚动位置由下面的滚动守护负责）
        const pinned = pinnedPoseRef.current;
        if (pinned) {
          handle.applyPose(pinned);
          // 双击复位也回到这一帧（引擎自己归零会回到「不是我们设置的固定机位」）
          handle.setHomePose({ p: pinned.p, yaw: pinned.yaw, pitch: pinned.pitch, zoom: pinned.zoom });
        }
        handle.setInspector(inspectorRef.current);
        handleRef.current = handle;
        // 记下这一轮挂的是哪辆车：之后 config 里只有车型变了就原地换车，不重建场景
        appliedModelRef.current = initialKey;
        const now = configRef.current;
        const stillBootstrapping = bootstrapPreview && now.assets.model === cfg.assets.model
          && textureQualityRef.current === requestedQuality && !inspectorRef.current && wireRef.current.mode === "native";
        const nowAsset = stillBootstrapping ? initialAsset : inspectorRef.current || textureQualityRef.current !== "fast" || wireRef.current.mode !== "native"
          ? (textureQualityRef.current === "original" ? now.assets.gpuModel ?? now.assets.model : now.assets.model)
          : (now.assets.previewModel ?? now.assets.model);
        const nowKey = JSON.stringify({ a: nowAsset, m: now.model ?? null, q: stillBootstrapping ? "fast" : textureQualityRef.current });
        if (nowKey !== appliedModelRef.current) {
          // 创建期间用户已经切了车：等引擎挂完这一次再补一次原地换车
          void handle.setModel({ asset: nowAsset, model: qualityModel(now.model) }).then((ok) => {
            if (ok) appliedModelRef.current = nowKey;
          });
        }
        // 开发环境留一个调试句柄，方便按进度截图与排查（生产不会写）
        if (process.env.NODE_ENV !== "production") {
          (window as unknown as { __mcl?: ShowcaseHandle | null }).__mcl = handle;
        }
      } catch (err) {
        if (cancelled || recoveryRequested) return;
        // 上下文创建失败（例如同时打开太多 WebGL 页面）时不要就此放弃，隔一会儿再试一次
        setError(err instanceof Error ? err.message : String(err));
        if (!cancelled && rebuild < (constrainedGraphics() ? 1 : 4)) {
          window.setTimeout(() => {
            if (!cancelled) setRebuild((n) => n + 1);
          }, 1200);
        }
      }
    })();

    return () => {
      cancelled = true;
      qualitySwitchRef.current += 1;
      // 先冻结这一帧：下一个实例（换车型 / 重建）拿它当背景板，避免中间露出空场
      try {
        const shot = !recoveryRequested ? handle?.snapshot() : null;
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
      if (upgradeTimer !== null) window.clearTimeout(upgradeTimer);
    };
    // 依赖里放的是「外壳签名」：只有镜头 / 灯光 / 地面 / 文案这些变了才重建场景，
    // 单纯换车型走下面的 setModel（原地换车，不重建、不空白）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shellKey, handlePhase, rebuild, retry, qualityModel]);

  // 置顶机位变化就同步给引擎：双击复位回到用户置顶的那一帧（没置顶时传 null = 回到中立角度）
  useEffect(() => {
    handleRef.current?.setHomePose(
      pinnedPose ? { p: pinnedPose.p, yaw: pinnedPose.yaw, pitch: pinnedPose.pitch, zoom: pinnedPose.zoom } : null
    );
  }, [pinnedPose]);

  // 换车型：原地换车（引擎、镜头、地面、HUD 都不动），切换过程没有空白期
  useEffect(() => {
    const next = configRef.current;
    const asset = inspectorRef.current || textureQualityRef.current !== "fast" || wireRef.current.mode !== "native"
      ? (textureQualityRef.current === "original" ? next.assets.gpuModel ?? next.assets.model : next.assets.model)
      : (next.assets.previewModel ?? next.assets.model);
    const targetKey = JSON.stringify({ a: asset, m: next.model ?? null, q: textureQualityRef.current });
    if (appliedModelRef.current === null || appliedModelRef.current === targetKey) return;
    const handle = handleRef.current;
    if (!handle) return;
    const previous = appliedModelRef.current;
    const switchId = ++qualitySwitchRef.current;
    appliedModelRef.current = targetKey;
    setQualityLoading(true);
    setLoadingKey(targetKey);
    setQualityError(false);
    const previewAsset = !inspectorRef.current && wireRef.current.mode === "native" && textureQualityRef.current !== "fast"
      && next.assets.previewModel !== asset ? next.assets.previewModel : undefined;
    const previewKey = previewAsset ? JSON.stringify({ a: previewAsset, m: next.model ?? null, q: "fast" }) : null;
    let previewSucceeded = false;
    const switchModel = async () => {
      if (previewAsset) {
        const previousFrame = constrainedGraphics() ? handle.snapshot() : null;
        if (previousFrame) {
          previousFrame.className = "sc-freeze";
          canvasWrapRef.current?.after(previousFrame);
        }
        const previewOk = await handle.setModel({ asset: previewAsset, model: { ...next.model, maxTextureSize: TEXTURE_QUALITY.fast.size } });
        if (previousFrame) {
          previousFrame.classList.add("out");
          window.setTimeout(() => previousFrame.remove(), 500);
        }
        if (switchId !== qualitySwitchRef.current || !previewOk) return previewOk;
        previewSucceeded = true;
        rememberLoadedModel(previewKey!);
      }
      return handle.setModel({ asset, model: qualityModel(next.model) });
    };
    void switchModel().then((ok) => {
      if (switchId !== qualitySwitchRef.current) return;
      // 失败（素材取不到 / 解析失败）就把标记退回去，下次变更还能重试
      if (!ok) appliedModelRef.current = previewSucceeded ? previewKey : previous;
      setQualityLoading(false);
      setQualityError(!ok);
      setLoadingKey(null);
      if (ok) rememberLoadedModel(targetKey);
    });
  }, [modelKey, qualityModel]);

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
    // Cookie 已让服务端把首页与全站首帧渲染为同一主题；旧 localStorage 不应在挂载后反向覆盖它。
    const hasThemeCookie = document.cookie.split(";").some((part) => /^(fire_theme|stocklog_theme)=/.test(part.trim()));
    const next: "dark" | "light" = hasThemeCookie || (saved !== "light" && saved !== "dark")
      ? initialTheme
      : saved;
    if (next !== themeRef.current) {
      themeRef.current = next;
      setTheme(next);
      handleRef.current?.setTheme(next);
    }
    // localStorage 与 cookie 不一致时补写 cookie，下次刷新的首帧就是同一个值
    document.documentElement.classList.toggle("dark", next === "dark");
    try { localStorage.setItem("fire.theme", next); } catch { /* 忽略存储异常 */ }
    setThemeCookie(next === "dark");
  }, [initialTheme]);

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

  /** 章节导航：所有尺寸直接设置进度，与页面滚动位置解耦。 */
  const goPhase = useCallback(
    (index: number) => {
      showSelectionHint(`phase:${index}`);
      setFreeCamera(false);
      freeCameraRef.current = false;
      handleRef.current?.setFreeCamera(false);
      if (driveCameraRef.current === "free") {
        driveCameraRef.current = "follow"; setDriveCamera("follow");
        handleRef.current?.setDriveCamera("follow");
      }
      const at = config.phases[index]?.at ?? 0;
      // 越过边界一点：进度有平滑跟随，避免仍被判为上一章。
      handleRef.current?.setProgress(Math.min(0.999, at + 0.006));
    },
    [config.phases, showSelectionHint]
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
    raceHintTouch: config.ui?.raceHintTouch ?? "PRESS & HOLD",
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
    <div className={`showcase ${freeCamera ? "sc-free" : ""} ${theme === "light" || studio ? "light" : ""} ${inspector ? "sc-inspecting" : ""} ${racing || driving ? "sc-immersive" : ""} ${className}`}>
      <div className="sc-scroll" ref={scrollRef}>
        <div className="sc-stage" ref={stageRef}>
          <div className="sc-canvas-wrap" ref={canvasWrapRef} />
          <div className="sc-watermark" ref={markRef}>
            {config.watermark}
          </div>
          <div className="sc-vignette" />
          <div className="sc-position-coordinate" ref={coordinateRef} aria-label="车型观察角度坐标" aria-live="off" />

          <div className="sc-hud">
            <div className="sc-row sc-tools">
              <div className="sc-wire-control" ref={wireControlRef} onKeyDown={(event) => {
                if (event.key === "Escape" && wirePanelRef.current) { setWirePanelOpen(false); event.currentTarget.querySelector("button")?.focus(); }
              }}>
                <button type="button" className={`sc-tool sc-glass-trigger${inspector ? " on" : ""}`}
                  aria-label="模型展示" title={inspector ? (wirePanel ? "隐藏模型设置" : "显示模型设置") : "进入模型展示"}
                  aria-expanded={wirePanel} aria-pressed={inspector}
                  onClick={toggleInspectorPanel}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
                    <path d="m12 2 9 5v10l-9 5-9-5V7Zm0 0v20M3 7l18 10M21 7 3 17M3 7l9 5 9-5M3 17l9-5 9 5" />
                  </svg><span>模型</span>
                </button>
                {inspector && <button type="button" className="sc-tool sc-inspector-home"
                  aria-label="返回首页" title="返回首页" onClick={exitInspector}>
                  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m12.5 5-5 5 5 5M8 10h7" /></svg>
                  <span>返回</span>
                </button>}
                {wirePanel && <div className="sc-wire-panel" role="group" aria-label="线框显示设置">
                  <div className="sc-wire-heading"><div><h3>模型展示</h3><p>每一处细节，自由探索。</p></div><button type="button" aria-label="隐藏模型设置" onClick={() => setWirePanelOpen(false)}>
                    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="m6 6 8 8M14 6l-8 8" /></svg>
                  </button></div>
                  <LiquidGlassControl label="显示模式" index={["native", "overlay", "wireframe"].indexOf(wireMode)}
                    onChange={index => changeWire((["native", "overlay", "wireframe"] as const)[index])}
                    items={[{ label: "原生" }, { label: "叠加线框" }, { label: "纯线框" }]} />
                  <div className="sc-wire-color-label"><span>线框颜色</span><span>{WIRE_COLORS.find(([, color]) => color === wireColor)?.[0]}</span></div>
                  <LiquidGlassControl label="线框颜色" swatches inactive={wireMode === "native"}
                    index={WIRE_COLORS.findIndex(([, color]) => color === wireColor)}
                    onChange={index => changeWire(wireMode === "native" ? "overlay" : wireMode, WIRE_COLORS[index][1])}
                    items={WIRE_COLORS.map(([label, color]) => ({ label: `${label}线框`, color }))} />
                  {models && models.length > 1 && <div className="sc-inspector-models" aria-label="选择展示车型">
                    <div className="sc-wire-color-label"><span>展示车型</span><span>{models.find(item => item.id === currentModel)?.label}</span></div>
                    <div className="sc-inspector-model-list">
                      {models.map(item => {
                        const loading = item.status === "loading" && item.id !== currentModel;
                        return <button key={item.id} type="button"
                          className={`fire-cap${item.id === currentModel ? " on" : ""}${loading ? " loading" : ""}`}
                          aria-pressed={item.id === currentModel}
                          onClick={() => onModelChange?.(item.id)}
                          onPointerEnter={() => onModelIntent?.(item.id)}
                          onFocus={() => onModelIntent?.(item.id)}
                          onTouchStart={() => onModelIntent?.(item.id)}>
                          <span>{item.label}</span>
                          {loading && <i style={{ width: `${Math.round((item.progress ?? 0) * 100)}%` }} />}
                        </button>;
                      })}
                    </div>
                  </div>}
                  <p className="sc-wire-help">左键环视 <span>·</span> Shift / 右键或双指平移 <span>·</span> 滚轮 / 捏合缩放<br />双击车身聚焦 <span>·</span> 双击背景拉远</p>
                  <div className="sc-inspector-actions">
                    <button type="button" className="sc-inspector-reset" onClick={() => handleRef.current?.resetCamera()}><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 8a6 6 0 1 1 0 4M4 4v4h4" /></svg>重置视角</button>
                    <button type="button" className="sc-inspector-exit" onClick={exitInspector}>退出展示</button>
                  </div>
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

            <div ref={leftDrawerRef} className={`sc-row sc-left-foot sc-side-drawer sc-side-left${leftDrawerOpen ? " open" : ""}`}>
              <button type="button" className="sc-drawer-toggle" onClick={() => { setLeftDrawerOpen((open) => !open); setRightDrawerOpen(false); }} aria-expanded={leftDrawerOpen} aria-controls="showcase-left-controls">
                <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M4 6h12M4 10h8M4 14h10" /></svg>
                <span>控制</span><i aria-hidden="true">›</i>
              </button>
              <div className="sc-drawer-content" id="showcase-left-controls">
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
                className={`sc-pill fire-cap${activeDiscStyle !== "none" ? " on" : ""}`}
                onClick={toggleDiscStyle}
                title={`当前${DISC_LABELS[activeDiscStyle]} · 点击切换`}
                aria-label={`圆盘：${DISC_LABELS[activeDiscStyle]}，点击切换`}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                  <ellipse cx="12" cy="12" rx="9" ry="5.5" />
                  {activeDiscStyle === "none" ? <path d="M5 19 19 5" /> : (
                    <>
                      <path d="M5.5 10.3c2.3 1 4.5 1.5 6.5 1.5s4.2-.5 6.5-1.5" strokeDasharray="1.4 2.2" />
                      <path d="M7.4 14.8c1.6.5 3.1.8 4.6.8s3-.3 4.6-.8" opacity=".65" />
                    </>
                  )}
                </svg>
                {DISC_LABELS[activeDiscStyle]}
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
              <button type="button" className="sc-race" ref={raceRef}
                onContextMenu={(event) => event.preventDefault()}
                onSelect={(event) => event.preventDefault()}
                onDragStart={(event) => event.preventDefault()}>
                <span>{racing ? "点按减速" : "点按起步"}</span>
                <em>→</em>
              </button>
              <div className="sc-ctr-hint">
                {/* 触屏没有空格键：两版文案都渲染，由 CSS 按 (hover: none) 选一版 */}
                <span className="kbd-only">点击按钮或按空格切换行驶</span>
                <span className="touch-only">点按保持行驶 · 可自由切换镜头</span>
              </div>
            </div>

            {(racing || driving) && !inspector && (
              <div className="sc-row sc-drive-camera">
                {driveCameraOpen && <div className="sc-drive-camera-options" role="group" aria-label="行驶镜头视角">
                  {DRIVE_CAMERA_OPTIONS.map(({ key, label }) => <button
                    type="button" key={key} className={driveCamera === key ? "on" : ""}
                    aria-pressed={driveCamera === key}
                    onClick={() => {
                      driveCameraRef.current = key;
                      setDriveCamera(key);
                      const free = key === "free";
                      setFreeCamera(free); freeCameraRef.current = free;
                      handleRef.current?.setFreeCamera(free);
                      handleRef.current?.setDriveCamera(key);
                      setDriveCameraOpen(false);
                    }}
                  >{label}</button>)}
                </div>}
                <button type="button" className="sc-drive-camera-toggle" aria-expanded={driveCameraOpen}
                  aria-label={`行驶镜头：${DRIVE_CAMERA_OPTIONS.find((option) => option.key === driveCamera)?.label}，选择视角`}
                  onClick={() => setDriveCameraOpen((open) => !open)}>
                  <span aria-hidden="true">◎</span>
                  {DRIVE_CAMERA_OPTIONS.find((option) => option.key === driveCamera)?.label}
                  <i aria-hidden="true">{driveCameraOpen ? "收起" : "视角"}</i>
                </button>
              </div>
            )}

            <div className="sc-row sc-hint-drag">
              <span>{ui.dragHint}</span>
              <span>{freeCamera ? "自由镜头 · Shift / 中键 / 右键平移 · 滚轮推进 · 双击聚焦" : ui.zoomHint}</span>
            </div>
            <div className="sc-row sc-hint-touch">{freeCamera ? "单指环视 · 双指平移缩放 · 双击聚焦" : ui.touchHint}</div>
            {/* 章节导航：右侧竖排指示器（短横条 + 当前章节更长更亮），悬停 / 键盘聚焦显示章节名 */}
            <div className="sc-row sc-nav" data-glass-ignore>
              {ui.nav.map((item, i) => (
                <button
                  type="button"
                  key={item}
                  className={`${!freeCamera && phase === i ? "on" : ""}${selectionHint === `phase:${i}` ? " sc-label-peek" : ""}`}
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
              <button type="button" className={`sc-free-camera${freeCamera ? " on" : ""}${selectionHint === "camera" ? " sc-label-peek" : ""}`}
                aria-label="自由镜头" aria-pressed={freeCamera}
                onClick={() => {
                  showSelectionHint("camera");
                  const next = !freeCamera;
                  setFreeCamera(next); freeCameraRef.current = next;
                  setOrbit(false); orbitRef.current = false;
                  handleRef.current?.setOrbit(false);
                  handleRef.current?.setFreeCamera(next);
                  const mode = next ? "free" : "follow";
                  driveCameraRef.current = mode; setDriveCamera(mode);
                  handleRef.current?.setDriveCamera(mode);
                }}>
                <span className="sc-nav-label">自由镜头</span>
                <span className="sc-nav-tick" aria-hidden="true" />
              </button>
              {freeCamera && <button type="button" className="sc-camera-reset" onClick={() => handleRef.current?.resetCamera()} aria-label="重置自由镜头">复位</button>}
            </div>
            {!inspector && (
              <div className="sc-row sc-texture-quality" role="group" aria-label="纹理质量">
                <span className="sc-quality-cap" aria-hidden="true">纹理</span>
                {memoryNotice && <span className="sc-quality-status" role="status">{memoryNotice}</span>}
                {!memoryNotice && textureLimitNotice && <span className="sc-quality-status" role="status">设备适配 · 贴图上限 {Math.round(textureLimitNotice / 1024)}K</span>}
                {qualityLoading && showLoadingNotice && <span className="sc-quality-pending" role="status" aria-label="正在更新高清模型" title="正在更新高清模型" />}
                {qualityError && <button type="button" className="sc-quality-retry" onClick={() => {
                  setQualityError(false);
                  setRetry((n) => n + 1);
                }}>加载失败 · 重试</button>}
                {(Object.entries(TEXTURE_QUALITY) as Array<[TextureQuality, (typeof TEXTURE_QUALITY)[TextureQuality]]>).map(([key, option]) => (
                  <button
                    key={key}
                    type="button"
                    className={`sc-quality-option${textureQuality === key ? " on" : ""}${selectionHint === `quality:${key}` ? " sc-label-peek" : ""}`}
                    aria-pressed={textureQuality === key}
                    title={key === "original" ? "原画纹理 · 保留源尺寸，优先使用高质量 GPU 压缩副本" : `${option.label}纹理 · 最长边 ${option.badge}`}
                    onClick={() => {
                      showSelectionHint(`quality:${key}`);
                      setMemoryNotice(null);
                      setTextureLimitNotice(null);
                      textureQualityRef.current = key;
                      setTextureQuality(key);
                    }}
                  >
                    <span className="sc-quality-label">{option.label} <small>{option.badge}</small></span>
                    <span className="sc-quality-tick" aria-hidden="true" />
                  </button>
                ))}
              </div>
            )}
            {models && models.length > 0 && (models.length > 1 || onImport) && (
              <div ref={rightDrawerRef} className={`sc-row sc-models sc-side-drawer sc-side-right${rightDrawerOpen ? " open" : ""}`}>
                <button type="button" className="sc-drawer-toggle" onClick={() => { setRightDrawerOpen((open) => !open); setLeftDrawerOpen(false); }} aria-expanded={rightDrawerOpen} aria-controls="showcase-model-controls">
                  <i aria-hidden="true">‹</i><span>车型</span>
                  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M3 13h14M5 13l2-5h6l2 5M6 13v2M14 13v2" /></svg>
                </button>
                <div className="sc-drawer-content" id="showcase-model-controls">
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
                    <svg className="sc-model-add-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg>
                  </button>
                )}
                </div>
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

          {ready && inspector && qualityLoading && showLoadingNotice && <div className="sc-loading" role="status" style={{ pointerEvents: "none" }}><span>正在加载模型…</span></div>}
          {!ready && (error || showLoadingNotice) && (
            <div className="sc-loading" style={{ opacity: error ? 1 : 0.9 }}>
              <span className={error ? "sc-loading-error" : undefined}>{error ?? ui.loading}</span>
              {error ? (
                <div className="flex flex-wrap justify-center gap-3">
                  <button type="button" className="fire-cap mt-4" onClick={() => { setRebuild(0); setRetry((n) => n + 1); }}>重新加载当前画质</button>
                  <button type="button" className="fire-cap mt-4" onClick={() => {
                    textureQualityRef.current = "fast";
                    setTextureQuality("fast");
                    wireRef.current.mode = "native";
                    setWireMode("native");
                    inspectorRef.current = false;
                    setInspector(false);
                    setWirePanelOpen(false);
                    setRebuild(0);
                    setRetry((n) => n + 1);
                  }}>以流畅模式重新加载</button>
                </div>
              ) : (
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
