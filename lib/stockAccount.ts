import { ACCOUNT_MARKET_CURRENCY } from "./accountCash";
import type { StockRecord } from "./types";

type Identity = Pick<StockRecord, "market" | "accountMarket">;
export const isStockConnect = (r: Identity) => r.market === "HK" && r.accountMarket === "CN";
export const holdingAccountMarket = (r: Identity) => isStockConnect(r) ? "CN" : r.market;
export const holdingAccountCurrency = (r: Identity) => ACCOUNT_MARKET_CURRENCY[holdingAccountMarket(r)] || "UNKNOWN";
/** Quote and recorded cost remain in the listing currency. Never reinterpret HK prices as CNY. */
export function holdingMoneyFactor(r: Identity, rates: Record<string, number>, target: string) {
  const source = ACCOUNT_MARKET_CURRENCY[r.market];
  if (source === target) return 1;
  return Number.isFinite(rates[source]) && rates[source] > 0 && Number.isFinite(rates[target]) && rates[target] > 0 ? rates[target] / rates[source] : NaN;
}
export function stockAccountError(market: string, accountMarket: unknown): string | null {
  return accountMarket === undefined || accountMarket === "" || accountMarket === market || market === "HK" && accountMarket === "CN" ? null : "港股通须保留 HK 行情市场并归属 CN 账户";
}
