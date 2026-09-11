import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import { setCardHeld, upsertCardAmount } from "./cardAmounts";

export interface CardDetails {
  cardKey: string;
  /** 卡号（允许空格，仅本地保存） */
  number: string;
  /** 有效期 MM/YY */
  expiry: string;
  /** 安全码 */
  cvv: string;
  /** 卡片备注（如「香港旅行和跨境消费扣账卡」） */
  note: string;
  /** 币种（如 HKD），余额与历史都按这个币种记账 */
  currency: string;
  updatedAt: string;
}

export type CardBalanceKind = "deposit" | "withdraw" | "adjust";

export interface CardBalanceEntry {
  id: string;
  cardKey: string;
  kind: CardBalanceKind;
  /** 本次变动额（存入为正、取出为负） */
  delta: number;
  /** 变动后的余额 */
  balance: number;
  note: string;
  occurredAt: string;
}

interface DetailsRow {
  card_key: string;
  card_number: string;
  expiry: string;
  cvv: string;
  note: string;
  currency: string;
  updated_at: string;
}

interface BalanceRow {
  id: string;
  card_key: string;
  kind: string;
  delta: number;
  balance: number;
  note: string;
  occurred_at: string;
}

export function listCardDetails(userId: string): Record<string, CardDetails> {
  const rows = getDb()
    .prepare("SELECT card_key, card_number, expiry, cvv, note, currency, updated_at FROM card_details WHERE user_id = ?")
    .all(userId) as DetailsRow[];
  const out: Record<string, CardDetails> = {};
  rows.forEach((row) => {
    out[row.card_key] = {
      cardKey: row.card_key,
      number: row.card_number || "",
      expiry: row.expiry || "",
      cvv: row.cvv || "",
      note: row.note || "",
      currency: row.currency || "",
      updatedAt: row.updated_at
    };
  });
  return out;
}

/** 卡片信息：只覆盖本次传入的字段（避免「改备注把安全码清空」这类误伤） */
export function saveCardDetails(
  userId: string,
  cardKey: string,
  input: { number?: string; expiry?: string; cvv?: string; note?: string; currency?: string }
): CardDetails {
  const db = getDb();
  const now = new Date().toISOString();
  const existing = (
    db
      .prepare("SELECT card_key, card_number, expiry, cvv, note, currency, updated_at FROM card_details WHERE user_id = ? AND card_key = ?")
      .get(userId, cardKey) as DetailsRow | undefined
  );
  const number =
    input.number === undefined
      ? existing?.card_number ?? ""
      : String(input.number).replace(/[^\d ]/g, "").replace(/\s+/g, " ").slice(0, 30).trim();
  const expiry = input.expiry === undefined ? existing?.expiry ?? "" : String(input.expiry).replace(/[^\d/]/g, "").slice(0, 7);
  const cvv = input.cvv === undefined ? existing?.cvv ?? "" : String(input.cvv).replace(/\D/g, "").slice(0, 4);
  const note = input.note === undefined ? existing?.note ?? "" : String(input.note).trim().slice(0, 60);
  const currency =
    input.currency === undefined ? existing?.currency ?? "" : String(input.currency).toUpperCase().replace(/[^A-Z]/g, "").slice(0, 8);
  db
    .prepare(
      `INSERT INTO card_details (user_id, card_key, card_number, expiry, cvv, note, currency, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, card_key) DO UPDATE SET
         card_number = excluded.card_number,
         expiry = excluded.expiry,
         cvv = excluded.cvv,
         note = excluded.note,
         currency = excluded.currency,
         updated_at = excluded.updated_at`
    )
    .run(userId, cardKey, number, expiry, cvv, note, currency, now);
  // 币种一并同步到金额记录（卡面库的金额胶囊与总览都读它）
  if (currency) {
    const amountRow = db.prepare("SELECT amount, note FROM card_amounts WHERE user_id = ? AND card_key = ?").get(userId, cardKey) as
      | { amount: number; note: string }
      | undefined;
    if (amountRow) {
      db.prepare("UPDATE card_amounts SET currency = ?, updated_at = ? WHERE user_id = ? AND card_key = ?").run(currency, now, userId, cardKey);
    }
  }
  return { cardKey, number, expiry, cvv, note, currency, updatedAt: now };
}

/** 每张卡取最近 limit 条流水 */
export function listCardBalanceHistory(userId: string, limitPerCard = 50): Record<string, CardBalanceEntry[]> {
  const rows = getDb()
    .prepare(
      `SELECT id, card_key, kind, delta, balance, note, occurred_at FROM (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY card_key ORDER BY occurred_at DESC, created_at DESC) AS rn
         FROM card_balance_history WHERE user_id = ?
       ) WHERE rn <= ? ORDER BY occurred_at DESC`
    )
    .all(userId, limitPerCard) as BalanceRow[];
  const out: Record<string, CardBalanceEntry[]> = {};
  rows.forEach((row) => {
    if (!out[row.card_key]) out[row.card_key] = [];
    out[row.card_key].push({
      id: row.id,
      cardKey: row.card_key,
      kind: (row.kind === "deposit" || row.kind === "withdraw" ? row.kind : "adjust") as CardBalanceKind,
      delta: Number(row.delta) || 0,
      balance: Number(row.balance) || 0,
      note: row.note || "",
      occurredAt: row.occurred_at
    });
  });
  return out;
}

