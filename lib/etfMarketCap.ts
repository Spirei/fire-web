/**
 * 美股 ETF 总市值补齐（富途 / 腾讯对 ETF 均不返回总市值）。
 *
 * 富途快照对 trust 只返回单位净值（trust_netAssetValue），腾讯美股 f44 为空，
 * 因此个股详情页 ETF 总市值长期显示「—」。这里用「份额 × 现价」计算市值，
 * 份额取自 stockanalysis.com 的 ETF 页（与站点其它轻量抓取同类），
 * 份额缺失时退到基金规模（aum）。结果写入 SQLite（etf_market_caps）：
 * 成功缓存 24h、失败缓存 6h，避免每次详情请求都打外部站点。
 */
import { getDb } from "./db";
import { proxyFetch } from "./net";
import type { Quote } from "./quotes";

const STOCKANALYSIS_BASE = "https://stockanalysis.com/etf/";
const OK_TTL_MS = 24 * 60 * 60 * 1000;
const FAIL_TTL_MS = 6 * 60 * 60 * 1000;

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";
const US_EXCHANGE_SUFFIX = /\.(AM|N|OQ|PS|K)$/;
const pending = new Map<string, Promise<{ shares: number | null; aum: number | null }>>();

interface EtfCapRow {
  shares: number | null;
  market_cap: number | null;
  fetched_at: number | null;
}

function normalizeCode(code: string): string {
  return code.trim().toUpperCase().replace(US_EXCHANGE_SUFFIX, "");
}

/** "2.36B" / "45.3M" / "1.2T" / "860" → 数字 */
function parseCompactNumber(raw: string): number | null {
  const m = /^\s*([\d.]+)\s*([KMBTkmbt])?\s*$/.exec(raw.trim());
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const mult: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
  return m[2] ? value * mult[m[2].toUpperCase()] : value;
}

async function fetchEtfMarketData(code: string): Promise<{ shares: number | null; aum: number | null }> {
  const url = `${STOCKANALYSIS_BASE}${code.toLowerCase()}/`;
  const res = await proxyFetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html" },
    signal: AbortSignal.timeout(7000)
  });
  if (!res.ok) throw new Error(`stockanalysis ${res.status}`);
  const html = await res.text();
  const sharesRaw = html.match(/sharesOut:"([^"]+)"/)?.[1];
  const aumRaw = html.match(/aum:"([^"]+)"/)?.[1];
  return {
    shares: sharesRaw ? parseCompactNumber(sharesRaw) : null,
    aum: aumRaw ? parseCompactNumber(aumRaw) : null
  };
}

/** undefined = 缺失/过期；null = 仍在失败冷却期；数值按每位调用者的现价计算。 */
function cachedCap(row: EtfCapRow | undefined, price: number, now: number): number | null | undefined {
  if (!row?.fetched_at || now - row.fetched_at < 0) return undefined;
  const age = now - row.fetched_at;
  if (row.shares != null && row.shares > 0 && age < OK_TTL_MS) return price * row.shares;
  if (row.market_cap != null && row.market_cap > 0 && age < OK_TTL_MS) return row.market_cap;
  if (row.shares == null && row.market_cap == null && age < FAIL_TTL_MS) return null;
  return undefined;
}

/** 相同 ETF 的份额读取共用请求；市值仍按各自报价计算，不共用某次旧报价的乘积。 */
export async function resolveEtfMarketCap(market: string, code: string, price: number): Promise<number | null> {
  if (market.toUpperCase() !== "US" || !Number.isFinite(price) || price <= 0) return null;
  const key = normalizeCode(code);
  if (!/^[A-Z0-9._-]{1,40}$/.test(key)) return null;
  const db = getDb();
  const row = db.prepare("SELECT shares, market_cap, fetched_at FROM etf_market_caps WHERE code = ?").get(key) as EtfCapRow | undefined;
  const hit = cachedCap(row, price, Date.now());
  if (hit !== undefined) return hit;
  let task = pending.get(key);
  if (!task) {
    task = fetchEtfMarketData(key).catch(() => ({ shares: null, aum: null })).then(data => {
      db.prepare(`INSERT INTO etf_market_caps (code, shares, market_cap, fetched_at)
        VALUES (?, ?, ?, ?) ON CONFLICT(code) DO UPDATE SET shares=excluded.shares,
        market_cap=excluded.market_cap, fetched_at=excluded.fetched_at`)
        .run(key, data.shares, data.shares ? price * data.shares : data.aum, Date.now());
      return data;
    }).finally(() => pending.delete(key));
    pending.set(key, task);
  }
  const data = await task;
  return data.shares ? price * data.shares : data.aum;
}

/**
 * 批量行情返回前补 ETF 市值（供 /api/v1/quotes 等批量接口使用）：
 * 只处理美股且当前缺市值的标的；缓存命中是纯 SQLite 读，单次请求最多真正抓取 12 个，
 * 避免首次批量刷新时一次性打爆外部站点，后续刷新会随缓存收敛。
 */
export async function fillEtfMarketCaps(
  items: { id: string; market: string; code: string }[],
  quotes: Record<string, Quote>
): Promise<void> {
  const candidates = items.filter((it) => {
    if (it.market.toUpperCase() !== "US") return false;
    const quote = quotes[it.id];
    return !!quote && Number.isFinite(quote.price) && quote.price > 0 && !quote.marketCap;
  });
  const db = getDb();
  const stmt = db.prepare("SELECT shares, market_cap, fetched_at FROM etf_market_caps WHERE code = ?");
  const due = new Map<string, typeof candidates>();
  const now = Date.now();
  for (const item of candidates) {
    const code = normalizeCode(item.code);
    const quote = quotes[item.id];
    const hit = cachedCap(stmt.get(code) as EtfCapRow | undefined, quote.price, now);
    if (hit !== undefined) {
      if (hit != null) quote.marketCap = hit;
    } else {
      const group = due.get(code) ?? [];
      group.push(item); due.set(code, group);
    }
  }
  // 预算按证券计数，不按账户记录/交易所后缀计数。
  const groups = [...due.values()].slice(0, 12);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, groups.length) }, async () => {
    while (next < groups.length) {
      const group = groups[next++];
      await Promise.all(group.map(async item => {
        const quote = quotes[item.id];
        const cap = await resolveEtfMarketCap(item.market, item.code, quote.price);
        if (cap != null && cap > 0) quote.marketCap = cap;
      }));
    }
  }));
}
