import { createHash } from "crypto";
import { getDb } from "./db";

const KEEP_MS = 30 * 24 * 60 * 60 * 1000;

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
}

function requestHash(payload: unknown) {
  return createHash("sha256").update(JSON.stringify(stable(payload))).digest("hex");
}

export function runAssistantAction<T>(input: {
  userId: string;
  actionId: string;
  actionType: string;
  payload: unknown;
  execute: () => T;
}): { result: T; replayed: boolean } {
  const db = getDb();
  const hash = requestHash(input.payload);
  const run = db.transaction(() => {
    const existing = db.prepare("SELECT action_type, request_hash, response FROM assistant_actions WHERE user_id = ? AND action_id = ?")
      .get(input.userId, input.actionId) as { action_type: string; request_hash: string; response: string } | undefined;
    if (existing) {
      if (existing.action_type !== input.actionType || existing.request_hash !== hash) throw new Error("操作标识与原请求不一致，请重新生成预览");
      return { result: JSON.parse(existing.response) as T, replayed: true };
    }
    const result = input.execute();
    db.prepare("INSERT INTO assistant_actions (user_id, action_id, action_type, request_hash, response, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(input.userId, input.actionId, input.actionType, hash, JSON.stringify(result), new Date().toISOString());
    return { result, replayed: false };
  });
  const response = run();
  // 幂等窗口远长于前端 15 分钟确认窗口；清理失败不影响本次操作。
  try {
    db.prepare("DELETE FROM assistant_actions WHERE created_at < ?").run(new Date(Date.now() - KEEP_MS).toISOString());
  } catch { /* no-op */ }
  return response;
}
