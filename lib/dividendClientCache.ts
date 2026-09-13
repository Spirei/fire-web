import type { DividendLedgerRow, DividendRecord } from "./dividends";

export interface DividendClientSnapshot {
  dividends: DividendRecord[];
  sourceOk: boolean;
  ledger?: DividendLedgerRow[];
  firstBuyDate?: string | null;
  savedAt: number;
}

const PREFIX = "fire:dividends:v1";

export function dividendClientCacheKey(market: string, code: string, recordId?: string) {
  return `${PREFIX}:${market.trim().toUpperCase()}:${code.trim().toUpperCase()}:${recordId || "quote"}`;
}

export function readDividendClientCache(key: string): DividendClientSnapshot | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "null") as DividendClientSnapshot | null;
    if (!parsed || !Array.isArray(parsed.dividends) || parsed.sourceOk !== true) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeDividendClientCache(key: string, snapshot: Omit<DividendClientSnapshot, "savedAt">) {
  try {
    localStorage.setItem(key, JSON.stringify({ ...snapshot, savedAt: Date.now() }));
  } catch {
    // 隐私模式或容量不足时仍可使用服务端持久缓存。
  }
}
