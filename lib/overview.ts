import { MARKET_CURRENCY } from "./currency";
import type { Quote, StockRecord } from "./types";

export function buildOverview(records: StockRecord[], rates: Record<string, number>, quotes: Record<string, Quote> = {}, currency = "USD") {
  const targetRate = rates[currency];
  if (!Number.isFinite(targetRate) || targetRate <= 0) throw new Error("不支持的汇总币种");
  const byMarket: Record<string, { count: number; cost: number; market: number; pnl: number; currency: string }> = {};
  const unconverted: string[] = [];
  let totalCost = 0, totalMarket = 0, count = 0;
  for (const r of records) {
    const qty = Number(r.qty);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    const sourceCurrency = r.market === "ASSET" ? "USD" : MARKET_CURRENCY[r.market];
    const rate = rates[sourceCurrency];
    if (!Number.isFinite(rate) || rate <= 0) { unconverted.push(r.id); continue; }
    const factor = targetRate / rate;
    const cost = Number(r.cost) || 0;
    const quote = quotes[r.id];
    const price = quote && Number.isFinite(quote.price) ? quote.price : r.price !== "" && Number.isFinite(Number(r.price)) ? Number(r.price) : Math.max(0, cost);
    const costValue = cost * qty * factor, marketValue = price * qty * factor;
    const m = byMarket[r.market] ??= { count: 0, cost: 0, market: 0, pnl: 0, currency };
    m.count++; m.cost += costValue; m.market += marketValue; m.pnl += marketValue - costValue;
    totalCost += costValue; totalMarket += marketValue; count++;
  }
  const round = (n: number) => +n.toFixed(2);
  const pnl = totalMarket - totalCost;
  return {
    count, currency, complete: unconverted.length === 0, unconverted,
    totalCost: round(totalCost), totalMarket: round(totalMarket), totalPnl: round(pnl),
    totalPnlPct: totalCost !== 0 ? round(pnl / Math.abs(totalCost) * 100) : 0,
    byMarket: Object.fromEntries(Object.entries(byMarket).map(([key, m]) => [key, { ...m, cost: round(m.cost), market: round(m.market), pnl: round(m.pnl) }])),
    valuation: records.filter(r => Number(r.qty) > 0).map(r => ({ id: r.id, source: quotes[r.id] ? "quote" : "record", at: quotes[r.id]?.time || r.updatedAt }))
  };
}
