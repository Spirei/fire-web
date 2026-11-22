import { validObservedDate } from "./observedDate";
import type { SeriesClose } from "./portfolioSeries";

interface VerifiedDay {
  day: string;
  equity: number | null;
  prior: number | null;
  pnl: number | null;
  rates: Record<string, unknown>;
}

export interface ObservedTrend {
  dates: string[];
  portfolio: (number | null)[];
  benchmark: (number | null)[];
  missingStart: (number | null)[];
}

function observedNumber(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

export function verifiedAssetDays(payload: unknown, ownerId: string): VerifiedDay[] {
  const result = payload as { accountId?: string; basis?: string; items?: unknown[] } | null;
  if (result?.accountId !== ownerId || result.basis !== "settled_real_ledger_v1" || !Array.isArray(result.items)) {
    throw new Error("日终趋势响应无效");
  }
  const byDay = new Map<string, VerifiedDay>();
  for (const item of result.items) {
    if (typeof item !== "object" || item === null) continue;
    const row = item as Record<string, unknown>;
    if (!validObservedDate(row.day)) continue;
    const usable = row.retired === false && !byDay.has(row.day);
    const rates = row.rates && typeof row.rates === "object" && !Array.isArray(row.rates)
      ? row.rates as Record<string, unknown>
      : {};
    byDay.set(row.day, {
      day: row.day,
      equity: usable ? observedNumber(row.equity) : null,
      prior: usable ? observedNumber(row.prior) : null,
      pnl: usable ? observedNumber(row.pnl) : null,
      rates,
    });
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

function nextDay(day: string) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
}

function display(value: number | null, day: VerifiedDay, currency: string): number | null {
  const rate = currency === "USD" ? 1 : observedNumber(day.rates[currency]);
  if (value === null || rate === null || rate <= 0) return null;
  const converted = value * rate;
  return Number.isFinite(converted) ? converted : null;
}

export function buildVerifiedAssetTrend(
  days: VerifiedDay[], reference: SeriesClose[], start: string, end: string, currency: string, weighting: "simple" | "time",
) {
  const assets = new Map<string, number | null>();
  const selected = days.filter(({ day }) => day >= start && day <= end);
  let previous: VerifiedDay | undefined;
  let segment: VerifiedDay[] = [];
  let comparable: VerifiedDay[] = [];
  for (const row of selected) {
    const contiguous = previous && nextDay(previous.day) === row.day;
    if (previous && !contiguous) assets.set(nextDay(previous.day), null);
    assets.set(row.day, display(row.equity, row, currency));
    if (previous && contiguous && previous.equity !== null && previous.equity > 0 && row.prior === previous.equity
        && row.equity !== null && row.pnl !== null && row.pnl >= -row.prior && segment.length) {
      segment.push(row);
      comparable = segment;
    } else {
      segment = row.equity !== null && row.equity > 0 ? [row] : [];
    }
    previous = row;
  }

  const personal = new Map<string, number>();
  let factor = 1;
  let profit = 0;
  let displayProfit: number | null = 0;
  if (comparable.length) {
    const opening = comparable[0];
    let capital = opening.equity!;
    personal.set(opening.day, 0);
    for (const row of comparable.slice(1)) {
      factor *= 1 + row.pnl! / row.prior!;
      profit += row.pnl!;
      capital += Math.max(0, row.equity! - row.prior! - row.pnl!);
      const dayProfit = display(row.pnl, row, currency);
      displayProfit = displayProfit === null || dayProfit === null ? null : displayProfit + dayProfit;
      const rate = weighting === "time" ? (factor - 1) * 100 : profit / capital * 100;
      if (Number.isFinite(rate)) personal.set(row.day, rate);
    }
  }

  const bars = reference.filter(({ d }) => d >= start && d <= end);
  const benchmark = new Map(bars.map(({ d, c }) => [d, (c / bars[0].c - 1) * 100]));
  const returnDates = [...new Set([...personal.keys(), ...benchmark.keys()])].sort();
  const left = validObservedDate(start) ? start : returnDates[0];
  if (left && returnDates.length && returnDates[0] > left) returnDates.unshift(left);
  const firstPersonal = personal.keys().next().value;
  const comparisonDay = returnDates.findLast(day => personal.has(day) && benchmark.has(day));
  const relative: ObservedTrend = {
    dates: returnDates,
    portfolio: returnDates.map(day => personal.get(day) ?? null),
    benchmark: returnDates.map(day => benchmark.get(day) ?? null),
    missingStart: returnDates.map(day => firstPersonal && firstPersonal > left && day <= firstPersonal ? 0 : null),
  };
  const lastPersonal = comparable.at(-1);
  return {
    relative,
    absolute: {
      dates: [...assets.keys()],
      portfolio: [...assets.values()],
      benchmark: [],
      missingStart: [],
    } satisfies ObservedTrend,
    returnRate: lastPersonal ? (personal.get(lastPersonal.day) ?? NaN) / 100 : NaN,
    cumulative: lastPersonal && displayProfit !== null && Number.isFinite(displayProfit) ? displayProfit : NaN,
    comparisonDay,
    benchmarkDifference: comparisonDay ? (personal.get(comparisonDay)! - benchmark.get(comparisonDay)!) / 100 : null,
  };
}
