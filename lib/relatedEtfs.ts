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

export const US_RELATED_ETFS: Record<string, RelatedETF[]> = {
  NVDA: [
    { code: "NVDL", name: "GraniteShares 2x Long NVDA Daily ETF", kind: "long", badge: "2X 做多" },
    { code: "NVD", name: "GraniteShares 2x Short NVDA Daily ETF", kind: "short", badge: "-2X 做空" },
    { code: "NVDX", name: "T-Rex 2X Long NVIDIA Daily Target ETF", kind: "long", badge: "2X 做多" },
    { code: "NVDU", name: "Direxion Daily NVDA Bull 2X Shares", kind: "long", badge: "2X 做多" },
    { code: "NVDQ", name: "T-Rex 2X Inverse NVIDIA Daily Target ETF", kind: "short", badge: "-2X 做空" },
    { code: "NVDY", name: "YieldMax NVDA Option Income Strategy ETF", kind: "income", badge: "期权收益" },
    { code: "NVDS", name: "T-Rex 1.5X Short NVIDIA Daily Target ETF", kind: "short", badge: "-1.5X 做空" }
  ],
  AAPL: [
    { code: "AAPU", name: "Direxion Daily AAPL Bull 2X Shares", kind: "long", badge: "2X 做多" },
    { code: "AAPD", name: "Direxion Daily AAPL Bear 1X Shares", kind: "short", badge: "-1X 做空" },
    { code: "AAPB", name: "GraniteShares 2x Long AAPL Daily ETF", kind: "long", badge: "2X 做多" },
    { code: "AAPX", name: "T-Rex 2X Long Apple Daily Target ETF", kind: "long", badge: "2X 做多" },
    { code: "PHS", name: "GraniteShares 1x Short AAPL Daily ETF", kind: "short", badge: "-1X 做空" },
    { code: "APII", name: "GraniteShares 2x Short AAPL Daily ETF", kind: "short", badge: "-2X 做空" },
    { code: "APLY", name: "YieldMax AAPL Option Income Strategy ETF", kind: "income", badge: "期权收益" },
    { code: "AAPY", name: "Kurv Yield Premium Strategy Apple ETF", kind: "income", badge: "期权收益" },
    { code: "AAPW", name: "Roundhill AAPL WeeklyPay ETF", kind: "income", badge: "每周收益" }
  ],
  TSLA: [
    { code: "TSLL", name: "Direxion Daily TSLA Bull 2X Shares", kind: "long", badge: "2X 做多" },
    { code: "TSLT", name: "T-Rex 2X Long TSLA Daily Target ETF", kind: "long", badge: "2X 做多" },
    { code: "TSLR", name: "GraniteShares 2x Long TSLA Daily ETF", kind: "long", badge: "2X 做多" },
    { code: "TSDD", name: "GraniteShares 2x Short TSLA Daily ETF", kind: "short", badge: "-2X 做空" },
    { code: "TSLQ", name: "Tradr 2X Short TSLA Daily ETF", kind: "short", badge: "-2X 做空" },
    { code: "TSLZ", name: "T-Rex 2X Inverse Tesla Daily Target ETF", kind: "short", badge: "-2X 做空" },
    { code: "TSLY", name: "YieldMax TSLA Option Income Strategy ETF", kind: "income", badge: "期权收益" },
    { code: "TSYY", name: "GraniteShares Yield Enhanced TSLA ETF", kind: "income", badge: "收益增强" }
  ],
  AMD: [
    { code: "AMDL", name: "GraniteShares 2x Long AMD Daily ETF", kind: "long", badge: "2X 做多" },
    { code: "AMUU", name: "Direxion Daily AMD Bull 2X Shares", kind: "long", badge: "2X 做多" },
    { code: "AMDD", name: "Direxion Daily AMD Bear 1X Shares", kind: "short", badge: "-1X 做空" },
    { code: "AMDS", name: "GraniteShares 2x Short AMD Daily ETF", kind: "short", badge: "-2X 做空" },
    { code: "AMDY", name: "YieldMax AMD Option Income Strategy ETF", kind: "income", badge: "期权收益" }
  ],
  AMZN: [
    { code: "AMZU", name: "Direxion Daily AMZN Bull 2X Shares", kind: "long", badge: "2X 做多" },
    { code: "AMZD", name: "Direxion Daily AMZN Bear 1X Shares", kind: "short", badge: "-1X 做空" },
    { code: "AMZY", name: "YieldMax AMZN Option Income Strategy ETF", kind: "income", badge: "期权收益" }
  ],
  MSFT: [
    { code: "MSFU", name: "Direxion Daily MSFT Bull 2X Shares", kind: "long", badge: "2X 做多" },
    { code: "MSFX", name: "T-Rex 2X Long MSFT Daily Target ETF", kind: "long", badge: "2X 做多" },
    { code: "MSFD", name: "Direxion Daily MSFT Bear 1X Shares", kind: "short", badge: "-1X 做空" },
    { code: "MSFY", name: "YieldMax MSFT Option Income Strategy ETF", kind: "income", badge: "期权收益" }
  ],
  GOOGL: [
    { code: "GGLL", name: "Direxion Daily GOOGL Bull 2X Shares", kind: "long", badge: "2X 做多" },
    { code: "GOOX", name: "T-Rex 2X Long Alphabet Daily Target ETF", kind: "long", badge: "2X 做多" },
    { code: "GGLS", name: "Direxion Daily GOOGL Bear 1X Shares", kind: "short", badge: "-1X 做空" },
    { code: "GOOY", name: "YieldMax GOOGL Option Income Strategy ETF", kind: "income", badge: "期权收益" }
  ],
  GOOG: [
    { code: "GGLL", name: "Direxion Daily GOOGL Bull 2X Shares", kind: "long", badge: "2X 做多" },
    { code: "GOOX", name: "T-Rex 2X Long Alphabet Daily Target ETF", kind: "long", badge: "2X 做多" },
    { code: "GGLS", name: "Direxion Daily GOOGL Bear 1X Shares", kind: "short", badge: "-1X 做空" },
    { code: "GOOY", name: "YieldMax GOOGL Option Income Strategy ETF", kind: "income", badge: "期权收益" }
  ],
  META: [
    { code: "FBL", name: "GraniteShares 2x Long META Daily ETF", kind: "long", badge: "2X 做多" },
    { code: "METU", name: "Direxion Daily META Bull 2X Shares", kind: "long", badge: "2X 做多" },
    { code: "FBS", name: "GraniteShares 2x Short META Daily ETF", kind: "short", badge: "-2X 做空" },
    { code: "FBY", name: "YieldMax META Option Income Strategy ETF", kind: "income", badge: "期权收益" }
  ],
  COIN: [
    { code: "CONL", name: "GraniteShares 2x Long COIN Daily ETF", kind: "long", badge: "2X 做多" },
    { code: "CONY", name: "YieldMax COIN Option Income Strategy ETF", kind: "income", badge: "期权收益" },
    { code: "COIW", name: "Roundhill COIN WeeklyPay ETF", kind: "income", badge: "每周收益" }
  ],
  RKLB: [
    { code: "RKLX", name: "Tradr 2X Long RKLB Daily ETF", kind: "long", badge: "2X 做多" },
    { code: "RKLZ", name: "Defiance Daily Target 2X Short RKLB ETF", kind: "short", badge: "-2X 做空" }
  ],
  SPCX: [
    { code: "SPCH", name: "2X Long SpaceX Daily ETF", kind: "long", badge: "2X 做多" }
  ],
  MSTR: [
    { code: "MSTU", name: "T-Rex 2X Long MSTR Daily Target ETF", kind: "long", badge: "2X 做多" },
    { code: "MSTZ", name: "T-Rex 2X Inverse MSTR Daily Target ETF", kind: "short", badge: "-2X 做空" },
    { code: "MSTY", name: "YieldMax MSTR Option Income Strategy ETF", kind: "income", badge: "期权收益" }
  ],
  SPY: [
    { code: "SSO", name: "ProShares Ultra S&P 500", kind: "long", badge: "2X 做多" },
    { code: "SPUU", name: "Direxion Daily S&P 500 Bull 2X Shares", kind: "long", badge: "2X 做多" }
  ],
  QQQ: [
    { code: "QLD", name: "ProShares Ultra QQQ", kind: "long", badge: "2X 做多" }
  ],
  SMCI: [
    { code: "SMCX", name: "Defiance Daily Target 2X Long SMCI ETF", kind: "long", badge: "2X 做多" },
    { code: "SMCZ", name: "Defiance Daily Target 2X Short SMCI ETF", kind: "short", badge: "-2X 做空" }
  ],
  HOOD: [
    { code: "ROBN", name: "T-Rex 2X Long Robinhood Daily Target ETF", kind: "long", badge: "2X 做多" }
  ],
  MU: [
    { code: "MUU", name: "Direxion Daily MU Bull 2X Shares", kind: "long", badge: "2X 做多" },
    { code: "MUD", name: "Direxion Daily MU Bear 1X Shares", kind: "short", badge: "-1X 做空" }
  ],
  NFLX: [
    { code: "NFLU", name: "T-Rex 2X Long NFLX Daily Target ETF", kind: "long", badge: "2X 做多" },
    { code: "NFLY", name: "YieldMax NFLX Option Income Strategy ETF", kind: "income", badge: "期权收益" }
  ],
  TSM: [
    { code: "TSMX", name: "Direxion Daily TSM Bull 2X Shares", kind: "long", badge: "2X 做多" }
  ],
  SNDK: [
    { code: "SNXX", name: "Tradr 2X Long SNDK Daily ETF", kind: "long", badge: "2X 做多" }
  ],
  UNH: [
    { code: "UNHG", name: "Leverage Shares 2X Long UNH Daily ETF", kind: "long", badge: "2X 做多" }
  ],
  ECHO: [
    { code: "ECHX", name: "Leverage Shares 2X Long ECHO Daily ETF", kind: "long", badge: "2X 做多" }
  ],
  INTC: [
    { code: "INTW", name: "GraniteShares 2x Long INTC Daily ETF", kind: "long", badge: "2X 做多" }
  ],
  NIO: [
    { code: "NIOG", name: "Leverage Shares 2X Long NIO Daily ETF", kind: "long", badge: "2X 做多" }
  ],
  WDC: [
    { code: "WDCX", name: "Tradr 2X Long WDC Daily ETF", kind: "long", badge: "2X 做多" },
    { code: "WDCC", name: "Corgi 2X Long WDC Daily ETF", kind: "long", badge: "2X 做多" }
  ],
  XPEV: [
    { code: "XPEG", name: "Leverage Shares 2X Long XPEV Daily ETF", kind: "long", badge: "2X 做多" }
  ]
};

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
  XPEV: "小鹏汽车"
};

