import { getDb } from "./db";

export type AssistantPreferences = { memoryEnabled: boolean; memory: string; selectedModel: string };

export function getAssistantPreferences(userId: string): AssistantPreferences {
  const row = getDb().prepare("SELECT memory_enabled, memory, selected_model FROM assistant_preferences WHERE user_id = ?").get(userId) as { memory_enabled: number; memory: string; selected_model: string } | undefined;
  return { memoryEnabled: row?.memory_enabled === 1, memory: (row?.memory || "").slice(0, 2000), selectedModel: row?.selected_model || "auto" };
}

export function saveAssistantPreferences(userId: string, value: unknown): AssistantPreferences {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const current = getAssistantPreferences(userId);
  const memoryEnabled = typeof row.memoryEnabled === "boolean" ? row.memoryEnabled : current.memoryEnabled;
  const memory = typeof row.memory === "string" ? row.memory.trim().slice(0, 2000) : current.memory;
  const selectedModel = typeof row.selectedModel === "string" && row.selectedModel.length <= 300 ? (row.selectedModel.trim() || "auto") : current.selectedModel;
  getDb().prepare(`INSERT INTO assistant_preferences (user_id,memory_enabled,memory,selected_model,updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET memory_enabled=excluded.memory_enabled,memory=excluded.memory,selected_model=excluded.selected_model,updated_at=excluded.updated_at`)
    .run(userId, memoryEnabled ? 1 : 0, memory, selectedModel, new Date().toISOString());
  return { memoryEnabled, memory, selectedModel };
}

export function clearAssistantPreferences(userId: string) {
  getDb().prepare("DELETE FROM assistant_preferences WHERE user_id = ?").run(userId);
  return { memoryEnabled: false, memory: "", selectedModel: "auto" };
}
