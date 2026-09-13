"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import echarts from "@/lib/echarts";

type Point = { period: string; fiscalYear?: number; fiscalPeriod?: string; value: number };
type Metric = "revenue" | "grossProfit" | "operatingIncome" | "netIncome" | "eps" | "assets" | "liabilities" | "cash" | "operatingCashFlow" | "capex" | "freeCashFlow" | "dividendsPerShare" | "productRevenue" | "serviceRevenue" | "costOfRevenue" | "rdExpense" | "sgaExpense" | "incomeTax";
type Payload = { supported?: boolean; company?: string; currency?: string; source?: string; error?: string; metrics?: Record<Metric, Point[]> };
const SECTIONS = ["财报", "财务评分", "关键指标", "利润表", "资产负债表", "现金流表", "股东回报"] as const;
type Section = typeof SECTIONS[number];
type ReportView = "摘要" | "收入明细";
const FINANCIAL_CACHE_PREFIX = "fire:financials:v1";

function financialCacheKey(market: string, code: string) {
  return `${FINANCIAL_CACHE_PREFIX}:${market.trim().toUpperCase()}:${code.trim().toUpperCase()}`;
}

function readFinancialCache(market: string, code: string): Payload | null {
  try {
    const value = JSON.parse(localStorage.getItem(financialCacheKey(market, code)) || "null") as { payload?: Payload } | null;
    return value?.payload?.metrics ? value.payload : null;
  } catch { return null; }
}

function writeFinancialCache(market: string, code: string, payload: Payload) {
  if (!payload.metrics) return;
  try { localStorage.setItem(financialCacheKey(market, code), JSON.stringify({ payload, savedAt: Date.now() })); } catch {}
}