function normalizedUsCode(code: string) {
  return code.trim().toUpperCase().replace(/\.(?:AM|N|OQ|PS|K)$/i, "");
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
  {} as Record<string, string>
);

const RELATED_ETF_BY_CODE: Record<string, RelatedETF> = Object.values(US_RELATED_ETFS).flat().reduce(
  (map, etf) => {
    if (!map[etf.code]) map[etf.code] = etf;
    return map;
  },
  {} as Record<string, RelatedETF>
);

// 兼容旧数据：EchoStar 2026-06-24 由 SATS 改为 ECHO，2X ETF 由 SATG 改为 ECHX；
// 仍存有 SATG 记录的旧自选/持仓，反向展示正股 ECHO。
RELATED_ETF_MAIN_STOCK["SATG"] = "ECHO";

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

export interface RelatedEtfBadgeMeta {
  label: "2x" | "反" | "收" | "多";
  title: string;
}

/** 全站相关 ETF 图标角标：统一从关系目录派生，避免各组件自行判断和展示。 */
export function relatedEtfBadge(market: string, code: string, name?: string): RelatedEtfBadgeMeta | null {
  if (market.toUpperCase() === "US") {
    const normalized = normalizedUsCode(code);
    const relation = RELATED_ETF_BY_CODE[normalized];
    if (relation) {
      if (relation.kind === "income") return { label: "收", title: "收益策略" };
      if (relation.kind === "short") return { label: "反", title: "反向 ETF" };
      return /2X/i.test(relation.badge) ? { label: "2x", title: relation.badge } : { label: "多", title: relation.badge };
    }
  }
  return isDoubleEtf(market, code, name) ? { label: "2x", title: "2X 做多" } : null;
}

/** 判断某只股票/ETF 是否为 2 倍杠杆产品（用于显示 2x 徽标）：
 * 优先命中相关 ETF 目录的 badge/名称，再按名称兜底（覆盖港/A 股或中文名如“两倍做多闪迪”）。 */
export function isDoubleEtf(market: string, code: string, name?: string): boolean {
  const m = (market || "").toUpperCase();
  const c = (code || "").trim().toUpperCase();
  if (m === "US") {
    const hit = Object.values(US_RELATED_ETFS).flat().find((e) => e.code.toUpperCase() === c);
    if (hit) return /(2x|2倍|两倍)/i.test(hit.badge) || /(2x|2倍|两倍)/i.test(hit.name);
  }
  return /(2x|2倍|两倍)/i.test(name || "");
}
