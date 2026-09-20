import * as THREE from "three";
import { TessellateModifier } from "three/examples/jsm/modifiers/TessellateModifier.js";

export type WireframeMode = "native" | "overlay" | "wireframe";

/** Shares the source geometry and local transform, including independently rotating wheels. */
export function createWireframeView() {
  let mode: WireframeMode = "native";
  let color = "#00ff00";
  let root: THREE.Object3D | null = null;
  let tessellationBudget = 1_000_000;
  const entries: { mesh: THREE.Mesh; original: THREE.Material | THREE.Material[]; overlay: THREE.Mesh; overlayGeometry?: THREE.BufferGeometry }[] = [];
  const overlayMaterial = new THREE.MeshBasicMaterial({ wireframe: true, transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
  // Offset in clip space, never inflate the mesh (which separates narrow panels / wheel parts).
  overlayMaterial.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace("#include <project_vertex>",
      "#include <project_vertex>\ngl_Position.z -= 0.00008 * gl_Position.w;");
  };
  const pureMaterial = new THREE.MeshBasicMaterial({ wireframe: true, transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
  pureMaterial.onBeforeCompile = overlayMaterial.onBeforeCompile;
  const depthMaterial = new THREE.MeshBasicMaterial({ colorWrite: false });

  /**
   * 部分导入车型用两三个超大三角形承载贴花 / 端板。直接打开 wireframe 只会画三角形边，
   * 视觉上就像整块没有被线网包裹。只为这些长边面片生成细分后的展示几何；原模型几何、UV
   * 和材质完全不改，已经足够密的轮胎与车身也不会被重复细分。
   */
  function wireGeometry(mesh: THREE.Mesh) {
    const geometry = mesh.geometry as THREE.BufferGeometry;
    const position = geometry.getAttribute("position");
    if (!position || position.count < 3) return { geometry };
    // 蒙皮 / 变形目标依赖逐顶点权重；TessellateModifier 不会插值这些属性，保持原拓扑才不会错位。
    if ((mesh as THREE.SkinnedMesh).isSkinnedMesh || Object.keys(geometry.morphAttributes).length > 0) return { geometry };
    mesh.updateWorldMatrix(true, false);
    const scale = new THREE.Vector3();
    mesh.getWorldScale(scale);
    const worldScale = Math.max(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z), 1e-6);
    const maxEdge = 0.14 / worldScale;
    const index = geometry.getIndex();
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const triangles = index ? index.count / 3 : position.count / 3;
    // 已经很密的单网格无需再生成展示副本，也避免未来导入极端模型时占满显存。
    if (triangles >= 200_000 || tessellationBudget <= triangles) return { geometry };
    let sparse = false;
    for (let triangle = 0; triangle < triangles && !sparse; triangle += 1) {
      const ai = index ? index.getX(triangle * 3) : triangle * 3;
      const bi = index ? index.getX(triangle * 3 + 1) : triangle * 3 + 1;
      const ci = index ? index.getX(triangle * 3 + 2) : triangle * 3 + 2;
      a.fromBufferAttribute(position, ai); b.fromBufferAttribute(position, bi); c.fromBufferAttribute(position, ci);
      sparse = a.distanceToSquared(b) > maxEdge ** 2 || b.distanceToSquared(c) > maxEdge ** 2 || c.distanceToSquared(a) > maxEdge ** 2;
    }
    if (!sparse) return { geometry };
    let iterations = 3;
    while (iterations > 0 && triangles * 4 ** iterations > tessellationBudget) iterations -= 1;
    if (iterations === 0) return { geometry };
    const generated = new TessellateModifier(maxEdge, iterations).modify(geometry);
    tessellationBudget -= Math.max(0, generated.getAttribute("position").count / 3 - triangles);
    return { geometry: generated, owned: generated };
  }

  function apply() {
    if (root && mode !== "native" && !entries.length) {
      const meshes: THREE.Mesh[] = [];
      root.traverse((object) => { if ((object as THREE.Mesh).isMesh) meshes.push(object as THREE.Mesh); });
      for (const mesh of meshes) {
        // Hidden source wheel meshes remain hidden; only the split wheel parts are shown.
        const overlay = mesh.clone(false);
        const wire = wireGeometry(mesh);
        overlay.geometry = wire.geometry;
        overlay.name = "showcase-wire-overlay";
        overlay.position.set(0, 0, 0);
        overlay.quaternion.identity();
        overlay.scale.set(1, 1, 1);
        overlay.matrix.identity();
        overlay.matrixAutoUpdate = true;
        overlay.material = overlayMaterial;
        overlay.castShadow = false;
        overlay.receiveShadow = false;
        overlay.raycast = () => {};
        mesh.add(overlay);
        entries.push({ mesh, original: mesh.material, overlay, overlayGeometry: wire.owned });
      }
    }
    overlayMaterial.color.set(color);
    pureMaterial.color.set(color);
    for (const { mesh, original, overlay } of entries) {
      mesh.material = mode === "wireframe" ? depthMaterial : original;
      overlay.material = mode === "wireframe" ? pureMaterial : overlayMaterial;
      overlay.visible = mode !== "native";
    }
  }

  function detach() {
    for (const { mesh, original, overlay, overlayGeometry } of entries) {
      mesh.material = original;
      mesh.remove(overlay);
      overlayGeometry?.dispose();
    }
    entries.length = 0;
    root = null;
    tessellationBudget = 1_000_000;
  }

  return {
    attach(next: THREE.Object3D) { detach(); root = next; apply(); },
    detach,
    set(next: WireframeMode, nextColor: string) { mode = next; color = nextColor; apply(); },
    dispose() { detach(); overlayMaterial.dispose(); pureMaterial.dispose(); depthMaterial.dispose(); },
  };
}
