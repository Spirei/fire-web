/**
 * 通用 3D 展示台（Showcase）的配置类型。
 *
 * 设计目标：镜头、地面、速度线、后期、HUD 章节全部由配置描述，
 * 换车只需要新增一份 preset（模型路径 + 镜头关键帧 + 文案），不用改引擎。
 */

/** 相机关键帧：方位角 0° = 正对车头，90° = 车身左侧，180° = 车尾 */
export interface ShowcaseCameraKey {
  /** 进入该机位的滚动进度 0–1 */
  p: number;
  /** 方位角（度） */
  az: number;
  /** 相机到车心的距离（米） */
  r: number;
  /** 相机高度（米） */
  h: number;
  /** 注视点高度（米） */
  ty: number;
  /** 注视点沿车身方向偏移（米） */
  tz: number;
  /** 注视点左右偏移（米）：用来把车放在画面偏左/偏右，参考视频里车是偏左的 */
  tx?: number;
  /** 垂直视角（度） */
  fov: number;
}

/**
 * 隧道里的一条主光条。
 * 角度是屏幕空间角度（相对消失点，度）：0° = 向右，90° = 向上，180° = 向左。
 * 参考视频里这些线是从消失点放射出去的，所以放在后期里画，而不是贴在圆柱面上。
 */
export interface ShowcaseLightBar {
  /** 屏幕角度（度），0° = 向右，90° = 向上 */
  angle: number;
  /** 角宽度（度） */
  width: number;
  /** 暖金（上下两条）或冷白（内侧四条） */
  tone: "gold" | "white";
  /** "bar" = 矩形光条（平顶、边缘略带过渡，像灯管）；不传则是普通细线 */
  style?: "line" | "bar";
}

export interface ShowcasePhase {
  /** 进入该章节的滚动进度 */
  at: number;
  idx: string;
  name: string;
  /** 标题，按行拆分 */
  head: string[];
  /** 说明文字，按行拆分 */
  copy: string[];
  /** 中间按钮上方的说明 */
  cap: string;
}

export interface ShowcasePart {
  title: string;
  value: string;
  /** 部件锚点（世界坐标，车头朝 +Z） */
  pos: [number, number, number];
  /** 出现进度 */
  from: number;
  /** 标注放在锚点左侧 */
  rev: boolean;
}

