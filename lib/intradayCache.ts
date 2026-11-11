import type { Intraday } from "./quotes";
import type { StockRecord } from "./types";
import { quoteInstrumentKey } from "./quoteBatches";

type Instrument = Pick<StockRecord,"id"|"market"|"code">;
export type BoundIntraday = { instrument: string; chart: Intraday; readAt: number };
export type IntradayEntries = Record<string, BoundIntraday>;
const MAX_ENTRIES = 128, MAX_AGE = 24 * 60 * 60 * 1000;
export const intradayCacheKey = (ownerId: string) => `fire:watchlist:charts:v2:${encodeURIComponent(ownerId)}`;

export function validIntraday(value: unknown): value is Intraday {
  if (!value || typeof value !== "object") return false;
  const chart = value as Intraday;
  return typeof chart.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(chart.date) && Array.isArray(chart.points) && chart.points.length > 1 && chart.points.length <= 128
    && chart.points.every(point => typeof point?.time === "string" && Number.isFinite(point.price) && point.price > 0);
}
export function intradayFor(entries: IntradayEntries, record: Instrument): Intraday | undefined {
  const value = entries[record.id];
  return value?.instrument === quoteInstrumentKey(record) && validIntraday(value.chart) ? value.chart : undefined;
}
export function pruneIntraday(entries: IntradayEntries, records: Instrument[], now = Date.now()): IntradayEntries {
  return Object.fromEntries(records.map(record => [record,entries[record.id]] as const)
    .filter(([record,value]) => value && value.instrument === quoteInstrumentKey(record) && validIntraday(value.chart) && Number.isFinite(value.readAt) && now >= value.readAt && now - value.readAt <= MAX_AGE)
    .sort((a,b) => b[1].readAt - a[1].readAt).slice(0,MAX_ENTRIES).map(([record,value]) => [record.id,value]));
}
export function readIntradayCache(raw: string | null, ownerId: string, records: Instrument[], now = Date.now()): IntradayEntries {
  if (!ownerId || !raw || raw.length > 1_000_000) return {};
  try {
    const value = JSON.parse(raw);
    if (value?.version !== 2 || value.ownerId !== ownerId || !value.entries || typeof value.entries !== "object" || Array.isArray(value.entries)) return {};
    return Object.fromEntries(Object.entries(pruneIntraday(value.entries,records,now)).map(([id,entry]) => [id,{...entry,chart:{...entry.chart,stale:true}}]));
  } catch { return {}; }
}
export function encodeIntradayCache(ownerId: string, entries: IntradayEntries, records: Instrument[]) {
  return JSON.stringify({version:2,ownerId,entries:pruneIntraday(entries,records)});
}
