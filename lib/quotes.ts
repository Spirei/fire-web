import { MARKET_META, type Market, type SearchMatch } from "./types";
import { getSiteSettings } from "./settings";
import { fetchUsExtendedQuote, fetchUsRegularQuote } from "./usExtendedQuote";
import { fetchFutuQuotes, fetchFutuIntraday, isFutuAvailable, searchFutu } from "./futuQuotes";
import { getCryptoQuote } from "./assetQuotes";
import { proxyFetch } from "./net";
import { MarketDataPool } from "./marketDataPool";
import { normalizeMarketCode } from "./marketCode";
import { waitForMarketTask } from "./marketDeadline";
import { readLimitedResponseJson } from "./requestBody";
import { ActiveQuotePool } from "./activeQuotePool";
import { marketSessionState } from "./marketSessions";
import { QUOTE_DEMAND_MARKETS, type PublicQuoteDemand } from "./quoteDemand";

const DEFAULT_QUOTE_URL = "https://qt.gtimg.cn/q=";
const DEFAULT_SEARCH_URL = "https://smartbox.gtimg.cn/s3/?v=2&q={q}&t=all";
const DEFAULT_CHART_URL = "https://web.ifzq.gtimg.cn/appstock/app/minute/query?code={code}";
// 东方财富搜索联想接口的公开 token（接口本身无需授权，权当常量避免散落在 URL 字符串里）
const EASTMONEY_SEARCH_TOKEN = "D43BF722C8E33BDC906FB84D85E326E8";

export interface Quote {
  name: string;
  price: number;
  change: number;
  changePct: number;
  open: number;
  high: number;
  low: number;
  time: string;
  /** 当前涨跌的常规收盘基准；夜盘为本周期 20:00 前的最近常规收盘。 */
  prevClose?: number;
  /** PRE / AFTER / OVERNIGHT 表示当前 price 已切换为对应扩展时段有效价。 */
  session?: "PRE" | "REGULAR" | "AFTER" | "OVERNIGHT";
  /** 成交量（股/手，腾讯 f36） */
  volume?: number;
  /** 成交额（本地货币，腾讯 f37） */
  amount?: number;
  /** 市盈率（腾讯 f39） */
  pe?: number;
  /** 换手率 %（腾讯 f43） */
  turnover?: number;
  amplitude?: number;
  epsTtm?: number;
  weekHigh?: number;
  weekLow?: number;
  pb?: number;
  dividendYieldTtm?: number;
  volumeRatio?: number;
  totalShares?: number;
  floatShares?: number;
  staticPe?: number;
  dividendTtm?: number;
  averagePrice?: number;
  /** 总市值（本地货币，腾讯 f44 × 1e8） */
  marketCap?: number;
  /** 行情来源：futu=富途 / tencent=腾讯兜底 / yahoo=Yahoo 扩展时段兜底 / auto */
  source?: "futu" | "tencent" | "yahoo" | "auto";
  /** A recent active-pool snapshot was returned while scheduled updates continue. */
  cached?: boolean;
}

export interface QuoteItem {
  id: string;
  market: Market;
  code: string;
}

// 腾讯美股代码的交易所后缀：搜索联想返回 TICKER.OQ / TICKER.N / TICKER.AM（美交所）等，
// 行情接口需要不带后缀的符号（BRK.B 这类点号属于股票名本身，不在列表中，不会被误剥）。
const US_EXCHANGE_SUFFIX = /\.(OQ|N|AM|PS|K)$/;

function toTencentSymbol(market: Market, code: string): string {
  const raw = code.trim().toUpperCase();
  if (!/^[A-Z0-9._]+$/.test(raw)) return "";
  switch (market) {
    case "US":
      return "us" + raw.replace(US_EXCHANGE_SUFFIX, "");
    case "HK":
      // 港股允许客户端传 700 / 00700，统一补为腾讯的五位代码。
      return "hk" + raw.replace(/^0+/, "").padStart(5, "0");
    case "CN": {
      // A 股代码的前导零属于证券代码本身（002602 / 000858），不可像数值一样剥除。
      // 旧逻辑会请求 sz2602，导致所有 0 开头的深市行情（含涨跌幅）整条缺失。
      const c = raw.padStart(6, "0");
      if (/^(4|8|920)/.test(c)) return "bj" + c; // 北交所：4xx / 8xx / 920xxx
      if (/^[69]/.test(c)) return "sh" + c;
      if (/^[0-3]/.test(c)) return "sz" + c;
      return "bj" + c;
    }
    // 日股 / 韩股：腾讯行情统一用 jp{4位代码} / kr{6位代码}（去交易所后缀），
    // 原本只在素材库回填脚本里用过，这里接进实时行情链路，持仓 / 自选才有最新价与涨跌幅。
    case "JP":
      return "jp" + raw.replace(/\.T$/, "");
    case "KR":
      return "kr" + raw.replace(/\.(KS|KQ)$/, "");
    default:
      return "";
  }
}

function parseLine(line: string): { symbol: string; fields: string[] } | null {
  const match = /v_([^=]+)="([^"]*)"/.exec(line);
  if (!match) return null;
  return { symbol: match[1], fields: match[2].split("~") };
}

