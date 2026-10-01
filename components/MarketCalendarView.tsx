"use client";
import { useMemo } from "react";
import AppSelect from "@/components/AppSelect";
import MarketIcon from "@/components/MarketIcon";
import { useWorkspaceSearchParams, useWorkspaceLocationGuard } from "@/lib/workspacePanel";
import { buildMarketCalendar, isCalendarMarket, MARKET_CALENDAR_YEAR, type CalendarMarket, type CalendarDay, type CalendarStatus } from "@/lib/marketCalendar";

const LABELS: Record<CalendarStatus, string> = { trading: "交易日", weekend: "周末休市", holiday: "节假日休市", half_day: "半日市", unknown: "未确认" };
const MARKET_ORDER: CalendarMarket[] = ["US", "HK", "CN"];
const MARKET_NAMES = { CN: "A 股（沪深）", HK: "港股", US: "美股" };
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
  const requestedYear = Number(params.get("calYear"));
  const year = Number.isSafeInteger(requestedYear) && requestedYear >= 2000 && requestedYear <= 2100 ? requestedYear : currentYear;
  const requestedMarket = params.get("market");
  const market: CalendarMarket = isCalendarMarket(requestedMarket || "") ? requestedMarket as CalendarMarket : "US";
  const requestedStatus = params.get("calStatus");
  const status = requestedStatus === "half_day" || requestedStatus === "unknown" ? requestedStatus : "all";
  const selectedDate = params.get("calDay");
  const requestedMonth = Number(params.get("calMonth"));
  const selectedMonth = selectedDate?.startsWith(`${year}-`) ? Number(selectedDate.slice(5, 7)) : 0;
  const month = Number.isInteger(requestedMonth) && requestedMonth >= 1 && requestedMonth <= 12 ? requestedMonth
    : selectedMonth >= 1 && selectedMonth <= 12 ? selectedMonth : Number(clockValue("month"));
  const calendar = useMemo(() => buildMarketCalendar(market, year), [market, year]);
  const monthDays = useMemo(() => calendar.days.filter(day => Number(day.date.slice(5, 7)) === month), [calendar, month]);
  const matches = (day: CalendarDay) => status === "all" || day.status === status;
  const selected = monthDays.find(day => day.date === selectedDate && matches(day));
  const matchingDays = monthDays.filter(matches);
  const leading = ((monthDays[0]?.weekday || 0) + 6) % 7;
  const verified = calendar.coverage.status === "verified";
  const sources = calendar.sources;
  const update = (patch: Record<string, string>) => {
    if (!canWrite()) return;
    const url = new URL(window.location.href);
    url.searchParams.set("section", "calendar");
    url.searchParams.set("market", market);
    url.searchParams.set("calYear", String(year));
    url.searchParams.set("calMonth", String(month));
    for (const [key, value] of Object.entries(patch)) value ? url.searchParams.set(key, value) : url.searchParams.delete(key);
    window.history.replaceState(null, "", url.pathname + "?" + url.searchParams.toString());
  };
  const moveMonth = (delta: number) => {
    const next = new Date(Date.UTC(year, month - 1 + delta, 1));
    if (next.getUTCFullYear() < 2000 || next.getUTCFullYear() > 2100) return;
    update({ calYear: String(next.getUTCFullYear()), calMonth: String(next.getUTCMonth() + 1), calDay: "" });
  };
  return <section className="market-calendar" aria-label="休市日历">
    <header className="mc-header">
      <div><h2 className="mc-title">休市日历</h2><p className="text-xs text-muted">{MARKET_NAMES[market]} · 按交易所当地日期显示（{calendar.timeZone}）</p></div>
      <AppSelect ariaLabel="日历年份" value={year < currentYear ? `${year} 年` : String(year)} options={Array.from({ length: 2100 - currentYear + 1 }, (_, i) => ({ value: String(currentYear + i), label: `${currentYear + i} 年${currentYear + i === MARKET_CALENDAR_YEAR ? " · 已核实" : ""}` }))} onChange={value => update({ calYear: value, calDay: "" })} />
    </header>
    <div className="mc-legend">
      <div className="mc-market-filters" role="group" aria-label="日历市场">{MARKET_ORDER.map(option => <button type="button" key={option} aria-pressed={market === option} onClick={() => update({ market: option, calDay: "" })}><MarketIcon market={option} size={16} />{MARKET_NAMES[option]}</button>)}</div>
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
            const description = `${day.date}；${MARKET_NAMES[market]}：${dayDescription(day)}`;
            const marked = day.status === "holiday" || day.status === "weekend" || day.status === "half_day";
            const closed = day.status === "holiday" || day.status === "weekend";
            const visible = matches(day);
            return <button type="button" key={day.date} title={description} aria-label={description} aria-pressed={selectedDate === day.date} aria-current={today === day.date ? "date" : undefined} disabled={!visible} className={`mc-day${!visible ? " is-filtered" : ""}${day.isWeekend ? " is-weekend" : ""}${selectedDate === day.date ? " is-selected" : ""}`} onClick={() => update({ calDay: selectedDate === day.date ? "" : day.date })}>
              <span className="mc-number">{Number(day.date.slice(8))}</span>
              {visible && closed && <svg className="mc-closure-watermark" viewBox="0 0 120 50" aria-hidden="true"><text x="60" y="27" textAnchor="middle" dominantBaseline="middle" fill="none" stroke="currentColor" strokeWidth="0.8" strokeDasharray="1.8 1.6" fontSize="34" fontWeight="700">休市</text></svg>}
              <span className="mc-market-marks">{visible && marked && <span className={`mc-market-mark${day.status === "half_day" ? " is-half" : ""}`} aria-hidden="true"><MarketIcon market={market} size={18} />{day.status === "half_day" && <i className="mc-half-dot" />}</span>}{visible && day.status === "unknown" && <span className="mc-unknown-key" aria-hidden="true" />}</span>
              {visible && day.name && <span className="mc-holiday-name" aria-hidden="true">{day.name}</span>}
            </button>;
          })}
          {Array.from({ length: 42 - leading - monthDays.length }, (_, i) => <span className="mc-blank" aria-hidden="true" key={`end-${i}`} />)}
        </div>
      </div>
    </section>
    {selected && <section className="mc-selected" aria-label="当日市场安排"><h3>{selected.date}</h3><p><MarketIcon market={market} size={17} /><b>{MARKET_NAMES[market]}</b><span>{dayDescription(selected)}{selected.close ? `（${calendar.timeZone}）` : ""}</span></p></section>}
    <p className="mc-note text-xs text-muted">当前仅显示{MARKET_NAMES[market]}。图标及背景字标记全天休市，金色圆点表示半日市，紫色圆点表示未确认。点击市场切换，点击状态筛选，再次点击取消筛选；点击日期查看该市场安排。年度计划不代表此刻正在交易，临时停市状态未确认。</p>
    <footer className="mc-sources"><details><summary>官方安排与来源</summary>{verified ? <><p>已核实 {year} 年 · 核对于 {calendar.coverage.verifiedAt}</p><div className="mc-market-summary"><p><MarketIcon market={market} size={16} />{MARKET_NAMES[market]} · {calendar.coverage.exchanges.join(" / ")} · {calendar.timeZone} · 计划交易 {calendar.days.filter(day => day.isTradingDay === true).length} 天，半日市 {calendar.days.filter(day => day.status === "half_day").length} 天</p></div><ul>{sources.map(source => <li key={source.id}><a href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a>{source.publishedAt && <span> · 发布于 {source.publishedAt}</span>}</li>)}</ul></> : <p>所选年份尚未收录已核实的官方安排。</p>}<p>仅覆盖所列交易所的现货股票常规交易，不包含盘前、盘后、期权及个股停牌。</p><p>数据版本 {calendar.calendarVersion} · <a href="/api-docs?version=v2" target="_blank" rel="noopener noreferrer">API v2 文档</a></p></details></footer>
  </section>;
}
