"use client";

import { useMemo } from "react";

interface MiniTrendChartProps {
  points?: number[];
  baseline?: number | null;
  stale?: boolean;
  width?: number;
  height?: number;
  className?: string;
  label?: string;
}

/** 微牛式列表火花图：昨收虚线、无面积填充；旧缓存用灰色提示数据已失效。 */
export default function MiniTrendChart({ points = [], baseline, stale = false, width = 100, height = 28, className = "block h-[28px] w-[100px]", label = "趋势图" }: MiniTrendChartProps) {
  const svg = useMemo(() => {
    const prices = points.filter((value) => Number.isFinite(value) && value > 0);
    if (prices.length < 2) return null;
    const base = baseline != null && Number.isFinite(baseline) && baseline > 0 ? baseline : prices[0];
    const rawMin = Math.min(...prices, base);
    const rawMax = Math.max(...prices, base);
    const rawRange = rawMax - rawMin;
    const pad = rawRange > 0 ? rawRange * 0.08 : Math.max(Math.abs(rawMin) * 0.0005, 1);
    const min = rawMin - pad;
    const range = rawMax + pad - min;
    const xPad = 1;
    const yPad = 2;
    const coords = prices.map((price, index) => ({ x: xPad + (index / (prices.length - 1)) * (width - xPad * 2), y: height - yPad - ((price - min) / range) * (height - yPad * 2) }));
    const path = coords.map(({ x, y }, index) => `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
    const baselineY = height - yPad - ((base - min) / range) * (height - yPad * 2);
    const last = prices[prices.length - 1];
    return { path, baselineY, color: stale ? "#b7bcc5" : last >= base ? "#e5484d" : "#0aa77d" };
  }, [baseline, height, points, stale, width]);

  if (!svg) {
    const y = height / 2;
    return <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className={className} role="img" aria-label={`${label}暂不可用`}><line x1="1" x2={width - 1} y1={y} y2={y} stroke="#c5c9d0" strokeWidth="1" strokeDasharray="3 3" /></svg>;
  }

  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className={className} role="img" aria-label={label}>
      <line x1="1" x2={width - 1} y1={svg.baselineY.toFixed(1)} y2={svg.baselineY.toFixed(1)} stroke="#9ca3af" strokeWidth="0.8" strokeDasharray="3 3" opacity="0.72" />
      <path d={svg.path} fill="none" stroke={svg.color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
