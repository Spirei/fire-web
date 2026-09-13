/**
 * 股息记录（线上富途优先，本地使用公开数据源）。
 *
 * 线上数据源优先使用富途 get_corporate_actions_dividends；本地开发态使用东方财富
 * （A 股）与 Yahoo（美股 / 港股）公开数据。解析「1股派息0.27USD」等声明文本得到
 * 每股金额与币种；实物分派 / 优先发售等非现金方案标记为 special 展示。
 * 结果持久化到 SQLite：历史记录合并保留；近期/未来记录每日刷新，纯历史快照每周刷新；
 * 上游不可用时继续返回最后一次成功数据，不再把失败显示成 0 期。
 */
import { getDb } from "./db";
import { fetchDailyKline } from "./kline";
import { fetchFutuDividends, type FutuDividendRaw } from "./futuQuotes";
import { proxyFetch } from "./net";

const ACTIVE_TTL_MS = 24 * 60 * 60 * 1000;
const HISTORY_TTL_MS = 7 * ACTIVE_TTL_MS;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";

export type DividendKind = "cash" | "special";
export type DividendPhase = "before" | "pending" | "booked" | "missing" | "unowned" | "info";
export interface DividendLedgerRow {
  exDate: string | null;
  payDate: string | null;
  heldQty: number;
  booked: boolean;
  phase: DividendPhase;
}

export interface DividendRecord {
  pubDate: string | null;
  exDate: string | null;
  recordDate: string | null;
  payDate: string | null;
  statement: string;
  process: string | null;
  fiscalYear: string | null;
  amount: number | null;
  currency: string | null;
  kind: DividendKind;
  /** 当期股息率：每股股息 / 除息日前收盘价 */
  yieldPct?: number | null;
}

export type DividendSource = "futu" | "eastmoney" | "yahoo" | "cache" | "cache-stale" | "unavailable";

function normalizeDate(raw?: string): string | null {
  if (!raw) return null;
  const m = /^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/.exec(raw.trim());
  if (!m) return raw.trim();
  return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}

function parseStatement(statement: string): { amount: number | null; currency: string | null } {
  const m = /([\d.]+)\s*(USD|HKD|CNY|港元|港币|美元|人民币元|人民币)/i.exec(statement);
  if (!m) return { amount: null, currency: null };
  const amount = Number(m[1]);
  if (!Number.isFinite(amount)) return { amount: null, currency: null };
  const raw = m[2].toUpperCase();
  const currency = raw.startsWith("USD") ? "USD" : raw.startsWith("HKD") || raw.includes("港") ? "HKD" : raw.startsWith("CNY") || raw.includes("人民") ? "CNY" : raw;
  return { amount, currency };
}

function classifyKind(statement: string): DividendKind {
  if (/实物分派|优先发售|每持有.*股.*获发|股份分派/.test(statement)) return "special";
  return "cash";
}

function normalize(raw: FutuDividendRaw): DividendRecord {
  const { amount, currency } = parseStatement(raw.statement || "");
  return {
    pubDate: normalizeDate(raw.pub_date),
    exDate: normalizeDate(raw.ex_date),
    recordDate: normalizeDate(raw.record_date),
    payDate: normalizeDate(raw.dividend_payable_date),
    statement: raw.statement || "",
    process: raw.process || null,
    fiscalYear: raw.fiscal_year == null || raw.fiscal_year === "" ? null : String(raw.fiscal_year),
    amount,
    currency,
    kind: classifyKind(raw.statement || "")
  };
}

