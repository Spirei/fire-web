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
    // 参考视频里的地面是镜面：反射贴图给到 768（8 位，成本约 2.3MB）才够清晰，旋转时也不糊
    reflectionSize: 768,
    pool: 0.14
  },

  speed: {
    maxSpeed: 34,
    topKmh: 355,
    launchTravel: 7.5,
    // 正后方跟车（跑道中线）：光条汇聚点与车都在画面正中，车就落在跑道正中
    chaseAzimuth: 180,
    // 机位左移 0.6 米：车落在画面偏左（参考里车心约 0.42），但仍在跑道中线上行驶
    chaseLateral: -0.6,
    // 车身流光与地面流光在参考视频里没有（高速时车身是暗的），置 0 去掉这两处多余光源
    flowStrength: 0,
    floorFlow: 0,
    // 顶点粒子隧道：三角形太碎、影响观感，这里关掉（引擎仍支持，想要纵深时把 shards 配上即可）。
    shards: false,
    tunnel: {
      radius: 26,
      length: 120,
      // 左右各三条主光条（60° 均分）：上下两条暖金、内侧四条冷白。
      // 颜色按参考视频逐点取样后做了偏色中性化，宽度按视频量出来约 0.5°。
      // 外道浅黄（取样核心 #D0813F~#BB7611，按亮线观感提高明度后的浅黄）
      gold: "#ffbe63",
      // 内道浅蓝（取样核心 #4679D5~#6D89D3）
      white: "#9dc0ff",
      dashes: 0.9,

      barSegment: 6,
      // 角度是屏幕空间角度（相对消失点）：左三 = 150°/190°/230°，右三 = 30°/350°/310°，
      // 每侧上下两条是暖金、中间那条偏白灰，对应参考视频里的六道主光条。
      vanish: [0.5, 0.46],
      // 冲刺机位是车尾偏左的 3/4（方位角 212°），真实消失点会跑到画面很右侧；
      // 参考视频里光条是在车右后上方汇聚，所以这里仍用固定的画面汇聚点，不用真实投影
      vanishFollow: false,
      // 光条亮度（参考里黄线是亮芯 + 窄光晕）
      barIntensity: 1.75,
      // 跑道线：内侧蓝线（左右跑道边线）＋ 跑道上的短白标线（一条条掠过镜头，速度感来自它）
      lanes: [
        // 内侧蓝线：紧贴跑道两侧（最靠里），连续虚线
        { angle: 240, width: 0.3, opacity: 1.15, color: "#9dc0ff" },
        { angle: 300, width: 0.3, opacity: 1.15, color: "#9dc0ff" },
        // 跑道上流动的短白标线（一条条掠过镜头，负责速度感与远近感）
        { angle: 262, width: 0.28, opacity: 0.95, color: "#e9effb", dash: 4 },
        { angle: 278, width: 0.28, opacity: 0.95, color: "#e9effb", dash: 4 }
      ],
      // 隧道壁上的浅虚线：只留很淡的一层做质感，别抢主体（主体只有 4 条黄线 + 2 条蓝线）
      auxCount: 26,
      auxOpacity: 0.3,
      // 主体只有这些，左右镜像：
      //   外侧：每侧 2 条黄线（上黄 + 下黄，关于水平轴对称）
      //   内侧：每侧 1 条蓝线（跑道边线，见上面的 lanes）
      //   中间：跑道，不放光条
      // 角度约定 0°=右、90°=上、180°=左、270°=下。
      bars: [
        // 每侧 2 条黄线 = 墙面（上黄 + 下黄，关于水平轴对称），左右镜像；蓝线更靠里（见上面的 lanes）
        { angle: 150, width: 1.0, tone: "gold", style: "bar" },    // 左上墙
        { angle: 210, width: 1.0, tone: "gold", style: "bar" },    // 左下墙
        { angle: 30, width: 1.0, tone: "gold", style: "bar" },     // 右上墙
        { angle: 330, width: 1.0, tone: "gold", style: "bar" }     // 右下墙
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
    touchHint: "横滑环视 · 双指缩放 · 双击复位",
    zoomMode: "缩放",
    view360: "360° 环视",
    studio: "影棚",
    pinCamera: "固定机位",
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
