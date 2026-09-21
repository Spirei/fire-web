import * as THREE from "three";

export type WireframeMode = "native" | "overlay" | "wireframe";
export interface WireframeTuning {
  enabled?: boolean;
  maxEdge?: number;
  maxDepth?: number;
  maxComponentTriangles?: number;
  triangleBudget?: number;
  filterThinTrim?: boolean;
  trimMaxTriangles?: number;
  trimThickness?: number;
  trimWidth?: number;
  trimLength?: number;
  cleanBaseEdges?: boolean;
  edgeThreshold?: number;
}

const DEFAULT_TUNING: Required<WireframeTuning> = {
  enabled: true,
  maxEdge: 0.14,
  maxDepth: 2,
  maxComponentTriangles: 5_000,
  triangleBudget: 1_000_000,
  filterThinTrim: true,
  trimMaxTriangles: 64,
  trimThickness: 0.04,
  trimWidth: 0.2,
  trimLength: 0.25,
  cleanBaseEdges: false,
  edgeThreshold: 12
};

// GLB 车漆常把不透明白漆也标成 transparent。若线框与这些网格都留在默认顺序，
// Three.js 会随镜头角度重新按距离排序：某些俯仰下白漆后画，把已经画好的线框盖掉。
// 统一把展示线框放到车身透明层之后；深度测试仍开启，所以不会透出背面的结构。
const WIRE_RENDER_ORDER = 8;

