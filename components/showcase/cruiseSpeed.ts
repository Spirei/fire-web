/** Map an irregular throttle sample to a small dip below this car's own top speed. */
export function cruiseTargetSpeed(maxSpeed: number, topKmh: number, sample: number): number {
  const bounded = Math.max(0, Math.min(1, sample));
  // Some peaks round to the advertised maximum; neither the values nor their order are scripted.
  const dipKmh = 0.15 + Math.pow(bounded, 1.35) * 4.45;
  return maxSpeed * (1 - dipKmh / Math.max(1, topKmh));
}
