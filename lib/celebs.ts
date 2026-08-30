/* ---------- 名人持仓 ----------
 *
 * 数据来源（lib/celebsData.ts 接入真实接口）：
 *  - SEC EDGAR 13F：机构投资人（伯克希尔等）每季度披露的持仓；
 *  - SEC EDGAR Form 4：董监高 / 政要（佩洛西、黄仁勋等）的持仓变动；
 *  - Dataroma：聚合 13F / 13G / Form 4 的第三方站点（参考数据源）。
 * 本文件为「示例数据」兜底，网络不可达或解析失败时前端自动回退到此处。
 */

export type CelebDataSource = "sec13f" | "secform4" | "sample";

export interface CelebTrade {
  code: string;
  name: string;
  changePct: number;
  action: string; // 买入 / 增仓 / 建仓 / 减仓 / 卖出
}

export interface CelebHolding {
  code: string;
  name: string;
  market: string;
  weight: number; // 持仓占比 %
  /** 较上一报告期（上一份 13F / Form 4）持仓占比变化（百分点，可为负） */
  weightDelta?: number;
  /** 本报告期新进（上一报告期未持有该标的） */
  isNew?: boolean;
  /** 公司当前总市值（复用个股详情页的 Quote.marketCap） */
  marketCap?: number;
  price: number;
  changePct: number;
  target: number; // 平均目标价
}

/** 对比基准指数（可扩展：后续可加纳指 IXIC / 上证 SH000001 / 恒生 HSI 等，追加一条即可） */
export interface BenchmarkReturn {
  code: string;
  name: string;
  y1: number;
  points: number[];
}

export const SPX_BENCH: BenchmarkReturn = {
  code: "SPX",
  name: "标普500指数",
  y1: 21.84,
  points: [0, 1, 3, 4, 6, 8, 10, 12, 14, 16, 19, 21.8]
};

export interface Celeb {
  id: string;
  name: string;
  title: string;
  gain250: number; // 250 日涨幅 %
  updated: string; // 数据更新时间
  avatar: string;
  dataSource: CelebDataSource; // 当前数据来源
  /** 报告期（如 2026Q2），由 SEC 13F reportDate 推导 */
  reportQuarter?: string;
  stockIcons?: Record<string, string>; // 名人专属股票图标（代码 → 图片），只在本名人生效
  trades: CelebTrade[];
  holdings: CelebHolding[];
  returns: {
    y1: number;
    y3: number;
    y5: number;
    spxY1: number;
    points: number[];
    spxPoints: number[];
    benchmarks?: BenchmarkReturn[];
  };
}

