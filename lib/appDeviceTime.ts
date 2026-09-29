/** Elapsed authorization time starts at grant creation, never at token refresh or last use. */
export function appAuthorizationDuration(createdAt: number, now: number): string {
  if (!Number.isFinite(createdAt) || createdAt <= 0 || !Number.isFinite(now) || now <= 0) return "—";
  const minutes = Math.floor(Math.max(0, now - createdAt) / 60_000);
  if (minutes < 1) return "不足 1 分钟";
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days) return `${days} 天${hours % 24 ? ` ${hours % 24} 小时` : ""}`;
  if (hours) return `${hours} 小时${minutes % 60 ? ` ${minutes % 60} 分钟` : ""}`;
  return `${minutes} 分钟`;
}