export async function fetchBatch(symbols: string[], signal?: AbortSignal, publish?: (symbol: string, quote: Quote) => void): Promise<Map<string, Quote>> {
  if (symbols.length === 0) return new Map();
  const base = getSiteSettings().quoteApiUrl || DEFAULT_QUOTE_URL;
  const map = new Map<string, Quote>();
  // 腾讯行情接口当前每次请求只返回第一条（批量已失效），改为并发逐条请求
  const CONCURRENCY = 6;
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, symbols.length) }, async () => {
    while (next < symbols.length && !signal?.aborted) {
      const symbol = symbols[next++];
      try {
        const res = await fetch(base + symbol, {
          headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000)
        });
        if (!res.ok) continue;
        const buffer = await res.arrayBuffer();
        let text: string;
        try {
          text = new TextDecoder("gbk").decode(buffer);
        } catch {
          text = new TextDecoder("utf-8").decode(buffer);
        }
        const parsed = parseLine(text);
        if (!parsed || parsed.fields.length < 35) continue;
        const f = parsed.fields;
        const price = Number(f[3]);
        if (!price) continue;
        // 无效代码会被行情源模糊匹配成某个“幽灵”证券：成交量/成交额、涨跌、涨跌幅全为 0，且时间停留在很久以前。
        // 这类占位行情不是真实股价，直接丢弃，避免“不存在股票却显示股价/市场图标/旧日期”。
        const change = Number(f[31]) || 0;
        const changePct = Number(f[32]) || 0;
        const volume = Number(f[36]) || 0;
        const amount = Number(f[37]) || 0;
        // 日股 / 韩股字段口径与美港 A 不完全一致，有现价就收下，避免 0 成交量被当成幽灵行情丢掉。
        const jpKr = parsed.symbol.startsWith("jp") || parsed.symbol.startsWith("kr");
        if (!jpKr && volume === 0 && change === 0 && changePct === 0 && amount === 0) continue;
        const quote: Quote = {
          name: f[1] || "",
          price,
          change,
          changePct,
          open: Number(f[5]) || price,
          high: Number(f[33]) || price,
          low: Number(f[34]) || price,
          time: f[30] || "",
          prevClose: Number(f[4]) || price - (Number(f[31]) || 0),
          session: "REGULAR",
          volume,
          amount,
          pe: Number(f[39]) || undefined,
          turnover: Number(f[38]) || 0,
          amplitude: Number(f[43]) || 0,
          marketCap: Number(f[44]) > 0 ? Number(f[44]) * 1e8 : undefined,
          epsTtm: Number(f[47]) || undefined,
          weekHigh: Number(f[48]) || undefined,
          weekLow: Number(f[49]) || undefined,
          pb: Number(f[51]) || undefined,
          dividendYieldTtm: Number(f[52]) || undefined,
          volumeRatio: Number(f[55]) || undefined,
          totalShares: Number(f[62]) || undefined,
          floatShares: Number(f[63]) || undefined,
          staticPe: Number(f[65]) || undefined,
          dividendTtm: Number(f[66]) || undefined,
          averagePrice: Number(f[67]) || undefined
        };
        map.set(parsed.symbol, quote);
        publish?.(parsed.symbol, quote);
      } catch {
        /* 单条失败不影响其他 */
      }
    }
  }));
  return map;
}

interface QuoteRuntime {
  quotes: MarketDataPool<Quote>;
  active?: ActiveQuotePool;
  namespace: typeof quoteNamespace;
  policy: typeof activeQuotePolicy;
  load: typeof fetchQuotesUnshared;
}
// Next entry points have independent module caches. Keep one public pool per process;
// update its callbacks on reload so background work uses the current adapters/settings.
const quoteHost = globalThis as typeof globalThis & { __alcorQuoteRuntimeV2?: QuoteRuntime; __alcorQuoteRuntimeV1?: QuoteRuntime };
const previousQuotes = quoteHost.__alcorQuoteRuntimeV1?.quotes;
quoteHost.__alcorQuoteRuntimeV1?.active?.dispose();
delete quoteHost.__alcorQuoteRuntimeV1;
const quoteRuntime = quoteHost.__alcorQuoteRuntimeV2 ??= {
  quotes: previousQuotes ?? new MarketDataPool<Quote>(2_000, quote => Number.isFinite(quote.price) && quote.price > 0),
  namespace: quoteNamespace, policy: activeQuotePolicy, load: fetchQuotesUnshared
};
quoteRuntime.namespace = quoteNamespace; quoteRuntime.policy = activeQuotePolicy; quoteRuntime.load = fetchQuotesUnshared;
const sharedQuotes = quoteRuntime.quotes;
const sharedCharts = new MarketDataPool<Intraday>(30_000, chart => !chart.stale);

function normalizedMarketItem(item: QuoteItem): QuoteItem {
  return { ...item, code: normalizeMarketCode(item.market, item.code) };
}

function quoteNamespace(): string {
  const settings = getSiteSettings();
  return JSON.stringify([settings.quoteSource, settings.quoteApiUrl, settings.futuHost, settings.futuPort, process.env.STOCKLOG_FUTU, process.env.STOCKLOG_PROXY, process.env.STOCKLOG_EXTENDED_QUOTE]);
}

function activeQuotePolicy(item: QuoteItem, now: number) {
  if (!/^[A-Z0-9._-]{1,40}$/.test(item.code) || !QUOTE_DEMAND_MARKETS.includes(item.market as typeof QUOTE_DEMAND_MARKETS[number])) return undefined;
  if (item.market === "ASSET") return { intervalMs: 10_000, phase: "ASSET" };
  const state = marketSessionState(item.market, new Date(now));
  return { intervalMs: state.active ? 5_000 : 60_000, phase: `${state.localDate}:${state.session}` };
}

const activeQuotes = quoteRuntime.active ??= new ActiveQuotePool({
  currentNamespace: () => quoteRuntime.namespace(),
  policy: (item, now) => quoteRuntime.policy(item, now),
  refresh: (items, namespace) => {
    // This bypasses observe(): proactive refresh never renews demand or recursively schedules itself.
    if (namespace !== quoteRuntime.namespace()) return Promise.resolve({});
    return quoteRuntime.quotes.fetch(items, namespace, quoteRuntime.load);
  }
});

