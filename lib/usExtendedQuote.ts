import { marketSessionState } from "./marketSessions";

export type UsExtendedSession = "PRE" | "AFTER" | "OVERNIGHT";

export interface UsExtendedQuote {
  price: number;
  previousClose: number;
  change: number;
  changePct: number;
  date: string;
  time: string;
  session: UsExtendedSession;
}

/** Yahoo 双主机：query1 被限流 / 抽风时自动切 query2（个股页同款数据源，range=1d 已含盘前/盘后分钟）。 */
const YAHOO_HOSTS = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];
const SUCCESS_TTL = 60_000;
const FAILURE_TTL = 20_000;

const cache = new Map<string, { at: number; value: UsExtendedQuote | null }>();

function nyParts(timestamp: number) {
  const values: Record<string, string> = {};
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  }).formatToParts(new Date(timestamp * 1000)).forEach((part) => { values[part.type] = part.value; });
  const hour = Number(values.hour) % 24;
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${String(hour).padStart(2, "0")}:${values.minute}`,
    minute: hour * 60 + Number(values.minute)
  };
}

interface YahooResult {
  timestamp: number[];
  close: Array<number | null>;
  meta: {
    regularMarketPrice?: number;
    previousClose?: number;
    chartPreviousClose?: number;
  };
}

interface YahooRaw {
  timestamp?: number[];
  indicators?: { quote?: Array<{ close?: Array<number | null> }> };
  meta?: YahooResult["meta"];
}

async function fetchYahoo(code: string): Promise<YahooResult> {
  let lastError: unknown = null;
  for (const host of YAHOO_HOSTS) {
    try {
      const response = await fetch(`https://${host}/v8/finance/chart/${encodeURIComponent(code)}?interval=1m&range=1d&includePrePost=true&events=div%2Csplits`, {
        headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
        signal: AbortSignal.timeout(6000)
      });
      if (!response.ok) throw new Error(`yahoo ${response.status}`);
      const json = (await response.json()) as { chart?: { result?: YahooRaw[] } };
      const result = json.chart?.result?.[0];
      if (!result) throw new Error("empty yahoo result");
      return {
        timestamp: Array.isArray(result.timestamp) ? result.timestamp : [],
        close: Array.isArray(result.indicators?.quote?.[0]?.close) ? result.indicators.quote[0].close : [],
        meta: result.meta ?? {}
      };
    } catch (error) {
      lastError = error;
      /* 当前主机失败，切下一个；双主机都失败则交给调用方 */
    }
  }
  throw lastError ?? new Error("yahoo unreachable");
}

/** 当前美股扩展时段有效报价。闭市/常规盘返回 null，避免旧盘前价覆盖最新常规价。 */
export async function fetchUsExtendedQuote(codeRaw: string): Promise<UsExtendedQuote | null> {
  const session = marketSessionState("US").session;
  const wanted: UsExtendedSession | "LATEST" | null = session === "pre" ? "PRE" : session === "post" ? "AFTER" : session === "overnight" ? "OVERNIGHT" : session === "closed" ? "LATEST" : null;
  if (!wanted) return null;
  const code = codeRaw.toUpperCase().replace(/\.(OQ|N|AM|PS|K)$/, "");
  const cacheKey = `${code}:${wanted}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < (cached.value ? SUCCESS_TTL : FAILURE_TTL)) return cached.value;

  try {
    const { timestamp: timestamps, close: closes, meta } = await fetchYahoo(code);
    const currentNyDate = nyParts(Math.floor(Date.now() / 1000)).date;
    let latest: { price: number; date: string; time: string; session: UsExtendedSession } | null = null;
    for (let index = 0; index < timestamps.length; index += 1) {
      const timestamp = timestamps[index];
      const price = Number(closes[index]);
      if (!Number.isFinite(price) || price <= 0) continue;
      const local = nyParts(timestamp);
      const pointSession = local.minute >= 240 && local.minute < 570 ? "PRE"
        : local.minute >= 960 && local.minute < 1200 ? "AFTER"
        : local.minute >= 1200 || local.minute < 240 ? "OVERNIGHT" : null;
      // 1 日窗口内，扩展时段最新价必须属于美东当天，否则无盘前/盘后成交的标的会被旧日期扩展价覆盖。
      if (wanted === "LATEST") {
        if (pointSession) latest = { price, date: local.date, time: local.time, session: pointSession };
      } else if (pointSession === wanted && local.date === currentNyDate) {
        latest = { price, date: local.date, time: local.time, session: wanted };
      }
    }
    // 「当日」口径应始终 = 最新价 − 上一常规交易日收盘（昨日收盘）。
    // 盘后（16:00-20:00）Yahoo regularMarketPrice = 当日常规收盘，若用作基准，
    // change 只剩盘后波动，视觉上当日盈亏被“重置”。因此盘后用 previousClose（昨收）；
    // 盘前 / 常规用 regularMarketPrice（即最近常规收盘，夜盘刚结束时 previousClose 偶尔滞后）。
    const regularPrice = Number(meta.regularMarketPrice);
    const prevCloseEntry = Number(meta.previousClose) || Number(meta.chartPreviousClose);
    const previousClose = wanted === "AFTER"
      ? (prevCloseEntry > 0 ? prevCloseEntry : regularPrice)
      : (regularPrice > 0 ? regularPrice : prevCloseEntry);
    if (!Number.isFinite(previousClose) || previousClose <= 0) throw new Error("empty previous close");

    if (!latest) {
      // 新交易日盘前刚开始、尚无盘前成交：以最近常规收盘价为基准，当日盈亏归零，
      // 避免继续沿用上一交易日的涨跌（此前会整体退回腾讯昨收行情，显示成「昨日盈亏」）。
      if (wanted === "PRE") {
        const value: UsExtendedQuote = {
          price: previousClose,
          previousClose,
          change: 0,
          changePct: 0,
          date: currentNyDate,
          time: nyParts(Math.floor(Date.now() / 1000)).time,
          session: "PRE"
        };
        cache.set(cacheKey, { at: Date.now(), value });
        return value;
      }
      throw new Error("empty extended quote");
    }

    const change = latest.price - previousClose;
    const value: UsExtendedQuote = {
      ...latest, previousClose, change, changePct: change / previousClose * 100, session: latest.session
    };
    cache.set(cacheKey, { at: Date.now(), value });
    return value;
  } catch {
    // 失败短缓存，避免同一批列表不断打穿上游；主行情仍可正常返回。
    cache.set(cacheKey, { at: Date.now(), value: null });
    return null;
  }
}
