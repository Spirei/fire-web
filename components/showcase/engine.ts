/**
 * 通用 3D 展示台引擎（滚动叙事）。
 *
 * 实现思路来自 alphardex 的 SU7 展示站还原心得与 su7-replica 源码：
 * 1) FBO 全屏四边形把两张 HDR 环境贴图 mix 起来（夜 → 昼），结果既当环境反射又不用额外灯光；
 * 2) 平面反射 + 法线扰动 + 菲涅尔混合 + 粗糙度控制模糊的地面；
 * 3) 速度线隧道：主光条 + 很浅的虚线，配合 Bloom；
 * 4) fbm 相机晃动、随速度增强的流光与 Bloom、轮胎自转，全部由同一个速度变量驱动；
 * 5) 滚动进度 p 是唯一输入。
 *
 * 引擎只认 config（见 ./types）：换车 / 换镜头 / 换配色都通过 preset 传入，
 * 本文件不含任何车型相关常量。它只在浏览器里被动态 import，不会进入首屏包。
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { HDRLoader } from "three/addons/loaders/HDRLoader.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { fetchAssetBuffer } from "./assetCache";
import { splitWheelGeometry } from "./wheels";
import { createWireframeView } from "./wireframe";
import { coastStep, boundedZoom, wheelPixels } from "./interaction";
import type {
  ShowcaseCameraKey,
  ShowcaseConfig,
  ShowcaseDiscStyle,
  ShowcaseDriveCamera,
  ShowcaseHandle,
  ShowcaseLightBar,
  ShowcaseOptions
} from "./types";

/** 配置里的正则既能写字符串（可跨服务端/客户端传递）也能直接给 RegExp */
function toRegExp(value: string | RegExp | undefined, fallback: RegExp) {
  if (value === undefined) return fallback;
  return typeof value === "string" ? new RegExp(value, "i") : value;
}

export type { ShowcaseHandle, ShowcaseHud, ShowcaseOptions } from "./types";

/**
 * 车型参数归一化：换车型时也要再跑一遍（原地换车只换这一块），所以单独抽出来。
 * 只补车型相关的字段，不碰镜头 / 灯光 / 地面。
 */
function normalizeModel(model: ShowcaseConfig["model"]) {
  return {
      length: model?.length ?? 5.6,
      yaw: model?.yaw ?? 0,
      pitch: model?.pitch ?? 0,
      // 模型自带的发光材质（车灯 / 仪表 / 玻璃细节）统一压一档：
      // 有的模型 emissiveStrength 高达 2 以上，叠上泛光就是一团白，压到 0.45 更像自然光
      emissiveIntensity: model?.emissiveIntensity ?? 0.45,
      // 清漆层粗糙度下限：模型给 0.04 就是一面镜子 —— 灯光在车身上会聚成一条死亮的光带
      // （叠上泛光就是那团「大光晕」）。抬太高又会让高光摊成一片发虚的绒毛，
      // 0.3 是这两者之间：高光仍看得出边界，但不再是死白的斑块
      clearcoatRoughness: model?.clearcoatRoughness ?? 0.3,
      // 环境反射强度：1.25 时夜景里的小亮点会被放大成光晕，1.0 更接近实车漆面
      envMapIntensity: model?.envMapIntensity ?? 1,
      wheelPattern: toRegExp(model?.wheelPattern, /rim|tread|tyre/i),
      wheelAxis: model?.wheelAxis ?? "x",
      wheelLateral: model?.wheelLateral ?? "x",
      wheelLongitudinal: model?.wheelLongitudinal ?? "y",
      maxTextureSize: model?.maxTextureSize ?? 4096,
      wireframe: model?.wireframe,
      materialRules: (model?.materialRules ?? []).map((rule) => ({
        match: toRegExp(rule.match, /$^/),
        metalness: rule.metalness,
        roughness: rule.roughness
      }))
  };
}

/** 把 config 里的可选值补齐成引擎内部使用的常量 */
function normalizeConfig(config: ShowcaseConfig) {
  const ring = config.ground?.ring;
  const tunnel = config.speed.tunnel;
  return {
    assets: config.assets,
    watermark: config.watermark ?? "SHOWCASE",
    model: normalizeModel(config.model),
    environment: {
      nightToDay: config.environment?.nightToDay ?? [0.72, 0.88],
      dayIntensity: config.environment?.dayIntensity ?? 1
    },
    camera: {
      keyframes: [...config.camera.keyframes].sort((a, b) => a.p - b.p),
      shakeAmount: config.camera.shake?.amount ?? 0.34,
      shakeSmoothing: config.camera.shake?.smoothing ?? 1.6,
      fitMinAspect: config.camera.fit?.minAspect ?? 1.2,
      fitMaxPullback: config.camera.fit?.maxPullback ?? 1.8,
      springStiffness: config.camera.smoothing?.stiffness ?? 120,
      springDamping: config.camera.smoothing?.damping ?? 26
    },
    ground: {
      ring:
        ring === false
          ? null
          : {
              radius: ring?.radius ?? 4,
              count: ring?.count ?? 180,
              longEvery: ring?.longEvery ?? 15,
              longLength: ring?.longLength ?? 0.34,
              shortLength: ring?.shortLength ?? 0.16,
              color: ring?.color ?? "#ffb070"
            },
      reflectIntensity: config.ground?.reflectIntensity ?? 0.95,
      reflectionSize: config.ground?.reflectionSize ?? 512,
      pool: config.ground?.pool ?? 0.14
    },
    speed: {
      shards:
        config.speed.shards === false
          ? null
          : {
              count: config.speed.shards?.count ?? 900,
              color: config.speed.shards?.color ?? "#dff3ff",
              size: config.speed.shards?.size ?? 0.22,
              spread: config.speed.shards?.spread ?? 9,
              far: config.speed.shards?.far ?? 52,
              near: config.speed.shards?.near ?? -16,
              opacity: config.speed.shards?.opacity ?? 0.85
            },
      maxSpeed: config.speed.maxSpeed ?? 34,
      topKmh: config.speed.topKmh ?? 355,
      launchTravel: config.speed.launchTravel ?? 11,
      chaseAzimuth: config.speed.chaseAzimuth ?? 180,
      chaseLateral: config.speed.chaseLateral ?? 0,
      chaseCamera: config.speed.chaseCamera ?? { radius: 11.8, height: 3.7, targetY: 1.2, fov: 34 },
      response: config.speed.response ?? { acceleration: 1.45, braking: 1.7 },
      flowStrength: config.speed.flowStrength ?? 0.28,
      floorFlow: config.speed.floorFlow ?? 1,
      laneKeep: {
        enabled: config.speed.laneKeep?.enabled ?? true,
        strength: config.speed.laneKeep?.strength ?? 2.6,
        autoHeading: config.speed.laneKeep?.autoHeading ?? true
      },
      tunnel:
        tunnel === false
          ? null
          : {
              radius: tunnel?.radius ?? 26,
              referenceAspect: tunnel?.referenceAspect,
              surfaces: tunnel?.surfaces ?? [],
              length: tunnel?.length ?? 120,
              bars: tunnel?.bars ?? [],
              gold: tunnel?.gold ?? "#ffc266",
              white: tunnel?.white ?? "#ccdcfa",
              dashes: tunnel?.dashes ?? 1,
              vanish: tunnel?.vanish ?? [0.5, 0.47],
              vanishFollow: tunnel?.vanishFollow ?? true,
              barIntensity: tunnel?.barIntensity ?? 1,
              lanes: tunnel?.lanes ?? [],
              barSegment: tunnel?.barSegment ?? 13,
              dof: tunnel?.dof ?? 1.2,
              auxCount: tunnel?.auxCount ?? 18,
              auxOpacity: tunnel?.auxOpacity ?? 1
            }
    },
    post: {
      exposure: config.post?.exposure ?? 1.16,
      bloomStrength: config.post?.bloom?.strength ?? 0.4,
      bloomRadius: config.post?.bloom?.radius ?? 0.6,
      bloomThreshold: config.post?.bloom?.threshold ?? 0.85,
      bloomSpeedBoost: config.post?.bloom?.speedBoost ?? 0.42,
      smearStrength: config.post?.smear?.strength ?? 0.09,
      smearChroma: config.post?.smear?.chroma ?? 0.012
    },
    zoom: {
      min: config.zoom?.min ?? 0.55,
      max: config.zoom?.max ?? 2.4,
      wheelStep: config.zoom?.wheelStep ?? 0.0016
    },
    lights: config.lights ?? [],
    ui: {
      liveData: config.ui?.liveData ?? "LIVE DATA",
      liveDeploying: config.ui?.liveDeploying ?? "LIVE DATA · DEPLOYING",
      orbitSpeed: config.ui?.orbitSpeed ?? 0.55
    },
    phases: config.phases,
    parts: config.parts ?? []
  };
}

/** 把 config 里的光条展开成 GLSL 表达式（unrolled，避免动态数组索引） */
function barGlsl(bars: ShowcaseLightBar[], tone: "gold" | "white", scale = 1) {
  const list = bars.filter((b) => b.tone === tone);
  if (list.length === 0) return "0.0";
  return list
    .map(
      (b) =>
        `${b.style === "bar" ? "barRect" : "barLine"}(ang, ${((b.angle * Math.PI) / 180).toFixed(5)}, ${((b.width * Math.PI) / 180).toFixed(5)})`
    )
    .join(" + ") + (scale !== 1 ? ` * ${scale}` : "");
}

