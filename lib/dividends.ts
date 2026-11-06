// 浏览器契约类型；业务由 Fire 内置后端统一执行。

export type DividendKind = "cash" | "special";
export type DividendPhase = "before" | "pending" | "booked" | "missing" | "unowned" | "info";
export interface DividendLedgerRow {
  exDate: string | null;
  payDate: string | null;
  heldQty: number;
  booked: boolean;
  phase: DividendPhase;
}
export interface DividendRecord {
  pubDate: string | null;
  exDate: string | null;
  recordDate: string | null;
  payDate: string | null;
  statement: string;
  process: string | null;
  fiscalYear: string | null;
  amount: number | null;
  currency: string | null;
  kind: DividendKind;
  /** 当期股息率：每股股息 / 除息日前收盘价 */
  yieldPct?: number | null;
}
export type DividendSource = "futu" | "eastmoney" | "yahoo" | "cache" | "cache-stale" | "unavailable";
interface CacheRow {
  payload: string;
  fetched_at: number;
}
