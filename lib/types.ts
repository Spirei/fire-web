export type Market = string;

export interface StockRecord {
  id: string;
  name: string;
  code: string;
  market: Market;
  price: number | "";
  cost: number | "";
  qty: number | "";
  group: string;
  /** 自选股分组 id（方案 A 独立分组实体），空串 = 未分组 */
  watchGroupId?: string;
  note: string;
  source?: string;
  updatedAt: string;
}

export interface RecordInput {
  name: string;
  code: string;
  market: Market;
  price: number | "";
  cost: number | "";
  qty: number | "";
  group: string;
  watchGroupId?: string;
  note: string;
  source?: string;
}

export type OrderSide = "buy" | "sell" | "dividend";
export type OrderStatus = "filled" | "cancelled" | "pending" | "expired";
export type OrderType = "limit" | "market" | "trigger_buy" | "trigger_sell" | "rebound_buy" | "rebound_sell";
export type OrderValidity = "day" | "gtc" | "custom";

/** 成交订单账本；持仓是订单执行后的汇总快照，订单是不可丢失的历史依据。 */
export interface TradeOrder {
  id: string;
  /** 唯一订单号（10 位数字），每笔成交生成一次且不可变更 */
  orderNo: string;
  recordId: string;
  market: Market;
  code: string;
  name: string;
  side: OrderSide;
  status: OrderStatus;
  qty: number;
  price: number;
  fees: number;
  amount: number;
  realizedPnl: number | null;
  positionQtyBefore: number;
  positionCostBefore: number | null;
  positionQtyAfter: number;
  positionCostAfter: number | null;
  broker: string;
  note: string;
  /** 委托类型：limit / market / trigger_buy / trigger_sell / rebound_buy / rebound_sell */
  orderType: OrderType;
  /** 触发价格（到价/反弹/回落/限价挂单），立即成交的普通委托为 null */
  triggerPrice: number | null;
  /** 有效期：day / gtc / custom */
  tif: OrderValidity;
  /** 自定义有效期到期时间（ISO），非 custom 为 null */
  expiresAt: string | null;
  /** 时段（盘中+盘前盘后 / 仅盘中 / 盘前 / 盘后） */
  session: string;
  /** 触发状态 */
  triggerStatus: string;
  tradedAt: string;
  createdAt: string;
}

export const MARKET_META: Record<string, { label: string; currency: string; code: string; flag: string }> = {
  HK: { label: "港股", currency: "HK$", code: "HKD$", flag: "🇭🇰" },
  US: { label: "美股", currency: "$", code: "USD$", flag: "🇺🇸" },
  CN: { label: "A股", currency: "¥", code: "CNY¥", flag: "🇨🇳" },
  JP: { label: "日股", currency: "¥", code: "JPY¥", flag: "🇯🇵" },
  KR: { label: "韩股", currency: "₩", code: "KRW₩", flag: "🇰🇷" },
  OTHER: { label: "其他", currency: "", code: "", flag: "🌐" }
};

export const MARKET_LIST = Object.keys(MARKET_META) as Market[];

export function marketMeta(market: string) {
  return MARKET_META[market as Market] ?? { label: market || "其他", currency: "", code: "", flag: "🌍" };
}

/**
 * 汇率兜底值：服务端汇率尚未返回时用于跨市场换算，
 * 避免港股 / A股 / 日股 / 韩股被按 1:1 误算成美元（导致总资产刷新闪变）。
 * 服务端 fetch 成功后会用真实汇率覆盖。
 */
export const FALLBACK_RATES: Record<string, number> = {
  USD: 1,
  CNY: 7.2,
  HKD: 7.85,
  JPY: 155,
  KRW: 1350,
  SGD: 1.35,
  GBP: 1.28,
  EUR: 1.08,
  AUD: 0.66,
  CAD: 0.73,
  INR: 0.012,
  TWD: 0.031,
  BRL: 0.18
};

