/**
 * 持仓盈亏桑基图的数据与样式（纯函数，不依赖 React，便于在本地/回归测试里直接渲染验证）。
 *
 * 抽出来的原因：图表好不好看只能靠渲染出来看，把 option 放进组件里就没法在 Node 里复现，
 * 只能凭感觉改。现在 ECharts SSR 直接调用这里，本地渲染的就是线上那一版。
 */
import { sankeyLayoutFor } from "./sankeyLayout";

export interface PnlSankeyItem { name: string; code: string; market: string; pnl: number }

export const CURRENCY_SYMBOLS: Record<string, string> = { USD: "$", HKD: "HK$", CNY: "¥", SGD: "S$", JPY: "¥", KRW: "₩", EUR: "€" };

/**
 * 红涨绿跌：盈利红、亏损绿（与站点其他地方一致）。
 * 深浅色各一套：深色底上要用更沉的红绿与更暗的脊柱，否则柱子发白、中间那根会亮得像荧光棒。
 */
export function sankeyPalette(dark: boolean) {
  return dark
    ? {
        profitTop: "#e9595f", profitBottom: "#bf2a33",
        lossTop: "#12a37e", lossBottom: "#046b53",
        spineTop: "#4a5260", spineBottom: "#2b323c",
        linkFrom: "rgba(233,89,95,.85)", linkMid: "rgba(110,120,136,.5)", linkTo: "rgba(18,163,126,.85)"
      }
    : {
        profitTop: "#f4686c", profitBottom: "#d8363e",
        lossTop: "#15b98d", lossBottom: "#048a67",
        spineTop: "#6f7885", spineBottom: "#3a424e",
        linkFrom: "rgba(244,104,108,.92)", linkMid: "rgba(120,129,144,.85)", linkTo: "rgba(10,158,120,.92)"
      };
}

export function formatCurrency(value: number, currency: string) {
  const digits = currency === "JPY" || currency === "KRW" ? 0 : 2;
  return `${CURRENCY_SYMBOLS[currency] || `${currency} `}${Math.abs(value).toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** 块上金额缩写：≥1 亿显示亿、≥1 万显示万，其余保留两位，如 +$1.23万 / −¥5,678.90 */
export function compactMoney(value: number, currency: string) {
  const sign = value >= 0 ? "+" : "−";
  const abs = Math.abs(value);
  const symbol = CURRENCY_SYMBOLS[currency] || `${currency} `;
  if (abs >= 1e12) return `${sign}${symbol}${(abs / 1e12).toFixed(2)}万亿`;
  if (abs >= 1e8) return `${sign}${symbol}${(abs / 1e8).toFixed(2)}亿`;
  if (abs >= 1e4) return `${sign}${symbol}${(abs / 1e4).toFixed(2)}万`;
  return `${sign}${symbol}${abs.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function marketLabel(market: string) {
  return market === "US" ? "美股" : market === "HK" ? "港股" : market === "CN" ? "A股" : market;
}

/** 2 倍杠杆 ETF（名称含 2倍/2x 且带 ETF/做多/做空）只显示代码，正股显示名称 */
export function displayName(item: PnlSankeyItem): string {
  const leveraged = /(\d+(?:\.\d+)?)\s*[xX倍]/.test(item.name) && /ETF|做多|做空/i.test(item.name);
  return leveraged ? item.code : (item.name || item.code);
}

export interface SankeyOptionInput {
  dark: boolean;
  width: number;
  currency: string;
  profit: PnlSankeyItem[];
  loss: PnlSankeyItem[];
  /** 净盈亏（换算后） */
  netTotal: number;
  /** 把原币金额换算成显示币种（分享图与 tooltip 用） */
  convert?: (value: number) => number;
}

function verticalGradient(from: string, to: string) {
  return { type: "linear" as const, x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: from }, { offset: 1, color: to }] };
}

/**
 * 连线渐变：沿着「源节点 → 目标节点」横向渐变。
 * 不用 ECharts 的 `color: 'gradient'` 关键字 —— 那是 canvas 专用写法，SVG 渲染器会把它原样
 * 写成 fill="gradient"（无效值），还会附带一层裁剪把两侧标签切掉；显式渐变对象两种渲染器都认。
 */
function linkGradient(from: string, to: string) {
  return { type: "linear" as const, x: 0, y: 0, x2: 1, y2: 0, colorStops: [{ offset: 0, color: from }, { offset: 1, color: to }] };
}

/**
 * 生成桑基图 option：两端「盈利 / 亏损」节点用渐变色柱，中间一根中性色脊柱，
 * 连线用 source→target 的渐变替代单色半透明色块（大持仓那条宽带才不会糊成一坨颜色）。
 */
