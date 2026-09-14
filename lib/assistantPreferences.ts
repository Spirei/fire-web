import { getDb } from "./db";

export type AssistantPreferences = { memoryEnabled: boolean; memory: string };

export function getAssistantPreferences(userId: string): AssistantPreferences {
  const row = getDb().prepare("SELECT memory_enabled, memory FROM assistant_preferences WHERE user_id = ?").get(userId) as { memory_enabled: number; memory: string } | undefined;
  return { memoryEnabled: row?.memory_enabled === 1, memory: (row?.memory || "").slice(0, 2000) };
}

export function saveAssistantPreferences(userId: string, value: unknown): AssistantPreferences {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const memoryEnabled = row.memoryEnabled === true;
  const memory = typeof row.memory === "string" ? row.memory.trim().slice(0, 2000) : "";
  getDb().prepare(`INSERT INTO assistant_preferences (user_id,memory_enabled,memory,updated_at) VALUES (?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET memory_enabled=excluded.memory_enabled,memory=excluded.memory,updated_at=excluded.updated_at`)
    .run(userId, memoryEnabled ? 1 : 0, memory, new Date().toISOString());
  return { memoryEnabled, memory };
}

export function clearAssistantPreferences(userId: string) {
  getDb().prepare("DELETE FROM assistant_preferences WHERE user_id = ?").run(userId);
  return { memoryEnabled: false, memory: "" };
}
