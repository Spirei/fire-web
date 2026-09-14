import { getDb } from "./db";
import { randomBytes } from "crypto";

export interface StoredAssistantMessage {
  role: "user" | "assistant";
  content: string;
  responseError?: boolean;
  retryQuestion?: string;
  action?: Record<string, unknown>;
  actionStatus?: "running" | "done" | "error" | "uncertain";
  undo?: Record<string, unknown>;
  undoStatus?: "running" | "error" | "uncertain";
}

export interface StoredAssistantConversation {
  id: string;
  title: string;
  messages: StoredAssistantMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface AssistantHistoryState {
  activeId: string;
  conversations: StoredAssistantConversation[];
}

const MAX_MESSAGES = 30;
const MAX_BYTES = 64 * 1024;
const MAX_CONVERSATIONS = 20;
const CONVERSATION_ID_RE = /^ac-[a-f0-9]{24}$/;

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
  const actionId = text(row.actionId, 40);
  if (!/^aa-[a-f0-9]{24}$/.test(actionId)) return undefined;
  if (row.type === "create_group") {
    const name = text(row.name, 30);
    return name ? { type: "create_group", label, name, createdAt, actionId } : undefined;
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
    return groupId && groupName && recordIds.length ? { type: "assign_group", label, groupId, groupName, recordIds, symbols, previous, createdAt, actionId } : undefined;
  }
  if (row.type === "trade") {
    const recordId = text(row.recordId, 100), code = text(row.code, 30), name = text(row.name, 200), market = text(row.market, 20);
    const qty = finite(row.qty), price = finite(row.price), fees = finite(row.fees);
    const side = row.side === "buy" || row.side === "sell" ? row.side : "";
    return recordId && code && name && side && qty !== null && price !== null && fees !== null
      ? { type: "trade", label, recordId, code, name, market, side, qty, price, fees, createdAt, actionId }
      : undefined;
  }
  return undefined;
}

function sanitizeUndo(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  const actionId = text(row.actionId, 40), createdAt = text(row.createdAt, 40);
  if (!/^au-[a-f0-9]{24}$/.test(actionId)) return undefined;
  if (row.type === "delete_group") {
    const groupId = text(row.groupId, 100);
    return groupId ? { type: "delete_group", groupId, actionId, createdAt } : undefined;
  }
  if (row.type === "delete_order") {
    const orderId = text(row.orderId, 100);
    return orderId ? { type: "delete_order", orderId, actionId, createdAt } : undefined;
  }
  if (row.type === "restore_groups" && Array.isArray(row.previous)) {
    const previous = row.previous.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const previousRow = item as Record<string, unknown>;
      const id = text(previousRow.id, 100);
      return id ? [{ id, groupId: text(previousRow.groupId, 100) }] : [];
    }).slice(0, 2000);
    return previous.length ? { type: "restore_groups", previous, actionId, createdAt } : undefined;
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
    if (row.role === "assistant" && row.responseError === true) {
      message.responseError = true;
      const retryQuestion = text(row.retryQuestion, 1200);
      if (retryQuestion) message.retryQuestion = retryQuestion;
    }
    const action = sanitizeAction(row.action);
    if (action) message.action = action;
    if (["running", "done", "error", "uncertain"].includes(String(row.actionStatus))) {
      message.actionStatus = row.actionStatus === "running"
        ? "uncertain"
        : row.actionStatus as StoredAssistantMessage["actionStatus"];
    }
    const undo = sanitizeUndo(row.undo);
    if (undo) message.undo = undo;
    if (["running", "error", "uncertain"].includes(String(row.undoStatus))) {
      message.undoStatus = row.undoStatus === "running" ? "uncertain" : row.undoStatus as StoredAssistantMessage["undoStatus"];
    }
    return [message];
  }).slice(-MAX_MESSAGES);
  while (messages.length && Buffer.byteLength(JSON.stringify(messages), "utf8") > MAX_BYTES) messages.shift();
  return messages;
}

function conversationTitle(messages: StoredAssistantMessage[]) {
  const firstQuestion = messages.find((message) => message.role === "user")?.content.trim().replace(/\s+/g, " ");
  return firstQuestion ? firstQuestion.slice(0, 36) : "新对话";
}

