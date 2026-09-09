/* ---------- 币种 / 市值换算（Web 服务端 + 客户端 + iOS 数据契约共用） ----------
 *
 * 个股详情多币种市值、素材库市值换算统一走这里；v1 个股详情接口直接返回
 * 七币种市值数组，移动端无需自行换算。
 */

/** 市场 → 本地币种 */
export const MARKET_CURRENCY: Record<string, string> = {
  US: "USD",
  HK: "HKD",
  CN: "CNY",
  JP: "JPY",
  KR: "KRW",
  SG: "SGD",
  UK: "GBP",
  DE: "EUR",
  FR: "EUR",
  AU: "AUD",
  CA: "CAD",
  IN: "INR",
  TW: "TWD",
  BR: "BRL"
};

/** 多币种市值弹层固定展示的 7 种币种（顺序即展示顺序；market/flag 供市场图标展示） */
export const MULTI_CURRENCIES = [
  { code: "USD", name: "美元", market: "US", flag: "🇺🇸" },
  { code: "HKD", name: "港元", market: "HK", flag: "🇭🇰" },
  { code: "CNY", name: "人民币", market: "CN", flag: "🇨🇳" },
  { code: "SGD", name: "新加坡元", market: "SG", flag: "🇸🇬" },
  { code: "JPY", name: "日元", market: "JP", flag: "🇯🇵" },
  { code: "KRW", name: "韩元", market: "KR", flag: "🇰🇷" },
  { code: "EUR", name: "欧元", market: "EU", flag: "🇪🇺" }
] as const;

/** 本地货币市值 → 美元市值（rates 为对 USD 的汇率） */
export function usdCap(market: string, cap: number, rates: Record<string, number>): number {
  if (!cap) return 0;
  const code = MARKET_CURRENCY[market] || "USD";
  const rate = rates[code] || (code === "USD" ? 1 : 0);
  return rate ? cap / rate : 0;
}

/** 按 7 种展示币种换算市值：本地币种返回原始值，其余 usd × 汇率 */
export function multiCurrencyCap(market: string, cap: number, rates: Record<string, number>): Record<string, number> {
  const usd = usdCap(market, cap, rates);
  const out: Record<string, number> = {};
  for (const cur of MULTI_CURRENCIES) {
    const rate = rates[cur.code] || (cur.code === "USD" ? 1 : 0);
    out[cur.code] = cur.code === (MARKET_CURRENCY[market] || "USD") ? cap : usd * rate;
  }
  return out;
}

export function fmtUsd(n: number): string {
  if (!n) return "";
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  return `$${n.toFixed(0)}`;
}