export function buildSankeyOption(input: SankeyOptionInput) {
  const { dark, width, currency, profit, loss, netTotal } = input;
  const convert = input.convert || ((value: number) => value);
  const layout = sankeyLayoutFor(width);
  const palette = sankeyPalette(dark);
  const ink = dark ? "#e6ebf2" : "#313944";
  const muted = dark ? "#8f99a7" : "#7e8794";
  const center = "持仓盈亏";
  const centerAmountColor = netTotal >= 0 ? "#e5484d" : "#0aa77d";
  const nodeName = (item: PnlSankeyItem, side: "P" | "L") => `${side}:${item.market}:${item.code}`;
  // 宽屏两行（名称 / 金额），手机单行（名称 + 金额）：单行标签只有一半高，
  // ECharts 的 hideOverlap 就不会再成片隐藏小持仓的标签。
  const label = (item: PnlSankeyItem) => layout.wide
    ? `{name|${displayName(item)}}\n{amount|${compactMoney(item.pnl, currency)}}`
    : `{name|${displayName(item)}} {amount|${compactMoney(item.pnl, currency)}}`;
  const nodes = [
    ...profit.map((item) => ({
      name: nodeName(item, "P"), depth: 0,
      itemStyle: { color: verticalGradient(palette.profitTop, palette.profitBottom) },
      label: { formatter: label(item), position: "left", rich: { name: { color: ink }, amount: { color: "rgba(229,72,77,.85)" } } }
    })),
    {
      name: center, depth: 1,
      itemStyle: { color: verticalGradient(palette.spineTop, palette.spineBottom) },
      label: layout.wide
        ? { color: centerAmountColor, fontWeight: 800, formatter: `{name|${center}}\n{amount|${compactMoney(netTotal, currency)}}`, rich: { name: { color: centerAmountColor, fontSize: 12, fontWeight: 800, lineHeight: 16 }, amount: { color: centerAmountColor, fontSize: 10, fontWeight: 700, lineHeight: 13 } } }
        : { show: false }
    },
    ...loss.map((item) => ({
      name: nodeName(item, "L"), depth: 2,
      itemStyle: { color: verticalGradient(palette.lossTop, palette.lossBottom) },
      label: { formatter: label(item), position: "right", rich: { name: { color: ink }, amount: { color: "rgba(10,167,125,.88)" } } }
    }))
  ];
  const links = [
    ...profit.map((item) => ({ source: nodeName(item, "P"), target: center, value: Math.max(.01, Math.abs(item.pnl)), stock: item, lineStyle: { color: linkGradient(palette.linkFrom, palette.linkMid) } })),
    ...loss.map((item) => ({ source: center, target: nodeName(item, "L"), value: Math.max(.01, Math.abs(item.pnl)), stock: item, lineStyle: { color: linkGradient(palette.linkMid, palette.linkTo) } }))
  ];
  return {
    animationDuration: 450,
    tooltip: {
      trigger: "item", confine: true,
      backgroundColor: dark ? "#202630" : "#fff",
      borderColor: dark ? "rgba(255,255,255,.14)" : "#d9dee5",
      textStyle: { color: ink, fontSize: 12 },
      formatter: (params: { data?: { stock?: PnlSankeyItem }; name?: string }) => {
        const item = params.data?.stock;
        if (!item) return `<b>${params.name || center}</b>`;
        const positive = item.pnl > 0;
        return `<b>${item.name} ${item.code}</b><br/><span style="color:${muted}">${marketLabel(item.market)}</span><br/><b style="color:${positive ? "#e5484d" : "#0aa77d"}">${positive ? "+" : "−"}${formatCurrency(convert(item.pnl), currency)}</b>`;
      }
    },
    series: [{
      type: "sankey",
      left: layout.sideMargin,
      right: layout.sideMargin,
      top: layout.wide ? 30 : 18,
      bottom: layout.wide ? 30 : 18,
      nodeWidth: layout.nodeWidth,
      nodeGap: layout.nodeGap,
      nodeAlign: "justify",
      draggable: false,
      layoutIterations: layout.wide ? 48 : 32,
      data: nodes,
      links,
      // 连线淡一点、曲线缓一点，让粗柱子与文字站得住；柱子给足圆角，手机上也不显得生硬。
      lineStyle: { curveness: .45, opacity: layout.wide ? .4 : .34 },
      itemStyle: { borderWidth: 0, borderRadius: layout.wide ? 5 : 6 },
      label: {
        color: ink,
        fontSize: layout.fontSize,
        fontWeight: 650,
        distance: layout.labelGap,
        lineHeight: layout.lineHeight,
        verticalAlign: "middle",
        overflow: "truncate",
        width: layout.labelWidth,
        rich: {
          name: { fontSize: layout.fontSize, fontWeight: 650, color: ink, lineHeight: layout.lineHeight },
          amount: { fontSize: layout.amountFontSize, fontWeight: 700, color: muted, lineHeight: layout.lineHeight }
        }
      },
      emphasis: { focus: "adjacency", lineStyle: { opacity: .9 } },
      labelLayout: { hideOverlap: true }
    }]
  };
}
