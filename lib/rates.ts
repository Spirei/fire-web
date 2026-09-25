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

const RATES_KEY = "rates_cache";
const REFRESH_URL = "https://api.frankfurter.dev/v1/latest?base=USD";

interface PersistedCache {
  at: number;
  rates: Record<string, number>;
  quoted: string[];
}

let memory: PersistedCache | null = null;

function loadPersisted(): PersistedCache | null {
  try {
    const row = getDb()
      .prepare("SELECT value FROM site_settings WHERE key = ?")
      .get(RATES_KEY) as { value?: string } | undefined;
    if (!row?.value) return null;
    const parsed = JSON.parse(row.value) as Partial<PersistedCache>;
    if (!parsed || typeof parsed.rates !== "object" || parsed.rates === null || typeof parsed.at !== "number") return null;
    const rates = parsed.rates as Record<string, number>;
    if (!(rates.USD > 0)) return null;
    const quoted = Array.isArray(parsed.quoted)
      ? parsed.quoted.filter((code): code is string => typeof code === "string" && /^[A-Z]{3}$/.test(code))
      : [];
    return { at: parsed.at, rates, quoted };
  } catch {
    return null;
  }
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

function liveCache(): PersistedCache | null {
  if (memory?.rates) return memory;
  const persisted = loadPersisted();
  if (persisted) memory = persisted;
  return persisted;
}

function withFallback(live: Record<string, number> | null): Record<string, number> {
  return { ...FALLBACK_RATES, ...(live ?? {}), USD: 1 };
}

/** 立即从设置中的汇率接口拉取并写入内存 + SQLite */
export async function refreshRates(): Promise<Record<string, number>> {
  const settings = getSiteSettings();
  const url = (settings.currencyApiUrl || REFRESH_URL).trim();
  const res = await fetch(url, {
    cache: "no-store",
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36"
    },
    signal: AbortSignal.timeout(15000)
  });
  const data = await res.json().catch(() => null);
  const extracted = extractRateMap(data);
  if (!extracted) throw new Error("汇率接口返回格式异常");
  const rates = toUsdBase(extracted);
  if (Object.keys(rates).length <= 1 && !extracted.USD) throw new Error("汇率数据无效");
  const quoted = Object.keys(rates).sort();
  memory = { at: Date.now(), rates, quoted };
  savePersisted(memory);
  return withFallback(rates);
}

export function quotedCurrencies(): string[] {
  const cache = liveCache();
  return cache?.quoted?.length ? cache.quoted : [];
}

export function ratesUpdatedAt(): number | null {
  const at = liveCache()?.at;
  return typeof at === "number" && at > 0 ? at : null;
}

/** 读取汇率：优先内存 → SQLite → 兜底值；不自动请求外部接口。 */
export async function getRates(): Promise<Record<string, number>> {
  return withFallback(liveCache()?.rates ?? null);
}
