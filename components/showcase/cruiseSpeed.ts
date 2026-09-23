/** 匀速段的轻微油门/空气阻力波动；返回场景速度单位，峰值不超过标称最高时速。 */
export function cruiseTargetSpeed(maxSpeed: number, topKmh: number, elapsed: number): number {
  // 约 1.85 秒一轮；让极速读数保持活跃，但波动始终只有约 3 km/h。
  const dipKmh = 1.6 + 1.6 * Math.sin(elapsed * 3.4);
  return maxSpeed * (1 - dipKmh / topKmh);
}