export interface MarketOption {
  key: string;
  label: string;
  flag: string;
}

export interface User {
  id: string;
  username: string;
  nickname: string;
  uid: string;
  email: string;
  avatar: string;
  role: "user" | "admin";
  isTest?: boolean;
}

export interface Quote {
  name: string;
  price: number;
  change: number;
  changePct: number;
  /** 今开（腾讯 f5） */
  open: number;
  high: number;
  low: number;
  time: string;
  prevClose?: number;
  session?: "PRE" | "REGULAR" | "AFTER" | "OVERNIGHT";
  /** 行情来源：futu=富途 / tencent=腾讯兜底 / yahoo=Yahoo 扩展兜底 */
  source?: "futu" | "tencent" | "yahoo" | "auto";
  /** 成交量（腾讯 f36） */
  volume?: number;
  /** 成交额（本地货币，腾讯 f37） */
  amount?: number;
  /** 市盈率（腾讯 f39） */
  pe?: number;
  /** 换手率 %（腾讯 f43） */
  turnover?: number;
  /** 总市值（本地货币，腾讯 f44 × 1e8） */
  marketCap?: number;
  /** 总股本（富途 issued_shares / 腾讯 f62），市值缺失时用于 价格 × 总股本 估算 */
  totalShares?: number;
}

export interface SearchMatch {
  symbol: string;
  code: string;
  name: string;
  market: Market;
  price: number | null;
  changePct: number | null;
}

export interface Activity {
  id: string;
  action: "created" | "updated" | "deleted";
  userName: string;
  userAvatar: string;
  stockName: string;
  stockCode: string;
  market: Market;
  price: number | null;
  cost: number | null;
  qty: number | null;
  createdAt: string;
}

export interface TabConfig {
  key: string;
  label: string;
  url?: string;
  default?: boolean;
}

export interface GroupConfig {
  id: string;
  name: string;
  /** 券商别名（如 盈透证券 → IBKR），展示在名称下方小字，可选 */
  alias?: string;
}

export interface HomeNavItem {
  key: string;
  label: string;
  href: string;
  enabled: boolean;
}

export interface SiteSettings {
  domain: string;
  title: string;
  ico: string;
  homepageBg: string;
  /** 登录弹窗左侧配图（管理员上传） */
  loginSideImage: string;
  tabs: TabConfig[];
  groups: GroupConfig[];
  homeNav: HomeNavItem[];
  markets: Market[];
  marketLabels: { key: string; label: string; flag: string }[];
  assetMarketOrder: string[];
  indicesOrder: string[];
  holdingColumns: import("./holdingColumns").HoldingColumnPreference[];
  allowRegister: boolean;
  stockIconCdn: boolean;
  siteLogo: string;
  logoText: string;
  logoFont: "diatype" | "diatype-regular" | "system";
  /** 行情源：auto = 富途优先 + 腾讯/Yahoo 自动回退；futu = 仅富途；tencent = 腾讯 + Yahoo */
  quoteSource: "auto" | "futu" | "tencent";
  /** 富途 OpenD 网关地址（支持远程部署，默认本机） */
  futuHost: string;
  /** 富途 OpenD 网关端口 */
  futuPort: string;
  footerDesc: string;
  quoteApiUrl: string;
  searchApiUrl: string;
  chartApiUrl: string;
  currencyApiUrl: string;
  earningsApiUrl: string;
  cnEarningsApiUrl: string;
  usLogoApiUrl: string;
  cnLogoApiUrl: string;
  dbType: "sqlite" | "postgres";
  pgHost: string;
  pgPort: string;
  pgDatabase: string;
  pgUser: string;
  pgPassword: string;
  ticker: TickerConfig;
}

export interface TickerItemConfig {
  key: string;
  label: string;
  secid: string;
  market: string;
}

export interface TickerConfig {
  items: TickerItemConfig[];
  interval: number;
}
