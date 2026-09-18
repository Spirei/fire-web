/**
 * 汇率刷新时刻与上游 JSON 解析（客户端 / 服务端共用，不碰数据库）。
 *
 * 刷新时间是真正的正则：拿用户表达式去匹配当天每一个 HH:MM（00:00–23:59）。
 * 例如 09:00|23:00、^(09|12|18):00$、^([01]\d|2[0-3]):00$。
 * 也接受 /pattern/flags 写法。正则无效或一个时刻都匹配不到时，回退 09:00|23:00。
 */

export const DEFAULT_CURRENCY_REFRESH_PATTERN = "09:00|23:00";

export interface RefreshTime {
  hour: number;
  minute: number;
  label: string;
}

const DEFAULT_REFRESH_TIMES: RefreshTime[] = [
  { hour: 9, minute: 0, label: "09:00" },
  { hour: 23, minute: 0, label: "23:00" }
];

const MAX_REFRESH_SLOTS = 96;

function padTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** 把输入编成正则。允许 /pattern/flags；去掉 g，避免 test 时 lastIndex 错位。 */
export function compileCurrencyRefreshRegex(raw: string): RegExp | null {
  const source = String(raw || "").trim();
  if (!source) return null;
  let pattern = source;
  let flags = "";
  const wrapped = /^\/((?:\\\/|[^/])+)\/([a-z]*)$/.exec(source);
  if (wrapped) {
    pattern = wrapped[1];
    flags = wrapped[2].replace(/g/g, "");
  }
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

export function parseRefreshTimes(pattern: string): RefreshTime[] {
  const regex = compileCurrencyRefreshRegex(pattern);
  if (!regex) return DEFAULT_REFRESH_TIMES;
  const times: RefreshTime[] = [];
  for (let hour = 0; hour < 24; hour += 1) {
    for (let minute = 0; minute < 60; minute += 1) {
      const label = padTime(hour, minute);
      regex.lastIndex = 0;
      if (!regex.test(label)) continue;
      times.push({ hour, minute, label });
      if (times.length >= MAX_REFRESH_SLOTS) return times;
    }
  }
  return times.length ? times : DEFAULT_REFRESH_TIMES;
}

export function formatRefreshTimes(times: RefreshTime[]): string {
  const labels = times.map((item) => item.label);
  if (labels.length <= 6) return labels.join(" / ");
  return `${labels.slice(0, 4).join(" / ")} 等 ${labels.length} 个时刻`;
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
