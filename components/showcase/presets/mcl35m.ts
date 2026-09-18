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

  camera: {
    // 方位角 0° = 正对车头，90° = 车身左侧，180° = 车尾
    keyframes: [
      { p: 0, az: -74, r: 12.2, h: 1.9, ty: 0.98, tz: 0.1, fov: 30 },   // 开场：左侧全览
      { p: 0.1, az: -56, r: 11.2, h: 1.76, ty: 0.9, tz: 0.15, fov: 30 },
      { p: 0.22, az: -16, r: 9.2, h: 1.3, ty: 0.76, tz: 0.1, fov: 29 },
      { p: 0.32, az: 26, r: 8.3, h: 1.02, ty: 0.62, tz: 0.85, fov: 27 },  // 车头特写
      { p: 0.42, az: 84, r: 8.7, h: 0.85, ty: 0.6, tz: 0.4, fov: 28 },    // 侧箱特写
      { p: 0.52, az: 140, r: 9.6, h: 0.68, ty: 0.6, tz: 0.1, fov: 30 },
      // 冲刺段镜头落在车尾正后方：车沿隧道开走时始终在画面中间，镜头保持锁定
      { p: 0.62, az: 172, r: 10.2, h: 0.65, ty: 0.6, tz: 0, fov: 31 },
      { p: 0.74, az: 180, r: 10.8, h: 0.75, ty: 0.62, tz: -0.2, fov: 32 },
      { p: 0.86, az: 186, r: 11.4, h: 1.9, ty: 0.8, tz: 0, fov: 30 },
      { p: 1, az: 192, r: 10.8, h: 2.15, ty: 0.84, tz: 0.1, fov: 30 }
    ],
    shake: { amount: 0.34, smoothing: 1.6 },
    fit: { minAspect: 1.2, maxPullback: 1.8 }
  },

  ground: {
    // 车下方的钟面刻度环：正圆，屏幕上的椭圆来自俯视透视
    ring: { radius: 4, count: 180, longEvery: 15, longLength: 0.34, shortLength: 0.16, color: "#ffb070" },
    reflectIntensity: 0.95,
    reflectionSize: 512,
    pool: 0.14
  },

  speed: {
    maxSpeed: 34,
    topKmh: 355,
    launchTravel: 11,
    tunnel: {
      radius: 26,
      length: 120,
      // 左右各三条主光条（60° 均分）：上下两条暖金、内侧四条冷白。
      // 颜色按参考视频逐点取样后做了偏色中性化，宽度按视频量出来约 0.5°。
      gold: "#ffc266",
      white: "#ccdbfa",
      dashes: 1,
      bars: [
        { angle: 10, width: 0.4, tone: "white" },
        { angle: 70, width: 0.52, tone: "gold" },
        { angle: 130, width: 0.46, tone: "white" },
        { angle: 190, width: 0.4, tone: "white" },
        { angle: 250, width: 0.52, tone: "gold" },
        { angle: 310, width: 0.46, tone: "white" }
      ]
    }
  },

  post: {
    exposure: 1.16,
    bloom: { strength: 0.4, radius: 0.6, threshold: 0.85, speedBoost: 0.42 },
    smear: { strength: 0.09, chroma: 0.012 }
  },

  zoom: { min: 0.55, max: 2.4, wheelStep: 0.0016 },

  phases: [
    { at: 0, idx: "01", name: "THE CAR", head: ["Built to chase", "the extraordinary."], copy: ["An obsession with every detail.", "A feeling like nothing else."], cap: "THE TRACK IS YOURS" },
    { at: 0.2, idx: "02", name: "AERO", head: ["Air, shaped", "to obey."], copy: ["Every surface earns its place.", "Downforce without compromise."], cap: "SCRUB THE APEX" },
    { at: 0.4, idx: "03", name: "POWER", head: ["Deploy.", "Then deploy again."], copy: ["1.6L V6 hybrid, eight gears,", "and one very loud idea."], cap: "LAUNCH IS ARMED" },
    { at: 0.58, idx: "04", name: "TYRES", head: ["Where the lap", "actually happens."], copy: ["Four patches of rubber carrying", "an entire team's work."], cap: "GRIP TO THE LIMIT" },
    { at: 0.78, idx: "05", name: "TECH", head: ["Two hundred sensors,", "one steering wheel."], copy: ["The car talks. The garage listens."], cap: "COOL DOWN" }
  ],

  parts: [
    { title: "FRONT WING", value: "3-PLANE · OUTWASH", pos: [1.05, 0.24, 2.35], from: 0.24, rev: false },
    { title: "SIDEPOD", value: "PAPAYA · COOLING", pos: [1.1, 0.55, 0.5], from: 0.3, rev: false },
    { title: "REAR WING", value: "DRS · 2021 SPEC", pos: [-0.25, 1, -2.55], from: 0.36, rev: true },
    { title: "TYRES", value: "P ZERO · 18 IN", pos: [-1, 0.36, -1.35], from: 0.42, rev: true }
  ]
};
