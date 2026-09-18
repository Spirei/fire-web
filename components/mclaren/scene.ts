/**
 * 首页迈凯伦（F1）滚动叙事场景。
 *
 * 实现思路来自 alphardex 的 SU7 展示站还原心得与 su7-replica 源码：
 * 1) FBO 全屏四边形把两张 HDR 环境贴图 mix 起来（夜 → 昼），结果既当环境反射又不用额外灯光；
 * 2) 平面反射 + 法线扰动 + 菲涅尔混合 + 粗糙度控制模糊的地面；
 * 3) 速度线隧道：纯片元着色器（噪声沿轴向拉长 → 取尖峰勾细线 → 随机颜色），配合 Bloom；
 * 4) fbm 相机晃动、随速度增强的流光与 Bloom、轮胎自转，全部由同一个速度变量驱动；
 * 5) 滚动进度 p 是唯一输入，换成任意 glb 都能复用。
 *
 * 这个文件只在浏览器里被动态 import，不会进入首屏包。
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { HDRLoader } from "three/addons/loaders/HDRLoader.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { MCL_PARTS, MCL_PHASES } from "./phases";

const CONFIG = {
  model: "/mclaren/mcl35m.glb",
  envNight: "/mclaren/moonless_golf_1k.hdr",
  envDay: "/mclaren/studio_small_09_1k.hdr",
  /** 归一化后的车长（米） */
  length: 5.6,
  /** 内部速度上限，对应 355 km/h */
  maxSpeed: 34,
  topKmh: 355
};

export interface McLarenHud {
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
  /** 部件标注元素（位置由本文件每帧投影更新） */
  labels: { el: HTMLElement; from: number; pos: [number, number, number] }[];
}

export interface McLarenSceneOptions {
  canvas: HTMLCanvasElement;
  hud: McLarenHud;
  /** 加载进度 0–1（模型 + 环境贴图） */
  onProgress?: (ratio: number) => void;
  /** 就绪（可以隐藏 loading） */
  onReady?: () => void;
  /** 章节切换 */
  onPhase?: (index: number) => void;
  onError?: (message: string) => void;
}

export interface McLarenSceneHandle {
  dispose: () => void;
  /** 手动设置滚动进度（调试 / 截图用） */
  setProgress: (p: number, settle?: number) => void;
  /** 调试用：当前平滑后的进度、速度与自适应倍率 */
  debug: () => { progress: number; speed: number; scale: number };
}

