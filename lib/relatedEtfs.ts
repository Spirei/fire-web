import * as directory from "../platform/backend/alcor_api/data/discovery-related-etfs.json";

/**
 * 个股详情页的相关 ETF 目录。
 *
 * 这里维护的是“跟踪 / 做多 / 做空 / 收益策略”关系，而不是把搜索结果
 * 当成 ETF。这样列表在行情源暂时不可用时仍然稳定，价格再由 quotes 接口
 * 实时补齐。未收录的股票显示空态，避免猜测错误产品。
 */
export type RelatedETFKind = "long" | "short" | "income";

export interface RelatedETF {
  code: string;
  name: string;
  kind: RelatedETFKind;
  badge: string;
}

export const US_RELATED_ETFS = directory.products as Record<string, RelatedETF[]>;

export interface RelatedStock {
  code: string;
  name: string;
  kind: RelatedETFKind;
  badge: string;
}

const US_STOCK_NAMES: Record<string, string> = {
  NVDA: "NVIDIA",
  AAPL: "苹果",
  TSLA: "特斯拉",
  AMD: "AMD",
  AMZN: "亚马逊",
  MSFT: "微软",
  GOOGL: "Alphabet",
  GOOG: "Alphabet",
  META: "Meta",
  COIN: "Coinbase",
  RKLB: "Rocket Lab",
  SPCX: "SpaceX",
  MSTR: "Strategy",
  SPY: "标普500 ETF",
  QQQ: "纳斯达克100 ETF",
  SMCI: "超微电脑",
  HOOD: "Robinhood",
  MU: "美光科技",
  NFLX: "奈飞",
  TSM: "台积电",
  SNDK: "闪迪",
  UNH: "联合健康",
  ECHO: "EchoStar",
  INTC: "英特尔",
  NIO: "蔚来",
  WDC: "西部数据",
  XPEV: "小鹏汽车",
  SKHY: "SK海力士"
};

function normalizedUsCode(code: string) {
  return (code || "").trim().toUpperCase().replace(/\.(?:AM|N|OQ|PS|K)$/i, "");
}

/**
 * ETF → 正股的唯一关系表。图标、正向“相关 ETF”和反向“正股”展示均从
 * US_RELATED_ETFS 派生，避免各模块各维护一份清单后再次出现数量不一致。
 */
export const RELATED_ETF_MAIN_STOCK: Record<string, string> = Object.entries(US_RELATED_ETFS).reduce(
  (map, [stock, etfs]) => {
    etfs.forEach((etf) => {
      // GOOG / GOOGL 会共享部分 ETF，保留目录里先出现的规范正股 GOOGL。
      if (!map[etf.code]) map[etf.code] = stock;
    });
    return map;
  },
  { ...directory.legacyUnderlyings } as Record<string, string>
);

const RELATED_ETF_BY_CODE: Record<string, RelatedETF> = Object.values(US_RELATED_ETFS).flat().reduce(
  (map, etf) => {
    if (!map[etf.code]) map[etf.code] = etf;
    return map;
  },
  {} as Record<string, RelatedETF>
);

export function relatedETFs(market: string, code: string): RelatedETF[] {
  if (market.toUpperCase() !== "US") return [];
  return US_RELATED_ETFS[normalizedUsCode(code)] ?? [];
}

/** ETF 详情页反向查找对应正股；非相关 ETF 返回 null。 */
export function relatedStock(market: string, code: string): RelatedStock | null {
  if (market.toUpperCase() !== "US") return null;
  const stockCode = RELATED_ETF_MAIN_STOCK[normalizedUsCode(code)];
  if (!stockCode) return null;
  return {
    code: stockCode,
    name: US_STOCK_NAMES[stockCode] ?? stockCode,
    kind: "long",
    badge: "正股"
  };
}

export type RelatedEtfBadgeTone = "long2x" | "short" | "income" | "long";

export interface RelatedEtfBadgeMeta {
  label: "2x" | "反" | "收" | "多";
  title: string;
  tone: RelatedEtfBadgeTone;
}

function is2xProduct(badge: string, name?: string) {
  return /(2x|2倍|两倍)/i.test(badge) || /(2x|2倍|两倍)/i.test(name || "");
}

function isShortProduct(name?: string) {
  return /(做空|short|inverse|bear)/i.test(name || "");
}

/** 全站相关 ETF 图标角标：统一从关系目录派生，避免各组件自行判断和展示。 */
export function relatedEtfBadge(market: string, code: string, name?: string): RelatedEtfBadgeMeta | null {
  if (market.toUpperCase() === "US") {
    const normalized = normalizedUsCode(code);
    const relation = RELATED_ETF_BY_CODE[normalized];
    if (relation) {
      if (relation.kind === "income") return { label: "收", title: "收益策略", tone: "income" };
      const double = is2xProduct(relation.badge, relation.name);
      if (relation.kind === "short") {
        return { label: double ? "2x" : "反", title: relation.badge, tone: "short" };
      }
      return double
        ? { label: "2x", title: relation.badge, tone: "long2x" }
        : { label: "多", title: relation.badge, tone: "long" };
    }
  }
  if (!isDoubleEtf(market, code, name)) return null;
  const short = isShortProduct(name);
  return { label: "2x", title: short ? "2X 做空" : "2X 做多", tone: short ? "short" : "long2x" };
}

/** 判断某只股票/ETF 是否为 2 倍杠杆产品（用于显示 2x 徽标）：
 * 优先命中相关 ETF 目录的 badge/名称，再按名称兜底（覆盖港/A 股或中文名如“两倍做多闪迪”）。 */
export function isDoubleEtf(market: string, code: string, name?: string): boolean {
  const m = (market || "").toUpperCase();
  const hit = m === "US" ? RELATED_ETF_BY_CODE[normalizedUsCode(code)] : undefined;
  return hit ? is2xProduct(hit.badge, hit.name) : is2xProduct("", name);
}
