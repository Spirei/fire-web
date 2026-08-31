/* ---------- 自选股分组（服务端实体，Web / iOS 共用） ----------
 *
 * 方案 A：分组升级为独立实体（watch_groups 表），记录通过 watch_group_id 归属；
 * 券商仍走 records.group_name（持仓显示），与自选股分组彻底解耦。
 *  - kind=market：内置市场分组（美股/港股/A股/新加坡/日股/韩股），动态按市场过滤，不可删除
 *  - kind=custom：用户自定义分组，可增删改、批量分配记录
 *  - visible：-1 自动（空分组隐藏） / 0 隐藏 / 1 显示
 * 分组图标 URL 同时注册进素材库（type=group，防文件清理丢失）。
 */

import { randomBytes } from "crypto";
import { getDb } from "./db";
import { assetId, deleteAsset, upsertAsset } from "./assets";
import { removeFileIfUnused } from "./fileCleanup";

export interface WatchGroupDto {
  id: string;
  name: string;
  icon: string;
  sort: number;
  visible: number; // -1 自动 / 0 隐藏 / 1 显示
  kind: "market" | "custom";
  market: string;
}

interface WatchGroupRow {
  id: string;
  user_id: string;
  name: string;
  icon: string;
  sort: number;
  visible: number;
  kind: "market" | "custom";
  market: string;
  created_at: string;
}

export const MARKET_GROUPS: { market: string; name: string }[] = [
  { market: "US", name: "美股" },
  { market: "HK", name: "港股" },
  { market: "CN", name: "A股" },
  { market: "SG", name: "新加坡" },
  { market: "JP", name: "日股" },
  { market: "KR", name: "韩股" }
];

function gid() {
  return "wg-" + randomBytes(8).toString("hex");
}

function rowToDto(row: WatchGroupRow): WatchGroupDto {
  return {
    id: row.id,
    name: row.name,
    icon: row.icon,
    sort: row.sort,
    visible: row.visible,
    kind: row.kind,
    market: row.market
  };
}

/** 首次访问时给该用户播种内置市场分组 */
function seedMarketGroups(userId: string) {
  const db = getDb();
  const n = (db.prepare("SELECT COUNT(*) AS c FROM watch_groups WHERE user_id = ? AND kind = 'market'").get(userId) as { c: number }).c;
  if (n > 0) return;
  const now = new Date().toISOString();
  const insert = db.prepare(
    "INSERT INTO watch_groups (id, user_id, name, icon, sort, visible, kind, market, created_at) VALUES (?, ?, ?, '', ?, -1, 'market', ?, ?)"
  );
  MARKET_GROUPS.forEach((g, i) => insert.run(gid(), userId, g.name, i, g.market, now));
}

/** 旧数据迁移：records.group_name（券商名）去重自动建成自定义分组，记录指向对应分组（仅执行一次） */
function migrateLegacyGroups(userId: string) {
  const db = getDb();
  const custom = (db.prepare("SELECT COUNT(*) AS c FROM watch_groups WHERE user_id = ? AND kind = 'custom'").get(userId) as { c: number }).c;
  if (custom > 0) return;
  const rows = db
    .prepare("SELECT DISTINCT group_name FROM records WHERE user_id = ? AND group_name <> '' AND group_name IS NOT NULL")
    .all(userId) as { group_name: string }[];
  if (rows.length === 0) return;
  const now = new Date().toISOString();
  const maxSort = (db.prepare("SELECT COALESCE(MAX(sort), 0) AS s FROM watch_groups WHERE user_id = ?").get(userId) as { s: number }).s;
  const insert = db.prepare(
    "INSERT INTO watch_groups (id, user_id, name, icon, sort, visible, kind, market, created_at) VALUES (?, ?, ?, '', ?, -1, 'custom', '', ?)"
  );
  const assign = db.prepare("UPDATE records SET watch_group_id = ? WHERE user_id = ? AND group_name = ?");
  rows.forEach((r, i) => {
    const id = gid();
    insert.run(id, userId, r.group_name, maxSort + 1 + i, now);
    assign.run(id, userId, r.group_name);
  });
}

