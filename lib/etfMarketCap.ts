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
import type { Quote } from "./quotes";

const STOCKANALYSIS_BASE = "https://stockanalysis.com/etf/";
const OK_TTL_MS = 24 * 60 * 60 * 1000;
const FAIL_TTL_MS = 6 * 60 * 60 * 1000;

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";
const US_EXCHANGE_SUFFIX = /\.(AM|N|OQ|PS|K)$/;

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
  if (!Number.isFinite(value)) return null;
  const mult: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
  return m[2] ? value * mult[m[2].toUpperCase()] : value;
}

async function fetchEtfMarketData(code: string): Promise<{ shares: number | null; aum: number | null }> {
  const url = `${STOCKANALYSIS_BASE}${code.toLowerCase()}/`;
  const res = await fetch(url, {
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

/**
 * 富途 / 腾讯给不出市值时，用「份额 × 现价」或基金规模补 ETF 总市值。
 * 仅处理美股；港股 / A股 ETF 腾讯 f44 已有市值，不走这里。
 */
export async function resolveEtfMarketCap(market: string, code: string, price: number): Promise<number | null> {
  if (market.toUpperCase() !== "US" || !Number.isFinite(price) || price <= 0) return null;
  const key = normalizeCode(code);
  if (!/^[A-Z0-9._-]+$/.test(key)) return null;

  const db = getDb();
  const row = db.prepare("SELECT shares, market_cap, fetched_at FROM etf_market_caps WHERE code = ?").get(key) as EtfCapRow | undefined;
  const now = Date.now();
  if (row?.fetched_at) {
    const age = now - row.fetched_at;
    if (row.shares != null && age < OK_TTL_MS) return price * row.shares;
    if (row.market_cap != null && age < OK_TTL_MS) return row.market_cap;
    if (row.shares == null && row.market_cap == null && age < FAIL_TTL_MS) return null;
  }

  try {
    const data = await fetchEtfMarketData(key);
    const cap = data.shares ? price * data.shares : data.aum;
    db.prepare(
      `INSERT INTO etf_market_caps (code, shares, market_cap, fetched_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(code) DO UPDATE SET
         shares = excluded.shares,
         market_cap = excluded.market_cap,
         fetched_at = excluded.fetched_at`
    ).run(key, data.shares, cap, now);
    return cap;
  } catch {
    // 抓取失败也缓存（短 TTL），避免每个详情请求重复打外部站点
    db.prepare(
      `INSERT INTO etf_market_caps (code, shares, market_cap, fetched_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(code) DO UPDATE SET
         shares = excluded.shares,
         market_cap = excluded.market_cap,
         fetched_at = excluded.fetched_at`
    ).run(key, null, null, now);
    return null;
  }
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
  const stmt = db.prepare("SELECT shares, market_cap FROM etf_market_caps WHERE code = ?");
  // 先批量读缓存命中的（SQLite 纯读，不限预算，全部补上，与详情页 resolveEtfMarketCap 同源）
  const uncached: { id: string; market: string; code: string }[] = [];
  for (const it of candidates) {
    const quote = quotes[it.id];
    if (!quote) continue;
    const row = stmt.get(normalizeCode(it.code)) as { shares?: number | null; market_cap?: number | null } | undefined;
    if (row?.shares != null) quote.marketCap = quote.price * row.shares;
    else if (row?.market_cap != null && row.market_cap > 0) quote.marketCap = row.market_cap;
    else uncached.push(it); // 未缓存 → 待外部抓取（限预算）
  }
  // 仅对未缓存标的做外部抓取，限制单请求抓取数量，避免打爆外部站点
  const BUDGET = 12;
  for (let i = 0; i < uncached.length && i < BUDGET; i += 4) {
    const chunk = uncached.slice(i, i + 4);
    await Promise.all(
      chunk.map(async (it) => {
        const quote = quotes[it.id];
        if (!quote) return;
        const cap = await resolveEtfMarketCap(it.market, it.code, quote.price);
        if (cap != null && cap > 0) quote.marketCap = cap;
      })
    );
  }
}
