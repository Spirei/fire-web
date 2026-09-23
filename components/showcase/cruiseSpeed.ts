/** 匀速段的轻微油门/空气阻力波动；返回场景速度单位，峰值不超过标称最高时速。 */
export function cruiseTargetSpeed(maxSpeed: number, topKmh: number, elapsed: number): number {
  const dipKmh = 1.6 + 1.6 * Math.sin(elapsed * 0.9);
  return maxSpeed * (1 - dipKmh / topKmh);
}