/** 单张卡的余额流水（打开卡片详情时才拉，避免首屏 payload 变胖） */
export function listCardBalanceHistoryForCard(userId: string, cardKey: string, limit = 100): CardBalanceEntry[] {
  const rows = getDb()
    .prepare(
      `SELECT id, card_key, kind, delta, balance, note, occurred_at FROM card_balance_history
       WHERE user_id = ? AND card_key = ?
       ORDER BY occurred_at DESC, created_at DESC LIMIT ?`
    )
    .all(userId, cardKey, limit) as BalanceRow[];
  return rows.map((row) => ({
    id: row.id,
    cardKey: row.card_key,
    kind: (row.kind === "deposit" || row.kind === "withdraw" ? row.kind : "adjust") as CardBalanceKind,
    delta: Number(row.delta) || 0,
    balance: Number(row.balance) || 0,
    note: row.note || "",
    occurredAt: row.occurred_at
  }));
}

function currentAmount(userId: string, cardKey: string): { amount: number; currency: string; note: string } {
  const row = getDb().prepare("SELECT amount, currency, note FROM card_amounts WHERE user_id = ? AND card_key = ?").get(userId, cardKey) as
    | { amount: number; currency: string; note: string }
    | undefined;
  return { amount: Number(row?.amount) || 0, currency: row?.currency || "", note: row?.note || "" };
}

/** 记一笔余额变动：写入流水，并把卡面库里的当前余额同步更新（资产分析的资金系统后续接这里） */
export function addCardBalanceEntry(
  userId: string,
  input: {
    cardKey: string;
    amount: number;
    kind: CardBalanceKind;
    note?: string;
    occurredAt?: string;
    /** kind = adjust 时表示「调整后的余额」；其余情况忽略 */
    currentBalance?: number;
  }
): { entry: CardBalanceEntry; balance: number } {
  const db = getDb();
  const now = new Date().toISOString();
  const occurredAt = input.occurredAt && !Number.isNaN(Date.parse(input.occurredAt)) ? new Date(input.occurredAt).toISOString() : now;
  const existing = currentAmount(userId, input.cardKey);
  const base = existing.amount;
  const delta = input.kind === "withdraw" ? -Math.abs(input.amount) : Math.abs(input.amount);
  const balance =
    input.kind === "adjust"
      ? Number.isFinite(input.currentBalance)
        ? Number(input.currentBalance)
        : Math.abs(input.amount)
      : base + delta;
  const entry: CardBalanceEntry = {
    id: randomUUID(),
    cardKey: input.cardKey,
    kind: input.kind,
    delta: balance - base,
    balance,
    note: String(input.note || "").trim().slice(0, 100),
    occurredAt
  };
  const tx = db.transaction(() => {
    db.prepare(
      "INSERT INTO card_balance_history (id, user_id, card_key, kind, delta, balance, note, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(entry.id, userId, entry.cardKey, entry.kind, entry.delta, entry.balance, entry.note, entry.occurredAt, now);
  });
  tx();
  // 当前余额同步到卡面库（概览条与卡片上的金额胶囊都读它）
  const currency =
    existing.currency ||
    ((getDb().prepare("SELECT currency FROM card_details WHERE user_id = ? AND card_key = ?").get(userId, input.cardKey) as
      | { currency: string }
      | undefined)?.currency ??
      "");
  upsertCardAmount(userId, { cardKey: input.cardKey, amount: entry.balance, currency, note: existing.note });
  setCardHeld(userId, input.cardKey, true);
  return { entry, balance: entry.balance };
}

/** 删除一笔流水：按「最早一笔之前的余额」重放整条流水，后面的余额保持一致，并同步当前余额 */
export function deleteCardBalanceEntry(userId: string, entryId: string): { cardKey: string; balance: number } | null {
  const db = getDb();
  const target = db
    .prepare("SELECT card_key FROM card_balance_history WHERE id = ? AND user_id = ?")
    .get(entryId, userId) as { card_key: string } | undefined;
  if (!target) return null;
  const cardKey = target.card_key;
  const ordered = db
    .prepare(
      "SELECT id, delta, balance FROM card_balance_history WHERE user_id = ? AND card_key = ? ORDER BY occurred_at ASC, created_at ASC"
    )
    .all(userId, cardKey) as { id: string; delta: number; balance: number }[];
  // 删之前先把「首笔发生之前的余额」固定下来，之后无论删哪一笔都能重放
  const opening = ordered.length > 0 ? Number(ordered[0].balance) - Number(ordered[0].delta) : 0;
  const remaining = ordered.filter((row) => row.id !== entryId);
  const update = db.prepare("UPDATE card_balance_history SET balance = ? WHERE id = ? AND user_id = ?");
  let running = opening;
  db.transaction(() => {
    db.prepare("DELETE FROM card_balance_history WHERE id = ? AND user_id = ?").run(entryId, userId);
    remaining.forEach((row) => {
      running += Number(row.delta) || 0;
      update.run(running, row.id, userId);
    });
  })();
  const existing = currentAmount(userId, cardKey);
  if (remaining.length > 0) {
    upsertCardAmount(userId, { cardKey, amount: running, currency: existing.currency, note: existing.note });
  }
  return { cardKey, balance: remaining.length > 0 ? running : existing.amount };
}