/** Shares the source geometry and local transform, including independently rotating wheels. */
export function createWireframeView(initialTuning?: WireframeTuning) {
  let tuning = { ...DEFAULT_TUNING, ...initialTuning };
  let mode: WireframeMode = "native";
  let color = "#00ff00";
  let root: THREE.Object3D | null = null;
  let focusFilter: ((mesh: THREE.Mesh) => boolean) | null = null;
  let tessellationBudget = tuning.triangleBudget;
  const entries: { mesh: THREE.Mesh; original: THREE.Material | THREE.Material[]; overlay: THREE.Mesh | THREE.LineSegments; mutedOverlay: THREE.Mesh; overlayGeometry?: THREE.BufferGeometry; baseGeometry?: THREE.BufferGeometry; detail?: THREE.Mesh; detailGeometry?: THREE.BufferGeometry }[] = [];
  const overlayMaterial = new THREE.MeshBasicMaterial({ wireframe: true, transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
  const overlayLineMaterial = new THREE.LineBasicMaterial({ transparent: true, depthWrite: false, toneMapped: false });
  // Offset in clip space, never inflate the mesh (which separates narrow panels / wheel parts).
  overlayMaterial.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace("#include <project_vertex>",
      "#include <project_vertex>\ngl_Position.z -= 0.00008 * gl_Position.w;");
  };
  overlayLineMaterial.onBeforeCompile = overlayMaterial.onBeforeCompile;
  const pureMaterial = new THREE.MeshBasicMaterial({ wireframe: true, transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
  pureMaterial.onBeforeCompile = overlayMaterial.onBeforeCompile;
  const pureLineMaterial = new THREE.LineBasicMaterial({ transparent: true, depthWrite: false, toneMapped: false });
  pureLineMaterial.onBeforeCompile = overlayMaterial.onBeforeCompile;
  // 未选区域直接复用“纯线框 + 浅灰”的完整三角网格路径；不能借用清边后的 overlay，
  // 否则轮胎与曲面只剩少量折边，看起来没有被线框完整包裹。
  const mutedMaterial = new THREE.MeshBasicMaterial({ wireframe: true, color: 0xcccccc, transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
  mutedMaterial.onBeforeCompile = overlayMaterial.onBeforeCompile;
  const depthMaterial = new THREE.MeshBasicMaterial({ colorWrite: false });

  /**
   * 部分导入车型把两三个超大端板三角形与几十万面的车身合在同一网格。整网格细分会爆显存，
   * 整网格跳过又会让尾翼像没被线包住。因此保留原线框，只抽出长边三角形生成局部细分层；
   * 原模型几何、UV 和材质完全不改，已经密集的车身与轮胎也不会被重复复制。
   */
  function wireGeometry(mesh: THREE.Mesh) {
    const geometry = mesh.geometry as THREE.BufferGeometry;
    const position = geometry.getAttribute("position");
    if (!position || position.count < 3) return {};
    // 蒙皮 / 变形目标依赖逐顶点权重；展示细分不插值这些属性，保持原拓扑才不会错位。
    if ((mesh as THREE.SkinnedMesh).isSkinnedMesh || Object.keys(geometry.morphAttributes).length > 0) return {};
    mesh.updateWorldMatrix(true, false);
    const scale = new THREE.Vector3();
    mesh.getWorldScale(scale);
    const worldScale = Math.max(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z), 1e-6);
    const maxEdge = tuning.maxEdge / worldScale;
    const index = geometry.getIndex();
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const triangles = index ? index.count / 3 : position.count / 3;
    let baseGeometry: THREE.BufferGeometry | undefined;
    let triangleComponents: Int32Array | undefined;
    const componentDepth = new Map<number, number>();
    const ignoredComponents = new Set<number>();
    // 端板上有些凸起装饰与主体合在同一 mesh，却是独立连通块：很薄、低面数、横跨整块面板。
    // 实体继续显示，只从线框索引中剔除，避免三条细长外轮廓看成悬空的“黄瓜”。
    if (index && position.count < 250_000) {
      const parent = new Int32Array(position.count);
      const canonical = new Int32Array(position.count);
      const positionOwner = new Map<string, number>();
      for (let i = 0; i < parent.length; i += 1) parent[i] = i;
      // MP4/6 的翼片在 UV / 法线接缝处复制了近一半顶点，同一块薄板因此在索引拓扑里
      // 被切成大量孤立三角形。只在连通性分析中按位置焊接；渲染几何、UV 与法线保持原样。
      for (let i = 0; i < position.count; i += 1) {
        a.fromBufferAttribute(position, i);
        const key = `${Math.round(a.x * 1e5)},${Math.round(a.y * 1e5)},${Math.round(a.z * 1e5)}`;
        const owner = positionOwner.get(key);
        canonical[i] = owner ?? i;
        if (owner === undefined) positionOwner.set(key, i);
      }
      const find = (value: number) => {
        let current = value;
        while (parent[current] !== current) { parent[current] = parent[parent[current]]; current = parent[current]; }
        return current;
      };
      const union = (left: number, right: number) => {
        const aRoot = find(left), bRoot = find(right);
        if (aRoot !== bRoot) parent[bRoot] = aRoot;
      };
      for (let triangle = 0; triangle < triangles; triangle += 1) {
        const ai = index.getX(triangle * 3), bi = index.getX(triangle * 3 + 1), ci = index.getX(triangle * 3 + 2);
        union(canonical[ai], canonical[bi]); union(canonical[ai], canonical[ci]);
      }
      const components = new Map<number, { triangles: number; min: THREE.Vector3; max: THREE.Vector3; longestEdgeSq: number }>();
      triangleComponents = new Int32Array(triangles);
      for (let triangle = 0; triangle < triangles; triangle += 1) {
        const ai = index.getX(triangle * 3), rootId = find(canonical[ai]);
        triangleComponents[triangle] = rootId;
        let component = components.get(rootId);
        if (!component) {
          component = { triangles: 0, min: new THREE.Vector3(Infinity, Infinity, Infinity), max: new THREE.Vector3(-Infinity, -Infinity, -Infinity), longestEdgeSq: 0 };
          components.set(rootId, component);
        }
        component.triangles += 1;
        a.fromBufferAttribute(position, ai);
        b.fromBufferAttribute(position, index.getX(triangle * 3 + 1));
        c.fromBufferAttribute(position, index.getX(triangle * 3 + 2));
        component.longestEdgeSq = Math.max(component.longestEdgeSq, a.distanceToSquared(b), b.distanceToSquared(c), c.distanceToSquared(a));
        for (let corner = 0; corner < 3; corner += 1) {
          a.fromBufferAttribute(position, index.getX(triangle * 3 + corner));
          component.min.min(a); component.max.max(a);
        }
      }
      const componentSize = new THREE.Vector3();
      for (const [rootId, component] of components) {
        componentSize.subVectors(component.max, component.min).multiplyScalar(worldScale);
        const dimensions = [componentSize.x, componentSize.y, componentSize.z].map(Math.abs).sort((x, y) => x - y);
        const isThinTrim = tuning.filterThinTrim && component.triangles <= tuning.trimMaxTriangles && dimensions[0] <= tuning.trimThickness && dimensions[1] <= tuning.trimWidth && dimensions[2] >= tuning.trimLength;
        if (isThinTrim) ignoredComponents.add(rootId);
        // Use topology rather than world-axis proportions: horizontal blades, vertical endplates and
        // curved wings all qualify as long as they are an independent, reasonably small component.
        const isSparsePart = tuning.enabled && !isThinTrim && component.triangles <= tuning.maxComponentTriangles;
        if (isSparsePart && component.longestEdgeSq > maxEdge ** 2) {
          // A whole wing component uses one quantized subdivision level. Mirrored components with tiny
          // export differences therefore receive the same topology instead of two unrelated zigzags.
          const ratio = Math.sqrt(component.longestEdgeSq) / maxEdge;
          componentDepth.set(rootId, THREE.MathUtils.clamp(Math.ceil(Math.log2(ratio)), 1, tuning.maxDepth));
        }
      }
    }
    if (tessellationBudget < 4) return { baseGeometry };
    const sparseTriangles: Array<[THREE.Vector3, THREE.Vector3, THREE.Vector3, number]> = [];
    const refinedTriangles = new Set<number>();
    const trianglesPerCandidate = 4 ** tuning.maxDepth;
    const candidateLimit = Math.max(1, Math.floor(tessellationBudget / trianglesPerCandidate));
    for (let triangle = 0; triangle < triangles && sparseTriangles.length < candidateLimit; triangle += 1) {
      const ai = index ? index.getX(triangle * 3) : triangle * 3;
      const bi = index ? index.getX(triangle * 3 + 1) : triangle * 3 + 1;
      const ci = index ? index.getX(triangle * 3 + 2) : triangle * 3 + 2;
      a.fromBufferAttribute(position, ai); b.fromBufferAttribute(position, bi); c.fromBufferAttribute(position, ci);
      const longestEdgeSq = Math.max(a.distanceToSquared(b), b.distanceToSquared(c), c.distanceToSquared(a));
      const componentId = triangleComponents?.[triangle];
      if (componentId !== undefined && ignoredComponents.has(componentId)) continue;
      const sharedDepth = tuning.enabled && componentId !== undefined ? componentDepth.get(componentId) : undefined;
      if (sharedDepth || (tuning.enabled && longestEdgeSq > maxEdge ** 2)) {
        const depth = sharedDepth ?? THREE.MathUtils.clamp(Math.ceil(Math.log2(Math.sqrt(longestEdgeSq) / maxEdge)), 1, tuning.maxDepth);
        sparseTriangles.push([a.clone(), b.clone(), c.clone(), depth]);
        refinedTriangles.add(triangle);
      }
    }
    // The generated layer replaces these source triangles; drawing both would double their boundary
    // edges and turn distant aerofoils into solid green bands.
    if (index && (ignoredComponents.size || refinedTriangles.size)) {
      const filtered: number[] = [];
      for (let triangle = 0; triangle < triangles; triangle += 1) {
        const offset = triangle * 3;
        const componentId = triangleComponents?.[triangle];
        if (refinedTriangles.has(triangle) || (componentId !== undefined && ignoredComponents.has(componentId))) continue;
        filtered.push(index.getX(offset), index.getX(offset + 1), index.getX(offset + 2));
      }
      baseGeometry = new THREE.BufferGeometry();
      for (const [name, attribute] of Object.entries(geometry.attributes)) baseGeometry.setAttribute(name, attribute);
      baseGeometry.setIndex(filtered);
    }
    if (!sparseTriangles.length) return { baseGeometry };
    // 细分后用索引几何共享相邻三角形的顶点。线框轮廓完全相同，但 MP4/6 尾翼不再为
    // 每个三角形复制三个 position，深度 2 时顶点内存通常可降到原来的约 1/3。
    const generatedPositions: number[] = [];
    const generatedIndices: number[] = [];
    const generatedVertex = new Map<string, number>();
    let emittedTriangles = 0;
    const vertexIndex = (point: THREE.Vector3) => {
      const key = `${Math.round(point.x * 1e7)},${Math.round(point.y * 1e7)},${Math.round(point.z * 1e7)}`;
      const existing = generatedVertex.get(key);
      if (existing !== undefined) return existing;
      const next = generatedPositions.length / 3;
      generatedPositions.push(point.x, point.y, point.z);
      generatedVertex.set(key, next);
      return next;
    };
    const midpoint = (p: THREE.Vector3, q: THREE.Vector3) => new THREE.Vector3().addVectors(p, q).multiplyScalar(0.5);
    const emit = (p: THREE.Vector3, q: THREE.Vector3, r: THREE.Vector3, depth: number) => {
      // 尾翼同一连通薄板固定使用相同层级；每轮四等分保持三角形形状与左右镜像关系。
      if (depth > 0 && emittedTriangles + 4 <= tessellationBudget) {
        const pq = midpoint(p, q), qr = midpoint(q, r), rp = midpoint(r, p);
        emit(p, pq, rp, depth - 1);
        emit(pq, q, qr, depth - 1);
        emit(rp, qr, r, depth - 1);
        emit(pq, qr, rp, depth - 1);
        return;
      }
      generatedIndices.push(vertexIndex(p), vertexIndex(q), vertexIndex(r));
      emittedTriangles += 1;
    };
    for (const [p, q, r, depth] of sparseTriangles) emit(p, q, r, depth);
    if (!generatedPositions.length) return { baseGeometry };
    const generated = new THREE.BufferGeometry();
    generated.setAttribute("position", new THREE.Float32BufferAttribute(generatedPositions, 3));
    generated.setIndex(generatedIndices);
    tessellationBudget -= emittedTriangles;
    return { baseGeometry, detailGeometry: generated };
  }

  function apply() {
    if (root && mode !== "native" && !entries.length) {
      const meshes: THREE.Mesh[] = [];
      root.traverse((object) => { if ((object as THREE.Mesh).isMesh) meshes.push(object as THREE.Mesh); });
      for (const mesh of meshes) {
        // Hidden source wheel meshes remain hidden; only the split wheel parts are shown.
        const wire = wireGeometry(mesh);
        const sourceGeometry = wire.baseGeometry ?? mesh.geometry;
        const overlayGeometry = tuning.cleanBaseEdges ? new THREE.EdgesGeometry(sourceGeometry, tuning.edgeThreshold) : undefined;
        const overlay = overlayGeometry
          ? new THREE.LineSegments(overlayGeometry, overlayLineMaterial)
          : mesh.clone(false);
        if (!overlayGeometry) (overlay as THREE.Mesh).geometry = sourceGeometry;
        overlay.name = "showcase-wire-overlay";
        overlay.position.set(0, 0, 0);
        overlay.quaternion.identity();
        overlay.scale.set(1, 1, 1);
        overlay.matrix.identity();
        overlay.matrixAutoUpdate = true;
        overlay.material = overlayGeometry ? overlayLineMaterial : overlayMaterial;
        overlay.renderOrder = WIRE_RENDER_ORDER;
        overlay.castShadow = false;
        overlay.receiveShadow = false;
        overlay.raycast = () => {};
        const mutedOverlay = mesh.clone(false);
        mutedOverlay.name = "showcase-wire-muted";
        mutedOverlay.geometry = mesh.geometry;
        mutedOverlay.material = mutedMaterial;
        mutedOverlay.position.set(0, 0, 0);
        mutedOverlay.quaternion.identity();
        mutedOverlay.scale.set(1, 1, 1);
        mutedOverlay.matrix.identity();
        mutedOverlay.matrixAutoUpdate = true;
        mutedOverlay.renderOrder = WIRE_RENDER_ORDER;
        mutedOverlay.castShadow = false;
        mutedOverlay.receiveShadow = false;
        mutedOverlay.raycast = () => {};
        mutedOverlay.visible = false;
        let detail: THREE.Mesh | undefined;
        if (wire.detailGeometry) {
          detail = new THREE.Mesh(wire.detailGeometry, overlayMaterial);
          detail.name = "showcase-wire-detail";
          detail.renderOrder = WIRE_RENDER_ORDER;
          detail.raycast = () => {};
          overlay.add(detail);
        }
        mesh.add(overlay);
        mesh.add(mutedOverlay);
        entries.push({ mesh, original: mesh.material, overlay, mutedOverlay, overlayGeometry, baseGeometry: wire.baseGeometry, detail, detailGeometry: wire.detailGeometry });
      }
    }
    overlayMaterial.color.set(color);
    overlayLineMaterial.color.set(color);
    pureMaterial.color.set(color);
    pureLineMaterial.color.set(color);
    for (const { mesh, original, overlay, mutedOverlay, detail } of entries) {
      const muted = focusFilter ? !focusFilter(mesh) : false;
      mesh.material = muted || mode === "wireframe" ? depthMaterial : original;
      overlay.material = overlay instanceof THREE.LineSegments
          ? mode === "wireframe" ? pureLineMaterial : overlayLineMaterial
          : mode === "wireframe" ? pureMaterial : overlayMaterial;
      if (detail) {
        detail.material = mode === "wireframe" ? pureMaterial : overlayMaterial;
        detail.visible = !muted;
      }
      overlay.visible = mode !== "native" && !muted;
      mutedOverlay.visible = mode !== "native" && muted;
    }
  }

  function detach() {
    for (const { mesh, original, overlay, mutedOverlay, overlayGeometry, baseGeometry, detailGeometry } of entries) {
      mesh.material = original;
      mesh.remove(overlay);
      mesh.remove(mutedOverlay);
      overlayGeometry?.dispose();
      baseGeometry?.dispose();
      detailGeometry?.dispose();
    }
    entries.length = 0;
    root = null;
    tessellationBudget = tuning.triangleBudget;
  }

  return {
    attach(next: THREE.Object3D) { detach(); root = next; apply(); },
    configure(next: WireframeTuning | undefined) {
      const activeRoot = root;
      detach();
      tuning = { ...DEFAULT_TUNING, ...next };
      tessellationBudget = tuning.triangleBudget;
      if (activeRoot) { root = activeRoot; apply(); }
    },
    detach,
    set(next: WireframeMode, nextColor: string) { mode = next; color = nextColor; apply(); },
    focus(next: ((mesh: THREE.Mesh) => boolean) | null) { focusFilter = next; apply(); },
    dispose() { detach(); overlayMaterial.dispose(); overlayLineMaterial.dispose(); pureMaterial.dispose(); pureLineMaterial.dispose(); mutedMaterial.dispose(); depthMaterial.dispose(); },
  };
}