export function createShowcaseScene(options: ShowcaseOptions): ShowcaseHandle {
  const { canvas, hud } = options;
  const CFG = normalizeConfig(options.config);
  /** 开场进度：用户置顶过机位时从这里起步（0 = 内置开场机位） */
  const START_P = Math.min(1, Math.max(0, options.startProgress ?? 0));
  const cleanups: Array<() => void> = [];
  const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  // 排查性能用：?mcloff=reflect,bloom,tunnel,floor,car 可逐项关掉效果（只影响诊断，不影响正常访问）
  const off =
    typeof location !== "undefined"
      ? new Set((new URLSearchParams(location.search).get("mcloff") || "").split(",").filter(Boolean))
      : new Set<string>();

  // 关键事件日志（最多留 8 条），debug() 里带出来，白屏后也能追溯
  const eventLog: string[] = [];
  const logEvent = (msg: string) => {
    eventLog.push(`${new Date().toISOString().slice(11, 19)} ${msg}`);
    if (eventLog.length > 8) eventLog.shift();
  };

  /** 深浅色首帧直接沿用服务端主题，浅色刷新不先清成黑色。 */
  let theme: "dark" | "light" = options.initialTheme ?? "dark";

  /* ---------- 渲染器 / 相机 ---------- */
  // 像素预算：EffectComposer 会建两块 HalfFloat 的 RT（后来还要泛光的多级），
  // 大窗口 + 高分屏下按设备像素比铺满会直接吃掉几百 MB 显存，久了会丢上下文变白屏。
  // 这里给整屏输出封一个像素上限，超了就降倍率（分辨率换稳定）。
  // 清晰度优先：预算放宽到约 4K（8M 像素），像素比允许到设备原生 2 倍。
  // 这个值仍远低于「整屏按 dpr 铺满」的 33M 像素（那才是之前白屏的显存来源）。
  const MAX_OUTPUT_PIXELS = 8_000_000;
  const originalResolution = () => CFG.model.maxTextureSize > 4096;
  const desiredPixelRatio = () => Math.min(window.devicePixelRatio || 1, originalResolution() ? 3 : 2);
  const MIN_PIXEL_RATIO = 0.7;
  const budgetRatio = (w: number, h: number, wanted: number) => {
    const area = Math.max(1, w * h);
    if (area * wanted * wanted <= MAX_OUTPUT_PIXELS) return wanted;
    return Math.max(MIN_PIXEL_RATIO, Math.sqrt(MAX_OUTPUT_PIXELS / area));
  };
  // 参考项目 su7 的渲染器是 antialias:false（后期链路里 MSAA 用不上，只会多占显存），保持一致
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
  renderer.setPixelRatio(budgetRatio(canvas.clientWidth || window.innerWidth, canvas.clientHeight || window.innerHeight, desiredPixelRatio()));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = CFG.post.exposure;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(theme === "light" ? 0xf4f6f9 : 0x050506, 1);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 400);

  /* ---------- 背景：程序化渐变（屏幕空间），避免 HDR 的地平线穿帮 ---------- */
  const makeBackdrop = (stops: Array<[number, string]>) => {
    const c = document.createElement("canvas");
    c.width = 8;
    c.height = 512;
    const g = c.getContext("2d");
    if (g) {
      const grd = g.createLinearGradient(0, 0, 0, 512);
      stops.forEach(([o, col]) => grd.addColorStop(o, col));
      g.fillStyle = grd;
      g.fillRect(0, 0, 8, 512);
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  const backdrop = makeBackdrop([[0, "#191c22"], [0.42, "#0b0c0f"], [0.72, "#070708"], [1, "#030303"]]);
  // 浅色主题：明亮摄影棚背景
  const backdropLight = makeBackdrop([[0, "#ffffff"], [0.4, "#f6f8fa"], [0.72, "#eceff4"], [1, "#e2e7ee"]]);
  scene.background = theme === "light" ? backdropLight : backdrop;

  /* ---------- 灯光：环境贴图为主，补三盏软灯让车身读得出来 ---------- */
  const keyLight = new THREE.DirectionalLight(0xfff6ee, 0.72);
  keyLight.position.set(6, 9, 5);
  scene.add(keyLight);
  // 轮廓光原来是深橙色，高速加码后把木瓜色车身染成偏红（实测车心 187,90,58，
  // 参考是 224,155,72），所以改成浅琥珀，只做边缘提亮、不改车身色相
  const rimLight = new THREE.DirectionalLight(0xffc98a, 0.78);
  rimLight.position.set(-7, 4, -6);
  scene.add(rimLight);
  const fillLight = new THREE.DirectionalLight(0x9fc4ff, 0.32);
  fillLight.position.set(-4, 3, 7);
  scene.add(fillLight);
  // 模型查看器专用观察灯：跟随相机，为座舱、悬挂和底盘提供类似 Sketchfab 的观察方向高光。
  // 只在查看器开启时点亮，不改变首页叙事与冲刺的既有布光。
  const inspectorViewLight = new THREE.PointLight(0xf4f7ff, 0, 18, 1.45);
  const inspectorUnderLight = new THREE.HemisphereLight(0xffffff, 0xb8c5dc, 0);
  scene.add(inspectorViewLight, inspectorUnderLight);

  /* ---------- 1) 双 HDR 环境：FBO 混合 ---------- */
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  // 环境只用来做反射；之前 512×256 在车身亮漆上会看到块状色斑，
  // 提到 1024×512（HalfFloat 约 2 MB）后反射过渡才连续。
  // envTarget 是给 PMREM 用的最终结果，envMixTarget / envBlurTarget 是模糊链的中间缓冲
  // （WebGL 不允许同一张纹理既读又写，所以模糊必须两个目标来回倒）
  const envTarget = new THREE.WebGLRenderTarget(1024, 512, { type: THREE.HalfFloatType });
  const envMixTarget = new THREE.WebGLRenderTarget(1024, 512, { type: THREE.HalfFloatType });
  const envBlurTarget = new THREE.WebGLRenderTarget(1024, 512, { type: THREE.HalfFloatType });
  const envQuadScene = new THREE.Scene();
  const envQuadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const envMixMat = new THREE.ShaderMaterial({
    uniforms: { uEnv1: { value: null }, uEnv2: { value: null }, uWeight: { value: 0 } },
    vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
    fragmentShader: `
      uniform sampler2D uEnv1; uniform sampler2D uEnv2; uniform float uWeight;
      varying vec2 vUv;
      void main(){
        vec3 night = texture2D(uEnv1, vUv).rgb * vec3(0.9, 0.95, 1.15);   // 夜里压暗并偏冷
        vec3 day = texture2D(uEnv2, vUv).rgb;
        // 单颗星点 / 灯珠在亮漆上会被拉成一块死白，先压一下峰值再交给 PMREM
        vec3 mixed = min(mix(night, day, uWeight), vec3(6.0));
        gl_FragColor = vec4(mixed, 1.0);
      }`
  });
  envQuadScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), envMixMat));

  // 环境贴图再走一趟可分离高斯：夜景 HDR 里的小亮点（星点、远处灯珠）在车漆上是一颗颗
  // 硬边色斑，糊散之后才是连续的光带 —— 这就是「反射/折射里能看到色块」的来源。
  const envBlurMat = new THREE.ShaderMaterial({
    uniforms: { tSrc: { value: null }, uStep: { value: new THREE.Vector2(1 / 1024, 0) } },
    vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
    fragmentShader: `
      uniform sampler2D tSrc; uniform vec2 uStep;
      varying vec2 vUv;
      void main(){
        // 9 抽头高斯（两趟凑成一次二维模糊），半径约 4 个像素：星点被抹平，光带仍然清楚
        vec3 c = texture2D(tSrc, vUv).rgb * 0.227027;
        c += (texture2D(tSrc, vUv + uStep).rgb + texture2D(tSrc, vUv - uStep).rgb) * 0.194595;
        c += (texture2D(tSrc, vUv + uStep * 2.0).rgb + texture2D(tSrc, vUv - uStep * 2.0).rgb) * 0.121622;
        c += (texture2D(tSrc, vUv + uStep * 3.0).rgb + texture2D(tSrc, vUv - uStep * 3.0).rgb) * 0.054054;
        c += (texture2D(tSrc, vUv + uStep * 4.0).rgb + texture2D(tSrc, vUv - uStep * 4.0).rgb) * 0.016216;
        gl_FragColor = vec4(c, 1.0);
      }`
  });
  envQuadScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), envBlurMat));
  const envMixMesh = envQuadScene.children[0] as THREE.Mesh;
  const envBlurMesh = envQuadScene.children[1] as THREE.Mesh;

  let envPmrem: THREE.WebGLRenderTarget | null = null;
  let envApplied = -1;
  let envReady = false;
  const hdr = new HDRLoader();
  let nightEnv: THREE.DataTexture | null = null;
  let dayEnv: THREE.DataTexture | null = null;
  let dayEnvLoading: Promise<void> | null = null;
  function ensureDayEnvironment() {
    if (dayEnv || dayEnvLoading) return dayEnvLoading;
    dayEnvLoading = hdr.loadAsync(CFG.assets.envDay).then((day) => {
      day.mapping = THREE.EquirectangularReflectionMapping;
      dayEnv = day;
      envMixMat.uniforms.uEnv2.value = day;
      envApplied = -1;
      reflectDirty = true;
      invalidateInspector();
    }).catch((err) => {
      dayEnvLoading = null;
      options.onError?.(`日间环境贴图加载失败：${String(err?.message ?? err)}`);
    });
    return dayEnvLoading;
  }
  function updateEnv(weight: number) {
    if (!envReady) return;                       // 环境贴图没加载完就别渲染全屏四边形
    const w = Math.round(weight * 10) / 10;      // 量化，避免每帧重跑 PMREM
    if (w === envApplied) return;
    envApplied = w;
    envMixMat.uniforms.uWeight.value = w;
    const prev = renderer.getRenderTarget();
    // 1) 夜 / 昼混到 envMixTarget
    envMixMesh.visible = true;
    envBlurMesh.visible = false;
    renderer.setRenderTarget(envMixTarget);
    renderer.render(envQuadScene, envQuadCam);
    // ?mcloff=envblur 可跳过下面两趟模糊，用来对比「有没有色块」
    if (off.has("envblur")) {
      renderer.setRenderTarget(prev);
      const plain = envMixTarget.texture;
      plain.mapping = THREE.EquirectangularReflectionMapping;
      envPmrem?.dispose();
      envPmrem = pmrem.fromEquirectangular(plain);
      scene.environment = envPmrem.texture;
      return;
    }
    // 2) 横向模糊：envMixTarget → envBlurTarget
    // 半径按 2 个纹素取（= 有效 sigma 约 5 个纹素）：夜景 HDR 里的星点、远处灯珠全部抹平，
    // 车漆上就只剩连续的光带；半径太小的话，PMREM 的立方体面边界会在车身上留下方块状色斑
    envMixMesh.visible = false;
    envBlurMesh.visible = true;
    envBlurMat.uniforms.tSrc.value = envMixTarget.texture;
    (envBlurMat.uniforms.uStep.value as THREE.Vector2).set(2 / envMixTarget.width, 0);
    renderer.setRenderTarget(envBlurTarget);
    renderer.render(envQuadScene, envQuadCam);
    // 3) 纵向模糊：envBlurTarget → envTarget（PMREM 用这一张）
    envBlurMat.uniforms.tSrc.value = envBlurTarget.texture;
    (envBlurMat.uniforms.uStep.value as THREE.Vector2).set(0, 2 / envBlurTarget.height);
    renderer.setRenderTarget(envTarget);
    renderer.render(envQuadScene, envQuadCam);
    renderer.setRenderTarget(prev);
    const mixed = envTarget.texture;
    mixed.mapping = THREE.EquirectangularReflectionMapping;
    envPmrem?.dispose();
    envPmrem = pmrem.fromEquirectangular(mixed);
    // ?mcloff=env 关掉环境反射（排查车身色块是不是环境贴图造成的）
    scene.environment = off.has("env") ? null : envPmrem.texture;
  }

  /* ---------- 2) 地面：程序化法线 / 粗糙度贴图 ---------- */
  function proceduralMaps(size = 256) {
    const normal = new THREE.DataTexture(new Uint8Array(size * size * 4), size, size);
    const rough = new THREE.DataTexture(new Uint8Array(size * size * 4), size, size);
    const hash = (x: number, y: number) => {
      const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
      return s - Math.floor(s);
    };
    const val = (u: number, v: number) => {
      const x = u * size;
      const y = v * size;
      const xi = Math.floor(x);
      const yi = Math.floor(y);
      const xf = x - xi;
      const yf = y - yi;
      const sx = xf * xf * (3 - 2 * xf);
      const sy = yf * yf * (3 - 2 * yf);
      const a = hash(xi, yi);
      const b = hash(xi + 1, yi);
      const c = hash(xi, yi + 1);
      const d = hash(xi + 1, yi + 1);
      return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
    };
    const nData = normal.image.data as Uint8Array;
    const rData = rough.image.data as Uint8Array;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const i = (y * size + x) * 4;
        const h = val(x / size, y / size);
        const hx = val((x + 1) / size, y / size);
        const hy = val(x / size, (y + 1) / size);
        const nx = (h - hx) * 2.2;
        const ny = (h - hy) * 2.2;
        const len = Math.hypot(nx, ny, 1);
        nData[i] = ((nx / len) * 0.5 + 0.5) * 255;
        nData[i + 1] = ((ny / len) * 0.5 + 0.5) * 255;
        nData[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
        nData[i + 3] = 255;
        const r = 0.1 + h * 0.16;   // 更平滑 → 反射更锐（镜面感）
        rData[i] = rData[i + 1] = rData[i + 2] = r * 255;
        rData[i + 3] = 255;
      }
    }
    [normal, rough].forEach((t) => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.needsUpdate = true;
    });
    return { normal, rough };
  }
  const floorMaps = proceduralMaps(256);

  const floorUniforms = {
    tReflect: { value: null as THREE.Texture | null },
    textureMatrix: { value: new THREE.Matrix4() },
    tNormal: { value: floorMaps.normal as THREE.Texture },
    tRough: { value: floorMaps.rough as THREE.Texture },
    uColor: { value: new THREE.Color(0x0b0c0e) },
    uReflectIntensity: { value: 0.95 },
    uSpeed: { value: 0 },
    uTime: { value: 0 },
    uFlow: { value: 0 },
    // 反射混合：底色与反射的混合系数（基础量 + 菲涅尔权重）、法线扰动强度
    uMixBase: { value: 0.3 },
    uMixFres: { value: 1.05 },
    uNormalAmount: { value: 1 },
    uMipBias: { value: 1 },
    // 天际线接色：远处地面渐变成背景色，避免地面与背景在水平线上出现一条硬边
    uHorizon: { value: new THREE.Color(0x0a0b0d) },
    uHorizonMix: { value: 0.85 },
    uHorizonPower: { value: 3 }
  };
  const floor = new THREE.Mesh(
    // 冲刺镜头会沿隧道前看数百米；140 米地面会在画面中段露出远端边界，
    // 浅色背景下尤其像一整片云雾。平面只有两个三角形，扩到远裁剪面之外没有额外几何成本。
    new THREE.PlaneGeometry(800, 800),
    new THREE.ShaderMaterial({
      uniforms: floorUniforms,
      vertexShader: `
        uniform mat4 textureMatrix;
        varying vec4 vWorld; varying vec4 vReflect; varying vec3 vView;
        void main(){
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp;
          vReflect = textureMatrix * wp;
          vView = (viewMatrix * wp).xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: `
        uniform sampler2D tReflect; uniform sampler2D tNormal; uniform sampler2D tRough;
        uniform vec3 uColor; uniform float uReflectIntensity; uniform float uSpeed; uniform float uTime; uniform float uFlow;
      uniform float uMixBase; uniform float uMixFres; uniform float uNormalAmount; uniform float uMipBias;
        uniform vec3 uHorizon; uniform float uHorizonMix; uniform float uHorizonPower;
        varying vec4 vWorld; varying vec4 vReflect; varying vec3 vView;
        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float vnoise(vec2 p){
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
                     mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
        }
        void main(){
          // 纹理随速度沿车头方向滚动，制造地面在跑的感觉
          vec2 scroll = vec2(0.0, -uTime * uSpeed * 0.22);
          vec3 n = texture2D(tNormal, vWorld.xz * 0.28 + scroll).rgb * 2.0 - 1.0;
          n = normalize(n.rbg);                        // 交换 G/B：法线方向修正
          float d = length(vView);
          // 噪声只做极轻微的扰动：参考视频里的地面是镜面，扰动大了就成磨砂玻璃
          vec2 distortion = n.xz * (0.0015 + 1.6 / max(d, 1.0)) * 0.02 * uNormalAmount;
          vec4 rp = vReflect; rp.xyz /= rp.w;
          float rough = texture2D(tRough, vWorld.xz * 0.06 + scroll).r;
          // 粗糙度控制 mip 级别 → 自带模糊的反射
          vec3 refl = texture2D(tReflect, clamp(rp.xy + distortion, 0.002, 0.998), rough * 0.5 * uMipBias).rgb;
          vec3 viewDir = normalize(-vView);
          // 菲涅尔用「几何法线」而不是噪声法线：否则逐像素抖动会让地面像磨砂玻璃
          vec3 upView = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
          float fres = pow(1.0 - clamp(dot(upView, viewDir), 0.0, 1.0), 4.0);
          vec3 col = uColor;
          // 反射强度归零时必须保留地面本色。旧公式仍按 uMixBase 把地面混向黑色反射贴图，
          // 浅色冲刺因此会出现深灰色“墙”；现在混合权重随反射强度一起退场。
          float reflectBlend = clamp(uMixBase + fres * uMixFres, 0.0, 1.0) * clamp(uReflectIntensity, 0.0, 1.0);
          col = mix(col, refl * max(uReflectIntensity, 1.0), reflectBlend);
          // 越贴近天际线（掠射）越靠背景色：浅色模式下原来地面比背景暗一档，交界处能看到一条横线
          // 只压「极掠射」那一条带（fres 再取一次幂）：以前整块中景地面都被洗向天际线色，
          // 车身倒影正好落在那一段、被冲成一片灰雾，看着就是「糊」。现在中景保住反射细节，接缝照旧看不到。
          // 浅色冲刺时二次幂会把天际线接色扩成大片乳白雾团；提高幂次，只在真正贴近地平线的窄带接色。
          col = mix(col, uHorizon, clamp(pow(fres, uHorizonPower) * uHorizonMix, 0.0, 1.0));
          // 流光：高速时地面上掠过的暖色光带
          float band = vnoise(vec2(vWorld.x * 0.32, vWorld.z * 0.06 + uTime * (0.6 + uSpeed * 0.5)));
          band = pow(max(band - 0.7, 0.0) * 3.2, 2.0);
          col += vec3(1.0, 0.52, 0.18) * band * uFlow * 0.45;
          gl_FragColor = vec4(col, 1.0);
        }`
    })
  );
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  /* 平面反射：镜像相机 + 斜裁剪（three Reflector 的做法） */
  // 反射贴图每次都会重渲染整个场景，分辨率是这张图最大的成本项；
  // 观感上决定清晰度的是「纵向像素」：掠射角下倒影在纵向被拉长，高度不够就是一片糊
  // （实测宽度加 2.7 倍几乎看不出差别）；宽度按画面宽高比推，见下面的 reflectSizeFor。
  // 反射贴图用 8 位（参考项目 su7-replica 的 meshReflectorMaterial 也是 UnsignedByteType + 256），
  // 地面本身带粗糙度模糊，8 位足够，显存只有 HalfFloat 的一半。
  /**
   * 反射贴图尺寸：高度用基准值（画质自适应会调），宽度按画面宽高比给。
   *
   * 以前这里无论窗口多宽都是正方形（768×768，自适应后 998×998），而镜像相机用的是画面本身的
   * 16:9 投影 —— 两个方向的像素密度不一致，倒影在两个方向上糊的程度也不同（观感就是「糊了一层」）。
   * 现在宽度跟画面比例挂钩：像素密度一致、换窗口比例也不会变形，同一个高度下横向像素多出约 60%。
   */
  // 排查画质用：?mclreflect=1600 或 ?mclreflect=2048x1280 可以临时改反射贴图尺寸（只影响诊断，不影响正常访问）
  const reflectOverride = (() => {
    if (typeof location === "undefined") return null;
    const raw = new URLSearchParams(location.search).get("mclreflect");
    if (!raw) return null;
    const [first, second] = raw.toLowerCase().split("x");
    const height = Number(second ?? first);
    const width = second ? Number(first) : null;
    if (!Number.isFinite(height) || height < 64) return null;
    return { width: width && Number.isFinite(width) && width >= 64 ? width : null, height };
  })();
  function reflectSizeFor(aspect: number, height: number): [number, number] {
    if (reflectOverride) {
      // 这个入口是地址栏可控的（?mclreflect=...）：夹到 256..4096，避免一个链接就让访问者
      // 去分配几个 GB 的渲染目标（浏览器随即假死）
      const h = Math.max(256, Math.min(4096, Math.round(reflectOverride.height)));
      const w = reflectOverride.width ?? h * Math.max(0.6, Math.min(3, aspect));
      return [Math.max(256, Math.min(4096, Math.round(w))), h];
    }
    const h = Math.max(256, Math.round(height));
    const w = Math.max(256, Math.round(h * Math.max(0.6, Math.min(3, aspect))));
    return [w, h];
  }
  /** 舞台当前的宽高比（拿不到尺寸时按 16:9 兜底） */
  function stageAspect() {
    const w = canvas.clientWidth || hud.stage.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || hud.stage.clientHeight || window.innerHeight;
    return w > 2 && h > 2 ? w / h : 16 / 9;
  }
  /** 反射贴图当前的高度基准（自适应画质会改它，宽度永远按宽高比推） */
  let reflectHeight = CFG.ground.reflectionSize;
  const [initialReflectW, initialReflectH] = reflectSizeFor(stageAspect(), reflectHeight);
  const reflectRT = new THREE.WebGLRenderTarget(initialReflectW, initialReflectH, {
    type: THREE.UnsignedByteType,
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter
  });
  // 掠射角下地面会把反射贴图拉得很长：没有各向异性过滤时就会出现大块阶梯锯齿
  // （浅色模式亮底最明显），这里把各向异性开到设备上限
  reflectRT.texture.anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy());
  const mirrorCamera = new THREE.PerspectiveCamera();
  const reflectorPlane = new THREE.Plane();
  const normalV = new THREE.Vector3();
  const reflectorWorldPos = new THREE.Vector3();
  const cameraWorldPos = new THREE.Vector3();
  const rotationMatrix = new THREE.Matrix4();
  const lookAtPosition = new THREE.Vector3(0, 0, -1);
  const clipPlane = new THREE.Vector4();
  const viewV = new THREE.Vector3();
  const targetV = new THREE.Vector3();
  const qV = new THREE.Vector4();
  floorUniforms.tReflect.value = reflectRT.texture;

  function updateReflection() {
    // 关键：镜面相机要用「本帧」的镜头矩阵。camera.matrixWorld 只在 renderer.render() 里更新，
    // 不手动补这一下，倒影就会一直用上一帧的镜头 —— 静止时看不出来，
    // 连续旋转时整块倒影会落后一帧、像被甩出去的残影（浅色亮底最明显）。
    camera.updateMatrixWorld();
    if (off.has("reflect")) return;
    reflectorWorldPos.setFromMatrixPosition(floor.matrixWorld);
    cameraWorldPos.setFromMatrixPosition(camera.matrixWorld);
    rotationMatrix.extractRotation(floor.matrixWorld);
    normalV.set(0, 0, 1).applyMatrix4(rotationMatrix);
    viewV.subVectors(reflectorWorldPos, cameraWorldPos);
    if (viewV.dot(normalV) > 0) return;
    viewV.reflect(normalV).negate().add(reflectorWorldPos);
    rotationMatrix.extractRotation(camera.matrixWorld);
    lookAtPosition.set(0, 0, -1).applyMatrix4(rotationMatrix).add(cameraWorldPos);
    targetV.subVectors(reflectorWorldPos, lookAtPosition).reflect(normalV).negate().add(reflectorWorldPos);
    mirrorCamera.position.copy(viewV);
    mirrorCamera.up.set(0, 1, 0).applyMatrix4(rotationMatrix).reflect(normalV);
    mirrorCamera.lookAt(targetV);
    mirrorCamera.far = camera.far;
    mirrorCamera.updateMatrixWorld();
    mirrorCamera.projectionMatrix.copy(camera.projectionMatrix);

    const tm = floorUniforms.textureMatrix.value as THREE.Matrix4;
    tm.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    tm.multiply(mirrorCamera.projectionMatrix);
    tm.multiply(mirrorCamera.matrixWorldInverse);

    reflectorPlane.setFromNormalAndCoplanarPoint(normalV, reflectorWorldPos);
    reflectorPlane.applyMatrix4(mirrorCamera.matrixWorldInverse);
    clipPlane.set(reflectorPlane.normal.x, reflectorPlane.normal.y, reflectorPlane.normal.z, reflectorPlane.constant);
    const p = mirrorCamera.projectionMatrix;
    qV.x = (Math.sign(clipPlane.x) + p.elements[8]) / p.elements[0];
    qV.y = (Math.sign(clipPlane.y) + p.elements[9]) / p.elements[5];
    qV.z = -1;
    qV.w = (1 + p.elements[10]) / p.elements[14];
    clipPlane.multiplyScalar(2 / clipPlane.dot(qV));
    p.elements[2] = clipPlane.x;
    p.elements[6] = clipPlane.y;
    p.elements[10] = clipPlane.z + 1 - 0.003;
    p.elements[14] = clipPlane.w;

    const prevTarget = renderer.getRenderTarget();
    const tunnelWas = tunnel?.visible ?? false;
    const accentWas = accent?.visible ?? false;
    floor.visible = false;
    groundFx.visible = false;
    if (tunnel) tunnel.visible = false;   // 速度线不参与地面反射，否则整块地面会被照亮成一片白
    if (accent) accent.visible = false;
    renderer.setRenderTarget(reflectRT);
    renderer.clear();
    renderer.render(scene, mirrorCamera);
    renderer.setRenderTarget(prevTarget);
    floor.visible = true;
    groundFx.visible = true;
    if (tunnel) tunnel.visible = tunnelWas;
    if (accent) accent.visible = accentWas;
  }

  /* ---------- 地面装饰：光池 / 接触阴影 / 刻度环 ---------- */
  function radialTexture(stops: Array<[number, string]>, size = 256) {
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const g = c.getContext("2d");
    if (g) {
      const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      stops.forEach(([o, col]) => grd.addColorStop(o, col));
      g.fillStyle = grd;
      g.fillRect(0, 0, size, size);
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }
  const groundFx = new THREE.Group();
  scene.add(groundFx);
  let ringUniformsRef: { uSweep: { value: number }; uSpeed: { value: number }; uTime: { value: number }; uFade?: { value: number } } | null = null;
  const ringOutlineMats: THREE.MeshBasicMaterial[] = [];
  let discStyle: ShowcaseDiscStyle = "chrono";
  let driveCamera: ShowcaseDriveCamera = "follow";
  let driveAzimuth = 180;
  let driveRadiusScale = 0.66;
  let driveHeightScale = 0.78;
  let classicCameraBlend = 0;
  let topCameraBlend = 0;
  let trackDiscFraming = 0;
  const chronoDisc = new THREE.Group();
  const trackDisc = new THREE.Group();
  chronoDisc.visible = !mobileViewer();
  trackDisc.visible = false;
  groundFx.add(chronoDisc, trackDisc);

  const pool = new THREE.Mesh(
    new THREE.PlaneGeometry(34, 34),
    new THREE.MeshBasicMaterial({
      map: radialTexture([[0, "rgba(255,158,86,0.34)"], [0.32, "rgba(255,120,44,0.08)"], [1, "rgba(0,0,0,0)"]]),
      transparent: true,
      opacity: 0.3,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    })
  );
  pool.rotation.x = -Math.PI / 2;
  pool.position.y = 0.004;
  pool.renderOrder = 1;
  groundFx.add(pool);

  // 接触阴影：原来 8.4×3.6 米的纯黑椭圆比车还大，浅色亮底上会从车轮两侧露出来，
  // 看着就是一团黑影；现在收到接近车身尺寸，并把边缘做柔、浓度降下来
  const contact = new THREE.Mesh(
    new THREE.PlaneGeometry(6.6, 2.6),
    new THREE.MeshBasicMaterial({
      map: radialTexture([[0, "rgba(0,0,0,0.7)"], [0.42, "rgba(0,0,0,0.32)"], [1, "rgba(0,0,0,0)"]]),
      transparent: true,
      opacity: 0.7,
      depthWrite: false
    })
  );
  contact.rotation.x = -Math.PI / 2;
  contact.position.y = 0.008;
  contact.renderOrder = 2;
  groundFx.add(contact);

  /**
   * 车下方的刻度环（config.ground.ring）：世界坐标里是一个正圆（屏幕上的椭圆来自俯视透视），
   * 外圈按计时码表排布径向刻度，每 longEvery 条一根长刻度，内圈再补两条细圆线。
   */
  const RING = CFG.ground.ring;
  const RING_COUNT = RING ? RING.count : 0;
  const RING_R = RING ? RING.radius : 0;
  function ellipseOutline(scaleX: number, scaleY: number, lineWidth: number, opacity: number, color: number) {
    const g = new THREE.RingGeometry(1, 1 + lineWidth, 256);
    const mesh = new THREE.Mesh(
      g,
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide
      })
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.scale.set(scaleX, scaleY, 1);
    mesh.position.y = 0.01;
    mesh.renderOrder = 3;
    return mesh;
  }
  let ring: THREE.InstancedMesh | null = null;
  if (RING) {
    const ringColor = new THREE.Color(RING.color);
    [ellipseOutline(RING_R + RING.longLength, RING_R + RING.longLength, 0.004, 0.2, ringColor.getHex()),
     ellipseOutline(RING_R, RING_R, 0.0025, 0.1, ringColor.clone().lerp(new THREE.Color(0xffffff), 0.35).getHex())
    ].forEach((mesh) => {
      const m = mesh.material as THREE.MeshBasicMaterial;
      m.userData.baseOpacity = m.opacity;
      ringOutlineMats.push(m);
      chronoDisc.add(mesh);
    });
    const ringUniforms = {
      uSweep: { value: 0 },
      uSpeed: { value: 0 },
      uTime: { value: 0 },
      uColor: { value: ringColor },
      uFade: { value: 1 }
    };
    const ringGeo = new THREE.BoxGeometry(0.024, 0.004, RING.shortLength);
    const ringMat = new THREE.ShaderMaterial({
      uniforms: ringUniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: `
        attribute float aIndex;
        varying float vIndex;
        void main(){
          vIndex = aIndex / ${RING.count}.0;
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform float uSweep; uniform float uSpeed; uniform float uTime; uniform vec3 uColor; uniform float uFade;
        varying float vIndex;
        void main(){
          float diff = abs(fract(vIndex - uSweep + 0.5) - 0.5) * 2.0;   // 环上的角距离
          float glow = pow(1.0 - clamp(diff, 0.0, 1.0), 7.0);
          float flick = 0.85 + 0.15 * sin(uTime * 3.0 + vIndex * 90.0);
          float a = (0.16 + glow * 0.5) * flick * (0.8 + uSpeed * 0.5) * uFade;
          gl_FragColor = vec4(uColor * (0.8 + glow * 1.4), a);
        }`
    });
    const mesh = new THREE.InstancedMesh(ringGeo, ringMat, RING.count);
    const m = new THREE.Matrix4();
    const idx = new Float32Array(RING.count);
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const zAxis = new THREE.Vector3(0, 0, 1);
    for (let i = 0; i < RING.count; i += 1) {
      const a = (i / RING.count) * Math.PI * 2;
      // 径向刻度：从圆周往外画，每 longEvery 条一根长刻度
      const dir = new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
      const long = i % RING.longEvery === 0;
      const len = long ? RING.longLength : RING.shortLength;
      pos.copy(dir).multiplyScalar(RING_R + len / 2);
      pos.y = 0.012;
      quat.setFromUnitVectors(zAxis, dir);
      m.compose(pos, quat, new THREE.Vector3(long ? 1.3 : 1, 1, len / RING.shortLength));
      mesh.setMatrixAt(i, m);
      idx[i] = i;
    }
    ringGeo.setAttribute("aIndex", new THREE.InstancedBufferAttribute(idx, 1));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.renderOrder = 3;
    mesh.frustumCulled = false;
    chronoDisc.add(mesh);
    ring = mesh;
    ringUniformsRef = ringUniforms;

    /*
     * 0919 原片圆盘：逐帧量得外径约为车身投影的 1.6 倍，由两条完整细环与 72 格
     * 向内的径向刻度组成。原片合成后的亮线约 RGB(31,34,38)，对应冷灰源色叠到黑底；
     * 不是三条米金色切向点阵。单独成组，仍可与原刻度盘原地切换。
     */
    const VIDEO_DISC_RADIUS = RING_R * (4.25 / 3.3);
    const videoDiscColor = new THREE.Color("#aeb5bc");
    [
      { radius: VIDEO_DISC_RADIUS - 0.07, width: 0.0025, opacity: 0.11 },
      { radius: VIDEO_DISC_RADIUS, width: 0.0035, opacity: 0.2 }
    ].forEach(({ radius, width, opacity }) => {
      const outline = ellipseOutline(radius, radius, width, opacity, videoDiscColor.getHex());
      const material = outline.material as THREE.MeshBasicMaterial;
      material.userData.baseOpacity = material.opacity;
      ringOutlineMats.push(material);
      trackDisc.add(outline);
    });
    const videoTickCount = 72;
    const tickTypes = [
      { every: 6, exclude: 0, length: 0.3, width: 0.022, opacity: 0.34 },
      { every: 3, exclude: 6, length: 0.18, width: 0.018, opacity: 0.22 },
      { every: 1, exclude: 3, length: 0.1, width: 0.014, opacity: 0.14 }
    ];
    const videoTickAxis = new THREE.Vector3(0, 0, 1);
    tickTypes.forEach(({ every, exclude, length, width, opacity }, level) => {
      const indices = Array.from({ length: videoTickCount }, (_, index) => index)
        .filter(index => index % every === 0 && (!exclude || index % exclude !== 0));
      const geometry = new THREE.BoxGeometry(width, 0.003, length);
      const material = new THREE.MeshBasicMaterial({
        color: videoDiscColor,
        transparent: true,
        opacity,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      });
      material.userData.baseOpacity = material.opacity;
      material.userData.mobileOpacity = level === 2 ? 0 : 1;
      ringOutlineMats.push(material);
      const ticks = new THREE.InstancedMesh(geometry, material, indices.length);
      const matrix = new THREE.Matrix4();
      const position = new THREE.Vector3();
      const quaternion = new THREE.Quaternion();
      indices.forEach((sourceIndex, instanceIndex) => {
        const angle = (sourceIndex / videoTickCount) * Math.PI * 2;
        const direction = new THREE.Vector3(Math.sin(angle), 0, Math.cos(angle));
        position.copy(direction).multiplyScalar(VIDEO_DISC_RADIUS - length / 2);
        position.y = 0.012 + level * 0.0006;
        quaternion.setFromUnitVectors(videoTickAxis, direction);
        matrix.compose(position, quaternion, new THREE.Vector3(1, 1, 1));
        ticks.setMatrixAt(instanceIndex, matrix);
      });
      ticks.instanceMatrix.needsUpdate = true;
      ticks.frustumCulled = false;
      ticks.renderOrder = 3;
      trackDisc.add(ticks);
    });
  }

  /* ---------- 3) 速度线隧道：纯片元着色器 ---------- */
  /** 速度线用的预计算噪声贴图：把逐像素的 hash 计算换成一次纹理采样，环形网格保证无缝平铺 */
  function streakNoiseTexture(size = 256, cells = 24) {
    const data = new Uint8Array(size * size * 4);
    const hash = (x: number, y: number, s: number) => {
      const v = Math.sin(x * 127.1 + y * 311.7 + s * 74.7) * 43758.5453;
      return v - Math.floor(v);
    };
    const wrap = (v: number) => ((v % cells) + cells) % cells;
    const val = (u: number, v: number, s: number) => {
      const fx = u * cells;
      const fy = v * cells;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = fx - x0;
      const ty = fy - y0;
      const sx = tx * tx * (3 - 2 * tx);
      const sy = ty * ty * (3 - 2 * ty);
      const a = hash(wrap(x0), wrap(y0), s);
      const b = hash(wrap(x0 + 1), wrap(y0), s);
      const c = hash(wrap(x0), wrap(y0 + 1), s);
      const d = hash(wrap(x0 + 1), wrap(y0 + 1), s);
      return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
    };
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const i = (y * size + x) * 4;
        const u = x / size;
        const v = y / size;
        const n = val(u, v, 1) * 0.9 + val(u * 2, v * 2, 2) * 0.35;
        // 提对比：只有峰值附近才亮，采样后才有细线而不是一团光
        data[i] = Math.pow(Math.min(1, n), 1.5) * 255;   // 速度线亮度
        data[i + 1] = val(u, v, 7) * 255;          // 每条线的配色选择
        data[i + 2] = val(u * 3, v * 3, 11) * 255; // 颜色抖动
        data[i + 3] = 255;
      }
    }
    const t = new THREE.DataTexture(data, size, size);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.minFilter = THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    return t;
  }
  const streakNoise = streakNoiseTexture();

  const streakVert = `
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
  const TUNNEL = CFG.speed.tunnel;
  const barTune = TUNNEL?.bars ?? [];
  // 主光条 / 车道线切成短段的密度（越大段越短）
  const SEG_SCALE = (CFG.speed.tunnel?.barSegment ?? 13).toFixed(1);
  const LANE_SEG_SCALE_NUM = (CFG.speed.tunnel?.barSegment ?? 13) * 0.28;
  const laneList = CFG.speed.tunnel?.lanes ?? [];
  // 跑道线逐条生成：每条自带颜色 / 宽度 / 不透明度 / 段长（dash 越大段越短）/ 流动速度。
  // dash 取 1 是随镜头一路延伸的长虚线（跑道边线），取 3 以上是路面短标线 ——
  // 参考视频里那条很短的白线就是它，行驶时一条条掠过镜头，速度与远近感主要靠它。
  const laneCode = laneList.length
    ? laneList
        .map((l, i) => {
          const a = ((l.angle * Math.PI) / 180).toFixed(5);
          const w = ((l.width * Math.PI) / 180).toFixed(5);
          const seg = (LANE_SEG_SCALE_NUM * (l.dash ?? 1) * 0.16).toFixed(3);
          const duty = l.dash ?? 1;
          const on = duty >= 2 ? [0.02, 0.05, 0.58, 0.65] : [0.02, 0.08, 0.62, 0.70];
          const flow = (Number(seg) * 3.5).toFixed(3);
          const col = new THREE.Color(l.color ?? "#8f9aa8").convertLinearToSRGB();
          const tail = new THREE.Color(l.tailColor ?? l.color ?? "#8f9aa8").convertLinearToSRGB();
          const fade = (l.opacity ?? 0.6).toFixed(3);
          return `{
            vec2 laneD = (tunnelUv - ${l.origin ? `vec2(${l.origin[0].toFixed(6)}, ${l.origin[1].toFixed(6)})` : "uCenter"}) * vec2(uAspect, 1.0);
            float laneR = length(laneD);
            float lm = barRect(atan(laneD.y, laneD.x), ${a}, ${w}) * ${fade};
            float lp = ${seg} / max(laneR, 0.025) + uTime * ${flow} + ${(i * 0.371).toFixed(3)};
            float ld = smoothstep(${on[0]}, ${on[1]}, fract(lp)) * (1.0 - smoothstep(${on[2]}, ${on[3]}, fract(lp)));
            lane += lm * ld;
            laneCol += mix(vec3(${col.r.toFixed(5)}, ${col.g.toFixed(5)}, ${col.b.toFixed(5)}),
              vec3(${tail.r.toFixed(5)}, ${tail.g.toFixed(5)}, ${tail.b.toFixed(5)}), smoothstep(0.2, 0.58, fract(lp))) * lm * ld;
          }`;
        })
        .join("\n        ")
    : "lane = 0.0;";
  const goldBars = barGlsl(barTune, "gold");
  const whiteBars = barGlsl(barTune, "white");
  const goldCores = barGlsl(barTune.filter((b) => b.style !== "bar"), "gold", 0.27);
  const whiteCores = barGlsl(barTune.filter((b) => b.style !== "bar"), "white", 0.26);
  const streakFrag = `
    uniform float uTime; uniform float uSpeed; uniform float uOpacity; uniform vec3 uTint; uniform sampler2D tNoise;
    uniform float uBars; uniform vec3 uGold; uniform vec3 uWhite; uniform float uDash;
    varying vec2 vUv;
    const float TAU = 6.28318530718;
    // 圆周上的角度距离（弧度），用来画径向光条
    float barLine(float ang, float target, float w){
      float d = abs(fract((ang - target) / TAU + 0.5) - 0.5) * TAU;
      return smoothstep(w, 0.0, d);
    }
    float barRect(float ang, float target, float w){
      float d = abs(fract((ang - target) / TAU + 0.5) - 0.5) * TAU;
      return smoothstep(w, w * 0.86, d);
    }
    void main(){
      float ang = vUv.x * TAU;
      vec3 col = vec3(0.0);
      float mask = 0.0;
      if (uBars > 0.5) {
        // 左右各三条主光条（60° 均分）：上下两条是暖金色，靠内侧的四条偏白灰。
        // 宽度按参考视频量出来约 0.5°，所以这里是很细的亮线，靠 Bloom 出光晕。
        float gold = ${goldBars};
        float white = ${whiteBars};
        float goldCore = ${goldCores};
        float whiteCore = ${whiteCores};
        // 亮度放在颜色里，alpha 顶到 1 就够，否则叠上 Bloom 会一片糊
        col += uGold * (gold * 1.15 + goldCore * 2.0) + uWhite * (white * 0.7 + whiteCore * 1.4);
        mask += gold * 0.6 + goldCore * 0.32 + white * 0.42 + whiteCore * 0.24;
      }
      // 其余是很浅的虚线：噪声贴图沿轴拉伸并滚动
      vec2 nUv = vec2(vUv.x * 48.0, vUv.y * 0.32 - uTime * 1.34);
      vec3 s = texture2D(tNoise, nUv).rgb;
      float dash = smoothstep(0.86, 0.99, s.r) * 0.34 * uDash;
      col += mix(vec3(0.52, 0.58, 0.72), vec3(0.92, 0.94, 1.0), s.g) * dash;
      mask += dash;
      col *= uTint;
      mask *= smoothstep(0.0, 0.16, vUv.y) * smoothstep(0.0, 0.16, 1.0 - vUv.y);
      mask *= smoothstep(0.0, 0.1, vUv.x) * smoothstep(0.0, 0.1, 1.0 - vUv.x);
      mask *= smoothstep(2.0, 12.0, uSpeed);
      gl_FragColor = vec4(col, mask * uOpacity);
    }`;
  const tunnelUniforms = {
    uTime: { value: 0 },
    uSpeed: { value: 0 },
    uOpacity: { value: 0 },
    uTint: { value: new THREE.Color(1, 1, 1) },
    tNoise: { value: streakNoise },
    uBars: { value: 0 },   // 主光条改到屏幕空间的后期里画（见 LightLinesShader）
    // 光条取色：按参考视频逐点取样后的暖金与冷白（照片偏色已做中性化）
    uGold: { value: new THREE.Color(TUNNEL?.gold ?? "#ffc266") },
    uWhite: { value: new THREE.Color(TUNNEL?.white ?? "#ccdcfa") },
    uDash: { value: TUNNEL?.dashes ?? 1 }
  };
  const tunnel = TUNNEL ? new THREE.Mesh(
    new THREE.CylinderGeometry(TUNNEL.radius, TUNNEL.radius, TUNNEL.length, 64, 1, true),
    new THREE.ShaderMaterial({
      uniforms: tunnelUniforms,
      vertexShader: streakVert,
      fragmentShader: streakFrag,
      transparent: true,
      side: THREE.BackSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    })
  ) : null;
  if (tunnel) {
    tunnel.rotation.x = Math.PI / 2;   // 圆柱轴对齐车长方向（Z）
    tunnel.frustumCulled = false;
    scene.add(tunnel);
  }

  const tunnel2Uniforms = {
    uTime: { value: 0 },
    uSpeed: { value: 0 },
    uOpacity: { value: 0 },
    uTint: { value: new THREE.Color(1.6, 0.85, 0.45) },
    tNoise: { value: streakNoise },
    uBars: { value: 0 },               // 副层只画很浅的虚线，主光条只留在主层
    uDash: { value: TUNNEL?.dashes ?? 1 },
    uGold: { value: new THREE.Color(1.0, 0.76, 0.4) },
    uWhite: { value: new THREE.Color(0.8, 0.86, 0.98) }
  };
  const accent = TUNNEL ? new THREE.Mesh(
    new THREE.CylinderGeometry(TUNNEL.radius * 0.73, TUNNEL.radius * 0.73, TUNNEL.length, 48, 1, true),
    new THREE.ShaderMaterial({
      uniforms: tunnel2Uniforms,
      vertexShader: streakVert,
      fragmentShader: streakFrag,
      transparent: true,
      side: THREE.BackSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    })
  ) : null;
  if (accent) {
    accent.rotation.set(Math.PI / 2, 0, 0.35);
    accent.frustumCulled = false;
    scene.add(accent);
  }

  /* ---------- 4) 车身流光：世界坐标驱动的流动光带 ---------- */
  const flowUniforms = {
    uFlowTime: { value: 0 },
    uFlowStrength: { value: 0 },
    uFlowColor: { value: new THREE.Color(0xffb070) }
  };
  function addFlow(material: THREE.Material) {
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uFlowTime = flowUniforms.uFlowTime;
      shader.uniforms.uFlowStrength = flowUniforms.uFlowStrength;
      shader.uniforms.uFlowColor = flowUniforms.uFlowColor;
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vFlowPos;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvFlowPos = (modelMatrix * vec4(transformed, 1.0)).xyz;");
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>
          varying vec3 vFlowPos;
          uniform float uFlowTime; uniform float uFlowStrength; uniform vec3 uFlowColor;
          float flowHash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          float flowNoise(vec2 p){
            vec2 i = floor(p), f = fract(p);
            f = f * f * (3.0 - 2.0 * f);
            return mix(mix(flowHash(i), flowHash(i + vec2(1.0, 0.0)), f.x),
                       mix(flowHash(i + vec2(0.0, 1.0)), flowHash(i + vec2(1.0, 1.0)), f.x), f.y);
          }`
        )
        .replace(
          "#include <emissivemap_fragment>",
          `#include <emissivemap_fragment>
          if (uFlowStrength > 0.001) {
            float band = flowNoise(vec2(vFlowPos.z * 0.55, vFlowPos.y * 1.4) - vec2(uFlowTime * 1.6, 0.0));
            band = pow(max(band - 0.55, 0.0) * 2.4, 2.5);
            float band2 = flowNoise(vec2(vFlowPos.x * 0.9, vFlowPos.z * 0.35) + vec2(uFlowTime * 2.1, 0.0));
            band2 = pow(max(band2 - 0.6, 0.0) * 2.6, 3.0);
            totalEmissiveRadiance += uFlowColor * (band * 1.6 + band2 * 0.9) * uFlowStrength;
          }`
        );
    };
    material.needsUpdate = true;
  }

  /* ---------- 5) 后期：色散拖影 + Bloom + 输出 ---------- */
  const smearPass = new ShaderPass({
    uniforms: {
      tDiffuse: { value: null },
      uStrength: { value: 0 },
      uChroma: { value: 0 },
      uTime: { value: 0 },
      uGrain: { value: 0.5 }
    },
    vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: `
      uniform sampler2D tDiffuse; uniform float uStrength; uniform float uChroma; uniform float uTime; uniform float uGrain;
      varying vec2 vUv;
      void main(){
        vec2 toCenter = vUv - vec2(0.5, 0.48);
        // 主体是横向拖影（车在画面里横向运动），叠一点径向拉伸，保留可读性
        vec2 dir = vec2(1.0, 0.05) * uStrength * 0.05 + toCenter * uStrength * 0.06;
        vec3 sum = vec3(0.0);
        float wsum = 0.0;
        for (int i = 0; i < 9; i++) {
          float t = float(i) / 8.0;
          float s = (t - 0.5) * 2.0;                 // 对称采样：拖影围绕物体展开，不把主体推偏
          float w = 1.0 - abs(s) * abs(s) * 0.85;
          vec2 off = dir * s;
          sum.r += texture2D(tDiffuse, vUv + off * (1.0 + uChroma)).r * w;
          sum.g += texture2D(tDiffuse, vUv + off).g * w;
          sum.b += texture2D(tDiffuse, vUv + off * (1.0 - uChroma)).b * w;
          wsum += w;
        }
        vec3 col = sum / wsum;
        float g = fract(sin(dot(vUv * (1.0 + fract(uTime) * 0.5), vec2(12.9898, 78.233))) * 43758.5453);
        col += (g - 0.5) * 0.028 * uGrain;
        // NaN 兜底：采样出 NaN 时直接回落成原图，避免整屏被放大成白
        if (!(col.r == col.r) || !(col.g == col.g) || !(col.b == col.b)) col = texture2D(tDiffuse, vUv).rgb;
        gl_FragColor = vec4(col, 1.0);
      }`
  });
  // 主光条：屏幕空间里从消失点放射出去的细亮线（参考视频里就是这个观感）。
  // 贴在圆柱面上的线只有在柱面很细的时候才进得来，所以改成后期。
  const lineBars = CFG.speed.tunnel?.bars ?? [];
  const lineAngles = lineBars.map((b) => ({ origin: b.origin, color: new THREE.Color(b.color ?? (b.tone === "gold" ? TUNNEL?.gold ?? "#ffc266" : TUNNEL?.white ?? "#ccdcfa")).convertLinearToSRGB(), a: (b.angle * Math.PI) / 180, w: (b.width * Math.PI) / 180, gold: b.tone === "gold" }));
  const lightLinesPass = new ShaderPass({
    uniforms: {
      tDiffuse: { value: null },
      uTime: { value: 0 },
      uStrength: { value: 0 },
      tSceneDepth: { value: null },
      uWorldFromClip: { value: new THREE.Matrix4() },
      uSpeed: { value: 0 },
      uCenter: { value: new THREE.Vector2(CFG.speed.tunnel?.vanish?.[0] ?? 0.5, CFG.speed.tunnel?.vanish?.[1] ?? 0.47) },
      uAspect: { value: 1.78 },
      uTunnelFrame: { value: new THREE.Vector2(CFG.speed.tunnel?.vanish?.[0] ?? 0.5, 1) },
      uGold: { value: new THREE.Color(CFG.speed.tunnel?.gold ?? "#ffc266").convertLinearToSRGB() },
      uWhite: { value: new THREE.Color(CFG.speed.tunnel?.white ?? "#ccdcfa").convertLinearToSRGB() },
      uIntensity: { value: CFG.speed.tunnel?.barIntensity ?? 1 },
      uCarBox: { value: new THREE.Vector4(0.5, 0.46, 0.12, 0.06) },
      uLaneColor: { value: new THREE.Color(laneList[0]?.color ?? "#9aa6b4") },
      uAuxCount: { value: CFG.speed.tunnel?.auxCount ?? 18 },
      uAuxOpacity: { value: CFG.speed.tunnel?.auxOpacity ?? 1 },
      uLightMode: { value: 0 },
      // 景深强度：0 = 全锐利，1.3 左右接近参考视频里边缘发虚的观感
      uDof: { value: CFG.speed.tunnel?.dof ?? 1.2 }
    },
    vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: `
      uniform sampler2D tDiffuse; uniform float uTime; uniform float uStrength; uniform float uSpeed;
      uniform sampler2D tSceneDepth; uniform mat4 uWorldFromClip;
      uniform vec2 uCenter; uniform float uAspect; uniform vec2 uTunnelFrame; uniform vec3 uGold; uniform vec3 uWhite; uniform float uIntensity;
      uniform vec4 uCarBox;   // 车在屏幕上的包围盒：xy 中心、zw 半尺寸（uv）
      uniform vec3 uLaneColor; uniform float uAuxCount; uniform float uAuxOpacity; uniform float uLightMode; uniform float uDof;
      varying vec2 vUv;
      const float TAU = 6.28318530718;
      // 景深：光条越远离消失点越"失焦"（角宽变大、峰值变低），靠近消失点则保持锐利
      float gRadius;
      float gDof;
      float barLine(float ang, float target, float w){
        float d = abs(fract((ang - target) / TAU + 0.5) - 0.5) * TAU;
        float wDof = w * (1.0 + gRadius * gDof);
        float soft = smoothstep(wDof * 3.0, 0.0, d) * 0.12 + smoothstep(wDof, 0.0, d);
        return soft / (1.0 + gRadius * gDof * 0.55);
      }
      // 矩形光条：平顶、边缘只有很窄的过渡（参考视频左右两侧那两根黄色长方形）
      float barRect(float ang, float target, float w){
        float d = abs(fract((ang - target) / TAU + 0.5) - 0.5) * TAU;
        float wDof = w * (1.0 + gRadius * gDof);
        float aa = max(fwidth(d), 0.0001);
        return (1.0 - smoothstep(max(0.0, wDof - aa), wDof + aa, d)) / (1.0 + gRadius * gDof * 0.3);
      }
      float hash11(float p){ return fract(sin(p * 127.1) * 43758.5453); }
      void main(){
        vec4 base = texture2D(tDiffuse, vUv);
        if (uStrength <= 0.001) { gl_FragColor = base; return; }
        // 竖屏稍微展开赛道并收回消失点，给车和左侧路肩留下间距；遮挡仍用真实屏幕坐标。
        vec2 tunnelUv = vec2(uCenter.x + (vUv.x - uTunnelFrame.x) / uTunnelFrame.y, vUv.y);
        // 用像素比例还原真实屏幕角度，宽屏也不会把线压扁
        vec2 d = (tunnelUv - uCenter) * vec2(uAspect, 1.0);
        float r = length(d);
        float ang = atan(d.y, d.x);
        // 靠近消失点淡出；外侧不再衰减（参考视频里亮线一直延伸到画面边缘）。
        // 收得比原来更靠里（0.03-0.2）：参考在消失点周围是一圈密集的短线段（starburst），
        // 原来 0.05-0.3 的淡出让最里面那圈几乎看不见，看着反而比参考稀
        gRadius = r;
        gDof = uDof;
        float radial = smoothstep(0.03, 0.2, r);
        // 透视深度与屏幕半径成反比：统一世界速度，近端快速拉长，远端密集。
        vec3 mainLight = vec3(0.0);
        float warmLight = 0.0;
        ${lineAngles.map((b, i) => `{
          vec2 railD = (tunnelUv - ${b.origin ? `vec2(${b.origin[0].toFixed(6)}, ${b.origin[1].toFixed(6)})` : "uCenter"}) * vec2(uAspect, 1.0);
          float line = barRect(atan(railD.y, railD.x), ${b.a.toFixed(5)}, ${b.w.toFixed(5)});
          float phase = ${SEG_SCALE} * 0.12 / max(length(railD), 0.025) + uTime * ${SEG_SCALE} * 0.42 + ${(i * 0.371).toFixed(3)};
          float f = fract(phase);
          float dash = smoothstep(0.02, 0.05, f) * (1.0 - smoothstep(0.58, 0.65, f));
          mainLight += vec3(${b.color.r.toFixed(5)}, ${b.color.g.toFixed(5)}, ${b.color.b.toFixed(5)}) * line * dash;
          ${b.gold ? "warmLight += line * dash;" : ""}
        }`).join("\n        ")}
        // 复用场景深度，只遮实际车体；包围框内的空白和路面继续显示线条。
        vec2 carQ = (vUv - uCarBox.xy) / max(uCarBox.zw, vec2(1e-4));
        float hide = 0.0;
        if (max(abs(carQ.x), abs(carQ.y)) < 1.0) {
          float depth = texture2D(tSceneDepth, vUv).x;
          vec4 world = uWorldFromClip * vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
          hide = step(0.025, world.y / world.w) * (1.0 - step(0.99999, depth));
        }
        // 隧道壁上的细虚线：按角度均匀分槽，每槽随机宽度 / 亮度 / 相位。
        // 参考视频里这些线是「细而长」的（宽约 3-5px、长 120-200px），所以槽内宽度收窄、切段拉长。
        // 隧道左右对称：槽号取其与镜像槽的较小值再哈希，两侧的宽度与相位因此完全一致
        float slotF = ang / TAU * uAuxCount;
        float slot = floor(slotF);
        float inSlot = fract(slotF);
        // 横向镜像对应角度 180° − ang，换算到槽号就是 N/2 − slot（N 为偶数）
        float mirror = mod(uAuxCount * 0.5 - slot, uAuxCount);
        float symSlot = min(slot, mirror);
        float h = hash11(symSlot + 3.7);
        float slotW = (0.014 + h * 0.025);                       // 占槽宽的比例（越小越细）
        float slotDist = min(inSlot, 1.0 - inSlot) * TAU / uAuxCount;
        float slotMax = slotW * (TAU / uAuxCount) * 0.5;
        float auxAA = max(fwidth(slotDist), 0.0001);
        float auxLine = (1.0 - smoothstep(max(0.0, slotMax - auxAA), slotMax + auxAA, slotDist))
          * min(1.0, slotMax / auxAA) * step(0.24, hash11(symSlot + 11.3));
        float auxDepth = 0.5 + h * 0.3;
        float auxPhase = fract(auxDepth / max(r, 0.025) + uTime * auxDepth * 3.5 + h * 3.0);
        float auxDash = smoothstep(0.02, 0.06, auxPhase) * (1.0 - smoothstep(0.10, 0.70, auxPhase));
        float upperWall = smoothstep(-0.06, 0.02, d.y);
        float aux = auxLine * auxDash * (0.4 + h * 0.6) * uAuxOpacity * upperWall;
        // 跑道线：逐条画（每条自带颜色 / 段长 / 流动速度），见上面的 laneCode
        float lane = 0.0;
        vec3 laneCol = vec3(0.0);
        ${laneCode}
        vec3 glow = (mainLight + laneCol + uWhite * aux)
          * radial * (1.0 - hide) * uStrength * uIntensity;
        // 两种主题保持相同空间 / 节奏，浅底用可辨识的冷暖色暗线。
        float mask = max(glow.r, max(glow.g, glow.b));
        // 亮底不能沿用夜景的“加亮”方式，否则所有线都会被白底洗成灰色。
        // 以冷蓝 / 暖橙两套实色压到画面上，并从原始光条色差判断所属色系。
        // 色系由线条配置决定，不能按最终像素亮度猜：暖色线在远端变淡后，红蓝差趋近 0，
        // 旧判断会把同一根橙线的尾部误判成蓝色。
        float warmSignal = step(0.00001, warmLight);
        vec3 dayLine = mix(vec3(0.36, 0.53, 0.70), vec3(0.82, 0.52, 0.31), warmSignal);
        float degrees = mod(ang * 360.0 / TAU + 360.0, 360.0);
        vec3 roadBase = base.rgb;
        ${(TUNNEL?.surfaces ?? []).map(surface => {
          const color = new THREE.Color(surface.color).convertLinearToSRGB();
          return `{
            float sector = mod(degrees - ${surface.from.toFixed(5)} + 360.0, 360.0);
            float inside = 1.0 - step(${(surface.to - surface.from).toFixed(5)}, sector);
            roadBase = mix(roadBase, vec3(${color.r.toFixed(5)}, ${color.g.toFixed(5)}, ${color.b.toFixed(5)}),
              inside * radial * (1.0 - hide) * uStrength * ${(surface.opacity).toFixed(3)} * (1.0 - uLightMode));
          }`;
        }).join("\n")}
        vec3 outRgb = uLightMode > 0.5
          ? mix(base.rgb, dayLine, clamp(mask * 1.25, 0.0, 0.74))
          : roadBase + glow;
        gl_FragColor = vec4(outRgb, base.a);
      }`
  });
  const composer = new EffectComposer(renderer);
  // 两个交替缓冲都保留本帧深度；后期不写深度，无须额外重画一次车体蒙版。
  for (const target of [composer.renderTarget1, composer.renderTarget2]) {
    target.depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
  }
  smearPass.material.depthWrite = false;
  smearPass.material.depthTest = false;
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(smearPass);
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(1, 1),
    CFG.post.bloomStrength,
    CFG.post.bloomRadius,
    CFG.post.bloomThreshold
  );
  bloom.enabled = !off.has("bloom");
  composer.addPass(bloom);
  const outputPass = new OutputPass();
  outputPass.material.depthWrite = false;
  outputPass.material.depthTest = false;
  composer.addPass(outputPass);
  // 参考图采样为 sRGB：在 tone mapping 之后合成，避免曝光 / Bloom 二次改色。
  composer.addPass(lightLinesPass);
  if (off.has("floor")) floor.visible = false;

  /* ---------- 6) 模型 ---------- */
  const carRoot = new THREE.Group();
  scene.add(carRoot);

  /** 车上的发光点：一张径向渐变广告牌 + 一盏点光，按 preset 给的模式常亮或只在发车时亮 */
  function glowTexture(size = 64) {
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const g = c.getContext("2d");
    if (g) {
      const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      grd.addColorStop(0, "rgba(255,255,255,1)");
      grd.addColorStop(0.25, "rgba(255,255,255,0.75)");
      grd.addColorStop(0.55, "rgba(255,255,255,0.18)");
      grd.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = grd;
      g.fillRect(0, 0, size, size);
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }
  const carLights: Array<{ sprite: THREE.Sprite; light: THREE.PointLight; intensity: number; mode: "always" | "race" }> = [];
  CFG.lights.forEach((def) => {
    const tex = glowTexture();
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: tex,
        color: new THREE.Color(def.color),
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      })
    );
    sprite.position.set(def.pos[0], def.pos[1], def.pos[2]);
    sprite.scale.setScalar(def.size ?? 0.28);
    sprite.renderOrder = 4;
    carRoot.add(sprite);
    const light = new THREE.PointLight(new THREE.Color(def.color), 0, 2.4, 2);
    light.position.set(def.pos[0], def.pos[1], def.pos[2]);
    carRoot.add(light);
    carLights.push({ sprite, light, intensity: def.intensity ?? 0.7, mode: def.mode ?? "race" });
  });
  let shardMesh: THREE.Mesh | null = null;
  let shardUniformsRef: {
    uTime: { value: number };
    uSpeed: { value: number };
    uOpacity: { value: number };
  } | null = null;
  const spinAxis = new THREE.Vector3(1, 0, 0);   // 轮子自转轴（config.model.wheelAxis）
  /** 车道保持开关与回收速度：横向偏移、车头偏角都会被拉回隧道中心线 */
  const laneKeepOn = CFG.speed.laneKeep?.enabled !== false;
  const laneKeepStrength = CFG.speed.laneKeep?.strength ?? 2.6;
  /** 自动量出来的车头偏角（度，相对隧道方向）；横向偏移（米）与实时偏角由车道保持收敛 */
  let laneHeadingDeg = 0;
  let carLateral = 0;
  let carHeadingOffset = 0;
  /** 车模在 carRoot 局部空间里的包围盒：每帧投影成屏幕包围盒，用来让光条从车后面穿过 */
  const carLocalBox = new THREE.Box3();
  /** 排查换车型用：车模在场景里的实际包围盒尺寸 */
  let carDebugBox: number[] = [];
  /** 归一化之前的原始包围盒（模型自带单位），导入向导用来判断朝向与单位 */
  let carRawBox: number[] = [];
  /** 模型结构快照（导入向导用来挑轮子材质 / 核对模型是否完整） */
  let carMaterialNames: string[] = [];
  let carMeshNames: string[] = [];
  let carWheelGroups = 0;
  const wheelPivots: Array<
    Array<{ mesh: THREE.Mesh; center: THREE.Vector3; radius: number; direction: number; angle: number; rot: THREE.Matrix4; t1: THREE.Matrix4; t2: THREE.Matrix4 }>
  > = [];
  const bodyMaterials: THREE.MeshStandardMaterial[] = [];
  const wheelBlur = { value: 0 };

  /**
   * 顶点粒子隧道（参考零跑 C16 公开课的做法）：
   * 从车模顶点里等距采样若干点当粒子种子，每颗粒子只存「自己的位置 + 随机相位」，
   * 位置偏移全部在顶点着色器里算 —— 没有 CPU 粒子模拟、没有每帧上传、也没有额外贴图，
   * 因此这一层的显存占用几乎为零（只有一个很小的实例化三角形缓冲）。
   */
  function buildShardField(car: THREE.Object3D) {
    const SHARD = CFG.speed.shards;
    if (!SHARD) return;
    car.updateMatrixWorld(true);
    const sampled: THREE.Vector3[] = [];
    const meshes: THREE.Mesh[] = [];
    car.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry?.attributes?.position) return;
      meshes.push(mesh);
    });
    if (meshes.length === 0) return;
    const perMesh = Math.max(8, Math.ceil(SHARD.count / meshes.length));
    const v = new THREE.Vector3();
    meshes.forEach((mesh) => {
      const pos = mesh.geometry.attributes.position as THREE.BufferAttribute;
      const step = Math.max(1, Math.floor(pos.count / perMesh));
      for (let i = 0; i < pos.count; i += step) {
        v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
        sampled.push(v.clone());
      }
    });
    if (sampled.length === 0) return;
    // 均匀抽到目标数量（保持形状分布）
    const stepAll = Math.max(1, Math.floor(sampled.length / SHARD.count));
    const picked = sampled.filter((_, i) => i % stepAll === 0).slice(0, SHARD.count);
    const base = new THREE.BufferGeometry();
    // 基础形状：一个三角形，用重心坐标在片元里只画边框（和课件里的线框三角一致）
    base.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    base.setAttribute("uv", new THREE.Float32BufferAttribute([1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 2));
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.attributes.position = base.attributes.position;
    geo.attributes.uv = base.attributes.uv;
    const seeds = new Float32Array(picked.length);
    const posArr = new Float32Array(picked.length * 3);
    picked.forEach((p, i) => {
      seeds[i] = Math.random();
      posArr[i * 3] = p.x;
      posArr[i * 3 + 1] = p.y;
      posArr[i * 3 + 2] = p.z;
    });
    geo.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 1));
    geo.setAttribute("aOrigin", new THREE.InstancedBufferAttribute(posArr, 3));
    geo.instanceCount = picked.length;
    const shardUniforms = {
      uTime: { value: 0 },
      uSpeed: { value: 0 },
      uOpacity: { value: 0 },
      uColor: { value: new THREE.Color(SHARD.color) },
      uSize: { value: SHARD.size },
      uSpread: { value: SHARD.spread },
      uFar: { value: SHARD.far },
      uNear: { value: SHARD.near }
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: shardUniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      vertexShader: `
        attribute float aSeed;
        attribute vec3 aOrigin;
        uniform float uTime; uniform float uSpeed; uniform float uSize; uniform float uSpread; uniform float uFar; uniform float uNear;
        varying vec3 vBary; varying float vFade;
        void main(){
          float t = fract(aSeed + uTime * (0.05 + uSpeed * 0.012));
          // 采样点在横截面里的方向决定往哪边扩散；越靠近镜头扩散越大
          vec2 planar = vec2(aOrigin.x, aOrigin.z);
          vec2 dir = normalize(planar + vec2(0.0001, 0.0001));
          float radial = length(planar);
          float grow = uSpread * pow(t, 1.5);
          vec3 center = vec3(dir.x * (radial + grow), aOrigin.y * 0.6 + 0.5, dir.y * (radial + grow));
          // 沿隧道轴从远处飞到镜头后方（相机在车尾一侧）
          center.z = mix(uFar, uNear, t);
          vBary = vec3(uv.x, uv.y, 1.0 - uv.x - uv.y);
          // 远端淡入、贴近镜头淡出
          vFade = smoothstep(0.0, 0.12, t) * (1.0 - smoothstep(0.86, 1.0, t));
          vec3 scaled = position * uSize * (0.6 + 0.8 * fract(aSeed * 7.0));
          gl_Position = projectionMatrix * viewMatrix * vec4(center + scaled, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 uColor; uniform float uOpacity;
        varying vec3 vBary; varying float vFade;
        void main(){
          float e = min(min(vBary.x, vBary.y), vBary.z);
          float edge = smoothstep(0.09, 0.0, e);
          if (edge <= 0.002) discard;
          gl_FragColor = vec4(uColor, edge * vFade * uOpacity);
        }`
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 5;
    mesh.visible = false;
    scene.add(mesh);
    shardMesh = mesh;
    shardUniformsRef = shardUniforms;
  }

  const loadTotal = 2;   // 夜间 HDR + 当前轻量模型；日间 HDR 在需要前再加载
  let loadDone = 0;
  const reportProgress = (partial = 0) => {
    options.onProgress?.(Math.min(1, (loadDone + partial) / loadTotal));
    if (loadDone >= loadTotal) options.onReady?.();
  };

  // 车模走 IndexedDB 缓存：首次下载并写入，之后刷新直接读本地，不再重新下 20 MB
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const parseCar = (buffer: ArrayBuffer) =>
    new Promise<THREE.Object3D>((resolve, reject) => {
      loader.parse(
        buffer,
        "",
        (gltf) => resolve(gltf.scene),
        (err: unknown) => reject(err instanceof Error ? err : new Error(String(err ?? "模型解析失败")))
      );
    });

  /** 当前挂在场景里的车（换车型时用它撤掉旧车） */
  const wireframeView = createWireframeView(CFG.model.wireframe, true, () => invalidateInspector());
  let wireframeMode: "native" | "overlay" | "wireframe" = "native";
  let mountedCar: THREE.Object3D | null = null;
  let modelSwitchSequence = 0;

  /**
   * 把一辆车挂进 carRoot：尺寸归一化、材质规则、贴图上限、清漆 / 发光、拆轮子、车道朝向、包围盒。
   * 首次加载与换车型共用这个函数 —— 换车型只是「撤旧车 + 挂新车」，场景 / 镜头 / 地面 / HUD 都不重建。
   */
  function mountCar(car: THREE.Object3D) {
      car.visible = !off.has("car");
      // 不同来源的模型朝向不一致：preset 里给 yaw / pitch 做一次性修正
      if (CFG.model.yaw) car.rotation.y += (CFG.model.yaw * Math.PI) / 180;
      if (CFG.model.pitch) car.rotation.x += (CFG.model.pitch * Math.PI) / 180;
      car.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(car);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const scale = CFG.model.length / Math.max(size.x, size.y, size.z);
      // 归一化之前的原始包围盒：导入向导靠它判断模型的单位与「哪根轴朝上」
      carRawBox = [size.x, size.y, size.z].map((v) => +v.toFixed(4));
      car.scale.setScalar(scale);
      car.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);

      // 贴图尺寸上限：默认 4096（等于不动），大贴图模型可在 preset 里调到 2048 省一半以上显存
      // 原画模式尊重设备实际可上传的单张纹理上限；部分手机 WebGL 只支持 4K/8K。
      // 超过 MAX_TEXTURE_SIZE 直接上传会让整车渲染失败，而等比缩小仍保留该设备的最高原生清晰度。
      const maxTex = Math.min(CFG.model.maxTextureSize, renderer.capabilities.maxTextureSize);
      const clampTexture = (tex: THREE.Texture | null | undefined) => {
        const img = tex?.image as { width?: number; height?: number } | undefined;
        if (!tex || !img?.width || !img?.height) return;
        const longest = Math.max(img.width, img.height);
        if (longest <= maxTex) return;
        const ratio = maxTex / longest;
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(img.width * ratio));
        c.height = Math.max(1, Math.round(img.height * ratio));
        const ctx = c.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(img as CanvasImageSource, 0, 0, c.width, c.height);
        tex.image = c;
        tex.needsUpdate = true;
      };

      const splitTargets: THREE.Mesh[] = [];
      const materialNames = new Set<string>();
      const meshNames = new Set<string>();
      car.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.frustumCulled = false;
        const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial;
        const name = mat?.name || "";
        // 导入向导要看的模型结构：材质名用来挑轮子 / 写材质规则，网格名用来判断一个网格是不是一辆车
        if (name && materialNames.size < 120) materialNames.add(name);
        if (mesh.name && meshNames.size < 200) meshNames.add(mesh.name);
        // 按 preset 的规则修正材质参数（不同模型自带参数差别很大：轮胎不该是金属，碳纤维别太像镜子）
        if (mat?.isMeshStandardMaterial) {
          if (!mat.userData.showcaseMaterialBase) mat.userData.showcaseMaterialBase = {
            envMapIntensity: mat.envMapIntensity,
            emissiveIntensity: mat.emissiveIntensity,
            clearcoatRoughness: (mat as THREE.MeshPhysicalMaterial).clearcoatRoughness ?? 0
          };
          CFG.model.materialRules.forEach((rule) => {
            if (!rule.match.test(name)) return;
            if (rule.metalness !== undefined) mat.metalness = rule.metalness;
            if (rule.roughness !== undefined) mat.roughness = rule.roughness;
          });
          ["map", "normalMap", "roughnessMap", "metalnessMap", "aoMap", "emissiveMap"].forEach((key) => {
            const tex = (mat as unknown as Record<string, THREE.Texture | null>)[key];
            clampTexture(tex);
            // 掠射角下没有各向异性过滤，车身上的字母会糊成一片；开到设备上限的一半更清楚
            if (tex) tex.anisotropy = Math.min(originalResolution() ? 16 : 8, renderer.capabilities.getMaxAnisotropy());
          });
          // 环境反射强度：1.25 时夜景里的小亮点在亮漆上会被放大成一团光晕，收到 1.0 更接近实车
          mat.envMapIntensity = CFG.model.envMapIntensity;
          // 清漆层：模型给 0.04 就是一面镜子，环境贴图在镜面上会显出砖块状色斑（车漆"色块"的来源）。
          // 抬到 0.2 相当于真实车漆的清漆层 —— 依然有光泽，但反射是连续的
          const physical = mat as THREE.MeshPhysicalMaterial;
          if (physical.clearcoat && physical.clearcoat > 0) {
            physical.clearcoatRoughness = Math.max(physical.clearcoatRoughness ?? 0, CFG.model.clearcoatRoughness);
            // ?mcloff=clearcoat 关掉清漆层（排查车头那层镜面反射造成的色块）
            if (off.has("clearcoat")) physical.clearcoat = 0;
          }
          // 发光材质压到自然强度：保留灯 / 仪表的亮，但不糊成一块白。
          // ?mcloff=emissive 可整批关掉发光，用来确认画面里的亮斑是不是车灯造成的
          if (off.has("emissive")) {
            mat.emissiveIntensity = 0;
          } else if (mat.emissive && (mat.emissive.r > 0.01 || mat.emissive.g > 0.01 || mat.emissive.b > 0.01)) {
            mat.emissiveIntensity = Math.min(mat.emissiveIntensity || 1, CFG.model.emissiveIntensity);
          }
          addFlow(mat);
          bodyMaterials.push(mat);
        }
        if (CFG.model.wheelPattern.test(name) && !/st_wheel/i.test(name)) splitTargets.push(mesh);
      });
      carRoot.add(car);

      // 拆轮子：几何体不动，用「平移到轮心 → 旋转 → 平移回去」的矩阵让每个轮子绕自己的轴自转
      const axisIndex = { x: 0, y: 1, z: 2 } as const;
      const lateralAxis = axisIndex[CFG.model.wheelLateral];
      const longAxis = axisIndex[CFG.model.wheelLongitudinal];
      carRoot.updateMatrixWorld(true);
      spinAxis.set(CFG.model.wheelAxis === "x" ? 1 : 0, CFG.model.wheelAxis === "y" ? 1 : 0, CFG.model.wheelAxis === "z" ? 1 : 0);
      splitTargets.forEach((mesh) => {
        const parts = splitWheelGeometry(mesh, lateralAxis, longAxis);
        if (parts.size === 0) return; // 悬挂等共用轮胎材质的部件保持原网格。
        const originalMaterial = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial;
        const material = originalMaterial.clone();
        // 高速轮胎的细字不应像静止贴纸一样逐帧闪烁；额外 mip 过滤保住圆形轮廓。
        material.onBeforeCompile = shader => {
          shader.uniforms.uWheelBlur = wheelBlur;
          shader.fragmentShader = "uniform float uWheelBlur;\n" + shader.fragmentShader.replace(
            "#include <map_fragment>", THREE.ShaderChunk.map_fragment.replace(
              "texture2D( map, vMapUv )", "texture2D( map, vMapUv, uWheelBlur )"));
        };
        material.customProgramCacheKey = () => "showcase-wheel-filter-v1";
        bodyMaterials.push(material);
        parts.forEach((part, key) => {
          const m = new THREE.Mesh(part.geometry, material);
          mesh.updateMatrix();
          m.matrix.copy(mesh.matrix);
          m.matrixAutoUpdate = false;
          m.frustumCulled = false;
          // 必须挂在原来的父节点下：模型原始坐标是 Z 轴朝上，靠父节点的 -90° 旋转才立起来，
          // 直接挂到场景根上会少了这层旋转，轮子就会飘到车顶上方。
          (mesh.parent ?? car).add(m);
          const { x, y, z } = part.center;
          if (!wheelPivots[key]) wheelPivots[key] = [];
          wheelPivots[key].push({
            mesh: m,
            center: part.center.clone(),
            radius: part.radius * new THREE.Vector3().setComponent(3 - lateralAxis - longAxis, 1)
              .applyMatrix3(new THREE.Matrix3().setFromMatrix4(mesh.matrixWorld)).length(),
            direction: new THREE.Vector3().copy(spinAxis).transformDirection(mesh.matrixWorld)
              .cross(new THREE.Vector3(0, 1, 0)).dot(new THREE.Vector3(0, 0, 1)) >= 0 ? 1 : -1,
            angle: 0,
            rot: new THREE.Matrix4(),
            t1: mesh.matrix.clone().multiply(new THREE.Matrix4().makeTranslation(x, y, z)),
            t2: new THREE.Matrix4().makeTranslation(-x, -y, -z)
          });
        });
        mesh.visible = false;
      });
      // 轮圈 / 侧壁 / 胎面属于同一只轮：统一用外胎半径，不能让小轮圈转得比胎面快。
      carRoot.updateMatrixWorld(true);
      const wheelCenters = wheelPivots.flat().map(w => ({ w, world: w.center.clone().applyMatrix4(w.mesh.matrixWorld) }));
      for (const { w, world } of wheelCenters) {
        w.radius = Math.max(w.radius, ...wheelCenters.filter(other =>
          world.distanceTo(other.world) < Math.max(w.radius, other.w.radius) * 1.2
        ).map(other => other.w.radius));
      }
      carMaterialNames = [...materialNames];
      carMeshNames = [...meshNames];
      carWheelGroups = wheelPivots.length;

      // 车道保持的第一件事：量出车头方向。
      // 前后轴中心连线就是车身纵轴，它与隧道方向（+z）的夹角就是「车头偏角」——
      // 不同来源的模型朝向不一，用几何量出来比手调 model.yaw 可靠，也不依赖具体车型。
      if (laneKeepOn) {
        carRoot.updateMatrixWorld(true);
        const centers = wheelCenters.map(({world}) => carRoot.worldToLocal(world.clone()));
        const bounds = new THREE.Box3().setFromPoints(centers);
        const extent = bounds.getSize(new THREE.Vector3());
        const axis = extent.x > extent.z ? "x" : "z";
        const middle = (bounds.min[axis] + bounds.max[axis]) / 2;
        const axleSum = [new THREE.Vector3(), new THREE.Vector3()];
        const axleCount = [0, 0];
        centers.forEach(center => {
          // 拆分编号只在各自网格内有效，前后轴必须在统一的车体坐标下判断。
          const end = center[axis] > middle ? 1 : 0;
          axleSum[end].add(center);
          axleCount[end] += 1;
        });
        if (axleCount[0] > 0 && axleCount[1] > 0) {
          const a = axleSum[0].divideScalar(axleCount[0]);
          const b = axleSum[1].divideScalar(axleCount[1]);
          let deg = (Math.atan2(b.x - a.x, b.z - a.z) * 180) / Math.PI;
          // 只按「轴」对齐：超过 90° 就取另一头，避免把车调头
          if (deg > 90) deg -= 180;
          else if (deg < -90) deg += 180;
          laneHeadingDeg = deg;
          if (CFG.speed.laneKeep?.autoHeading !== false) {
            car.rotation.y -= (deg * Math.PI) / 180;
            car.updateMatrixWorld(true);
          }
        }
      }
      // 车身包围盒（carRoot 局部空间）缓存一份：光条遮挡用它，比写死的「半长 ± x」准。
      // 先把 carRoot 归零再量，量完恢复，避免把根节点的位移算进去。
      const keepPos = carRoot.position.clone();
      const keepRot = carRoot.rotation.clone();
      carRoot.position.set(0, 0, 0);
      carRoot.rotation.set(0, 0, 0);
      carRoot.updateMatrixWorld(true);
      carLocalBox.setFromObject(car);
      {
        // 排查换车型：把车模在场景里的实际包围盒记下来（缩放 / 朝向不对时一眼能看出来）
        const dbgBox = new THREE.Box3().setFromObject(car);
        const dbgSize = dbgBox.getSize(new THREE.Vector3());
        carDebugBox = [dbgSize.x, dbgSize.y, dbgSize.z].map((v) => +v.toFixed(2));
      }
    carRoot.position.copy(keepPos);
    carRoot.rotation.copy(keepRot);
    carRoot.updateMatrixWorld(true);
    buildShardField(car);
    mountedCar = car;
    wireframeView.attach(car);
  }

  /** 撤掉上一辆车：车身 / 拆出来的轮子 / 几何体 / 材质 / 模型自带贴图全部释放，并清空与车身绑定的缓存 */
  function unmountCar(car: THREE.Object3D | null) {
    if (!car) return;
    wireframeView.detach();
    car.parent?.remove(car);
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    car.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (mesh.geometry) geometries.add(mesh.geometry);
      (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach((m) => {
        if (m) materials.add(m);
      });
    });
    geometries.forEach((g) => g.dispose());
    materials.forEach((m) => {
      // 只释放模型自带的贴图：环境贴图是场景共享的，跟着材质 dispose 会把新车也一起弄花
      const maps = m as unknown as Record<string, THREE.Texture | null | undefined>;
      ["map", "normalMap", "roughnessMap", "metalnessMap", "aoMap", "emissiveMap"].forEach((key) => maps[key]?.dispose?.());
      m.dispose();
    });
    wheelPivots.length = 0;
    bodyMaterials.length = 0;
    carWheelGroups = 0;
    carMaterialNames = [];
    carMeshNames = [];
    carRawBox = [];
    carDebugBox = [];
    carLocalBox.makeEmpty();
    laneHeadingDeg = 0;
  }

  /** 取素材（走 IndexedDB 缓存）→ 解析 → 挂车；首次加载与换车型共用一条路径 */
  async function loadCar(asset: string, model: ShowcaseConfig["model"], onRatio?: (ratio: number) => void) {
    const cached = await fetchAssetBuffer(asset, onRatio);
    logEvent(`车模来源 ${cached.mode}${cached.fromCache ? "（本地命中）" : "（网络下载）"}`);
    const car = await parseCar(cached.buffer);
    mountCar(car);
    return car;
  }

  void (async () => {
    try {
      await loadCar(CFG.assets.model, CFG.model, (ratio) => reportProgress(ratio));
      loadDone += 1;
      reportProgress();
      resize();
      render(progress(), 1 / 60);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err ?? "");
      options.onError?.(message || "模型加载失败");
    }
  })();

  /* ---------- 7) 滚动编排 ---------- */
  const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
  const smooth = (t: number) => t * t * (3 - 2 * t);
  const smoother = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  const seg = (p: number, a: number, b: number) => smooth(clamp((p - a) / (b - a), 0, 1));

  // 相机关键帧：方位角（度）/ 半径 / 高度 / 注视点 / 视角
  // 方位角 0° = 正对车头，90° = 车身左侧，180° = 车尾。
  // 开场对齐参考图：左侧全览（车头朝画面右），随后绕到车头 3/4、细节特写，最后在车尾方向收车。
  const CAM_KEYS: ShowcaseCameraKey[] = CFG.camera.keyframes.length
    ? CFG.camera.keyframes
    : [{ p: 0, az: 0, r: 12, h: 2, ty: 0.9, tz: 0, fov: 30 }];
  const camState = {
    az: CAM_KEYS[0].az,
    r: CAM_KEYS[0].r,
    h: CAM_KEYS[0].h,
    ty: CAM_KEYS[0].ty,
    tz: CAM_KEYS[0].tz,
    tx: CAM_KEYS[0].tx ?? 0,
    fov: CAM_KEYS[0].fov,
    fovEff: CAM_KEYS[0].fov
  };
  function camAt(p: number) {
    let i = 0;
    while (i < CAM_KEYS.length - 2 && p > CAM_KEYS[i + 1].p) i += 1;
    const a = CAM_KEYS[i];
    const b = CAM_KEYS[i + 1];
    const t = smoother(clamp((p - a.p) / (b.p - a.p), 0, 1));
    camState.az = a.az + (b.az - a.az) * t;
    camState.r = a.r + (b.r - a.r) * t;
    camState.h = a.h + (b.h - a.h) * t;
    camState.ty = a.ty + (b.ty - a.ty) * t;
    camState.tz = a.tz + (b.tz - a.tz) * t;
    camState.tx = (a.tx ?? 0) + ((b.tx ?? 0) - (a.tx ?? 0)) * t;
    camState.fov = a.fov + (b.fov - a.fov) * t;
  }

  // fbm 噪声（相机晃动）
  function fbm2(x: number, y: number, octave = 3) {
    let value = 0;
    let freq = 1;
    let amp = 1;
    let norm = 0;
    const h = (i: number, j: number) => {
      const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
      return (s - Math.floor(s)) * 2 - 1;
    };
    for (let o = 0; o < octave; o += 1) {
      const xi = Math.floor(x * freq);
      const yi = Math.floor(y * freq);
      const xf = x * freq - xi;
      const yf = y * freq - yi;
      const sx = xf * xf * (3 - 2 * xf);
      const sy = yf * yf * (3 - 2 * yf);
      const v = (h(xi, yi) * (1 - sx) + h(xi + 1, yi) * sx) * (1 - sy) + (h(xi, yi + 1) * (1 - sx) + h(xi + 1, yi + 1) * sx) * sy;
      value += v * amp;
      norm += amp;
      freq *= 2;
      amp *= 0.5;
    }
    return value / norm;
  }
  const shakeOffset = new THREE.Vector3();
  const shakeTarget = new THREE.Vector3();
  const SHAKE_SEED = [Math.random() * 1000, Math.random() * 1000, Math.random() * 1000];

  let speed = 0;
  let elapsed = 0;
  let roadTravel = 0; // 积分速度，变速时光条相位连续，不用 elapsed × 当前速度。
  let racing = false;
  let racingAmt = 0;   // 速度驱动的镜头混合量（轮胎 / 光条直接跟随速度）
  let carTravel = 0;   // 冲刺时车沿隧道开走的距离
  let lastRacing = false;
  let lastDriving = false;
  const perfStartedAt = performance.now();
  let renderCalls = 0;
  let reflectionRenders = 0;
  let inspectorSkippedFrames = 0;
  let homepageSkippedFrames = 0;
  let reflectDirty = true;
  // 反射是否在动：只要相机或车动过就必须逐帧更新，否则倒影会比画面慢一帧 → 看起来在抖。
  // 完全静止时复用上一张逐像素相同的反射纹理。
  const reflectCamLast = new THREE.Vector3(1e9, 0, 0);
  let reflectTravelLast = -1;
  const reflectNeedsUpdate = () => {
    // 镜头只要动过就必须逐帧更新：阈值收到 1e-10（约 1e-5 米），
    // 否则慢速旋转时倒影会隔帧更新，看起来就像有一层甩出去的残影
    const camMoved = camera.position.distanceToSquared(reflectCamLast) > 1e-10;
    const carMoved = Math.abs(carTravel - reflectTravelLast) > 1e-6;
    if (camMoved || carMoved || reflectDirty) return true;
    // 环视 / 拖拽惯性期间也强制逐帧（这时镜头动得很慢，靠位置差判断会漏）
    if (orbitOn || Math.abs(userYawVel) > 1e-4 || Math.abs(userPitchVel) > 1e-5 || Math.abs(zoomTarget - zoom) > 1e-4) return true;
    // 相机、车辆和场景都没变化时，上一张反射纹理仍是逐像素相同的结果；不要再隔帧重画整场景。
    return false;
  };
  let lastLit = -1;
  let lastMarkP = -1;
  let lastMarkRace = -1;
  let lastRaceClass: boolean | null = null;
  const labelPos: Array<{ x: number; y: number; opacity?: number } | undefined> = [];
  let userYaw = 0;
  let userYawVel = 0;
  // 上下拖拽的俯仰偏移：把「相机高度」换算成仰角后再叠加，这样上下拖是真抬头/俯视
  let userPitch = 0;
  let userPitchVel = 0;
  /** 360° 环视：自动绕车旋转（角速度由 ui.orbitSpeed 给，默认约 0.5 弧度/秒） */
  let orbitOn = false;
  let orbitYaw = 0;
  /** 影棚：环境切到明亮摄影棚（与深浅色主题独立，供「影棚」胶囊使用） */
  let studioOn = false;
  /** 镜头快速转动时倒影淡出（0=静止全强度，1=转动最快时几乎关掉），避免倒影扫过去像残影 */
  let motionFade = 0;
  /** 低通后的镜头角速度（弧度/秒）：用来算倒影淡出，避免逐帧抖动变成频闪 */
  let azSpeedSmooth = 0;
  let lastAzRad = Number.NaN;
  // 用户缩放：滚轮（⌘/Ctrl + 滚轮或触控板捏合）与按钮都改这个倍率，用来放大看细节
  const MIN_ZOOM = CFG.zoom.min;
  const MAX_ZOOM = CFG.zoom.max;
  const INSPECTOR_MIN_ZOOM = 0.015;
  const INSPECTOR_MAX_ZOOM = 400;
  let freeCamera = false;
  let inspectorOn = false;
  // 工作台静止时保留最后一帧；交互期间仍按显示器刷新率、原像素比连续渲染。
  // 这只消除重复帧，不改画布分辨率、贴图、线框几何或材质质量。
  let inspectorRenderDirty = true;
  const invalidateInspector = () => { inspectorRenderDirty = true; };
  const modelCameraOn = () => freeCamera || inspectorOn;
  let inspectorProgress = START_P;
  const inspectorBackgroundLight = new THREE.Color("#e7e7e7");
  const inspectorBackgroundDark = new THREE.Color("#090b0f");
  let inspectorPose: { free: boolean; yaw: number; pitch: number; zoom: number; orbit: boolean; orbitYaw: number; focus: THREE.Vector3 } | null = null;
  const focusTarget = new THREE.Vector3();
  const focusOffset = new THREE.Vector3();
  const focusRay = new THREE.Raycaster();
  const focusPointer = new THREE.Vector2();
  const zoomLimit = () => {
    if (modelCameraOn()) return INSPECTOR_MAX_ZOOM;
    if (!freeCamera) return MAX_ZOOM;
    const base = CAM_KEYS[0];
    const fit = camera.aspect < CFG.camera.fitMinAspect
      ? clamp(CFG.camera.fitMinAspect / camera.aspect, 1, CFG.camera.fitMaxPullback) : 1;
    const height = canvas.clientHeight || 720;
    // 最远仍保留至少 110px / 短边 20% 的可辨识轮廓，竖屏同时计入机位拉远与 FOV。
    const pixels = Math.max(110, Math.min(canvas.clientWidth || 1280, height) * 0.2);
    const fov = base.fov * Math.pow(fit, 0.45) * Math.PI / 180;
    return clamp(CFG.model.length * 0.6 * height /
      (2 * Math.tan(fov / 2) * pixels * base.r * Math.pow(fit, 0.8)), 1.2, 5);
  };
  let zoom = 1;
  let zoomTarget = 1;
  let active = true;
  let lastPhase = -1;

  const carHalfA = new THREE.Vector3();
  const carHalfB = new THREE.Vector3();
  const carHalfC = new THREE.Vector3();
  const carHalfD = new THREE.Vector3();
  const camPos = new THREE.Vector3();
  const lookAt = new THREE.Vector3();
  const projected = new THREE.Vector3();
  let viewAzimuth = 0;
  let viewElevation = 0;
  let viewDistance = 0;

  let interactionUntil = 0;
  let reflectionLite = false;
  let reflectResizedAt = -1;
  function render(p: number, dt = 0.016) {
    renderCalls += 1;
    elapsed += dt;
    const mobilePresentation = mobileViewer();

    // 0919：约 2 秒进入高速，松手后先退光条，再回到展示机位。
    const targetSpeed = racing ? CFG.speed.maxSpeed : 0;
    const response = racing ? CFG.speed.response.acceleration : CFG.speed.response.braking;
    const previousSpeed = speed;
    speed += (targetSpeed - speed) * (1 - Math.exp(-dt * response));
    if (!racing && speed < 0.015) speed = 0;
    roadTravel += (previousSpeed + speed) * 0.5 * dt;
    const sp = clamp(speed / CFG.speed.maxSpeed, 0, 1);
    const chaseTarget = reduced ? 0 : seg(sp, 0.035, 0.86);
    racingAmt += (chaseTarget - racingAmt) * (1 - Math.exp(-dt * 5.5));
    if (racing !== lastRacing) {
      lastRacing = racing;
      options.onRacing?.(racing);
    }
    const drivingNow = !inspectorOn && (racing || speed > CFG.speed.maxSpeed * 0.035);
    if (drivingNow !== lastDriving) {
      lastDriving = drivingNow;
      options.onDriving?.(drivingNow);
    }
    carTravel += (racingAmt * CFG.speed.launchTravel - carTravel) * (1 - Math.exp(-dt * 3));

    // 环境：夜 → 昼（窗口与强度由 preset 给；参考视频里整段 hero 都是夜景，只在收尾略微提亮）
    // 浅色主题直接顶到白天环境；深色主题按叙事窗口在夜→昼之间过渡
    const narrativeDay = seg(p, CFG.environment.nightToDay[0], CFG.environment.nightToDay[1]) * CFG.environment.dayIntensity;
    const envWeight = theme === "light" || studioOn || inspectorOn ? 1 : narrativeDay;
    if (envWeight > 0.02) void ensureDayEnvironment();
    updateEnv(envWeight);
    const day = envWeight;
    const light = theme === "light" || studioOn || inspectorOn;
    // 参考图里冲刺时车身反而更亮：速度越高，暖色轮廓光与主光一起加码
    const speedLight = clamp(speed / CFG.speed.maxSpeed, 0, 1) ** 2;
    // 参考视频里高速时车身是明亮的木瓜色（实测车身核心色 ≈ 224,155,72、亮度 0.88），
    // 因此冲刺段主光加码、暖色轮廓光收着打 —— 之前橙色轮廓光太强，车被染红（实测 187,90,58）
    keyLight.intensity = (light ? 1.1 : 0.92) + day * 0.42 + speedLight * 0.72;
    // 暖色轮廓光收一档：它给白漆打出的镜面高光最亮，叠上泛光就是车身上那团毛茸茸的大光晕。
    // 主光相应加一点，整车亮度基本不变，只是高光不再聚成一块
    rimLight.intensity = (light ? 0.6 : 0.58) + day * 0.26 + seg(p, 0.42, 0.5) * 0.14 + speedLight * 0.12;
    fillLight.intensity = 0.36 + day * 0.24 + speedLight * 0.52;
    inspectorViewLight.intensity = inspectorOn ? 1.15 : 0;
    inspectorUnderLight.intensity = inspectorOn ? 0.42 : 0;

    // 相机
    camAt(p);
    // 拖拽环视：角度直接跟手，松手后带着惯性继续转，可以无限圈 360° 环视
    if (!dragging) {
      // 松手后的惯性：速度按帧衰减，且俯仰每帧都夹在范围内（之前漏夹会把镜头甩飞）
      const yawStep = coastStep(userYawVel, dt);
      const pitchStep = coastStep(userPitchVel, dt);
      userYaw += yawStep.distance;
      userYawVel = Math.abs(yawStep.velocity) < 0.05 ? 0 : yawStep.velocity;
      const [pitchMin, pitchMax] = modelCameraOn() ? [-Math.PI, Math.PI] : [-0.55, 0.95];
      userPitch = clamp(userPitch + pitchStep.distance, pitchMin, pitchMax);
      userPitchVel = Math.abs(pitchStep.velocity) < 0.0005 ? 0 : pitchStep.velocity;
    }
    if (freeCamera) zoomTarget = Math.min(zoomTarget, zoomLimit());
    zoom += (zoomTarget - zoom) * (1 - Math.exp(-dt * 10));
    // 360° 环视：自动绕车旋转（松开后平滑回到叙事机位）
    if (orbitOn && racingAmt < 0.01) {
      orbitYaw += dt * (CFG.ui?.orbitSpeed ?? 0.55);
    } else if (!orbitOn && orbitYaw !== 0) {
      orbitYaw *= Math.pow(0.02, dt);
      if (Math.abs(orbitYaw) < 0.002) orbitYaw = 0;
    }
    // 冲刺时镜头顺隧道方向跟随；竖屏收小桌面的斜后方夹角，
    // 避免透视让车尾贴左墙、车头跨向右侧车道。
    const azBase = camState.az + userYaw + (orbitYaw * 180) / Math.PI;
    // 中速先转到正后方，再落到偏后 3/4；停下时保留用户原先拖拽的姿态。
    const tunnelRefAspect = CFG.speed.tunnel?.referenceAspect ?? CFG.camera.fitMinAspect;
    const portraitFraming = clamp((tunnelRefAspect - camera.aspect) / Math.max(0.01, tunnelRefAspect - 0.75), 0, 1);
    const chaseAngle = 180 + (CFG.speed.chaseAzimuth - 180) * (1 - portraitFraming * 0.84);
    const cameraEase = 1 - Math.exp(-dt * 4.5);
    classicCameraBlend += ((driveCamera === "classic" ? 1 : 0) - classicCameraBlend) * cameraEase;
    topCameraBlend += ((driveCamera === "top" ? 1 : 0) - topCameraBlend) * cameraEase;
    const targetAz = driveCamera === "left" ? 105 : driveCamera === "right" ? 255
      : driveCamera === "classic" ? THREE.MathUtils.lerp(180, chaseAngle, seg(sp, 0.5, 0.94)) : 180;
    const driveAzDelta = (((targetAz - driveAzimuth) % 360 + 540) % 360) - 180;
    driveAzimuth += driveAzDelta * cameraEase;
    const chaseAz = driveAzimuth;
    const azDelta = (((chaseAz - azBase) % 360 + 540) % 360) - 180;
    const az = ((azBase + azDelta * racingAmt) * Math.PI) / 180;
    // 镜头角速度（弧度/秒）→ 倒影淡出系数：1.6 rad/s（约 92°/秒）视为最快。
    // 注意：鼠标事件是一阵一阵来的，逐帧量出来的角速度快慢交替，直接喂给系数的话
    // 倒影会跟着一明一暗（连续旋转时看起来就是频闪）。所以先对「角速度」本身做低通，
    // 再算系数，并且整体淡出幅度收一半 —— 慢速旋转完全不淡出，快速旋转也只是略微收一点。
    if (Number.isFinite(lastAzRad) && dt > 0) {
      const azSpeed = Math.abs(az - lastAzRad) / dt;
      azSpeedSmooth += (azSpeed - azSpeedSmooth) * clamp(dt * 3.2, 0, 1);
      const target = clamp((azSpeedSmooth - 0.35) / 1.35, 0, 1);
      motionFade += (target - motionFade) * clamp(dt * 3.5, 0, 1);
    }
    lastAzRad = az;
    const follow = carTravel;
    // 冲刺时机位整体右移（镜头与注视点同向平移，视线方向不变）：车因此落在画面左侧、
    // 光条汇聚点在其右 —— 参考视频就是这个构图，之前车正好压在汇聚点上，左右关系是反的
    const chaseLat = (CFG.speed.chaseLateral ?? 0) * racingAmt * classicCameraBlend;
    // 竖屏 / 窄屏时水平视野会变窄，这里按宽高比把相机拉远、视角放宽，保证整车进画面
    const fitAspect = CFG.camera.fitMinAspect;
    const fit = camera.aspect < fitAspect ? clamp(fitAspect / camera.aspect, 1, CFG.camera.fitMaxPullback) : 1;
    const chase = CFG.speed.chaseCamera;
    // 跟随镜头需要明显靠近车尾；原镜头完整保留 preset 机位。
    const radiusTarget = driveCamera === "classic" ? 1 : driveCamera === "top" ? 0.9
      : driveCamera === "follow" ? 0.66 : 0.82;
    const heightTarget = driveCamera === "classic" ? 1 : driveCamera === "top" ? 1.3
      : driveCamera === "follow" ? 0.78 : 0.9;
    driveRadiusScale += (radiusTarget - driveRadiusScale) * cameraEase;
    driveHeightScale += (heightTarget - driveHeightScale) * cameraEase;
    const driveRadius = chase.radius * driveRadiusScale;
    const driveHeight = chase.height * driveHeightScale;
    const fitRadius = Math.pow(fit, 0.8);
    // 原片的完整圆盘外径约为车身投影 1.6 倍；当前首页近景若沿用同一镜头会把外环切出画面。
    // 选择视频圆盘时平滑拉远 34%，冲刺或进入自由 / 模型镜头时自然退回原机位。
    const trackFrameTarget = discStyle === "track" && !freeCamera && !inspectorOn ? 1 - racingAmt : 0;
    trackDiscFraming += (trackFrameTarget - trackDiscFraming) * (1 - Math.exp(-dt * 5));
    const trackPullback = 1 + trackDiscFraming * 0.34;
    const baseRadius = THREE.MathUtils.lerp(camState.r, driveRadius, racingAmt) * fitRadius * trackPullback;
    const r = THREE.MathUtils.lerp(camState.r * zoom, driveRadius, racingAmt) * fitRadius * trackPullback;
    const h = THREE.MathUtils.lerp(camState.h, driveHeight, racingAmt);
    const targetY = THREE.MathUtils.lerp(camState.ty, chase.targetY, racingAmt) - trackDiscFraming * 0.45;
    // 关键帧给的是高度，换成仰角后才能和用户的上下拖拽相加；
    // 最终仰角夹在 3° 到 66° 之间：既能贴地看侧面，也不会穿到地面下或翻过头顶。
    // 缩放必须沿当前相机 → 轨道焦点的射线直线推进。旧实现用缩放后的 r 重算角度，
    // 越靠近俯仰越低，从车头/车尾进入时会明显走弧线；基准角只由未缩放机位决定。
    const baseElev = Math.atan2(Math.max(0.2, h) - targetY, baseRadius);
    // 模型展示允许相机越过地平线进入车底；叙事模式仍锁在地面以上，避免穿过隧道路面。
    if (modelCameraOn()) {
      // 边界约束的是实际仰角，而非叠在初始机位上的用户偏移。
      const limitedPitch = clamp(baseElev + userPitch, -1.56, 1.56) - baseElev;
      if (limitedPitch !== userPitch) { userPitch = limitedPitch; userPitchVel = 0; }
    }
    const elev = clamp(THREE.MathUtils.lerp(baseElev, 1.12, topCameraBlend * racingAmt) + userPitch * (1 - racingAmt), modelCameraOn() ? -1.56 : 0.05, modelCameraOn() ? 1.56 : 1.15);
    viewAzimuth = (THREE.MathUtils.radToDeg(az) % 360 + 360) % 360;
    viewElevation = THREE.MathUtils.radToDeg(elev);
    viewDistance = r;
    const horizontal = Math.cos(elev) * r;
    camPos.set(Math.sin(az) * horizontal + chaseLat, targetY + Math.sin(elev) * r, Math.cos(az) * horizontal + follow);
    lookAt.set(camState.tx * (1 - racingAmt) + chaseLat, targetY, camState.tz * (1 - racingAmt) + follow);
    camState.fovEff = THREE.MathUtils.lerp(camState.fov, chase.fov, racingAmt) * Math.pow(fit, 0.45);

    focusOffset.lerp(focusTarget, 1 - Math.exp(-dt * 10));
    if (freeCamera) {
      carHalfC.copy(focusOffset).multiplyScalar(1 - racingAmt);
      camPos.add(carHalfC); lookAt.add(carHalfC);
    }

    // fbm 晃动：三个轴各自随机错开频率，高速才明显
    const shakeAmp = reduced ? 0 : sp * sp * CFG.camera.shakeAmount * 0.16;
    shakeTarget.set(
      fbm2(elapsed * 0.5 + SHAKE_SEED[0], 3.1) * shakeAmp,
      fbm2(elapsed * 0.5 + SHAKE_SEED[1], 7.7) * shakeAmp * 0.8,
      fbm2(elapsed * 0.5 + SHAKE_SEED[2], 11.3) * shakeAmp * 0.6
    );
    shakeOffset.lerp(shakeTarget, clamp(dt * CFG.camera.shakeSmoothing, 0, 1));
    camera.position.copy(camPos).add(shakeOffset);
    camera.lookAt(lookAt);
    // 超近距离要随镜头距离收近裁剪面，否则固定 0.1 会在进入座舱前切掉方向盘和内饰。
    // 拉远时恢复较大的 near，保持 400 倍远景下的深度精度。
    const desiredNear = modelCameraOn() ? clamp(r * 0.003, 0.0015, 0.08) : 0.1;
    const desiredFar = modelCameraOn() ? Math.max(5000, r * 2 + CFG.model.length * 2) : 400;
    if (Math.abs(camera.near - desiredNear) > 0.0001 || camera.far !== desiredFar) {
      camera.near = desiredNear;
      camera.far = desiredFar;
      camera.updateProjectionMatrix();
    }
    inspectorViewLight.position.copy(camera.position);
    if (Math.abs(camera.fov - camState.fovEff) > 0.02) {
      camera.fov += (camState.fovEff - camera.fov) * clamp(dt * 3, 0, 1);
      camera.updateProjectionMatrix();
    }

    // 车：轻微下沉、轮胎自转；位移与镜头使用同帧 carTravel。
    // 车道保持：横向偏移与车头偏角每帧平滑收回隧道中心线，车不会越跑越偏
    if (laneKeepOn) {
      const back = clamp(dt * laneKeepStrength, 0, 1);
      carLateral += (0 - carLateral) * back;
      carHeadingOffset += (0 - carHeadingOffset) * back;
    }
    carRoot.position.x = carLateral;
    carRoot.position.z = carTravel;
    carRoot.position.y = -sp * 0.012;
    carRoot.rotation.z = -sp * 0.014;
    // 车头沿隧道方向，只保留车道保持的残余修正量。
    carRoot.rotation.y = carHeadingOffset;
    // 轮胎跟着「当前车速」转：静止浏览时车速是 0 所以不转；
    // 松手后画面会看到轮胎继续带着转、随车速一起慢下来才停（参考视频就是这样）。
    wheelBlur.value = seg(sp, 0.15, 0.8) * 2.8;
    const wheelTravel = sp * CFG.speed.topKmh / 3.6 * dt; // v = ωr，显示车速与实际轮周速度同源。
    contact.position.z = carTravel;   // 接触阴影跟着车走，不然车会像浮在空中
    wheelPivots.forEach((parts) =>
      parts.forEach((w) => {
        w.angle = (w.angle + w.direction * wheelTravel / Math.max(0.05, w.radius)) % (Math.PI * 2);
        w.rot.makeRotationAxis(spinAxis, w.angle);
        w.mesh.matrix.copy(w.t1).multiply(w.rot).multiply(w.t2);
        w.mesh.matrixWorldNeedsUpdate = true;
      })
    );
    bodyMaterials.forEach((m) => {
      m.envMapIntensity = CFG.model.envMapIntensity * (1 - sp * 0.096);
    });
    carLights.forEach((item) => {
      const on = item.mode === "always" ? 1 : racingAmt;
      const flicker = item.mode === "race" ? 0.92 + Math.sin(elapsed * 9 + item.sprite.position.z) * 0.08 : 1;
      (item.sprite.material as THREE.SpriteMaterial).opacity = on * flicker;
      item.light.intensity = on * item.intensity * flicker;
    });

    // 地面 / 隧道 / 流光
    const sps = reduced ? 0 : sp;
    floorUniforms.uTime.value = elapsed;
    floorUniforms.uSpeed.value = sps;
    floorUniforms.uFlow.value = sps * sps * (CFG.speed.floorFlow ?? 1);
    // 冲刺（隧道里）没有倒影：反射强度随速度衰减到 0，地面变成一块暗面。
    // 浅色/影棚下反射不再打折（原来 0.6 倍 + 与底色五五开，车身倒影会比车身暗一大截、颜色也对不上）
    floorUniforms.uReflectIntensity.value = wireframeMode === "native"
      ? (light ? 0.72 : CFG.ground.reflectIntensity) * (1 - seg(sps, 0.12, 0.55)) * (1 - motionFade * 0.45)
      : 0;
    // 浅色/影棚：反射占比给足，车身与倒影同色；法线扰动仍压低，避免亮背景经扰动出现麻点
    floorUniforms.uMixBase.value = light ? 0.62 : 0.46;
    floorUniforms.uMixFres.value = light ? 0.5 : 1.05;
    floorUniforms.uNormalAmount.value = light ? 0.07 : 0.1;
    floorUniforms.uMipBias.value = light ? 1.5 : 1.1;
    // 天际线接色：浅色背景（#dfe3e8 一带）与夜间背景（近黑）各自接自己的底色
    floorUniforms.uHorizon.value.set(light ? 0xe7ecf2 : 0x090a0c);
    floorUniforms.uHorizonMix.value = light ? 1 : 0.9;
    floorUniforms.uHorizonPower.value = light ? 8 : 3;
    flowUniforms.uFlowTime.value = elapsed;
    flowUniforms.uFlowStrength.value = sps * sps * CFG.speed.flowStrength;
    tunnelUniforms.uTime.value = roadTravel / CFG.speed.maxSpeed;
    tunnelUniforms.uSpeed.value = reduced ? 0 : speed;
    tunnelUniforms.uOpacity.value = sps ** 3 * 0.28;
    tunnel2Uniforms.uTime.value = roadTravel / CFG.speed.maxSpeed * 0.75;
    tunnel2Uniforms.uSpeed.value = reduced ? 0 : speed * 0.8;
    tunnel2Uniforms.uOpacity.value = sps ** 3 * 0.12;
    if (shardUniformsRef && shardMesh) {
      shardUniformsRef.uTime.value = elapsed;
      shardUniformsRef.uSpeed.value = reduced ? 0 : speed;
      const on = CFG.speed.shards ? CFG.speed.shards.opacity : 0;
      shardUniformsRef.uOpacity.value = sps * on;
      shardMesh.visible = sps > 0.05 && !off.has("shards");
    }
    if (ringUniformsRef) {
      ringUniformsRef.uTime.value = elapsed;
      ringUniformsRef.uSpeed.value = sps;
      ringUniformsRef.uSweep.value = elapsed * (0.05 + sps * 0.22);
      // 行驶时退出展示台刻度环，避免看起来带着大圆盘前进。
      const ringFade = 1 - seg(sps, 0.04, 0.28);
      const discReady = !mobilePresentation || mountedCar !== null;
      // 这是展示台的刻度参照，随车辆跟随机位保留在车下，不遗留在起步点。
      chronoDisc.position.z = carTravel;
      trackDisc.position.z = carTravel;
      chronoDisc.visible = discReady && discStyle === "chrono";
      trackDisc.visible = discReady && discStyle === "track";
      if (ringUniformsRef.uFade) ringUniformsRef.uFade.value = ringFade;
      ringOutlineMats.forEach((m) => {
        m.opacity = (m.userData.baseOpacity as number) * ringFade * (mobilePresentation ? (m.userData.mobileOpacity ?? 1) : 1);
        m.visible = ringFade > 0.02;
      });
    }
    (pool.material as THREE.MeshBasicMaterial).opacity = mobilePresentation ? 0 : CFG.ground.pool * (1 - seg(sps, 0.08, 0.5));
    // 浅色/影棚：亮底上黑影更刺眼，接触阴影再压一档
    (contact.material as THREE.MeshBasicMaterial).opacity = mobilePresentation && !mountedCar ? 0 : light ? 0.45 : 0.7;
    if (ring) ring.visible = !mobilePresentation && (p > 0.12 || sps > 0.05);
    const tunnelOn = !!CFG.speed.tunnel && speed > 0.6 && !off.has("tunnel");
    if (tunnel) tunnel.visible = tunnelOn;
    if (accent) accent.visible = tunnelOn;

    // 后期遮挡用本帧矩阵；屏幕 UV 的 Y 向上，与 NDC 一致。
    carRoot.updateMatrixWorld(true);
    camera.updateMatrixWorld(true);
    // 主光条：只在有速度时出现（滚动浏览时表是 0，不会亮）
    if (sps > 0.04) {
      // 车的屏幕包围盒：把车模包围盒的 8 个角投影到屏幕上再取包围矩形，
      // 长轴不再写死（车头方向由车道保持量出来），车体遮挡与车身姿态始终对得上
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      let cornersOk = true;
      for (let i = 0; i < 8; i += 1) {
        carHalfA.set(
          i & 1 ? carLocalBox.max.x : carLocalBox.min.x,
          i & 2 ? carLocalBox.max.y : carLocalBox.min.y,
          i & 4 ? carLocalBox.max.z : carLocalBox.min.z
        ).applyMatrix4(carRoot.matrixWorld).project(camera);
        if (!Number.isFinite(carHalfA.x) || !Number.isFinite(carHalfA.y)) { cornersOk = false; break; }
        minX = Math.min(minX, carHalfA.x); maxX = Math.max(maxX, carHalfA.x);
        minY = Math.min(minY, carHalfA.y); maxY = Math.max(maxY, carHalfA.y);
      }
      if (cornersOk) {
        const cx = (minX + maxX) / 4 + 0.5;
        const cy = (minY + maxY) / 4 + 0.5;
        const hx = (maxX - minX) / 4 + 0.012;
        const hy = (maxY - minY) / 4 + 0.02;
        (lightLinesPass.uniforms.uCarBox.value as THREE.Vector4).set(cx, cy, hx, hy);
      }
      // 汇聚点 = 隧道轴（+z）在屏幕上的真实消失点：光条、车与地面刻度环的透视因此一致，
      // 不再固定在画面中心（镜头绕到车侧时，固定中心会让光条和车各说各话）
      if (CFG.speed.tunnel?.vanishFollow !== false) {
        carHalfB.set(0, 0.4, 400).project(camera);
        if (Number.isFinite(carHalfB.x) && Math.abs(carHalfB.x) < 6 && Math.abs(carHalfB.y) < 6) {
          (lightLinesPass.uniforms.uCenter.value as THREE.Vector2).set(
            clamp(carHalfB.x * 0.5 + 0.5, 0.02, 0.98),
            clamp(carHalfB.y * 0.5 + 0.5, 0.02, 0.98)
          );
        }
      }
    }
    lightLinesPass.uniforms.uTime.value = roadTravel / CFG.speed.maxSpeed;
    // 正后方跟随时，车与隧道轴都压在画面中线；窄屏不沿用原镜头的偏右消失点。
    const tunnelFrame = lightLinesPass.uniforms.uTunnelFrame.value as THREE.Vector2;
    tunnelFrame.x = THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(CFG.speed.tunnel?.vanish?.[0] ?? 0.5, 0.64, portraitFraming),
      0.5,
      racingAmt * (1 - classicCameraBlend) * (1 - topCameraBlend)
    );
    lightLinesPass.uniforms.uSpeed.value = reduced ? 0 : speed;
    // 中速只有淡线，高速才铺满；松手后比镜头回位更早退去。
    lightLinesPass.uniforms.uStrength.value = seg(sps, 0.14, 0.9) ** 2;
    lightLinesPass.uniforms.uLightMode.value = light ? 1 : 0;
    lightLinesPass.enabled = !!TUNNEL && sps > 0.04 && !off.has("tunnel");   // 静止段整趟跳过，省一层全屏后期

    // 后期：拖影只在高速时才有意义，静止段直接关掉这一整趟全屏后期
    smearPass.uniforms.uChroma.value = sps * CFG.post.smearChroma;
    smearPass.uniforms.uTime.value = elapsed;
    const smear = sps * sps * CFG.post.smearStrength;
    smearPass.uniforms.uStrength.value = smear;
    smearPass.enabled = smear > 0.004 && !off.has("smear");
    bloom.strength = (CFG.post.bloomStrength + sps * CFG.post.bloomSpeedBoost) * (light ? 0.6 : 1);
    bloom.radius = CFG.post.bloomRadius + sps * 0.14;
    scene.background = light ? backdropLight : backdrop;
    scene.backgroundIntensity = light ? 1 : 0.85 + narrativeDay * 0.35;
    // 浅色/影棚：地面跟着背景走亮灰（冲刺时反射会关掉，地面若仍是深色就会和背景断开、底部深色字也看不清）
    floorUniforms.uColor.value.set(light ? 0xd5d9de : 0x0b0c0e);

    // HUD
    // HUD 写入都做变更判断：每帧几十次 DOM 写会让浏览器反复重排（滚动发涩的另一个来源）
    const kmh = Math.round(clamp(speed / CFG.speed.maxSpeed, 0, 1.02) * CFG.speed.topKmh);
    const kmhText = String(kmh).padStart(3, "0");
    if (hud.kmh && hud.kmh.textContent !== kmhText) hud.kmh.textContent = kmhText;
    const gearText = speed < 0.4 ? "N" : String(clamp(1 + Math.floor(sp * 8.9), 1, 8));
    if (hud.gear && hud.gear.textContent !== gearText) hud.gear.textContent = gearText;
    const lit = speed < 0.4 ? 0 : Math.round(clamp(3 + sp * (hud.rpmTicks.length - 3) + fbm2(elapsed * 6, 2) * 1.2, 0, hud.rpmTicks.length));
    if (lit !== lastLit) {
      const from = Math.min(lit, lastLit);
      const to = Math.max(lit, lastLit);
      for (let i = from; i < to; i += 1) hud.rpmTicks[i]?.classList.toggle("on", i < lit);
      lastLit = lit;
    }
    const ers = clamp(62 + sp * 30 + Math.sin(elapsed * 2.4) * 6, 0, 100);
    const ersText = `${ers.toFixed(0)}%`;
    if (hud.ersBar) hud.ersBar.style.width = ersText;
    if (hud.ersText && hud.ersText.textContent !== ersText) hud.ersText.textContent = ersText;
    const foot = sps > 0.25 ? CFG.ui.liveDeploying : CFG.ui.liveData;
    if (hud.teleFoot && hud.teleFoot.textContent !== foot) hud.teleFoot.textContent = foot;
    let phase = 0;
    for (let i = CFG.phases.length - 1; i >= 0; i -= 1) {
      if (p >= CFG.phases[i].at) {
        phase = i;
        break;
      }
    }
    if (phase !== lastPhase) {
      lastPhase = phase;
      options.onPhase?.(phase);
    }
    if (hud.mark && (Math.abs(p - lastMarkP) > 0.002 || Math.abs(racingAmt - lastMarkRace) > 0.002)) {
      lastMarkP = p;
      lastMarkRace = racingAmt;
      hud.stage.style.setProperty("--sc-tunnel", String(racingAmt));
      hud.mark.style.transform = `translate(-50%, -50%) scale(${1 + p * 0.1 + sps * 0.04})`;
      hud.mark.style.opacity = String(0.75 - racingAmt * 0.42);
    }
    if (racing !== lastRaceClass) {
      lastRaceClass = racing;
      hud.raceBtn?.classList.toggle("on", racing);
    }

    // 部件标注：把 3D 锚点投影到屏幕
    hud.labels.forEach((part, i) => {
      const def = CFG.parts[i];
      const vis = seg(p, def.from, def.from + 0.05) * (1 - seg(p, 0.46, 0.52));
      if (vis < 0.02) {
        part.el.style.opacity = "0";
        return;
      }
      projected.set(def.pos[0], def.pos[1], def.pos[2]).project(camera);
      if (projected.z > 1) {
        part.el.style.opacity = "0";
        return;
      }
      const x = (projected.x * 0.5 + 0.5) * canvas.clientWidth;
      const y = (-projected.y * 0.5 + 0.5) * canvas.clientHeight;
      const prev = labelPos[i];
      if (!prev || Math.abs(prev.x - x) > 0.5 || Math.abs(prev.y - y) > 0.5) {
        labelPos[i] = { x, y };
        part.el.style.left = `${x.toFixed(1)}px`;
        part.el.style.top = `${y.toFixed(1)}px`;
      }
      if (!prev || prev.opacity !== vis) {
        labelPos[i] = { x: labelPos[i]?.x ?? x, y: labelPos[i]?.y ?? y, opacity: vis };
        part.el.style.opacity = String(clamp(vis, 0, 1));
      }
    });

    // 导入工作台部位点：锚点保存在车身包围盒的归一化坐标里，先转到当前车身世界坐标，
    // 再投影到画布，因此环视、缩放、平移时圆点会一直贴在对应部位上。
    if (inspectorOn && !carLocalBox.isEmpty()) {
      hud.inspectMarkers?.forEach((marker) => {
        carHalfD.set(
          THREE.MathUtils.lerp(carLocalBox.min.x, carLocalBox.max.x, marker.pos[0]),
          THREE.MathUtils.lerp(carLocalBox.min.y, carLocalBox.max.y, marker.pos[1]),
          THREE.MathUtils.lerp(carLocalBox.min.z, carLocalBox.max.z, marker.pos[2])
        );
        carRoot.localToWorld(carHalfD);
        carHalfD.project(camera);
        const visible = carHalfD.z >= -1 && carHalfD.z <= 1;
        marker.el.style.opacity = visible ? "1" : "0";
        if (visible) {
          marker.el.style.left = `${((carHalfD.x * 0.5 + 0.5) * canvas.clientWidth).toFixed(1)}px`;
          marker.el.style.top = `${((-carHalfD.y * 0.5 + 0.5) * canvas.clientHeight).toFixed(1)}px`;
        }
      });
    } else hud.inspectMarkers?.forEach(marker => { marker.el.style.opacity = "0"; });

    // 交互时只降低倒影采样尺寸，仍逐帧更新；主体渲染分辨率不变。
    if (dragging || touches.size > 0 || Math.abs(zoomTarget - zoom) > 0.01 || Math.abs(userYawVel) > 0.5 || Math.abs(userPitchVel) > 0.005) interactionUntil = elapsed + 0.25;
    const wantsLite = elapsed < interactionUntil;
    if (wantsLite !== reflectionLite && elapsed - reflectResizedAt > 0.25) {
      reflectionLite = wantsLite; reflectResizedAt = elapsed;
      const [rw, rh] = reflectSizeFor(camera.aspect, reflectionLite ? Math.min(512, reflectHeight * 0.5) : reflectHeight);
      reflectRT.setSize(rw, rh); reflectDirty = true;
    }
    // 相机或车在动 → 反射必须逐帧更新（否则转动时倒影会抖）；完全静止时复用上一张。
    if (!inspectorOn && floorUniforms.uReflectIntensity.value > 0.001 && reflectNeedsUpdate()) {
      reflectionRenders += 1;
      updateReflection();
      reflectCamLast.copy(camera.position);
      reflectTravelLast = carTravel;
      reflectDirty = false;
    }
    lightLinesPass.uniforms.tSceneDepth.value = composer.readBuffer.depthTexture;
    (lightLinesPass.uniforms.uWorldFromClip.value as THREE.Matrix4).multiplyMatrices(camera.matrixWorld, camera.projectionMatrixInverse);
    if (inspectorOn) {
      // 模型展示跟随首页深浅主题；直接渲染保留纯线框颜色，不经过后期调色。
      const background = scene.background;
      const hidden = scene.children.filter(child => child !== carRoot && !(child as THREE.Light).isLight && child.visible);
      hidden.forEach(child => { child.visible = false; });
      scene.background = theme === "light" || studioOn ? inspectorBackgroundLight : inspectorBackgroundDark;
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
      scene.background = background;
      hidden.forEach(child => { child.visible = true; });
    } else {
      composer.render();
    }
  }

  let lastResizeKey = "";
  function resize(force = false) {
    let w = canvas.clientWidth || hud.stage.clientWidth || window.innerWidth;
    let h = canvas.clientHeight || hud.stage.clientHeight || window.innerHeight;
    // 关键防线：显示器休眠/唤醒、窗口最小化还原时，浏览器可能在一帧里给出 0 或 NaN 的尺寸，
    // 一旦让它写进 camera.aspect，投影矩阵就会变成 Infinity/NaN，
    // 再经 HalfFloat 后期放大成一整屏白（GPU 把 NaN 写成 255）。这里直接拒绝异常尺寸。
    if (!Number.isFinite(w) || !Number.isFinite(h) || w < 2 || h < 2) {
      logEvent(`resize 拒绝异常尺寸 ${w}x${h}`);
      return;
    }
    w = Math.round(w);
    h = Math.round(h);
    wantedScale = desiredPixelRatio();
    // 尺寸与倍率都没变就别重建渲染目标（composer / 泛光一共要重建二十来个，每次都是明显卡顿）
    const key = `${w}x${h}@${renderScale.toFixed(2)}:${wantedScale.toFixed(2)}`;
    if (!force && key === lastResizeKey) return;
    lastResizeKey = key;
    budgetedScale = budgetRatio(w, h, wantedScale);
    reflectDirty = true;
    measureScroll();
    if (originalResolution() || renderScale > budgetedScale) {
      renderScale = budgetedScale;
      renderer.setPixelRatio(renderScale);
      composer.setPixelRatio(renderScale);
    }
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    // 泛光只是低频辉光：按设备像素的一半渲染，并且整块封顶到 1280×720 以内
    // （参考项目用 postprocessing 的 mipmapBlur，只有一条 mip 链；这里用固定上限达到同样的省显存效果）
    const pr = renderer.getPixelRatio();
    const bw = w * pr * 0.5;
    const bh = h * pr * 0.5;
    const cap = Math.min(1, 1280 / Math.max(1, bw), 720 / Math.max(1, bh));
    bloom.setSize(Math.max(64, Math.round(bw * cap)), Math.max(64, Math.round(bh * cap)));
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    (lightLinesPass.uniforms.uAspect.value as number) = CFG.speed.tunnel?.referenceAspect ?? w / h;
    const referenceAspect = CFG.speed.tunnel?.referenceAspect ?? w / h;
    const portraitBlend = clamp((referenceAspect - w / h) / Math.max(0.01, referenceAspect - 0.75), 0, 1);
    (lightLinesPass.uniforms.uTunnelFrame.value as THREE.Vector2).set(
      THREE.MathUtils.lerp(CFG.speed.tunnel?.vanish?.[0] ?? 0.5, 0.64, portraitBlend),
      THREE.MathUtils.lerp(1, 1.12, portraitBlend)
    );
    // 反射贴图按画面宽高比同步（换窗口比例时倒影不会又被拉糊）
    const [reflectW, reflectH] = reflectSizeFor(w / h, reflectionLite ? Math.min(512, reflectHeight * 0.5) : reflectHeight);
    if (reflectRT.width !== reflectW || reflectRT.height !== reflectH) reflectRT.setSize(reflectW, reflectH);
    invalidateInspector();
  }

  /**
   * 自适应渲染倍率：先按设备像素比开画，随后按实测帧耗时微调。
   * 帧耗时偏高就降倍率（最低 0.75），长时间流畅再慢慢升回去（最高 1.6），
   * 这样高分屏与集成显卡都能保住流畅度。
   */
  let wantedScale = desiredPixelRatio();
  let renderScale = originalResolution() ? budgetRatio(canvas.clientWidth || window.innerWidth, canvas.clientHeight || window.innerHeight, wantedScale) : Math.min(wantedScale, 1.5);
  // 画质下限：低分屏绝不低于 1.0（原生），高分屏最低按 1.2 倍的 CSS 像素渲染，
  // 这样自动降级也不会出现「糊」的情况。
  const minScale = Math.max(0.95, Math.min(1, 1.9 / Math.max(1, window.devicePixelRatio || 1)));
  let frameCost = 0;
  let frameSamples = 0;
  let lastAdapt = performance.now();
  let qualityChanges = 0;
  let budgetedScale = 1;
  // 调参用：地址栏加 ?mclhud=1 会在右下角显示实测帧耗时与当前渲染倍率
  const qualityHud =
    typeof location !== "undefined" && location.search.includes("mclhud")
      ? (() => {
          const el = document.createElement("div");
          el.style.cssText =
            "position:absolute;right:10px;bottom:10px;z-index:9;font:10px/1.4 ui-monospace,monospace;color:#8a8a90;background:rgba(0,0,0,.5);padding:4px 8px;border-radius:4px;pointer-events:none;text-align:right";
          hud.stage.appendChild(el);
          return el;
        })()
      : null;
  renderer.setPixelRatio(renderScale);
  composer.setPixelRatio(renderScale);

  function adaptQuality(frameMs: number) {
    // 原画是用户明确选择清晰度：锁住预算内的原生分辨率，不因帧耗时悄悄降采样。
    if (originalResolution()) { frameCost = 0; frameSamples = 0; return; }
    frameCost += frameMs;
    frameSamples += 1;
    if (frameSamples < 20) return;
    const now = performance.now();
    if (now - lastAdapt < 700) return;
    // 交互期间（拖拽 / 环视 / 冲刺）不调画质：这段时间帧耗被交互本身抬高，
    // 一降就把画面变糊发灰，而且停下来还要等很久才升回去
    const interacting =
      dragging || orbitOn || racing || Math.abs(userYawVel) > 1e-4 || Math.abs(userPitchVel) > 1e-5;
    if (interacting) {
      frameCost = 0;
      frameSamples = 0;
      lastAdapt = now;
      return;
    }
    const avg = frameCost / frameSamples;
    frameCost = 0;
    frameSamples = 0;
    lastAdapt = now;
    if (qualityChanges > 6) return;
    // 只在明显掉帧时降、长时间很稳才升，避免来回抖动反复重建 RT（那也是显存压力来源）
    if (avg > 26 && renderScale > minScale) {
      renderScale = Math.max(minScale, renderScale - 0.15);
    } else if (avg > 20 && renderScale > minScale) {
      renderScale = Math.max(minScale, renderScale - 0.08);
    } else if (avg < 13 && renderScale < Math.min(wantedScale, budgetedScale)) {
      renderScale = Math.min(wantedScale, budgetedScale, renderScale + 0.1);
    } else {
      return;
    }
    qualityChanges += 1;
    if (qualityHud) {
      qualityHud.innerHTML = [
        `${avg.toFixed(1)} ms · ${renderScale.toFixed(2)}x`,
        `buffer ${canvas.width}×${canvas.height} · reflect ${reflectRT.width}×${reflectRT.height}`,
        `tex ${renderer.info.memory.textures} · geo ${renderer.info.memory.geometries}`
      ].join("<br>");
    }
    renderer.setPixelRatio(renderScale);
    composer.setPixelRatio(renderScale);
    // 反射贴图也跟着倍率走：帧耗时偏高时它同样是最贵的一项。
    // 高度按基准 × 画质倍率，宽度按画面宽高比推 —— 只改高度基准，倒影不会横向被拉糊。
    const base = CFG.ground.reflectionSize;
    reflectHeight = Math.round(clamp(base * (renderScale + 0.55), base * 0.8, base * 1.3));
    const [reflectW, reflectH] = reflectSizeFor(stageAspect(), reflectHeight);
    if (reflectRT.width !== reflectW || reflectRT.height !== reflectH) reflectRT.setSize(reflectW, reflectH);
    resize();
  }

  /** 滚动进度：用「滚动容器已经划过多少」来算，粘性舞台高度变化时自动正确 */
  /**
   * 滚动几何只在必须时测量；帧循环里只用 window.scrollY（读它不会触发布局），
   * 避免「每帧写 HUD → 每帧读布局」这种强制同步布局（那是滚动发涩的常见原因）。
   */
  let scrollOrigin = 0;
  let scrollTravel = 1;
  let mobileProgress = START_P;
  function mobileViewer() {
    return window.matchMedia("(max-width: 640px), (max-height: 500px) and (pointer: coarse)").matches;
  }
  /**
   * 用户是否已经自己滚动过。浏览器可能在挂载之后才把上次的滚动位置写回来（会话恢复、
   * 重新打开标签页、从别的页面回来），那条路径会把「刷新后的默认机位」换成当时那个机位。
   * 因此用户没自己滚动之前，进度一律按 0 处理 —— 这是组件侧「钉住滚动位置」之外的第二道防线。
   */
  let userScrolled = false;
  function measureScroll() {
    const el = hud.scroll;
    const stage = hud.stage;
    scrollOrigin = el.getBoundingClientRect().top + window.scrollY;
    scrollTravel = Math.max(1, el.offsetHeight - stage.offsetHeight);
  }
  function progress() {
    if (inspectorOn) return inspectorProgress;
    if (freeCamera) return 0;
    if (mobileViewer()) return mobileProgress;
    // 只守开场这三秒：这段时间足够覆盖浏览器的滚动恢复，也不会长期影响脚本化调试（直接 scrollTo 也能工作）。
    // 用户置顶过机位时「家」不是 0 而是置顶进度，所以开场就停在那里
    if (!userScrolled && elapsed < 3) return START_P;
    return clamp((window.scrollY - scrollOrigin) / scrollTravel, 0, 1);
  }

  /* ---------- 8) 交互：按住冲刺 / 拖拽环视 ---------- */
  // 用户一有滚动意图（滚轮 / 触摸 / 键盘 / 按下指针）就把进度控制权交出去
  const markUserScroll = () => {
    userScrolled = true;
  };
  const scrollIntentEvents: Array<keyof WindowEventMap> = ["wheel", "touchstart", "keydown", "pointerdown"];
  scrollIntentEvents.forEach((name) => window.addEventListener(name, markUserScroll, { passive: true }));
  cleanups.push(() => scrollIntentEvents.forEach((name) => window.removeEventListener(name, markUserScroll)));

  const press = (on: boolean) => {
    racing = on && !inspectorOn;
  };
  const onRaceDown = (e: Event) => {
    e.preventDefault();
    press(true);
  };
  const onPointerUp = (event: Event) => {
    // 第二根手指切换行驶镜头时，别把仍按住的起步键误当作松开。
    if ((event.target as Element | null)?.closest?.(".sc-drive-camera")) return;
    press(false);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.code === "Space" && !isTyping()) {
      e.preventDefault();
      press(true);
    }
    if (e.key === "z" && !isTyping() && !e.metaKey && !e.ctrlKey) setZoomMode(!zoomMode);
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.code === "Space") press(false);
  };
  const isTyping = () => {
    const el = document.activeElement;
    return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || (el as HTMLElement).isContentEditable);
  };
  hud.raceBtn?.addEventListener("pointerdown", onRaceDown);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onPointerUp);
  cleanups.push(() => {
    hud.raceBtn?.removeEventListener("pointerdown", onRaceDown);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerUp);
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", onPointerUp);
  });

  let dragging = false;
  let dragX = 0;
  let dragY = 0;
  let dragTime = 0;
  let dragPointer: number | null = null;
  let dragPan = false;
  let dragZoom = false;
  const touches = new Map<number, { x: number; y: number }>();
  let tapX = 0, tapY = 0, tapDownAt = 0, tapTravel = 0;
  let lastTapX = 0, lastTapY = 0;
  /** 当前手势是不是手指（触屏）：手指横滑转车、竖滑留给页面滚动，不做俯仰 */
  let dragByTouch = false;
  let lastTapAt = 0;
  let lastTouchFocusAt = -Infinity;
  /**
   * 用户置顶的机位（由组件通过 setHomePose 传进来）。
   * 双击复位要回到「用户的固定机位」，而不是引擎的中立角度 —— 以前这里一律归零，
   * 于是双击之后停在的不是用户置顶的那一帧（反馈：「回到一个非我们设置的固定机位」）。
   */
  let homePose: { p: number; yaw: number; pitch: number; zoom: number } | null = null;
  const resetView = () => {
    focusTarget.set(0, 0, 0);
    userYaw = inspectorOn ? homePose?.yaw ?? 0 : freeCamera ? 0 : homePose?.yaw ?? 0;
    userYawVel = 0;
    userPitch = inspectorOn ? homePose?.pitch ?? 0 : freeCamera ? 0 : homePose?.pitch ?? 0;
    userPitchVel = 0;
    zoomTarget = inspectorOn ? homePose?.zoom ?? 1 : freeCamera ? 1 : homePose?.zoom ?? 1;
    setZoomMode(false);
    // 置顶机位还包含「进度」：交给组件把滚动位置带回去，才真的回到那一帧
    if (!freeCamera) options.onResetView?.();
    invalidateInspector();
  };
  const focusAt = (x: number, y: number) => {
    if (!freeCamera) { resetView(); return; }
    if (racing || racingAmt > 0.05) return;
    const rect = canvas.getBoundingClientRect();
    focusPointer.set((x - rect.left) / rect.width * 2 - 1, 1 - (y - rect.top) / rect.height * 2);
    camera.updateMatrixWorld(); carRoot.updateMatrixWorld(true);
    focusRay.setFromCamera(focusPointer, camera);
    const hit = focusRay.intersectObject(carRoot, true).find(h => {
      for (let o: THREE.Object3D | null = h.object; o && o !== carRoot; o = o.parent) if (!o.visible) return false;
      return true;
    });
    if (!hit) {
      if (modelCameraOn()) applyZoom(1 / 0.65);
      return;
    }
    focusTarget.copy(hit.point).sub(lookAt).add(focusOffset);
    zoomTarget = modelCameraOn()
      ? clamp(zoom * hit.distance / Math.max(0.0001, camera.position.distanceTo(lookAt)) * 0.65, INSPECTOR_MIN_ZOOM, INSPECTOR_MAX_ZOOM)
      : Math.max(MIN_ZOOM, zoomTarget * 0.65);
    userYawVel = 0; userPitchVel = 0;
  };
  const inspectAt = (x: number, y: number, exact = false) => {
    if (!inspectorOn || !options.onInspectPart) return;
    const rect = canvas.getBoundingClientRect();
    focusPointer.set((x - rect.left) / rect.width * 2 - 1, 1 - (y - rect.top) / rect.height * 2);
    camera.updateMatrixWorld(); carRoot.updateMatrixWorld(true);
    focusRay.setFromCamera(focusPointer, camera);
    const hit = focusRay.intersectObject(carRoot, true).find(candidate => {
      for (let o: THREE.Object3D | null = candidate.object; o && o !== carRoot; o = o.parent) if (!o.visible) return false;
      return true;
    });
    if (!hit) return;
    const mesh = hit.object as THREE.Mesh;
    const source = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    options.onInspectPart({
      mesh: mesh.name || mesh.parent?.name || "未命名网格",
      materials: source.map(material => material.name || "未命名材质"),
      position: [hit.point.x, hit.point.y, hit.point.z]
    });
    const region = inspectRegionOf(mesh);
    wireframeView.focus(exact ? candidate => candidate === mesh : candidate => inspectRegionOf(candidate) === region);
    invalidateInspector();
  };
  const inspectRegionOf = (mesh: THREE.Mesh) => {
    const materials = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map(material => material?.name ?? "").join(" ");
    const name = `${mesh.name} ${materials}`.toLowerCase();
    if (/tyre|tire|wheel|rim/.test(name)) return "wheels";
    if (/wing|spoiler|aero|diffuser/.test(name)) return "aero";
    if (/seat|cockpit|steer|tach|pedal|dash/.test(name)) return "cockpit";
    return "body";
  };
  const panCamera = (dx: number, dy: number) => {
    const distance = Math.max(0.01, camera.position.distanceTo(lookAt));
    const worldPerPixel = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * distance /
      Math.max(1, canvas.clientHeight || 720);
    camera.updateMatrixWorld();
    carHalfA.setFromMatrixColumn(camera.matrixWorld, 0);
    carHalfB.setFromMatrixColumn(camera.matrixWorld, 1);
    focusTarget.addScaledVector(carHalfA, -dx * worldPerPixel).addScaledVector(carHalfB, dy * worldPerPixel);
    focusOffset.copy(focusTarget);
    userYawVel = 0; userPitchVel = 0;
  };
  const onCanvasDown = (e: PointerEvent) => {
    if (![0, 1, 2].includes(e.button) || (!freeCamera && e.button !== 0)) return;
    if (e.pointerType === "touch") {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size > 1) {
        dragging = false; dragPointer = null; lastTapAt = 0;
        userYawVel = 0; userPitchVel = 0; return;
      }
    }
    dragging = true; dragPointer = e.pointerId;
    dragByTouch = e.pointerType === "touch";
    dragPan = freeCamera && !dragByTouch && (e.shiftKey || e.button === 1 || e.button === 2);
    dragZoom = freeCamera && !dragByTouch && !dragPan && e.button === 0 && (e.ctrlKey || e.metaKey);
    dragX = tapX = e.clientX; dragY = tapY = e.clientY;
    dragTime = tapDownAt = performance.now(); tapTravel = 0;
    userYawVel = 0; userPitchVel = 0;
    canvas.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!dragging || e.pointerId !== dragPointer || touches.size > 1) return;
    const now = performance.now();
    const sampleDt = Math.max(0.001, Math.min(0.1, (now - dragTime) / 1000));
    dragTime = now;
    tapTravel = Math.max(tapTravel, Math.hypot(e.clientX - tapX, e.clientY - tapY));
    const dx = e.clientX - dragX;
    dragX = e.clientX;
    const dy = e.clientY - dragY;
    dragY = e.clientY;
    // 冲刺中不接收拖拽：否则镜头被转偏，车会跑出轨道、看起来在天上飞。
    // 基准点仍要跟着指针走，否则松开空格那一刻会一次结算掉整段位移，镜头瞬间被甩飞。
    if (racing) return;
    // Sketchfab 风格轨道相机：Shift / 中键 / 右键拖动平移轨道焦点。
    if (dragPan) {
      panCamera(dx, dy);
      return;
    }
    // Ctrl / ⌘ + 左键上下拖动沿视线 dolly，与滚轮共用同一距离范围。
    if (dragZoom) {
      applyZoom(Math.exp(dy * 0.008));
      userYawVel = 0; userPitchVel = 0;
      return;
    }
    // 手机上画布独占拖动：水平环视、垂直俯仰；桌面叙事仍可纵向滚动。
    const mobileDrag = dragByTouch && mobileViewer();
    const gain = dragByTouch ? (mobileDrag ? 0.24 : 0.42) : 0.3;
    userYaw -= dx * gain;
    userYawVel = clamp(-dx * gain / sampleDt, -180, 180);
    if (dragByTouch && !freeCamera && !mobileDrag) return;
    // 鼠标上下拖：向上拖 = 升高视角俯视，向下拖 = 降低视角平视/略微仰视
    const [pitchMin, pitchMax] = modelCameraOn() ? [-Math.PI, Math.PI] : [-0.55, 0.95];
    const pitchGain = mobileDrag ? 0.0025 : 0.0035;
    userPitch = clamp(userPitch + dy * pitchGain, pitchMin, pitchMax);
    userPitchVel = clamp(dy * pitchGain / sampleDt, -2, 2);
  };
  const onDragEnd = (e: PointerEvent) => {
    if (e.pointerId !== dragPointer) return;
    const now = performance.now();
    if (e.type === "pointercancel" || now - dragTime > 80) { userYawVel = 0; userPitchVel = 0; }
    if (dragByTouch && e.type === "pointerup" && touches.size === 1 && tapTravel < 8 && now - tapDownAt < 250) {
      inspectAt(e.clientX, e.clientY);
      if (now - lastTapAt < 320 && Math.hypot(e.clientX - lastTapX, e.clientY - lastTapY) < 24) {
        inspectAt(e.clientX, e.clientY, true);
        focusAt(e.clientX, e.clientY); lastTapAt = 0; lastTouchFocusAt = now;
      } else { lastTapAt = now; lastTapX = e.clientX; lastTapY = e.clientY; }
    } else {
      if (!dragByTouch && e.type === "pointerup" && tapTravel < 5 && now - tapDownAt < 300) inspectAt(e.clientX, e.clientY);
      lastTapAt = 0;
    }
    dragging = false; dragByTouch = false; dragPan = false; dragZoom = false; dragPointer = null;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  };
  const cancelInteraction = () => {
    dragging = false; dragPan = false; dragZoom = false; dragPointer = null; touches.clear();
    userYawVel = 0; userPitchVel = 0; lastTapAt = 0;
  };
  window.addEventListener("blur", cancelInteraction);
  cleanups.push(() => window.removeEventListener("blur", cancelInteraction));
  canvas.addEventListener("pointerdown", onCanvasDown);
  const stopContextMenu = (e: MouseEvent) => { if (freeCamera) e.preventDefault(); };
  canvas.addEventListener("contextmenu", stopContextMenu);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onDragEnd);
  // 浏览器接管滚动 / 捏合放大时会发 pointercancel，这里要结束拖拽状态，
  // 否则手指抬起后镜头还在跟着最后一段位移转
  window.addEventListener("pointercancel", onDragEnd);
  cleanups.push(() => {
    canvas.removeEventListener("pointerdown", onCanvasDown);
    canvas.removeEventListener("contextmenu", stopContextMenu);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onDragEnd);
    window.removeEventListener("pointercancel", onDragEnd);
  });

  // 缩放：⌘/Ctrl + 滚轮（触控板捏合同样走这里）、按钮、双击复位
  const applyZoom = (factor: number) => {
    if (!Number.isFinite(factor) || factor <= 0) return;
    if (modelCameraOn()) {
      // 查看器不在边界前减速：连续滚轮可以真正进入座舱，也能把整车缩成远处的小模型。
      zoomTarget = clamp(zoomTarget * factor, INSPECTOR_MIN_ZOOM, INSPECTOR_MAX_ZOOM);
      return;
    }
    zoomTarget = boundedZoom(zoomTarget, factor, MIN_ZOOM, zoomLimit());
  };
  let zoomMode = false;
  const setZoomMode = (on: boolean) => {
    zoomMode = on;
    hud.zoomMode?.classList.toggle("on", on);
    hud.zoomMode?.setAttribute("aria-pressed", on ? "true" : "false");
  };
  const onWheel = (e: WheelEvent) => {
    const withModifier = e.ctrlKey || e.metaKey || e.altKey || e.shiftKey;
    // 打开缩放模式后普通滚轮 / 触控板双指滚动就是缩放，不再滚动页面（触屏仍可单指上下滑动）
    if (!withModifier && !zoomMode && !freeCamera) return;
    e.preventDefault();
    // 往下滚 = 拉远，往上滚 / 双指张开 = 推近看细节
    applyZoom(Math.exp(wheelPixels(e.deltaY, e.deltaMode, canvas.clientHeight) * CFG.zoom.wheelStep));
  };
  const onDoubleClick = (e: MouseEvent) => {
    if (performance.now() - lastTouchFocusAt < 500) return;
    if (!(e as MouseEvent & { sourceCapabilities?: { firesTouchEvents: boolean } }).sourceCapabilities?.firesTouchEvents) {
      inspectAt(e.clientX, e.clientY, true);
      focusAt(e.clientX, e.clientY);
    }
  };
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("dblclick", onDoubleClick);
  cleanups.push(() => {
    canvas.removeEventListener("wheel", onWheel);
    canvas.removeEventListener("dblclick", onDoubleClick);
  });

  const onZoomIn = () => applyZoom(1 / 1.25);
  const onZoomOut = () => applyZoom(1.25);
  const onZoomModeToggle = () => {
    if (zoomMode) {
      zoomTarget = 1;
      setZoomMode(false);
      return;
    }
    setZoomMode(true);
  };
  hud.zoomIn?.addEventListener("click", onZoomIn);
  hud.zoomOut?.addEventListener("click", onZoomOut);
  hud.zoomMode?.addEventListener("click", onZoomModeToggle);
  cleanups.push(() => {
    hud.zoomIn?.removeEventListener("click", onZoomIn);
    hud.zoomOut?.removeEventListener("click", onZoomOut);
    hud.zoomMode?.removeEventListener("click", onZoomModeToggle);
  });

  // 触屏双指捏合

  const onTouchDown = (e: PointerEvent) => {
    if (e.pointerType !== "touch") return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 2) { pinchBase = pointerDistance(); }
  };
  const pointerDistance = () => {
    const [a, b] = [...touches.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };
  let pinchBase = 0;
  const onTouchMove = (e: PointerEvent) => {
    if (e.pointerType !== "touch" || !touches.has(e.pointerId)) return;
    const previous = touches.get(e.pointerId)!;
    if (modelCameraOn() && touches.size === 2 && !racing) {
      // 每个指针事件贡献双指中心位移的一半，同时保留捏合缩放。
      panCamera((e.clientX - previous.x) / 2, (e.clientY - previous.y) / 2);
    }
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size !== 2 || racing) return;
    const d = pointerDistance();
    if (!pinchBase) {
      pinchBase = d;
      return;
    }
    if (d > 1 && pinchBase > 1) {
      zoomTarget = modelCameraOn()
        ? clamp(zoomTarget * (pinchBase / d), INSPECTOR_MIN_ZOOM, INSPECTOR_MAX_ZOOM)
        : boundedZoom(zoomTarget, pinchBase / d, MIN_ZOOM, zoomLimit());
      pinchBase = d;
    }
  };
  const onTouchEnd = (e: PointerEvent) => {
    if (e.pointerType !== "touch") return;
    const wasPinching = touches.size > 1;
    touches.delete(e.pointerId);
    if (!wasPinching) { pinchBase = 0; return; }
    dragging = false; dragPointer = null; userYawVel = 0; userPitchVel = 0;
    if (touches.size === 1) {
      const [id, point] = [...touches][0];
      dragPointer = id; dragging = true; dragByTouch = true;
      dragX = point.x; dragY = point.y; dragTime = performance.now(); tapTravel = 100;
    }
    if (touches.size < 2) pinchBase = 0;
  };
  // 平板仍允许单指滚动章节；双指缩放始终由画布处理。手机由 touch-action: none 独占手势。
  const onTouchStartCapture = (e: TouchEvent) => {
    if (e.touches.length >= 2) e.preventDefault();
  };
  canvas.addEventListener("touchstart", onTouchStartCapture, { passive: false });
  canvas.addEventListener("pointerdown", onTouchDown);
  window.addEventListener("pointermove", onTouchMove);
  window.addEventListener("pointerup", onTouchEnd);
  window.addEventListener("pointercancel", onTouchEnd);
  cleanups.push(() => {
    canvas.removeEventListener("touchstart", onTouchStartCapture);
    canvas.removeEventListener("pointerdown", onTouchDown);
    window.removeEventListener("pointermove", onTouchMove);
    window.removeEventListener("pointerup", onTouchEnd);
    window.removeEventListener("pointercancel", onTouchEnd);
  });

  /* ---------- 9) 上下文丢失 / 恢复 ---------- */
  // 显存吃紧或驱动回收时 WebGL 上下文会丢，画面会变成白板。
  // 这里接管事件：丢失时阻止默认行为以便恢复，恢复或连续报错时让上层重建场景。
  const onContextLost = (e: Event) => {
    e.preventDefault();
    logEvent("webgl context lost");
    armWatchdog();
    options.onContextLost?.();
  };
  const onContextRestored = () => {
    logEvent("webgl context restored");
    options.onContextLost?.();
  };
  canvas.addEventListener("webglcontextlost", onContextLost);
  canvas.addEventListener("webglcontextrestored", onContextRestored);
  cleanups.push(() => {
    canvas.removeEventListener("webglcontextlost", onContextLost);
    canvas.removeEventListener("webglcontextrestored", onContextRestored);
  });
  let renderErrors = 0;
  let jsAvg = 0;
  let gpuAvg = 0;
  let lastPerfHud = 0;
  let hudLastRenderCalls = 0;
  let hudLastReflectionRenders = 0;
  let hudLastInspectorSkips = 0;
  const refreshPerfHud = (now: number) => {
    if (!qualityHud || now - lastPerfHud < 1000) return;
    const interval = Math.max(0.001, (now - (lastPerfHud || perfStartedAt)) / 1000);
    lastPerfHud = now;
    qualityHud.innerHTML = [
      `showcase · CPU ${jsAvg.toFixed(2)} ms · GPU ${gpuAvg ? gpuAvg.toFixed(2) : "—"} ms`,
      `render ${((renderCalls - hudLastRenderCalls) / interval).toFixed(1)}/s · reflect ${((reflectionRenders - hudLastReflectionRenders) / interval).toFixed(1)}/s · skip ${((inspectorSkippedFrames + homepageSkippedFrames - hudLastInspectorSkips) / interval).toFixed(1)}/s`,
      `buffer ${canvas.width}×${canvas.height} · tex ${renderer.info.memory.textures} · geo ${renderer.info.memory.geometries}`,
      `wire ${wireframeView.stats().buildMs.toFixed(1)} ms · ${(wireframeView.stats().generatedBytes / 1048576).toFixed(1)} MB`
    ].join("<br>");
    hudLastRenderCalls = renderCalls;
    hudLastReflectionRenders = reflectionRenders;
    hudLastInspectorSkips = inspectorSkippedFrames + homepageSkippedFrames;
  };

  /**
   * 自愈看门狗：GPU 驱动回收上下文时会留下整屏发白（或全黑）的画面，
   * 这里每隔约 1.5 秒回读 5 个点（中心与四角），连续 3 次都异常就通知上层重建场景。
   * 正常画面（哪怕在最亮的高速段）不会 5 个点同时接近纯白，因此不会误判。
   */
  const gl = renderer.getContext();
  const gl2 = typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext ? gl : null;
  const gpuTimerExt = gl2?.getExtension("EXT_disjoint_timer_query_webgl2") as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  const gpuQueries: WebGLQuery[] = [];
  const pollGpuTimers = () => {
    if (!gl2 || !gpuTimerExt) return;
    while (gpuQueries.length && gl2.getQueryParameter(gpuQueries[0], gl2.QUERY_RESULT_AVAILABLE)) {
      const query = gpuQueries.shift()!;
      const disjoint = gl2.getParameter(gpuTimerExt.GPU_DISJOINT_EXT);
      const ms = Number(gl2.getQueryParameter(query, gl2.QUERY_RESULT)) / 1e6;
      gl2.deleteQuery(query);
      if (!disjoint && Number.isFinite(ms)) gpuAvg = gpuAvg === 0 ? ms : gpuAvg * 0.85 + ms * 0.15;
    }
  };
  const beginGpuTimer = () => {
    if (!gl2 || !gpuTimerExt || gpuQueries.length >= 4) return null;
    const query = gl2.createQuery();
    if (!query) return null;
    gl2.beginQuery(gpuTimerExt.TIME_ELAPSED_EXT, query);
    return query;
  };
  const endGpuTimer = (query: WebGLQuery | null) => {
    if (!query || !gl2 || !gpuTimerExt) return;
    gl2.endQuery(gpuTimerExt.TIME_ELAPSED_EXT);
    gpuQueries.push(query);
  };
  cleanups.push(() => {
    if (gl2) gpuQueries.splice(0).forEach(query => gl2.deleteQuery(query));
  });
  const probe = new Uint8Array(4);
  let badFrames = 0;
  let softTries = 0;
  let lastProbe = performance.now();
  // readPixels 会同步等待 GPU，长期每秒探测会造成周期性卡顿；只在刚启动与刚经历过
  // 可见性/尺寸/上下文事件的窗口内探测（那才是白屏的高风险时刻）。
  let probeUntil = performance.now() + 8000;
  let watchdogHits = 0;
  let rebuilds = 0;
  const armWatchdog = () => {
    probeUntil = performance.now() + 8000;
  };
  let frameForMatrixCheck = 0;
  function checkCameraFinite() {
    frameForMatrixCheck += 1;
    if (frameForMatrixCheck % 30 !== 0) return;
    const e = camera.matrixWorld.elements;
    for (let i = 0; i < 16; i += 1) {
      if (!Number.isFinite(e[i])) {
        options.onContextLost?.();
        return;
      }
    }
    const p = camera.projectionMatrix.elements;
    for (let i = 0; i < 16; i += 1) {
      if (!Number.isFinite(p[i])) {
        resize(true);
        return;
      }
    }
  }

  function watchdog() {
    checkCameraFinite();
    // 查看器的浅灰画布在极近/极远位置可能五个采样点都接近纯白，这是正常构图，不是 WebGL 白屏。
    if (modelCameraOn()) { badFrames = 0; softTries = 0; return; }
    const now = performance.now();
    if (now > probeUntil) return;
    if (now - lastProbe < 500) return;
    lastProbe = now;
    const w = canvas.width;
    const h = canvas.height;
    if (!w || !h) return;
    const points: Array<[number, number]> = [
      [Math.round(w / 2), Math.round(h / 2)],
      [Math.round(w * 0.06), Math.round(h * 0.06)],
      [Math.round(w * 0.94), Math.round(h * 0.06)],
      [Math.round(w * 0.06), Math.round(h * 0.94)],
      [Math.round(w * 0.94), Math.round(h * 0.94)]
    ];
    let white = 0;
    let black = 0;
    for (const [x, y] of points) {
      gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, probe);
      const lum = (probe[0] * 0.299 + probe[1] * 0.587 + probe[2] * 0.114) / 255;
      if (lum > 0.9) white += 1;
      if (lum < 0.012) black += 1;
    }
    if (white >= 5 || black >= 5) {
      badFrames += 1;
      if (badFrames >= 2) {
        badFrames = 0;
        watchdogHits += 1;
        if (softTries < 2) {
          // 先做一次“软恢复”：多数白屏是尺寸/投影矩阵被写坏，重新算一次尺寸就能回来
          softTries += 1;
          logEvent(`watchdog: 整屏异常，第 ${watchdogHits} 次软恢复`);
          console.warn(`[showcase] 检测到异常画面（整屏发白或全黑），第 ${watchdogHits} 次软恢复`);
          resize(true);
        } else {
          softTries = 0;
          rebuilds += 1;
          logEvent(`watchdog: 软恢复无效，第 ${rebuilds} 次重建`);
          console.warn(`[showcase] 软恢复无效，第 ${rebuilds} 次重建场景`);
          options.onContextLost?.();
        }
      }
    } else {
      badFrames = 0;
      softTries = 0;
    }
  }

  /* ---------- 10) 渲染循环：不可见时暂停 ---------- */
  let last = performance.now();
  let lastRenderAt = last;
  let lastHomepageRender = 0;
  let pSmooth = START_P;
  let pVel = 0;
  const tick = () => {
    const now = performance.now();
    const rawDt = (now - last) / 1000;
    const dt = Number.isFinite(rawDt) ? Math.min(Math.max(rawDt, 0), 0.05) : 1 / 60;
    const frameMs = Number.isFinite(now - last) ? now - last : 16.7;
    last = now;
    if (!canvas.width || !canvas.height || !Number.isFinite(camera.aspect)) {
      resize();
      if (!canvas.width || !canvas.height || !Number.isFinite(camera.aspect)) return;
    }
    if (!active || document.hidden) return;
    // 滚动进度用临界阻尼弹簧跟随：相比一阶滤波，起步更快、收尾更顺，
    // 接近 framer-motion useSpring 的手感（参考站点就是这套观感）。
    const target = progress();
    pVel += ((target - pSmooth) * CFG.camera.springStiffness - pVel * CFG.camera.springDamping) * dt;
    pSmooth += pVel * dt;
    if (Math.abs(target - pSmooth) < 0.0002 && Math.abs(pVel) < 0.0004) {
      pSmooth = target;
      pVel = 0;
    }
    const inspectorMoving = inspectorOn && (
      dragging || touches.size > 0 || Math.abs(userYawVel) > 1e-4 || Math.abs(userPitchVel) > 1e-5 ||
      Math.abs(zoomTarget - zoom) > 1e-4 || Math.abs(pVel) > 0.0004
    );
    const homepageMoving = !inspectorOn && (
      dragging || touches.size > 0 || orbitOn || racing || speed > 0.01 || racingAmt > 0.001 ||
      Math.abs(userYawVel) > 1e-4 || Math.abs(userPitchVel) > 1e-5 || Math.abs(zoomTarget - zoom) > 1e-4 || Math.abs(pVel) > 0.0004
    );
    // 首页静止时复用上一帧画布，3D 主体以 30Hz 更新仪表/圆盘动画；交互立刻恢复显示器满帧。
    if (!inspectorOn && !homepageMoving && now - lastHomepageRender < 1000 / 32) {
      homepageSkippedFrames += 1;
      refreshPerfHud(now);
      return;
    }
    if (inspectorOn && !inspectorMoving && !inspectorRenderDirty) {
      inspectorSkippedFrames += 1;
      refreshPerfHud(now);
      return;
    }
    adaptQuality(frameMs);
    pollGpuTimers();
    const gpuQuery = beginGpuTimer();
    try {
      const jsStart = performance.now();
      const renderDt = Math.min(Math.max((now - lastRenderAt) / 1000, 0), 0.05);
      render(pSmooth, renderDt);
      if (inspectorOn && !inspectorMoving) inspectorRenderDirty = false;
      const jsCost = performance.now() - jsStart;
      jsAvg = jsAvg === 0 ? jsCost : jsAvg * 0.9 + jsCost * 0.1;
      refreshPerfHud(now);
      renderErrors = 0;
      watchdog();
    } catch (err) {
      // 单帧偶发错误不要拖死整个循环；连续出错说明上下文已经不健康，重建场景
      renderErrors += 1;
      if (renderErrors === 1) (window as unknown as { __errs?: string[] }).__errs?.push(String(err));
      if (renderErrors > 3) {
        renderer.setAnimationLoop(null);
        options.onContextLost?.();
      }
    } finally {
      endGpuTimer(gpuQuery);
      lastRenderAt = now;
      if (!inspectorOn) lastHomepageRender = now;
    }
  };
  renderer.setAnimationLoop(tick);
  cleanups.push(() => renderer.setAnimationLoop(null));

  const io = new IntersectionObserver(
    (entries) => {
      active = entries.some((e) => e.isIntersecting);
      last = performance.now();
    },
    { threshold: 0 }
  );
  io.observe(hud.stage);
  cleanups.push(() => io.disconnect());

  const onVisible = () => {
    if (!document.hidden) {
      last = performance.now();
      armWatchdog();
      resize();
      measureScroll();
      render(pSmooth, 1 / 60);
    }
  };
  document.addEventListener("visibilitychange", onVisible);
  cleanups.push(() => document.removeEventListener("visibilitychange", onVisible));

  let resizeQueued = false;
  const ro = new ResizeObserver(() => {
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(() => {
      resizeQueued = false;
      resize();
      measureScroll();
    });
  });
  ro.observe(canvas);
  ro.observe(hud.scroll);
  cleanups.push(() => ro.disconnect());

  // 首屏只加载当前需要的夜间环境；浅色、影棚和模型展示首次启用前再取日间 HDR。
  hdr.loadAsync(CFG.assets.envNight)
    .then((night) => {
      night.mapping = THREE.EquirectangularReflectionMapping;
      nightEnv = night;
      envMixMat.uniforms.uEnv1.value = night;
      envMixMat.uniforms.uEnv2.value = night;
      envReady = true;
      updateEnv(0);
      loadDone += 1;
      reportProgress();
      resize();
      render(progress(), 1 / 60);
    })
    .catch((err) => options.onError?.(`环境贴图加载失败：${String(err?.message ?? err)}`));

  resize();

  return {
    dispose: () => {
      wireframeView.dispose();
      cleanups.forEach((fn) => fn());
      io.disconnect();
      ro.disconnect();
      scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.geometry?.dispose?.();
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          mats.forEach((m) => m?.dispose?.());
        }
      });
      composer.passes.forEach((pass) => pass.dispose?.());
      composer.dispose();
      reflectRT.dispose();
      envTarget.dispose();
      envMixTarget.dispose();
      envBlurTarget.dispose();
      envPmrem?.dispose();
      nightEnv?.dispose();
      dayEnv?.dispose();
      pmrem.dispose();
      backdrop.dispose();
      backdropLight.dispose();
      renderer.dispose();
      try {
        renderer.forceContextLoss();
      } catch {
        /* 上下文可能已经被驱动回收，忽略 */
      }
    },
    setTheme: (next: "dark" | "light") => {
      theme = next;
      renderer.setClearColor(next === "light" ? 0xf4f6f9 : 0x050506, 1);
      invalidateInspector();
    },
    /**
     * 原地换车：只换车身，镜头 / 地面 / 环境 / HUD 全不动 —— 不重建 WebGL 场景，所以切换过程没有空白期。
     * 素材通常已经被预热进缓存，这里剩下的主要就是解析时间；解析完成后在同一个任务里撤旧车、挂新车。
     */
    setModel: async (next: { asset: string; model?: ShowcaseConfig["model"] }) => {
      const sequence = ++modelSwitchSequence;
      try {
        const cached = await fetchAssetBuffer(next.asset);
        const nextCar = await parseCar(cached.buffer);
        // 连续调参可能让多次解析交叠；旧请求晚到时不得覆盖最新参数。
        if (sequence !== modelSwitchSequence) return false;
        logEvent(`换车 ${next.asset}：来源 ${cached.mode}${cached.fromCache ? "（本地命中）" : "（网络下载）"}`);
        const previous = mountedCar;
        mountedCar = null;
        // 先把配置换成新车（车长 / 朝向 / 材质规则 / 轮子都读 CFG.model），再撤旧挂新
        const previousTextureLimit = CFG.model.maxTextureSize;
        CFG.model = normalizeModel(next.model);
        if (previousTextureLimit !== CFG.model.maxTextureSize) {
          wantedScale = desiredPixelRatio();
          renderScale = budgetRatio(canvas.clientWidth || window.innerWidth, canvas.clientHeight || window.innerHeight, originalResolution() ? wantedScale : Math.min(wantedScale, 1.5));
          qualityChanges = 0;
          frameCost = 0; frameSamples = 0; lastAdapt = performance.now();
          renderer.setPixelRatio(renderScale);
          composer.setPixelRatio(renderScale);
          resize(true);
        }
        CFG.assets = { ...CFG.assets, model: next.asset };
        unmountCar(previous);
        wireframeView.configure(CFG.model.wireframe);
        focusTarget.set(0, 0, 0);
        mountCar(nextCar);
        invalidateInspector();
        render(progress(), 1 / 60);
        return true;
      } catch (err) {
        // 失败就把旧车留在画面上（mountedCar 没动），只报错
        options.onError?.(err instanceof Error ? err.message : String(err ?? "换车失败"));
        return false;
      }
    },
    updateModelMaterials: (next) => {
      const normalized = normalizeModel(next);
      CFG.model.emissiveIntensity = normalized.emissiveIntensity;
      CFG.model.clearcoatRoughness = normalized.clearcoatRoughness;
      CFG.model.envMapIntensity = normalized.envMapIntensity;
      bodyMaterials.forEach((material) => {
        const base = material.userData.showcaseMaterialBase as { envMapIntensity?: number; emissiveIntensity?: number; clearcoatRoughness?: number } | undefined;
        material.envMapIntensity = normalized.envMapIntensity;
        if (material.emissive && (material.emissive.r > 0.01 || material.emissive.g > 0.01 || material.emissive.b > 0.01)) {
          material.emissiveIntensity = Math.min(base?.emissiveIntensity ?? material.emissiveIntensity ?? 1, normalized.emissiveIntensity);
        }
        const physical = material as THREE.MeshPhysicalMaterial;
        if (physical.clearcoat && physical.clearcoat > 0) {
          physical.clearcoatRoughness = Math.max(base?.clearcoatRoughness ?? 0, normalized.clearcoatRoughness);
        }
        material.needsUpdate = true;
      });
      invalidateInspector();
    },
    /**
     * 冻结当前这一帧（换车型时当背景板用）：先补渲染一帧，再同步拷进一张 2D canvas。
     * 不能直接把 WebGL canvas 留在页面上当背景 —— dispose() 里的 forceContextLoss 会把它清成黑色。
     * 拷贝宽度封顶 1600：背景板不需要全分辨率，省内存也省拷贝时间。
     */
    snapshot: () => {
      try {
        if (renderer.getContext().isContextLost()) return null;
        render(progress(), 1 / 60);
        const scale = Math.min(1, 1600 / Math.max(1, canvas.width));
        const copy = document.createElement("canvas");
        copy.width = Math.max(16, Math.round(canvas.width * scale));
        copy.height = Math.max(16, Math.round(canvas.height * scale));
        const ctx2d = copy.getContext("2d");
        if (!ctx2d) return null;
        ctx2d.drawImage(canvas, 0, 0, copy.width, copy.height);
        return copy;
      } catch {
        return null;
      }
    },
    /** 360° 环视：自动绕车一圈，再点一次平滑回到叙事机位 */
    resetCamera: resetView,
    setInspector: (on) => {
      if (on === inspectorOn) return;
      inspectorOn = on;
      if (on) {
        inspectorPose = { free: freeCamera, yaw: userYaw, pitch: userPitch, zoom: zoomTarget, orbit: orbitOn, orbitYaw, focus: focusTarget.clone() };
        freeCamera = true; orbitOn = false; orbitYaw = 0;
        racing = false; speed = 0; racingAmt = 0; carTravel = 0;
        inspectorProgress = homePose?.p ?? START_P;
        userYaw = homePose?.yaw ?? 0; userPitch = homePose?.pitch ?? 0;
        zoom = zoomTarget = homePose?.zoom ?? 1;
        focusTarget.set(0, 0, 0); focusOffset.set(0, 0, 0);
      } else if (inspectorPose) {
        freeCamera = inspectorPose.free; orbitOn = inspectorPose.orbit; orbitYaw = inspectorPose.orbitYaw;
        userYaw = inspectorPose.yaw; userPitch = inspectorPose.pitch;
        zoom = zoomTarget = inspectorPose.zoom;
        focusTarget.copy(inspectorPose.focus); focusOffset.copy(inspectorPose.focus);
        inspectorPose = null;
      }
      userYawVel = 0; userPitchVel = 0;
      camera.far = on ? 5000 : 400;
      camera.near = on ? 0.01 : 0.1;
      camera.updateProjectionMatrix();
      invalidateInspector();
    },
    setInspectRegion: (region) => {
      wireframeView.focus(!region || region === "overall" ? null : mesh => inspectRegionOf(mesh) === region);
      invalidateInspector();
    },
    setWireframe: (mode, color) => {
      wireframeMode = mode;
      wireframeView.set(mode, color);
      if (mode === "native") reflectDirty = true;
      invalidateInspector();
    },
    setDiscStyle: (style) => {
      discStyle = style;
      const ready = !mobileViewer() || mountedCar !== null;
      chronoDisc.visible = ready && discStyle === "chrono";
      trackDisc.visible = ready && discStyle === "track";
    },
    setDriveCamera: (mode) => { driveCamera = mode; },
    setFreeCamera: (on: boolean) => {
      if (freeCamera === on) return;
      freeCamera = on;
      focusTarget.set(0, 0, 0);
      zoomTarget = 1;
      userYaw = 0; userPitch = 0; userYawVel = 0; userPitchVel = 0;
      if (on) { orbitOn = false; orbitYaw = 0; }
      invalidateInspector();
    },
    setOrbit: (on: boolean) => {
      orbitOn = on;
      invalidateInspector();
    },
    /** 影棚：把环境切到明亮摄影棚（不改深浅色主题，只影响 3D 场景的光与背景） */
    setStudio: (on: boolean) => {
      studioOn = on;
      invalidateInspector();
    },
    /** 当前机位：置顶时把这几项一起存下来 */
    readPose: () => ({ p: +pSmooth.toFixed(4), yaw: +userYaw.toFixed(2), pitch: +userPitch.toFixed(4), zoom: +zoom.toFixed(3) }),
    applyPose: (pose) => {
      if (typeof pose.yaw === "number" && Number.isFinite(pose.yaw)) {
        userYaw = pose.yaw;
        userYawVel = 0;
      }
      if (typeof pose.pitch === "number" && Number.isFinite(pose.pitch)) {
        userPitch = clamp(pose.pitch, modelCameraOn() ? -Math.PI : -0.55, modelCameraOn() ? Math.PI : 0.95);
        userPitchVel = 0;
      }
      if (typeof pose.zoom === "number" && Number.isFinite(pose.zoom)) {
        zoom = modelCameraOn()
          ? clamp(pose.zoom, INSPECTOR_MIN_ZOOM, INSPECTOR_MAX_ZOOM)
          : clamp(pose.zoom, MIN_ZOOM, MAX_ZOOM);
        zoomTarget = zoom;
      }
      invalidateInspector();
    },
    /** 用户置顶的机位：双击复位回到这里（传 null 表示没置顶，回到中立角度） */
    setHomePose: (pose: { p?: number; yaw?: number; pitch?: number; zoom?: number } | null) => {
      homePose = pose
        ? { p: pose.p ?? START_P, yaw: pose.yaw ?? 0, pitch: pose.pitch ?? 0, zoom: pose.zoom ?? 1 }
        : null;
      invalidateInspector();
    },
    setProgress: (p: number, settle = 0) => {
      if (mobileViewer()) mobileProgress = clamp(p, 0, 1);
      const steps = Math.max(1, Math.round(settle * 60));
      for (let i = 0; i < steps; i += 1) render(p, 1 / 60);
      render(p, 1 / 60);
    },
  debug: () => ({
    progress: +pSmooth.toFixed(4),
    speed: +speed.toFixed(2),
    scale: renderScale,
    racing,
    travel: +carTravel.toFixed(2),
    chase: +racingAmt.toFixed(3),
    roadTravel: +roadTravel.toFixed(3),
    tunnelStrength: +lightLinesPass.uniforms.uStrength.value.toFixed(3),
    tunnelEnabled: lightLinesPass.enabled,
    camera: camera.position.toArray(),
    target: lookAt.toArray(),
    inspector: inspectorOn,
    clipping: [camera.near, camera.far],
    viewAzimuth: +viewAzimuth.toFixed(2),
    viewElevation: +viewElevation.toFixed(2),
    viewDistance: +viewDistance.toFixed(3),
    carScreenBox: lightLinesPass.uniforms.uCarBox.value.toArray(),
    zoom: +zoom.toFixed(3),
    theme,
    yaw: +userYaw.toFixed(1),
    pitch: +userPitch.toFixed(2),
    wheelAngle: wheelPivots[0]?.[0] ? +wheelPivots[0][0].angle.toFixed(2) : 0,
    /** 地面倒影当前强度：冲刺（隧道行驶）时应为 0 */
    reflect: +floorUniforms.uReflectIntensity.value.toFixed(3),
    /** 车身高度与偏航（度）：用来确认车没有离地、没有偏出轨道 */
    carY: +carRoot.position.y.toFixed(3),
    carYaw: +((carRoot.rotation.y * 180) / Math.PI).toFixed(2),
    /** 车道保持：自动量出的车头偏角（度，对齐前）与当前横向偏移（米） */
    carBox: carDebugBox,
    carBoxRaw: carRawBox,
    carMaterials: carMaterialNames,
    carMeshes: carMeshNames,
    wheelGroups: carWheelGroups,
    laneHeading: +laneHeadingDeg.toFixed(2),
    laneOffset: +carLateral.toFixed(3),
    /** 360° 环视 / 影棚当前是否打开（界面按钮要显示状态） */
    orbit: orbitOn,
    studio: studioOn,
    buffer: [canvas.width, canvas.height],
    reflection: reflectRT.width,
    textures: renderer.info.memory.textures,
    geometries: renderer.info.memory.geometries,
    wireframe: wireframeView.stats(),
    /** 每帧脚本耗时（毫秒，渲染调用 + HUD + 相机计算，不含 GPU 执行时间） */
    jsMs: +jsAvg.toFixed(2),
    gpuMs: +gpuAvg.toFixed(2),
    renderFps: +(renderCalls / Math.max(0.001, (performance.now() - perfStartedAt) / 1000)).toFixed(2),
    reflectionFps: +(reflectionRenders / Math.max(0.001, (performance.now() - perfStartedAt) / 1000)).toFixed(2),
    inspectorSkippedFps: +((inspectorSkippedFrames + homepageSkippedFrames) / Math.max(0.001, (performance.now() - perfStartedAt) / 1000)).toFixed(2),
    /** 看门狗触发次数（软恢复 / 重建），排查白屏用 */
    watchdogHits,
    rebuilds,
    /** 关键事件日志（上下文丢失、看门狗动作、异常尺寸等） */
    log: [...eventLog]
  })
};
}
