/** 同一证券的交易所后缀、补零写法共用行情与历史缓存。空代码保留为空。 */
export function normalizeMarketCode(market: string, code: string): string {
  let value = code.trim().toUpperCase();
  if (!value) return value;
  if (market === "US") value = value.replace(/\.(AM|N|OQ|PS|K)$/, "");
  if (market === "HK" && /^\d+$/.test(value)) value = value.replace(/^0+/, "").padStart(5, "0");
  if (market === "CN" && /^\d+$/.test(value)) value = value.padStart(6, "0");
  if (market === "JP") value = value.replace(/\.T$/, "");
  if (market === "KR") value = value.replace(/\.(KS|KQ)$/, "");
  return value;
}