export interface ShowcaseConfig {
  /** 换素材时改这里即可 */
  assets: {
    /** glb / gltf 路径 */
    model: string;
    /** 夜间环境贴图（HDR） */
    envNight: string;
    /** 日间环境贴图（HDR） */
    envDay: string;
  };
  /** 仪表盘水印文字 */
  watermark?: string;
  /** 背景音乐地址（放在 uploads 卷里，不随公开仓库分发） */
  music?: string;
  model?: {
    /** 归一化后的车长（米） */
    length?: number;
    /** 模型朝向修正：绕 Y / X 轴旋转（度） */
    yaw?: number;
    pitch?: number;
    /**
     * 哪些材质的网格算轮子（要拆开各自自转）。
     * 写正则源码字符串（不区分大小写），这样配置可以从服务端组件传给客户端组件；
     * 配置只在客户端使用时也可以直接给 RegExp。
     */
    wheelPattern?: string | RegExp;
    /** 轮子自转轴（模型自身坐标系） */
    wheelAxis?: "x" | "y" | "z";
    /** 用来区分左右轮的轴 */
    wheelLateral?: "x" | "y" | "z";
    /** 用来区分前后轮的轴 */
    wheelLongitudinal?: "x" | "y" | "z";
    /**
     * 贴图最长边上限（像素）。默认 4096（等于不动）。
     * 4K 贴图解码后很吃显存，换到重贴图模型时可以降到 2048。
     */
    maxTextureSize?: number;
    /** 按材质名修正金属度 / 粗糙度（不同模型自带参数差别很大） */
    materialRules?: Array<{ match: string | RegExp; metalness?: number; roughness?: number }>;
  };
  /** 昼夜环境过渡（参考视频整段 hero 都是夜景，通常把窗口放到收尾或整段保持夜色） */
  environment?: {
    /** 夜 → 昼的滚动进度区间 */
    nightToDay?: [number, number];
    /** 白天环境的混合强度 0–1 */
    dayIntensity?: number;
  };
  camera: {
    keyframes: ShowcaseCameraKey[];
    /** 相机晃动（仅高速时明显） */
    shake?: { amount?: number; smoothing?: number };
    /** 窄屏时自动拉远：宽高比低于 minAspect 时按比例放大距离 */
    fit?: { minAspect?: number; maxPullback?: number };
    /** 滚动跟随的弹簧参数（越大越跟手；默认 120 / 26，接近 framer-motion useSpring 的手感） */
    smoothing?: { stiffness?: number; damping?: number };
  };
  ground?: {
    /** 车下方的刻度环，false 表示不要 */
    ring?:
      | false
      | {
          radius?: number;
          /** 刻度数量 */
          count?: number;
          /** 每几条一根长刻度（钟面小时刻度） */
          longEvery?: number;
          longLength?: number;
          shortLength?: number;
          color?: string;
        };
    /** 反射强度 */
    reflectIntensity?: number;
    /** 反射贴图分辨率 */
    reflectionSize?: number;
    /** 地面暖色光池强度 */
    pool?: number;
  };
  speed: {
    /** 内部速度上限 */
    maxSpeed?: number;
    /** 显示用的最高时速 */
    topKmh?: number;
    /** 冲刺时车驶离的距离（米） */
    launchTravel?: number;
    /** 冲刺时镜头绕到的方位角（度，180 = 正后方；参考视频是偏左后方约 205） */
    chaseAzimuth?: number;
    /**
     * 冲刺时机位横向偏移（米，正数 = 镜头移到车道中心线右侧，车因此落在画面偏左）。
     * 参考视频里车在画面左侧、光条汇聚点在其右，靠这一项对齐。
     */
    chaseLateral?: number;
    /**
     * 车道保持：把车从横向偏移与车头偏角里平滑拉回隧道中心线，避免「越跑越偏」。
     * 默认开启；autoHeading 会用前后轴连线自动量出车头方向并一次性摆正（不同来源的模型朝向不一）。
     */
    laneKeep?: {
      enabled?: boolean;
      /** 回收速度（越大回得越快，默认 2.6） */
      strength?: number;
      /** 自动量取车头方向并摆正（默认开启） */
      autoHeading?: boolean;
    };
    /** 车身流光强度（0 = 不要，参考视频里高速时车身是暗的） */
    flowStrength?: number;
    /** 地面流光强度（0 = 不要） */
    floorFlow?: number;
    /**
     * 顶点粒子隧道（参考零跑 C16 公开课的做法）：直接拿车模自身的顶点当粒子种子，
     * 位移全在顶点着色器里算，没有 CPU 粒子模拟，也不需要额外贴图或渲染目标。
     * false 表示不要这一层。
     */
    shards?:
      | false
      | {
          /** 粒子数量（从车模顶点里等距采样） */
          count?: number;
          color?: string;
          /** 三角形边长（米） */
          size?: number;
          /** 越靠近镜头向外扩散的距离（米） */
          spread?: number;
          /** 起点与终点在隧道轴上的位置（米） */
          far?: number;
          near?: number;
          opacity?: number;
        };
    /** 速度线隧道，false 表示不要 */
    tunnel?:
      | false
      | {
          radius?: number;
          length?: number;
          /** 主光条（不传则只有很浅的虚线） */
          bars?: ShowcaseLightBar[];
          /** 消失点在画面里的位置（默认 0.5 / 0.47） */
          vanish?: [number, number];
          /** 消失点跟随隧道轴的真实投影（默认开启；关掉则固定用 vanish 的画面位置） */
          vanishFollow?: boolean;
          /** 地面车道线（参考视频里从画面左下/右下斜向消失点的灰色标线） */
          lanes?: Array<{ angle: number; width: number; opacity?: number; dash?: number; color?: string }>;
          /** 景深强度：光条越远离消失点越虚（0 = 全锐利，默认 1.2） */
          dof?: number;
          /** 主光条切段密度：越大段越短（默认 13 ≈ 每条被切成十几段） */
          barSegment?: number;
          /** 辅助虚线的条数（均匀分布在整个圆周上，随机宽度与流动相位） */
          auxCount?: number;
          /** 辅助虚线的亮度倍率 */
          auxOpacity?: number;
          /** 主光条的亮度倍率 */
          barIntensity?: number;
          gold?: string;
          white?: string;
          /** 虚线亮度 */
          dashes?: number;
        };
  };
  post?: {
    /** 曝光（ACES 色调映射） */
    exposure?: number;
    bloom?: { strength?: number; radius?: number; threshold?: number; speedBoost?: number };
    /** 高速时的色散拖影 */
    smear?: { strength?: number; chroma?: number };
  };
  /** 缩放范围（相机距离倍率，越小越近） */
  zoom?: { min?: number; max?: number; wheelStep?: number };
  /**
   * 车上的发光点（F1 的 T 字灯、雨灯这种）。
   * 位置用归一化之后的坐标：车头朝 +Z、落地 y=0、车长由 model.length 决定。
   */
  lights?: Array<{
    pos: [number, number, number];
    color: string;
    /** 光点直径（米） */
    size?: number;
    /** 点光强度 */
    intensity?: number;
    /** 常亮还是只在发车时亮 */
    mode?: "always" | "race";
  }>;
  /** 冲刺按钮文案（参考站点：未发车是 HOLD TO RACE，发车后变成 RE-ENGAGE TO SLOW） */
  race?: { idleLabel?: string; label?: string; cap?: string };
  /** 舞台界面文案（默认英文，传了就用传入的；本站首页已改中文） */
  ui?: {
    kicker?: string;
    telemetry?: string;
    gear?: string;
    energy?: string;
    unit?: string;
    liveData?: string;
    liveDeploying?: string;
    raceIdle?: string;
    raceActive?: string;
    raceCap?: string;
    raceHint?: string;
    dragHint?: string;
    zoomHint?: string;
    zoomMode?: string;
    view360?: string;
    studio?: string;
    /** 「固定机位」按钮文案 */
    pinCamera?: string;
    /** 360° 环视的自动旋转角速度（弧度/秒，默认 0.55 ≈ 32°/秒） */
    orbitSpeed?: number;
    loading?: string;
    metaLeft?: string;
    metaRight?: string;
    nav?: string[];
  };
  /** 章节文案（React 层渲染，引擎只负责按进度回调） */
  phases: ShowcasePhase[];
  /** 部件标注锚点 */
  parts?: ShowcasePart[];
}

