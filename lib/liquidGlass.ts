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
