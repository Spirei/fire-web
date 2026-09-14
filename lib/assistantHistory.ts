import { getDb } from "./db";

export interface StoredAssistantMessage {
  role: "user" | "assistant";
  content: string;
  action?: Record<string, unknown>;
  actionStatus?: "running" | "done" | "error";
  undo?: Record<string, unknown>;
}

const MAX_MESSAGES = 30;
const MAX_BYTES = 64 * 1024;

export function sanitizeAssistantMessages(value: unknown): StoredAssistantMessage[] {
  if (!Array.isArray(value)) return [];
  const messages = value.flatMap((item): StoredAssistantMessage[] => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    if ((row.role !== "user" && row.role !== "assistant") || typeof row.content !== "string") return [];
    const message: StoredAssistantMessage = { role: row.role, content: row.content.slice(0, 4000) };
    if (row.action && typeof row.action === "object") message.action = row.action as Record<string, unknown>;
    if (["running", "done", "error"].includes(String(row.actionStatus))) message.actionStatus = row.actionStatus as StoredAssistantMessage["actionStatus"];
    if (row.undo && typeof row.undo === "object") message.undo = row.undo as Record<string, unknown>;
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
