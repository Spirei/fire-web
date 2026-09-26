const TTL = 10 * 60 * 1000;
type Entry = { at: number; closes: number[] };
const memory = new Map<string, Entry>();
export const miniKlineKey = (market: string, code: string) => `fire:kline:v2:${market.toUpperCase()}:${code.toUpperCase()}`;
export function validCloses(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 1 && value.length <= 12 && value.every(n => typeof n === "number" && Number.isFinite(n) && n > 0);
}
/** 仅挂载后读取；过期或损坏的缓存不能阻止重新加载。 */
export function readMiniKline(market: string, code: string): number[] | null {
  const key = miniKlineKey(market, code);
  let entry = memory.get(key);
  if (!entry) {
    try { entry = JSON.parse(localStorage.getItem(key) || "null"); } catch { return null; }
  }
  const age = entry ? Date.now() - entry.at : -1;
  if (!entry || !Number.isFinite(age) || age < 0 || age >= TTL || !validCloses(entry.closes)) {
    memory.delete(key);
    return null;
  }
  memory.set(key, entry);
  return entry.closes;
}
export function writeMiniKline(market: string, code: string, closes: number[]) {
  if (!validCloses(closes)) return;
  const key = miniKlineKey(market, code);
  const entry = { at: Date.now(), closes };
  if (memory.size >= 300) memory.delete(memory.keys().next().value!);
  memory.set(key, entry);
  try { localStorage.setItem(key, JSON.stringify(entry)); } catch { /* 私密浏览仍使用内存缓存 */ }
}