/** 东方财富 A 股分红送配（富途不支持 A 股股息）：只取「实施分配」，每股 = 每10股派现 ÷ 10 */
async function fetchCnDividends(code: string): Promise<DividendRecord[]> {
  const qs =
    `reportName=RPT_SHAREBONUS_DET&columns=ALL&filter=(SECURITY_CODE="${code}")` +
    `&pageNumber=1&pageSize=200&sortTypes=-1&sortColumns=EX_DIVIDEND_DATE&source=HSF10&client=PC`;
  const res = await fetch(`https://datacenter.eastmoney.com/securities/api/data/v1/get?${qs}`, {
    headers: { "User-Agent": UA, Referer: "https://data.eastmoney.com/" },
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) throw new Error(`eastmoney ${res.status}`);
  const data = (await res.json().catch(() => null)) as {
    result?: { data?: Array<Record<string, unknown>> };
  } | null;
  const rows = data?.result?.data ?? [];
  const out: DividendRecord[] = [];
  for (const r of rows) {
    if (String(r.ASSIGN_PROGRESS || "").trim() !== "实施分配") continue;
    const pretax = Number(r.PRETAX_BONUS_RMB);
    const cash = Number.isFinite(pretax) && pretax > 0;
    const bonusRatio = Number(r.BONUS_RATIO) || 0;
    const itRatio = Number(r.IT_RATIO) || 0;
    const stock = bonusRatio > 0 || itRatio > 0;
    out.push({
      pubDate: normalizeDate(String(r.PLAN_NOTICE_DATE || r.PUBLISH_DATE || "")),
      exDate: normalizeDate(String(r.EX_DIVIDEND_DATE || "")),
      recordDate: normalizeDate(String(r.EQUITY_RECORD_DATE || "")),
      payDate: null,
      statement: String(r.IMPL_PLAN_PROFILE || ""),
      process: String(r.ASSIGN_PROGRESS || "") || null,
      fiscalYear: String(r.REPORT_DATE || "").slice(0, 4) || null,
      amount: cash ? pretax / 10 : null,
      currency: cash ? "CNY" : null,
      kind: cash && !stock ? "cash" : "special"
    });
  }
  return out;
}

/** Yahoo chart events：作为本地及富途不可用时的美股/港股公开历史股息源。 */
async function fetchYahooDividends(market: string, code: string): Promise<DividendRecord[]> {
  const clean = code.replace(/\.(US|HK|AM|N|OQ|PS|K)$/i, "");
  const hkCode = /^\d+$/.test(clean) ? String(Number(clean)).padStart(4, "0") : clean;
  const symbol = market === "HK" ? `${hkCode}.HK` : clean;
  let payload: {
    chart?: { result?: Array<{ meta?: { currency?: string }; events?: { dividends?: Record<string, { amount?: number; date?: number }> } }>; error?: unknown };
  } | null = null;
  let lastError: unknown = null;
  for (const host of ["query2.finance.yahoo.com", "query1.finance.yahoo.com"]) {
    const url = new URL(`https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}`);
    url.searchParams.set("period1", "0");
    url.searchParams.set("period2", String(Math.floor(Date.now() / 1000) + 366 * 24 * 60 * 60));
    url.searchParams.set("interval", "1d");
    url.searchParams.set("events", "div");
    try {
      const res = await proxyFetch(url, {
        headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
        signal: AbortSignal.timeout(12000)
      });
      if (!res.ok) throw new Error(`yahoo ${res.status}`);
      payload = await res.json().catch(() => null);
      if (payload?.chart?.result?.[0] && !payload.chart.error) break;
      throw new Error("yahoo invalid dividend response");
    } catch (error) {
      payload = null;
      lastError = error;
    }
  }
  const result = payload?.chart?.result?.[0];
  if (!result || payload?.chart?.error) throw lastError ?? new Error("yahoo invalid dividend response");
  const currency = String(result.meta?.currency || (market === "HK" ? "HKD" : "USD")).toUpperCase();
  return Object.values(result.events?.dividends || {}).flatMap((item) => {
    const amount = Number(item.amount);
    const stamp = Number(item.date);
    if (!(amount > 0) || !(stamp > 0)) return [];
    const exDate = new Date(stamp * 1000).toISOString().slice(0, 10);
    return [{
      pubDate: null,
      exDate,
      recordDate: null,
      payDate: null,
      statement: `每股派息 ${amount} ${currency}`,
      process: "历史派息",
      fiscalYear: exDate.slice(0, 4),
      amount,
      currency,
      kind: "cash" as const
    }];
  });
}

async function fetchFreshDividends(market: string, code: string): Promise<{ dividends: DividendRecord[]; source: DividendSource }> {
  if (market === "CN") return { dividends: await fetchCnDividends(code), source: "eastmoney" };
  try {
    return { dividends: (await fetchFutuDividends(market, code)).map(normalize), source: "futu" };
  } catch {
    return { dividends: await fetchYahooDividends(market, code), source: "yahoo" };
  }
}

interface CacheRow {
  payload: string;
  fetched_at: number;
}

function dividendDate(item: DividendRecord) {
  return item.payDate || item.exDate || item.recordDate || item.pubDate || "";
}

function dividendKey(item: DividendRecord) {
  return [item.exDate || item.recordDate || item.payDate || item.pubDate, item.payDate, item.kind, item.fiscalYear].join("|");
}

function sortDividends(items: DividendRecord[]) {
  return [...items].sort((a, b) => dividendDate(b).localeCompare(dividendDate(a)));
}

/** 新数据覆盖同一期，旧接口不再返回的历史期仍永久保留。 */
function mergeDividends(cached: DividendRecord[], fresh: DividendRecord[], today: string) {
  const freshKeys = new Set(fresh.map(dividendKey));
  const historical = cached.filter((item) => dividendDate(item) <= today && !freshKeys.has(dividendKey(item)));
  return sortDividends([...fresh, ...historical]);
}

function hasActiveDividend(items: DividendRecord[], today: string) {
  const recent = new Date(`${today}T00:00:00Z`).getTime() - 120 * 24 * 60 * 60 * 1000;
  return items.some((item) => {
    const value = dividendDate(item);
    const time = value ? new Date(`${value}T00:00:00Z`).getTime() : 0;
    return time >= recent;
  });
}

/** 当期股息率：每股现金股息 / 除息日前最近收盘价。K 线失败时收益率留空，不影响股息列表。 */
export async function withPeriodYields(market: string, code: string, dividends: DividendRecord[]): Promise<DividendRecord[]> {
  if (!dividends.length) return dividends;
  try {
    const closes = (await fetchDailyKline(market, code, 3200)).filter((item) => item.c > 0).sort((a, b) => a.d.localeCompare(b.d));
    if (!closes.length) return dividends.map((item) => ({ ...item, yieldPct: null }));
    return dividends.map((item) => {
      if (!(Number(item.amount) > 0)) return { ...item, yieldPct: null };
      const day = item.exDate || item.payDate || item.recordDate;
      if (!day) return { ...item, yieldPct: null };
      let close = 0;
      for (let index = closes.length - 1; index >= 0; index -= 1) {
        if (closes[index].d < day) {
          close = closes[index].c;
          break;
        }
      }
      if (!(close > 0)) close = closes[closes.length - 1]?.c || 0;
      if (!(close > 0)) return { ...item, yieldPct: null };
      return { ...item, yieldPct: Number(item.amount) / close * 100 };
    });
  } catch {
    return dividends.map((item) => ({ ...item, yieldPct: null }));
  }
}

/**
 * 个股 / ETF 股息记录。ok=false 表示全部数据源当前不可用（未缓存，恢复后自动可取）；
 * ok=true 且 dividends 为空表示该标的确实没有（或暂无）派息记录（缓存 24h）。
 */
export async function getDividends(market: string, code: string): Promise<{ ok: boolean; dividends: DividendRecord[]; cached: boolean; stale: boolean; source: DividendSource }> {
  const m = market.trim().toUpperCase();
  const c = code.trim().toUpperCase();
  if (!m || !c) return { ok: true, dividends: [], cached: false, stale: false, source: "unavailable" };

  const db = getDb();
  const row = db.prepare("SELECT payload, fetched_at FROM dividend_cache WHERE market = ? AND code = ?").get(m, c) as CacheRow | undefined;
  const now = Date.now();
  let cachedDividends: DividendRecord[] = [];
  let cacheVerified = false;
  if (row?.fetched_at) {
    const age = now - row.fetched_at;
    try {
      const parsed = JSON.parse(row.payload) as { ok: boolean; verified?: boolean; dividends?: DividendRecord[] };
      if (parsed.ok && Array.isArray(parsed.dividends)) {
        cachedDividends = parsed.dividends;
        cacheVerified = parsed.verified === true;
      }
    } catch { /* 损坏缓存忽略，重新回源 */ }
    const today = new Date(now).toISOString().slice(0, 10);
    const ttl = hasActiveDividend(cachedDividends, today) ? ACTIVE_TTL_MS : HISTORY_TTL_MS;
    if (cachedDividends.length > 0 && age < ttl) return { ok: true, dividends: sortDividends(cachedDividends), cached: true, stale: false, source: "cache" };
    if (cacheVerified && cachedDividends.length === 0 && age < ACTIVE_TTL_MS) return { ok: true, dividends: [], cached: true, stale: false, source: "cache" };
  }

  try {
    const freshResult = await fetchFreshDividends(m, c);
    const today = new Date(now).toISOString().slice(0, 10);
    const dividends = mergeDividends(cachedDividends, freshResult.dividends, today);
    db.prepare(
      `INSERT INTO dividend_cache (market, code, payload, fetched_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(market, code) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`
    ).run(m, c, JSON.stringify({ ok: true, verified: true, dividends }), now);
    return { ok: true, dividends, cached: false, stale: false, source: freshResult.source };
  } catch (error) {
    console.warn(`[dividends] refresh failed for ${m}.${c}:`, error instanceof Error ? error.message : error);
    if (cachedDividends.length > 0) return { ok: true, dividends: sortDividends(cachedDividends), cached: true, stale: true, source: "cache-stale" };
    return { ok: false, dividends: [], cached: false, stale: false, source: "unavailable" };
  }
}
