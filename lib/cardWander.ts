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

/** Match the initial 12×18 wall, warming its centre before distant cards. */
export function wanderWarmupImages<T extends { key: string; image: string }>(cards: T[], seed: string, limit: number): string[] {
  const deck = selectWanderCards(cards, seed, 216);
  const centreRow = (Math.min(18, deck.length) - 1) / 2;
  return [...new Set(deck.map((card, index) => ({ card, distance: ((Math.floor(index / 18) - 5.5) * 1.586) ** 2 + (index % 18 - centreRow) ** 2 }))
    .sort((a, b) => a.distance - b.distance).map(({ card }) => card.image))].slice(0, limit);
}

/** Network cache only: sequential low-priority reads, no offscreen image decoding. */
export async function warmWanderOriginals(urls: string[], signal: AbortSignal, budget = 24 * 1024 * 1024) {
  let bytes = 0;
  for (const url of urls) {
    if (signal.aborted || bytes >= budget) break;
    if (!url.startsWith("/uploads/") || url.startsWith("/uploads/reports/")) continue;
    try {
      const response = await fetch(url, { signal, cache: "force-cache", priority: "low" } as RequestInit & { priority: "low" });
      if (!response.ok || !response.body) { await response.body?.cancel(); continue; }
      const length = Number(response.headers.get("content-length"));
      if (length > budget - bytes) { await response.body.cancel(); continue; }
      const reader = response.body.getReader();
      try {
        while (!signal.aborted) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > budget) { await reader.cancel(); break; }
        }
      } finally { reader.releaseLock(); }
    } catch { if (signal.aborted) break; }
  }
}
