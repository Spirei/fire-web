export type MarketSession = "pre" | "regular" | "lunch" | "post" | "overnight" | "closed";

export interface MarketSessionState {
  market: string;
  session: MarketSession;
  active: boolean;
  label: string;
  localDate: string;
  /** 当日盈亏是否已到本市场结算点；美股为美东 20:00。 */
  pnlSettled: boolean;
  settlementLabel: string;
  settlementDate: string;
}

function localParts(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value || "";
  return {
    weekday: get("weekday"),
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minute: Number(get("hour")) * 60 + Number(get("minute"))
  };
}

function previousWeekday(date: string) {
  const value = new Date(`${date}T12:00:00Z`);
  do value.setUTCDate(value.getUTCDate() - 1);
  while (value.getUTCDay() === 0 || value.getUTCDay() === 6);
  return value.toISOString().slice(0, 10);
}

/** 按交易所当地时间判断是否需要实时行情；节假日由行情源的最后交易时间兜底。 */
export function marketSessionState(market: string, now = new Date()): MarketSessionState {
  const key = market.toUpperCase();
  const timeZone =
    key === "US" ? "America/New_York"
      : key === "JP" ? "Asia/Tokyo"
        : key === "KR" ? "Asia/Seoul"
          : "Asia/Shanghai";
  const p = localParts(now, timeZone);
  const weekday = p.weekday !== "Sat" && p.weekday !== "Sun";
  let session: MarketSession = "closed";
  let label = "休市";
  if (weekday && key === "US") {
    if (p.minute >= 240 && p.minute < 570) { session = "pre"; label = "盘前"; }
    else if (p.minute >= 570 && p.minute < 960) { session = "regular"; label = "交易中"; }
    else if (p.minute >= 960 && p.minute < 1200) { session = "post"; label = "盘后"; }
    else if (p.minute >= 1200 || p.minute < 240) { session = "overnight"; label = "夜盘"; }
  } else if (weekday && (key === "HK" || key === "CN")) {
    const morningEnd = key === "HK" ? 720 : 690;
    const afternoonEnd = key === "HK" ? 960 : 900;
    if (p.minute >= 570 && p.minute < morningEnd) { session = "regular"; label = "交易中"; }
    else if (p.minute >= morningEnd && p.minute < 780) { session = "lunch"; label = "午间休市"; }
    else if (p.minute >= 780 && p.minute < afternoonEnd) { session = "regular"; label = "交易中"; }
  } else if (weekday && key === "JP") {
    // 东京：09:00-11:30 / 12:30-15:00（当地时间）
    if (p.minute >= 540 && p.minute < 690) { session = "regular"; label = "交易中"; }
    else if (p.minute >= 690 && p.minute < 750) { session = "lunch"; label = "午间休市"; }
    else if (p.minute >= 750 && p.minute < 900) { session = "regular"; label = "交易中"; }
  } else if (weekday && key === "KR") {
    // 首尔：09:00-15:30（连续交易，无午休）
    if (p.minute >= 540 && p.minute < 930) { session = "regular"; label = "交易中"; }
  }
  const settlementMinute = key === "US" ? 1200 : key === "HK" ? 960 : key === "JP" ? 900 : key === "KR" ? 930 : 900;
  const nextSessionMinute = key === "US" ? 240 : key === "JP" || key === "KR" ? 540 : 570;
  // 结算状态跨过当地午夜保持到下一交易时段开始；周末保持最近交易日最终值。
  // 美股 20:00 为交易日分界：夜盘（20:00-04:00）属于新一天，当日盈亏 = 夜盘波动，
  // 只有周末才算已结算；港股/A股维持 收盘后结算到下一交易时段开始 的旧口径。
  const pnlSettled =
    key === "US" ? !weekday : !weekday || p.minute >= settlementMinute || p.minute < nextSessionMinute;
  const settlementDate = weekday && p.minute >= settlementMinute ? p.date : previousWeekday(p.date);
  return {
    market: key,
    session,
    active: session === "pre" || session === "regular" || session === "post" || session === "overnight",
    label: pnlSettled ? "已结算" : label,
    localDate: p.date,
    pnlSettled,
    settlementLabel:
      key === "US" ? "美东 20:00"
        : key === "HK" ? "港股 16:00"
          : key === "JP" ? "日股 15:00"
            : key === "KR" ? "韩股 15:30"
              : "A股 15:00",
    settlementDate
  };
}

export function activeQuoteMarkets(markets: string[], now = new Date()) {
  return new Set(markets.filter((market) => marketSessionState(market, now).active));
}

/** 卡片用的三态：开盘中 / 未开盘 / 休市（休市一般只出现在周末）。 */
export function marketBoardLabel(market: string, now = new Date()): "开盘中" | "未开盘" | "休市" {
  const key = market.toUpperCase();
  const timeZone =
    key === "US" ? "America/New_York"
      : key === "JP" ? "Asia/Tokyo"
        : key === "KR" ? "Asia/Seoul"
          : "Asia/Shanghai";
  const weekday = localParts(now, timeZone).weekday;
  if (weekday === "Sat" || weekday === "Sun") return "休市";
  return marketSessionState(market, now).session === "regular" ? "开盘中" : "未开盘";
}
