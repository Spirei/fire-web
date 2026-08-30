/* ---------- 自选股分组（客户端模型，对应服务端 /api/v1/watch-groups） ----------
 *
 * 方案 A：分组为服务端独立实体（watch_groups 表），记录通过 watch_group_id 归属；
 * Web / iOS 共享同一份分组数据。此文件只做类型 / 纯函数 + 旧 localStorage 一次性迁移。
 */

export interface WatchGroup {
  id: string;
  name: string;
  icon: string;
  sort: number;
  /** -1 自动（空分组隐藏）/ 0 隐藏 / 1 显示 */
  visible: number;
  kind: "market" | "custom";
  market: string;
}

export const WATCH_MARKETS = ["US", "HK", "CN", "SG", "JP", "KR"] as const;

/** 分组是否显示：显式设置优先，默认空分组隐藏（与 iOS 一致） */
export function groupVisible(g: WatchGroup, count: number): boolean {
  if (g.visible >= 0) return g.visible === 1;
  return count > 0;
}

export function groupCount(g: WatchGroup, records: { market: string; watchGroupId?: string }[]): number {
  if (g.kind === "market") return records.filter((r) => r.market.toUpperCase() === g.market.toUpperCase()).length;
  return records.filter((r) => r.watchGroupId === g.id).length;
}

/* ---------- 旧版本（localStorage 分组配置）一次性迁移 ---------- */

interface LegacyGroupState {
  customGroups?: string[];
  groupOrder?: string[];
  visibility?: Record<string, boolean>;
  marketOrder?: string[];
  marketRenames?: Record<string, string>;
  groupIcons?: Record<string, string>;
}

const LEGACY_KEY = "fire:watch-groups:v1";

export function loadLegacyWatchGroups(): LegacyGroupState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LegacyGroupState;
    return parsed && Array.isArray(parsed.customGroups) ? parsed : null;
  } catch {
    return null;
  }
}

export function clearLegacyWatchGroups() {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    /* 忽略 */
  }
}

/**
 * 把旧 localStorage 分组配置（customGroups / 顺序 / 显隐 / 市场改名 / 分组图标）
 * 一次性同步到服务端分组实体，成功后清除本地旧配置。
 */
export async function migrateLegacyWatchGroups(
  current: WatchGroup[],
  api: {
    create: (name: string) => Promise<WatchGroup | null>;
    update: (id: string, input: { name?: string; icon?: string; visible?: number }) => Promise<boolean>;
    reorder: (order: string[]) => Promise<boolean>;
  }
): Promise<boolean> {
  const legacy = loadLegacyWatchGroups();
  if (!legacy) return false;

  let groups = [...current];
  const names = new Set(groups.filter((g) => g.kind === "custom").map((g) => g.name));
  // 1) 补建旧的自定义分组
  for (const name of legacy.customGroups ?? []) {
    if (!name.trim() || names.has(name)) continue;
    const created = await api.create(name);
    if (created) {
      groups = [...groups, created];
      names.add(name);
    }
  }
  // 2) 显隐 / 市场改名 / 分组图标
  for (const g of groups) {
    const update: { name?: string; icon?: string; visible?: number } = {};
    if (g.kind === "market") {
      const v = legacy.visibility?.[`M:${g.market}`];
      if (v !== undefined) update.visible = v ? 1 : 0;
      const rename = legacy.marketRenames?.[g.market];
      if (rename && rename !== g.name) update.name = rename;
    } else {
      const key = "G:" + g.name.trim().replace(/\s+/g, " ");
      const v = legacy.visibility?.[key];
      if (v !== undefined) update.visible = v ? 1 : 0;
      const icon = legacy.groupIcons?.[g.name];
      if (icon) update.icon = icon;
    }
    if (Object.keys(update).length > 0) await api.update(g.id, update);
  }
  // 3) 顺序：旧 marketOrder + groupOrder，缺失补在末尾
  const idByKey = new Map<string, string>();
  groups.forEach((g) => idByKey.set(g.kind === "market" ? `M:${g.market}` : `G:${g.name}`, g.id));
  const order: string[] = [];
  const seen = new Set<string>();
  const push = (key: string) => {
    if (seen.has(key)) return;
    const id = idByKey.get(key);
    if (id) {
      order.push(id);
      seen.add(key);
    }
  };
  (legacy.marketOrder ?? []).forEach((m) => push(`M:${m}`));
  (legacy.groupOrder ?? []).forEach((n) => push(`G:${n}`));
  groups.forEach((g) => push(g.kind === "market" ? `M:${g.market}` : `G:${g.name}`));
  if (order.length > 0) await api.reorder(order);

  clearLegacyWatchGroups();
  return true;
}
