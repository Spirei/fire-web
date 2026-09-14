import { getDb } from "./db";

export type AssistantPreferences = { memoryEnabled: boolean; memory: string; defaultModel: string };

export function getAssistantPreferences(userId: string): AssistantPreferences {
  const row = getDb().prepare("SELECT memory_enabled, memory, default_model FROM assistant_preferences WHERE user_id = ?").get(userId) as { memory_enabled: number; memory: string; default_model: string } | undefined;
  return { memoryEnabled: row?.memory_enabled === 1, memory: (row?.memory || "").slice(0, 2000), defaultModel: row?.default_model || "auto" };
}

export function saveAssistantPreferences(userId: string, value: unknown): AssistantPreferences {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const current = getAssistantPreferences(userId);
  const memoryEnabled = typeof row.memoryEnabled === "boolean" ? row.memoryEnabled : current.memoryEnabled;
  const memory = typeof row.memory === "string" ? row.memory.trim().slice(0, 2000) : current.memory;
  const defaultModel = typeof row.defaultModel === "string" && row.defaultModel.length <= 300 ? (row.defaultModel.trim() || "auto") : current.defaultModel;
  getDb().prepare(`INSERT INTO assistant_preferences (user_id,memory_enabled,memory,default_model,updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET memory_enabled=excluded.memory_enabled,memory=excluded.memory,default_model=excluded.default_model,updated_at=excluded.updated_at`)
    .run(userId, memoryEnabled ? 1 : 0, memory, defaultModel, new Date().toISOString());
  return { memoryEnabled, memory, defaultModel };
}

export function clearAssistantPreferences(userId: string) {
  getDb().prepare("DELETE FROM assistant_preferences WHERE user_id = ?").run(userId);
  return { memoryEnabled: false, memory: "", defaultModel: "auto" };
}