export function readActiveQuotePool() {
  // Next can retain the previous scheduler instance across a module reload.
  // Add the new read-only inspector without resetting its leases or jobs.
  if (typeof activeQuotes.snapshot !== "function") activeQuotes.snapshot = ActiveQuotePool.prototype.snapshot;
  return activeQuotes.snapshot(quoteDemandNamespace());
}

export function quoteDemandNamespace() { return quoteRuntime.namespace(); }
export function syncQuoteSubscriptions(changes: PublicQuoteDemand[], replace = false) {
  activeQuotes.reconcileSubscriptions(changes, quoteDemandNamespace(), replace);
}

function activeQuoteSnapshot(items: QuoteItem[], namespace: string): Record<string, Quote> {
  const result: Record<string, Quote> = Object.create(null);
  const fresh = sharedQuotes.peek(items, namespace);
  for (const item of items) {
    const maxAge = activeQuotes.cacheAge(item, namespace);
    if (maxAge === undefined) continue;
    const quote = sharedQuotes.peek([item], namespace, maxAge)[item.id];
    if (quote) result[item.id] = fresh[item.id] ? quote : { ...quote, cached: true };
  }
  return result;
}

async function readRequestedQuotes(items: QuoteItem[], namespace: string): Promise<Record<string, Quote>> {
  const snapshot = activeQuoteSnapshot(items, namespace);
  const missing = items.filter(item => !snapshot[item.id]);
  return { ...snapshot, ...await sharedQuotes.fetch(missing, namespace, fetchQuotesUnshared) };
}

export async function fetchQuotes(items: QuoteItem[], demand?: { tracked: boolean }): Promise<Record<string, Quote>> {
  const normalized = items.map(normalizedMarketItem), namespace = quoteNamespace();
  if (!demand?.tracked) activeQuotes.observe(normalized, namespace);
  return readRequestedQuotes(normalized, namespace);
}

/** Overview waits briefly; its fallback is public market data, never a cached account total. */
export async function fetchOverviewQuotes(items: QuoteItem[], maxWaitMs = 1_500, demand?: { tracked: boolean }) {
  const normalized = items.map(normalizedMarketItem), namespace = quoteNamespace();
  if (!demand?.tracked) activeQuotes.observe(normalized, namespace);
  const fresh = sharedQuotes.peek(normalized, namespace);
  const hot = activeQuoteSnapshot(normalized, namespace);
  const lookup = readRequestedQuotes(normalized, namespace).catch(() => ({} as Record<string, Quote>));
  if (normalized.every(item => fresh[item.id])) return { quotes: fresh, pending: false, cached: [] as string[] };
  if (normalized.every(item => hot[item.id])) return { quotes: hot, pending: activeQuotes.refreshing(normalized, namespace), cached: Object.keys(hot).filter(id => hot[id].cached) };
  const cached = sharedQuotes.peek(normalized, namespace, 60_000);
  if (normalized.every(item => cached[item.id])) return { quotes: cached, pending: true, cached: Object.keys(cached) };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      lookup.then(quotes => ({ quotes: { ...cached, ...quotes }, pending: activeQuotes.refreshing(normalized, namespace),
        cached: [...new Set([...Object.keys(cached).filter(id => !quotes[id]), ...Object.keys(quotes).filter(id => quotes[id].cached)])] })),
      new Promise<{ quotes: Record<string, Quote>; pending: boolean; cached: string[] }>(resolve => {
        timer = setTimeout(() => {
          const quotes = sharedQuotes.peek(normalized, namespace, 60_000);
          const freshNow = sharedQuotes.peek(normalized, namespace);
          resolve({ quotes, pending: true, cached: Object.keys(quotes).filter(id => !freshNow[id]) });
        }, maxWaitMs);
      })
    ]);
    return result;
  } finally { clearTimeout(timer); }
}

