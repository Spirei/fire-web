import { normalizeMarketCode } from "./marketCode";
import { pickStockIcon } from "./stockIconKey";

type RankedAsset = { market: string; code: string; type?: "stock" | "crypto" | "metal" };

/** Ranking providers include exchange suffixes that the asset library stores separately. */
export function marketCapStockKey(item: RankedAsset) {
  if (item.type === "crypto" || item.type === "metal") return null;
  const market = item.market.trim().toUpperCase();
  let code = item.code.trim().toUpperCase();
  if (market === "HK") code = code.replace(/\.HK$/, "");
  if (market === "CN") code = code.replace(/\.(SS|SZ)$/, "");
  // Berkshire's two provider spellings refer to the same share class.
  if (market === "US" && /^BRK-[AB]$/.test(code)) code = code.replace("-", ".");
  return { market, code: normalizeMarketCode(market, code) };
}

export function marketCapLibraryIcon(item: RankedAsset, stockIcons: Record<string, string>, assetIcons: Record<string, string>) {
  const stock = marketCapStockKey(item);
  if (stock) return pickStockIcon(stockIcons, stock.market, stock.code);
  const code = item.code.trim().toUpperCase();
  return assetIcons[code];
}
