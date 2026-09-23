/**
 * 通用 3D 展示台（Showcase）的配置类型。
 *
 * 设计目标：镜头、地面、速度线、后期、HUD 章节全部由配置描述，
 * 换车只需要新增一份 preset（模型路径 + 镜头关键帧 + 文案），不用改引擎。
 */

/** 相机关键帧：方位角 0° = 正对车头，90° = 车身左侧，180° = 车尾 */
export type ShowcaseDriveCamera = "follow" | "left" | "right" | "top" | "classic" | "free";

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
  /** 从参考帧测量的独立颜色与消失线起点（屏幕 UV，Y 向上）。 */
  color?: string;
  origin?: [number, number];
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

/** 首页展示台地面圆盘：原刻度盘或 0919 参考视频里的赛道点阵盘。 */
export type ShowcaseDiscStyle = "none" | "chrono" | "track";

/**
 * 导入车型可调的渲染参数（存在 uploads 卷的 showroom.json 里）。
 * 与 ShowcaseConfig.model 同义，但只保留「换车时需要动」的那几项。
 */
export interface ShowcaseModelParams {
  /** 归一化后的车长（米） */
  length?: number;
  /** 本车型行驶遥测的最高时速（km/h） */
  topKmh?: number;
  /** 模型朝向修正（度）：车头没朝 +Z 时用 */
  yaw?: number;
  pitch?: number;
  /** 轮子材质名（正则源码字符串） */
  wheelPattern?: string;
  wheelAxis?: "x" | "y" | "z";
  wheelLateral?: "x" | "y" | "z";
  wheelLongitudinal?: "x" | "y" | "z";
  maxTextureSize?: number;
  emissiveIntensity?: number;
  clearcoatRoughness?: number;
  envMapIntensity?: number;
  /** 模型展示线框的尾翼规则补线参数 */
  wireframe?: import("./wireframe").WireframeTuning;
  materialRules?: Array<{ match: string; metalness?: number; roughness?: number }>;
}

export interface ShowcaseConfig {
  /** 换素材时改这里即可 */
  assets: {
    /** glb / gltf 路径 */
    model: string;
    /** 首页快速可交互版本；进入模型展示后无缝升级到 model。 */
    previewModel?: string;
    /** 保留源贴图尺寸的 UASTC GPU 压缩副本（原文件仍保留）。 */
    gpuModel?: string;
    /** GPU 副本经校验的最大贴图边长，用于判断是否必须切换到压缩文件。 */
    gpuTextureMax?: number;
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
    /**
     * 模型自带发光材质（车灯 / 仪表 / 玻璃细节）的强度上限，默认 0.45。
     * 有的模型 KHR_materials_emissive_strength 高达 2 以上，叠上泛光就是一团白，压一档更像自然光。
     */
    emissiveIntensity?: number;
    /**
     * 清漆层（KHR_materials_clearcoat）的粗糙度下限，默认 0.2。
     * 有的模型给 0.04（近乎镜面），环境贴图在这种镜面上会显出方块状色斑，
     * 抬起一点相当于真实车漆的清漆层，反射变柔和但不失光泽。
     */
    clearcoatRoughness?: number;
    /** 环境反射强度，默认 1。调高会让夜景里的小亮点在漆面上放大成光晕 */
    envMapIntensity?: number;
    /** 尾翼 / 稀疏部件的规则补线参数 */
    wireframe?: import("./wireframe").WireframeTuning;
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
    /** 独立冲刺机位，不随起步时所在章节 / 用户缩放改变。高度与注视点相对车所在路面。 */
    chaseCamera?: { radius: number; height: number; targetY: number; fov: number };
    /** 加速 / 松手减速的响应系数（每秒）。 */
    response?: { acceleration: number; braking: number };
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
          /** 保持参考画幅里的墙 / 路面占比；不传时按当前画幅的像素角度计算。 */
          referenceAspect?: number;
          /** 两条边线之间的墙面 / 路肩，角度与主光条使用相同坐标。 */
          surfaces?: Array<{ from: number; to: number; color: string; opacity: number }>;
          /** 主光条（不传则只有很浅的虚线） */
          bars?: ShowcaseLightBar[];
          /** 消失点在画面里的位置（默认 0.5 / 0.47） */
          vanish?: [number, number];
          /** 消失点跟随隧道轴的真实投影（默认开启；关掉则固定用 vanish 的画面位置） */
          vanishFollow?: boolean;
          /** 地面车道线（参考视频里从画面左下/右下斜向消失点的灰色标线） */
          lanes?: Array<{ angle: number; width: number; opacity?: number; dash?: number; color?: string; tailColor?: string; origin?: [number, number] }>;
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
    /** 触屏版发车提示（手机 / 平板上没有空格键） */
    raceHintTouch?: string;
    dragHint?: string;
    zoomHint?: string;
    /** 手机端手势提示（横滑环视 / 双指缩放 / 双击复位） */
    touchHint?: string;
    zoomMode?: string;
    view360?: string;
    studio?: string;
    /** 「固定机位」按钮文案 */
    pinCamera?: string;
    /** 360° 环视的自动旋转角速度（弧度/秒，默认 0.55 ≈ 32°/秒） */
    orbitSpeed?: number;
    loading?: string;
    nav?: string[];
  };
  /** 章节文案（React 层渲染，引擎只负责按进度回调） */
  phases: ShowcasePhase[];
  /** 部件标注锚点 */
  parts?: ShowcasePart[];
}