async function fetchQuotesUnshared(items: QuoteItem[], publish: (item: QuoteItem, quote: Quote) => void): Promise<Record<string, Quote>> {
  const result: Record<string, Quote> = {};
  const signal = AbortSignal.timeout(5_000);
  const delivered = new Set<string>();
  const valid = (item: QuoteItem, q: Quote) => Number.isFinite(q.price) && q.price > 0 &&
    (q.session === "OVERNIGHT" || (q.source === "futu" && (q.session === "PRE" || q.session === "AFTER")) || item.market === "JP" || item.market === "KR" ||
      (q.volume ?? 0) !== 0 || (q.amount ?? 0) !== 0 || (q.change ?? 0) !== 0 || (q.changePct ?? 0) !== 0);
  const deliver = (item: QuoteItem) => {
    const quote = result[item.id];
    if (!quote || !valid(item, quote)) { delete result[item.id]; return; }
    if (!delivered.has(item.id)) { delivered.add(item.id); publish(item, quote); }
  };
  const tencent = async (rows: QuoteItem[], immediate = false) => {
    const bySymbol = new Map<string, QuoteItem[]>();
    for (const item of rows) {
      const symbol = toTencentSymbol(item.market, item.code);
      if (symbol) bySymbol.set(symbol, [...(bySymbol.get(symbol) || []), item]);
    }
    await waitForMarketTask(fetchBatch([...bySymbol.keys()], signal, (symbol, quote) => {
      if (signal.aborted) return;
      for (const item of bySymbol.get(symbol) || []) {
        result[item.id] = { ...quote, name: item.code, source: "tencent" };
        if (immediate) deliver(item);
      }
    }), signal).catch(() => {});
  };
  const crypto = async () => {
    await Promise.all(items.filter(item => item.market === "ASSET").map(async item => {
      const q = await waitForMarketTask(getCryptoQuote(item.code), signal).catch(() => null);
      if (q && !signal.aborted) {
        result[item.id] = { name: item.code, price: q.price, change: q.price * q.changePct / 100, changePct: q.changePct, open: q.price, high: q.price, low: q.price, time: new Date().toISOString(), marketCap: q.marketCap, source: "auto" };
        deliver(item);
      }
    }));
  };
  const us = async () => {
    const usItems = items.filter(item => item.market === "US");
    if (!usItems.length) return;
    const quoteSource = getSiteSettings().quoteSource || "auto";
    let futuReturnedAny = false;
    if (quoteSource !== "tencent") {
      try {
        // Includes queue wait and SDK execution; expired queued work never opens OpenD.
        const futuSignal = AbortSignal.any([signal, AbortSignal.timeout(2_500)]);
        const futuMap = await waitForMarketTask(fetchFutuQuotes(usItems, futuSignal), futuSignal);
        for (const [id, quote] of futuMap) result[id] = { ...quote, source: "futu" };
        futuReturnedAny = futuMap.size > 0;
      } catch { /* Preserve the established public-source fallback. */ }
    }
    const strictFutu = quoteSource === "futu" && futuReturnedAny;
    // A valid Futu extended quote is already authoritative. Yahoo only fills gaps.
    const authoritative = new Set(usItems.filter(item => result[item.id]?.source === "futu" && valid(item, result[item.id]) &&
      ["PRE", "AFTER", "OVERNIGHT"].includes(result[item.id]?.session || "")).map(item => item.id));
    for (const item of usItems) if (strictFutu || authoritative.has(item.id)) deliver(item);
    if (strictFutu) return;
    await tencent(usItems.filter(item => !result[item.id]));
    const byCode = new Map<string, QuoteItem[]>();
    for (const item of usItems) {
      if (authoritative.has(item.id)) continue;
      byCode.set(item.code, [...(byCode.get(item.code) || []), item]);
    }
    const codes = [...byCode.keys()];
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, codes.length) }, async () => {
      while (next < codes.length && !signal.aborted) {
        const code = codes[next++], rows = byCode.get(code)!;
        if (!result[rows[0].id]) {
          const fallback = await waitForMarketTask(fetchUsRegularQuote(code), signal).catch(() => null);
          if (fallback && !signal.aborted) for (const item of rows) result[item.id] = {
            name: item.code, price: fallback.price, change: fallback.change, changePct: fallback.changePct,
            open: fallback.price, high: fallback.high, low: fallback.low, prevClose: fallback.previousClose,
            session: "REGULAR", volume: fallback.volume, marketCap: fallback.marketCap, time: fallback.time, source: "yahoo"
          };
        }
        if (result[rows[0].id]) {
          const extended = await waitForMarketTask(fetchUsExtendedQuote(code), signal).catch(() => null);
          if (extended && !signal.aborted) for (const item of rows) {
            const change = extended.price - extended.previousClose;
            result[item.id] = { ...result[item.id], price: extended.price, prevClose: extended.previousClose,
              change, changePct: change / extended.previousClose * 100, time: `${extended.date} ${extended.time}:00`,
              session: extended.session, source: "yahoo" };
          }
        }
        for (const item of rows) deliver(item);
      }
    }));
  };
  // Each market has its own worker set. Slow HK symbols cannot occupy CN/JP/KR slots.
  const marketRows = new Map<Market, QuoteItem[]>();
  for (const item of items) if (item.market !== "US" && item.market !== "ASSET") {
    marketRows.set(item.market, [...(marketRows.get(item.market) || []), item]);
  }
  await waitForMarketTask(Promise.allSettled([
    crypto(), ...[...marketRows.values()].map(rows => tencent(rows, true)), us()
  ]), signal).catch(() => {});
  for (const item of items) deliver(item);
  return { ...result };
}

/* ---------- 股票搜索联想（腾讯 smartbox） ---------- */

