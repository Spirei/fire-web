"use client";
import { useMemo, type CSSProperties } from "react";
import AppSelect from "@/components/AppSelect";
import MarketIcon from "@/components/MarketIcon";
import { useWorkspaceSearchParams, useWorkspaceLocationGuard } from "@/lib/workspacePanel";
import { buildMarketCalendar, isCalendarMarket, MARKET_CALENDAR_YEAR, type CalendarMarket, type CalendarDay, type CalendarStatus } from "@/lib/marketCalendar";

const LABELS: Record<CalendarStatus, string> = { trading: "交易日", weekend: "周末休市", holiday: "节假日休市", half_day: "半日市", unknown: "未确认" };
const MARKET_ORDER: CalendarMarket[] = ["US", "HK", "CN"];
type ViewMarket = CalendarMarket | "ALL";
type ViewDay = CalendarDay & { markets: { market: CalendarMarket; day: CalendarDay }[] };
const MARKET_NAMES = { ALL: "全部市场", CN: "A 股（沪深）", HK: "港股", US: "美股" };
type DayTone = "neutral" | "holiday" | "half_day" | "unknown" | "mixed";
/** Normal weekends stay neutral; only special schedules contribute a color panel. */
export function calendarDayAppearance(states: readonly CalendarStatus[]): { tone: DayTone; fill?: string } {
  const panels = (["holiday", "half_day", "unknown"] as const)
    .map(tone => ({ tone, count: states.filter(status => status === tone).length }))
    .filter(panel => panel.count > 0);
  if (panels.length === 0) return { tone: "neutral" };
  if (panels.length === 1) return { tone: panels[0].tone };
  const total = panels.reduce((sum, panel) => sum + panel.count, 0);
  let offset = 0;
  const stops = panels.flatMap(panel => {
    const from = Math.round(offset / total * 10000) / 100;
    offset += panel.count;
    const to = Math.round(offset / total * 10000) / 100;
    return [`var(--mc-fill-${panel.tone}) ${from}%`, `var(--mc-fill-${panel.tone}) ${to}%`];
  });
  return { tone: "mixed", fill: `linear-gradient(135deg, ${stops.join(", ")})` };
}
function dayDescription(day: CalendarDay) {
  const close = day.close ? ` · 连续交易至 ${day.close.continuous}${day.close.auction ? `，收市竞价 ${day.close.auction.earliest}–${day.close.auction.latest} 随机结束（适用证券）` : ""}` : "";
  return `${LABELS[day.status]}${day.name ? ` · ${day.name}` : ""}${close}`;
}
export default function MarketCalendarView({ initialNow = Date.UTC(MARKET_CALENDAR_YEAR, 0, 1) }: { initialNow?: number }) {
  const params = useWorkspaceSearchParams(), canWrite = useWorkspaceLocationGuard();
  const clock = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(initialNow);
  const clockValue = (part: string) => clock.find(item => item.type === part)?.value || "";
  const today = `${clockValue("year")}-${clockValue("month")}-${clockValue("day")}`;
  const currentYear = Number(clockValue("year"));
  // Compact month/day parameters are canonical; existing calendar links stay readable.
  const monthParam = params.get("month") || "";
  const compactMonth = /^(20\d{2}|2100)-(0[1-9]|1[0-2])$/.test(monthParam) ? monthParam : "";
  const requestedYear = Number(compactMonth ? compactMonth.slice(0, 4) : params.get("calYear"));
  const year = Number.isSafeInteger(requestedYear) && requestedYear >= 2000 && requestedYear <= 2100 ? requestedYear : currentYear;
  const requestedMarket = params.get("market");
  const market: ViewMarket = requestedMarket === "ALL" ? "ALL" : isCalendarMarket(requestedMarket || "") ? requestedMarket as CalendarMarket : "US";
  const requestedStatus = params.get("status") ?? params.get("calStatus");
  const status = requestedStatus === "half_day" || requestedStatus === "unknown" ? requestedStatus : "all";
  const legacyDay = params.get("calDay");
  const requestedMonth = Number(compactMonth ? compactMonth.slice(5) : params.get("calMonth"));
  const selectedMonth = legacyDay?.startsWith(`${year}-`) ? Number(legacyDay.slice(5, 7)) : 0;
  const month = Number.isInteger(requestedMonth) && requestedMonth >= 1 && requestedMonth <= 12 ? requestedMonth
    : selectedMonth >= 1 && selectedMonth <= 12 ? selectedMonth : Number(clockValue("month"));
  const monthKey = `${year}-${String(month).padStart(2, "0")}`;
  const compactDay = params.get("day") || "";
  const selectedDate = /^([1-9]|[12]\d|3[01])$/.test(compactDay) ? `${monthKey}-${compactDay.padStart(2, "0")}` : legacyDay;
  const calendars = useMemo(() => (market === "ALL" ? MARKET_ORDER : [market]).map(item => buildMarketCalendar(item, year)), [market, year]);
  const calendar = calendars[0];
  const monthDays = useMemo(() => calendar.days.map((day, index) => ({ ...day, markets: calendars.map(item => ({ market: item.market, day: item.days[index] })) })).filter(day => Number(day.date.slice(5, 7)) === month), [calendars, calendar, month]);
  const matches = (day: ViewDay) => status === "all" || day.markets.some(item => item.day.status === status);
  const selected = monthDays.find(day => day.date === selectedDate && matches(day));
  const matchingDays = monthDays.filter(matches);
  const leading = ((monthDays[0]?.weekday || 0) + 6) % 7;
  const verified = calendars.every(item => item.coverage.status === "verified");
  const sources = calendars.flatMap(item => item.sources);
  const update = (patch: Record<string, string>) => {
    if (!canWrite()) return;
    const url = new URL(window.location.href);
    const nextYear = patch.calYear ?? String(year), nextMonth = patch.calMonth ?? String(month);
    const nextMonthKey = `${nextYear}-${nextMonth.padStart(2, "0")}`;
    const nextStatus = patch.calStatus ?? (status === "all" ? "" : status);
    const nextDay = patch.calDay ?? selectedDate ?? "";
    for (const key of ["calYear", "calMonth", "calDay", "calStatus", "month", "day", "status"]) url.searchParams.delete(key);
    url.searchParams.set("section", "calendar");
    url.searchParams.set("market", patch.market ?? market);
    url.searchParams.set("month", nextMonthKey);
    if (nextStatus) url.searchParams.set("status", nextStatus);
    if (nextDay.startsWith(nextMonthKey + "-")) url.searchParams.set("day", String(Number(nextDay.slice(8))));
    window.history.replaceState(null, "", url.pathname + "?" + url.searchParams.toString());
  };
  const moveMonth = (delta: number) => {
    const next = new Date(Date.UTC(year, month - 1 + delta, 1));
    if (next.getUTCFullYear() < 2000 || next.getUTCFullYear() > 2100) return;
    update({ calYear: String(next.getUTCFullYear()), calMonth: String(next.getUTCMonth() + 1), calDay: "" });
  };
  return <section className="market-calendar" aria-label="休市日历">
    <header className="mc-header">
      <div><h2 className="mc-title">休市日历</h2><p className="text-xs text-muted">{MARKET_NAMES[market]} · 按各交易所当地日期显示{market !== "ALL" ? `（${calendar.timeZone}）` : ""}</p></div>
      <AppSelect ariaLabel="日历年份" value={year < currentYear ? `${year} 年` : String(year)} options={Array.from({ length: 2100 - currentYear + 1 }, (_, i) => ({ value: String(currentYear + i), label: `${currentYear + i} 年${currentYear + i === MARKET_CALENDAR_YEAR ? " · 已核实" : ""}` }))} onChange={value => update({ calYear: value, calDay: "" })} />
    </header>
    <div className="mc-legend">
      <div className="mc-market-filters" role="group" aria-label="日历市场"><button type="button" aria-pressed={market === "ALL"} onClick={() => update({ market: "ALL", calDay: "" })}>全部</button>{MARKET_ORDER.map(option => <button type="button" key={option} aria-pressed={market === option} onClick={() => update({ market: option, calDay: "" })}><MarketIcon market={option} size={16} />{MARKET_NAMES[option]}</button>)}</div>
      <span className="mc-holiday-legend"><i className="mc-holiday-key" aria-hidden="true" />全天休市</span>
      <div className="mc-status-filters" role="group" aria-label="日历状态筛选">{(["half_day", "unknown"] as const).map(option => <button type="button" key={option} aria-pressed={status === option} onClick={() => update({ calStatus: status === option ? "" : option, calDay: "" })}><i className={option === "half_day" ? "mc-half-key" : "mc-unknown-key"} aria-hidden="true" />{LABELS[option]}</button>)}</div>
    </div>
    {status !== "all" && <p className="mc-filter-result text-xs text-muted" role="status">{MARKET_NAMES[market]} · {year} 年 {month} 月{LABELS[status]} {matchingDays.length} 天{matchingDays.length === 0 ? "，可切换月份或再次点击筛选取消" : "，再次点击筛选可查看全部日期"}</p>}
    {!verified && <div className="mc-coverage is-unknown" role="status"><strong>{year} 年安排未确认</strong><span>当前已核实 {MARKET_CALENDAR_YEAR} 年。该年份全部日期保持未知，不能据工作日判定开市。</span></div>}
    <section className="mc-month card" aria-label={`${year} 年 ${month} 月`}>
      <div className="mc-toolbar">
        <div className="mc-month-nav">
          <button type="button" aria-label="上个月" disabled={year === 2000 && month === 1} onClick={() => moveMonth(-1)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m15 18-6-6 6-6" /></svg></button>
          <h3>{year} 年 {month} 月</h3>
          <button type="button" aria-label="下个月" disabled={year === 2100 && month === 12} onClick={() => moveMonth(1)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m9 18 6-6-6-6" /></svg></button>
        </div>
        <button type="button" className="mc-today" onClick={() => update({ calYear: clockValue("year"), calMonth: String(Number(clockValue("month"))), calDay: "" })}>回到本月</button>
      </div>
      <div className="mc-grid">
        <div className="mc-weekdays" aria-hidden="true">{["周一", "周二", "周三", "周四", "周五", "周六", "周日"].map(day => <span key={day}>{day}</span>)}</div>
        <div className="mc-days">
          {Array.from({ length: leading }, (_, i) => <span className="mc-blank" aria-hidden="true" key={`pad-${i}`} />)}
          {monthDays.map(day => {
            const description = `${day.date}；${day.markets.map(item => `${MARKET_NAMES[item.market]}：${dayDescription(item.day)}`).join("；")}`;
            const items = day.markets.filter(item => status === "all" || item.day.status === status);
            const marked = items.filter(item => item.day.status === "holiday" || item.day.status === "weekend" || item.day.status === "half_day");
            const closed = marked.some(item => item.day.status === "holiday" || item.day.status === "weekend");
            const names = [...new Set(items.map(item => item.day.name).filter(Boolean))];
            const visible = matches(day);
            const appearance = calendarDayAppearance(visible ? items.map(item => item.day.status) : []);
            return <button type="button" key={day.date} title={description} aria-label={description} aria-pressed={selectedDate === day.date} aria-current={today === day.date ? "date" : undefined} disabled={!visible} data-tone={appearance.tone} style={appearance.fill ? { "--mc-status-fill": appearance.fill } as CSSProperties : undefined} className={`mc-day${!visible ? " is-filtered" : ""}${day.isWeekend ? " is-weekend" : ""}${selectedDate === day.date ? " is-selected" : ""}`} onClick={() => update({ calDay: selectedDate === day.date ? "" : day.date })}>
              <span className="mc-number">{Number(day.date.slice(8))}</span>
              {visible && closed && <svg className="mc-closure-watermark" viewBox="0 0 100 60" aria-hidden="true"><text x="50" y="31" textAnchor="middle" dominantBaseline="middle" fill="none" stroke="currentColor" strokeWidth="0.9" strokeDasharray="1.5 1.35" fontSize="48" fontWeight="700">休市</text></svg>}
              <span className="mc-market-marks">{visible && marked.map(item => <span key={item.market} className={`mc-market-mark${item.day.status === "half_day" ? " is-half" : ""}`} aria-hidden="true"><MarketIcon market={item.market} size={18} />{item.day.status === "half_day" && <i className="mc-half-dot" />}</span>)}{visible && items.some(item => item.day.status === "unknown") && <span className="mc-unknown-key" aria-hidden="true" />}</span>
              {visible && names.length > 0 && <span className="mc-holiday-name" aria-hidden="true">{names.join(" · ")}</span>}
            </button>;
          })}
          {Array.from({ length: 42 - leading - monthDays.length }, (_, i) => <span className="mc-blank" aria-hidden="true" key={`end-${i}`} />)}
        </div>
      </div>
    </section>
    {selected && <section className="mc-selected" aria-label="当日市场安排"><h3>{selected.date}</h3><div>{selected.markets.map(item => <p key={item.market}><MarketIcon market={item.market} size={17} /><b>{MARKET_NAMES[item.market]}</b><span>{dayDescription(item.day)}{item.day.close ? `（${calendars.find(calendar => calendar.market === item.market)?.timeZone}）` : ""}</span></p>)}</div></section>}
    <p className="mc-note text-xs text-muted">{market === "ALL" ? "当前汇总美股、港股与 A 股安排，同一天按市场分别标记。" : `当前仅显示${MARKET_NAMES[market]}。`}粉色标记节假日全天休市，金色标记半日市，紫色标记未确认；不同市场安排拼色显示，普通周末保持中性背景。市场图标及休市背景字保留，圆点分别标记半日市和未确认。点击市场切换，点击状态筛选，再次点击取消筛选；点击日期查看当前市场安排。年度计划不代表此刻正在交易，临时停市状态未确认。</p>
    <footer className="mc-sources"><details><summary>官方安排与来源</summary>{verified ? <><p>已核实 {year} 年 · 核对于 {calendar.coverage.verifiedAt}</p><div className="mc-market-summary">{calendars.map(item => <p key={item.market}><MarketIcon market={item.market} size={16} />{MARKET_NAMES[item.market]} · {item.coverage.exchanges.join(" / ")} · {item.timeZone} · 计划交易 {item.days.filter(day => day.isTradingDay === true).length} 天，半日市 {item.days.filter(day => day.status === "half_day").length} 天</p>)}</div><ul>{sources.map(source => <li key={source.id}><a href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a>{source.publishedAt && <span> · 发布于 {source.publishedAt}</span>}</li>)}</ul></> : <p>所选年份尚未收录已核实的官方安排。</p>}<p>仅覆盖所列交易所的现货股票常规交易，不包含盘前、盘后、期权及个股停牌。</p><p>数据版本 {calendar.calendarVersion} · <a href="/api-docs?version=v2" target="_blank" rel="noopener noreferrer">API v2 文档</a></p></details></footer>
  </section>;
}
