import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import { setCardHeld, upsertCardAmount } from "./cardAmounts";
import { CARD_LINK_PREFIX, writeFundTransaction } from "./funds";
import { isFundCurrency, type FundCurrency } from "./fundCurrencies";

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
  /** 币种范围手动覆盖：'' = 自动推断，single / dual / multi / unknown = 用户指定 */
  currencyScope: string;
  /** 自定义卡面（用户自己上传的卡片照片）本地地址；空 = 用清单里的原图 */
  image: string;
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
  /** 这笔钱的另一端在券商账户（联动记了一笔方向相反的资金流水），资金记录里显示为自动 */
  brokerLinked: boolean;
}

interface DetailsRow {
  card_key: string;
  card_number: string;
  expiry: string;
  cvv: string;
  note: string;
  currency: string;
  currency_scope: string;
  image: string;
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
  fund_tx_id?: string;
}

function toBalanceEntry(row: BalanceRow): CardBalanceEntry {
  return {
    id: row.id,
    cardKey: row.card_key,
    kind: (row.kind === "deposit" || row.kind === "withdraw" ? row.kind : "adjust") as CardBalanceKind,
    delta: Number(row.delta) || 0,
    balance: Number(row.balance) || 0,
    note: row.note || "",
    occurredAt: row.occurred_at,
    brokerLinked: Boolean(row.fund_tx_id)
  };
}

export function listCardDetails(userId: string): Record<string, CardDetails> {
  const rows = getDb()
    .prepare("SELECT card_key, card_number, expiry, cvv, note, currency, currency_scope, image, updated_at FROM card_details WHERE user_id = ?")
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
      currencyScope: row.currency_scope || "",
      image: row.image || "",
      updatedAt: row.updated_at
    };
  });
  return out;
}

