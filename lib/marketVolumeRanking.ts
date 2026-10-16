/** Public, market-wide share-volume ranking. Never rank a user's holdings or a cap shortlist. */
export const RANKING_MARKETS = ["US", "HK", "CN"] as const;
export type RankingMarket = typeof RANKING_MARKETS[number];
const filters: Record<RankingMarket, string> = {
  US: "m:105,m:106,m:107", HK: "m:128+t:3,m:128+t:4,m:128+t:1,m:128+t:8",
  CN: "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048"
};
type Row = { market: RankingMarket; code: string; name: string; volume: number };
export type VolumeRanking = { market: RankingMarket; metric: "volume"; updatedAt: string; tradeDate: string; items: Row[] };
export function parseVolumeRanking(raw: unknown, market: RankingMarket, now = Date.now()): VolumeRanking {
  const data = (raw as { data?: { diff?: unknown; total?: unknown } })?.data;
  if (!data || !Array.isArray(data.diff) || data.diff.length !== 10 || typeof data.total !== "number" || data.total < 10) throw new Error("Incomplete ranking");
  const seen = new Set<string>(), dates = new Set<string>();
  let previous = Infinity;
  const items = data.diff.map(value => {
    const r = value as Record<string, unknown>;
    if (typeof r.f12 !== "string" || !/^[A-Z0-9.\-]{1,24}$/i.test(r.f12) || typeof r.f14 !== "string" || !r.f14.trim()
      || typeof r.f5 !== "number" || !Number.isFinite(r.f5) || r.f5 <= 0 || r.f5 > previous
      || typeof r.f124 !== "number" || !Number.isFinite(r.f124) || r.f124 * 1000 > now + 180000 || r.f124 * 1000 < now - 10 * 86400000) throw new Error("Invalid ranking row");
    const code = r.f12.toUpperCase();
    if (seen.has(code)) throw new Error("Duplicate ranking row");
    seen.add(code); previous = r.f5;
    dates.add(new Intl.DateTimeFormat("en-CA", { timeZone: market === "US" ? "America/New_York" : "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(r.f124 * 1000)));
    return { market, code, name: r.f14.trim(), volume: r.f5 };
  });
  if (dates.size !== 1) throw new Error("Mixed trading dates");
  return { market, metric: "volume", updatedAt: new Date(now).toISOString(), tradeDate: [...dates][0], items };
}
const cache = new Map<RankingMarket, { at: number; value: VolumeRanking }>();
const pending = new Map<RankingMarket, Promise<VolumeRanking>>();
export async function volumeRanking(market: RankingMarket): Promise<VolumeRanking> {
  const stored = cache.get(market);
  if (stored && Date.now() - stored.at < 180000) return stored.value;
  const existing = pending.get(market); if (existing) return existing;
  const work = (async () => {
    const params = new URLSearchParams({ pn: "1", pz: "10", po: "1", np: "1", fltt: "2", invt: "2", fid: "f5", fs: filters[market], fields: "f12,f14,f5,f124" });
    let failure: unknown;
    for (const host of ["push2.eastmoney.com", "push2delay.eastmoney.com"]) {
    try {
      const response = await fetch(`https://${host}/api/qt/clist/get?` + params, {
        signal: AbortSignal.timeout(3000), redirect: "error", headers: { "User-Agent": "Mozilla/5.0", Referer: "https://quote.eastmoney.com/" }
      });
      if (!response.ok || !response.body) throw new Error("Ranking unavailable");
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let count = 0;
      try {
        while (true) { const { done, value } = await reader.read(); if (done) break; count += value.length; if (count > 128 * 1024) throw new Error("Ranking too large"); chunks.push(value); }
      } finally { await reader.cancel().catch(() => undefined); }
      const bytes = new Uint8Array(count); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const value = parseVolumeRanking(JSON.parse(new TextDecoder().decode(bytes)), market);
      cache.set(market, { at: Date.now(), value }); return value;
    } catch (error) { failure = error; }
    }
    throw failure ?? new Error("Ranking unavailable");
  })();
  pending.set(market, work);
  try { return await work; } finally { if (pending.get(market) === work) pending.delete(market); }
}
