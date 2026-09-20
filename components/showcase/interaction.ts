/** Exact exponential integration: equal release velocity gives equal travel at any refresh rate. */
export function coastStep(velocity: number, seconds: number, drag = 10) {
  const decay = Math.exp(-drag * Math.max(0, seconds));
  return { distance: velocity * (1 - decay) / drag, velocity: velocity * decay };
}

/** Ease outward movement near limits; inward movement always responds immediately. */
export function boundedZoom(value: number, factor: number, min: number, max: number) {
  if (!Number.isFinite(factor) || factor <= 0) return value;
  const delta = Math.log(factor);
  const remaining = delta > 0 ? Math.log(max / value) : Math.log(value / min);
  const gain = Math.min(1, Math.max(0.12, remaining / 0.24));
  const next = Math.max(min, Math.min(max, value * Math.exp(delta * gain)));
  if (delta > 0 && max - next < 0.002) return max;
  if (delta < 0 && next - min < 0.002) return min;
  return next;
}

/** Normalize mouse wheels (lines/pages) and trackpads (pixels) to the same dolly scale. */
export function wheelPixels(delta: number, mode: number, viewportHeight: number) {
  if (!Number.isFinite(delta)) return 0;
  const pixels = delta * (mode === 1 ? 16 : mode === 2 ? Math.max(1, viewportHeight) : 1);
  return Math.max(-1000, Math.min(1000, pixels));
}