export interface ShowcaseHud {
  /** 滚动长度容器（决定滚动推进区间） */
  scroll: HTMLElement;
  /** 粘性舞台 */
  stage: HTMLElement;
  kmh: HTMLElement | null;
  gear: HTMLElement | null;
  rpmTicks: HTMLElement[];
  ersBar: HTMLElement | null;
  ersText: HTMLElement | null;
  teleFoot: HTMLElement | null;
  mark: HTMLElement | null;
  raceBtn: HTMLElement | null;
  zoomIn?: HTMLElement | null;
  zoomOut?: HTMLElement | null;
  zoomMode?: HTMLElement | null;
  /** 部件标注元素（位置由引擎每帧投影更新） */
  labels: { el: HTMLElement; from: number; pos: [number, number, number] }[];
}

export interface ShowcaseOptions {
  canvas: HTMLCanvasElement;
  hud: ShowcaseHud;
  config: ShowcaseConfig;
  /** 开场进度（0–1）：用户置顶过机位时从这里起步，避免先落到 0 再弹回置顶处 */
  startProgress?: number;
  /** 加载进度 0–1（模型 + 环境贴图） */
  onProgress?: (ratio: number) => void;
  /** 就绪（可以隐藏 loading） */
  onReady?: () => void;
  /** 章节切换 */
  onPhase?: (index: number) => void;
  /** 冲刺状态变化（按住空格 / 按住按钮） */
  onRacing?: (racing: boolean) => void;
  /** WebGL 上下文丢失（显存吃紧、驱动回收）：上层重建一次场景即可恢复 */
  onContextLost?: () => void;
  onError?: (message: string) => void;
}

export interface ShowcaseHandle {
  dispose: () => void;
  /** 切换深浅色：深色＝夜间隧道，浅色＝明亮摄影棚 */
  setTheme: (theme: "dark" | "light") => void;
  /** 360° 环视：自动绕车旋转（再调一次关闭并回到叙事机位） */
  setOrbit: (on: boolean) => void;
  /** 影棚：3D 场景切到明亮摄影棚（不改深浅色主题） */
  setStudio: (on: boolean) => void;
  /** 读取当前机位（进度 / 偏航 / 俯仰 / 缩放），用于「置顶当前机位」 */
  readPose: () => { p: number; yaw: number; pitch: number; zoom: number };
  /** 应用机位：刷新或重建后回到用户置顶的角度（滚动位置由组件负责） */
  applyPose: (pose: { yaw?: number; pitch?: number; zoom?: number }) => void;
  /** 手动设置滚动进度（调试 / 截图用） */
  setProgress: (p: number, settle?: number) => void;
  /** 调试用：当前平滑后的进度、速度、渲染倍率、冲刺与缩放状态 */
  debug: () => {
    progress: number;
    speed: number;
    scale: number;
    racing: boolean;
    travel: number;
    zoom: number;
    theme: "dark" | "light";
    /** 实际绘制缓冲尺寸 / 反射贴图边长 / 贴图与几何体数量（排查显存用） */
    buffer: [number, number];
    reflection: number;
    textures: number;
    geometries: number;
    /** 每帧脚本耗时（毫秒，不含 GPU 执行时间） */
    jsMs: number;
    /** 用户拖拽的偏航（度）与俯仰偏移（弧度） */
    yaw: number;
    pitch: number;
    /** 轮胎累计转角（弧度），用来确认松手后还在带着转 */
    wheelAngle: number;
    /** 地面倒影强度：冲刺时衰减到 0（隧道里没有倒影） */
    reflect: number;
    /** 车身高度与偏航（度），用来确认车没有离地 / 偏出轨道 */
    carY: number;
    carYaw: number;
    /** 车模在场景里的实际包围盒尺寸（排查换车型的缩放 / 朝向） */
    carBox: number[];
    /** 车道保持：自动量出的车头偏角（度）与当前横向偏移（米） */
    laneHeading: number;
    laneOffset: number;
    /** 360° 环视 / 影棚开关状态 */
    orbit: boolean;
    studio: boolean;
    /** 看门狗触发次数（软恢复 / 重建），排查白屏用 */
    watchdogHits: number;
    rebuilds: number;
    /** 关键事件日志（上下文丢失、看门狗动作、异常尺寸等） */
    log: string[];
  };
}
