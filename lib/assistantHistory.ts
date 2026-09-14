import { getDb } from "./db";

export interface StoredAssistantMessage {
  role: "user" | "assistant";
  content: string;
  action?: Record<string, unknown>;
  actionStatus?: "running" | "done" | "error" | "uncertain";
  undo?: Record<string, unknown>;
}

const MAX_MESSAGES = 30;
const MAX_BYTES = 64 * 1024;

function text(value: unknown, max = 200) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function finite(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sanitizeAction(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  const label = text(row.label);
  if (!label) return undefined;
  if (row.type === "navigate") {
    const path = text(row.path, 500);
    return path.startsWith("/") ? { type: "navigate", label, path } : undefined;
  }
  const createdAt = text(row.createdAt, 40);
  if (row.type === "create_group") {
    const name = text(row.name, 30);
    return name ? { type: "create_group", label, name, createdAt } : undefined;
  }
  if (row.type === "assign_group") {
    const groupId = text(row.groupId, 100), groupName = text(row.groupName, 30);
    const recordIds = Array.isArray(row.recordIds) ? row.recordIds.map((item) => text(item, 100)).filter(Boolean).slice(0, 2000) : [];
    const symbols = Array.isArray(row.symbols) ? row.symbols.map((item) => text(item, 30)).filter(Boolean).slice(0, 2000) : [];
    const previous = Array.isArray(row.previous) ? row.previous.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const previousRow = item as Record<string, unknown>;
      const id = text(previousRow.id, 100);
      return id ? [{ id, groupId: text(previousRow.groupId, 100) }] : [];
    }).slice(0, 2000) : [];
    return groupId && groupName && recordIds.length ? { type: "assign_group", label, groupId, groupName, recordIds, symbols, previous, createdAt } : undefined;
  }
  if (row.type === "trade") {
    const recordId = text(row.recordId, 100), code = text(row.code, 30), name = text(row.name, 200), market = text(row.market, 20);
    const qty = finite(row.qty), price = finite(row.price), fees = finite(row.fees);
    const side = row.side === "buy" || row.side === "sell" ? row.side : "";
    return recordId && code && name && side && qty !== null && price !== null && fees !== null
      ? { type: "trade", label, recordId, code, name, market, side, qty, price, fees, createdAt }
      : undefined;
  }
  return undefined;
}

function sanitizeUndo(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  if (row.type === "delete_group") {
    const groupId = text(row.groupId, 100);
    return groupId ? { type: "delete_group", groupId } : undefined;
  }
  if (row.type === "delete_order") {
    const orderId = text(row.orderId, 100);
    return orderId ? { type: "delete_order", orderId } : undefined;
  }
  if (row.type === "restore_groups" && Array.isArray(row.previous)) {
    const previous = row.previous.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const previousRow = item as Record<string, unknown>;
      const id = text(previousRow.id, 100);
      return id ? [{ id, groupId: text(previousRow.groupId, 100) }] : [];
    }).slice(0, 2000);
    return previous.length ? { type: "restore_groups", previous } : undefined;
  }
  return undefined;
}

export function sanitizeAssistantMessages(value: unknown): StoredAssistantMessage[] {
  if (!Array.isArray(value)) return [];
  const messages = value.flatMap((item): StoredAssistantMessage[] => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    if ((row.role !== "user" && row.role !== "assistant") || typeof row.content !== "string") return [];
    const message: StoredAssistantMessage = { role: row.role, content: row.content.slice(0, 4000) };
    const action = sanitizeAction(row.action);
    if (action) message.action = action;
    if (["running", "done", "error", "uncertain"].includes(String(row.actionStatus))) {
      const actionType = message.action?.type;
      message.actionStatus = row.actionStatus === "running"
        ? actionType === "trade" ? "uncertain" : "error"
        : row.actionStatus as StoredAssistantMessage["actionStatus"];
    }
    const undo = sanitizeUndo(row.undo);
    if (undo) message.undo = undo;
    return [message];
  }).slice(-MAX_MESSAGES);
  while (messages.length && Buffer.byteLength(JSON.stringify(messages), "utf8") > MAX_BYTES) messages.shift();
  return messages;
}

export function getAssistantHistory(userId: string): StoredAssistantMessage[] {
  const row = getDb().prepare("SELECT messages FROM assistant_conversations WHERE user_id = ?").get(userId) as { messages: string } | undefined;
  if (!row) return [];
  try { return sanitizeAssistantMessages(JSON.parse(row.messages)); } catch { return []; }
}

export function saveAssistantHistory(userId: string, value: unknown): StoredAssistantMessage[] {
  const messages = sanitizeAssistantMessages(value);
  getDb().prepare(`
    INSERT INTO assistant_conversations (user_id, messages, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET messages = excluded.messages, updated_at = excluded.updated_at
  `).run(userId, JSON.stringify(messages), new Date().toISOString());
  return messages;
}

export function clearAssistantHistory(userId: string) {
  getDb().prepare("DELETE FROM assistant_conversations WHERE user_id = ?").run(userId);
}