export function createMcLarenScene(options: McLarenSceneOptions): McLarenSceneHandle {
  const { canvas, hud } = options;
  const cleanups: Array<() => void> = [];
  const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  // 排查性能用：?mcloff=reflect,bloom,tunnel,floor,car 可逐项关掉效果（只影响诊断，不影响正常访问）
  const off =
    typeof location !== "undefined"
      ? new Set((new URLSearchParams(location.search).get("mcloff") || "").split(",").filter(Boolean))
      : new Set<string>();

  /* ---------- 渲染器 / 相机 ---------- */
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.16;
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
  const reflectRT = new THREE.WebGLRenderTarget(512, 512, { generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
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
    const tunnelWas = tunnel.visible;
    const accentWas = accent.visible;
    floor.visible = false;
    groundFx.visible = false;
    tunnel.visible = false;      // 速度线不参与地面反射，否则整块地面会被照亮成一片白
    accent.visible = false;
    renderer.setRenderTarget(reflectRT);
    renderer.clear();
    renderer.render(scene, mirrorCamera);
    renderer.setRenderTarget(prevTarget);
    floor.visible = true;
    groundFx.visible = true;
    tunnel.visible = tunnelWas;
    accent.visible = accentWas;
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

  /** 车周围的椭圆刻度环，带扫掠高亮 */
  const RING_COUNT = 190;
  const RING_A = 5.5;
  const RING_B = 2.55;
  const ringUniforms = {
    uSweep: { value: 0 },
    uSpeed: { value: 0 },
    uTime: { value: 0 },
    uColor: { value: new THREE.Color(0xffb070) }
  };
  const ringGeo = new THREE.BoxGeometry(0.028, 0.004, 0.2);
  const ringMat = new THREE.ShaderMaterial({
    uniforms: ringUniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: `
      attribute float aIndex;
      varying float vIndex;
      void main(){
        vIndex = aIndex / ${RING_COUNT}.0;
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform float uSweep; uniform float uSpeed; uniform float uTime; uniform vec3 uColor;
      varying float vIndex;
      void main(){
        float diff = abs(fract(vIndex - uSweep + 0.5) - 0.5) * 2.0;   // 环上的角距离
        float glow = pow(1.0 - clamp(diff, 0.0, 1.0), 7.0);
        float flick = 0.85 + 0.15 * sin(uTime * 3.0 + vIndex * 90.0);
        float a = (0.1 + glow * 0.95) * flick * (0.75 + uSpeed * 0.6);
        gl_FragColor = vec4(uColor * (0.7 + glow * 1.6), a);
      }`
  });
  const ring = new THREE.InstancedMesh(ringGeo, ringMat, RING_COUNT);
  {
    const m = new THREE.Matrix4();
    const idx = new Float32Array(RING_COUNT);
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const zAxis = new THREE.Vector3(0, 0, 1);
    for (let i = 0; i < RING_COUNT; i += 1) {
      const a = (i / RING_COUNT) * Math.PI * 2;
      pos.set(Math.sin(a) * RING_A, 0.012, Math.cos(a) * RING_B);
      const tangent = new THREE.Vector3(Math.cos(a) * RING_A, 0, -Math.sin(a) * RING_B).normalize();
      quat.setFromUnitVectors(zAxis, tangent);
      m.compose(pos, quat, new THREE.Vector3(1, 1, i % 5 === 0 ? 2.1 : 1));
      ring.setMatrixAt(i, m);
      idx[i] = i;
    }
    ringGeo.setAttribute("aIndex", new THREE.InstancedBufferAttribute(idx, 1));
    ring.instanceMatrix.needsUpdate = true;
  }
  ring.renderOrder = 3;
  ring.frustumCulled = false;
  groundFx.add(ring);

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
  const streakFrag = `
    uniform float uTime; uniform float uSpeed; uniform float uOpacity; uniform vec3 uTint; uniform sampler2D tNoise;
    varying vec2 vUv;
    void main(){
      // 噪声贴图沿隧道轴拉伸并滚动：x 方向密、y 方向疏，就得到放射状速度线
      vec2 nUv = vec2(vUv.x * 34.0, vUv.y * 0.7 - uTime * (0.15 + uSpeed * 0.035));
      vec3 s = texture2D(tNoise, nUv).rgb;
      float mask = smoothstep(0.8, 0.97, s.r);
      vec3 col = mix(vec3(1.0, 0.62, 0.28), vec3(0.5, 0.62, 1.9) * (0.7 + s.b), step(0.6, s.g));
      col *= uTint;
      mask *= smoothstep(0.0, 0.16, vUv.y) * smoothstep(0.0, 0.16, 1.0 - vUv.y);
      mask *= smoothstep(0.0, 0.1, vUv.x) * smoothstep(0.0, 0.1, 1.0 - vUv.x);
      mask *= smoothstep(2.0, 12.0, uSpeed);
      gl_FragColor = vec4(col * 1.9, mask * uOpacity);
    }`;
  const tunnelUniforms = {
    uTime: { value: 0 },
    uSpeed: { value: 0 },
    uOpacity: { value: 0 },
    uTint: { value: new THREE.Color(1, 1, 1) },
    tNoise: { value: streakNoise }
  };
  const tunnel = new THREE.Mesh(
    new THREE.CylinderGeometry(26, 26, 120, 64, 1, true),
    new THREE.ShaderMaterial({
      uniforms: tunnelUniforms,
      vertexShader: streakVert,
      fragmentShader: streakFrag,
      transparent: true,
      side: THREE.BackSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    })
  );
  tunnel.rotation.x = Math.PI / 2;   // 圆柱轴对齐车长方向（Z）
  tunnel.frustumCulled = false;
  scene.add(tunnel);

  const tunnel2Uniforms = {
    uTime: { value: 0 },
    uSpeed: { value: 0 },
    uOpacity: { value: 0 },
    uTint: { value: new THREE.Color(1.6, 0.85, 0.45) },
    tNoise: { value: streakNoise }
  };
  const accent = new THREE.Mesh(
    new THREE.CylinderGeometry(19, 19, 120, 48, 1, true),
    new THREE.ShaderMaterial({
      uniforms: tunnel2Uniforms,
      vertexShader: streakVert,
      fragmentShader: streakFrag,
      transparent: true,
      side: THREE.BackSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    })
  );
  accent.rotation.set(Math.PI / 2, 0, 0.35);
  accent.frustumCulled = false;
  scene.add(accent);

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
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(smearPass);
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.42, 0.62, 0.85);
  bloom.enabled = !off.has("bloom");
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  if (off.has("floor")) floor.visible = false;

  /* ---------- 6) 模型 ---------- */
  const carRoot = new THREE.Group();
  scene.add(carRoot);
  const wheelPivots: Array<
    Array<{ mesh: THREE.Mesh; angle: number; rot: THREE.Matrix4; t1: THREE.Matrix4; t2: THREE.Matrix4 }>
  > = [];
  const bodyMaterials: THREE.MeshStandardMaterial[] = [];

  /** 合并网格里一个材质覆盖四个轮子，按三角面质心聚类拆成四个独立的轮子 */
  function splitWheels(mesh: THREE.Mesh, midX: number, midY: number) {
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
      const cx = (a.x + b.x + c.x) / 3;
      const cy = (a.y + b.y + c.y) / 3;
      const key = (cx > midX ? 1 : 0) + (cy > midY ? 2 : 0);
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

  const loadTotal = 3;   // 两个 HDR + 一个模型
  let loadDone = 0;
  const reportProgress = (partial = 0) => {
    options.onProgress?.(Math.min(1, (loadDone + partial) / loadTotal));
    if (loadDone >= loadTotal) options.onReady?.();
  };

  new GLTFLoader().load(
    CONFIG.model,
    (gltf) => {
      const car = gltf.scene;
      car.visible = !off.has("car");
      const box = new THREE.Box3().setFromObject(car);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const scale = CONFIG.length / Math.max(size.x, size.y, size.z);
      car.scale.setScalar(scale);
      car.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);

      const splitTargets: THREE.Mesh[] = [];
      car.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.frustumCulled = false;
        const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial;
        const name = mat?.name || "";
        // 修正贴图模型自带的材质参数：轮胎不该是金属，碳纤维别太像镜子
        if (mat?.isMeshStandardMaterial) {
          if (/tread|tyrewall/i.test(name)) {
            mat.metalness = 0;
            mat.roughness = 0.85;
          } else if (/rim/i.test(name)) {
            mat.metalness = 1;
            mat.roughness = 0.28;
          } else if (/mcl35m_c/i.test(name)) {
            mat.metalness = 0.35;
            mat.roughness = 0.42;
          }
          mat.envMapIntensity = 1.25;
          addFlow(mat);
          bodyMaterials.push(mat);
        }
        if (/rim|tread|tyre/i.test(name) && !/st_wheel/i.test(name)) splitTargets.push(mesh);
      });
      carRoot.add(car);

      // 拆轮子：几何体不动，用「平移到轮心 → 旋转 → 平移回去」的矩阵让每个轮子绕自己的轴自转
      const wheelBox = new THREE.Box3();
      splitTargets.forEach((m) =>
        wheelBox.union(new THREE.Box3().setFromBufferAttribute(m.geometry.attributes.position as THREE.BufferAttribute))
      );
      const midX = (wheelBox.min.x + wheelBox.max.x) / 2;
      const midY = (wheelBox.min.y + wheelBox.max.y) / 2;
      splitTargets.forEach((mesh) => {
        splitWheels(mesh, midX, midY).forEach((part, key) => {
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
  const CAM_KEYS = [
    { p: 0, az: 46, r: 11.9, h: 2.1, ty: 0.92, tz: 0.2, fov: 30 },
    { p: 0.12, az: 60, r: 10.7, h: 1.75, ty: 0.85, tz: 0.2, fov: 30 },
    { p: 0.28, az: 134, r: 9.1, h: 1.05, ty: 0.74, tz: 0.1, fov: 29 },
    { p: 0.4, az: 172, r: 8.3, h: 0.95, ty: 0.62, tz: 0.75, fov: 27 },
    { p: 0.52, az: 194, r: 8.8, h: 0.8, ty: 0.6, tz: 0.4, fov: 28 },
    { p: 0.68, az: 214, r: 10.6, h: 0.52, ty: 0.55, tz: -0.1, fov: 32 },
    { p: 0.84, az: 236, r: 11.2, h: 1.85, ty: 0.8, tz: 0, fov: 30 },
    { p: 1, az: 248, r: 10.6, h: 2.15, ty: 0.84, tz: 0.1, fov: 30 }
  ];
  const camState = { az: CAM_KEYS[0].az, r: CAM_KEYS[0].r, h: CAM_KEYS[0].h, ty: 0.9, tz: 0.2, fov: 30, fovEff: 30 };
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
  let userYaw = 0;
  let userYawVel = 0;
  let active = true;
  let lastPhase = -1;

  const camPos = new THREE.Vector3();
  const lookAt = new THREE.Vector3();
  const projected = new THREE.Vector3();

  function render(p: number, dt = 0.016) {
    elapsed += dt;

    // 环境：夜 → 昼（加速时保持夜色，收车后切到明亮工作室）
    const envWeight = seg(p, 0.72, 0.88);
    updateEnv(envWeight);
    const day = envWeight;
    keyLight.intensity = 0.72 + day * 0.42;
    rimLight.intensity = 0.78 + day * 0.3 + seg(p, 0.42, 0.5) * 0.2;
    fillLight.intensity = 0.32 + day * 0.24;

    // 速度：加速段 0.46→0.64 拉起，0.74→0.86 落回；按住空格 / 按钮随时冲刺
    const accel = seg(p, 0.46, 0.64);
    const decel = seg(p, 0.74, 0.86);
    const cruise = seg(p, 0.3, 0.42) * 4;
    let targetSpeed = (accel - decel) * CONFIG.maxSpeed + cruise;
    if (racing) targetSpeed = CONFIG.maxSpeed * 1.02;
    speed += (targetSpeed - speed) * clamp(dt * (racing ? 2.4 : 2), 0, 1);
    const sp = clamp(speed / CONFIG.maxSpeed, 0, 1);

    // 相机
    camAt(p);
    // 拖拽环视：角度直接跟手，松手后带着惯性继续转，可以无限圈 360° 环视
    if (!dragging) {
      userYaw += userYawVel * dt * 60;
      userYawVel *= Math.pow(0.93, dt * 60);
      if (Math.abs(userYawVel) < 0.0004) userYawVel = 0;
    }
    const az = ((camState.az + userYaw) * Math.PI) / 180;
    // 竖屏 / 窄屏时水平视野会变窄，这里按宽高比把相机拉远、视角放宽，保证整车进画面
    const fit = camera.aspect < 1.2 ? clamp(1.2 / camera.aspect, 1, 1.8) : 1;
    const r = (camState.r - sp * 1.5) * Math.pow(fit, 0.8);
    const h = camState.h - sp * 0.22;
    camPos.set(Math.sin(az) * r, Math.max(0.35, h), Math.cos(az) * r);
    lookAt.set(0, camState.ty + sp * 0.05, camState.tz);
    camState.fovEff = camState.fov * Math.pow(fit, 0.45);

    // fbm 晃动：三个轴各自随机错开频率，高速才明显
    const shakeAmp = reduced ? 0 : (sp * sp * 0.34 + 0.02) * 0.6;
    shakeTarget.set(
      fbm2(elapsed * 0.5 + SHAKE_SEED[0], 3.1) * shakeAmp,
      fbm2(elapsed * 0.5 + SHAKE_SEED[1], 7.7) * shakeAmp * 0.8,
      fbm2(elapsed * 0.5 + SHAKE_SEED[2], 11.3) * shakeAmp * 0.6
    );
    shakeOffset.lerp(shakeTarget, clamp(dt * 1.6, 0, 1));
    camera.position.copy(camPos).add(shakeOffset);
    camera.lookAt(lookAt);
    if (Math.abs(camera.fov - camState.fovEff) > 0.02) {
      camera.fov += (camState.fovEff - camera.fov) * clamp(dt * 3, 0, 1);
      camera.updateProjectionMatrix();
    }

    // 车：加速时下沉、轻微前倾，轮胎自转
    carRoot.position.y = Math.sin(elapsed * 0.7) * 0.004 - sp * 0.022;
    carRoot.rotation.z = -sp * 0.014;
    carRoot.rotation.y = Math.sin(elapsed * 0.25) * 0.006 + sp * 0.02;
    const spin = speed * 0.62 * dt;
    wheelPivots.forEach((parts) =>
      parts.forEach((w) => {
        w.angle -= spin;
        w.rot.makeRotationX(w.angle);
        w.mesh.matrix.copy(w.t1).multiply(w.rot).multiply(w.t2);
        w.mesh.matrixWorldNeedsUpdate = true;
      })
    );
    bodyMaterials.forEach((m) => {
      m.envMapIntensity = 1.25 - sp * 0.45;
    });

    // 地面 / 隧道 / 流光
    const sps = reduced ? 0 : sp;
    floorUniforms.uTime.value = elapsed;
    floorUniforms.uSpeed.value = sps;
    floorUniforms.uFlow.value = sps * sps;
    floorUniforms.uReflectIntensity.value = 0.95 + sps * 0.2;
    flowUniforms.uFlowTime.value = elapsed;
    flowUniforms.uFlowStrength.value = sps * sps * 0.6;
    tunnelUniforms.uTime.value = elapsed;
    tunnelUniforms.uSpeed.value = reduced ? 0 : speed;
    tunnelUniforms.uOpacity.value = 0.55 + sps * 0.45;
    tunnel2Uniforms.uTime.value = elapsed * 0.75;
    tunnel2Uniforms.uSpeed.value = reduced ? 0 : speed * 0.8;
    tunnel2Uniforms.uOpacity.value = sps * 0.5;
    ringUniforms.uTime.value = elapsed;
    ringUniforms.uSpeed.value = sps;
    ringUniforms.uSweep.value = elapsed * (0.05 + sps * 0.22);
    (pool.material as THREE.MeshBasicMaterial).opacity = 0.16 + sps * 0.24;
    ring.visible = p > 0.12 || sps > 0.05;
    tunnel.visible = speed > 0.6 && !off.has("tunnel");
    accent.visible = speed > 0.6 && !off.has("tunnel");

    // 后期
    // 拖影只在高速时才有意义，静止段直接关掉这一整趟全屏后期
   smearPass.uniforms.uChroma.value = sps * 0.012;
    smearPass.uniforms.uTime.value = elapsed;
    const smear = sps * sps * 0.14;
    smearPass.uniforms.uStrength.value = smear;
    smearPass.enabled = smear > 0.004;
    bloom.strength = 0.4 + sps * 0.72;
    bloom.radius = 0.62 + sps * 0.3;
    scene.backgroundIntensity = 0.85 + day * 0.35;

    // HUD
    const kmh = Math.round(clamp(speed / CONFIG.maxSpeed, 0, 1.02) * CONFIG.topKmh);
    if (hud.kmh) hud.kmh.textContent = String(kmh).padStart(3, "0");
    if (hud.gear) hud.gear.textContent = speed < 0.4 ? "N" : String(clamp(1 + Math.floor(sp * 8.9), 1, 8));
    const lit = speed < 0.4 ? 0 : Math.round(clamp(3 + sp * (hud.rpmTicks.length - 3) + fbm2(elapsed * 6, 2) * 1.2, 0, hud.rpmTicks.length));
    hud.rpmTicks.forEach((t, i) => t.classList.toggle("on", i < lit));
    const ers = clamp(62 + sp * 30 + Math.sin(elapsed * 2.4) * 6, 0, 100);
    if (hud.ersBar) hud.ersBar.style.width = `${ers.toFixed(0)}%`;
    if (hud.ersText) hud.ersText.textContent = `${ers.toFixed(0)}%`;
    if (hud.teleFoot) hud.teleFoot.textContent = sps > 0.25 ? "LIVE DATA · DEPLOYING" : "LIVE DATA";
    let phase = 0;
    for (let i = MCL_PHASES.length - 1; i >= 0; i -= 1) {
      if (p >= MCL_PHASES[i].at) {
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
      const def = MCL_PARTS[i];
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
    const w = canvas.clientWidth || hud.stage.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || hud.stage.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    // 泛光只是低频辉光，按设备像素的一半渲染，观感几乎不变但填充率省一大截
    const pr = renderer.getPixelRatio();
    bloom.setSize(Math.max(64, Math.round(w * pr * 0.5)), Math.max(64, Math.round(h * pr * 0.5)));
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  /**
   * 自适应渲染倍率：先按设备像素比开画，随后按实测帧耗时微调。
   * 帧耗时偏高就降倍率（最低 0.75），长时间流畅再慢慢升回去（最高 1.6），
   * 这样高分屏与集成显卡都能保住流畅度。
   */
  const maxScale = Math.min(window.devicePixelRatio || 1, 1.6);
  let renderScale = Math.min(maxScale, 1.25);
  let frameCost = 0;
  let frameSamples = 0;
  let lastAdapt = performance.now();
  // 调参用：地址栏加 ?mclhud=1 会在右下角显示实测帧耗时与当前渲染倍率
  const qualityHud =
    typeof location !== "undefined" && location.search.includes("mclhud")
      ? (() => {
          const el = document.createElement("div");
          el.style.cssText =
            "position:absolute;right:10px;bottom:10px;z-index:9;font:10px/1.4 ui-monospace,monospace;color:#8a8a90;background:rgba(0,0,0,.5);padding:4px 8px;border-radius:4px;pointer-events:none";
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
    if (avg > 26 && renderScale > 0.75) {
      renderScale = Math.max(0.75, renderScale - 0.25);
    } else if (avg > 19 && renderScale > 0.75) {
      renderScale = Math.max(0.75, renderScale - 0.15);
    } else if (avg < 12 && renderScale < maxScale) {
      renderScale = Math.min(maxScale, renderScale + 0.1);
    } else {
      return;
    }
    if (qualityHud) qualityHud.textContent = `${avg.toFixed(1)} ms · ${renderScale.toFixed(2)}x`;
    renderer.setPixelRatio(renderScale);
    composer.setPixelRatio(renderScale);
    // 反射贴图也跟着倍率走：帧耗时偏高时它同样是最贵的一项
    const reflectSize = Math.round(clamp(512 * (renderScale + 0.4), 320, 640));
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

  /* ---------- 9) 渲染循环：不可见时暂停 ---------- */
  let last = performance.now();
  let pSmooth = 0;
  const tick = () => {
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 0.05);
    const frameMs = now - last;
    last = now;
    if (!active || document.hidden) return;
    // 滚动进度先做一阶平滑：鼠标滚轮的台阶感不会直接传到镜头上，整体才顺
    const target = progress();
    pSmooth += (target - pSmooth) * clamp(dt * 6, 0, 1);
    if (Math.abs(target - pSmooth) < 0.0002) pSmooth = target;
    adaptQuality(frameMs);
    render(pSmooth, dt);
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

  const ro = new ResizeObserver(() => resize());
  ro.observe(canvas);
  cleanups.push(() => ro.disconnect());

  // 先加载环境贴图，再启动，避免首帧全黑
  const hdr = new HDRLoader();
  Promise.all([hdr.loadAsync(CONFIG.envDay), hdr.loadAsync(CONFIG.envNight)])
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
      renderer.forceContextLoss();
    },
    setProgress: (p: number, settle = 0) => {
      const steps = Math.max(1, Math.round(settle * 60));
      for (let i = 0; i < steps; i += 1) render(p, 1 / 60);
      render(p, 1 / 60);
    },
    debug: () => ({ progress: +pSmooth.toFixed(3), speed: +speed.toFixed(2), scale: renderScale })
  };
}
