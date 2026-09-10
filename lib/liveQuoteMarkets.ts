/** 当前有实时行情源的市场：美/港/A 走腾讯或富途，日/韩走腾讯，加密走独立接口。 */
export const LIVE_QUOTE_MARKETS = new Set(["US", "HK", "CN", "JP", "KR", "ASSET"]);

export function hasLiveQuotes(market: string): boolean {
  return LIVE_QUOTE_MARKETS.has(market.trim().toUpperCase());
}
