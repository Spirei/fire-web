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

/** 用户自建卡面标签：cardKey → 标签数组 */
export function listCardTags(userId: string): Record<string, string[]> {
  const rows = getDb()
    .prepare("SELECT card_key, tag FROM card_tags WHERE user_id = ? ORDER BY created_at ASC")
    .all(userId) as { card_key: string; tag: string }[];
  const out: Record<string, string[]> = {};
  rows.forEach((row) => {
    if (!out[row.card_key]) out[row.card_key] = [];
    out[row.card_key].push(row.tag);
  });
  return out;
}

/** 覆盖式保存某张卡的标签（去重、限 10 个、每个限 12 字） */
export function saveCardTags(userId: string, cardKey: string, tags: string[]): string[] {
  const clean = [...new Set(tags.map((tag) => String(tag || "").trim().slice(0, 12)).filter(Boolean))].slice(0, 10);
  const db = getDb();
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM card_tags WHERE user_id = ? AND card_key = ?").run(userId, cardKey);
    const insert = db.prepare("INSERT INTO card_tags (user_id, card_key, tag, created_at) VALUES (?, ?, ?, ?)");
    clean.forEach((tag) => insert.run(userId, cardKey, tag, now));
  });
  tx();
  return clean;
}
