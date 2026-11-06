// 浏览器契约类型；业务由 Fire 内置后端统一执行。

export interface FutuQuota {
  subscription?: {
    totalUsed: number;
    remain: number;
    ownUsed: number;
    totalQuota: number;
    ownTotalQuota: number;
  };
  historyKl?: {
    used: number;
    remain: number;
    totalQuota: number;
  };
}
export interface FutuDividendRaw {
  pub_date?: string;
  statement?: string;
  record_date?: string;
  ex_date?: string;
  dividend_payable_date?: string;
  process?: string;
  fiscal_year?: string | number;
}
export interface FutuKlineRow {
  time_key: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
}
