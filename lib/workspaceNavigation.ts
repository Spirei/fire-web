export const MOBILE_PRIMARY_KEYS = ["assets", "watchlist", "holdings", "settings"] as const;
export const MOBILE_NAV_LABELS: Record<string, string> = { assets: "总览", watchlist: "自选", holdings: "持仓", settings: "设置" };

export function normalizeMobileNavigationOrder(value: unknown, available: readonly string[]): string[] {
  if (!Array.isArray(value)) return [];
  const allowed = new Set(available);
  return [...new Set(value.filter((key): key is string => typeof key === "string" && allowed.has(key)))].slice(0, 64);
}

/** 新增入口自动补入，删除和权限过滤不留空位；四个主入口与更多始终分组。 */
export function mobileWorkspaceGroups<T extends { key: string }>(items: readonly T[], order: readonly string[] = []) {
  const ordered = [...normalizeMobileNavigationOrder(order, items.map(item => item.key)), ...items.map(item => item.key)];
  const keys = [...new Set(ordered)];
  const isPrimary = (key: string) => (MOBILE_PRIMARY_KEYS as readonly string[]).includes(key);
  const primaryOrder = [...new Set([...normalizeMobileNavigationOrder(order, items.map(item => item.key)).filter(isPrimary), ...MOBILE_PRIMARY_KEYS])];
  const find = (key: string) => items.filter(item => item.key === key);
  return { primary: primaryOrder.flatMap(find), more: keys.filter(key => !isPrimary(key)).flatMap(find) };
}
