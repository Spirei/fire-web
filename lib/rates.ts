/* ---------- 汇率管理：SQLite 持久化 + 兜底值 + 后台刷新 ----------
 *
 * 背景：汇率缓存原来是进程内存级，服务重启即丢失；首次请求要实时等
 * Frankfurter（最长 15 秒），期间前端拿到 { USD: 1 }，港股 / A股 / 日股 /
 * 韩股被按 1:1 换算成美元，导致总资产刷新瞬间闪出错误数值。
 *
 * 现在：
 * 1. 汇率持久化到 site_settings 表，服务重启后立即返回上次汇率；
 * 2. 完全没有缓存时立即返回兜底值（见 FALLBACK_RATES），后台异步刷新；
 * 3. 每天 9:00 / 23:00 两个刷新点，其余时间直接用缓存。
 */

import { getDb } from "./db";
import { getSiteSettings } from "./settings";
import { FALLBACK_RATES } from "./types";

const RATES_KEY = "rates_cache";
const REFRESH_URL = "https://api.frankfurter.dev/v1/latest";

interface PersistedCache {
  at: number;
  rates: Record<string, number>;
}

let memory: PersistedCache | null = null;

// 计算下一次计划刷新时间（今天 9:00 / 今天 23:00 / 明天 9:00）
function nextRefreshAt(now: number): number {
  const d = new Date(now);
  const today9 = new Date(d);
  today9.setHours(9, 0, 0, 0);
  const today23 = new Date(d);
  today23.setHours(23, 0, 0, 0);
  const tomorrow9 = new Date(today9);
  tomorrow9.setDate(tomorrow9.getDate() + 1);
  if (now < today9.getTime()) return today9.getTime();
  if (now < today23.getTime()) return today23.getTime();
  return tomorrow9.getTime();
}

function loadPersisted(): PersistedCache | null {
  try {
    const row = getDb()
      .prepare("SELECT value FROM site_settings WHERE key = ?")
      .get(RATES_KEY) as { value?: string } | undefined;
    if (!row?.value) return null;
    const parsed = JSON.parse(row.value) as Partial<PersistedCache>;
    if (
      parsed &&
      typeof parsed.rates === "object" &&
      parsed.rates !== null &&
      parsed.rates.USD === 1 &&
      typeof parsed.at === "number"
    ) {
      return { at: parsed.at, rates: parsed.rates as Record<string, number> };
    }
  } catch {
    /* 损坏的缓存忽略 */
  }
  return null;
}

function savePersisted(cache: PersistedCache) {
  try {
    getDb()
      .prepare(
        `INSERT INTO site_settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(RATES_KEY, JSON.stringify(cache));
  } catch {
    /* 写入失败不影响主流程 */
  }
}

/** 上一次成功获取的汇率（内存 → SQLite），用于兜底；从未成功过则返回 null */
function lastKnownRates(): Record<string, number> | null {
  if (memory?.rates) return memory.rates;
  return loadPersisted()?.rates ?? null;
}

/** 立即从上游拉取最新汇率并写入内存 + SQLite */
export async function refreshRates(): Promise<Record<string, number>> {
  const settings = getSiteSettings();
  const base = settings.currencyApiUrl || REFRESH_URL;
  const sep = base.includes("?") ? "&" : "?";
  const res = await fetch(`${base}${sep}base=USD&symbols=CNY,HKD,JPY,KRW,SGD,GBP,EUR,AUD,CAD,INR,BRL,USD`, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36"
    },
    signal: AbortSignal.timeout(15000)
  });
  const data = await res.json().catch(() => null);
  const raw = data?.rates;
  if (!raw || typeof raw !== "object") throw new Error("汇率接口返回格式异常");
  // 以「上一次成功汇率」为底（从未成功过才用静态兜底），
  // 上游缺失的币种保留上次成功值，避免按 1:1 误算
  const rates: Record<string, number> = { ...(lastKnownRates() ?? FALLBACK_RATES) };
  rates.USD = 1;
  let found = 0;
  Object.entries(raw as Record<string, unknown>).forEach(([code, v]) => {
    if (/^[A-Z]{3}$/.test(code) && typeof v === "number" && v > 0) {
      rates[code] = v;
      found += 1;
    }
  });
  if (found === 0) throw new Error("汇率数据无效");
  memory = { at: Date.now(), rates };
  savePersisted(memory);
  return rates;
}

/** 读取汇率：优先内存 → SQLite → 兜底值；过期或缺失时后台异步刷新，不阻塞响应 */
export async function getRates(): Promise<Record<string, number>> {
  const now = Date.now();
  if (memory && now < nextRefreshAt(memory.at)) return memory.rates;
  const persisted = loadPersisted();
  if (persisted) {
    memory = persisted;
    if (now >= nextRefreshAt(persisted.at)) refreshRates().catch(() => {});
    return persisted.rates;
  }
  refreshRates().catch(() => {});
  return { ...FALLBACK_RATES };
}
