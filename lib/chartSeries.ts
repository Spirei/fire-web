import { waitForMarketTask } from "./marketDeadline";
import { fetchFutuMinuteSeries } from "./futuQuotes";
import { proxyFetch } from "./net";
import { readLimitedResponseJson } from "./requestBody";
import { normalizeMarketCode } from "./marketCode";
import { getSiteSettings } from "./settings";

export const CHART_SERIES_MARKETS = ["US", "HK", "CN", "JP", "KR"];
export interface ChartSeriesPoint { date: string; time: string; price: number }
export interface ChartSeries { market: string; code: string; days: number; source: string; coverage: { overnight: boolean }; points: ChartSeriesPoint[] }
const zones: Record<string, string> = { US: "America/New_York", HK: "Asia/Hong_Kong", CN: "Asia/Shanghai", JP: "Asia/Tokyo", KR: "Asia/Seoul" };
export function chartSeriesSymbols(market: string, rawCode: string): string[] {
  const code = normalizeMarketCode(market, rawCode);
  switch (market) {
    case "US": return [code.replace(/\./g, "-")];
    case "HK": return [/^\d+$/.test(code) ? `${String(Number(code)).padStart(4, "0")}.HK` : code];
    case "CN": return /^(4|8|920)/.test(code) ? [] : [code + (/^[69]/.test(code) ? ".SS" : ".SZ")];
    case "JP": return [code + ".T"];
    case "KR": return [code + ".KS", code + ".KQ"];
    default: return [];
  }
}

/** Only actual timestamped observations; no calendar-day padding or previous-close interpolation. */
export function parseChartSeries(raw: any, market: string, code: string, symbol: string, days: number, now = Date.now()): ChartSeries {
  const result = raw?.chart?.result?.[0];
  if (![1, 5].includes(days) || !zones[market] || String(result?.meta?.symbol).toUpperCase() !== symbol.toUpperCase()) throw new Error("chart identity mismatch");
  return normalizeChartRows(result?.timestamp, result?.indicators?.quote?.[0]?.close, market, code, days, "Yahoo Finance minute", now);
}
export function normalizeChartRows(stamps: unknown, prices: unknown, market: string, code: string, days: number, source: string, now = Date.now()): ChartSeries {
  if (![1, 5].includes(days) || !zones[market]) throw new Error("invalid market/range");
  if (!Array.isArray(stamps) || !Array.isArray(prices) || stamps.length > 16000) throw new Error("invalid chart rows");
  const format = new Intl.DateTimeFormat("en-CA", { timeZone: zones[market], year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const unique = new Map<string, ChartSeriesPoint>();
  const conflict = new Set<string>();
  for (let i = 0; i < stamps.length; i++) {
    const stamp = stamps[i], price = prices[i];
    if (typeof stamp !== "number" || !Number.isFinite(stamp) || stamp * 1000 > now + 180000 || stamp * 1000 < now - 35 * 86400000 || typeof price !== "number" || !Number.isFinite(price) || price <= 0) continue;
    const parts = Object.fromEntries(format.formatToParts(new Date(stamp * 1000)).map(p => [p.type, p.value]));
    const date = `${parts.year}-${parts.month}-${parts.day}`, time = `${parts.hour}:${parts.minute}`;
    // Five-day is the regular-session minute chart shown by the reference.
    if (days === 5 && market === "US" && (time < "09:30" || time > "16:00")) continue;
    const key = `${date} ${time}`, point = { date, time, price };
    if (unique.has(key) && unique.get(key)!.price !== price) conflict.add(key);
    unique.set(key, point);
  }
  let points = [...unique].filter(([key]) => !conflict.has(key)).sort(([a], [b]) => a.localeCompare(b)).map(([, p]) => p);
  // A US full trading session begins at 20:00 on the previous local calendar day.
  // Keep the original date in every point; only the selection key crosses midnight.
  const sessionDate = (point: ChartSeriesPoint) => market === "US" && days === 1 && point.time >= "20:00"
    ? new Date(Date.parse(point.date + "T12:00:00Z") + 86400000).toISOString().slice(0, 10) : point.date;
  const dates = [...new Set(points.map(sessionDate))].slice(-days);
  points = points.filter(p => dates.includes(sessionDate(p)));
  if (points.length < 2) throw new Error("minute observations unavailable");
  // Coverage is based on received observations, never the requested session flag.
  const overnight = market === "US" && points.some(p => p.time < "04:00" || p.time >= "20:00");
  return { market, code, days, source, coverage: { overnight }, points };
}

const entries = new Map<string, { at: number; value?: ChartSeries; work?: Promise<ChartSeries> }>();
export async function fetchChartSeries(market: string, code: string, days: number): Promise<ChartSeries> {
  const settings = getSiteSettings();
  const key = JSON.stringify([market, code, days, settings.chartApiUrl, settings.futuHost, settings.futuPort, process.env.STOCKLOG_FUTU, process.env.STOCKLOG_PROXY]);
  const cached = entries.get(key);
  if (cached?.work) return cached.work;
  if (cached?.value && Date.now() - cached.at < 30000) return cached.value;
  if (entries.size >= 256) { for (const [id, entry] of entries) { if (!entry.work) { entries.delete(id); break; } } }
  if (entries.size >= 256 && !entries.has(key)) throw new Error("chart pool busy");
  const entry: { at: number; value?: ChartSeries; work?: Promise<ChartSeries> } = { at: 0 };
  const work = (async () => {
    const signal = AbortSignal.timeout(8000);
    if (days === 1) {
      try {
        const sourceSignal = AbortSignal.any([signal, AbortSignal.timeout(3000)]);
        const rows = await waitForMarketTask(fetchFutuMinuteSeries(market, code, sourceSignal), sourceSignal);
        return normalizeChartRows(rows.map(p => p.timestamp), rows.map(p => p.price), market, code, days, "futu");
      } catch { signal.throwIfAborted(); }
    }
    const symbols = chartSeriesSymbols(market, code);
    for (const symbol of symbols) {
      for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
        try {
          signal.throwIfAborted();
          const sourceSignal = AbortSignal.any([signal, AbortSignal.timeout(3500)]);
          const response = await waitForMarketTask(proxyFetch(`https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${days === 1 ? "1m" : "5m"}&range=5d&includePrePost=${days === 1}&events=div%2Csplits`, { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" }, signal: sourceSignal }), sourceSignal);
          if (!response.ok) throw new Error("minute source failed");
          const raw = await waitForMarketTask(readLimitedResponseJson(response, 4 * 1024 * 1024), sourceSignal);
          signal.throwIfAborted();
          return parseChartSeries(raw, market, code, symbol, days);
        } catch { signal.throwIfAborted(); }
      }
    }
    throw new Error("minute sources unavailable");
  })();
  entry.work = work; entries.set(key, entry);
  try { const value = await work; entry.value = value; entry.at = Date.now(); return value; }
  catch (error) { entries.delete(key); throw error; }
  finally { entry.work = undefined; }
}