function parseHintName(text: string): string {
  return text.replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function normalizeUsCode(code: string): string {
  const upper = code.toUpperCase();
  return upper.replace(US_EXCHANGE_SUFFIX, "");
}

function hintToMatch(parts: string[]): { symbol: string; code: string; name: string; market: Market } | null {
  if (parts.length < 5) return null;
  const [prefix, codeRaw, nameRaw, , type] = parts;
  if (!type.startsWith("GP")) return null;
  const name = parseHintName(nameRaw).trim();
  if (!name) return null;
  const code = prefix === "us" ? normalizeUsCode(codeRaw) : codeRaw.toUpperCase();
  if (prefix === "sh" || prefix === "sz" || prefix === "bj") {
    return { symbol: `${prefix}${codeRaw}`, code, name, market: "CN" };
  }
  if (prefix === "hk") return { symbol: `hk${codeRaw}`, code, name, market: "HK" };
  if (prefix === "us") return { symbol: `us${code}`, code, name, market: "US" };
  if (prefix === "jp") return { symbol: `jp${codeRaw}`, code, name, market: "JP" };
  if (prefix === "kr") return { symbol: `kr${codeRaw}`, code, name, market: "KR" };
  return null;
}

export async function searchStocks(q: string, limit = 8): Promise<SearchMatch[]> {
  const query = q.trim();
  if (!query) return [];
  // 富途搜索优先：OpenD 在线时直接返回带价格的结果；不可用 / 无结果回退腾讯 + 东财。
  const quoteSource = getSiteSettings().quoteSource || "auto";
  if (quoteSource !== "tencent") {
    try {
      const futuResults = await searchFutu(query, limit);
      if (futuResults.length > 0 || quoteSource === "futu") {
        // 富途搜索偶尔返回无价结果（尤其桥接超时/快照缺失）；缺价时用 fetchQuotes 补价，
        // 避免搜索联想出现「无价格」的无效项。
        const missingPrice = futuResults.some((r) => r.price == null || !Number.isFinite(r.price));
        if (missingPrice) {
          const quotes = await fetchQuotes(futuResults.map((h) => ({ id: h.symbol, market: h.market, code: h.code })));
          return futuResults.map((h) => ({ ...h, price: h.price ?? quotes[h.symbol]?.price ?? null, changePct: h.changePct ?? quotes[h.symbol]?.changePct ?? null }));
        }
        return futuResults;
      }
    } catch {
      if (quoteSource === "futu") return [];
      /* 回退腾讯 */
    }
  }
  const tpl = getSiteSettings().searchApiUrl || DEFAULT_SEARCH_URL;
  const res = await fetch(
    tpl.replace("{q}", encodeURIComponent(query)),
    {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
      signal: AbortSignal.timeout(8000)
    }
  );
  if (!res.ok) throw new Error(`搜索接口返回 ${res.status}`);
  const text = await res.text();
  const match = /v_hint="([^"]*)"/.exec(text);
  if (!match) return [];

  const hints = match[1].split("^")
    .map((entry) => entry.split("~"))
    .map(hintToMatch)
    .filter((m): m is NonNullable<typeof m> => m !== null)
    .slice(0, limit);
  // 腾讯联想按当前简称 / 代码 / 拼音匹配：改名股（如 西安旅游 → *ST西旅）或中文全称可能搜不到，
  // 兜底东方财富搜索联想（按全称 / 简称 / 代码，覆盖 A股 / 港股 / 美股）
  if (hints.length === 0) return searchEastMoney(query, limit);

  const quotes = await fetchQuotes(hints.map((h) => ({ id: h.symbol, market: h.market, code: h.code })));
  return hints.map((h) => {
    const q = quotes[h.symbol];
    return {
      ...h,
      price: q?.price ?? null,
      changePct: q?.changePct ?? null
    };
  });
}

/** 东方财富搜索联想：腾讯兜底源（西安旅游 → 000610 *ST西旅） */
async function searchEastMoney(q: string, limit = 8): Promise<SearchMatch[]> {
  const url = `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(q)}&type=14&token=${EASTMONEY_SEARCH_TOKEN}&count=${Math.min(limit, 10)}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      Referer: "https://www.eastmoney.com/"
    },
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) throw new Error(`东财联想返回 ${res.status}`);
  const data = (await res.json().catch(() => null)) as {
    QuotationCodeTable?: { Data?: { Code?: string; Name?: string; SecurityTypeName?: string }[] };
  } | null;
  const rows = data?.QuotationCodeTable?.Data ?? [];
  const hints: { symbol: string; code: string; name: string; market: Market }[] = [];
  for (const r of rows) {
    const code = String(r.Code ?? "").trim().toUpperCase();
    const name = String(r.Name ?? "").trim();
    const st = String(r.SecurityTypeName ?? "");
    let market: Market | null = null;
    let symbol = "";
    if (/沪|深|京/.test(st)) {
      market = "CN";
      symbol = /^(4|8|920)/.test(code) ? `bj${code}` : /^[69]/.test(code) ? `sh${code}` : /^[0-3]/.test(code) ? `sz${code}` : `bj${code}`;
    } else if (st.includes("港")) {
      market = "HK";
      symbol = `hk${code.padStart(5, "0")}`;
    } else if (st.includes("美")) {
      market = "US";
      symbol = `us${code.replace(US_EXCHANGE_SUFFIX, "")}`;
    } else if (/日|东京/.test(st)) {
      market = "JP";
      symbol = `jp${code.replace(/\.T$/, "")}`;
    } else if (/韩|韩国/.test(st)) {
      market = "KR";
      symbol = `kr${code.replace(/\.(KS|KQ)$/, "")}`;
    }
    if (!market || !code || !name) continue;
    hints.push({ symbol, code, name, market });
  }
  if (hints.length === 0) return [];
  const quotes = await fetchQuotes(hints.map((h) => ({ id: h.symbol, market: h.market, code: h.code })));
  return hints.slice(0, limit).map((h) => ({
    ...h,
    price: quotes[h.symbol]?.price ?? null,
    changePct: quotes[h.symbol]?.changePct ?? null
  }));
}

/* ---------- 当日分时走势（迷你图） ---------- */

export interface IntradayPoint {
  time: string;
  price: number;
  volume?: number;
}

export interface Intraday {
  date: string;
  points: IntradayPoint[];
  stale?: boolean;
  source?: "futu" | "tencent" | "eastmoney" | "yahoo";
}


/** 迷你走势抽样：每个区间保留高低点与首尾，避免等距抽样漏掉短暂尖峰。 */
export function samplePoints(points: IntradayPoint[], target = 60): IntradayPoint[] {
  if (!Array.isArray(points)) return points;
  if (points.length <= target) return points;
  const limit = Math.max(4, Math.floor(target));
  const middleCount = points.length - 2;
  const bucketCount = Math.max(1, Math.floor((limit - 2) / 2));
  const out = [points[0]];
  for (let bucket = 0; bucket < bucketCount; bucket++) {
    const start = 1 + Math.floor((bucket * middleCount) / bucketCount);
    const end = 1 + Math.floor(((bucket + 1) * middleCount) / bucketCount);
    let minIndex = start;
    let maxIndex = start;
    for (let index = start + 1; index < end; index++) {
      if (points[index].price < points[minIndex].price) minIndex = index;
      if (points[index].price > points[maxIndex].price) maxIndex = index;
    }
    if (minIndex === maxIndex) out.push(points[minIndex]);
    else if (minIndex < maxIndex) out.push(points[minIndex], points[maxIndex]);
    else out.push(points[maxIndex], points[minIndex]);
  }
  out.push(points[points.length - 1]);
  return out;
}

/** Bound proxy preparation, headers and body reads, even if a source ignores cancellation. */
async function intradayDeadline<T>(milliseconds: number, work: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason ?? new Error("intraday cancelled"));
  if (parent?.aborted) abort(); else parent?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error("intraday source deadline")), milliseconds);
  try { controller.signal.throwIfAborted(); return await waitForMarketTask(work(controller.signal), controller.signal); }
  finally { clearTimeout(timeout); parent?.removeEventListener("abort", abort); controller.abort(); }
}

function normalizeIntraday(value: Intraday | null | undefined, item: QuoteItem): Intraday | null {
  if (!value || typeof value.date !== "string" || !Array.isArray(value.points)) return null;
  const rawDate = value.date.replace(/-/g, "");
  if (!/^\d{8}$/.test(rawDate)) return null;
  const date = `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6)}`;
  const parsed = new Date(`${date}T12:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return null;
  const state = marketSessionState(item.market);
  if (date > state.localDate) return null;
  const points = new Map<string, IntradayPoint>();
  for (const point of value.points ?? []) {
    if (!point || typeof point.time !== "string") continue;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(point.time) || !Number.isFinite(point.price) || point.price <= 0) continue;
    if (item.market === "US" && (point.time < "04:00" || point.time >= "20:00")) continue;
    points.set(point.time, { ...point });
  }
  if (points.size < 2) return null;
  const expected = state.pnlSettled || state.session === "overnight" ? state.settlementDate : state.localDate;
  return { ...value, date, points: [...points.values()].sort((a, b) => a.time.localeCompare(b.time)),
    ...(value.stale || date < expected ? { stale: true } : {}) };
}

