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
      { p: 0, az: -74, r: 12.2, h: 1.9, ty: 0.98, tz: 0.1, fov: 30 },   // 开场：左侧全览，整车与刻度环都在画面里
      { p: 0.1, az: -60, r: 11.4, h: 1.78, ty: 0.9, tz: 0.15, fov: 30 },
      { p: 0.2, az: -20, r: 9.6, h: 1.34, ty: 0.76, tz: 0.15, fov: 29 },
      { p: 0.3, az: 18, r: 8.4, h: 1.04, ty: 0.62, tz: 0.7, fov: 27 },   // 开始推近车头
      { p: 0.38, az: 60, r: 5.9, h: 0.8, ty: 0.5, tz: 0.9, fov: 27 },    // 前轮 / 侧箱特写（参考视频里车是满画甚至溢出的）
      { p: 0.46, az: 104, r: 6.2, h: 0.78, ty: 0.52, tz: 0.1, fov: 28 }, // 沿车身滑到后段，继续贴近
      { p: 0.54, az: 130, r: 9.4, h: 1.0, ty: 0.62, tz: 0.1, fov: 29 },  // 拉回 3/4 侧视
      { p: 0.62, az: 162, r: 10.4, h: 1.9, ty: 0.7, tz: 0, fov: 31 },    // 抬升并收到车尾方向
      // 发车位：车尾正后方的低机位，按住空格后车就是朝这里驶入隧道，镜头保持锁定
      { p: 0.7, az: 176, r: 10.2, h: 2.7, ty: 0.78, tz: -0.2, fov: 32 },
      { p: 0.8, az: 181, r: 9.8, h: 2.9, ty: 0.8, tz: -0.1, fov: 32 },
      { p: 0.88, az: 186, r: 5.6, h: 0.9, ty: 0.6, tz: -0.7, fov: 29 },  // 收车后的一次极近特写（车尾 / 后轮）
      { p: 1, az: 190, r: 11, h: 1.9, ty: 0.82, tz: 0.1, fov: 30 }       // 最后拉出到英雄机位
    ],
    shake: { amount: 0.34, smoothing: 1.6 },
    fit: { minAspect: 1.2, maxPullback: 1.8 }
  },

  ground: {
    // 车下方的钟面刻度环：正圆，屏幕上的椭圆来自俯视透视
    ring: { radius: 4, count: 180, longEvery: 15, longLength: 0.34, shortLength: 0.16, color: "#ffb070" },
    reflectIntensity: 1.05,
    // 参考视频里的地面是镜面：反射贴图给到 512（8 位，成本很小）才够清晰
    reflectionSize: 512,
    pool: 0.14
  },

  speed: {
    maxSpeed: 34,
    topKmh: 355,
    launchTravel: 11,
    // 顶点粒子隧道：三角形太碎、影响观感，这里关掉（引擎仍支持，想要纵深时把 shards 配上即可）。
    shards: false,
    tunnel: {
      radius: 26,
      length: 120,
      // 左右各三条主光条（60° 均分）：上下两条暖金、内侧四条冷白。
      // 颜色按参考视频逐点取样后做了偏色中性化，宽度按视频量出来约 0.5°。
      gold: "#ffc266",
      white: "#ccdbfa",
      dashes: 0.6,
      // 角度是屏幕空间角度（相对消失点）：左三 = 150°/190°/230°，右三 = 30°/350°/310°，
      // 每侧上下两条是暖金、中间那条偏白灰，对应参考视频里的六道主光条。
      vanish: [0.5, 0.46],
      barIntensity: 0.34,
      bars: [
        { angle: 30, width: 0.34, tone: "gold" },
        { angle: 350, width: 0.28, tone: "white" },
        { angle: 310, width: 0.34, tone: "gold" },
        { angle: 150, width: 0.34, tone: "gold" },
        { angle: 190, width: 0.28, tone: "white" },
        { angle: 230, width: 0.34, tone: "gold" }
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

  parts: [
    { title: "前翼", value: "三层翼片 · 外洗气流", pos: [1.05, 0.24, 2.35], from: 0.28, rev: false },
    { title: "侧箱", value: "木瓜橙 · 散热进气", pos: [1.1, 0.55, 0.5], from: 0.34, rev: false },
    { title: "尾翼", value: "DRS · 2021 规格", pos: [-0.25, 1, -2.55], from: 0.4, rev: true },
    { title: "轮胎", value: "P ZERO · 18 英寸", pos: [-1, 0.36, -1.35], from: 0.44, rev: true }
  ]
};
