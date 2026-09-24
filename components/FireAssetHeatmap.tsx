"use client";

import { useMemo, useState } from "react";
import { fireAssetChange, type FireAssetRecord } from "@/lib/fireAssetHistory";

type View = "day" | "week" | "month" | "total";
type Cell = { key: string; date: Date; label: string; week: string; month: string; record?: FireAssetRecord; previous?: FireAssetRecord; count: number; delta: number | null };

const shanghaiDay = (value: Date) => {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value);
  const field = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${field("year")}-${field("month")}-${field("day")}`;
};
const utcKey = (date: Date) => date.toISOString().slice(0, 10);
const money = (record: FireAssetRecord) => `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(record.amountBase)} ${record.currency}`;
const pct = (value: number | null) => value == null ? "基准记录" : `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
const tone = (cell: Cell) => {
  if (!cell.record) return "rgba(100,116,139,.14)";
  if (cell.delta == null) return "rgba(59,130,246,.62)";
  if (Math.abs(cell.delta) < 0.005) return "rgba(100,116,139,.42)";
  const alpha = (0.22 + 0.7 * Math.min(1, Math.abs(cell.delta) / 10)).toFixed(2);
  return cell.delta > 0 ? `rgba(16,185,129,${alpha})` : `rgba(239,68,68,${alpha})`;
};