/**
 * 收敛旧版导入遗留的重复分组。市场分组按 market 唯一，自定义分组按
 * 规范化名称唯一；记录统一迁移到最早的分组，避免只隐藏重复项而丢失归属。
 */
function dedupeWatchGroups(userId: string) {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM watch_groups WHERE user_id = ? ORDER BY sort, created_at, id")
    .all(userId) as WatchGroupRow[];
  const canonicalByKey = new Map<string, WatchGroupRow>();
  const duplicates: { duplicate: WatchGroupRow; canonical: WatchGroupRow }[] = [];

  for (const row of rows) {
    const normalizedName = row.name.trim().replace(/\s+/g, " ").toLocaleLowerCase();
    const key = row.kind === "market"
      ? `market:${row.market.trim().toUpperCase()}`
      : `custom:${normalizedName}`;
    const canonical = canonicalByKey.get(key);
    if (canonical) duplicates.push({ duplicate: row, canonical });
    else canonicalByKey.set(key, row);
  }
  if (duplicates.length === 0) return;

  const merge = db.transaction(() => {
    const reassign = db.prepare("UPDATE records SET watch_group_id = ? WHERE user_id = ? AND watch_group_id = ?");
    const remove = db.prepare("DELETE FROM watch_groups WHERE id = ? AND user_id = ?");
    const removeAsset = db.prepare("DELETE FROM assets WHERE id = ?");
    for (const { duplicate, canonical } of duplicates) {
      reassign.run(canonical.id, userId, duplicate.id);
      removeAsset.run(assetId("group", "GROUP", duplicate.id));
      remove.run(duplicate.id, userId);
    }
  });
  merge();
}

export function listWatchGroups(userId: string): WatchGroupDto[] {
  seedMarketGroups(userId);
  migrateLegacyGroups(userId);
  dedupeWatchGroups(userId);
  const rows = getDb()
    .prepare("SELECT * FROM watch_groups WHERE user_id = ? ORDER BY sort, created_at")
    .all(userId) as WatchGroupRow[];
  return rows.map(rowToDto);
}

function getOwned(userId: string, id: string): WatchGroupRow | null {
  const row = getDb().prepare("SELECT * FROM watch_groups WHERE id = ? AND user_id = ?").get(id, userId) as WatchGroupRow | undefined;
  return row ?? null;
}

export function createWatchGroup(userId: string, name: string): WatchGroupDto {
  const db = getDb();
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 30) throw new Error("分组名称需为 1-30 个字符");
  const dup = db.prepare("SELECT id FROM watch_groups WHERE user_id = ? AND name = ?").get(userId, trimmed);
  if (dup) throw new Error("分组已存在");
  const maxSort = (db.prepare("SELECT COALESCE(MAX(sort), 0) AS s FROM watch_groups WHERE user_id = ?").get(userId) as { s: number }).s;
  const id = gid();
  db.prepare(
    "INSERT INTO watch_groups (id, user_id, name, icon, sort, visible, kind, market, created_at) VALUES (?, ?, ?, '', ?, -1, 'custom', '', ?)"
  ).run(id, userId, trimmed, maxSort + 1, new Date().toISOString());
  return rowToDto(getOwned(userId, id) as WatchGroupRow);
}

