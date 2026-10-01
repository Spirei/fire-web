/* ---------- 汇率管理：SQLite 持久化 + 兜底值 + 按设置刷新 ----------
 *
 * 1. 只请求设置里的汇率接口（currencyApiUrl），不再拼接 symbols、也不再用腾讯补缺。
 * 2. 接口没返回的币种不写入实时表；换算页显示「暂无汇率」。
 * 3. 持仓等金额换算仍用 FALLBACK_RATES 垫底，避免刷新瞬间按 1:1 错算。
 * 4. 普通读取只用已保存汇率；外部接口仅由显式刷新调用，避免触及有限额度。
 */

import { getDb } from "./db";
import { getSiteSettings } from "./settings";
import { FALLBACK_RATES } from "./types";
import { extractRateMap, toUsdBase } from "./currencyRefresh";
import { proxyFetch } from "./net";

const RATES_KEY = "rates_cache";
const REFRESH_URL = "https://api.frankfurter.dev/v1/latest?base=USD";

interface PersistedCache {
  at: number;
  rates: Record<string, number>;
  quoted: string[];
}

let memory: PersistedCache | null = null;
let persistedValue: string | null = null;
const pendingRefreshes = new Map<string, Promise<PersistedCache>>();

function loadPersisted(): PersistedCache | null {
  try {
    const row = getDb()
      .prepare("SELECT value FROM site_settings WHERE key = ?")
      .get(RATES_KEY) as { value?: string } | undefined;
    if (!row?.value) {
      memory = null;
      persistedValue = null;
      return null;
    }
    if (row.value === persistedValue) return memory;
    const parsed = JSON.parse(row.value) as Partial<PersistedCache>;
    if (!parsed || !Number.isFinite(parsed.at) || !(Number(parsed.at) > 0)) return null;
    const rates = extractRateMap({ rates: parsed.rates });
    if (!rates || rates.USD !== 1) return null;
    const quoted = Array.isArray(parsed.quoted)
      ? [...new Set(parsed.quoted.filter((code): code is string => typeof code === "string" && /^[A-Z]{3}$/.test(code) && rates[code] > 0))]
      : [];
    memory = { at: Number(parsed.at), rates, quoted };
    persistedValue = row.value;
    return memory;
  } catch {
    return memory;
  }
}

function savePersisted(cache: PersistedCache) {
  const value = JSON.stringify(cache);
  getDb()
    .prepare(
      `INSERT INTO site_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(RATES_KEY, value);
  memory = cache;
  persistedValue = value;
}

function liveCache(): PersistedCache | null {
  // Next 路由、调度器和其他进程共享 SQLite，不能永久使用各自的旧内存快照。
  return loadPersisted();
}

function withFallback(live: Record<string, number> | null): Record<string, number> {
  return { ...FALLBACK_RATES, ...(live ?? {}), USD: 1 };
}

/** 立即从设置中的汇率接口拉取并写入内存 + SQLite */
export async function refreshRates(): Promise<Record<string, number>> {
  return withFallback((await refreshCache()).rates);
}

async function refreshCache(): Promise<PersistedCache> {
  const settings = getSiteSettings();
  const url = (settings.currencyApiUrl || REFRESH_URL).trim();
  const pending = pendingRefreshes.get(url);
  if (pending) return pending;
  const task = fetchRates(url).finally(() => {
    if (pendingRefreshes.get(url) === task) pendingRefreshes.delete(url);
  });
  pendingRefreshes.set(url, task);
  return task;
}

async function fetchRates(url: string): Promise<PersistedCache> {
  const res = await proxyFetch(url, {
    cache: "no-store",
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36"
    },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`汇率接口请求失败 (${res.status})`);
  const data = await res.json().catch(() => null);
  const extracted = extractRateMap(data);
  if (!extracted) throw new Error("汇率接口返回格式异常");
  const rates = toUsdBase(extracted);
  if (Object.keys(rates).length <= 1) throw new Error("汇率数据无效");
  const quoted = Object.keys(rates).sort();
  const cache = { at: Date.now(), rates, quoted };
  savePersisted(cache);
  return cache;
}

/** 汇率、可用币种和时间从同一快照返回，刷新期间也不会拼出不一致的响应。 */
export async function getRatesSnapshot(force = false) {
  const cache = force ? await refreshCache() : liveCache();
  return {
    base: "USD" as const,
    rates: withFallback(cache?.rates ?? null),
    quoted: [...(cache?.quoted ?? [])],
    updatedAt: cache?.at ?? null
  };
}

export function quotedCurrencies(): string[] {
  const cache = liveCache();
  return [...(cache?.quoted ?? [])];
}

export function ratesUpdatedAt(): number | null {
  const at = liveCache()?.at;
  return typeof at === "number" && at > 0 ? at : null;
}

/** 读取共享的已保存汇率；不自动请求外部接口。 */
export async function getRates(): Promise<Record<string, number>> {
  return withFallback(liveCache()?.rates ?? null);
}