export const CELEBS: Celeb[] = [
  {
    id: "buffett",
    name: "巴菲特",
    title: "伯克希尔·哈撒韦 CEO",
    gain250: 28.14,
    updated: "05/01 更新",
    avatar: "/uploads/celebs/buffett-custom-1785959604596-1b74c273.png",
    dataSource: "sample",
    trades: [
      { code: "DVA", name: "DaVita", changePct: -1.9, action: "减仓" },
      { code: "INTC", name: "英特尔", changePct: 2.4, action: "买入" },
      { code: "UBER", name: "优步", changePct: 1.1, action: "增仓" }
    ],
    holdings: [
      { code: "AAPL", name: "苹果", market: "US", weight: 24.6, price: 308.72, changePct: 1.75, target: 344.85 },
      { code: "AXP", name: "美国运通", market: "US", weight: 12.8, price: 286.4, changePct: 0.62, target: 302.1 },
      { code: "KO", name: "可口可乐", market: "US", weight: 10.5, price: 71.22, changePct: -0.34, target: 74.5 },
      { code: "BAC", name: "美国银行", market: "US", weight: 9.8, price: 46.88, changePct: 0.94, target: 49.2 },
      { code: "GOOGL", name: "谷歌", market: "US", weight: 8.2, price: 208.31, changePct: 1.28, target: 226.0 },
      { code: "CVX", name: "雪佛龙", market: "US", weight: 7.4, price: 161.2, changePct: -0.55, target: 168.4 },
      { code: "OXY", name: "西方石油", market: "US", weight: 6.1, price: 52.36, changePct: 1.02, target: 58.9 },
      { code: "CB", name: "安达保险", market: "US", weight: 5.6, price: 268.9, changePct: 0.31, target: 275.0 }
    ],
    returns: { y1: 26.54, y3: 54.24, y5: 76.0, spxY1: 21.84, points: [0, 2, 4, 7, 5, 9, 12, 15, 13, 18, 22, 26.5], spxPoints: [0, 1, 3, 4, 6, 8, 10, 12, 14, 16, 19, 21.8], benchmarks: [SPX_BENCH] }
  },
  {
    id: "pelosi",
    name: "佩洛西",
    title: "美国前众议院议长",
    gain250: 41.7,
    updated: "08/04 更新",
    avatar: "/uploads/celebs/pelosi-custom-1786043465104-fed471cd.png",
    dataSource: "sample",
    trades: [
      { code: "NVDA", name: "英伟达", changePct: 1.44, action: "增仓" },
      { code: "MSFT", name: "微软", changePct: -0.8, action: "卖出" },
      { code: "GOOGL", name: "谷歌", changePct: 0.9, action: "买入" }
    ],
    holdings: [
      { code: "NVDA", name: "英伟达", market: "US", weight: 32.4, price: 210.26, changePct: 1.44, target: 245.0 },
      { code: "AAPL", name: "苹果", market: "US", weight: 18.6, price: 308.72, changePct: 1.75, target: 344.85 },
      { code: "MSFT", name: "微软", market: "US", weight: 15.2, price: 512.4, changePct: -0.8, target: 535.0 },
      { code: "GOOGL", name: "谷歌", market: "US", weight: 12.1, price: 208.31, changePct: 0.9, target: 226.0 },
      { code: "AMZN", name: "亚马逊", market: "US", weight: 9.8, price: 235.7, changePct: 0.64, target: 255.0 },
      { code: "DIS", name: "迪士尼", market: "US", weight: 6.4, price: 121.3, changePct: -1.2, target: 128.0 }
    ],
    returns: { y1: 41.7, y3: 88.2, y5: 132.0, spxY1: 21.84, points: [0, 5, 8, 12, 15, 19, 24, 28, 32, 36, 39, 41.7], spxPoints: [0, 1, 3, 4, 6, 8, 10, 12, 14, 16, 19, 21.8], benchmarks: [SPX_BENCH] }
  },
  {
    id: "huang",
    name: "黄仁勋",
    title: "英伟达 CEO",
    gain250: 55.3,
    updated: "08/04 更新",
    avatar: "/uploads/celebs/huang-custom-1785959912531-8b437268.png",
    dataSource: "sample",
    trades: [
      { code: "NVDA", name: "英伟达", changePct: 1.44, action: "增持" },
      { code: "AVGO", name: "博通", changePct: 0.88, action: "买入" },
      { code: "MU", name: "美光", changePct: -2.1, action: "减仓" }
    ],
    holdings: [
      { code: "NVDA", name: "英伟达", market: "US", weight: 46.8, price: 210.26, changePct: 1.44, target: 245.0 },
      { code: "AVGO", name: "博通", market: "US", weight: 18.2, price: 268.4, changePct: 0.88, target: 290.0 },
      { code: "MU", name: "美光科技", market: "US", weight: 14.6, price: 138.9, changePct: -2.1, target: 155.0 },
      { code: "AMD", name: "超威半导体", market: "US", weight: 12.3, price: 186.5, changePct: 1.12, target: 210.0 },
      { code: "TSM", name: "台积电", market: "US", weight: 8.1, price: 241.7, changePct: 0.45, target: 260.0 }
    ],
    returns: { y1: 55.3, y3: 102.0, y5: 188.0, spxY1: 21.84, points: [0, 6, 10, 16, 20, 26, 32, 38, 44, 49, 53, 55.3], spxPoints: [0, 1, 3, 4, 6, 8, 10, 12, 14, 16, 19, 21.8], benchmarks: [SPX_BENCH] }
  },
  {
    id: "cathie",
    name: "木头姐",
    title: "方舟投资 CEO",
    gain250: -1.48,
    updated: "07/31 更新",
    avatar: "/uploads/celebs/cathie-custom-1786043468667-6e835ac3.png",
    dataSource: "sample",
    trades: [
      { code: "TSLA", name: "特斯拉", changePct: 2.3, action: "买入" },
      { code: "COIN", name: "Coinbase", changePct: -3.6, action: "减仓" },
      { code: "ROKU", name: "Roku", changePct: 1.8, action: "增仓" }
    ],
    holdings: [
      { code: "TSLA", name: "特斯拉", market: "US", weight: 28.4, price: 342.6, changePct: 2.3, target: 380.0 },
      { code: "COIN", name: "Coinbase", market: "US", weight: 18.6, price: 388.2, changePct: -3.6, target: 420.0 },
      { code: "ROKU", name: "Roku", market: "US", weight: 15.2, price: 96.4, changePct: 1.8, target: 110.0 },
      { code: "CRWD", name: "CrowdStrike", market: "US", weight: 13.8, price: 428.9, changePct: 0.95, target: 455.0 },
      { code: "ZM", name: "Zoom", market: "US", weight: 11.2, price: 78.6, changePct: -1.4, target: 88.0 },
      { code: "PLTR", name: "Palantir", market: "US", weight: 8.4, price: 301.2, changePct: 1.05, target: 330.0 }
    ],
    returns: { y1: -1.48, y3: -22.6, y5: 41.2, spxY1: 21.84, points: [0, -2, -1, -4, -3, -5, -2, -4, -3, -1, -2, -1.5], spxPoints: [0, 1, 3, 4, 6, 8, 10, 12, 14, 16, 19, 21.8], benchmarks: [SPX_BENCH] }
  },
  {
    id: "trump",
    name: "特朗普",
    title: "美国前总统",
    gain250: 63.8,
    updated: "08/01 更新",
    avatar: "/uploads/celebs/trump-custom-1786043526485-1e34c87e.png",
    dataSource: "sample",
    trades: [
      { code: "DJT", name: "特朗普媒体", changePct: 4.2, action: "增仓" },
      { code: "NVDA", name: "英伟达", changePct: 1.44, action: "买入" },
      { code: "AAPL", name: "苹果", changePct: 1.75, action: "建仓" }
    ],
    holdings: [
      { code: "DJT", name: "特朗普媒体", market: "US", weight: 36.8, price: 42.6, changePct: 4.2, target: 50.0 },
      { code: "NVDA", name: "英伟达", market: "US", weight: 22.4, price: 210.26, changePct: 1.44, target: 245.0 },
      { code: "AAPL", name: "苹果", market: "US", weight: 16.2, price: 308.72, changePct: 1.75, target: 344.85 },
      { code: "TLT", name: "20年美债ETF", market: "US", weight: 12.6, price: 88.4, changePct: -0.6, target: 92.0 },
      { code: "BTC", name: "比特币ETF", market: "US", weight: 8.2, price: 92.5, changePct: 2.1, target: 100.0 }
    ],
    returns: { y1: 63.8, y3: 118.0, y5: 210.0, spxY1: 21.84, points: [0, 8, 12, 18, 24, 30, 38, 44, 52, 58, 61, 63.8], spxPoints: [0, 1, 3, 4, 6, 8, 10, 12, 14, 16, 19, 21.8], benchmarks: [SPX_BENCH] }
  },
  {
    id: "duan",
    name: "段永平",
    title: "步步高创始人 · 投资人",
    gain250: 30.69,
    updated: "03/31 更新",
    avatar: "/uploads/celebs/duan-custom-1785959747574-b3c57b2d.png",
    dataSource: "sample",
    trades: [
      { code: "PDD", name: "拼多多", changePct: 0.58, action: "增仓" },
      { code: "AAPL", name: "苹果", changePct: 1.75, action: "买入" },
      { code: "GOOGL", name: "谷歌", changePct: 0.9, action: "建仓" }
    ],
    holdings: [
      { code: "PDD", name: "拼多多", market: "US", weight: 28.6, price: 118.4, changePct: 0.58, target: 135.0 },
      { code: "AAPL", name: "苹果", market: "US", weight: 24.8, price: 308.72, changePct: 1.75, target: 344.85 },
      { code: "GOOGL", name: "谷歌", market: "US", weight: 18.2, price: 208.31, changePct: 0.9, target: 226.0 },
      { code: "MSFT", name: "微软", market: "US", weight: 14.6, price: 512.4, changePct: -0.8, target: 535.0 },
      { code: "BRK.B", name: "伯克希尔", market: "US", weight: 8.4, price: 511.15, changePct: -0.08, target: 540.0 }
    ],
    returns: { y1: 30.69, y3: 62.4, y5: 118.0, spxY1: 21.84, points: [0, 3, 6, 9, 12, 16, 19, 22, 25, 27, 29, 30.7], spxPoints: [0, 1, 3, 4, 6, 8, 10, 12, 14, 16, 19, 21.8], benchmarks: [SPX_BENCH] }
  }
];