async function chartJson(url: string, signal: AbortSignal, proxied = false): Promise<any> {
  return waitForMarketTask((async () => {
    const response = await (proxied ? proxyFetch : fetch)(url, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" }, signal
    });
    if (!response.ok) throw new Error("intraday source unavailable");
    return readLimitedResponseJson(response, 4 * 1024 * 1024);
  })(), signal);
}

function minuteQueryCodes(item: QuoteItem): string[] {
  const c = item.code.trim().toUpperCase();
  switch (item.market) {
    case "CN": return [`${/^(4|8|920)/.test(c) ? "bj" : /^[69]/.test(c) ? "sh" : "sz"}${c}`];
    case "HK": return [`hk${c.padStart(5, "0")}`];
    case "US": return [`us${c}`, `us${c}.OQ`, `us${c}.N`];
    case "JP": return [`jp${c.replace(/\.T$/, "")}`];
    case "KR": return [`kr${c.replace(/\.(KS|KQ)$/, "")}`];
    default: return [];
  }
}

async function tencentIntraday(item: QuoteItem, signal: AbortSignal): Promise<Intraday | null> {
  const codes = minuteQueryCodes(item), template = getSiteSettings().chartApiUrl || DEFAULT_CHART_URL;
  if (!codes.length) return null;
  try {
    return await intradayDeadline(2500, async sourceSignal => Promise.any(codes.map(async code => {
      const json = await chartJson(template.replace("{code}", encodeURIComponent(code)), sourceSignal);
      const node = json?.data?.[code]?.data;
      const points: IntradayPoint[] = (Array.isArray(node?.data) ? node.data : []).flatMap((row: unknown) => {
        if (typeof row !== "string") return [];
        const [time, price, volume] = row.trim().split(/\s+/);
        return [{ time: time?.length === 4 ? `${time.slice(0, 2)}:${time.slice(2)}` : time, price: Number(price), volume: Number(volume) || 0 }];
      });
      const value = normalizeIntraday({ date: String(node?.date ?? ""), points, source: "tencent" }, item);
      if (!value) throw new Error("empty tencent chart");
      return value;
    })), signal);
  } catch { return null; }
}

function eastmoneySymbols(item: QuoteItem): string[] {
  if (item.market === "CN" && /^\d{6}$/.test(item.code)) return [`${/^[69]/.test(item.code) ? 1 : 0}.${item.code}`];
  if (item.market === "HK" && /^\d{5}$/.test(item.code)) return [`116.${item.code}`];
  if (item.market === "US") return [105, 106, 107].map(market => `${market}.${item.code}`);
  return [];
}

async function eastmoneyIntraday(item: QuoteItem, signal: AbortSignal): Promise<Intraday | null> {
  const symbols = eastmoneySymbols(item);
  if (!symbols.length) return null;
  try {
    return await intradayDeadline(2500, async sourceSignal => Promise.any(symbols.map(async symbol => {
      const query = `secid=${encodeURIComponent(symbol)}&fields1=f1,f2,f3,f4,f5&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ndays=1&iscr=1`;
      const json = await chartJson(`https://push2his.eastmoney.com/api/qt/stock/trends2/get?${query}`, sourceSignal);
      // secid guesses are admitted only after upstream confirms the exact symbol.
      if (String(json?.data?.code ?? "").toUpperCase() !== item.code) throw new Error("different eastmoney security");
      const rows: string[] = Array.isArray(json?.data?.trends) ? json.data.trends.filter((row: unknown) => typeof row === "string") : [];
      const date = rows.map(row => row.slice(0, 10)).sort().at(-1) ?? "";
      const points = rows.filter(row => row.slice(0, 10) === date).map(row => {
        const cells = row.split(",");
        return { time: cells[0].slice(11, 16), price: Number(cells[2]), volume: Number(cells[5]) || 0 };
      });
      const value = normalizeIntraday({ date, points, source: "eastmoney" }, item);
      if (!value) throw new Error("empty eastmoney chart");
      return value;
    })), signal);
  } catch { return null; }
}

