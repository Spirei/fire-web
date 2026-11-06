import { normalizeMarketCode } from "./marketCode";

export interface AssetLookupKey { type: "stock" | "market" | "crypto" | "metal"; market: string; code: string }

/** 小批量精确匹配；不把完整素材目录传给移动端。 */
export function parseAssetLookup(value: string | null): AssetLookupKey[] | null {
  if (value == null || value.length > 10_000) return null;
  let data: unknown;
  try { data = JSON.parse(value); } catch { return null; }
  if (!Array.isArray(data) || data.length > 50) return null;
  const keys = new Map<string, AssetLookupKey>();
  for (const item of data) {
    if (!item || !["stock", "market", "crypto", "metal"].includes(item.type)
        || typeof item.code !== "string" || !/^[A-Za-z0-9._-]{1,40}$/.test(item.code.trim())
        || typeof item.market !== "string" || !/^[A-Za-z0-9_-]{0,16}$/.test(item.market.trim())
        || (item.type === "stock" && !item.market.trim())) return null;
    const market = item.market.trim().toUpperCase();
    const key: AssetLookupKey = { type: item.type, market, code: item.type === "stock" ? normalizeMarketCode(market, item.code) : item.code.trim().toUpperCase() };
    if (!key.code) return null;
    keys.set(JSON.stringify(key), key);
  }
  return [...keys.values()];
}