/** 分组图标注册进素材库（type=group，防文件清理丢失；同分组多次上传不堆积） */
function saveGroupAsset(groupId: string, name: string, url: string) {
  const db = getDb();
  const assetRowId = assetId("group", "GROUP", groupId);
  if (!url) {
    const row = db.prepare("SELECT url FROM assets WHERE id = ?").get(assetRowId) as { url?: string } | undefined;
    db.prepare("DELETE FROM assets WHERE id = ?").run(assetRowId);
    if (row?.url) removeFileIfUnused(row.url);
    return;
  }
  upsertAsset({ type: "group", market: "GROUP", code: groupId, name, url, source: "auto" });
  // upsert 对 manual 旧行有保护逻辑，这里强制覆盖 url / name（分组图标以最新上传为准）
  db.prepare("UPDATE assets SET url = ?, name = ?, updated_at = ? WHERE id = ?").run(url, name, new Date().toISOString(), assetRowId);
}

export function updateWatchGroup(
  userId: string,
  id: string,
  input: { name?: string; icon?: string; visible?: number }
): WatchGroupDto {
  const db = getDb();
  const row = getOwned(userId, id);
  if (!row) throw new Error("分组不存在");
  const name = input.name === undefined ? row.name : input.name.trim();
  if (!name || name.length > 30) throw new Error("分组名称需为 1-30 个字符");
  if (row.kind === "market" && input.visible === undefined && input.icon !== undefined) {
    // 市场分组暂不支持自定义图标（保留显示名重命名 + 显隐）
    throw new Error("市场分组不支持自定义图标");
  }
  if (name !== row.name) {
    const dup = db.prepare("SELECT id FROM watch_groups WHERE user_id = ? AND name = ? AND id <> ?").get(userId, name, id);
    if (dup) throw new Error("分组已存在");
  }
  const icon = input.icon === undefined ? row.icon : input.icon.trim();
  const visible = input.visible === undefined ? row.visible : input.visible;
  db.prepare("UPDATE watch_groups SET name = ?, icon = ?, visible = ? WHERE id = ? AND user_id = ?").run(name, icon, visible, id, userId);
  if (icon !== row.icon) saveGroupAsset(id, name, icon);
  return rowToDto(getOwned(userId, id) as WatchGroupRow);
}

export function deleteWatchGroup(userId: string, id: string): boolean {
  const db = getDb();
  const row = getOwned(userId, id);
  if (!row) return false;
  if (row.kind === "market") throw new Error("市场分组不可删除");
  db.prepare("UPDATE records SET watch_group_id = '' WHERE user_id = ? AND watch_group_id = ?").run(userId, id);
  db.prepare("DELETE FROM watch_groups WHERE id = ? AND user_id = ?").run(id, userId);
  const assetRowId = assetId("group", "GROUP", id);
  const assetRow = db.prepare("SELECT url FROM assets WHERE id = ?").get(assetRowId) as { url?: string } | undefined;
  if (assetRow?.url) {
    db.prepare("DELETE FROM assets WHERE id = ?").run(assetRowId);
    removeFileIfUnused(assetRow.url);
  }
  return true;
}

export function reorderWatchGroups(userId: string, order: string[]): number {
  const db = getDb();
  const owned = new Set(
    (db.prepare("SELECT id FROM watch_groups WHERE user_id = ?").all(userId) as { id: string }[]).map((r) => r.id)
  );
  const update = db.prepare("UPDATE watch_groups SET sort = ? WHERE id = ? AND user_id = ?");
  let updated = 0;
  order.forEach((id, i) => {
    if (owned.has(id)) {
      update.run(i, id, userId);
      updated++;
    }
  });
  return updated;
}

/** 批量分配 / 清除记录的分组（groupId 传空字符串表示移出分组） */
export function assignRecordsGroup(userId: string, ids: string[], groupId: string) {
  const db = getDb();
  if (ids.length === 0) return 0;
  if (groupId) {
    const group = getOwned(userId, groupId);
    if (!group || group.kind !== "custom") throw new Error("分组不存在或不可分配");
  }
  const marks = ids.map(() => "?").join(",");
  const result = db
    .prepare(`UPDATE records SET watch_group_id = ?, updated_at = ? WHERE user_id = ? AND id IN (${marks})`)
    .run(groupId, new Date().toISOString(), userId, ...ids);
  return result.changes;
}
