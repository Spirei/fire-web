import { proxyFetch } from "./net";
import { fetchBatch, type Quote } from "./quotes";
import type { RankingMarket } from "./marketVolumeRanking";

const markets = {
  US: { scanner: "america", exchanges: ["NASDAQ", "NYSE", "AMEX"], currency: "USD" },
  HK: { scanner: "hongkong", exchanges: ["HKEX"], currency: "HKD" },
  CN: { scanner: "china", exchanges: ["SSE", "SZSE", "BSE"], currency: "CNY" }
};
type Candidate = { code: string; symbol: string; name: string; upper: number };
export type AmountRanking = {
  market: RankingMarket; metric: "amount"; currency: string; tradeDate: string; updatedAt: string;
  items: { market: RankingMarket; code: string; name: string; amount: number; price: number; changePct: number; time: string }[];
};
function tencentSymbol(market: RankingMarket, code: string) {
  return market === "US" ? "us" + code : market === "HK" ? "hk" + code :
    (/^(4|8|920)/.test(code) ? "bj" : /^[69]/.test(code) ? "sh" : "sz") + code;
}

/** Inspect the complete market, never a volume/cap shortlist. High × shares is only
 * a conservative exclusion bound; it is never returned as an observed amount. */
export function parseAmountUniverse(raw: unknown, market: RankingMarket, now = Date.now()) {
  const data = raw as { totalCount?: unknown; data?: unknown };
  if (!Array.isArray(data?.data) || typeof data.totalCount !== "number" || data.totalCount < 10 ||
      data.totalCount > 20000 || data.data.length !== data.totalCount) throw Error("Incomplete amount universe");
  const seen = new Set<string>();
  let latest = 0;
  const rows: (Candidate & { day: number })[] = [];
  for (const value of data.data) {
    const row = value as { s?: unknown; d?: unknown };
    if (!Array.isArray(row.d) || row.d.length !== 8) throw Error("Invalid amount universe row");
    const [symbol, name, high, volume, day, type, exchange, currency] = row.d;
    if (typeof symbol !== "string" || !/^[A-Z0-9./\-]{1,24}$/i.test(symbol) || typeof name !== "string" || !name.trim() ||
        type !== "stock" || !markets[market].exchanges.includes(exchange) || currency !== markets[market].currency ||
        row.s !== `${exchange}:${symbol}`) throw Error("Invalid amount identity");
    const code = market === "HK" ? symbol.padStart(5, "0") : symbol.toUpperCase();
    if (seen.has(code) || (market === "HK" && !/^\d{5}$/.test(code)) || (market === "CN" && !/^\d{6}$/.test(code))) throw Error("Duplicate amount security");
    seen.add(code);
    if (volume == null || volume === 0) continue; // No trades, no amount to rank.
    if (typeof volume !== "number" || !Number.isFinite(volume) || volume < 0 || typeof high !== "number" ||
        !Number.isFinite(high) || high <= 0 || typeof day !== "number" || day <= 0 || day % 86400 !== 0 ||
        day * 1000 > now + 180000) throw Error("Invalid amount observation");
    latest = Math.max(latest, day);
    const upper = high * volume * 1.05; // Allow small cross-source publication lag.
    if (!Number.isFinite(upper)) throw Error("Invalid amount bound");
    rows.push({ code, symbol: tencentSymbol(market, code), name: name.trim(), upper, day });
  }
  const candidates = rows.filter(row => row.day === latest).sort((a, b) => b.upper - a.upper);
  if (candidates.length < 10 || latest * 1000 < now - 10 * 86400000) throw Error("Incomplete amount trading day");
  return { tradeDate: new Date(latest * 1000).toISOString().slice(0, 10), candidates };
}

export async function rankObservedAmounts(market: RankingMarket, universe: ReturnType<typeof parseAmountUniverse>,
    read: (symbols: string[]) => Promise<Map<string, Quote>>, now = Date.now()): Promise<AmountRanking> {
  const accepted: AmountRanking["items"] = [], unresolved: Candidate[] = [];
  let offset = 0;
  while (offset < universe.candidates.length && offset < 72) {
    const batch = universe.candidates.slice(offset, Math.min(offset + 12, 72));
    const quotes = await read(batch.map(item => item.symbol));
    for (const item of batch) {
      const q = quotes.get(item.symbol);
      // Tencent A-share amount is in CNY 10,000; HK/US amounts are currency units.
      const amount = q?.amount == null ? NaN : q.amount * (market === "CN" ? 10000 : 1);
      const date = q?.time.replace(/[^0-9]/g, "").slice(0, 8);
      if (!q || date !== universe.tradeDate.replaceAll("-", "") || !Number.isFinite(amount) || amount <= 0 ||
          amount > item.upper || !Number.isFinite(q.price) || q.price <= 0 || !Number.isFinite(q.changePct)) {
        unresolved.push(item); continue;
      }
      accepted.push({ market, code: item.code, name: q.name.trim() || item.name, amount, price: q.price, changePct: q.changePct, time: q.time });
    }
    offset += batch.length;
    accepted.sort((a, b) => b.amount - a.amount || a.code.localeCompare(b.code));
    const cutoff = accepted[9]?.amount ?? 0;
    const outstanding = Math.max(universe.candidates[offset]?.upper ?? 0, ...unresolved.map(item => item.upper));
    if (cutoff > outstanding) return { market, metric: "amount", currency: markets[market].currency, tradeDate: universe.tradeDate,
      updatedAt: new Date(now).toISOString(), items: accepted.slice(0, 10) };
  }
  throw Error("Cannot verify complete amount top ten");
}

async function universeResponse(response: Response) {
  if (!response.ok || !response.body) throw Error("Amount universe unavailable");
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let count = 0;
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; count += value.length;
      if (count > 3 * 1024 * 1024) throw Error("Amount universe too large"); chunks.push(value); }
  } finally { await reader.cancel().catch(() => undefined); }
  const bytes = new Uint8Array(count); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}
const cache = new Map<RankingMarket, { at: number; value: AmountRanking }>();
const pending = new Map<RankingMarket, Promise<AmountRanking>>();
export async function amountRanking(market: RankingMarket): Promise<AmountRanking> {
  const stored = cache.get(market);
  if (stored && Date.now() - stored.at < 180000) return stored.value;
  const existing = pending.get(market); if (existing) return existing;
  const work = (async () => {
    const signal = AbortSignal.timeout(10000), setting = markets[market];
    const response = await proxyFetch(`https://scanner.tradingview.com/${setting.scanner}/scan`, {
      method: "POST", redirect: "error", signal,
      headers: { "Content-Type": "application/json", Origin: "https://www.tradingview.com" },
      body: JSON.stringify({ filter: [{ left: "type", operation: "equal", right: "stock" },
        { left: "is_primary", operation: "equal", right: true }, { left: "exchange", operation: "in_range", right: setting.exchanges },
        { left: "currency", operation: "equal", right: setting.currency }],
        columns: ["name", "description", "high", "volume", "daily-bar.time", "type", "exchange", "currency"], range: [0, 20000] })
    });
    const universe = parseAmountUniverse(await universeResponse(response), market);
    const value = await rankObservedAmounts(market, universe, symbols => fetchBatch(symbols, signal));
    signal.throwIfAborted(); cache.set(market, { at: Date.now(), value }); return value;
  })();
  pending.set(market, work);
  try { return await work; } finally { if (pending.get(market) === work) pending.delete(market); }
}
