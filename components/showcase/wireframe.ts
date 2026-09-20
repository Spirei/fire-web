import * as THREE from "three";

export type WireframeMode = "native" | "overlay" | "wireframe";

/** Shares the source geometry and local transform, including independently rotating wheels. */
export function createWireframeView() {
  let mode: WireframeMode = "native";
  let color = "#00ff00";
  let root: THREE.Object3D | null = null;
  const entries: { mesh: THREE.Mesh; original: THREE.Material | THREE.Material[]; overlay: THREE.Mesh }[] = [];
  const overlayMaterial = new THREE.MeshBasicMaterial({ wireframe: true, transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
  // Offset in clip space, never inflate the mesh (which separates narrow panels / wheel parts).
  overlayMaterial.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace("#include <project_vertex>",
      "#include <project_vertex>\ngl_Position.z -= 0.00008 * gl_Position.w;");
  };
  const pureMaterial = new THREE.MeshBasicMaterial({ wireframe: true, transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
  pureMaterial.onBeforeCompile = overlayMaterial.onBeforeCompile;
  const depthMaterial = new THREE.MeshBasicMaterial({ colorWrite: false });

  function apply() {
    if (root && mode !== "native" && !entries.length) {
      const meshes: THREE.Mesh[] = [];
      root.traverse((object) => { if ((object as THREE.Mesh).isMesh) meshes.push(object as THREE.Mesh); });
      for (const mesh of meshes) {
        // Hidden source wheel meshes remain hidden; only the split wheel parts are shown.
        const overlay = mesh.clone(false);
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
        entries.push({ mesh, original: mesh.material, overlay });
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
    for (const { mesh, original, overlay } of entries) {
      mesh.material = original;
      mesh.remove(overlay);
    }
    entries.length = 0;
    root = null;
  }

  return {
    attach(next: THREE.Object3D) { detach(); root = next; apply(); },
    detach,
    set(next: WireframeMode, nextColor: string) { mode = next; color = nextColor; apply(); },
    dispose() { detach(); overlayMaterial.dispose(); pureMaterial.dispose(); depthMaterial.dispose(); },
  };
}