function yahooMinuteSymbols(item: QuoteItem) {
  const code = item.code;
  if (item.market === "US") return [code];
  if (item.market === "HK") return [`${code.replace(/^0+/, "").padStart(4, "0")}.HK`];
  if (item.market === "CN") return /^[69]/.test(code) ? [`${code}.SS`] : /^[0-3]/.test(code) ? [`${code}.SZ`] : [];
  if (item.market === "JP") return [`${code}.T`];
  if (item.market === "KR") return [`${code}.KS`, `${code}.KQ`];
  if (item.market === "SG") return [`${code}.SI`];
  return [];
}

async function yahooIntraday(item: QuoteItem, signal: AbortSignal): Promise<Intraday | null> {
  const symbols = yahooMinuteSymbols(item);
  if (!symbols.length) return null;
  try {
    return await intradayDeadline(2500, async sourceSignal => Promise.any(symbols.flatMap(symbol =>
      ["query1.finance.yahoo.com", "query2.finance.yahoo.com"].map(async (host, index) => {
        if (index) await waitForMarketTask(new Promise<void>(resolve => setTimeout(resolve, 200)), sourceSignal);
        sourceSignal.throwIfAborted();
        const json = await chartJson(`https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d&includePrePost=${item.market === "US"}&events=div%2Csplits`, sourceSignal, true);
        const chart = json?.chart?.result?.[0], quote = chart?.indicators?.quote?.[0];
        if (String(chart?.meta?.symbol ?? "").toUpperCase() !== symbol.toUpperCase()) throw new Error("different yahoo security");
        const timeZone = chart?.meta?.exchangeTimezoneName || (item.market === "US" ? "America/New_York" : "UTC");
        const formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
        const rows = (Array.isArray(chart?.timestamp) ? chart.timestamp : []).map((stamp: number, i: number) => {
          const parts = Object.fromEntries(formatter.formatToParts(new Date(stamp * 1000)).map(p => [p.type, p.value]));
          return { date: `${parts.year}-${parts.month}-${parts.day}`, point: { time: `${parts.hour}:${parts.minute}`, price: Number(quote?.close?.[i]), volume: Number(quote?.volume?.[i]) || 0 } };
        });
        const date = rows.map((row: { date: string }) => row.date).sort().at(-1) ?? "";
        const value = normalizeIntraday({ date, points: rows.filter((row: { date: string }) => row.date === date).map((row: { point: IntradayPoint }) => row.point), source: "yahoo" }, item);
        if (!value) throw new Error("empty yahoo chart");
        return value;
      }))), signal);
  } catch { return null; }
}

export async function fetchIntraday(items: QuoteItem[]): Promise<Record<string, Intraday>> {
  const settings = getSiteSettings();
  // OpenD recovery must not remain behind a still-fresh lower-priority chart cache.
  let futuAvailable = false;
  if (items.some(item => ["US", "HK", "CN"].includes(item.market))) {
    try { futuAvailable = await intradayDeadline(1000, signal => waitForMarketTask(isFutuAvailable(1000), signal)); } catch { /* Bound discovery too. */ }
  }
  const namespace = JSON.stringify([settings.chartApiUrl, settings.futuHost, settings.futuPort, futuAvailable, process.env.STOCKLOG_FUTU, process.env.STOCKLOG_PROXY]);
  return sharedCharts.fetch(items.map(normalizedMarketItem), namespace, fetchIntradayUnshared,
    chart => !futuAvailable || chart.source === "futu");
}

async function fetchIntradayUnshared(items: QuoteItem[], publish: (item: QuoteItem, value: Intraday) => void): Promise<Record<string, Intraday>> {
  const result: Record<string, Intraday> = Object.create(null);
  try {
    await intradayDeadline(14000, async signal => {
      let futu: Record<string, Intraday> = {};
      try { futu = await intradayDeadline(3500, sourceSignal => fetchFutuIntraday(items, sourceSignal), signal); } catch { /* Next supported source. */ }
      const missing: Array<{ item: QuoteItem; fallback: Intraday | null }> = [];
      for (const item of items) {
        const value = normalizeIntraday(futu[item.id], item);
        if (value && !value.stale) { result[item.id] = value; publish(item, value); }
        else missing.push({ item, fallback: value });
      }
      // Bounded workers; finished instruments release joined Web/App reads immediately.
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(12, missing.length) }, async () => {
        while (next < missing.length && !signal.aborted) {
          const { item, fallback } = missing[next++];
          let retained = fallback;
          for (const provider of [tencentIntraday, eastmoneyIntraday, yahooIntraday]) {
            signal.throwIfAborted();
            const value = await provider(item, signal);
            signal.throwIfAborted();
            if (!value) continue;
            if (value.stale) { if (!retained || value.date > retained.date) retained = value; continue; }
            result[item.id] = value; publish(item, value); retained = null; break;
          }
          if (!result[item.id] && retained) { result[item.id] = retained; publish(item, retained); }
        }
      }));
    });
  } catch { /* Return only completed actual data; no late task can publish after expiry. */ }
  if (!Object.keys(result).length && items.some(item => minuteQueryCodes(item).length || yahooMinuteSymbols(item).length)) {
    throw new Error("intraday sources unavailable");
  }
  return result;
}

/* ---------- 大盘指数 ---------- */

export interface IndexQuote {
  name: string;
  open: number | null;
  latest: number | null;
  changePct: number | null;
  time: string;
  extra?: string;
}