export interface ShowcaseHud {
  /** 查看器容器（用于尺寸观察） */
  scroll: HTMLElement;
  /** 单屏舞台 */
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
  /** 导入工作台的彩色部位点；pos 是车身包围盒内 0–1 的归一化位置。 */
  inspectMarkers?: { el: HTMLElement; pos: [number, number, number] }[];
}

export interface ShowcaseOptions {
  canvas: HTMLCanvasElement;
  hud: ShowcaseHud;
  config: ShowcaseConfig;
  /** WebGL 创建前的首帧主题，避免浅色页面先清成黑色再切换。 */
  initialTheme?: "dark" | "light";
  /** 开场进度（0–1）：用户置顶过机位时从这里起步，避免先落到 0 再弹回置顶处 */
  startProgress?: number;
  /** 加载进度 0–1（模型 + 环境贴图） */
  onProgress?: (ratio: number) => void;
  /** 就绪（可以隐藏 loading） */
  onReady?: () => void;
  /** 实际贴图上限低于所选档位时，向界面说明设备内存适配。 */
  onTextureBudget?: (limit: number | null) => void;
  /** 模型展示中单击真实网格：供导入工作台跳到对应部位参数。 */
  onInspectPart?: (part: { mesh: string; materials: string[]; position: [number, number, number] }) => void;
  /** 章节切换 */
  onPhase?: (index: number) => void;
  /** 冲刺状态变化（按住空格 / 按住按钮） */
  onRacing?: (racing: boolean) => void;
  /** 行驶或减速尚未结束，用于精简页面 HUD。 */
  onDriving?: (driving: boolean) => void;
  /** WebGL 上下文丢失（显存吃紧、驱动回收）：上层重建一次场景即可恢复 */
  onContextLost?: () => void;
  /** 双击复位：引擎已把角度 / 缩放调到置顶机位，这里由组件恢复置顶章节进度 */
  onResetView?: () => void;
  onError?: (message: string) => void;
}

