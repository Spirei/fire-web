import { RELATED_ETF_MAIN_STOCK } from "./relatedEtfs";

const RELATED_ETF_EXCHANGE_SUFFIXES = ["", ".AM", ".N", ".OQ", ".PS", ".K"] as const;

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

/**
 * 已收录的相关 ETF 必须统一显示对应正股图标。
 * 主股图标缺失时删除 ETF 自身图标，让界面回退名称首字母，避免显示发行商图标。
 */
export function applyRelatedEtfMainStockIcons(map: Record<string, string>): Record<string, string> {
  Object.entries(RELATED_ETF_MAIN_STOCK).forEach(([etf, main]) => {
    const mainUrl = map[`US:${main}`];
    RELATED_ETF_EXCHANGE_SUFFIXES.forEach((suffix) => {
      const key = `US:${etf}${suffix}`;
      if (mainUrl) map[key] = mainUrl;
      else delete map[key];
    });
  });
  return map;
}

export function pickStockIcon(map: Record<string, string>, market: string, code: string): string | undefined {
  const m = market.trim().toUpperCase();
  for (const item of stockIconLookupCodes(m, code)) {
    const url = map[`${m}:${item}`];
    if (url) return url;
  }
  return undefined;
}
