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
    // ?v= 是给浏览器长缓存用的版本号：换了模型 / 贴图就把数字 +1，
    // 否则浏览器会一直用本地那份（服务端对这些路径返回 immutable）。
    // 这一辆是随仓库分发的默认车（别人克隆/部署后开箱就有车可看），所以放在 public/mclaren/；
    // 其余车型一律手动导入 uploads 卷（public/uploads/mclaren/models/，不进 Git 也不进镜像）
    model: "/mclaren/mcl35m.glb?v=1",
    previewModel: "/mclaren/mcl35m-preview.glb?v=1",
    // Poly Haven CC0 环境贴图：夜（moonless golf）+ 昼（studio small 09）
    envNight: "/mclaren/moonless_golf_1k.hdr?v=1",
    envDay: "/mclaren/studio_small_09_1k.hdr?v=1"
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
      { p: 0.62, az: 180, r: 10.4, h: 2.0, ty: 0.72, tz: 0, tx: 0, fov: 31 },  // 车尾正后方，车正对隧道方向
      // 发车位：车尾正后方的低机位，按住空格后车就是朝这里驶入隧道，镜头保持锁定
      // 冲刺距离按参考帧量：行驶中车高约占画面 0.48（我们之前 0.36 偏小），机位因此前收到 9.0 / 8.8
      { p: 0.7, az: 186, r: 9.0, h: 3.8, ty: 1.0, tz: -0.2, tx: 0, fov: 32 },
      { p: 0.8, az: 186, r: 8.8, h: 4.0, ty: 1.05, tz: -0.1, tx: 0, fov: 32 },
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
    // 参考视频里的地面是镜面：反射贴图的高度基准给到 1024（宽度按画面宽高比推，16:9 下约 1638×1024）。
    // 实测「糊」主要来自纵向分辨率：掠射角下倒影在纵向被拉长，高度不够就糊（宽度加 2.7 倍几乎看不出差别，
    // 高度 768 → 1152 明显变清）。只填高度，宽度由引擎按画面比例补（见 engine.ts 的 reflectSizeFor）
    reflectionSize: 1024,
    pool: 0.14
  },

  speed: {
    maxSpeed: 34,
    topKmh: 340,
    launchTravel: 7.5,
    // 参考 0919：先绕到正后方，再落在左后 3/4；车偏左、消失点偏右上。
    chaseAzimuth: 205,
    // 镜头与注视点一起左移，车落在画面约 0.42 处。
    chaseLateral: -0.8,
    chaseCamera: { radius: 11.8, height: 3.7, targetY: 1.2, fov: 34 },
    response: { acceleration: 1.05, braking: 1.65 },
    // 车身流光与地面流光在参考视频里没有（高速时车身是暗的），置 0 去掉这两处多余光源
    flowStrength: 0,
    floorFlow: 0,
    // 顶点粒子隧道：三角形太碎、影响观感，这里关掉（引擎仍支持，想要纵深时把 shards 配上即可）。
    shards: false,
    tunnel: {
      radius: 26,
      length: 120,
      // download.png (541×377)：拟合四条黄线，按各自局部坐标保存，非镜像布局。
      // 每个采样区排除了红色标注框；数据与误差见 docs/showcase-tunnel-reference.md。
      referenceAspect: 541 / 377,
      surfaces: [
        { from: 165.9386, to: 194.0015, color: "#010104", opacity: 0.65 },
        { from: 316.1346, to: 405.2193, color: "#000002", opacity: 0.65 },
        { from: 194.0015, to: 197.7645, color: "#010103", opacity: 0.65 },
        { from: 278.9903, to: 316.1346, color: "#000001", opacity: 0.65 }
      ],
      gold: "#a6926d",
      white: "#6c6c76",
      dashes: 0,
      dof: 0,
      barSegment: 7,
      vanish: [0.683030, 0.621390],
      vanishFollow: false,
      barIntensity: 1,
      lanes: [
        // 左路肩在画面边缘仅约 23px 高，右路肩明显较宽，蓝线接近竖直。
        { angle: 197.7645, width: 0.15, origin: [0.683206, 0.620690], color: "#6e6d78", tailColor: "#32363d", opacity: 1, dash: 3 },
        { angle: 278.9903, width: 0.82, origin: [0.681746, 0.620690], color: "#568092", opacity: 1, dash: 3 }
      ],
      auxCount: 42,
      auxOpacity: 0.34,
      bars: [
        { angle: 165.9386, width: 0.23, origin: [0.694463, 0.620690], color: "#a6926d", tone: "gold", style: "bar" },
        { angle: 194.0015, width: 0.28, origin: [0.683206, 0.620690], color: "#9f8366", tone: "gold", style: "bar" },
        { angle: 45.2193, width: 0.55, origin: [0.683543, 0.620690], color: "#9e7f57", tone: "gold", style: "bar" },
        { angle: 316.1346, width: 0.68, origin: [0.681065, 0.620690], color: "#836d51", tone: "gold", style: "bar" }
      ]
    }
  },

  post: {
    exposure: 1.28,
    // 参考里的黄线是「亮芯 + 很窄的光晕」，泛光因此收窄、只在高速时加一点点，避免糊成一条光带
    bloom: { strength: 0.26, radius: 0.34, threshold: 1.0, speedBoost: 0.08 },
    // 拖影（动态模糊）会让行驶中的车发虚，参考视频里车是清晰的，所以置 0（想要时改回 0.05 即可）
    smear: { strength: 0, chroma: 0 }
  },

  zoom: { min: 0.55, max: 2.4, wheelStep: 0.0016 },

  // 车顶 T 字灯与车尾雨灯先去掉（引擎仍支持 lights 配置，换素材时按需再加）

  // 参考站点：未发车是 HOLD TO RACE，发车后变成 RE-ENGAGE TO SLOW（提示松开回到慢速）
  race: { idleLabel: "按住起步", label: "松手减速", cap: "追赶极限" },

  // 首页界面文案（能中文就中文，专有名词保留）
  ui: {
    kicker: "速度，自有答案",
    telemetry: "LIVE TELEMETRY",
    gear: "GEAR",
    energy: "ERS",
    unit: "KM/H",
    liveData: "LIVE DATA",
    liveDeploying: "LIVE DATA · FULL POWER",
    raceIdle: "按住起步",
    raceActive: "松手减速",
    raceCap: "追赶极限",
    raceHint: "按住 空格 或 长按按钮",
    raceHintTouch: "长按按钮发车",
    dragHint: "↻ 拖拽环视 · 上下俯仰",
    zoomHint: "⌘ / Ctrl + 滚轮缩放",
    touchHint: "单指旋转 · 双指缩放 · 双击复位",
    zoomMode: "缩放",
    view360: "360° 环视",
    studio: "影棚",
    pinCamera: "固定机位",
    loading: "正在加载模型",
    nav: ["车辆", "空力", "动力", "轮胎", "科技"]
  },

  phases: [
    { at: 0, idx: "01", name: "车辆", head: ["每一处线条，", "都指向前方。"], copy: ["从车头到车尾，", "每一处细节都为速度服务。"], cap: "赛道是你的" },
    { at: 0.2, idx: "02", name: "空气动力学", head: ["迎风而行，", "贴地而过。"], copy: ["气流沿车身掠过，", "在高速弯中换来更稳的抓地力。"], cap: "贴着顶点过弯" },
    { at: 0.4, idx: "03", name: "动力单元", head: ["每一次加速，", "都有回应。"], copy: ["V6 发动机与电能协同，", "出弯时，动力随心而至。"], cap: "发车已就绪" },
    { at: 0.58, idx: "04", name: "轮胎", head: ["速度，最终要", "落在地面上。"], copy: ["四条轮胎紧贴赛道，", "把动力化作向前的每一米。"], cap: "把抓地力用满" },
    { at: 0.78, idx: "05", name: "科技", head: ["读懂赛车，", "才能快得更稳。"], copy: ["数据记录每一圈的变化，", "下一次调整便有迹可循。"], cap: "收车回库" }
  ],

  // 部件标注（前翼/侧箱/尾翼/轮胎）先去掉：特写时压在车身上反而干扰观感。
  // 引擎仍支持 parts 配置，想要标注时按同样的格式补回来即可。
  parts: []
};
