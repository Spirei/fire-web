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
import { HDRLoader } from "three/addons/loaders/HDRLoader.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import type { ShowcaseCameraKey, ShowcaseConfig, ShowcaseHandle, ShowcaseLightBar, ShowcaseOptions } from "./types";

/** 配置里的正则既能写字符串（可跨服务端/客户端传递）也能直接给 RegExp */
function toRegExp(value: string | RegExp | undefined, fallback: RegExp) {
  if (value === undefined) return fallback;
  return typeof value === "string" ? new RegExp(value, "i") : value;
}

export type { ShowcaseHandle, ShowcaseHud, ShowcaseOptions } from "./types";

/** 把 config 里的可选值补齐成引擎内部使用的常量 */
function normalizeConfig(config: ShowcaseConfig) {
  const ring = config.ground?.ring;
  const tunnel = config.speed.tunnel;
  return {
    assets: config.assets,
    watermark: config.watermark ?? "SHOWCASE",
    model: {
      length: config.model?.length ?? 5.6,
      yaw: config.model?.yaw ?? 0,
      pitch: config.model?.pitch ?? 0,
      wheelPattern: toRegExp(config.model?.wheelPattern, /rim|tread|tyre/i),
      wheelAxis: config.model?.wheelAxis ?? "x",
      wheelLateral: config.model?.wheelLateral ?? "x",
      wheelLongitudinal: config.model?.wheelLongitudinal ?? "y",
      maxTextureSize: config.model?.maxTextureSize ?? 4096,
      materialRules: (config.model?.materialRules ?? []).map((rule) => ({
        match: toRegExp(rule.match, /$^/),
        metalness: rule.metalness,
        roughness: rule.roughness
      }))
    },
    environment: {
      nightToDay: config.environment?.nightToDay ?? [0.72, 0.88],
      dayIntensity: config.environment?.dayIntensity ?? 1
    },
    camera: {
      keyframes: [...config.camera.keyframes].sort((a, b) => a.p - b.p),
      shakeAmount: config.camera.shake?.amount ?? 0.34,
      shakeSmoothing: config.camera.shake?.smoothing ?? 1.6,
      fitMinAspect: config.camera.fit?.minAspect ?? 1.2,
      fitMaxPullback: config.camera.fit?.maxPullback ?? 1.8
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
      reflectionSize: config.ground?.reflectionSize ?? 384,
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
      tunnel:
        tunnel === false
          ? null
          : {
              radius: tunnel?.radius ?? 26,
              length: tunnel?.length ?? 120,
              bars: tunnel?.bars ?? [],
              gold: tunnel?.gold ?? "#ffc266",
              white: tunnel?.white ?? "#ccdcfa",
              dashes: tunnel?.dashes ?? 1,
              vanish: tunnel?.vanish ?? [0.5, 0.47],
              barIntensity: tunnel?.barIntensity ?? 1
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
    phases: config.phases,
    parts: config.parts ?? []
  };
}

/** 把 config 里的光条展开成 GLSL 表达式（unrolled，避免动态数组索引） */
function barGlsl(bars: ShowcaseLightBar[], tone: "gold" | "white", scale = 1) {
  const list = bars.filter((b) => b.tone === tone);
  if (list.length === 0) return "0.0";
  return list
    .map((b) => `barLine(ang, ${((b.angle * Math.PI) / 180).toFixed(5)}, ${((b.width * Math.PI) / 180).toFixed(5)})`)
    .join(" + ") + (scale !== 1 ? ` * ${scale}` : "");
}

export function createShowcaseScene(options: ShowcaseOptions): ShowcaseHandle {
  const { canvas, hud } = options;
  const CFG = normalizeConfig(options.config);
  const cleanups: Array<() => void> = [];
  const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  // 排查性能用：?mcloff=reflect,bloom,tunnel,floor,car 可逐项关掉效果（只影响诊断，不影响正常访问）
  const off =
    typeof location !== "undefined"
      ? new Set((new URLSearchParams(location.search).get("mcloff") || "").split(",").filter(Boolean))
      : new Set<string>();

  /* ---------- 渲染器 / 相机 ---------- */
  // 像素预算：EffectComposer 会建两块 HalfFloat 的 RT（后来还要泛光的多级），
  // 大窗口 + 高分屏下按设备像素比铺满会直接吃掉几百 MB 显存，久了会丢上下文变白屏。
  // 这里给整屏输出封一个像素上限，超了就降倍率（分辨率换稳定）。
  const MAX_OUTPUT_PIXELS = 2_000_000;
  const MIN_PIXEL_RATIO = 0.5;
  const budgetRatio = (w: number, h: number, wanted: number) => {
    const area = Math.max(1, w * h);
    if (area * wanted * wanted <= MAX_OUTPUT_PIXELS) return wanted;
    return Math.max(MIN_PIXEL_RATIO, Math.sqrt(MAX_OUTPUT_PIXELS / area));
  };
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(budgetRatio(canvas.clientWidth || window.innerWidth, canvas.clientHeight || window.innerHeight, Math.min(window.devicePixelRatio || 1, 1.5)));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = CFG.post.exposure;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 400);

  /* ---------- 背景：程序化渐变（屏幕空间），避免 HDR 的地平线穿帮 ---------- */
  const backdrop = (() => {
    const c = document.createElement("canvas");
    c.width = 8;
    c.height = 512;
    const g = c.getContext("2d");
    if (g) {
      const grd = g.createLinearGradient(0, 0, 0, 512);
      grd.addColorStop(0, "#191c22");
      grd.addColorStop(0.42, "#0b0c0f");
      grd.addColorStop(0.72, "#070708");
      grd.addColorStop(1, "#030303");
      g.fillStyle = grd;
      g.fillRect(0, 0, 8, 512);
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  scene.background = backdrop;

  /* ---------- 灯光：环境贴图为主，补三盏软灯让车身读得出来 ---------- */
  const keyLight = new THREE.DirectionalLight(0xfff2e2, 0.72);
  keyLight.position.set(6, 9, 5);
  scene.add(keyLight);
  const rimLight = new THREE.DirectionalLight(0xff9a3c, 0.78);
  rimLight.position.set(-7, 4, -6);
  scene.add(rimLight);
  const fillLight = new THREE.DirectionalLight(0x9fc4ff, 0.32);
  fillLight.position.set(-4, 3, 7);
  scene.add(fillLight);

  /* ---------- 1) 双 HDR 环境：FBO 混合 ---------- */
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  // 环境只用来做反射，512×256 足够；PMREM 的开销与分辨率成正比，这里直接砍到四分之一
  const envTarget = new THREE.WebGLRenderTarget(512, 256, { type: THREE.HalfFloatType });
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
        gl_FragColor = vec4(mix(night, day, uWeight), 1.0);
      }`
  });
  envQuadScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), envMixMat));

  let envPmrem: THREE.WebGLRenderTarget | null = null;
  let envApplied = -1;
  let envReady = false;
  function updateEnv(weight: number) {
    if (!envReady) return;                       // 环境贴图没加载完就别渲染全屏四边形
    const w = Math.round(weight * 10) / 10;      // 量化，避免每帧重跑 PMREM
    if (w === envApplied) return;
    envApplied = w;
    envMixMat.uniforms.uWeight.value = w;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(envTarget);
    renderer.render(envQuadScene, envQuadCam);
    renderer.setRenderTarget(prev);
    const mixed = envTarget.texture;
    mixed.mapping = THREE.EquirectangularReflectionMapping;
    envPmrem?.dispose();
    envPmrem = pmrem.fromEquirectangular(mixed);
    scene.environment = envPmrem.texture;
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
        const r = 0.28 + h * 0.34;
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
    uFlow: { value: 0 }
  };
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(140, 140),
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
          vec2 distortion = n.xz * (0.0015 + 1.6 / max(d, 1.0)) * 0.06;
          vec4 rp = vReflect; rp.xyz /= rp.w;
          float rough = texture2D(tRough, vWorld.xz * 0.06 + scroll).r;
          // 粗糙度控制 mip 级别 → 自带模糊的反射
          vec3 refl = texture2D(tReflect, clamp(rp.xy + distortion, 0.002, 0.998), rough * 2.4).rgb;
          vec3 viewDir = normalize(-vView);
          float fres = pow(1.0 - clamp(dot(n, viewDir), 0.0, 1.0), 3.0);
          vec3 col = uColor;
          col = mix(col, refl * uReflectIntensity, clamp(0.22 + fres * 1.2, 0.0, 1.0));
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
  // 地面本来就带粗糙度模糊，512 与 1024 的观感差别很小。
  // 反射贴图用 8 位（参考项目 su7-replica 的 meshReflectorMaterial 也是 UnsignedByteType + 256），
  // 地面本身带粗糙度模糊，8 位足够，显存只有 HalfFloat 的一半。
  const reflectRT = new THREE.WebGLRenderTarget(CFG.ground.reflectionSize, CFG.ground.reflectionSize, {
    type: THREE.UnsignedByteType,
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter
  });
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
  let ringUniformsRef: { uSweep: { value: number }; uSpeed: { value: number }; uTime: { value: number } } | null = null;

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

  const contact = new THREE.Mesh(
    new THREE.PlaneGeometry(8.4, 3.6),
    new THREE.MeshBasicMaterial({
      map: radialTexture([[0, "rgba(0,0,0,0.92)"], [0.45, "rgba(0,0,0,0.5)"], [1, "rgba(0,0,0,0)"]]),
      transparent: true,
      opacity: 0.9,
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
    groundFx.add(ellipseOutline(RING_R + RING.longLength, RING_R + RING.longLength, 0.008, 0.34, ringColor.getHex()));
    groundFx.add(ellipseOutline(RING_R, RING_R, 0.005, 0.18, ringColor.clone().lerp(new THREE.Color(0xffffff), 0.35).getHex()));
    const ringUniforms = {
      uSweep: { value: 0 },
      uSpeed: { value: 0 },
      uTime: { value: 0 },
      uColor: { value: ringColor }
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
        uniform float uSweep; uniform float uSpeed; uniform float uTime; uniform vec3 uColor;
        varying float vIndex;
        void main(){
          float diff = abs(fract(vIndex - uSweep + 0.5) - 0.5) * 2.0;   // 环上的角距离
          float glow = pow(1.0 - clamp(diff, 0.0, 1.0), 7.0);
          float flick = 0.85 + 0.15 * sin(uTime * 3.0 + vIndex * 90.0);
          float a = (0.3 + glow * 0.8) * flick * (0.8 + uSpeed * 0.5);
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
      m.compose(pos, quat, new THREE.Vector3(long ? 1.6 : 1, 1, len / RING.shortLength));
      mesh.setMatrixAt(i, m);
      idx[i] = i;
    }
    ringGeo.setAttribute("aIndex", new THREE.InstancedBufferAttribute(idx, 1));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.renderOrder = 3;
    mesh.frustumCulled = false;
    groundFx.add(mesh);
    ring = mesh;
    ringUniformsRef = ringUniforms;
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
  const goldBars = barGlsl(barTune, "gold");
  const whiteBars = barGlsl(barTune, "white");
  const goldCores = barGlsl(barTune, "gold", 0.27);
  const whiteCores = barGlsl(barTune, "white", 0.26);
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
      vec2 nUv = vec2(vUv.x * 48.0, vUv.y * 0.32 - uTime * (0.15 + uSpeed * 0.035));
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
        gl_FragColor = vec4(col, 1.0);
      }`
  });
  // 主光条：屏幕空间里从消失点放射出去的细亮线（参考视频里就是这个观感）。
  // 贴在圆柱面上的线只有在柱面很细的时候才进得来，所以改成后期。
  const lineBars = CFG.speed.tunnel?.bars ?? [];
  const lineAngles = lineBars.map((b) => ({ a: (b.angle * Math.PI) / 180, w: (b.width * Math.PI) / 180, gold: b.tone === "gold" }));
  const lightLinesPass = new ShaderPass({
    uniforms: {
      tDiffuse: { value: null },
      uTime: { value: 0 },
      uStrength: { value: 0 },
      uSpeed: { value: 0 },
      uCenter: { value: new THREE.Vector2(CFG.speed.tunnel?.vanish?.[0] ?? 0.5, CFG.speed.tunnel?.vanish?.[1] ?? 0.47) },
      uAspect: { value: 1.78 },
      uGold: { value: new THREE.Color(CFG.speed.tunnel?.gold ?? "#ffc266") },
      uWhite: { value: new THREE.Color(CFG.speed.tunnel?.white ?? "#ccdcfa") },
      uIntensity: { value: CFG.speed.tunnel?.barIntensity ?? 1 },
      uCarBox: { value: new THREE.Vector4(0.5, 0.46, 0.12, 0.06) }
    },
    vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: `
      uniform sampler2D tDiffuse; uniform float uTime; uniform float uStrength; uniform float uSpeed;
      uniform vec2 uCenter; uniform float uAspect; uniform vec3 uGold; uniform vec3 uWhite; uniform float uIntensity;
      uniform vec4 uCarBox;   // 车在屏幕上的包围盒：xy 中心、zw 半尺寸（uv）
      varying vec2 vUv;
      const float TAU = 6.28318530718;
      float barLine(float ang, float target, float w){
        float d = abs(fract((ang - target) / TAU + 0.5) - 0.5) * TAU;
        return smoothstep(w * 3.0, 0.0, d) * 0.1 + smoothstep(w, 0.0, d);
      }
      void main(){
        vec4 base = texture2D(tDiffuse, vUv);
        if (uStrength <= 0.001) { gl_FragColor = base; return; }
        // 用像素比例还原真实屏幕角度，宽屏也不会把线压扁
        vec2 d = (vUv - uCenter) * vec2(uAspect, 1.0);
        float r = length(d);
        float ang = atan(d.y, d.x);
        float radial = smoothstep(0.06, 0.34, r) * (1.0 - smoothstep(0.9, 1.35, r) * 0.3);
        float goldMask = 0.0;
        float whiteMask = 0.0;
        ${lineAngles.map((b) => `${b.gold ? "goldMask" : "whiteMask"} += barLine(ang, ${b.a.toFixed(5)}, ${b.w.toFixed(5)});`).join("\n        ")}
        // 沿线流动的虚线段：光条像一段段光带往镜头方向掠过
        float flow = 0.72 + 0.28 * sin(r * 26.0 - uTime * (2.0 + uSpeed * 0.35));
        float dash = 0.82 + 0.18 * smoothstep(0.1, 0.9, fract(r * 9.0 - uTime * (1.2 + uSpeed * 0.04)));
        // 车体遮挡：参考视频里光条是从车后面去的，不要画在车身上
        vec2 carQ = (vUv - uCarBox.xy) / max(uCarBox.zw, vec2(1e-4));
        float hide = 1.0 - smoothstep(0.8, 1.12, length(carQ));
        float mask = (goldMask + whiteMask * 0.85) * radial * flow * dash * (1.0 - hide) * uStrength * uIntensity;
        vec3 col = uGold * goldMask + uWhite * whiteMask;
        gl_FragColor = vec4(base.rgb + col * mask, base.a);
      }`
  });
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(lightLinesPass);
  composer.addPass(smearPass);
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(1, 1),
    CFG.post.bloomStrength,
    CFG.post.bloomRadius,
    CFG.post.bloomThreshold
  );
  bloom.enabled = !off.has("bloom");
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
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
  const wheelPivots: Array<
    Array<{ mesh: THREE.Mesh; angle: number; rot: THREE.Matrix4; t1: THREE.Matrix4; t2: THREE.Matrix4 }>
  > = [];
  const bodyMaterials: THREE.MeshStandardMaterial[] = [];

  /** 合并网格里一个材质覆盖四个轮子，按三角面质心聚类拆成四个独立的轮子 */
  function splitWheels(mesh: THREE.Mesh, midLateral: number, midLong: number, lateralAxis: number, longAxis: number) {
    const geo = mesh.geometry;
    const idx = geo.index;
    const pos = geo.attributes.position as THREE.BufferAttribute;
    if (!idx || !pos) return new Map<number, { geometry: THREE.BufferGeometry; center: THREE.Vector3 }>();
    const buckets = new Map<number, number[]>();
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    for (let i = 0; i < idx.count; i += 3) {
      a.fromBufferAttribute(pos, idx.getX(i));
      b.fromBufferAttribute(pos, idx.getX(i + 1));
      c.fromBufferAttribute(pos, idx.getX(i + 2));
      const cl = (a.getComponent(lateralAxis) + b.getComponent(lateralAxis) + c.getComponent(lateralAxis)) / 3;
      const cf = (a.getComponent(longAxis) + b.getComponent(longAxis) + c.getComponent(longAxis)) / 3;
      const key = (cl > midLateral ? 1 : 0) + (cf > midLong ? 2 : 0);
      const list = buckets.get(key);
      if (list) list.push(idx.getX(i), idx.getX(i + 1), idx.getX(i + 2));
      else buckets.set(key, [idx.getX(i), idx.getX(i + 1), idx.getX(i + 2)]);
    }
    const out = new Map<number, { geometry: THREE.BufferGeometry; center: THREE.Vector3 }>();
    buckets.forEach((indices, key) => {
      if (indices.length < 30) return;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", pos);                       // 共用顶点缓冲，只换索引
      if (geo.attributes.normal) g.setAttribute("normal", geo.attributes.normal);
      if (geo.attributes.uv) g.setAttribute("uv", geo.attributes.uv);
      g.setIndex(indices);
      const min = new THREE.Vector3(Infinity, Infinity, Infinity);
      const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
      const v = new THREE.Vector3();
      for (const i of indices) {
        v.fromBufferAttribute(pos, i);
        min.min(v);
        max.max(v);
      }
      out.set(key, { geometry: g, center: min.clone().add(max).multiplyScalar(0.5) });
    });
    return out;
  }

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

  const loadTotal = 3;   // 两个 HDR + 一个模型
  let loadDone = 0;
  const reportProgress = (partial = 0) => {
    options.onProgress?.(Math.min(1, (loadDone + partial) / loadTotal));
    if (loadDone >= loadTotal) options.onReady?.();
  };

  new GLTFLoader().load(
    CFG.assets.model,
    (gltf) => {
      const car = gltf.scene;
      car.visible = !off.has("car");
      // 不同来源的模型朝向不一致：preset 里给 yaw / pitch 做一次性修正
      if (CFG.model.yaw) car.rotation.y += (CFG.model.yaw * Math.PI) / 180;
      if (CFG.model.pitch) car.rotation.x += (CFG.model.pitch * Math.PI) / 180;
      car.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(car);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const scale = CFG.model.length / Math.max(size.x, size.y, size.z);
      car.scale.setScalar(scale);
      car.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);

      // 贴图尺寸上限：默认 4096（等于不动），大贴图模型可在 preset 里调到 2048 省一半以上显存
      const maxTex = CFG.model.maxTextureSize;
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
      car.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.frustumCulled = false;
        const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial;
        const name = mat?.name || "";
        // 按 preset 的规则修正材质参数（不同模型自带参数差别很大：轮胎不该是金属，碳纤维别太像镜子）
        if (mat?.isMeshStandardMaterial) {
          CFG.model.materialRules.forEach((rule) => {
            if (!rule.match.test(name)) return;
            if (rule.metalness !== undefined) mat.metalness = rule.metalness;
            if (rule.roughness !== undefined) mat.roughness = rule.roughness;
          });
          ["map", "normalMap", "roughnessMap", "metalnessMap", "aoMap", "emissiveMap"].forEach((key) => {
            clampTexture((mat as unknown as Record<string, THREE.Texture | null>)[key]);
          });
          mat.envMapIntensity = 1.25;
          addFlow(mat);
          bodyMaterials.push(mat);
        }
        if (CFG.model.wheelPattern.test(name) && !/st_wheel/i.test(name)) splitTargets.push(mesh);
      });
      carRoot.add(car);

      // 拆轮子：几何体不动，用「平移到轮心 → 旋转 → 平移回去」的矩阵让每个轮子绕自己的轴自转
      const wheelBox = new THREE.Box3();
      splitTargets.forEach((m) =>
        wheelBox.union(new THREE.Box3().setFromBufferAttribute(m.geometry.attributes.position as THREE.BufferAttribute))
      );
      const axisIndex = { x: 0, y: 1, z: 2 } as const;
      const lateralAxis = axisIndex[CFG.model.wheelLateral];
      const longAxis = axisIndex[CFG.model.wheelLongitudinal];
      const midLateral = (wheelBox.min.getComponent(lateralAxis) + wheelBox.max.getComponent(lateralAxis)) / 2;
      const midLong = (wheelBox.min.getComponent(longAxis) + wheelBox.max.getComponent(longAxis)) / 2;
      spinAxis.set(CFG.model.wheelAxis === "x" ? 1 : 0, CFG.model.wheelAxis === "y" ? 1 : 0, CFG.model.wheelAxis === "z" ? 1 : 0);
      splitTargets.forEach((mesh) => {
        splitWheels(mesh, midLateral, midLong, lateralAxis, longAxis).forEach((part, key) => {
          const material = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.Material;
          const m = new THREE.Mesh(part.geometry, material);
          m.matrixAutoUpdate = false;
          m.frustumCulled = false;
          // 必须挂在原来的父节点下：模型原始坐标是 Z 轴朝上，靠父节点的 -90° 旋转才立起来，
          // 直接挂到场景根上会少了这层旋转，轮子就会飘到车顶上方。
          (mesh.parent ?? car).add(m);
          const { x, y, z } = part.center;
          if (!wheelPivots[key]) wheelPivots[key] = [];
          wheelPivots[key].push({
            mesh: m,
            angle: 0,
            rot: new THREE.Matrix4(),
            t1: new THREE.Matrix4().makeTranslation(x, y, z),
            t2: new THREE.Matrix4().makeTranslation(-x, -y, -z)
          });
        });
        mesh.visible = false;
      });

      buildShardField(car);
      loadDone += 1;
      reportProgress();
      resize();
      render(progress(), 1 / 60);
    },
    undefined,
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err ?? "");
      options.onError?.(message || "模型加载失败");
    }
  );

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
  const camState = { az: CAM_KEYS[0].az, r: CAM_KEYS[0].r, h: CAM_KEYS[0].h, ty: CAM_KEYS[0].ty, tz: CAM_KEYS[0].tz, fov: CAM_KEYS[0].fov, fovEff: CAM_KEYS[0].fov };
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
  let racing = false;
  let racingAmt = 0;   // 冲刺状态的平滑量：镜头、轮胎、光条都跟它走
  let carTravel = 0;   // 冲刺时车沿隧道开走的距离
  let lastRacing = false;
  let userYaw = 0;
  let userYawVel = 0;
  // 用户缩放：滚轮（⌘/Ctrl + 滚轮或触控板捏合）与按钮都改这个倍率，用来放大看细节
  const MIN_ZOOM = CFG.zoom.min;
  const MAX_ZOOM = CFG.zoom.max;
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

  function render(p: number, dt = 0.016) {
    elapsed += dt;

    // 环境：夜 → 昼（窗口与强度由 preset 给；参考视频里整段 hero 都是夜景，只在收尾略微提亮）
    const envWeight = seg(p, CFG.environment.nightToDay[0], CFG.environment.nightToDay[1]) * CFG.environment.dayIntensity;
    updateEnv(envWeight);
    const day = envWeight;
    // 参考图里冲刺时车身反而更亮：速度越高，暖色轮廓光与主光一起加码
    const speedLight = clamp(speed / CFG.speed.maxSpeed, 0, 1) ** 2;
    keyLight.intensity = 0.78 + day * 0.42 + speedLight * 0.18;
    rimLight.intensity = 0.82 + day * 0.3 + seg(p, 0.42, 0.5) * 0.18 + speedLight * 0.45;
    fillLight.intensity = 0.36 + day * 0.24 + speedLight * 0.08;

    // 速度只由冲刺（按住空格 / 按住按钮）驱动：参考视频里滚动的过程中表一直是 000，
    // 只有在发车后才爬升，松开后回落 —— 滚动只负责镜头与舞台。
    const targetSpeed = racing ? CFG.speed.maxSpeed * 1.02 : 0;
    speed += (targetSpeed - speed) * clamp(dt * (racing ? 2.4 : 1.6), 0, 1);
    const sp = clamp(speed / CFG.speed.maxSpeed, 0, 1);
    racingAmt += ((racing ? 1 : 0) - racingAmt) * clamp(dt * 2.2, 0, 1);
    if (racing !== lastRacing) {
      lastRacing = racing;
      options.onRacing?.(racing);
    }

    // 相机
    camAt(p);
    // 拖拽环视：角度直接跟手，松手后带着惯性继续转，可以无限圈 360° 环视
    if (!dragging) {
      userYaw += userYawVel * dt * 60;
      userYawVel *= Math.pow(0.93, dt * 60);
      if (Math.abs(userYawVel) < 0.0004) userYawVel = 0;
    }
    zoom += (zoomTarget - zoom) * clamp(dt * 8, 0, 1);
    // 冲刺时镜头顺隧道方向跟随：方位角平滑绕到车尾正后方，机位与注视点随车往隧道深处推进，
    // 因此消失点始终在画面中心，车开走时不会被甩到画面外。
    const azBase = camState.az + userYaw;
    const azDelta = ((180 - azBase + 540) % 360) - 180;
    const az = ((azBase + azDelta * racingAmt * 0.85) * Math.PI) / 180;
    const follow = carTravel * racingAmt;
    // 竖屏 / 窄屏时水平视野会变窄，这里按宽高比把相机拉远、视角放宽，保证整车进画面
    const fitAspect = CFG.camera.fitMinAspect;
  const fit = camera.aspect < fitAspect ? clamp(fitAspect / camera.aspect, 1, CFG.camera.fitMaxPullback) : 1;
    const r = (camState.r - sp * 1.5) * Math.pow(fit, 0.8) * zoom;
    const h = camState.h - sp * 0.22;
    camPos.set(Math.sin(az) * r, Math.max(0.35, h), Math.cos(az) * r + follow * 0.55);
    lookAt.set(0, camState.ty + sp * 0.05, camState.tz + follow * 0.62);
    camState.fovEff = camState.fov * Math.pow(fit, 0.45);

    // fbm 晃动：三个轴各自随机错开频率，高速才明显
    const shakeAmp = reduced ? 0 : (sp * sp * CFG.camera.shakeAmount + 0.02) * 0.6;
    shakeTarget.set(
      fbm2(elapsed * 0.5 + SHAKE_SEED[0], 3.1) * shakeAmp,
      fbm2(elapsed * 0.5 + SHAKE_SEED[1], 7.7) * shakeAmp * 0.8,
      fbm2(elapsed * 0.5 + SHAKE_SEED[2], 11.3) * shakeAmp * 0.6
    );
    shakeOffset.lerp(shakeTarget, clamp(dt * CFG.camera.shakeSmoothing, 0, 1));
    camera.position.copy(camPos).add(shakeOffset);
    camera.lookAt(lookAt);
    if (Math.abs(camera.fov - camState.fovEff) > 0.02) {
      camera.fov += (camState.fovEff - camera.fov) * clamp(dt * 3, 0, 1);
      camera.updateProjectionMatrix();
    }

    // 车：加速时下沉、轻微前倾，轮胎自转
    // 冲刺时车顺着隧道开走（镜头锁定，车越来越小），松开后回到原位
    carTravel += (racingAmt * CFG.speed.launchTravel - carTravel) * clamp(dt * 1.1, 0, 1);
    carRoot.position.z = carTravel;
    carRoot.position.y = Math.sin(elapsed * 0.7) * 0.004 - sp * 0.022;
    carRoot.rotation.z = -sp * 0.014;
    carRoot.rotation.y = Math.sin(elapsed * 0.25) * 0.006 + sp * 0.02;
    // 轮胎只在冲刺（按住空格 / 按住按钮）时转，纯滚动浏览时保持静止
    const spin = speed * 0.62 * dt * racingAmt;
    contact.position.z = carTravel;   // 接触阴影跟着车走，不然车会像浮在空中
    wheelPivots.forEach((parts) =>
      parts.forEach((w) => {
        w.angle -= spin;
        w.rot.makeRotationAxis(spinAxis, w.angle);
        w.mesh.matrix.copy(w.t1).multiply(w.rot).multiply(w.t2);
        w.mesh.matrixWorldNeedsUpdate = true;
      })
    );
    bodyMaterials.forEach((m) => {
      m.envMapIntensity = 1.25 - sp * 0.3;
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
    floorUniforms.uFlow.value = sps * sps;
    floorUniforms.uReflectIntensity.value = CFG.ground.reflectIntensity + sps * 0.2;
    flowUniforms.uFlowTime.value = elapsed;
    flowUniforms.uFlowStrength.value = sps * sps * 0.6;
    tunnelUniforms.uTime.value = elapsed;
    tunnelUniforms.uSpeed.value = reduced ? 0 : speed;
    tunnelUniforms.uOpacity.value = 0.46 + sps * 0.3;
    tunnel2Uniforms.uTime.value = elapsed * 0.75;
    tunnel2Uniforms.uSpeed.value = reduced ? 0 : speed * 0.8;
    tunnel2Uniforms.uOpacity.value = sps * 0.35;
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
    }
    (pool.material as THREE.MeshBasicMaterial).opacity = CFG.ground.pool + sps * 0.1;
    if (ring) ring.visible = p > 0.12 || sps > 0.05;
    const tunnelOn = !!CFG.speed.tunnel && speed > 0.6 && !off.has("tunnel");
    if (tunnel) tunnel.visible = tunnelOn;
    if (accent) accent.visible = tunnelOn;

    // 主光条：只在有速度时出现（滚动浏览时表是 0，不会亮）
    if (sps > 0.04) {
      // 车的屏幕包围盒：车心 ± 车身方向半长、± 车高一半，投影后取半尺寸
      const halfLength = CFG.model.length / 2;
      carHalfA.set(-halfLength, 0.4, 0).applyMatrix4(carRoot.matrixWorld).project(camera);
      carHalfB.set(halfLength, 0.4, 0).applyMatrix4(carRoot.matrixWorld).project(camera);
      carHalfC.set(0, 0.4 + 0.8, 0).applyMatrix4(carRoot.matrixWorld).project(camera);
      carHalfD.set(0, 0.4 - 0.85, 0).applyMatrix4(carRoot.matrixWorld).project(camera);
      const cx = (carHalfA.x + carHalfB.x) / 4 + 0.5;
      const cy = (-(carHalfA.y + carHalfB.y) / 4) * 0.5 + 0.5;
      const hx = Math.abs(carHalfB.x - carHalfA.x) / 4 + 0.012;
      const hy = Math.abs(carHalfC.y - carHalfD.y) / 4 + 0.02;
      (lightLinesPass.uniforms.uCarBox.value as THREE.Vector4).set(cx, cy, hx, hy);
    }
    lightLinesPass.uniforms.uTime.value = elapsed;
    lightLinesPass.uniforms.uSpeed.value = reduced ? 0 : speed;
    lightLinesPass.uniforms.uStrength.value = sps * sps;
    lightLinesPass.enabled = sps > 0.04;   // 静止段整趟跳过，省一层全屏后期

    // 后期：拖影只在高速时才有意义，静止段直接关掉这一整趟全屏后期
    smearPass.uniforms.uChroma.value = sps * CFG.post.smearChroma;
    smearPass.uniforms.uTime.value = elapsed;
    const smear = sps * sps * CFG.post.smearStrength;
    smearPass.uniforms.uStrength.value = smear;
    smearPass.enabled = smear > 0.004;
    bloom.strength = CFG.post.bloomStrength + sps * CFG.post.bloomSpeedBoost;
    bloom.radius = CFG.post.bloomRadius + sps * 0.14;
    scene.backgroundIntensity = 0.85 + day * 0.35;

    // HUD
    const kmh = Math.round(clamp(speed / CFG.speed.maxSpeed, 0, 1.02) * CFG.speed.topKmh);
    if (hud.kmh) hud.kmh.textContent = String(kmh).padStart(3, "0");
    if (hud.gear) hud.gear.textContent = speed < 0.4 ? "N" : String(clamp(1 + Math.floor(sp * 8.9), 1, 8));
    const lit = speed < 0.4 ? 0 : Math.round(clamp(3 + sp * (hud.rpmTicks.length - 3) + fbm2(elapsed * 6, 2) * 1.2, 0, hud.rpmTicks.length));
    hud.rpmTicks.forEach((t, i) => t.classList.toggle("on", i < lit));
    const ers = clamp(62 + sp * 30 + Math.sin(elapsed * 2.4) * 6, 0, 100);
    if (hud.ersBar) hud.ersBar.style.width = `${ers.toFixed(0)}%`;
    if (hud.ersText) hud.ersText.textContent = `${ers.toFixed(0)}%`;
    if (hud.teleFoot) hud.teleFoot.textContent = sps > 0.25 ? "LIVE DATA · DEPLOYING" : "LIVE DATA";
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
    if (hud.mark) {
      hud.mark.style.transform = `translate(-50%, -50%) scale(${1 + p * 0.1 + sps * 0.04})`;
      hud.mark.style.opacity = String(0.75 + sps * 0.5);
    }
    hud.raceBtn?.classList.toggle("on", racing);

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
      part.el.style.left = `${x.toFixed(1)}px`;
      part.el.style.top = `${y.toFixed(1)}px`;
      part.el.style.opacity = String(clamp(vis, 0, 1));
    });

    updateReflection();
    composer.render();
  }

  function resize() {
    let w = canvas.clientWidth || hud.stage.clientWidth || window.innerWidth;
    let h = canvas.clientHeight || hud.stage.clientHeight || window.innerHeight;
    // 关键防线：显示器休眠/唤醒、窗口最小化还原时，浏览器可能在一帧里给出 0 或 NaN 的尺寸，
    // 一旦让它写进 camera.aspect，投影矩阵就会变成 Infinity/NaN，
    // 再经 HalfFloat 后期放大成一整屏白（GPU 把 NaN 写成 255）。这里直接拒绝异常尺寸。
    if (!Number.isFinite(w) || !Number.isFinite(h) || w < 2 || h < 2) return;
    w = Math.round(w);
    h = Math.round(h);
    budgetedScale = budgetRatio(w, h, wantedScale);
    if (renderScale > budgetedScale) {
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
    (lightLinesPass.uniforms.uAspect.value as number) = w / h;
  }

  /**
   * 自适应渲染倍率：先按设备像素比开画，随后按实测帧耗时微调。
   * 帧耗时偏高就降倍率（最低 0.75），长时间流畅再慢慢升回去（最高 1.6），
   * 这样高分屏与集成显卡都能保住流畅度。
   */
  const wantedScale = Math.min(window.devicePixelRatio || 1, 1.5);
  let renderScale = Math.min(wantedScale, 1.25);
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
    frameCost += frameMs;
    frameSamples += 1;
    if (frameSamples < 20) return;
    const now = performance.now();
    if (now - lastAdapt < 700) return;
    const avg = frameCost / frameSamples;
    frameCost = 0;
    frameSamples = 0;
    lastAdapt = now;
    // 只在明显掉帧时降、长时间很稳才升，避免来回抖动反复重建 RT（那也是显存压力来源）
    if (avg > 26 && renderScale > 0.75) {
      renderScale = Math.max(0.75, renderScale - 0.25);
    } else if (avg > 19 && renderScale > 0.75) {
      renderScale = Math.max(0.75, renderScale - 0.15);
    } else if (avg < 11 && renderScale < Math.min(wantedScale, budgetedScale)) {
      renderScale = Math.min(wantedScale, budgetedScale, renderScale + 0.1);
    } else {
      return;
    }
    if (qualityChanges > 6) return;
    qualityChanges += 1;
    if (qualityHud) {
      qualityHud.innerHTML = [
        `${avg.toFixed(1)} ms · ${renderScale.toFixed(2)}x`,
        `buffer ${canvas.width}×${canvas.height} · reflect ${reflectRT.width}`,
        `tex ${renderer.info.memory.textures} · geo ${renderer.info.memory.geometries}`
      ].join("<br>");
    }
    renderer.setPixelRatio(renderScale);
    composer.setPixelRatio(renderScale);
    // 反射贴图也跟着倍率走：帧耗时偏高时它同样是最贵的一项
    const base = CFG.ground.reflectionSize;
    const reflectSize = Math.round(clamp(base * (renderScale + 0.4), base * 0.62, base * 1.25));
    if (reflectSize !== reflectRT.width) reflectRT.setSize(reflectSize, reflectSize);
    resize();
  }

  /** 滚动进度：用「滚动容器已经划过多少」来算，粘性舞台高度变化时自动正确 */
  function progress() {
    const total = hud.scroll.offsetHeight - hud.stage.offsetHeight;
    if (total <= 0) return 0;
    const top = hud.scroll.getBoundingClientRect().top;
    return clamp(-top / total, 0, 1);
  }

  /* ---------- 8) 交互：按住冲刺 / 拖拽环视 ---------- */
  const press = (on: boolean) => {
    racing = on;
  };
  const onRaceDown = (e: Event) => {
    e.preventDefault();
    press(true);
  };
  const onPointerUp = () => press(false);
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
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onPointerUp);
  cleanups.push(() => {
    hud.raceBtn?.removeEventListener("pointerdown", onRaceDown);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", onPointerUp);
  });

  let dragging = false;
  let dragX = 0;
  const onCanvasDown = (e: PointerEvent) => {
    dragging = true;
    dragX = e.clientX;
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!dragging) return;
    const dx = e.clientX - dragX;
    dragX = e.clientX;
    userYaw -= dx * 0.3;
    userYawVel = -dx * 0.3;
  };
  const onDragEnd = () => {
    dragging = false;
  };
  canvas.addEventListener("pointerdown", onCanvasDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onDragEnd);
  cleanups.push(() => {
    canvas.removeEventListener("pointerdown", onCanvasDown);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onDragEnd);
  });

  // 缩放：⌘/Ctrl + 滚轮（触控板捏合同样走这里）、按钮、双击复位
  const applyZoom = (factor: number) => {
    zoomTarget = clamp(zoomTarget * factor, MIN_ZOOM, MAX_ZOOM);
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
    if (!withModifier && !zoomMode) return;
    e.preventDefault();
    // 往下滚 = 拉远，往上滚 / 双指张开 = 推近看细节
    applyZoom(Math.exp(e.deltaY * CFG.zoom.wheelStep));
  };
  const onDoubleClick = () => {
    zoomTarget = 1;
    setZoomMode(false);
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
  const touches = new Map<number, { x: number; y: number }>();
  let pinchStart = 0;
  const onTouchDown = (e: PointerEvent) => {
    if (e.pointerType !== "touch") return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 2) pinchStart = zoomTarget;
  };
  const pointerDistance = () => {
    const [a, b] = [...touches.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };
  let pinchBase = 0;
  const onTouchMove = (e: PointerEvent) => {
    if (e.pointerType !== "touch" || !touches.has(e.pointerId)) return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size !== 2) return;
    const d = pointerDistance();
    if (!pinchBase) {
      pinchBase = d;
      return;
    }
    zoomTarget = clamp(pinchStart * (pinchBase / d), MIN_ZOOM, MAX_ZOOM);
  };
  const onTouchEnd = (e: PointerEvent) => {
    if (e.pointerType !== "touch") return;
    touches.delete(e.pointerId);
    if (touches.size < 2) pinchBase = 0;
  };
  canvas.addEventListener("pointerdown", onTouchDown);
  canvas.addEventListener("pointermove", onTouchMove);
  canvas.addEventListener("pointerup", onTouchEnd);
  canvas.addEventListener("pointercancel", onTouchEnd);
  cleanups.push(() => {
    canvas.removeEventListener("pointerdown", onTouchDown);
    canvas.removeEventListener("pointermove", onTouchMove);
    canvas.removeEventListener("pointerup", onTouchEnd);
    canvas.removeEventListener("pointercancel", onTouchEnd);
  });

  /* ---------- 9) 上下文丢失 / 恢复 ---------- */
  // 显存吃紧或驱动回收时 WebGL 上下文会丢，画面会变成白板。
  // 这里接管事件：丢失时阻止默认行为以便恢复，恢复或连续报错时让上层重建场景。
  const onContextLost = (e: Event) => {
    e.preventDefault();
    options.onContextLost?.();
  };
  const onContextRestored = () => {
    options.onContextLost?.();
  };
  canvas.addEventListener("webglcontextlost", onContextLost);
  canvas.addEventListener("webglcontextrestored", onContextRestored);
  cleanups.push(() => {
    canvas.removeEventListener("webglcontextlost", onContextLost);
    canvas.removeEventListener("webglcontextrestored", onContextRestored);
  });
  let renderErrors = 0;

  /**
   * 自愈看门狗：GPU 驱动回收上下文时会留下整屏发白（或全黑）的画面，
   * 这里每隔约 1.5 秒回读 5 个点（中心与四角），连续 3 次都异常就通知上层重建场景。
   * 正常画面（哪怕在最亮的高速段）不会 5 个点同时接近纯白，因此不会误判。
   */
  const gl = renderer.getContext();
  const probe = new Uint8Array(4);
  let badFrames = 0;
  let softTries = 0;
  let lastProbe = performance.now();
  function watchdog() {
    const now = performance.now();
    if (now - lastProbe < 1500) return;
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
      if (badFrames >= 3) {
        badFrames = 0;
        if (softTries < 2) {
          // 先做一次“软恢复”：多数白屏是尺寸/投影矩阵被写坏，重新算一次尺寸就能回来
          softTries += 1;
          resize();
        } else {
          softTries = 0;
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
  let pSmooth = 0;
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
    // 滚动进度先做一阶平滑：鼠标滚轮的台阶感不会直接传到镜头上，整体才顺
    const target = progress();
    pSmooth += (target - pSmooth) * clamp(dt * 6, 0, 1);
    if (Math.abs(target - pSmooth) < 0.0002) pSmooth = target;
    adaptQuality(frameMs);
    try {
      render(pSmooth, dt);
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
      resize();
      render(pSmooth, 1 / 60);
    }
  };
  document.addEventListener("visibilitychange", onVisible);
  cleanups.push(() => document.removeEventListener("visibilitychange", onVisible));

  const ro = new ResizeObserver(() => resize());
  ro.observe(canvas);
  cleanups.push(() => ro.disconnect());

  // 先加载环境贴图，再启动，避免首帧全黑
  const hdr = new HDRLoader();
  Promise.all([hdr.loadAsync(CFG.assets.envDay), hdr.loadAsync(CFG.assets.envNight)])
    .then(([day, night]) => {
      day.mapping = night.mapping = THREE.EquirectangularReflectionMapping;
      envMixMat.uniforms.uEnv1.value = night;
      envMixMat.uniforms.uEnv2.value = day;
      envReady = true;
      updateEnv(0);
      loadDone += 2;
      reportProgress();
      resize();
      render(progress(), 1 / 60);
    })
    .catch((err) => options.onError?.(`环境贴图加载失败：${String(err?.message ?? err)}`));

  resize();

  return {
    dispose: () => {
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
      reflectRT.dispose();
      envTarget.dispose();
      envPmrem?.dispose();
      pmrem.dispose();
      backdrop.dispose();
      renderer.dispose();
      try {
        renderer.forceContextLoss();
      } catch {
        /* 上下文可能已经被驱动回收，忽略 */
      }
    },
    setProgress: (p: number, settle = 0) => {
      const steps = Math.max(1, Math.round(settle * 60));
      for (let i = 0; i < steps; i += 1) render(p, 1 / 60);
      render(p, 1 / 60);
    },
  debug: () => ({
    progress: +pSmooth.toFixed(3),
    speed: +speed.toFixed(2),
    scale: renderScale,
    racing,
    travel: +carTravel.toFixed(2),
    zoom: +zoom.toFixed(2),
    buffer: [canvas.width, canvas.height],
    reflection: reflectRT.width,
    textures: renderer.info.memory.textures,
    geometries: renderer.info.memory.geometries
  })
};
}
