import { randomBytes } from "node:crypto";
import { getDb } from "@/lib/db";

export type FundCurrency = "USD" | "EUR" | "HKD" | "CNY" | "JPY" | "KRW" | "SGD";
export type FundType = "opening" | "deposit" | "withdrawal" | "adjustment";
export interface FundTransaction {
  id: string; currency: FundCurrency; type: FundType; amount: number; direction: 1 | -1;
  note: string; occurredAt: string; createdAt: string;
}

interface Row { id: string; currency: FundCurrency; type: FundType; amount: number; direction: 1 | -1; note: string; occurred_at: string; created_at: string }
const mapRow = (row: Row): FundTransaction => ({ id: row.id, currency: row.currency, type: row.type, amount: Number(row.amount), direction: row.direction, note: row.note, occurredAt: row.occurred_at, createdAt: row.created_at });

export function listFundTransactions(userId: string, limit = 200) {
  return (getDb().prepare("SELECT id,currency,type,amount,direction,note,occurred_at,created_at FROM fund_transactions WHERE user_id=? ORDER BY occurred_at DESC,created_at DESC LIMIT ?").all(userId, limit) as Row[]).map(mapRow);
}
export function fundBalances(userId: string): Record<FundCurrency, number> {
  const result: Record<FundCurrency, number> = { USD: 0, EUR: 0, HKD: 0, CNY: 0, JPY: 0, KRW: 0, SGD: 0 };
  const rows = getDb().prepare("SELECT currency,SUM(amount*direction) balance FROM fund_transactions WHERE user_id=? GROUP BY currency").all(userId) as { currency: FundCurrency; balance: number }[];
  rows.forEach((row) => { result[row.currency] = Number(row.balance) || 0; });
  return result;
}
export function createFundTransaction(input: { userId: string; currency: FundCurrency; type: FundType; amount: number; direction: 1 | -1; note?: string; occurredAt?: string }) {
  const now = new Date().toISOString();
  const id = `fund-${randomBytes(12).toString("hex")}`;
  getDb().prepare("INSERT INTO fund_transactions (id,user_id,currency,type,amount,direction,note,occurred_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(id, input.userId, input.currency, input.type, input.amount, input.direction, input.note || "", input.occurredAt || now, now);
  return listFundTransactions(input.userId, 1)[0];
}
export function deleteFundTransaction(userId: string, id: string) {
  return getDb().prepare("DELETE FROM fund_transactions WHERE id=? AND user_id=?").run(id, userId).changes > 0;
}
