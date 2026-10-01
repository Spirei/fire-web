/** Published cash-equity schedules. This module never infers live market status. */
export const MARKET_CALENDAR_SCHEMA_VERSION = 1;
export const MARKET_CALENDAR_VERSION = "2026-10-02.1";
export const MARKET_CALENDAR_VERIFIED_AT = "2026-10-02";
export const MARKET_CALENDAR_YEAR = 2026;
export const CALENDAR_MARKETS = ["CN", "HK", "US"] as const;
export type CalendarMarket = typeof CALENDAR_MARKETS[number];
export type CalendarStatus = "trading" | "weekend" | "holiday" | "half_day" | "unknown";
export interface CalendarSource { id: string; title: string; url: string; publishedAt: string | null; verifiedAt: string }
export interface CalendarDay {
  date: string;
  weekday: number;
  isWeekend: boolean;
  status: CalendarStatus;
  isTradingDay: boolean | null;
  name: string | null;
  reason: "official_schedule" | "unverified_year" | "temporary_uncertainty";
  actualTradingStatus: "unknown";
  close: { continuous: string; auction: { earliest: string; latest: string; appliesTo: "CAS_securities" } | null } | null;
  sourceIds: string[];
}
export interface MarketCalendar {
  schemaVersion: number;
  calendarVersion: string;
  market: CalendarMarket;
  marketName: string;
  timeZone: string;
  year: number;
  coverage: { status: "verified" | "unknown"; from: string; to: string; verifiedYears: number[]; exchanges: string[]; verifiedAt: string | null; basis: "official_annual_schedule"; temporaryClosures: "unknown" };
  sources: CalendarSource[];
  days: CalendarDay[];
}
function source(id: string, title: string, url: string, publishedAt: string | null = null): CalendarSource {
  return { id, title, url, publishedAt, verifiedAt: MARKET_CALENDAR_VERIFIED_AT };
}
const MARKETS = {
  CN: { name: "A 股（沪深）", timeZone: "Asia/Shanghai", exchanges: ["SSE", "SZSE"], sources: [
    source("sse-2026", "上交所 2026 年休市安排", "https://www.sse.com.cn/disclosure/dealinstruc/closed/"),
    source("szse-2026", "深交所 2026 年部分节假日休市安排", "https://www.szse.cn/disclosure/notice/general/t20251222_618087.html", "2025-12-22")
  ] },
  HK: { name: "港股", timeZone: "Asia/Hong_Kong", exchanges: ["SEHK"], sources: [
    source("hkex-2026", "HKEX 2026 年证券市场假期安排", "https://www.hkex.com.hk/-/media/HKEX-Market/Services/Circulars-and-Notices/Participant-and-Members-Circulars/SEHK/2025/ce_SEHK_CT_075_2025.pdf", "2025-06-02"),
    source("hkex-hours", "HKEX 证券市场交易时段", "https://www.hkex.com.hk/Services/Trading-hours-and-Severe-Weather-Arrangements/Trading-Hours/Securities-Market")
  ] },
  US: { name: "美股", timeZone: "America/New_York", exchanges: ["NYSE", "NASDAQ"], sources: [
    source("nyse-2026", "NYSE 假期及交易时段", "https://www.nyse.com/trade/hours-calendars"),
    source("nasdaq-2026", "Nasdaq 2026 年交易假期", "https://www.nasdaq.com/market-activity/stock-market-holiday-schedule")
  ] }
} as const;
// Inclusive local date ranges from the exchanges, not civil workday calendars.
const HOLIDAYS: Record<CalendarMarket, readonly [string, string, string][]> = {
  CN: [["01-01", "01-03", "元旦"], ["02-15", "02-23", "春节"], ["04-04", "04-06", "清明节"], ["05-01", "05-05", "劳动节"], ["06-19", "06-21", "端午节"], ["09-25", "09-27", "中秋节"], ["10-01", "10-07", "国庆节"]],
  HK: [["01-01", "01-01", "元旦"], ["02-17", "02-19", "农历新年"], ["04-03", "04-03", "耶稣受难节"], ["04-06", "04-06", "清明节翌日"], ["04-07", "04-07", "复活节星期一翌日"], ["05-01", "05-01", "劳动节"], ["05-25", "05-25", "佛诞翌日"], ["06-19", "06-19", "端午节"], ["07-01", "07-01", "香港特别行政区成立纪念日"], ["10-01", "10-01", "国庆日"], ["10-19", "10-19", "重阳节翌日"], ["12-25", "12-25", "圣诞节"]],
  US: [["01-01", "01-01", "元旦"], ["01-19", "01-19", "马丁·路德·金纪念日"], ["02-16", "02-16", "华盛顿诞辰日"], ["04-03", "04-03", "耶稣受难日"], ["05-25", "05-25", "阵亡将士纪念日"], ["06-19", "06-19", "六月节"], ["07-03", "07-03", "独立日补休"], ["09-07", "09-07", "劳动节"], ["11-26", "11-26", "感恩节"], ["12-25", "12-25", "圣诞节"]]
};
const HALF_DAYS: Record<CalendarMarket, Readonly<Record<string, string>>> = {
  CN: {}, HK: { "02-16": "农历新年前夕", "12-24": "圣诞节前夕", "12-31": "新年前夕" },
  US: { "11-27": "感恩节翌日", "12-24": "圣诞节前夕" }
};
/** Add an officially reported uncertain date here; it overrides annual schedules. */
const UNCERTAIN_DATES: Partial<Record<CalendarMarket, Readonly<Record<string, string>>>> = {};