export interface MarketIndices {
  market: Market;
  label: string;
  flag: string;
  open: boolean;
  indices: IndexQuote[];
}

/* ---------- 市场开市判断（用于实时圆点） ---------- */

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** 取指定时区的星期与分钟（当地时间） */
function tzParts(now: Date, timeZone: string): { day: number; minute: number } {
  const parts: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(now)) {
    parts[p.type] = p.value;
  }
  const hour = Number(parts.hour || "0") % 24;
  return {
    day: WEEKDAY[parts.weekday || ""] ?? 0,
    minute: hour * 60 + Number(parts.minute || "0")
  };
}

function inWindows(minute: number, windows: [number, number][]): boolean {
  return windows.some(([start, end]) => minute >= start && minute < end);
}

/** 判断市场当前是否处于交易时段（本地时间） */
export function isMarketOpen(market: Market, now = new Date()): boolean {
  const zone = market === "US" || market === "F&G" ? "America/New_York" : "Asia/Shanghai";
  const { day, minute } = tzParts(now, zone);
  if (day === 0 || day === 6) return false; // 周末休市
  switch (market) {
    case "US":
    case "F&G":
      return inWindows(minute, [[570, 960]]); // 09:30-16:00 美东
    case "HK":
      return inWindows(minute, [[570, 720], [780, 960]]); // 09:30-12:00, 13:00-16:00
    case "CN":
      return inWindows(minute, [[570, 690], [780, 900]]); // 09:30-11:30, 13:00-15:00
    case "JP":
      return inWindows(minute, [[540, 690], [750, 900]]); // 09:00-11:30, 12:30-15:00
    case "KR":
      return inWindows(minute, [[540, 930]]); // 09:00-15:30
    default:
      return false;
  }
}

const INDEX_SYMBOLS: { market: Market; symbols: string[] }[] = [
  { market: "US", symbols: ["usIXIC", "usINX"] },
  { market: "HK", symbols: ["hkHSI", "hkHSTECH"] },
  { market: "CN", symbols: ["sh000001", "sz399001"] },
  { market: "F&G", symbols: [] }
];

// 腾讯接口返回的中文名补充/修正（如 usIXIC 只返回「纳斯达克」）
const INDEX_NAME_OVERRIDES: Record<string, string> = {
  usIXIC: "纳斯达克综合指数"
};

const FG_RATINGS: Record<string, string> = {
  "extreme fear": "极度恐惧",
  fear: "恐惧",
  neutral: "中性",
  greed: "贪婪",
  "extreme greed": "极度贪婪"
};

// CNN 恐惧与贪婪指数
async function fetchFearGreed(): Promise<IndexQuote | null> {
  try {
    const res = await fetch("https://production.dataviz.cnn.io/index/fearandgreed/graphdata", {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36",
        Accept: "application/json, text/plain, */*",
        Origin: "https://edition.cnn.com",
        Referer: "https://edition.cnn.com/markets/fear-and-greed"
      },
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    const fg = data?.fear_and_greed;
    if (!fg || typeof fg.score !== "number") return null;
    const prev = typeof fg.previous_close === "number" ? fg.previous_close : null;
    const rating = FG_RATINGS[String(fg.rating).toLowerCase()] || String(fg.rating || "");
    return {
      name: "恐惧与贪婪指数",
      open: prev,
      latest: Math.round(fg.score * 10) / 10,
      changePct: prev ? ((fg.score - prev) / prev) * 100 : null,
      time: String(fg.timestamp || ""),
      extra: rating
    };
  } catch {
    return null;
  }
}

export async function fetchIndices(): Promise<MarketIndices[]> {
  const savedOrder = getSiteSettings().indicesOrder;
  const symbols = INDEX_SYMBOLS.filter((g) => g.market !== "F&G").flatMap((g) => g.symbols);
  const now = new Date();
  // 腾讯行情与 CNN 恐惧贪婪并行请求，任一失败不阻塞整体
  const [quotes, fg] = await Promise.all([
    fetchBatch(symbols).catch(() => new Map<string, Quote>()),
    fetchFearGreed().catch(() => null)
  ]);
  const groups: MarketIndices[] = INDEX_SYMBOLS.map((g) => {
    if (g.market === "F&G") {
      return {
        market: g.market,
        label: "恐惧与贪婪指数",
        flag: "🧠",
        open: isMarketOpen("F&G", now),
        indices: [] as IndexQuote[]
      };
    }
    return {
      market: g.market,
      label: MARKET_META[g.market].label,
      flag: MARKET_META[g.market].flag,
      open: isMarketOpen(g.market, now),
      indices: g.symbols.map((s) => {
        const q = quotes.get(s);
        return q
          ? { name: INDEX_NAME_OVERRIDES[s] || q.name, open: q.open, latest: q.price, changePct: q.changePct, time: q.time }
          : { name: s, open: null, latest: null, changePct: null, time: "" };
      })
    };
  });
  const fgGroup = groups.find((g) => g.market === "F&G");
  if (fgGroup && fg) fgGroup.indices = [fg];
  if (fgGroup && !fg) fgGroup.indices = [];
  // 应用用户自定义顺序（缺失的市场按默认顺序补在末尾）
  if (savedOrder.length > 0) {
    const seen = new Set<string>();
    const ordered = savedOrder
      .map((m) => groups.find((g) => g.market === m))
      .filter((g): g is MarketIndices => {
        if (!g || seen.has(g.market)) return false;
        seen.add(g.market);
        return true;
      });
    groups.forEach((g) => {
      if (!seen.has(g.market)) ordered.push(g);
    });
    return ordered;
  }
  return groups;
}
