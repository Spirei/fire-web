"use client";

import { useWorkspaceSearchParams as useSearchParams, useWorkspaceLocationGuard } from "@/lib/workspacePanel";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { IconActivity, IconArrowLeft, IconArrowUpRight, IconCheck, IconChevronLeft, IconChevronRight, IconPlayerPause, IconPlayerPlay, IconRefresh, IconSearch, IconX } from "@tabler/icons-react";
import ThemeToggle from "@/components/ThemeToggle";
import AppSelect from "@/components/AppSelect";
import ApiPathText from "@/components/ApiPathText";
import { usePersistedState } from "@/lib/usePersistedState";
import { parseRequestFilters, requestDay, type RequestFilters, type RequestSnapshot } from "@/lib/apiRequestTypes";
import { useWorkspaceForeground } from "@/lib/useWorkspaceForeground";

const SOURCE_NAMES = { web: "网页", ios: "iOS", app: "App", other: "其他" };
const FILTER_KEYS: Record<keyof RequestFilters, string> = { period: "rPeriod", status: "rStatus", source: "rSource", method: "rMethod", q: "rQ", page: "rPage", anchor: "rAnchor", day: "rDay", year: "rYear" };
const fmt = (value: number) => value.toLocaleString("zh-CN");
const ms = (value: number) => value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`;
const time = (value: number) => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(value);
const stamp = (value: number) => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(value);

function filterParams(filters: RequestFilters) {
  const params = new URLSearchParams();
  for (const key of Object.keys(FILTER_KEYS) as Array<keyof RequestFilters>) {
    const value = filters[key];
    if (value !== "" && value !== "all" && value !== 0) params.set(FILTER_KEYS[key], String(value));
  }
  return params;
}
function Method({ value }: { value: string }) { return <span className={`rq-method rq-method-${value.toLowerCase()}`}>{value}</span>; }
function ApiPath({ path, className = "" }: { path: string; className?: string }) {
  return <span className={`rq-api-path ${className}`}>
    <span className="rq-api-path-text" title={path}><ApiPathText path={path} /></span>
  </span>;
}

function RequestHeatmap({ counts, today, filters, onChange }: { counts: Record<string, number>; today: string; filters: RequestFilters; onChange: (next: Partial<RequestFilters>) => void }) {
  const { cells, months, weeks } = useMemo(() => {
    const start = new Date(Date.UTC(filters.year, 0, 1)), end = new Date(Date.UTC(filters.year, 11, 31));
    const gridStart = new Date(start); gridStart.setUTCDate(gridStart.getUTCDate() - gridStart.getUTCDay());
    const gridEnd = new Date(end); gridEnd.setUTCDate(gridEnd.getUTCDate() + 6 - gridEnd.getUTCDay());
    const cells: Array<{ key: string; valid: boolean; future: boolean; count: number }> = [];
    const months: Array<{ key: string; column: number }> = [];
    for (let at = gridStart.getTime(), index = 0; at <= gridEnd.getTime(); at += 86400_000, index++) {
      const date = new Date(at), key = date.toISOString().slice(0, 10);
      const valid = at >= start.getTime() && at <= end.getTime();
      if (valid && date.getUTCDate() === 1) months.push({ key: `${date.getUTCMonth() + 1}月`, column: Math.floor(index / 7) + 1 });
      cells.push({ key, valid, future: key > today, count: key <= today ? counts[key] || 0 : 0 });
    }
    return { cells, months, weeks: cells.length / 7 };
  }, [counts, filters.year, today]);
  const max = Math.max(1, ...cells.map(cell => cell.count));
  const total = cells.reduce((sum, cell) => sum + (cell.valid ? cell.count : 0), 0);
  return <section className="rq-card rq-heatmap">
    <div className="rq-section-head"><div><h2>请求热力图</h2><span className="rq-meta">{fmt(total)} 次请求</span></div>
      <AppSelect ariaLabel="热力图年份" value={filters.year} options={[Number(today.slice(0, 4)), Number(today.slice(0, 4)) - 1].map(year => ({ value: String(year), label: `${year} 年` }))} onChange={value => onChange({ year: Number(value), day: "" })} className="rq-select" />
    </div>
    <div className="rq-heatmap-scroll"><div className="rq-heatmap-inner">
      <div className="rq-months" style={{ gridTemplateColumns: `repeat(${weeks},minmax(0,1fr))` }}>{months.map(month => <span key={month.key} style={{ gridColumnStart: month.column }}>{month.key}</span>)}</div>
      <div className="rq-days"><span>一</span><span>三</span><span>五</span></div>
      <div className="rq-heatmap-grid" style={{ gridTemplateColumns: `repeat(${weeks},minmax(0,1fr))` }}>
        {cells.map(cell => cell.valid ? <button key={cell.key} type="button" disabled={cell.future} aria-pressed={filters.day === cell.key} aria-label={`${cell.key}，${fmt(cell.count)} 次请求`} title={`${cell.key} · ${cell.future ? "尚未到来" : `${fmt(cell.count)} 次请求`}`} className={`rq-heat-cell rq-heat-${cell.future ? "future" : cell.count === 0 ? 0 : Math.min(4, Math.max(1, Math.ceil(4 * Math.log1p(cell.count) / Math.log1p(max))))}`} onClick={() => onChange({ day: filters.day === cell.key ? "" : cell.key })} /> : <span key={cell.key} />)}
      </div>
    </div></div>
    <div className="rq-heatmap-foot"><span>{filters.day || `${filters.year} 年`}</span><span className="rq-legend">少{[0, 1, 2, 3, 4].map(level => <i key={level} className={`rq-heat-${level}`} />)}多</span></div>
  </section>;
}

export default function ApiRequests({ standalone = false }: { standalone?: boolean }) {
  const foreground = useWorkspaceForeground();
  const foregroundRef = useRef(foreground);
  foregroundRef.current = foreground;
  const canUseWorkspaceUrl = useWorkspaceLocationGuard();
  const searchParams = useSearchParams();
  const query = searchParams.toString();
  const filters = useMemo(() => parseRequestFilters(new URLSearchParams(query)), [query]);
  const filterKey = filterParams(filters).toString();
  const [result, setResult] = useState<{ key: string; snapshot: RequestSnapshot } | null>(null);
  const snapshot = result?.key === filterKey ? result.snapshot : null;
  const [error, setError] = useState("");
  const [blocked, setBlocked] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [checkedAt, setCheckedAt] = useState(0);
  const [live, setLive] = usePersistedState("fire:api-requests:live", true);
  const [connection, setConnection] = useState<"connecting" | "live" | "reconnecting" | "paused">("connecting");
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const flight = useRef<AbortController | null>(null);
  const flightKey = useRef("");
  const changedDuringRead = useRef(false);
  const confirmed = useRef({ key: "", at: 0 });
  const queueRefresh = useRef<() => void>(() => {});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chartRef = useRef<HTMLDivElement | null>(null);
  const [chartHover, setChartHover] = useState<{ index: number; x: number } | null>(null);
  const tooltipId = useId();
  const loadingShape = useRef({ rows: 6, endpoints: 3 });

  const refresh = useCallback(async () => {
    if (!foregroundRef.current || document.hidden) return;
    const key = filterParams(filtersRef.current).toString();
    if (flight.current && !flight.current.signal.aborted && flightKey.current === key) {
      changedDuringRead.current = true;
      return;
    }
    flight.current?.abort();
    const controller = new AbortController(); flight.current = controller;
    flightKey.current = key;
    setRefreshing(true);
    const isCurrent = () => !controller.signal.aborted && foregroundRef.current && !document.hidden && key === filterParams(filtersRef.current).toString();
    try {
      const response = await fetch(`/api/request-logs?${key}`, { cache: "no-store", signal: controller.signal });
      const data = await response.json();
      if (!isCurrent()) return;
      if (!response.ok || data.code !== 0) {
        if (response.status === 401 || response.status === 403) { setBlocked(true); setResult(null); }
        throw new Error(data.message || "请求日志读取失败");
      }
      loadingShape.current = { rows: data.data.logs.length, endpoints: data.data.endpoints.length };
      const at = Date.now(); confirmed.current = { key, at };
      setResult({ key, snapshot: data.data }); setError(""); setCheckedAt(at);
    } catch (error) { if (isCurrent()) setError(error instanceof Error ? error.message : "请求日志读取失败"); }
    finally {
      if (flight.current === controller) {
        flight.current = null;
        setRefreshing(false);
        if (changedDuringRead.current && !controller.signal.aborted && foregroundRef.current && !document.hidden) {
          changedDuringRead.current = false;
          queueRefresh.current();
        }
      }
    }
  }, []);
  const scheduleRefresh = useCallback((delay = 150, replace = false) => {
    if (!foregroundRef.current || document.hidden) return;
    // Coalesce live events without postponing an update forever under sustained traffic.
    if (timer.current && !replace) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; void refresh(); }, delay);
  }, [refresh]);
  queueRefresh.current = scheduleRefresh;

  useEffect(() => {
    if (foreground) {
      setError("");
      if (confirmed.current.key !== filterKey || Date.now() - confirmed.current.at >= 30_000) scheduleRefresh(180, true);
    } else setRefreshing(false);
    return () => {
      flight.current?.abort(); flight.current = null; changedDuringRead.current = false;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [filterKey, foreground, scheduleRefresh]);

  useEffect(() => {
    if (!foreground || !live || blocked) { setConnection("paused"); return; }
    let events: EventSource | null = null;
    let stopped = false;
    const open = () => {
      events?.close(); events = null;
      if (document.hidden) { setConnection("paused"); return; }
      setConnection("connecting");
      events = new EventSource("/api/request-logs/events");
      events.onopen = () => { if (!stopped) setConnection("live"); };
      events.addEventListener("change", () => { if (!stopped) scheduleRefresh(); });
      events.onerror = () => { if (!stopped) { setConnection("reconnecting"); scheduleRefresh(); } };
      if (confirmed.current.key !== filterParams(filtersRef.current).toString() || Date.now() - confirmed.current.at >= 30_000) scheduleRefresh();
    };
    open();
    // EventSource reconnects itself. This bounded fallback also works behind buffering proxies.
    const fallback = setInterval(() => { if (!document.hidden) scheduleRefresh(); }, 30_000);
    return () => { stopped = true; events?.close(); clearInterval(fallback); };
  }, [blocked, live, foreground, scheduleRefresh]);
  useEffect(() => () => { flight.current?.abort(); if (timer.current) clearTimeout(timer.current); }, []);

  const change = (patch: Partial<RequestFilters>) => {
    if (!canUseWorkspaceUrl()) return;
    const next = { ...filters, page: 1, anchor: 0, ...patch };
    if (patch.period) next.day = "";
    const url = new URL(window.location.href);
    for (const key of Object.values(FILTER_KEYS)) url.searchParams.delete(key);
    filterParams(next).forEach((value, key) => url.searchParams.set(key, value));
    window.history.replaceState(null, "", url.pathname + "?" + url.searchParams.toString());
  };
  const selectClass = "rq-select";
  const summary = snapshot?.summary;
  const successRate = summary?.total ? `${((1 - summary.errors / summary.total) * 100).toFixed(1)}%` : "—";
  const chart = useMemo(() => {
    if (!snapshot) return [];
    const data = new Map(snapshot.chart.map(row => [row.key, row]));
    const end = filters.day || snapshot.today;
    if (snapshot.chartUnit === "hour") {
      return Array.from({ length: 24 }, (_, hour) => { const key = `${end}T${String(hour).padStart(2, "0")}:00`; return data.get(key) || { key, count: 0, errors: 0 }; });
    }
    if (filters.day) return snapshot.chart;
    const days = filters.period === "30d" ? 30 : 7;
    return Array.from({ length: days }, (_, index) => { const key = new Date(Date.parse(`${end}T00:00:00Z`) - (days - 1 - index) * 86400_000).toISOString().slice(0, 10); return data.get(key) || { key, count: 0, errors: 0 }; });
  }, [filters.day, filters.period, snapshot]);
  const chartMax = Math.max(1, ...chart.map(row => row.count));
  const hoverRow = chartHover ? chart[chartHover.index] : null;
  const inspectChart = (index: number, clientX?: number) => {
    const bounds = chartRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const x = clientX === undefined ? (index + 0.5) / chart.length * bounds.width : clientX - bounds.left;
    setChartHover({ index, x: Math.max(80, Math.min(bounds.width - 80, x)) });
  };
  const totalPages = Math.max(1, Math.ceil((snapshot?.pagination.total || 0) / 20));
  const safePage = snapshot?.pagination.page || filters.page;

  return <div className="rq-dashboard">
    <header className="rq-header"><div className="rq-title"><span className="rq-title-icon"><IconActivity size={22} stroke={1.6} /></span><div>{standalone ? <h1>API 请求</h1> : <h2>API 请求</h2>}{checkedAt > 0 && <span className="rq-meta">{time(checkedAt)}</span>}</div></div>
      <div className="rq-actions">
        {standalone && <ThemeToggle />}
        <button type="button" className="rq-live rq-control" aria-pressed={live} onClick={() => setLive(!live)} title={live ? "暂停实时刷新" : "开启实时刷新"}>
          {live ? <><i className={`rq-live-dot ${connection === "live" ? "is-live" : ""}`} /><IconPlayerPause size={13} /></> : <IconPlayerPlay size={14} />}{live ? connection === "reconnecting" ? "重连中" : "实时" : "已暂停"}
        </button>
        <button type="button" className="rq-icon-button" aria-label="刷新请求日志" title="刷新" disabled={refreshing} onClick={() => scheduleRefresh(0, true)}><IconRefresh size={17} className={refreshing ? "rq-spinning" : ""} /></button>
        <Link className="rq-icon-button" href={standalone ? "/activities?scope=requests" : `/api-requests?${filterParams(filters)}`} aria-label={standalone ? "返回日志" : "打开 API 请求页"} title={standalone ? "返回日志" : "独立页面"}>{standalone ? <IconArrowLeft size={17} /> : <IconArrowUpRight size={17} />}</Link>
      </div>
    </header>
    {error && <div role="alert" className="rq-error">{error}</div>}
    {!blocked && <>
      <div className="rq-filters">
        <AppSelect ariaLabel="请求时间范围" value={filters.period} options={[{ value: "today", label: "今天" }, { value: "7d", label: "近 7 天" }, { value: "30d", label: "近 30 天" }]} onChange={period => change({ period: period as RequestFilters["period"] })} className={selectClass} />
        <AppSelect ariaLabel="请求状态" value={filters.status} options={[{ value: "all", label: "全部状态" }, { value: "success", label: "成功" }, { value: "4xx", label: "客户端错误" }, { value: "5xx", label: "服务端错误" }, { value: "cancelled", label: "连接中断" }]} onChange={status => change({ status: status as RequestFilters["status"] })} className={selectClass} />
        <AppSelect ariaLabel="请求来源" value={filters.source} options={[{ value: "all", label: "全部来源" }, ...Object.entries(SOURCE_NAMES).map(([value, label]) => ({ value, label }))]} onChange={source => change({ source: source as RequestFilters["source"] })} className={selectClass} />
        <AppSelect ariaLabel="请求方法" value={filters.method} options={[{ value: "all", label: "全部方法" }, ...["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].map(value => ({ value, label: value }))]} onChange={method => change({ method })} className={selectClass} />
        <label className="rq-search"><IconSearch size={16} /><input aria-label="搜索请求接口" placeholder="搜索接口" value={filters.q} onChange={event => change({ q: event.target.value.slice(0, 120) })} /></label>
        {filters.day && <button type="button" className="rq-day-chip" onClick={() => change({ day: "" })}>{filters.day}<IconX size={13} /></button>}
      </div>
      <section className="rq-stats" aria-label="请求概览">
        {[{ name: "请求总数", value: summary ? fmt(summary.total) : "—", className: "" }, { name: "成功率", value: successRate, className: summary?.errors ? summary.errors === summary.total ? "rq-negative" : "rq-caution" : "rq-positive" }, { name: "平均耗时", value: summary?.total ? ms(summary.averageMs) : "—", className: "" }, { name: "服务端错误", value: summary ? fmt(summary.serverErrors) : "—", className: summary?.serverErrors ? "rq-negative" : "" }].map(item => <div key={item.name} className="rq-card rq-stat"><span>{item.name}</span><strong className={item.className}>{item.value}</strong></div>)}
      </section>
      <div className="rq-middle">
        <section className="rq-card rq-trend"><div className="rq-section-head"><h2>请求趋势</h2><span className="rq-meta">{filters.day || ({ today: "今天", "7d": "近 7 天", "30d": "近 30 天" }[filters.period])}</span></div>
          <div className="rq-chart" ref={chartRef} onPointerLeave={() => setChartHover(null)}>
            <div className="rq-chart-lines"><span>{fmt(chartMax)}</span><span>{fmt(Math.floor(chartMax / 2))}</span><span>0</span></div>
            <div className={`rq-chart-bars${hoverRow ? " is-inspecting" : ""}`}>{chart.map((row, index) => <button type="button" className={`rq-chart-slot${chartHover?.index === index ? " is-active" : ""}`} key={row.key} aria-label={`${row.key.replace("T", " ")}，${fmt(row.count)} 次请求，${fmt(row.errors)} 次错误`} aria-describedby={chartHover?.index === index ? tooltipId : undefined} onPointerEnter={event => inspectChart(index, event.clientX)} onPointerMove={event => inspectChart(index, event.clientX)} onFocus={() => inspectChart(index)} onBlur={() => setChartHover(null)} onClick={() => inspectChart(index)}><span className="rq-chart-bar" style={{ height: `${row.count / chartMax * 100}%` }}><i style={{ height: `${row.count ? row.errors / row.count * 100 : 0}%` }} /></span>{index % Math.max(1, Math.floor(chart.length / 5)) === 0 && <span className="rq-chart-label">{row.key.includes("T") ? row.key.slice(11, 16) : row.key.slice(5)}</span>}</button>)}</div>
            {hoverRow && chartHover && <><div className="rq-chart-cursor" style={{ left: `${(chartHover.index + 0.5) / chart.length * 100}%` }} /><div id={tooltipId} role="tooltip" className="rq-chart-tooltip" style={{ left: chartHover.x }}><time>{hoverRow.key.replace("T", " ")}</time><div><span><i />请求</span><strong>{fmt(hoverRow.count)}</strong></div><div><span><i className="is-error" />错误</span><strong>{fmt(hoverRow.errors)}</strong></div></div></>}
          </div>
          <div className="rq-chart-legend"><span><i />请求</span><span><i className="is-error" />错误</span></div>
        </section>
        <section className="rq-card rq-sources"><div className="rq-section-head"><h2>请求来源</h2><IconActivity size={17} className="rq-muted" /></div><div className="rq-source-total">{summary ? fmt(summary.total) : "—"}<span>次请求</span></div><div className="rq-source-track">{Object.keys(SOURCE_NAMES).map((key, index) => <i key={key} className={`rq-source-${index}`} style={{ width: `${summary?.total ? summary.sources[key as keyof typeof SOURCE_NAMES] / summary.total * 100 : 0}%` }} />)}</div><div className="rq-source-list">{Object.entries(SOURCE_NAMES).map(([key, label], index) => <div key={key}><span><i className={`rq-source-${index}`} />{label}</span><strong>{summary ? fmt(summary.sources[key as keyof typeof SOURCE_NAMES]) : "—"}</strong></div>)}</div></section>
      </div>
      <section className="rq-card rq-ranking"><div className="rq-section-head"><h2>常用接口</h2><span className="rq-meta">{snapshot?.endpoints.length || 0} 个</span></div>
        {snapshot?.endpoints.length ? snapshot.endpoints.map(row => <button type="button" key={`${row.method}:${row.path}`} className="rq-endpoint" onClick={() => change({ q: row.path, method: row.method })}><Method value={row.method} /><ApiPath path={row.path} className="rq-endpoint-path" /><span className="rq-endpoint-track"><i style={{ width: `${row.count / snapshot.endpoints[0].count * 100}%` }} /></span><strong>{fmt(row.count)}</strong><span className="rq-meta">{ms(row.averageMs)}</span></button>) : snapshot ? <div className="rq-empty">暂无请求</div> : Array.from({ length: Math.max(1, loadingShape.current.endpoints) }, (_, index) => <div className="rq-endpoint rq-placeholder" aria-hidden="true" key={index}><i className="rq-skeleton" /></div>)}
      </section>
      <section className="rq-card rq-records"><div className="rq-section-head"><h2>请求日志</h2><span className="rq-count">{snapshot ? fmt(snapshot.pagination.total) : "—"}</span></div>
        <div className="rq-table-scroll"><table><thead><tr><th>时间</th><th>接口</th><th>状态</th><th>耗时</th><th>来源</th></tr></thead><tbody>{snapshot ? snapshot.logs.map(row => <tr key={row.id}><td><time dateTime={new Date(row.at).toISOString()} title={new Date(row.at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}>{stamp(row.at)}</time></td><td><div className="rq-table-path"><Method value={row.method} /><ApiPath path={row.path} /></div></td><td><span className={`rq-status ${row.status >= 500 ? "is-error" : row.status >= 400 ? "is-warn" : "is-success"}`}>{row.status < 400 && <IconCheck size={11} />}{row.status}</span></td><td className={row.duration >= 1000 ? "rq-slow" : ""}>{ms(row.duration)}</td><td>{SOURCE_NAMES[row.source]}</td></tr>) : Array.from({ length: Math.max(1, loadingShape.current.rows) }, (_, index) => <tr className="rq-placeholder" aria-hidden="true" key={index}>{[0, 1, 2, 3, 4].map(column => <td key={column}><i className="rq-skeleton" /></td>)}</tr>)}</tbody></table></div>
        {snapshot && !snapshot.logs.length && <div className="rq-empty">{filters.day && Date.parse(`${filters.day}T23:59:59+08:00`) < snapshot.detailFrom ? "该日期的请求明细已过保留期" : "暂无请求记录"}</div>}
        {totalPages > 1 && <div className="rq-pagination"><span>第 {safePage} / {totalPages} 页</span><div><button type="button" className="rq-icon-button" disabled={safePage <= 1 || refreshing} aria-label="上一页请求" onClick={() => change({ page: safePage - 1, anchor: safePage === 2 ? 0 : snapshot?.pagination.anchor || 0 })}><IconChevronLeft size={15} /></button><button type="button" className="rq-icon-button" disabled={safePage >= totalPages || refreshing} aria-label="下一页请求" onClick={() => change({ page: safePage + 1, anchor: snapshot?.pagination.anchor || 0 })}><IconChevronRight size={15} /></button></div></div>}
      </section>
      <RequestHeatmap counts={snapshot?.heatmap || {}} today={snapshot?.today || requestDay()} filters={filters} onChange={change} />
    </>}
  </div>;
}
