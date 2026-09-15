const PAGE_LABELS: Record<string, string> = {
  holdings: "账户资产", assets: "资产分析", pnl: "资产总盈亏", fire: "FIRE",
  watchlist: "自选股", global: "全球经济", trading: "交易广场", earnings: "财报日历",
  celebs: "名人持仓", cards: "卡面库", library: "素材库", settings: "设置",
  // 管理分组也要能被浮动入口识别，否则在这些页面上助手只能说"当前页面上下文为空"
  users: "用户管理", attachments: "附件管理", activities: "日志"
};

export type SafeAssistantContext = { page?: string; label: string; symbol?: string; filter?: string };

export function normalizeAssistantContext(input: unknown): SafeAssistantContext {
  const raw = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const candidate = typeof raw.page === "string" ? raw.page.trim().toLowerCase() : "";
  const page = Object.hasOwn(PAGE_LABELS, candidate) ? candidate : undefined;
  const symbolRaw = typeof raw.symbol === "string" ? raw.symbol.trim().toUpperCase() : "";
  const filterRaw = typeof raw.filter === "string" ? raw.filter.trim().toLowerCase() : "";
  return {
    ...(page ? { page } : {}),
    label: page ? PAGE_LABELS[page] : "当前页面",
    ...(/^[A-Z0-9.:-]{1,30}$/.test(symbolRaw) ? { symbol: symbolRaw } : {}),
    ...(/^[a-z0-9:_-]{1,50}$/.test(filterRaw) ? { filter: filterRaw } : {})
  };
}

export function validateAssistantEndpoint(input: string): string | null {
  if (!input || input.length > 2048) return null;
  try {
    const url = new URL(input);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password || url.hash) return null;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (!host || host === "0.0.0.0" || host === "metadata.google.internal" || host === "metadata.azure.internal") return null;
    if (/^169\.254\./.test(host) || /^fe[89ab][0-9a-f]:/i.test(host) || host === "100.100.100.200") return null;
    return url.toString();
  } catch {
    return null;
  }
}