export interface ShowcaseHandle {
  dispose: () => void;
  /** 冻结当前这一帧（换车型时当背景板用）：返回一张 2D canvas，取不到就返回 null */
  snapshot: () => HTMLCanvasElement | null;
  /** 切换深浅色：深色＝夜间隧道，浅色＝明亮摄影棚 */
  setTheme: (theme: "dark" | "light") => void;
  /**
   * 原地换车：只换车身，镜头 / 地面 / 环境 / HUD 都不动（不重建场景，所以切换不会有空白期）。
   * 素材会走同一套缓存；解析失败时旧车留在画面上并返回 false。
   */
  setModel: (next: { asset: string; model?: ShowcaseConfig["model"] }) => Promise<boolean>;
  setTopKmh: (value: number) => void;
  /** 只更新材质参数，不重新解析 GLB 或重建线框/轮组。 */
  updateModelMaterials: (model?: ShowcaseConfig["model"]) => void;
  /** 360° 环视：自动绕车旋转（再调一次关闭并回到叙事机位） */
  setOrbit: (on: boolean) => void;
  setInspector: (on: boolean) => void;
  /** 模型调校时聚焦一个大类；其他部件退成低透明灰线框，null/overall 恢复整车。 */
  setInspectRegion: (region: "overall" | "body" | "aero" | "wheels" | "cockpit" | null) => void;
  setWireframe: (mode: import("./wireframe").WireframeMode, color: string) => void;
  /** 原地切换地面圆盘，不重建模型、镜头或 WebGL 场景。 */
  setDiscStyle: (style: ShowcaseDiscStyle) => void;
  /** 行驶镜头：正后方跟随，或保留原来的斜后方动态镜头。 */
  setDriveCamera: (mode: ShowcaseDriveCamera) => void;
  setFreeCamera: (on: boolean) => void;
  resetCamera: () => void;
  /** 影棚：3D 场景切到明亮摄影棚（不改深浅色主题） */
  setStudio: (on: boolean) => void;
  /** 读取当前机位（含自由镜头焦点），用于「置顶当前机位」 */
  readPose: () => { p: number; yaw: number; pitch: number; zoom: number; focus: [number, number, number]; distance: number; elevation: number };
  /** 应用机位：刷新或重建后回到用户置顶的角度（章节进度由 setProgress 设置） */
  applyPose: (pose: { yaw?: number; pitch?: number; zoom?: number; focus?: [number, number, number] }) => void;
  /** 用户置顶的机位：双击复位回到这里（null = 没置顶，回到中立角度） */
  setHomePose: (pose: { p?: number; yaw?: number; pitch?: number; zoom?: number; focus?: [number, number, number]; distance?: number; elevation?: number } | null) => void;
  /** 设置章节进度（导航、复位与调试共用） */
  setProgress: (p: number, settle?: number) => void;
  /** 调试用：当前平滑后的进度、速度、渲染倍率、冲刺与缩放状态 */
  debug: () => {
    asset: string;
    textureLimit: number;
    sourceTextureMax: number;
    progress: number;
    speed: number;
    scale: number;
    racing: boolean;
    travel: number;
    zoom: number;
    /** 当前相机与观察焦点的世界坐标 */
    camera: number[];
    target: number[];
    inspector: boolean;
    clipping: number[];
    /** 当前最终观察角：水平角 / 俯仰角（度）与相机到焦点距离，可直接复现构图 */
    viewAzimuth: number;
    viewElevation: number;
    viewDistance: number;
    theme: "dark" | "light";
    /** 实际绘制缓冲尺寸 / 反射贴图边长 / 贴图与几何体数量（排查显存用） */
    buffer: [number, number];
    reflection: number;
    textures: number;
    geometries: number;
    /** 线框构建诊断：同步构建耗时、网格层数与额外 GPU 缓冲字节。 */
    wireframe: { buildMs: number; entries: number; generatedBytes: number };
    /** 每帧脚本耗时（毫秒，不含 GPU 执行时间） */
    jsMs: number;
    /** EXT_disjoint_timer_query_webgl2 测得的 GPU 帧耗时；设备不支持时为 0。 */
    gpuMs: number;
    /** 诊断计数：实际渲染、倒影渲染、工作台跳过的重复帧（每秒平均）。 */
    renderFps: number;
    reflectionFps: number;
    inspectorSkippedFps: number;
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
    /** 归一化之前、模型自带单位的包围盒（导入向导判断朝向与单位） */
    carBoxRaw: number[];
    /** 车模的材质名 / 网格名（导入向导用来挑轮子材质、核对模型结构） */
    carMaterials: string[];
    carMeshes: string[];
    /** 按当前规则认出来几个轮子（4 = 正常；0 = 轮子材质名没对上） */
    wheelGroups: number;
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
