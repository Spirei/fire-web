import { MARKET_CURRENCY } from "./currency";
import type { Quote, StockRecord } from "./types";

export const ACCOUNT_MARKET_CURRENCY: Record<string, string> = { ...MARKET_CURRENCY, ASSET: "USD" };
export interface InvestmentEquity { market: string; cur: string; amount: number }
export interface AccountCashSnapshot {
  /** Includes card cash once, just like /funds.balances. */
  balances: Record<string, number>;
  cardCash: Record<string, number>;
  investmentEquities: InvestmentEquity[];
  sourceComplete: boolean;
  unavailableReasons?: string[];
  missingOpeningCurrencies?: string[];
}

export function investmentEquities(raw: unknown): { equities: InvestmentEquity[]; complete: boolean } {
  if (!Array.isArray(raw)) return { equities: [], complete: false };
  const equities: InvestmentEquity[] = [];
  let complete = true;
  for (const value of raw) {
    if (!value || typeof value !== "object" || Array.isArray(value)) { complete = false; continue; }
    const row = value as Record<string, unknown>;
    const market = String(row.market || "").toUpperCase();
    if (!market) continue; // Unlinked simple-ledger investments are not this account.
    const amount = typeof row.amount === "number" ? row.amount : Number.NaN;
    if (!Number.isFinite(amount)) { complete = false; continue; }
    if (amount > 0) equities.push({ market, cur: String(row.cur || "USD").toUpperCase(), amount });
  }
  return { equities, complete };
}

export function accountHoldingPrice(record: StockRecord, quotes: Record<string, Quote>) {
  const quote = quotes[record.id]?.price;
  if (Number.isFinite(quote)) return quote;
  const stored = Number(record.price);
  return Number.isFinite(stored) ? stored : 0;
}

/** Cash is independent of valuation. Legacy arguments remain compatible but never infer cash from equity. */
export function reconcileAccountCash<T extends Record<string, number>>(balances: T, _cardCash: Record<string, number>, _equities: InvestmentEquity[], _nativeHoldings: Record<string, number>): T {
  return Object.fromEntries(Object.entries(balances).map(([code, value]) => [code, typeof value === "number" && Number.isFinite(value) ? value : Number.NaN])) as T;
}

/** NaN is an unavailable value for the UI, not a fictitious 1:1 conversion. */
export function convertAccountAmount(value: number, source: string, rates: Record<string, number>, currency: string) {
  const from = rates[source], to = rates[currency];
  return Number.isFinite(value) && Number.isFinite(from) && from > 0 && Number.isFinite(to) && to > 0 ? value / from * to : Number.NaN;
}

/** Shared Web/App calculation. Round only at the API boundary, after addition. */
export function accountTotals(marketValue: number, balances: Record<string, number>, rates: Record<string, number>, currency: string, holdingsComplete = true, sourceComplete = true) {
  let cash = 0;
  const missing = new Set<string>();
  let cashComplete = sourceComplete && Number.isFinite(rates[currency]) && rates[currency] > 0;
  for (const [code, amount] of Object.entries(balances)) {
    if (amount === 0) continue;
    const value = convertAccountAmount(amount, code, rates, currency);
    if (!Number.isFinite(value)) { cashComplete = false; missing.add(code); }
    else cash += value;
  }
  cashComplete = cashComplete && Number.isFinite(cash);
  const totalAssetComplete = cashComplete && holdingsComplete && Number.isFinite(marketValue) && Number.isFinite(marketValue + cash);
  return { totalCash: cashComplete ? cash : null, totalAsset: totalAssetComplete ? marketValue + cash : null, cashComplete, totalAssetComplete, unconvertedCurrencies: [...missing].sort() };
}
