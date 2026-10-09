import { createHash } from "node:crypto";
import { getDb } from "./db";
import { getSiteSettings } from "./settings";
import { listRecords } from "./store";
import { holdingAccountCurrency } from "./stockAccount";
import { convertAccountAmount } from "./accountCash";
import { orderCashAmount, settlementCurrency } from "./funds";
import type { GroupConfig, StockRecord } from "./types";

export interface AllocationBasis {
  version: 1; currency: string; sourceAmount: number;
  tradeCash: Record<string, number>; capturedAt: string;
}
export function allocationBrokerId(record: StockRecord, groups: GroupConfig[] = getSiteSettings().groups) {
  const group = groups.find(g => g.name === record.group || g.alias && g.alias === record.group);
  const identity = group?.id || createHash("sha256").update(record.group || "ungrouped").digest("hex").slice(0, 20);
  return `broker:${identity}:${holdingAccountCurrency(record)}`;
}
/** Native cash totals remain native. Only changes since reconciliation enter its valuation. */
export function allocationTradeCash(userId: string, sourceId: string): Record<string, number> {
  const groups = getSiteSettings().groups;
  const ids = new Set(listRecords(userId).filter(r => allocationBrokerId(r, groups) === sourceId).map(r => r.id));
  const rows = getDb().prepare("SELECT record_id,market,side,qty,price,fees,amount,settlement_currency,settlement_amount FROM trade_orders WHERE user_id=? AND status='filled'").all(userId) as {
    record_id: string; market: string; side: "buy" | "sell" | "dividend"; qty: number; price: number; fees: number; amount: number;
    settlement_currency: string | null; settlement_amount: number | null;
  }[];
  const result: Record<string, number> = {};
  for (const order of rows) if (ids.has(order.record_id)) {
    const currency = order.settlement_currency === "CNY" ? "CNY" : settlementCurrency(order.market);
    const amount = orderCashAmount(order);
    if (!Number.isFinite(amount)) throw Error("Invalid order cash");
    result[currency] = (result[currency] ?? 0) + amount;
  }
  return result;
}
export function captureAllocationBasis(userId: string, id: string, currency: string, sourceAmount: number): AllocationBasis {
  if (!Number.isFinite(sourceAmount)) throw Error("Missing reconciliation valuation");
  return { version: 1, currency, sourceAmount, tradeCash: id.startsWith("broker:") ? allocationTradeCash(userId, id) : {}, capturedAt: new Date().toISOString() };
}
export function parseAllocationBasis(raw: string): AllocationBasis | null {
  if (!raw) return null;
  const b = JSON.parse(raw) as AllocationBasis;
  if (!b || b.version !== 1 || !/^[A-Z]{3}$/.test(b.currency) || !Number.isFinite(b.sourceAmount)
    || !Number.isFinite(Date.parse(b.capturedAt)) || !b.tradeCash || typeof b.tradeCash !== "object" || Array.isArray(b.tradeCash)
    || Object.entries(b.tradeCash).some(([c, n]) => !/^[A-Z]{3}$/.test(c) || !Number.isFinite(n))) throw Error("Invalid reconciliation basis");
  return b;
}
export function reconciledAllocationAmount(userId: string, id: string, amount: number, currency: string, sourceAmount: number | null, raw: string, rates: Record<string, number>) {
  const basis = parseAllocationBasis(raw);
  // Legacy statements have no historical price/cash checkpoint. Never invent one on a read.
  if (!basis) return amount;
  if (basis.currency !== currency || sourceAmount === null) return null;
  let result = amount + sourceAmount - basis.sourceAmount;
  const current = id.startsWith("broker:") ? allocationTradeCash(userId, id) : {};
  for (const cur of new Set([...Object.keys(current), ...Object.keys(basis.tradeCash)])) {
    const delta = (current[cur] ?? 0) - (basis.tradeCash[cur] ?? 0);
    if (Math.abs(delta) < 1e-8) continue;
    result += convertAccountAmount(delta, cur, rates, currency);
  }
  return Number.isFinite(result) ? result : null;
}
