/**
 * 迈凯伦 MCL35M 的展示预设。
 *
 * 换车 / 换素材时照着这个文件复制一份即可，引擎（../engine.ts）不用改：
 * 1) 把新的 glb / HDR 放进 public/，改 assets；
 * 2) 模型朝向不对就调 model.yaw / model.pitch（单位：度）；
 * 3) 轮子材质名不同就改 model.wheelPattern 与三个 wheel* 轴；
 * 4) 镜头机位全部在 camera.keyframes 里，p 是滚动进度（0–1）；
 * 5) 地面刻度环、隧道光条、配色、后期都在下面分组里。
 */
import type { ShowcaseConfig } from "../types";

export const MCL35M_SHOWCASE: ShowcaseConfig = {
  assets: {
    model: "/mclaren/mcl35m.glb",
    // Poly Haven CC0 环境贴图：夜（moonless golf）+ 昼（studio small 09）
    envNight: "/mclaren/moonless_golf_1k.hdr",
    envDay: "/mclaren/studio_small_09_1k.hdr"
  },
  watermark: "FORMULA",
  // 背景音乐放在 uploads 卷（不进公开仓库、也不进镜像），部署时把 mp3 放进服务器 uploads 目录即可
  music: "/uploads/mclaren/theme.mp3",

  model: {
    length: 5.6,
    // 4K 贴图解码后约 236MB 显存；想让显存更省可以改成 2048（约省四分之三），代价是特写贴图变软
    maxTextureSize: 4096,
    // 轮子：Sketchfab 这份模型一个材质盖住四个轮子，按材质名挑出来再拆开自转
    wheelPattern: "rim|tread|tyre",
    wheelAxis: "x",           // 自转轴
    wheelLateral: "x",        // 区分左右轮
    wheelLongitudinal: "y",   // 区分前后轮
    materialRules: [
      // 参考车是橡胶胎 + 金属轮圈 + 半光碳纤维，原始材质参数偏金属，这里按实物修正
      { match: "tread|tyrewall", metalness: 0, roughness: 0.85 },
      { match: "rim", metalness: 1, roughness: 0.28 },
      { match: "mcl35m_c", metalness: 0.35, roughness: 0.42 }
    ]
  },

  // 参考视频整段 hero 都是夜景，只有收尾略微提亮；这里把窗口放到最后，强度减半
  environment: { nightToDay: [0.86, 1], dayIntensity: 0.5 },

  camera: {
    // 方位角 0° = 正对车头，90° = 车身左侧，180° = 车尾。
    // 节奏对齐参考视频：静置全览 → 绕车 → 前轮/侧箱特写 → 拉回侧视 → 车尾宽景（在这里发车）→ 收尾微推再拉出。
    keyframes: [
      { p: 0, az: 205, r: 9.4, h: 1.9, ty: 0.78, tz: 0.1, tx: -0.15, fov: 30 },  // 开场：车尾偏左的大 3/4 视角（刷新的默认姿势）
      { p: 0.1, az: 168, r: 10.2, h: 1.7, ty: 0.85, tz: 0.15, tx: -0.1, fov: 30 },
      { p: 0.2, az: -20, r: 9.6, h: 1.34, ty: 0.76, tz: 0.15, fov: 29 },
      { p: 0.3, az: 22, r: 9.2, h: 1.15, ty: 0.7, tz: 0.6, fov: 27 },     // 绕到车头并推近
      { p: 0.38, az: 60, r: 5.9, h: 0.8, ty: 0.5, tz: 0.9, fov: 27 },    // 前轮 / 侧箱特写（参考视频里车是满画甚至溢出的）
      { p: 0.46, az: 104, r: 6.2, h: 0.78, ty: 0.52, tz: 0.1, fov: 28 }, // 沿车身滑到后段，继续贴近
      { p: 0.54, az: 130, r: 9.4, h: 1.0, ty: 0.62, tz: 0.1, fov: 29 },  // 拉回 3/4 侧视
      { p: 0.62, az: 178, r: 10.4, h: 2.0, ty: 0.72, tz: 0, tx: -0.5, fov: 31 },  // 抬升并收到车尾偏左
      // 发车位：车尾正后方的低机位，按住空格后车就是朝这里驶入隧道，镜头保持锁定
      { p: 0.7, az: 198, r: 10.0, h: 2.6, ty: 0.8, tz: -0.2, tx: -1.35, fov: 32 },
      { p: 0.8, az: 205, r: 9.8, h: 2.8, ty: 0.82, tz: -0.1, tx: -1.6, fov: 32 },
      { p: 0.88, az: 186, r: 5.6, h: 0.9, ty: 0.6, tz: -0.7, fov: 29 },  // 收车后的一次极近特写（车尾 / 后轮）
      { p: 1, az: 190, r: 11, h: 1.9, ty: 0.82, tz: 0.1, fov: 30 }       // 最后拉出到英雄机位
    ],
    shake: { amount: 0.34, smoothing: 1.6 },
    fit: { minAspect: 1.2, maxPullback: 1.8 }
  },

  ground: {
    // 车下方的钟面刻度环：正圆，屏幕上的椭圆来自俯视透视
    ring: { radius: 3.3, count: 220, longEvery: 20, longLength: 0.16, shortLength: 0.07, color: "#d8c3a4" },
    reflectIntensity: 1.05,
    // 参考视频里的地面是镜面：反射贴图给到 640（8 位，成本约 1.6MB）才够清晰
    reflectionSize: 640,
    pool: 0.14
  },

  speed: {
    maxSpeed: 34,
    topKmh: 355,
    launchTravel: 11,
    // 冲刺时镜头绕到车尾偏左（参考视频里车是偏左、左右光条角度不对称的来源）
    chaseAzimuth: 212,
    // 顶点粒子隧道：三角形太碎、影响观感，这里关掉（引擎仍支持，想要纵深时把 shards 配上即可）。
    shards: false,
    tunnel: {
      radius: 26,
      length: 120,
      // 左右各三条主光条（60° 均分）：上下两条暖金、内侧四条冷白。
      // 颜色按参考视频逐点取样后做了偏色中性化，宽度按视频量出来约 0.5°。
      // 外道浅黄（取样核心 #D0813F~#BB7611，按亮线观感提高明度后的浅黄）
      gold: "#ffcc80",
      // 内道浅蓝（取样核心 #4679D5~#6D89D3）
      white: "#a8c8ff",
      dashes: 0.6,
      // 角度是屏幕空间角度（相对消失点）：左三 = 150°/190°/230°，右三 = 30°/350°/310°，
      // 每侧上下两条是暖金、中间那条偏白灰，对应参考视频里的六道主光条。
      vanish: [0.5, 0.46],
      barIntensity: 0.62,
      // 参考视频里每段长约 100-200px（1080 宽画面），这里约 1/8 屏幕半径一段
      barSegment: 8,
      // 地面车道线：比主光条更宽更暗的长虚线，专门做隧道地面的纵深
      lanes: [
        { angle: 168, width: 0.5, opacity: 1.1, color: "#9aa6b4" },
        { angle: 12, width: 0.5, opacity: 1.1, color: "#9aa6b4" },
        { angle: 194, width: 0.34, opacity: 0.5, color: "#8f9aa8" },
        { angle: 346, width: 0.34, opacity: 0.5, color: "#8f9aa8" }
      ],
      // 隧道壁上的大量浅虚线
      auxCount: 22,
      auxOpacity: 1.15,
      bars: [
        // 角度是逐帧量出来的（0°=右，90°=上，180°=左，270°=下）：
        // 参考视频里主要光条在 59° / 112° / 239° / 268° / 296° / 317°。
        // 严格取色（多帧、沿整条线取中位数与最饱和核心色）得到两组：
        //   外道（较平的角度）核心 #D0813F ~ #BB7611 → 浅黄/琥珀；
        //   内道（较陡的角度）核心 #4679D5 ~ #6D89D3 → 浅蓝，且更细更暗。
        { angle: 59, width: 0.5, tone: "gold" },    // 外道 · 浅黄
        { angle: 317, width: 0.44, tone: "gold" },  // 外道 · 浅黄
        { angle: 239, width: 0.46, tone: "gold" },  // 外道 · 浅黄
        { angle: 296, width: 0.44, tone: "gold" },  // 外道 · 浅黄
        { angle: 112, width: 0.4, tone: "white" },  // 内道 · 浅蓝
        { angle: 268, width: 0.42, tone: "white" }  // 内道 · 浅蓝
      ]
    }
  },

  post: {
    exposure: 1.16,
    bloom: { strength: 0.38, radius: 0.5, threshold: 0.9, speedBoost: 0.26 },
    smear: { strength: 0.055, chroma: 0.01 }
  },

  zoom: { min: 0.55, max: 2.4, wheelStep: 0.0016 },

  // 车顶 T 字灯与车尾雨灯先去掉（引擎仍支持 lights 配置，换素材时按需再加）

  // 参考站点：未发车是 HOLD TO RACE，发车后变成 RE-ENGAGE TO SLOW（提示松开回到慢速）
  race: { idleLabel: "按住起步", label: "松手减速", cap: "追赶极限" },

  // 首页界面文案（能中文就中文，专有名词保留）
  ui: {
    kicker: "超越极限",
    telemetry: "实时遥测",
    gear: "档位",
    energy: "ERS",
    unit: "公里/时",
    liveData: "实时数据",
    liveDeploying: "实时数据 · 全功率输出",
    raceIdle: "按住起步",
    raceActive: "松手减速",
    raceCap: "追赶极限",
    raceHint: "按住 空格 或 长按按钮",
    dragHint: "↻ 拖拽环视 · 上下俯仰",
    zoomHint: "⌘ / Ctrl + 滚轮缩放",
    zoomMode: "缩放",
    view360: "360° 环视",
    studio: "影棚",
    loading: "正在加载模型",
    metaLeft: "MCL35M / 2021 · FORMULA 1",
    metaRight: "WEBGL 展示",
    nav: ["车辆", "空力", "动力", "轮胎", "科技"]
  },

  phases: [
    { at: 0, idx: "01", name: "车辆", head: ["为追逐", "非凡而造。"], copy: ["每一处细节都反复推敲，", "只为一种说不出的感觉。"], cap: "赛道是你的" },
    { at: 0.2, idx: "02", name: "空气动力学", head: ["让空气", "学会听话。"], copy: ["每一条曲面都有它的任务，", "下压力上不做任何妥协。"], cap: "贴着顶点过弯" },
    { at: 0.4, idx: "03", name: "动力单元", head: ["先释放，", "再释放一次。"], copy: ["1.6 升 V6 混动，八挡序列式，", "以及一个很大的想法。"], cap: "发车已就绪" },
    { at: 0.58, idx: "04", name: "轮胎", head: ["圈速真正", "发生的地方。"], copy: ["四块橡胶，", "扛着整支车队的功课。"], cap: "把抓地力用满" },
    { at: 0.78, idx: "05", name: "科技", head: ["两百个传感器，", "一个方向盘。"], copy: ["车在说话，", "车库在听。"], cap: "收车回库" }
  ],

  // 部件标注（前翼/侧箱/尾翼/轮胎）先去掉：特写时压在车身上反而干扰观感。
  // 引擎仍支持 parts 配置，想要标注时按同样的格式补回来即可。
  parts: []
};