export default function FireAssetHeatmap({ history }: { history: FireAssetRecord[] }) {
  const [view, setView] = useState<View>("day");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const todayKey = shanghaiDay(new Date());
  const year = Number(todayKey.slice(0, 4));
  const { cells, labels, weekCount } = useMemo(() => {
    const ordered = [...history].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
    const daily = new Map<string, { record: FireAssetRecord; previous?: FireAssetRecord; count: number; delta: number | null }>();
    ordered.forEach((record, index) => {
      const key = shanghaiDay(new Date(record.recordedAt));
      const previous = ordered[index - 1];
      daily.set(key, { record, previous, count: (daily.get(key)?.count ?? 0) + 1, delta: fireAssetChange(previous?.amountUsd ?? 0, record.amountUsd) });
    });
    const first = new Date(Date.UTC(year, 0, 1));
    const last = new Date(Date.UTC(year, 11, 31));
    const start = new Date(first);
    start.setUTCDate(start.getUTCDate() - start.getUTCDay());
    const end = new Date(last);
    end.setUTCDate(end.getUTCDate() + 6 - end.getUTCDay());
    const result: Cell[] = [];
    const monthLabels: { key: string; label: string; column: number }[] = [];
    let previousMonth = -1;
    for (let date = new Date(start), index = 0; date <= end; date.setUTCDate(date.getUTCDate() + 1), index++) {
      const current = new Date(date);
      const key = utcKey(current);
      const inYear = current.getUTCFullYear() === year;
      const month = current.getUTCMonth();
      if (inYear && month !== previousMonth) {
        monthLabels.push({ key: String(month), label: `${month + 1}月`, column: Math.floor(index / 7) });
        previousMonth = month;
      }
      const weekStart = new Date(current);
      weekStart.setUTCDate(weekStart.getUTCDate() - weekStart.getUTCDay());
      result.push({ key, date: current, label: `${month + 1}月${current.getUTCDate()}日`, week: utcKey(weekStart), month: `${year}-${month}`, count: 0, delta: null,
        ...(inYear && key <= todayKey ? daily.get(key) : undefined) });
    }
    return { cells: result, labels: monthLabels, weekCount: result.length / 7 };
  }, [history, year, todayKey]);
  const selected = cells.find((cell) => cell.key === selectedKey);
  const group = selected ? cells.filter((cell) => view === "week" ? cell.week === selected.week : view === "month" ? cell.month === selected.month : view === "total" ? cell.key <= selected.key : cell.key === selected.key) : [];
  const records = group.filter((cell) => cell.record);
  const latest = records.at(-1);
  const first = records[0];
  const groupChange = first && latest ? fireAssetChange(first.previous?.amountUsd ?? 0, latest.record!.amountUsd) : null;
  const tabs: [View, string][] = [["day", "每日"], ["week", "每周"], ["month", "每月"], ["total", "累计"]];
  return (
    <section className="mt-8 overflow-hidden rounded-xl border border-edge bg-white p-4 dark:border-edge-strong dark:bg-[#16181c] sm:p-5" aria-label="当前资产记录热力图">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink-2 dark:text-white">资产记录热力图</h2>
          <p className="mt-1 text-xs text-muted">以手动保存的当前资产为记录；首次为基准，之后与上次填报比较</p>
        </div>
        <div className="flex items-center gap-1 rounded-lg bg-bg-gray p-1 text-xs dark:bg-white/[.06]" role="tablist" aria-label="资产记录统计周期">
          {tabs.map(([key, label]) => <button key={key} type="button" role="tab" aria-selected={view === key} onClick={() => { setView(key); setSelectedKey(null); }} className={`rounded-md px-2 py-1 ${view === key ? "bg-white font-medium text-ink-2 shadow-sm dark:bg-white/10 dark:text-white" : "text-muted"}`}>{label}</button>)}
        </div>
      </div>
      <div className="deploy-heatmap-continuous min-w-0">
        <div className="deploy-heatmap-labels" style={{ gridTemplateColumns: `repeat(${weekCount}, minmax(0, 1fr))` }}>
          {labels.map((month) => <span key={month.key} style={{ gridColumnStart: month.column + 1 }}>{month.label}</span>)}
        </div>
        <div className="deploy-heatmap-grid grid w-full grid-flow-col grid-rows-7 gap-[2px]" style={{ gridTemplateColumns: `repeat(${weekCount}, minmax(0, 1fr))` }}>
          {cells.map((cell) => cell.date.getUTCFullYear() !== year
            ? <span key={cell.key} className="min-w-0" style={{ aspectRatio: "1 / 1" }} />
            : <button key={cell.key} type="button" disabled={cell.key > todayKey} onClick={() => setSelectedKey(cell.key)}
                aria-label={`${cell.label}，${cell.record ? `${money(cell.record)}，较上次 ${pct(cell.delta)}` : "未填报"}`}
                title={`${cell.label} · ${cell.record ? `${money(cell.record)} · ${pct(cell.delta)}` : "未填报"}`}
                className={`min-w-0 rounded-[2px] p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${selected && (view === "week" ? cell.week === selected.week : view === "month" ? cell.month === selected.month : view === "total" ? cell.key <= selected.key : cell.key === selected.key) ? "ring-2 ring-brand" : ""}`}
                style={{ aspectRatio: "1 / 1", backgroundColor: cell.key > todayKey ? "rgba(100,116,139,.08)" : tone(cell) }} />)}
        </div>
      </div>
      {selected && <p className="mt-3 rounded-lg bg-bg-gray px-3 py-2 text-xs text-ink-2 dark:bg-white/[.06] dark:text-white">
        {view === "day" ? selected.label : view === "week" ? `${selected.label}所在周` : view === "month" ? `${selected.date.getUTCMonth() + 1}月` : `截至${selected.label}`} · {records.reduce((sum, cell) => sum + cell.count, 0)} 次填报
        {latest && ` · ${money(latest.record!)} · 较${view === "day" ? "上次" : "期初"} ${pct(view === "day" ? selected.delta : groupChange)}`}
      </p>}
      {history.length === 0 && <p className="mt-3 text-xs text-muted">编辑并保存“当前资产”后，这里会出现第一条基准记录。</p>}
      <div className="mt-3 flex items-center justify-end gap-2 text-[10px] text-muted">
        <span>下降</span><i className="h-2.5 w-2.5 rounded-[3px] bg-red-500/80" /><span>基准</span><i className="h-2.5 w-2.5 rounded-[3px] bg-blue-500/70" /><span>上升</span><i className="h-2.5 w-2.5 rounded-[3px] bg-emerald-500/80" />
      </div>
    </section>
  );
}
