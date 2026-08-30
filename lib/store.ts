import { randomBytes } from "crypto";
import { getDb } from "./db";
import type { Activity, Market, RecordInput, StockRecord } from "./types";

function uid() {
  return "r-" + randomBytes(8).toString("hex");
}

function rowToRecord(row: Record<string, unknown>): StockRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    code: String(row.code),
    market: row.market as Market,
    price: row.price as number,
    cost: row.cost === null ? "" : (row.cost as number),
    qty: row.qty === null ? "" : (row.qty as number),
    group: String(row.group_name ?? ""),
    watchGroupId: row.watch_group_id ? String(row.watch_group_id) : "",
    note: String(row.note ?? ""),
    source: row.source ? String(row.source) : undefined,
    updatedAt: String(row.updated_at)
  };
}

export function listRecords(userId: string): StockRecord[] {
  const rows = getDb()
    .prepare("SELECT * FROM records WHERE user_id = ? ORDER BY updated_at DESC")
    .all(userId) as Record<string, unknown>[];
  return rows.map(rowToRecord);
}

export function createRecord(userId: string, input: RecordInput): StockRecord {
  const db = getDb();
  const id = uid();
  db.prepare(`
    INSERT INTO records (id, user_id, name, code, market, price, cost, qty, group_name, watch_group_id, note, source, updated_at)
    VALUES (@id, @userId, @name, @code, @market, @price, @cost, @qty, @group, @watchGroupId, @note, @source, @updatedAt)
  `).run({
    id,
    userId,
    name: input.name,
    code: input.code,
    market: input.market,
    price: input.price,
    cost: input.cost === "" ? null : input.cost,
    qty: input.qty === "" ? null : input.qty,
    group: input.group,
    watchGroupId: input.watchGroupId ?? "",
    note: input.note,
    source: input.source ?? "",
    updatedAt: new Date().toISOString()
  });
  return listRecords(userId).find((r) => r.id === id) as StockRecord;
}

export function updateRecord(id: string, userId: string, input: RecordInput): StockRecord | null {
  const db = getDb();
  const exists = db.prepare("SELECT id FROM records WHERE id = ? AND user_id = ?").get(id, userId);
  if (!exists) return null;
  db.prepare(`
    UPDATE records
    SET name = @name, code = @code, market = @market, price = @price,
        cost = @cost, qty = @qty, group_name = @group, watch_group_id = COALESCE(@watchGroupId, watch_group_id), note = @note, source = @source, updated_at = @updatedAt
    WHERE id = @id AND user_id = @userId
  `).run({
    id,
    userId,
    name: input.name,
    code: input.code,
    market: input.market,
    price: input.price,
    cost: input.cost === "" ? null : input.cost,
    qty: input.qty === "" ? null : input.qty,
    group: input.group,
    watchGroupId: input.watchGroupId === undefined ? null : input.watchGroupId,
    note: input.note,
    source: input.source ?? "",
    updatedAt: new Date().toISOString()
  });
  const row = db.prepare("SELECT * FROM records WHERE id = ? AND user_id = ?").get(id, userId);
  return row ? rowToRecord(row as Record<string, unknown>) : null;
}

export function deleteRecord(id: string, userId: string): boolean {
  const result = getDb().prepare("DELETE FROM records WHERE id = ? AND user_id = ?").run(id, userId);
  return result.changes > 0;
}

export function deleteRecordsByIds(userId: string, ids: string[]): number {
  if (ids.length === 0) return 0;
  const marks = ids.map(() => "?").join(",");
  const result = getDb()
    .prepare(`DELETE FROM records WHERE user_id = ? AND id IN (${marks})`)
    .run(userId, ...ids);
  return result.changes;
}

export function logActivity(
  userId: string,
  action: Activity["action"],
  stockName: string,
  stockCode: string,
  extra?: { market?: string; price?: number | ""; cost?: number | ""; qty?: number | "" }
) {
  getDb().prepare(`
    INSERT INTO activities (id, user_id, action, stock_name, stock_code, market, price, cost, qty, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "a-" + randomBytes(8).toString("hex"),
    userId,
    action,
    stockName,
    stockCode,
    extra?.market ?? "",
    extra?.price === "" || extra?.price === undefined ? null : Number(extra.price),
    extra?.cost === "" || extra?.cost === undefined ? null : Number(extra.cost),
    extra?.qty === "" || extra?.qty === undefined ? null : Number(extra.qty),
    new Date().toISOString()
  );
}

export function listActivities(userId: string, limit = 50): Activity[] {
  const rows = getDb()
    .prepare(`
      SELECT a.*, u.nickname, u.username, u.avatar
      FROM activities a JOIN users u ON u.id = a.user_id
      WHERE a.user_id = ? ORDER BY a.created_at DESC LIMIT ?
    `)
    .all(userId, limit) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: String(r.id),
    action: r.action as Activity["action"],
    userName: String(r.nickname || r.username || ""),
    userAvatar: String(r.avatar || ""),
    stockName: String(r.stock_name),
    stockCode: String(r.stock_code),
    market: (r.market as Activity["market"]) || "OTHER",
    price: r.price === null || r.price === undefined ? null : Number(r.price),
    cost: r.cost === null || r.cost === undefined ? null : Number(r.cost),
    qty: r.qty === null || r.qty === undefined ? null : Number(r.qty),
    createdAt: String(r.created_at)
  }));
}

export function clearAllRecords(userId: string): { records: number; orders: number; activities: number; fundTransactions: number } {
  const db = getDb();
  return db.transaction(() => {
    const orders = db.prepare("DELETE FROM trade_orders WHERE user_id = ?").run(userId).changes;
    const records = db.prepare("DELETE FROM records WHERE user_id = ?").run(userId).changes;
    const activities = db.prepare("DELETE FROM activities WHERE user_id = ?").run(userId).changes;
    const fundTransactions = db.prepare("DELETE FROM fund_transactions WHERE user_id = ?").run(userId).changes;
    return { records, orders, activities, fundTransactions };
  })();
}

export function renameRecordGroup(oldName: string, newName: string) {
  getDb().prepare("UPDATE records SET group_name = ? WHERE group_name = ?").run(newName, oldName);
}

export function clearRecordGroup(name: string) {
  getDb().prepare("UPDATE records SET group_name = '' WHERE group_name = ?").run(name);
}

export function parseMarket(value: string): Market {
  const v = String(value ?? "").trim();
  return v ? (v as Market) : "OTHER";
}

export function toNumberOrEmpty(value: unknown): number | "" {
  if (value === "" || value === null || value === undefined) return "";
  const n = Number(value);
  return Number.isFinite(n) ? n : "";
}
