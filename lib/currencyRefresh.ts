/**
 * 汇率刷新时刻与上游 JSON 解析（客户端 / 服务端共用，不碰数据库）。
 *
 * 刷新时间写成日常的 HH:MM，用 | 或逗号分隔即可，例如 09:00|23:00。
 * 用正则从字符串里抽出时刻，不把用户输入当成 RegExp 源码执行。
 */

export const DEFAULT_CURRENCY_REFRESH_PATTERN = "09:00|23:00";

export interface RefreshTime {
  hour: number;
  minute: number;
  label: string;
}

const TIME_RE = /\b([01]?\d|2[0-3]):([0-5]\d)\b/g;

export function parseRefreshTimes(pattern: string): RefreshTime[] {
  const seen = new Set<string>();
  const times: RefreshTime[] = [];
  const source = String(pattern || "");
  for (const match of source.matchAll(TIME_RE)) {
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (!Number.isInteger(hour) || hour > 23 || minute > 59) continue;
    const label = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    if (seen.has(label)) continue;
    seen.add(label);
    times.push({ hour, minute, label });
    if (times.length >= 24) break;
  }
  if (!times.length) {
    if (source.trim() === DEFAULT_CURRENCY_REFRESH_PATTERN) {
      return [
        { hour: 9, minute: 0, label: "09:00" },
        { hour: 23, minute: 0, label: "23:00" }
      ];
    }
    return parseRefreshTimes(DEFAULT_CURRENCY_REFRESH_PATTERN);
  }
  times.sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute));
  return times;
}

export function formatRefreshTimes(times: RefreshTime[]): string {
  return times.map((item) => item.label).join(" / ");
}

export function nextRefreshAt(now: number, times: RefreshTime[]): number {
  const slots = times.length ? times : parseRefreshTimes(DEFAULT_CURRENCY_REFRESH_PATTERN);
  const date = new Date(now);
  for (const slot of slots) {
    const at = new Date(date);
    at.setHours(slot.hour, slot.minute, 0, 0);
    if (now < at.getTime()) return at.getTime();
  }
  const first = slots[0];
  const tomorrow = new Date(date);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(first.hour, first.minute, 0, 0);
  return tomorrow.getTime();
}

function takeNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) return Number(value);
  return NaN;
}

function collectRates(source: unknown): Record<string, number> {
  const rates: Record<string, number> = {};
  if (!source || typeof source !== "object" || Array.isArray(source)) return rates;
  for (const [rawKey, rawValue] of Object.entries(source as Record<string, unknown>)) {
    const key = rawKey.trim().toUpperCase();
    const code = /^USD[A-Z]{3}$/.test(key) ? key.slice(3) : key;
    if (!/^[A-Z]{3}$/.test(code)) continue;
    const amount = takeNumber(rawValue);
    if (Number.isFinite(amount) && amount > 0) rates[code] = amount;
  }
  return rates;
}

/** 从常见汇率接口 JSON 里抽出「币种 → 数量」表。 */
export function extractRateMap(data: unknown): Record<string, number> | null {
  if (!data || typeof data !== "object") return null;
  const root = data as Record<string, unknown>;
  const candidates = [root.rates, root.conversion_rates, root.quotes, root.data, root];
  for (const candidate of candidates) {
    const nested = candidate && typeof candidate === "object" && !Array.isArray(candidate)
      ? collectRates((candidate as Record<string, unknown>).rates ?? candidate)
      : collectRates(candidate);
    if (Object.keys(nested).length) return nested;
  }
  return null;
}

/** 把任意基准的汇率表折成「1 美元 = N 本币」。 */
export function toUsdBase(rates: Record<string, number>): Record<string, number> {
  const usd = rates.USD;
  const out: Record<string, number> = { USD: 1 };
  if (!usd || usd === 1) {
    for (const [code, value] of Object.entries(rates)) {
      if (code !== "USD" && value > 0) out[code] = value;
    }
    return out;
  }
  for (const [code, value] of Object.entries(rates)) {
    if (code === "USD" || !(value > 0)) continue;
    out[code] = value / usd;
  }
  return out;
}