export function isCalendarMarket(value: string): value is CalendarMarket {
  return (CALENDAR_MARKETS as readonly string[]).includes(value);
}
export function buildMarketCalendar(market: CalendarMarket, year: number, uncertainDates: Readonly<Record<string, string>> = UNCERTAIN_DATES[market] || {}): MarketCalendar {
  if (!isCalendarMarket(market) || !Number.isSafeInteger(year) || year < 2000 || year > 2100) throw new RangeError("Invalid market calendar query");
  const config = MARKETS[market], verified = year === MARKET_CALENDAR_YEAR;
  const days: CalendarDay[] = [];
  for (let at = Date.UTC(year, 0, 1); at < Date.UTC(year + 1, 0, 1); at += 86400_000) {
    const day = new Date(at), date = day.toISOString().slice(0, 10), monthDay = date.slice(5), weekday = day.getUTCDay();
    const isWeekend = weekday === 0 || weekday === 6;
    const holiday = verified ? HOLIDAYS[market].find(([start, end]) => monthDay >= start && monthDay <= end)?.[2] : undefined;
    const halfDay = verified && !isWeekend ? HALF_DAYS[market][monthDay] : undefined;
    const uncertain = uncertainDates[date];
    const status: CalendarStatus = !verified || uncertain ? "unknown" : holiday ? "holiday" : isWeekend ? "weekend" : halfDay ? "half_day" : "trading";
    days.push({ date, weekday, isWeekend, status, isTradingDay: status === "unknown" ? null : status === "trading" || status === "half_day",
      name: uncertain || holiday || halfDay || null, reason: uncertain ? "temporary_uncertainty" : verified ? "official_schedule" : "unverified_year",
      actualTradingStatus: "unknown", close: status === "half_day" ? { continuous: market === "US" ? "13:00" : "12:00", auction: market === "HK" ? { earliest: "12:08", latest: "12:10", appliesTo: "CAS_securities" } : null } : null,
      sourceIds: verified ? config.sources.map(item => item.id) : [] });
  }
  return { schemaVersion: MARKET_CALENDAR_SCHEMA_VERSION, calendarVersion: MARKET_CALENDAR_VERSION, market, marketName: config.name, timeZone: config.timeZone, year,
    coverage: { status: verified ? "verified" : "unknown", from: `${year}-01-01`, to: `${year}-12-31`, verifiedYears: [MARKET_CALENDAR_YEAR], exchanges: [...config.exchanges], verifiedAt: verified ? MARKET_CALENDAR_VERIFIED_AT : null, basis: "official_annual_schedule", temporaryClosures: "unknown" },
    sources: verified ? config.sources.map(item => ({ ...item })) : [], days };
}
export function marketCalendarDiscovery() {
  return { path: "/api/v2/market-calendar", api_version: 2, access: "public", schema_version: MARKET_CALENDAR_SCHEMA_VERSION, calendar_version: MARKET_CALENDAR_VERSION,
    markets: CALENDAR_MARKETS.map(market => ({ market, name: MARKETS[market].name, time_zone: MARKETS[market].timeZone, exchanges: [...MARKETS[market].exchanges], verified_years: [MARKET_CALENDAR_YEAR] })), temporary_closures: "unknown" };
}