/** 卡片信息：只覆盖本次传入的字段（避免「改备注把安全码清空」这类误伤） */
export function saveCardDetails(
  userId: string,
  cardKey: string,
  input: { number?: string; expiry?: string; cvv?: string; note?: string; currency?: string; currencyScope?: string; image?: string }
): CardDetails {
  const db = getDb();
  const now = new Date().toISOString();
  const existing = (
    db
      .prepare(
        "SELECT card_key, card_number, expiry, cvv, note, currency, currency_scope, image, updated_at FROM card_details WHERE user_id = ? AND card_key = ?"
      )
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
  // 只认四个合法值，其余（含空字符串）都当成「恢复自动推断」
  const rawScope = input.currencyScope === undefined ? existing?.currency_scope ?? "" : String(input.currencyScope).trim().toLowerCase();
  const currencyScope = ["single", "dual", "multi", "unknown"].includes(rawScope) ? rawScope : "";
  // 自定义卡面：只认本地 /uploads/ 地址（空字符串 = 恢复用清单原图）——
  // 外链、data:、javascript: 一律拒绝，避免把不可信内容写进 <img src>
  const rawImage = input.image === undefined ? existing?.image ?? "" : String(input.image).trim().slice(0, 500);
  const image = rawImage === "" || rawImage.startsWith("/uploads/") ? rawImage : existing?.image ?? "";
  db
    .prepare(
      `INSERT INTO card_details (user_id, card_key, card_number, expiry, cvv, note, currency, currency_scope, image, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, card_key) DO UPDATE SET
         card_number = excluded.card_number,
         expiry = excluded.expiry,
         cvv = excluded.cvv,
         note = excluded.note,
         currency = excluded.currency,
         currency_scope = excluded.currency_scope,
         image = excluded.image,
         updated_at = excluded.updated_at`
    )
    .run(userId, cardKey, number, expiry, cvv, note, currency, currencyScope, image, now);
  // 币种一并同步到金额记录（卡面库的金额胶囊与总览都读它）
  if (currency) {
    const amountRow = db.prepare("SELECT amount, note FROM card_amounts WHERE user_id = ? AND card_key = ?").get(userId, cardKey) as
      | { amount: number; note: string }
      | undefined;
    if (amountRow) {
      db.prepare("UPDATE card_amounts SET currency = ?, updated_at = ? WHERE user_id = ? AND card_key = ?").run(currency, now, userId, cardKey);
    }
  }
  return { cardKey, number, expiry, cvv, note, currency, currencyScope, image, updatedAt: now };
}

/** 每张卡取最近 limit 条流水 */
export function listCardBalanceHistory(userId: string, limitPerCard = 50): Record<string, CardBalanceEntry[]> {
  const rows = getDb()
    .prepare(
      `SELECT id, card_key, kind, delta, balance, note, occurred_at, fund_tx_id FROM (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY card_key ORDER BY occurred_at DESC, created_at DESC) AS rn
         FROM card_balance_history WHERE user_id = ?
       ) WHERE rn <= ? ORDER BY occurred_at DESC`
    )
    .all(userId, limitPerCard) as BalanceRow[];
  const out: Record<string, CardBalanceEntry[]> = {};
  rows.forEach((row) => {
    if (!out[row.card_key]) out[row.card_key] = [];
    out[row.card_key].push(toBalanceEntry(row));
  });
  return out;
}

/** 单张卡的余额流水（打开卡片详情时才拉，避免首屏 payload 变胖） */
export function listCardBalanceHistoryForCard(userId: string, cardKey: string, limit = 100): CardBalanceEntry[] {
  const rows = getDb()
    .prepare(
      `SELECT id, card_key, kind, delta, balance, note, occurred_at, fund_tx_id FROM card_balance_history
       WHERE user_id = ? AND card_key = ?
       ORDER BY occurred_at DESC, created_at DESC LIMIT ?`
    )
    .all(userId, cardKey, limit) as BalanceRow[];
  return rows.map(toBalanceEntry);
}

function currentAmount(userId: string, cardKey: string): { amount: number; currency: string; note: string } {
  const row = getDb().prepare("SELECT amount, currency, note FROM card_amounts WHERE user_id = ? AND card_key = ?").get(userId, cardKey) as
    | { amount: number; currency: string; note: string }
    | undefined;
  return { amount: Number(row?.amount) || 0, currency: row?.currency || "", note: row?.note || "" };
}

/** 卡币种：金额上记的优先，其次卡背信息里填的（与卡包 / 卡面库的取值顺序一致） */
function cardCurrency(userId: string, cardKey: string, amountCurrency: string): string {
  if (amountCurrency) return amountCurrency.toUpperCase();
  const row = getDb().prepare("SELECT currency FROM card_details WHERE user_id = ? AND card_key = ?").get(userId, cardKey) as
    | { currency: string }
    | undefined;
  return (row?.currency || "").toUpperCase();
}

/**
 * 记一笔余额变动：写入流水，并把卡面库里的当前余额同步更新。
 *
 * fundAccount = "broker" 表示这笔钱的另一端就在券商账户里（从券商转到卡上 / 从卡上转回券商）：
 * 那就同时在资金账本记一笔**方向相反**的流水 —— 卡里多了钱，券商现金就少了同样的钱。
 * 不这么做的话，卡余额会被算作现金、券商账本里的那笔钱也还在，总现金直接翻倍。
 * 两笔记录在同一个数据库事务里写入，卡包那笔删掉时联动流水也会一起删。
 */
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
    /** "broker" = 这笔钱在券商账户里也有一份（联动记账） */
    fundAccount?: "broker";
    /** 联动流水的备注（一般传「银行 卡名」），只用于资金记录的展示 */
    fundNote?: string;
  }
): { entry: CardBalanceEntry; balance: number } {
  const db = getDb();
  const now = new Date().toISOString();
  const occurredAt = input.occurredAt && !Number.isNaN(Date.parse(input.occurredAt)) ? new Date(input.occurredAt).toISOString() : now;
  const existing = currentAmount(userId, input.cardKey);
  const currency = cardCurrency(userId, input.cardKey, existing.currency);
  const base = existing.amount;
  const delta = input.kind === "withdraw" ? -Math.abs(input.amount) : Math.abs(input.amount);
  const balance =
    input.kind === "adjust"
      ? Number.isFinite(input.currentBalance)
        ? Number(input.currentBalance)
        : Math.abs(input.amount)
      : base + delta;
  const linked = input.fundAccount === "broker" && input.kind !== "adjust";
  if (linked && !isFundCurrency(currency)) {
    throw new Error(currency ? `资金系统不支持 ${currency}（没有汇率），没法记券商流水` : "这张卡还没有币种，先把卡背信息的币种填上");
  }
  const entry: CardBalanceEntry = {
    id: randomUUID(),
    cardKey: input.cardKey,
    kind: input.kind,
    delta: balance - base,
    balance,
    note: String(input.note || "").trim().slice(0, 100),
    occurredAt,
    brokerLinked: linked
  };
  const fundTxId = linked ? `${CARD_LINK_PREFIX}${entry.id}` : "";
  const tx = db.transaction(() => {
    db.prepare(
      "INSERT INTO card_balance_history (id, user_id, card_key, kind, delta, balance, note, occurred_at, created_at, fund_tx_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(entry.id, userId, entry.cardKey, entry.kind, entry.delta, entry.balance, entry.note, entry.occurredAt, now, fundTxId);
    if (linked) {
      // 卡里存入 = 券商现金流出（转出）；卡里取出 = 券商现金流入（转入）
      const money = Math.abs(Number(input.amount)) || 0;
      writeFundTransaction({
        id: fundTxId,
        userId,
        currency: currency as FundCurrency,
        type: input.kind === "deposit" ? "withdrawal" : "deposit",
        amount: money,
        direction: input.kind === "deposit" ? -1 : 1,
        note: `${input.kind === "deposit" ? "银行卡存钱" : "银行卡取钱"}${input.fundNote ? ` · ${input.fundNote}` : ""}`,
        occurredAt
      });
    }
  });
  tx();
  // 当前余额同步到卡面库（概览条与卡片上的金额胶囊都读它）
  upsertCardAmount(userId, { cardKey: input.cardKey, amount: entry.balance, currency: existing.currency || currency, note: existing.note });
  setCardHeld(userId, input.cardKey, true);
  return { entry, balance: entry.balance };
}

/** 删除一笔流水：按「最早一笔之前的余额」重放整条流水，并同步当前余额（联动流水一起删） */
export function deleteCardBalanceEntry(userId: string, entryId: string): { cardKey: string; balance: number } | null {
  const db = getDb();
  const target = db
    .prepare("SELECT card_key, fund_tx_id FROM card_balance_history WHERE id = ? AND user_id = ?")
    .get(entryId, userId) as { card_key: string; fund_tx_id?: string } | undefined;
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
    // 联动的那笔券商流水跟着一起删，否则券商现金与卡余额会各少一笔、账对不上
    if (target.fund_tx_id) db.prepare("DELETE FROM fund_transactions WHERE id = ? AND user_id = ?").run(target.fund_tx_id, userId);
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