function parseConversation(row: { conversation_id: string; title: string; messages: string; created_at: string; updated_at: string }): StoredAssistantConversation {
  let parsed: unknown = [];
  try { parsed = JSON.parse(row.messages); } catch { /* malformed history becomes empty */ }
  return {
    id: row.conversation_id,
    title: text(row.title, 80) || "新对话",
    messages: sanitizeAssistantMessages(parsed),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function migrateLegacyHistory(userId: string) {
  const database = getDb();
  const count = database.prepare("SELECT COUNT(*) AS count FROM assistant_conversation_threads WHERE user_id = ?").get(userId) as { count: number };
  if (count.count > 0) return;
  const legacy = database.prepare("SELECT messages, updated_at FROM assistant_conversations WHERE user_id = ?").get(userId) as { messages: string; updated_at: string } | undefined;
  if (!legacy) return;
  let messages: StoredAssistantMessage[] = [];
  try { messages = sanitizeAssistantMessages(JSON.parse(legacy.messages)); } catch { /* ignore malformed legacy history */ }
  if (!messages.length) {
    database.prepare("DELETE FROM assistant_conversations WHERE user_id = ?").run(userId);
    return;
  }
  const id = `ac-${randomBytes(12).toString("hex")}`;
  const updatedAt = legacy.updated_at || new Date().toISOString();
  database.transaction(() => {
    database.prepare(`
      INSERT INTO assistant_conversation_threads
        (user_id, conversation_id, title, messages, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId, id, conversationTitle(messages), JSON.stringify(messages), updatedAt, updatedAt);
    database.prepare("DELETE FROM assistant_conversations WHERE user_id = ?").run(userId);
  })();
}

export function getAssistantHistoryState(userId: string): AssistantHistoryState {
  migrateLegacyHistory(userId);
  const rows = getDb().prepare(`
    SELECT conversation_id, title, messages, created_at, updated_at
    FROM assistant_conversation_threads
    WHERE user_id = ?
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(userId, MAX_CONVERSATIONS) as Array<{ conversation_id: string; title: string; messages: string; created_at: string; updated_at: string }>;
  const conversations = rows.map(parseConversation);
  return { activeId: conversations[0]?.id || "", conversations };
}

export function getAssistantHistory(userId: string): StoredAssistantMessage[] {
  return getAssistantHistoryState(userId).conversations[0]?.messages || [];
}

export function saveAssistantHistory(userId: string, conversationId: unknown, value: unknown): AssistantHistoryState {
  const id = text(conversationId, 40);
  if (!CONVERSATION_ID_RE.test(id)) throw new Error("invalid conversation id");
  const messages = sanitizeAssistantMessages(value);
  const database = getDb();
  const latest = database.prepare("SELECT updated_at FROM assistant_conversation_threads WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1").get(userId) as { updated_at: string } | undefined;
  const now = new Date(Math.max(Date.now(), (Date.parse(latest?.updated_at || "") || 0) + 1)).toISOString();
  const existing = database.prepare("SELECT created_at FROM assistant_conversation_threads WHERE user_id = ? AND conversation_id = ?").get(userId, id) as { created_at: string } | undefined;
  database.transaction(() => {
    database.prepare(`
      INSERT INTO assistant_conversation_threads
        (user_id, conversation_id, title, messages, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, conversation_id) DO UPDATE SET
        title = excluded.title,
        messages = excluded.messages,
        updated_at = excluded.updated_at
    `).run(userId, id, conversationTitle(messages), JSON.stringify(messages), existing?.created_at || now, now);
    const stale = database.prepare(`
      SELECT conversation_id FROM assistant_conversation_threads
      WHERE user_id = ? ORDER BY updated_at DESC LIMIT -1 OFFSET ?
    `).all(userId, MAX_CONVERSATIONS) as Array<{ conversation_id: string }>;
    const remove = database.prepare("DELETE FROM assistant_conversation_threads WHERE user_id = ? AND conversation_id = ?");
    for (const row of stale) remove.run(userId, row.conversation_id);
  })();
  return getAssistantHistoryState(userId);
}

export function clearAssistantHistory(userId: string, conversationId?: unknown): AssistantHistoryState {
  const id = text(conversationId, 40);
  if (id) {
    if (!CONVERSATION_ID_RE.test(id)) throw new Error("invalid conversation id");
    getDb().prepare("DELETE FROM assistant_conversation_threads WHERE user_id = ? AND conversation_id = ?").run(userId, id);
  } else {
    getDb().prepare("DELETE FROM assistant_conversation_threads WHERE user_id = ?").run(userId);
    getDb().prepare("DELETE FROM assistant_conversations WHERE user_id = ?").run(userId);
  }
  return getAssistantHistoryState(userId);
}
