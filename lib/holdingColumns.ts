export const HOLDING_COLUMN_KEYS = [
  "identity",
  "marketValue",
  "cost",
  "price",
  "qty",
  "dayPnl",
  "dayPnlRate",
  "pnl",
  "pnlRate",
  "weight"
] as const;

export type HoldingColumnKey = (typeof HOLDING_COLUMN_KEYS)[number];

export interface HoldingColumnPreference {
  key: HoldingColumnKey;
  visible: boolean;
}

export const HOLDING_COLUMN_LABELS: Record<HoldingColumnKey, string> = {
  identity: "名称 / 代码",
  marketValue: "持仓市值",
  cost: "成本价",
  price: "最新价",
  qty: "持仓数量",
  dayPnl: "当日盈亏",
  dayPnlRate: "当日盈亏率",
  pnl: "浮动盈亏",
  pnlRate: "浮动盈亏率",
  weight: "持仓占比"
};

export const DEFAULT_HOLDING_COLUMNS: HoldingColumnPreference[] = HOLDING_COLUMN_KEYS.map((key) => ({
  key,
  visible: key !== "dayPnlRate"
}));

export function normalizeHoldingColumns(value: unknown): HoldingColumnPreference[] {
  if (!Array.isArray(value)) return DEFAULT_HOLDING_COLUMNS.map((item) => ({ ...item }));
  const seen = new Set<HoldingColumnKey>();
  const normalized: HoldingColumnPreference[] = [];
  value.forEach((item) => {
    if (!item || typeof item !== "object") return;
    const raw = item as { key?: unknown; visible?: unknown };
    if (typeof raw.key !== "string" || !(HOLDING_COLUMN_KEYS as readonly string[]).includes(raw.key)) return;
    const key = raw.key as HoldingColumnKey;
    if (seen.has(key)) return;
    seen.add(key);
    normalized.push({ key, visible: raw.visible !== false });
  });
  DEFAULT_HOLDING_COLUMNS.forEach((item) => {
    if (!seen.has(item.key)) normalized.push({ ...item });
  });
  return normalized;
}
