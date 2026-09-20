/** Rounded capsule displacement: clear center, strongest refraction just inside the rim. */
export function glassDisplacement(width: number, height: number) {
  const data = new Uint8ClampedArray(width * height * 4);
  const radius = Math.min(width, height) / 2, band = Math.max(2, radius * .32);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const px = x + .5, py = y + .5;
    const cx = Math.max(radius, Math.min(width - radius, px));
    const cy = Math.max(radius, Math.min(height - radius, py));
    const dx = px - cx, dy = py - cy, distance = Math.hypot(dx,dy);
    const t = Math.max(0, Math.min(1, (distance - radius + band) / band));
    const strength = distance < radius ? Math.sin(t * Math.PI) * 112 : 0;
    const i = (y * width + x) * 4;
    data[i] = 128 + (distance ? dx / distance : 0) * strength;
    data[i+1] = 128 + (distance ? dy / distance : 0) * strength;
    data[i+2] = 128; data[i+3] = 255;
  }
  return data;
}
export function glassPosition(x: number, left: number, width: number, count: number) {
  return Math.max(0, Math.min(count - 1, (x - left) / Math.max(width,1) * count - .5));
}

export type GlassSpring = { value: number; velocity: number };
/** Exact critically damped step, independent of the display refresh rate. */
export function stepGlassSpring(state: GlassSpring, target: number, seconds: number, frequency: number): GlassSpring {
  const dt = Math.max(0, Math.min(seconds, .064));
  const offset = state.value - target, impulse = state.velocity + frequency * offset;
  const decay = Math.exp(-frequency * dt);
  return { value: target + (offset + impulse * dt) * decay, velocity: (state.velocity - frequency * impulse * dt) * decay };
}

/** Lens, content and exclusion use the same pixel coordinate system. */
export function glassFrame(position: number, lift: number, velocity: number, slot: number, height: number) {
  const raised = Math.max(0, Math.min(1, lift));
  const width = slot * (1 + .16 * raised + Math.min(Math.abs(velocity) / 16, 1) * .08 * raised);
  const lensHeight = height * (1 + .30 * raised);
  const left = (position + .5) * slot - width / 2;
  return { left, width, height: lensHeight, top: (height - lensHeight) / 2, copyX: -left, zoom: 1 + .16 * raised, lift: raised };
}
