import * as THREE from "three";

export interface WheelPart {
  geometry: THREE.BufferGeometry;
  center: THREE.Vector3;
  radius: number;
}

/** Partition only axes containing separate wheels, in this mesh's own coordinates.
 * A shared material may also cover suspension: leave noncircular parts intact. */
export function splitWheelGeometry(mesh: THREE.Mesh, lateralAxis: number, longAxis: number): Map<number, WheelPart> {
  const geo = mesh.geometry;
  const pos = geo.getAttribute("position");
  const idx = geo.index;
  if (!pos || lateralAxis === longAxis) return new Map();
  const vertex = (i: number) => idx ? idx.getX(i) : i;
  const count = idx?.count ?? pos.count;
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (let i = 0; i < count; i++) box.expandByPoint(v.fromBufferAttribute(pos, vertex(i)));
  const size = box.getSize(new THREE.Vector3());
  const mid = box.getCenter(new THREE.Vector3());
  const heightAxis = 3 - lateralAxis - longAxis;
  const diameter = size.getComponent(heightAxis);
  if (diameter <= 0) return new Map();
  const splitLateral = size.getComponent(lateralAxis) > diameter * 1.6;
  const splitLong = size.getComponent(longAxis) > diameter * 1.6;
  const buckets = new Map<number, number[]>();
  const centroid = new THREE.Vector3();
  for (let i = 0; i < count; i += 3) {
    centroid.set(0, 0, 0);
    for (let j = 0; j < 3; j++) centroid.add(v.fromBufferAttribute(pos, vertex(i + j)));
    centroid.multiplyScalar(1 / 3);
    const key = (splitLateral && centroid.getComponent(lateralAxis) > mid.getComponent(lateralAxis) ? 1 : 0)
      + (splitLong && centroid.getComponent(longAxis) > mid.getComponent(longAxis) ? 2 : 0);
    const indices = buckets.get(key) ?? [];
    indices.push(vertex(i), vertex(i + 1), vertex(i + 2));
    buckets.set(key, indices);
  }
  // Validate before allocating or hiding anything. Every retained triangle survives unchanged.
  const parts = [...buckets].map(([key, indices]) => {
    const bounds = new THREE.Box3();
    for (const i of indices) bounds.expandByPoint(v.fromBufferAttribute(pos, i));
    const extent = bounds.getSize(new THREE.Vector3());
    const ratio = extent.getComponent(longAxis) / Math.max(1e-8, extent.getComponent(heightAxis));
    return { key, indices, bounds, extent, round: ratio > 0.78 && ratio < 1.28 };
  });
  if (parts.some(part => !part.round)) return new Map();
  return new Map(parts.map(({key, indices, bounds, extent}) => {
    const geometry = new THREE.BufferGeometry();
    for (const [name, attribute] of Object.entries(geo.attributes)) geometry.setAttribute(name, attribute);
    geometry.setIndex(indices);
    geometry.boundingBox = bounds;
    geometry.boundingSphere = bounds.getBoundingSphere(new THREE.Sphere());
    return [key, { geometry, center: bounds.getCenter(new THREE.Vector3()),
      radius: (extent.getComponent(longAxis) + extent.getComponent(heightAxis)) / 4 }];
  }));
}