function compact(value?: number, perShare = false) {
  if (value == null || !Number.isFinite(value)) return "—";
  if (perShare) return value.toFixed(2);
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${(value / 1e12).toFixed(2)}万亿`;
  if (abs >= 1e8) return `${(value / 1e8).toFixed(2)}亿`;
  if (abs >= 1e4) return `${(value / 1e4).toFixed(2)}万`;
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
const last = (rows?: Point[]) => rows?.[rows.length - 1];
const previous = (rows?: Point[]) => rows?.[rows.length - 2];
function growth(rows?: Point[]) { const a = last(rows)?.value; const b = previous(rows)?.value; return a != null && b ? (a - b) / Math.abs(b) * 100 : null; }

function useDarkMode() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setDark(root.classList.contains("dark"));
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return dark;
}

function scoreMetric(rows?: Point[]) {
  const current = last(rows)?.value;
  const rate = growth(rows);
  if (current == null) return null;
  const positivity = current > 0 ? 12 : current < 0 ? -18 : 0;
  return Math.max(0, Math.min(100, Math.round(62 + positivity + Math.max(-30, Math.min(26, rate || 0)))));
}

function scoreTone(score: number | null) {
  if (score == null) return { label: "数据不足", className: "is-neutral" };
  if (score >= 80) return { label: "优秀", className: "is-strong" };
  if (score >= 65) return { label: "稳健", className: "is-good" };
  if (score >= 45) return { label: "一般", className: "is-neutral" };
  return { label: "承压", className: "is-weak" };
}

function TrendChart({ metrics }: { metrics: Record<Metric, Point[]> }) {
  const ref = useRef<HTMLDivElement>(null);
  const dark = useDarkMode();
  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current);
    const revenue = metrics.revenue || [];
    const income = metrics.netIncome || [];
    chart.setOption({ tooltip: { trigger: "axis", backgroundColor: dark ? "#23262d" : "#fff", borderColor: dark ? "rgba(255,255,255,.12)" : "#e1e5eb", textStyle: { color: dark ? "#eef2f7" : "#202733", fontSize: 11 }, extraCssText: "border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.14)", valueFormatter: (value: unknown) => compact(Number(value)) }, legend: { data: ["营业收入", "净利润"], top: 10, left: "center", itemGap: 22, itemWidth: 22, itemHeight: 10, textStyle: { color: dark ? "#aab3c0" : "#67707d", fontSize: 11 }, selectedMode: true }, grid: { left: 16, right: 18, top: 52, bottom: 18, containLabel: true }, xAxis: { type: "category", data: revenue.map((p) => `${p.fiscalYear || ""} ${p.fiscalPeriod || ""}`), axisLine: { lineStyle: { color: dark ? "rgba(255,255,255,.09)" : "#e4e8ee" } }, axisLabel: { color: dark ? "#8e99a8" : "#7c8592", margin: 12, hideOverlap: true }, axisTick: { show: false } }, yAxis: { type: "value", axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: dark ? "#8e99a8" : "#7c8592", formatter: (v: number) => compact(v) }, splitLine: { lineStyle: { color: dark ? "rgba(255,255,255,.08)" : "rgba(20,30,45,.07)", type: "dotted" } } }, series: [{ name: "营业收入", type: "bar", data: revenue.map((p) => p.value), itemStyle: { color: "#5577f6", borderRadius: [5, 5, 0, 0] }, emphasis: { itemStyle: { color: "#6c89fa" } }, barMaxWidth: 26 }, { name: "净利润", type: "line", data: income.map((p) => p.value), smooth: 0.28, showSymbol: false, symbolSize: 7, emphasis: { focus: "series", scale: true }, lineStyle: { color: "#20b486", width: 2.2 }, itemStyle: { color: "#20b486" }, areaStyle: { color: { type: "linear", x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: "rgba(32,180,134,.18)" }, { offset: 1, color: "rgba(32,180,134,0)" }] } } }] });
    const ro = new ResizeObserver(() => chart.resize()); ro.observe(ref.current);
    return () => { ro.disconnect(); chart.dispose(); };
  }, [metrics, dark]);
  return <div ref={ref} className="h-[280px] w-full" />;
}

const periodLabel = (point?: Point) => point ? `${point.fiscalYear || ""} ${point.fiscalPeriod || ""}`.trim() : "—";

function BreakdownChart({ metrics, percent }: { metrics: Record<Metric, Point[]>; percent: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const dark = useDarkMode();
  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current);
    const product = metrics.productRevenue || [];
    const service = metrics.serviceRevenue || [];
    const hasSegments = product.length > 0 || service.length > 0;
    const base = metrics.revenue || (product.length ? product : metrics.grossProfit || []);
    const values = (rows: Point[], index: number) => rows[index]?.value || 0;
    const dataFor = (rows: Point[]) => base.map((_p, index) => {
      const value = values(rows, index);
      const total = values(base, index) || values(product, index) + values(service, index);
      return percent ? (total ? value / total * 100 : 0) : value;
    });
    const series = hasSegments ? [
      { name: "产品收入", type: "bar", stack: "income", data: dataFor(product), itemStyle: { color: "#5570ff" }, barMaxWidth: 34 },
      { name: "服务收入", type: "bar", stack: "income", data: dataFor(service), itemStyle: { color: "#20aceb" }, barMaxWidth: 34 }
    ] : [
      { name: "营业成本", type: "bar", stack: "income", data: dataFor(metrics.costOfRevenue || []), itemStyle: { color: "#5570ff" }, barMaxWidth: 34 },
      { name: "毛利润", type: "bar", stack: "income", data: dataFor(metrics.grossProfit || []), itemStyle: { color: "#2fc35d" }, barMaxWidth: 34 }
    ];
    chart.setOption({ tooltip: { trigger: "axis", valueFormatter: (value: unknown) => percent ? `${Number(value).toFixed(2)}%` : compact(Number(value)) }, legend: { top: 8, left: 12, textStyle: { color: dark ? "#aab3c0" : "#68717e", fontSize: 11 } }, grid: { left: 18, right: 24, top: 50, bottom: 22, containLabel: true }, xAxis: { type: "category", data: base.map(periodLabel), axisTick: { show: false }, axisLabel: { color: dark ? "#8e99a8" : "#7c8592", hideOverlap: true } }, yAxis: { type: "value", max: percent ? 100 : undefined, axisLabel: { color: dark ? "#8e99a8" : "#7c8592", formatter: (value: number) => percent ? `${value}%` : compact(value) }, splitLine: { lineStyle: { color: dark ? "rgba(255,255,255,.08)" : "rgba(20,30,45,.07)", type: "dotted" } } }, series });
    const observer = new ResizeObserver(() => chart.resize()); observer.observe(ref.current);
    return () => { observer.disconnect(); chart.dispose(); };
  }, [metrics, percent, dark]);
  return <div ref={ref} className="h-[290px] w-full" />;
}

function RevenueBreakdown({ metrics, currency }: { metrics: Record<Metric, Point[]>; currency?: string }) {
  const [percent, setPercent] = useState(false);
  const [indicator, setIndicator] = useState<Metric>("revenue");
  const product = metrics.productRevenue || [];
  const service = metrics.serviceRevenue || [];
  const segmented = product.length > 0 || service.length > 0;
  const latestTotal = last(metrics.revenue)?.value || (last(product)?.value || 0) + (last(service)?.value || 0);
  const breakdownRows = segmented ? [["产品收入", product, "#5570ff"], ["服务收入", service, "#20aceb"]] as const : [["营业成本", metrics.costOfRevenue || [], "#5570ff"], ["毛利润", metrics.grossProfit || [], "#2fc35d"]] as const;
  const indicators: Array<[string, Metric]> = [["总收入", "revenue"], ["产品收入", "productRevenue"], ["服务收入", "serviceRevenue"], ["毛利润", "grossProfit"], ["营业利润", "operatingIncome"], ["研发费用", "rdExpense"], ["销售管理费用", "sgaExpense"], ["所得税", "incomeTax"]];
  const selected = metrics[indicator] || [];
  return <>
    {!segmented && <div className="report-format-note"><b>当前为标准化摘要</b><span>尚未上传含业务/地区分部的解析财报，因此暂以营业成本与毛利润展示；上传 JSON 后可替换为完整收入明细。</span></div>}
    <div className="financial-breakdown-toolbar">
      <div><button className={!percent ? "is-active" : ""} onClick={() => setPercent(false)}>图表视图</button><button className={percent ? "is-active" : ""} onClick={() => setPercent(true)}>百分比视图</button></div>
      <span>业务 · 单季 · {currency || "USD"}</span>
    </div>
    <div className="financial-chart-card"><BreakdownChart metrics={metrics} percent={percent} /></div>
    <div className="financial-breakdown-list"><div><span>名称</span><span>营收</span><span>环比</span><span>占比</span></div>{breakdownRows.map(([label, data, color]) => { const value = last(data)?.value || 0; const rate = growth(data); return <div key={label}><b><i style={{ background: color }} />{label}</b><b>{compact(value)}</b><b className={(rate || 0) >= 0 ? "up" : "down"}>{rate == null ? "—" : `${rate >= 0 ? "▲" : "▼"} ${Math.abs(rate).toFixed(2)}%`}</b><b>{latestTotal ? `${(value / latestTotal * 100).toFixed(2)}%` : "—"}</b></div>; })}</div>
    <h3 className="financial-operation-title">经营指标</h3>
    <div className="financial-indicator-tabs">{indicators.filter(([, key]) => (metrics[key] || []).length).map(([label, key]) => <button key={key} className={indicator === key ? "is-active" : ""} onClick={() => setIndicator(key)}>{label}</button>)}</div>
    <div className="financial-chart-card"><TrendChart metrics={{ ...metrics, revenue: selected, netIncome: [] }} /></div>
    <div className="financial-table-card"><table><thead><tr><th>时间</th><th>{indicators.find(([, key]) => key === indicator)?.[0]}</th><th>环比</th><th>报告期</th></tr></thead><tbody>{[...selected].reverse().map((point, index, reversed) => { const originalIndex = selected.length - 1 - index; const before = selected[originalIndex - 1]?.value; const rate = before ? (point.value - before) / Math.abs(before) * 100 : null; return <tr key={`${point.period}-${index}`}><td>{periodLabel(point)}</td><td>{compact(point.value)}</td><td className={(rate || 0) >= 0 ? "up" : "down"}>{rate == null ? "—" : `${rate >= 0 ? "+" : ""}${rate.toFixed(2)}%`}</td><td>{point.period}</td></tr>; })}</tbody></table></div>
  </>;
}

export default function FinancialPanel({ market, code }: { market: string; code: string }) {
  const [section, setSection] = useState<Section>("财报");
  const [reportView, setReportView] = useState<ReportView>("摘要");
  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  useLayoutEffect(() => {
    const cached = readFinancialCache(market, code);
    setPayload(cached);
    setLoading(!cached);
  }, [market, code]);
  useEffect(() => {
    const controller = new AbortController();
    const cached = readFinancialCache(market, code);
    if (!cached) setLoading(true);
    fetch(`/api/financials?market=${encodeURIComponent(market)}&code=${encodeURIComponent(code)}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = await response.json().catch(() => null);
        if (!response.ok) throw new Error(body?.error || "财务数据加载失败");
        return body;
      })
      .then((next) => { setPayload(next); writeFinancialCache(market, code, next); })
      .catch((error) => {
        if ((error as Error)?.name !== "AbortError" && !cached) setPayload({ error: error instanceof Error ? error.message : "财务数据加载失败" });
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [market, code, reloadKey]);
  const metrics = useMemo(() => {
    if (!payload?.metrics) return undefined;
    const incoming = payload.metrics;
    const capexByPeriod = new Map((incoming.capex || []).map((point) => [point.period, point.value]));
    const freeCashFlow = (incoming.operatingCashFlow || []).map((point) => ({
      ...point,
      value: point.value - Math.abs(capexByPeriod.get(point.period) || 0)
    }));
    return { ...incoming, freeCashFlow } as Record<Metric, Point[]>;
  }, [payload?.metrics]);
  const rows = useMemo(() => {
    if (!metrics) return [];
    const maps: Record<Section, [string, Metric, boolean?][]> = {
      "财报": [["营业收入", "revenue"], ["毛利润", "grossProfit"], ["营业利润", "operatingIncome"], ["净利润", "netIncome"], ["每股收益", "eps", true]],
      "财务评分": [["盈利能力 · 毛利润", "grossProfit"], ["经营能力 · 营业利润", "operatingIncome"], ["现金能力 · 经营现金流", "operatingCashFlow"], ["偿债能力 · 现金", "cash"]],
      "关键指标": [["营业收入", "revenue"], ["净利润", "netIncome"], ["每股收益", "eps", true], ["总资产", "assets"], ["总负债", "liabilities"]],
      "利润表": [["营业收入", "revenue"], ["毛利润", "grossProfit"], ["营业利润", "operatingIncome"], ["净利润", "netIncome"], ["稀释每股收益", "eps", true]],
      "资产负债表": [["总资产", "assets"], ["总负债", "liabilities"], ["现金及现金等价物", "cash"]],
      "现金流表": [["经营活动现金流", "operatingCashFlow"], ["资本开支", "capex"], ["自由现金流", "freeCashFlow"]],
      "股东回报": [["每股股息", "dividendsPerShare", true], ["净利润", "netIncome"], ["经营活动现金流", "operatingCashFlow"]]
    };
    return maps[section].map(([label, key, perShare]) => ({ label, key, perShare: !!perShare, point: last(metrics[key]), growth: growth(metrics[key]) }));
  }, [metrics, section]);

  const scoreRows = useMemo(() => {
    if (!metrics) return [];
    return [
      ["盈利能力", "毛利润增长与盈利方向", "grossProfit"],
      ["经营效率", "营业利润的持续性", "operatingIncome"],
      ["现金质量", "自由现金流创造能力", "freeCashFlow"],
      ["偿债能力", "现金储备变化趋势", "cash"]
    ].map(([label, description, key]) => {
      const metric = key as Metric;
      const score = scoreMetric(metrics[metric]);
      return { label, description, key: metric, score, tone: scoreTone(score), value: last(metrics[metric])?.value, rate: growth(metrics[metric]) };
    });
  }, [metrics]);

  return <div className="financial-panel">
    <div className="financial-subnav" role="tablist" aria-label="财务数据分类">{SECTIONS.map((item) => <button key={item} type="button" role="tab" aria-selected={section === item} onClick={() => setSection(item)} className={section === item ? "is-active" : ""}>{item}</button>)}</div>
    {loading && !metrics ? <div className="financial-state financial-loading" aria-live="polite"><span className="stock-module-spinner"/><b>正在整理财务数据</b><span>同步申报口径与最近报告期</span></div> : !metrics ? <div className="financial-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4 19V5m0 14h16M8 16v-5m4 5V8m4 8v-3"/></svg><b>暂无可用财务数据</b><span>{payload?.error || "该市场数据源后续接入"}</span><button type="button" onClick={() => setReloadKey((key) => key + 1)}>重新加载</button></div> : <>
      <div className="financial-heading"><div><h3>{section}</h3><p>最新报告期 {last(metrics.revenue)?.period || "—"} · 币种 {payload?.currency}</p></div><span>{payload?.source}</span></div>
      {section === "财报" && <div className="financial-report-tabs">{(["摘要", "收入明细"] as ReportView[]).map((item) => <button key={item} className={reportView === item ? "is-active" : ""} onClick={() => setReportView(item)}>{item}</button>)}</div>}
      {section === "财报" && reportView === "收入明细" ? <RevenueBreakdown metrics={metrics} currency={payload?.currency} /> : <>
      {section === "财报" && <div className="financial-summary">{rows.slice(0, 4).map((row) => <div key={row.label}><span>{row.label}</span><b>{compact(row.point?.value, row.perShare)}</b><em className={(row.growth || 0) >= 0 ? "up" : "down"}>{row.growth == null ? "—" : `${row.growth >= 0 ? "▲" : "▼"} ${Math.abs(row.growth).toFixed(2)}%`}</em></div>)}</div>}
      {section === "财务评分" && <div className="financial-score-grid">{scoreRows.map((row) => <article key={row.label} className={row.tone.className}><header><div><b>{row.label}</b><span>{row.description}</span></div><em>{row.tone.label}</em></header><div className="financial-score-value"><strong>{row.score ?? "—"}</strong><small>/ 100</small><span>{compact(row.value)}</span></div><div className="financial-score-track"><i style={{ width: `${row.score ?? 0}%` }}/></div><footer><span>最近变化</span><b className={(row.rate || 0) >= 0 ? "up" : "down"}>{row.rate == null ? "数据不足" : `${row.rate >= 0 ? "+" : ""}${row.rate.toFixed(2)}%`}</b></footer></article>)}</div>}
      {(section === "财报" || section === "关键指标") && <div className="financial-chart-card"><TrendChart metrics={metrics} /></div>}
      {section !== "财务评分" && <div className="financial-table-card"><table><thead><tr><th>指标</th><th>最新值</th><th>同比/环比</th><th>报告期</th></tr></thead><tbody>{rows.map((row) => <tr key={row.label}><td data-label="指标">{row.label}</td><td data-label="最新值">{compact(row.point?.value, row.perShare)}</td><td data-label="同比/环比" className={(row.growth || 0) >= 0 ? "up" : "down"}>{row.growth == null ? "—" : `${row.growth >= 0 ? "+" : ""}${row.growth.toFixed(2)}%`}</td><td data-label="报告期">{row.point ? `${row.point.fiscalYear || ""} ${row.point.fiscalPeriod || ""}`.trim() : "—"}</td></tr>)}</tbody></table></div>}</>}
      <p className="financial-source">{section === "财务评分" ? "评分依据最近两个报告期的方向与变化幅度生成，仅用于趋势对比，不代表信用评级或投资建议。" : section === "财报" && reportView === "收入明细" ? "收入明细优先使用已归档财报的结构化解析；标准化数据仅作缺省摘要。" : `数据来自 ${payload?.source}，原始申报口径未经调整，仅供参考。`}</p>
    </>}
  </div>;
}
