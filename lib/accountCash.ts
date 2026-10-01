import { MARKET_CURRENCY } from "./currency";
import type { Quote, StockRecord } from "./types";

export const ACCOUNT_MARKET_CURRENCY: Record<string, string> = { ...MARKET_CURRENCY, ASSET: "USD" };
// Preserve the existing linked-account rule: only these imported markets have a
// one-account position ledger. Unimported brokers must not be silently added.
const EQUITY_CURRENCY: Record<string, string> = { US: "USD", HK: "HKD", CN: "CNY", JP: "JPY", KR: "KRW" };
export interface InvestmentEquity { market: string; cur: string; amount: number }
export interface AccountCashSnapshot {
  /** Includes card cash once, just like /funds.balances. */
  balances: Record<string, number>;
  cardCash: Record<string, number>;
  investmentEquities: InvestmentEquity[];
  sourceComplete: boolean;
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
    const amount = Number(row.amount || 0);
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

/** Native-currency cash; never subtract reserved/pending cash from total assets. */
export function reconcileAccountCash<T extends Record<string, number>>(balances: T, cardCash: Record<string, number>, equities: InvestmentEquity[], nativeHoldings: Record<string, number>): T {
  const primary: Record<string, InvestmentEquity> = {};
  for (const row of equities) if (!primary[row.market] || row.amount > primary[row.market].amount) primary[row.market] = row;
  const next: Record<string, number> = { ...balances };
  for (const [market, equity] of Object.entries(primary)) {
    const holdings = nativeHoldings[market];
    const bank = cardCash[equity.cur];
    const bankCash = bank === undefined ? 0 : Number.isFinite(bank) ? bank : Number.NaN;
    if (holdings !== undefined && equity.cur === EQUITY_CURRENCY[market]) next[equity.cur] = equity.amount - holdings + bankCash;
  }
  return next as T;
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
