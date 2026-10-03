import { marketSessionState } from "./marketSessions";
import { proxyFetch } from "./net";
import { waitForMarketTask } from "./marketDeadline";

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
/**
 * Yahoo 双主机同时不可达时的短期熔断。
 * 线上容器（境外源不通）实测：44 只持仓逐个等 6 秒超时会把一次行情请求拖到 17 秒，
 * 页面长时间停在「计算中」。一旦双主机都失败，60 秒内直接判定不可用，
 * 由腾讯常规盘行情兜底（配合「美股·腾讯兜底」提示），请求耗时回落到 1-2 秒。
 * 只对「连不上 Yahoo」生效；某只标的没有扩展时段成交（数据为空）不会触发熔断。
 */
const YAHOO_DOWN_TTL = 60_000;
let yahooDownUntil = 0;

const cache = new Map<string, { at: number; value: UsExtendedQuote | null }>();
const regularCache = new Map<string, { at: number; value: UsRegularQuote | null }>();

export interface UsRegularQuote {
  price: number;
  previousClose: number;
  change: number;
  changePct: number;
  high: number;
  low: number;
  volume?: number;
  marketCap?: number;
  time: string;
}

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
    regularMarketTime?: number;
    previousClose?: number;
    chartPreviousClose?: number;
    regularMarketDayHigh?: number;
    regularMarketDayLow?: number;
    regularMarketVolume?: number;
    marketCap?: number;
  };
}

interface YahooRaw {
  timestamp?: number[];
  indicators?: { quote?: Array<{ close?: Array<number | null> }> };
  meta?: YahooResult["meta"];
}

const yahooCache = new Map<string, { at: number; value: YahooResult }>();
const yahooPending = new Map<string, Promise<YahooResult>>();

/** Share the same chart between regular and extended fallbacks; hedge a slow primary. */
async function fetchYahoo(code: string): Promise<YahooResult> {
  const cached = yahooCache.get(code);
  if (cached && Date.now() - cached.at < SUCCESS_TTL) return cached.value;
  const pending = yahooPending.get(code);
  if (pending) return pending;
  const task = loadYahoo(code);
  yahooPending.set(code, task);
  try {
    const value = await task;
    yahooCache.set(code, { at: Date.now(), value });
    for (const [key, entry] of yahooCache) if (Date.now() - entry.at >= SUCCESS_TTL) yahooCache.delete(key);
    while (yahooCache.size > 1024) yahooCache.delete(yahooCache.keys().next().value!);
    return value;
  } finally { yahooPending.delete(code); }
}

async function loadYahoo(code: string): Promise<YahooResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("yahoo deadline")), 2_500);
  let serviceFailure = false;
  try {
    const result = await Promise.any(YAHOO_HOSTS.map(async (host, index) => {
      try {
        // Fast primary uses one request. A slow primary no longer delays query2 for 6s.
        if (index) await waitForMarketTask(new Promise<void>(resolve => setTimeout(resolve, 200)), controller.signal);
        controller.signal.throwIfAborted();
        return await waitForMarketTask((async () => {
          const response = await proxyFetch(`https://${host}/v8/finance/chart/${encodeURIComponent(code)}?interval=1m&range=1d&includePrePost=true&events=div%2Csplits`, {
            headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" }, signal: controller.signal
          });
          if (!response.ok) throw new Error(`yahoo ${response.status}`);
          const json = await response.json() as { chart?: { result?: YahooRaw[] } };
          const raw = json.chart?.result?.[0];
          if (!raw) throw new Error("empty yahoo result");
          return { timestamp: Array.isArray(raw.timestamp) ? raw.timestamp : [],
            close: Array.isArray(raw.indicators?.quote?.[0]?.close) ? raw.indicators.quote[0].close : [], meta: raw.meta ?? {} };
        })(), controller.signal);
      } catch (error) {
        // A missing symbol is not a service outage; retain the existing circuit breaker.
        if (!(error instanceof Error && error.message === "empty yahoo result")) serviceFailure = true;
        throw error;
      }
    }));
    yahooDownUntil = 0;
    return result;
  } catch (error) {
    if (serviceFailure) yahooDownUntil = Date.now() + YAHOO_DOWN_TTL;
    throw error;
  } finally { clearTimeout(timeout); controller.abort(); }
}

function extendedQuoteEnabled(): boolean {
  const flag = process.env.STOCKLOG_EXTENDED_QUOTE?.trim().toLowerCase();
  return !(flag === "off" || flag === "0" || flag === "false" || flag === "none");
}

/** 腾讯缺少某只美股时的整行兜底，避免列表已有走势图却没有价格与高低值。 */
export async function fetchUsRegularQuote(codeRaw: string): Promise<UsRegularQuote | null> {
  if (!extendedQuoteEnabled() || Date.now() < yahooDownUntil) return null;
  const code = codeRaw.toUpperCase().replace(/\.(OQ|N|AM|PS|K)$/, "");
  const cached = regularCache.get(code);
  if (cached && Date.now() - cached.at < (cached.value ? SUCCESS_TTL : FAILURE_TTL)) return cached.value;
  try {
    const { meta } = await fetchYahoo(code);
    const price = Number(meta.regularMarketPrice);
    const previousClose = Number(meta.previousClose) || Number(meta.chartPreviousClose);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(previousClose) || previousClose <= 0) throw new Error("empty regular quote");
    const change = price - previousClose;
    // Extended bars cannot timestamp the separate regular-market price.
    const regularTime = Number(meta.regularMarketTime);
    const latestTimestamp = Number.isFinite(regularTime) && regularTime > 0 ? regularTime : null;
    const value: UsRegularQuote = {
      price,
      previousClose,
      change,
      changePct: change / previousClose * 100,
      high: Number(meta.regularMarketDayHigh) || price,
      low: Number(meta.regularMarketDayLow) || price,
      volume: Number(meta.regularMarketVolume) || undefined,
      marketCap: Number(meta.marketCap) || undefined,
      time: latestTimestamp ? new Date(latestTimestamp * 1000).toISOString() : ""
    };
    regularCache.set(code, { at: Date.now(), value });
    return value;
  } catch {
    regularCache.set(code, { at: Date.now(), value: null });
    return null;
  }
}

/** 当前美股扩展时段有效报价。闭市/常规盘返回 null，避免旧盘前价覆盖最新常规价。 */
export async function fetchUsExtendedQuote(codeRaw: string): Promise<UsExtendedQuote | null> {
  if (!extendedQuoteEnabled()) return null;
  const session = marketSessionState("US").session;
  const wanted: UsExtendedSession | "LATEST" | null = session === "pre" ? "PRE" : session === "post" ? "AFTER" : session === "overnight" ? "OVERNIGHT" : session === "closed" ? "LATEST" : null;
  if (!wanted) return null;
  // This chart feed declares pre/post coverage, not an overnight quote stream.
  // Its final 20:00 post-market bar must never become an OVERNIGHT price.
  if (wanted === "OVERNIGHT") return null;
  // 熔断期内不再逐只发起请求（每只最多 2×6 秒），直接交给腾讯兜底。
  if (Date.now() < yahooDownUntil) return null;
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
        : null;
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
