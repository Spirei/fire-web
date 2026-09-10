/** 港股代码 9992 / 09992 视为同一只，查找素材库图标时两种都试。 */
export function stockIconLookupCodes(market: string, code: string): string[] {
  const c = code.trim().toUpperCase();
  if (!c) return [];
  const codes = [c];
  if (market.trim().toUpperCase() === "HK" && /^\d+$/.test(c)) {
    const padded = c.padStart(5, "0");
    const stripped = c.replace(/^0+/, "") || "0";
    if (!codes.includes(padded)) codes.push(padded);
    if (!codes.includes(stripped)) codes.push(stripped);
  }
  return codes;
}

export function pickStockIcon(map: Record<string, string>, market: string, code: string): string | undefined {
  const m = market.trim().toUpperCase();
  for (const item of stockIconLookupCodes(m, code)) {
    const url = map[`${m}:${item}`];
    if (url) return url;
  }
  return undefined;
}
