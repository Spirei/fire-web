/** 手动填报的当前资产快照。USD 值固定在记录当时，避免后来汇率变化改写历史涨跌。 */
export type FireAssetRecord = {
  recordedAt: string;
  amountBase: number;
  currency: string;
  amountUsd: number;
};

const CURRENCIES = new Set(["USD", "HKD", "CNY", "SGD", "JPY", "KRW", "EUR"]);
const MAX_AMOUNT = 1_000_000_000_000_000;

export function validFireAssetAmount(amountBase: number, amountUsd: number, currency: string) {
  return Number.isFinite(amountBase) && amountBase > 0 && amountBase <= MAX_AMOUNT
    && Number.isFinite(amountUsd) && amountUsd > 0 && amountUsd <= MAX_AMOUNT
    && CURRENCIES.has(currency);
}

export function readFireAssetHistory(value: unknown): FireAssetRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is FireAssetRecord =>
    !!item && typeof item === "object"
    && typeof item.recordedAt === "string" && Number.isFinite(Date.parse(item.recordedAt))
    && validFireAssetAmount(item.amountBase, item.amountUsd, item.currency)
  ).sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
}

export function fireAssetChange(previousUsd: number, currentUsd: number): number | null {
  return previousUsd > 0 && Number.isFinite(previousUsd) && Number.isFinite(currentUsd)
    ? (currentUsd / previousUsd - 1) * 100
    : null;
}
