import { getDb } from "./db";
import { readFireAssetHistory, type FireAssetRecord } from "./fireAssetHistory";

/** 读取某用户的 FIRE 配置 JSON（不存在返回 null） */
export function getUserFire(userId: string): Record<string, unknown> | null {
  try {
    const row = getDb().prepare("SELECT fire FROM user_settings WHERE user_id = ?").get(userId) as { fire: string } | undefined;
    if (!row?.fire) return null;
    const parsed = JSON.parse(row.fire);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** 保存某用户的 FIRE 配置 JSON（UPSERT） */
export function setUserFire(userId: string, fire: Record<string, unknown>, assetRecord?: FireAssetRecord): FireAssetRecord[] {
  // 自动保存计划参数时不能覆盖另一设备刚追加的资产历史。
  const history = readFireAssetHistory(getUserFire(userId)?.assetHistory);
  if (assetRecord) history.push(assetRecord);
  const retainedHistory = history.slice(-1500);
  const next = { ...fire, assetHistory: retainedHistory };
  getDb()
    .prepare(
      `INSERT INTO user_settings (user_id, fire) VALUES (?, ?)
       ON CONFLICT(user_id) DO UPDATE SET fire = excluded.fire`
    )
    .run(userId, JSON.stringify(next));
  return retainedHistory;
}
