"use client";

import { useState, type ReactNode } from "react";
import MarketIcon from "@/components/MarketIcon";
import MarketCodeBadge from "@/components/MarketCodeBadge";
import type { CalendarDayCell, CalendarDayRow, CalendarYearCell } from "@/lib/pnlCalendar";
import EtfDoubleBadge from "@/components/EtfDoubleBadge";

const CAL_MARKETS = ["全部", "美股", "港股", "A股"] as const;
const CAL_MARKET_ICON: Record<string, string> = { 美股: "US", 港股: "HK", A股: "CN" };

/** 共用「选择日期」按钮：点击弹出年份/月份选择器 */
function DateSelectButton({
  year,
  month,
  onSelect,
  label
}: {
  year: number;
  month: number;
  onSelect: (y: number, m: number) => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const [pickerYear, setPickerYear] = useState(year);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="选择日期"
        aria-label="选择日期"
        className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-sm font-semibold transition ${open ? "bg-bg-gray" : "text-ink-2 hover:bg-bg-gray"}`}
      >
        {label}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5 text-muted">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <>
          <div data-drag-skip className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div data-drag-skip className="absolute right-0 top-full z-40 mt-1 w-56 overflow-hidden rounded-xl border border-edge-strong bg-white p-3 shadow-pop dark:border-white/10 dark:bg-[#1b2029]">
            <div className="flex items-center justify-between">
              <button type="button" onClick={() => setPickerYear((y) => y - 1)} aria-label="上一年" className="grid h-7 w-7 place-items-center rounded-full text-muted hover:bg-bg-gray">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5"><path d="m15 18-6-6 6-6" /></svg>
              </button>
              <span className="text-sm font-bold">{pickerYear}</span>
              <button type="button" onClick={() => setPickerYear((y) => y + 1)} aria-label="下一年" className="grid h-7 w-7 place-items-center rounded-full text-muted hover:bg-bg-gray">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5"><path d="m9 18 6-6-6-6" /></svg>
              </button>
            </div>
            <div className="mt-2 grid grid-cols-3 gap-1">
              {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => {
                const active = year === pickerYear && month === m;
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => {
                      onSelect(pickerYear, m);
                      setOpen(false);
                    }}
                    className={`rounded-lg py-2 text-sm font-semibold transition ${active ? "bg-[#3297f6] text-white" : "text-ink-2 hover:bg-bg-gray"}`}
                  >
                    {m}月
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export interface PnlCalendarProps {
  days: (CalendarDayCell | null)[];
  yearSummary: CalendarYearCell[];
  loading?: boolean;
  month: { y: number; m: number };
  onMonthChange: (next: { y: number; m: number }) => void;
  view: "year" | "month";
  onViewChange: (view: "year" | "month") => void;
  mode: "收益" | "收益率";
  onModeChange: (mode: "收益" | "收益率") => void;
  market: string;
  onMarketChange: (market: string) => void;
  /** 明细行 / 合计金额（带符号与货币符号） */
  formatAmount: (usd: number) => string;
  /** 格子里的小字（紧凑金额，带符号） */
  formatCompact: (usd: number) => string;
  /** 375px 七列月历里的超窄金额；未传时沿用 formatCompact。 */
  formatNarrow?: (usd: number) => string;
  onDayClick: (date: string) => void;
  dayDetail: { date: string; rows: CalendarDayRow[] } | null;
  onDayDetailClose: () => void;
  /** 当日明细行前面的股票图标（key 形态 `市场:代码`，与全站一致） */
  stockIcons?: Record<string, string>;
  /** 明细行里的市场标识，默认用全站通用的 MarketCodeBadge */
  renderMarketBadge?: (row: CalendarDayRow) => ReactNode;
  className?: string;
  title?: string;
}

export default function PnlCalendar({
  days,
  yearSummary,
  loading = false,
  month,
  onMonthChange,
  view,
  onViewChange,
  mode,
  onModeChange,
  market,
  onMarketChange,
  formatAmount,
  formatCompact,
  formatNarrow = formatCompact,
  onDayClick,
  dayDetail,
  onDayDetailClose,
  stockIcons,
  renderMarketBadge,
  className = "card p-5",
  title = "收益日历"
}: PnlCalendarProps) {
  const [marketMenuOpen, setMarketMenuOpen] = useState(false);
  const [dayDetailMode, setDayDetailMode] = useState<"profit" | "loss">("profit");

  const shiftMonth = (delta: number) => {
    const m = month.m + delta;
    const y = m < 1 ? month.y - 1 : m > 12 ? month.y + 1 : month.y;
    onMonthChange({ y, m: ((m - 1 + 12) % 12) + 1 });
  };

  return (
    <section className={className}>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <h2 className="text-base font-bold">{title}</h2>
          <div className="flex items-center gap-1">
            <button onClick={() => shiftMonth(-1)} className="grid h-7 w-7 place-items-center rounded-full border border-edge text-muted hover:bg-bg-gray" aria-label="上个月">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5"><path d="m15 18-6-6 6-6" /></svg>
            </button>
            <button onClick={() => shiftMonth(1)} className="grid h-7 w-7 place-items-center rounded-full border border-edge text-muted hover:bg-bg-gray" aria-label="下个月">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5"><path d="m9 18 6-6-6-6" /></svg>
            </button>
            <DateSelectButton
              year={month.y}
              month={month.m}
              label={`${month.y}/${String(month.m).padStart(2, "0")}`}
              onSelect={(y, m) => onMonthChange({ y, m })}
            />
            <div className="relative ml-1">
              <button
                type="button"
                onClick={() => setMarketMenuOpen((open) => !open)}
                title={`市场：${market}`}
                aria-label="选择日历市场"
                className={`grid h-8 w-8 place-items-center rounded-full border transition ${marketMenuOpen ? "border-edge-strong bg-bg-gray text-ink-2" : "border-edge text-muted hover:bg-bg-gray hover:text-ink-2"}`}
              >
                {market === "全部" ? (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4">
                    <rect x="3.5" y="3.5" width="7" height="7" rx="1.8" />
                    <rect x="13.5" y="3.5" width="7" height="7" rx="1.8" />
                    <rect x="3.5" y="13.5" width="7" height="7" rx="1.8" />
                    <rect x="13.5" y="13.5" width="7" height="7" rx="1.8" />
                  </svg>
                ) : (
                  <MarketIcon market={CAL_MARKET_ICON[market] || "US"} size={17} />
                )}
              </button>
              {marketMenuOpen && (
                <>
                  <div data-drag-skip className="fixed inset-0 z-30" onClick={() => setMarketMenuOpen(false)} />
                  <div data-drag-skip className="absolute right-0 top-full z-40 mt-1 w-32 overflow-hidden rounded-xl border border-edge-strong bg-white p-1 shadow-pop dark:border-white/10 dark:bg-[#1b2029]">
                    {CAL_MARKETS.map((item) => (
                      <button
                        key={item}
                        type="button"
                        onClick={() => {
                          onMarketChange(item);
                          setMarketMenuOpen(false);
                        }}
                        className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm transition ${market === item ? "bg-bg-gray font-semibold text-ink" : "text-ink hover:bg-bg-gray"}`}
                      >
                        {item === "全部" ? (
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4">
                            <rect x="3.5" y="3.5" width="7" height="7" rx="1.8" />
                            <rect x="13.5" y="3.5" width="7" height="7" rx="1.8" />
                            <rect x="3.5" y="13.5" width="7" height="7" rx="1.8" />
                            <rect x="13.5" y="13.5" width="7" height="7" rx="1.8" />
                          </svg>
                        ) : (
                          <MarketIcon market={CAL_MARKET_ICON[item] || "US"} size={16} />
                        )}
                        {item}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-full bg-bg-gray p-1 text-sm">
            <button onClick={() => onViewChange("year")} className={`rounded-full px-5 py-2 font-semibold transition ${view === "year" ? "bg-white shadow-sm" : "text-muted hover:text-ink-2"}`}>年</button>
            <button onClick={() => onViewChange("month")} className={`rounded-full px-5 py-2 font-semibold transition ${view === "month" ? "bg-white shadow-sm" : "text-muted hover:text-ink-2"}`}>月</button>
          </div>
          <div className="flex rounded-full bg-bg-gray p-1 text-sm">
            <button onClick={() => onModeChange("收益")} className={`rounded-full px-5 py-2 font-semibold transition ${mode === "收益" ? "bg-white shadow-sm" : "text-muted hover:text-ink-2"}`}>收益</button>
            <button onClick={() => onModeChange("收益率")} className={`rounded-full px-5 py-2 font-semibold transition ${mode === "收益率" ? "bg-white shadow-sm" : "text-muted hover:text-ink-2"}`}>收益率</button>
          </div>
        </div>
      </div>

      {loading && days.every((cell) => !cell || cell.pnl === 0) ? (
        <div className="mt-4 grid grid-cols-7 gap-2" aria-hidden>
          {Array.from({ length: 28 }).map((_, i) => (
            <div key={i} className="h-16 animate-pulse rounded-xl bg-bg-gray" />
          ))}
        </div>
      ) : view === "year" ? (
        <div className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-4">
          {yearSummary.map(({ m, pnl, pct, active }) => (
            <button
              key={m}
              type="button"
              onClick={() => onMonthChange({ y: month.y, m })}
              className={`flex min-h-20 flex-col items-center justify-center rounded-xl border transition ${active ? "border-up bg-up-bg" : "border-edge hover:border-edge-strong"} ${pnl > 0 ? "text-up" : pnl < 0 ? "text-down" : "text-muted"}`}
            >
              <b className="text-sm text-ink">{m}月</b>
              {pnl !== 0 && (
                <span className="mt-2 text-xs font-semibold sm:text-sm">
                  {mode === "收益" ? formatCompact(pnl) : pct != null ? `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%` : "—"}
                </span>
              )}
            </button>
          ))}
        </div>
      ) : (
        <>
          <div className="mt-4 grid grid-cols-7 text-center text-xs font-semibold text-muted">{["日", "一", "二", "三", "四", "五", "六"].map((day) => <span key={day}>{day}</span>)}</div>
          <div className="mt-2 grid grid-cols-7 gap-[3px] sm:mt-3 sm:gap-2">
            {days.map((cell, index) =>
              cell ? (
                <button
                  key={index}
                  type="button"
                  onClick={() => onDayClick(`${month.y}-${String(month.m).padStart(2, "0")}-${String(cell.day).padStart(2, "0")}`)}
                  title="点击查看当日每只股票盈亏"
                  className={`flex min-h-[52px] min-w-0 flex-col items-center justify-center overflow-hidden rounded-lg px-0.5 transition hover:ring-1 hover:ring-edge-strong sm:min-h-20 sm:rounded-xl ${cell.pnl > 0 ? "bg-up-bg text-up" : cell.pnl < 0 ? "bg-down-bg text-down" : "text-muted hover:bg-bg-gray"}`}
                >
                  <b className="text-sm text-ink">{String(cell.day).padStart(2, "0")}</b>
                  {mode === "收益" ? (
                    cell.pnl !== 0 && <><span className="mt-1.5 max-w-full whitespace-nowrap text-[9px] font-semibold leading-none tracking-[-.03em] min-[390px]:text-[10px] sm:hidden">{formatNarrow(cell.pnl)}</span><span className="mt-2 hidden whitespace-nowrap text-sm font-semibold sm:inline">{formatCompact(cell.pnl)}</span></>
                  ) : (
                    cell.pct != null && cell.pnl !== 0 && <><span className="mt-1.5 whitespace-nowrap text-[9px] font-semibold leading-none tracking-[-.03em] min-[390px]:text-[10px] sm:hidden">{cell.pct >= 0 ? "+" : ""}{cell.pct.toFixed(Math.abs(cell.pct) >= 100 ? 0 : Math.abs(cell.pct) >= 10 ? 1 : 2)}%</span><span className="mt-2 hidden whitespace-nowrap text-sm font-semibold sm:inline">{cell.pct >= 0 ? "+" : ""}{cell.pct.toFixed(2)}%</span></>
                  )}
                </button>
              ) : (
                <span key={index} />
              )
            )}
          </div>
        </>
      )}

      {dayDetail && (() => {
        const profitRows = dayDetail.rows.filter((r) => r.pnl > 0);
        const lossRows = dayDetail.rows.filter((r) => r.pnl < 0).slice().sort((a, b) => a.pnl - b.pnl);
        const shownRows = dayDetailMode === "profit" ? profitRows : lossRows;
        const shownTotal = shownRows.reduce((sum, r) => sum + r.pnl, 0);
        return (
          <div className="fixed inset-0 z-[10002] flex items-center justify-center bg-black/50 p-6">
            <div className="flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-card border border-edge bg-white shadow-2xl dark:border-white/10 dark:bg-[#16181d]">
              <div className="flex items-center justify-between border-b border-edge px-5 py-4">
                <div>
                  <h3 className="text-base font-bold">当日盈亏 · {dayDetail.date.replace(/-/g, "/")}</h3>
                  <p className="mt-0.5 text-xs text-muted">{profitRows.length} / {lossRows.length}</p>
                </div>
                <button type="button" onClick={onDayDetailClose} aria-label="关闭" className="grid h-8 w-8 place-items-center rounded-full text-muted transition hover:bg-bg-gray hover:text-ink-2">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-4 w-4"><path d="m6 6 12 12M18 6 6 18" /></svg>
                </button>
              </div>
              <div className="px-5 pt-4">
                <div className="grid grid-cols-2 rounded-full bg-bg-gray p-1">
                  <button onClick={() => setDayDetailMode("profit")} className={`rounded-full py-2.5 font-semibold ${dayDetailMode === "profit" ? "bg-white shadow-sm" : "text-muted"}`}>盈利</button>
                  <button onClick={() => setDayDetailMode("loss")} className={`rounded-full py-2.5 font-semibold ${dayDetailMode === "loss" ? "bg-white shadow-sm" : "text-muted"}`}>亏损</button>
                </div>
              </div>
              <div className="mt-3 flex-1 space-y-2 overflow-y-auto px-2 pb-2">
                {shownRows.length === 0 && <p className="py-10 text-center text-sm text-muted">当日暂无{dayDetailMode === "profit" ? "盈利" : "亏损"}持仓</p>}
                {(() => {
                  const maxRank = Math.max(...shownRows.map((r) => Math.abs(r.pnl)), 1);
                  return shownRows.map((row, index) => (
                    <div key={row.id} className="relative flex min-h-16 items-center overflow-hidden rounded-xl px-4">
                      <div className={`absolute inset-y-0 right-0 rounded-xl ${dayDetailMode === "profit" ? "bg-up-bg" : "bg-down-bg"}`} style={{ width: `${Math.max(20, Math.abs(row.pnl) / maxRank * 100)}%` }} />
                      <span className="relative mr-3 w-6 flex-none text-xs text-muted">{String(index + 1).padStart(2, "0")}</span>
                      <div className="relative flex min-w-0 flex-1 items-center gap-2.5">
                        {(() => {
                          const icon = stockIcons?.[`${row.market.toUpperCase()}:${row.code.toUpperCase()}`];
                          return <span className="relative flex-none">
                            {icon ? <img src={icon} alt="" className="h-7 w-7 rounded-full bg-bg-gray object-cover" /> : <span className="flex h-7 w-7 items-center justify-center rounded-full bg-bg-gray text-[11px] font-bold text-ink-2">{(row.name || row.code).trim().slice(0, 1).toUpperCase()}</span>}
                            <EtfDoubleBadge market={row.market} code={row.code} name={row.name} />
                          </span>;
                        })()}
                        <div className="min-w-0">
                          <p className="truncate text-xs font-semibold">{row.name}</p>
                          <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted">
                            {renderMarketBadge ? renderMarketBadge(row) : <MarketCodeBadge market={row.market} code={row.code} />}
                            <span className="truncate">{row.code}</span>
                          </p>
                        </div>
                      </div>
                      <strong className={`relative text-xs tabular-nums ${row.pnl >= 0 ? "text-up" : "text-down"}`}>{formatAmount(row.pnl)}</strong>
                    </div>
                  ));
                })()}
              </div>
              <div className="flex items-center justify-between border-t border-edge px-5 py-4">
                <span className="text-xs text-muted">{dayDetailMode === "profit" ? "盈利合计" : "亏损合计"}</span>
                <strong className={`text-sm font-bold tabular-nums ${shownTotal >= 0 ? "text-up" : "text-down"}`}>{formatAmount(shownTotal)}</strong>
              </div>
            </div>
          </div>
        );
      })()}
    </section>
  );
}
