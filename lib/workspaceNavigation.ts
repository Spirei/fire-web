export const MOBILE_PRIMARY_KEYS = ["assets", "watchlist", "holdings", "settings"] as const;
export const MOBILE_NAV_LABELS: Record<string, string> = { assets: "总览", watchlist: "自选", holdings: "持仓", settings: "设置", fire: "FIRE", global: "全球", "quote-pool": "股票池", trading: "动态", earnings: "财报", assistant: "助手", celebs: "名人", users: "用户", attachments: "附件", library: "素材", cards: "卡面", activities: "日志" };

export function normalizeMobileNavigationOrder(value: unknown, available: readonly string[]): string[] {
  if (!Array.isArray(value)) return [];
  const allowed = new Set(available);
  return [...new Set(value.filter((key): key is string => typeof key === "string" && allowed.has(key)))].slice(0, 64);
}

/** 前四项为底部入口，其余进更多；未配置时保留原默认入口，权限过滤后自动补位。 */
export function mobileWorkspaceGroups<T extends { key: string }>(items: readonly T[], order: readonly string[] = []) {
  const ordered = [...normalizeMobileNavigationOrder(order, items.map(item => item.key)), ...MOBILE_PRIMARY_KEYS, ...items.map(item => item.key)];
  const keys = [...new Set(ordered)];
  const find = (key: string) => items.filter(item => item.key === key);
  const available = keys.flatMap(find);
  return { primary: available.slice(0, 4), more: available.slice(4) };
}

export function moveMobileNavigation(keys: readonly string[], from: number, to: number): string[] {
  const next = [...keys];
  if (!Number.isInteger(from) || !Number.isInteger(to) || from === to || from < 0 || from >= next.length || to < 0 || to >= next.length) return next;
  const [key] = next.splice(from, 1);
  next.splice(to, 0, key);
  return next;
}
