import { normalizeMarketCode } from "./marketCode";
import { pickStockIcon } from "./stockIconKey";

export type RankedAsset = { market: string | null; code: string; type?: "stock" | "crypto" | "metal" };

/** Ranking providers include exchange suffixes that the asset library stores separately. */
export function marketCapStockKey(item: RankedAsset) {
  if (item.type === "crypto" || item.type === "metal") return null;
  const market = item.market?.trim().toUpperCase();
  if (!market || !/^[A-Z]{2}$/.test(market)) return null;
  let code = item.code.trim().toUpperCase();
  if (market === "HK") code = code.replace(/\.HK$/, "");
  if (market === "CN") code = code.replace(/\.(SS|SZ)$/, "");
  // Berkshire's two provider spellings refer to the same share class.
  if (market === "US" && /^BRK-[AB]$/.test(code)) code = code.replace("-", ".");
  code = normalizeMarketCode(market, code);
  return code ? { market, code } : null;
}

export function marketCapLibraryIcon(item: RankedAsset, stockIcons: Record<string, string>, assetIcons: Record<string, string>) {
  const stock = marketCapStockKey(item);
  if (stock) return pickStockIcon(stockIcons, stock.market, stock.code);
  if (item.type === "crypto" || item.type === "metal") return assetIcons[item.code.trim().toUpperCase()];
}
