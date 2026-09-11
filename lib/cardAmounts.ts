import { getDb } from "./db";

export interface CardAmount {
  cardKey: string;
  amount: number;
  currency: string;
  note: string;
  updatedAt: string;
}

interface CardAmountRow {
  card_key: string;
  amount: number;
  currency: string;
  note: string;
  updated_at: string;
}

function toAmount(row: CardAmountRow): CardAmount {
  return {
    cardKey: row.card_key,
    amount: Number(row.amount) || 0,
    currency: row.currency || "",
    note: row.note || "",
    updatedAt: row.updated_at
  };
}

/** 某个用户在卡面库里录入过的金额（key = manifest 里的 card.file） */
export function listCardAmounts(userId: string): CardAmount[] {
  const rows = getDb()
    .prepare("SELECT card_key, amount, currency, note, updated_at FROM card_amounts WHERE user_id = ? ORDER BY updated_at DESC")
    .all(userId) as CardAmountRow[];
  return rows.map(toAmount);
}

export function upsertCardAmount(
  userId: string,
  input: { cardKey: string; amount: number; currency?: string; note?: string }
): CardAmount {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO card_amounts (user_id, card_key, amount, currency, note, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, card_key) DO UPDATE SET
         amount = excluded.amount,
         currency = excluded.currency,
         note = excluded.note,
         updated_at = excluded.updated_at`
    )
    .run(userId, input.cardKey, input.amount, input.currency || "", (input.note || "").slice(0, 100), now);
  return { cardKey: input.cardKey, amount: input.amount, currency: input.currency || "", note: input.note || "", updatedAt: now };
}

export function deleteCardAmount(userId: string, cardKey: string): void {
  getDb().prepare("DELETE FROM card_amounts WHERE user_id = ? AND card_key = ?").run(userId, cardKey);
}
