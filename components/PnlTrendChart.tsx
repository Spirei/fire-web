"use client";

import { useEffect, useRef } from "react";
import echarts from "@/lib/echarts";
import { buildCurveSpec, normalizeToPercent } from "@/lib/curve";

export interface PnlTrendPoint {
  date: string;
  asset: number;
  benchmark: number;
  timeIndex: number;
  /** 累计盈亏 / 实际投入资本形成的简单加权指数；旧调用方缺省时回退 asset。 */
  simpleIndex?: number;
  /** 从该趋势首个可确认点开始累计的经济盈亏。 */
  pnl?: number;
}

export type PnlChartTab = "return" | "asset";

/** 资产分析「收益率趋势图 / 总资产趋势图」共用图表（我的持仓 vs 标普500 / 总资产） */
export default function PnlTrendChart({
  points,
  tab,
  weighting,
  benchLabel
}: {
  points: PnlTrendPoint[];
  tab: PnlChartTab;
  weighting: "simple" | "time";
  benchLabel: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current || points.length === 0) return;
    const dark = document.documentElement.classList.contains("dark");
    const chart = echarts.init(ref.current, null, { renderer: "canvas" });
    const dates = points.map((p) => p.date);
    const portfolioValues = weighting === "time"
      ? points.map((point) => point.timeIndex)
      : points.map((point) => point.simpleIndex ?? point.asset);
    const hasBench = points.some((p) => p.benchmark > 0);
    // 曲线数据走与简化版账户页同一份 spec（归一化口径同源；这里用到 dates / series，
    // 轴范围与命中点抽稀由各自渲染器决定 —— ECharts 自带刻度，不需要 domain / hitIndices）
    const spec = buildCurveSpec({
      dates: dates,
      series: [
        {
          key: "main",
          label: tab === "return" ? "我的持仓" : "总资产",
          role: tab === "return" ? "main" : "asset",
          format: tab === "return" ? "percent" : "amount",
          values: tab === "return" ? normalizeToPercent(portfolioValues) : points.map((point) => point.asset)
        },
        ...(tab === "return" && hasBench
          ? [{
              key: "bench",
              label: benchLabel,
              role: "bench" as const,
              format: "percent" as const,
              values: normalizeToPercent(points.map((point) => point.benchmark))
            }]
          : [])
      ]
    });
    const mainValues = spec.series[0].values;
    const benchValues = spec.series[1]?.values ?? [];
    const ink = dark ? "#d8dee9" : "#26303b";
    const muted = dark ? "#727d8d" : "#87909d";
    const grid = dark ? "rgba(255,255,255,.07)" : "rgba(34,46,60,.08)";
    chart.setOption({
      animationDuration: 360,
      grid: { left: 10, right: 12, top: 24, bottom: 24, containLabel: true },
      tooltip: {
        trigger: "axis",
        confine: true,
        backgroundColor: dark ? "#202630" : "#fff",
        borderColor: dark ? "#3a4350" : "#dce1e8",
        textStyle: { color: ink },
        valueFormatter: (value: number) => (tab === "return" ? `${Number(value).toFixed(2)}%` : Number(value).toLocaleString("zh-CN", { maximumFractionDigits: 2 }))
      },
      xAxis: {
        type: "category",
        boundaryGap: false,
        data: dates,
        axisTick: { show: false },
        axisLine: { lineStyle: { color: grid } },
        axisLabel: { color: muted, hideOverlap: true, formatter: (value: string) => value.slice(5).replace("-", "/") }
      },
      yAxis: {
        type: "value",
        position: "right",
        scale: true,
        splitNumber: 4,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          color: muted,
          formatter: (value: number) => (tab === "return" ? `${value.toFixed(1)}%` : value.toLocaleString("zh-CN", { notation: "compact", maximumFractionDigits: 1 }))
        },
        splitLine: { lineStyle: { color: grid, type: "dashed" } }
      },
      series:
        tab === "return"
          ? [
              {
                name: "我的持仓",
                type: "line",
                showSymbol: false,
                smooth: false,
                data: mainValues,
                lineStyle: { color: "#ef5b19", width: 2 },
                areaStyle: {
                  color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                    { offset: 0, color: "rgba(239,91,25,.28)" },
                    { offset: 1, color: "rgba(239,91,25,.015)" }
                  ])
                }
              },
              ...(hasBench
                ? [
                    {
                      name: benchLabel,
                      type: "line",
                      showSymbol: false,
                      data: benchValues,
                      lineStyle: { color: "#4a90d9", width: 1.6 },
                      emphasis: { focus: "series" }
                    }
                  ]
                : [])
            ]
          : [
              {
                name: "总资产",
                type: "line",
                showSymbol: false,
                data: mainValues,
                lineStyle: { color: "#3297f6", width: 2 },
                areaStyle: {
                  color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                    { offset: 0, color: "rgba(50,151,246,.42)" },
                    { offset: 1, color: "rgba(50,151,246,.02)" }
                  ])
                }
              }
            ]
    });
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      chart.dispose();
    };
  }, [points, tab, weighting]);
  return <div ref={ref} className="h-[330px] w-full min-w-0 max-w-full overflow-hidden" />;
}
