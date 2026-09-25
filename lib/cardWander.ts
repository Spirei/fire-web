/** 洗牌由 URL seed 决定：相同种子始终得到相同卡墙，刷新可恢复。 */
function hash(value: string) {
  let result = 2166136261;
  for (let i = 0; i < value.length; i++) {
    result ^= value.charCodeAt(i);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

export function selectWanderCards<T extends { key: string }>(cards: T[], seed: string, limit: number): T[] {
  return [...cards]
    .sort((a, b) => hash(`${seed}:${a.key}`) - hash(`${seed}:${b.key}`) || a.key.localeCompare(b.key))
    .slice(0, Math.max(0, limit));
}
