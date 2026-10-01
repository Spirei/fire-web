import { ACCOUNT_MARKET_CURRENCY, accountHoldingPrice, accountTotals, convertAccountAmount, reconcileAccountCash, type AccountCashSnapshot } from "./accountCash";
import type { Quote, StockRecord } from "./types";

export function buildOverview(records: StockRecord[], rates: Record<string, number>, quotes: Record<string, Quote> = {}, currency = "USD", cash?: AccountCashSnapshot) {
  const targetRate = rates[currency];
  if (!Number.isFinite(targetRate) || targetRate <= 0) throw new Error("不支持的汇总币种");
  const byMarket: Record<string, { count: number; cost: number; market: number; pnl: number; currency: string }> = {};
  const unconverted: string[] = [];
  const missingCurrencies = new Set<string>();
  const nativeHoldings: Record<string, number> = {};
  let totalCost = 0, totalMarket = 0, count = 0;
  for (const r of records) {
    const qty = Number(r.qty);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    const price = accountHoldingPrice(r, quotes);
    nativeHoldings[r.market] = (nativeHoldings[r.market] || 0) + price * qty;
    const sourceCurrency = ACCOUNT_MARKET_CURRENCY[r.market];
    const rate = rates[sourceCurrency];
    if (!Number.isFinite(rate) || rate <= 0) { unconverted.push(r.id); missingCurrencies.add(sourceCurrency || `UNKNOWN:${r.market}`); continue; }
    const cost = Number(r.cost) || 0;
    const costValue = convertAccountAmount(cost * qty, sourceCurrency, rates, currency), marketValue = convertAccountAmount(price * qty, sourceCurrency, rates, currency);
    const m = byMarket[r.market] ??= { count: 0, cost: 0, market: 0, pnl: 0, currency };
    m.count++; m.cost += costValue; m.market += marketValue; m.pnl += marketValue - costValue;
    totalCost += costValue; totalMarket += marketValue; count++;
  }
  const round = (n: number) => +n.toFixed(2);
  const pnl = totalMarket - totalCost;
  const totals = cash && accountTotals(totalMarket, reconcileAccountCash(cash.balances, cash.cardCash, cash.investmentEquities, nativeHoldings), rates, currency, unconverted.length === 0, cash.sourceComplete);
  return {
    count, currency, complete: unconverted.length === 0, unconverted,
    totalCost: round(totalCost), totalMarket: round(totalMarket), totalPnl: round(pnl),
    totalPnlPct: totalCost !== 0 ? round(pnl / Math.abs(totalCost) * 100) : 0,
    ...(totals ? { ...totals, totalCash: totals.totalCash === null ? null : round(totals.totalCash), totalAsset: totals.totalAsset === null ? null : round(totals.totalAsset), unconvertedCurrencies: [...new Set([...missingCurrencies, ...totals.unconvertedCurrencies])].sort() } : {}),
    byMarket: Object.fromEntries(Object.entries(byMarket).map(([key, m]) => [key, { ...m, cost: round(m.cost), market: round(m.market), pnl: round(m.pnl) }])),
    valuation: records.filter(r => Number(r.qty) > 0).map(r => ({ id: r.id, source: Number.isFinite(quotes[r.id]?.price) ? "quote" : "record", at: Number.isFinite(quotes[r.id]?.price) ? quotes[r.id]?.time || r.updatedAt : r.updatedAt }))
  };
}
