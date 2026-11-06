// 浏览器契约类型；业务由 Fire 内置后端统一执行。
import type {Market} from "./types";
export interface QuoteDetailMetrics {
  /** Snapshot currency; cap is an observed total, never ETF AUM/price-derived. */
  currency?: string | null;
  time?: string;
  source?: "futu" | "tencent";
  turnoverRate?: number | null;
  peTtm?: number | null;
  pe?: number | null;
  marketCap?: number | null;
  dividendYieldTtm?: number | null;
}
export interface Quote {
  name: string;
  price: number;
  change: number;
  changePct: number;
  open: number;
  high: number;
  low: number;
  time: string;
  /** 当前涨跌的常规收盘基准；夜盘为本周期 20:00 前的最近常规收盘。 */
  prevClose?: number;
  /** PRE / AFTER / OVERNIGHT 表示当前 price 已切换为对应扩展时段有效价。 */
  session?: "PRE" | "REGULAR" | "AFTER" | "OVERNIGHT";
  /** 成交量（股/手，腾讯 f36） */
  volume?: number;
  /** 成交额（本地货币，腾讯 f37） */
  amount?: number;
  /** 市盈率（腾讯 f39） */
  pe?: number;
  /** 换手率 %（腾讯 f38） */
  turnover?: number;
  amplitude?: number;
  epsTtm?: number;
  weekHigh?: number;
  weekLow?: number;
  pb?: number;
  dividendYieldTtm?: number;
  volumeRatio?: number;
  totalShares?: number;
  floatShares?: number;
  staticPe?: number;
  dividendTtm?: number;
  averagePrice?: number;
  /** 总市值（本地货币，腾讯 f44 × 1e8） */
  marketCap?: number;
  /** Optional strict detail metrics; legacy pe/marketCap remain independent. */
  detailMetrics?: QuoteDetailMetrics;
  /** 行情来源：futu=富途 / tencent=腾讯兜底 / yahoo=Yahoo 扩展时段兜底 / auto */
  source?: "futu" | "tencent" | "yahoo" | "auto";
  /** A recent active-pool snapshot was returned while scheduled updates continue. */
  cached?: boolean;
}
export interface QuoteItem {
  id: string;
  market: Market;
  code: string;
}
export interface IntradayPoint {
  time: string;
  price: number;
  volume?: number;
}
export interface Intraday {
  date: string;
  points: IntradayPoint[];
  stale?: boolean;
  source?: "futu" | "tencent" | "eastmoney" | "yahoo";
}
export interface IndexQuote {
  name: string;
  open: number | null;
  latest: number | null;
  changePct: number | null;
  time: string;
  extra?: string;
}
export interface MarketIndices {
  market: Market;
  label: string;
  flag: string;
  open: boolean;
  indices: IndexQuote[];
}
