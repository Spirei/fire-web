/**
 * CurveSpec → SVG 适配器（纯字符串拼接，不依赖 DOM / React）。
 *
 * 它同时服务两处：
 * 1. 简化版账户页 —— public/simple-app-runtime.js 通过 window.FireCurve 桥接调用（浏览器内带 hover 属性）；
 * 2. 服务端出图 —— 同一函数可在 Node 里直接跑（不传 interactiveAttrs 就是一张静态图），
 *    分享图 / 年度报告 / 通知都能用同一份几何。
 *
 * 换渲染器时它是「第二个适配器」的参照实现：输入永远只有 spec + 少量展示参数，不碰算法。
 */
import type { CurveSeriesSpec, CurveSpec, LedgerCurveKind } from "./curve";

/** 绘图区（与手写 SVG 版几何完全一致：viewBox 360×170） */
const PLOT = { left: 18, right: 334, top: 26, bottom: 154, width: 360, height: 170 } as const;

export interface CurveGeometry {
  xAt: (index: number, count: number) => number;
  yAt: (value: number) => number;
}

export function curveGeometry(spec: CurveSpec): CurveGeometry {
  const { min, max } = spec.domain;
  const span = max - min || 1;
  return {
    xAt: (index: number, count: number) => (count <= 1 ? 180 : PLOT.left + (PLOT.right - PLOT.left) * index / (count - 1)),
    yAt: (value: number) => 154 - ((value - min) / span) * 128
  };
}

export interface CurveSvgOptions {
  kind: LedgerCurveKind;
  /** 金额单位（命中点标题 / 点击提示用） */
  unit?: string;
  /** 交互属性：浏览器内由 runtime 传入 hover 处理器；服务端出图留空 */
  interactiveAttrs?: string;
  /** 轴两端日期文案 */
  startLabel?: string;
  endLabel?: string;
  /** 无数据时的提示文案 */
  emptyText?: string;
  /**
   * 主题变量（服务端出图用）：页面里由 CSS 变量提供，独立成图时需要在 SVG 内自带。
   * 传入后会在 <defs> 里补一段 <style>，覆盖 --line / --muted / --faint / --card / --dash。
   */
  theme?: { ink?: string; muted?: string; faint?: string; line?: string; card?: string; dash?: string };
}

/** 与简化版 runtime 的 num() 完全一致 */
function num(value: number, digits = 2): string {
  return Number(value || 0).toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** 与简化版 runtime 的 pct() 完全一致 */
function pct(value: number): string {
  if (value == null || Number.isNaN(value)) return "暂无";
  const numeric = Number(value);
  return (numeric >= 0 ? "+" : "") + numeric.toFixed(2) + "%";
}

function pointsPath(values: number[], geometry: CurveGeometry, count: number): string {
  if (!values.length) return "";
  return values
    .map((value, index) => `${index ? "L" : "M"}${geometry.xAt(index, count).toFixed(1)} ${geometry.yAt(value).toFixed(1)}`)
    .join(" ");
}

export function curveSvg(spec: CurveSpec, options: CurveSvgOptions): string {
  const kind = options.kind;
  const unit = options.unit ?? "元";
  const lineColor = kind === "mwr" ? "#ef5b19" : "#3297f6";
  const main: CurveSeriesSpec | undefined = spec.series.find((item) => item.role === "main");
  const bench = spec.series.find((item) => item.role === "bench");
  const values = main?.values ?? [];
  const geometry = curveGeometry(spec);
  const path = pointsPath(values, geometry, values.length);
  const benchPath = pointsPath(bench?.values ?? [], geometry, bench?.values.length ?? 0);
  const expectedMarker = spec.markers.find((marker) => marker.kind === "expected");
  const expPath = expectedMarker
    ? `M20 ${geometry.yAt(0).toFixed(1)} L350 ${geometry.yAt(expectedMarker.value).toFixed(1)}`
    : "";
  const area = kind === "pnl" && path
    ? `${path} L${geometry.xAt(values.length - 1, values.length).toFixed(1)} 154 L${geometry.xAt(0, values.length).toFixed(1)} 154 Z`
    : "";
  const hitCircles = spec.hitIndices
    .map((index) => `<circle cx="${geometry.xAt(index, values.length)}" cy="${geometry.yAt(values[index])}" r="7" fill="transparent" tabindex="0" onclick="toast('${spec.dates[index] || ""}　${kind === "pnl" ? num(values[index]) + " " + unit : pct(values[index])}')"><title>${spec.dates[index] || ""} ${kind === "pnl" ? num(values[index]) + " " + unit : pct(values[index])}</title></circle>`)
    .join("");
  const themeStyle = options.theme
    ? `<style>${Object.entries(options.theme).filter(([, value]) => !!value).map(([key, value]) => `.chart{--${key}:${value}}`).join("")}</style>`
    : "";
  return `<svg class="chart" viewBox="0 0 360 170" preserveAspectRatio="xMidYMid meet"${options.interactiveAttrs ? ` ${options.interactiveAttrs}` : ""}>
        <defs>${themeStyle}<linearGradient id="trendFill${kind}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${lineColor}" stop-opacity=".34"/><stop offset="1" stop-color="${lineColor}" stop-opacity=".02"/></linearGradient></defs>
        <path d="M18 26H334 M18 68H334 M18 110H334 M18 154H334" fill="none" stroke="var(--line)" stroke-width="1" stroke-dasharray="3 4" vector-effect="non-scaling-stroke"/>
        ${expPath ? `<path d="${expPath}" fill="none" stroke="var(--dash)" stroke-width="1.4" stroke-dasharray="3 4"/>` : ""}
        ${benchPath ? `<path d="${benchPath}" fill="none" stroke="#4a90d9" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>` : ""}
        ${area ? `<path d="${area}" fill="url(#trendFill${kind})"/>` : ""}${path ? `<path d="${path}" fill="none" stroke="${lineColor}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" />` : `<text x="110" y="90" font-size="12" fill="var(--faint)">${options.emptyText || "当前区间暂无数据"}</text>`}
        <line data-hover-line="" x1="18" x2="18" y1="24" y2="154" stroke="var(--muted)" stroke-width="1" stroke-dasharray="3 3" style="display:none;pointer-events:none"/>
        <circle data-hover-main="" cx="0" cy="0" r="4" fill="var(--card)" stroke="${lineColor}" stroke-width="2" style="display:none;pointer-events:none"/>
        <circle data-hover-bench="" cx="0" cy="0" r="3.5" fill="var(--card)" stroke="#4a90d9" stroke-width="2" style="display:none;pointer-events:none"/>
        ${hitCircles}
        <text x="18" y="168" font-size="10" fill="var(--faint)">${options.startLabel ?? ""}</text><text x="286" y="168" font-size="10" fill="var(--faint)">${options.endLabel ?? ""}</text>
        <text x="346" y="29" text-anchor="end" font-size="9" fill="var(--faint)">${kind === "pnl" ? num(spec.domain.max) : spec.domain.max.toFixed(1) + "%"}</text><text x="346" y="154" text-anchor="end" font-size="9" fill="var(--faint)">${kind === "pnl" ? num(spec.domain.min) : spec.domain.min.toFixed(1) + "%"}</text>
      </svg>`;
}

/** 供简化版 runtime 桥接调用（与 lib/curve.ts 的 curveApi 合并后挂到 window.FireCurve） */
export const curveSvgApi = {
  curveGeometry,
  curveSvg
};
