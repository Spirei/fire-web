import { MARKET_META, type Market, type SearchMatch } from "./types";
import { getSiteSettings } from "./settings";
import { fetchUsExtendedQuote } from "./usExtendedQuote";
import { fetchFutuQuotes, searchFutu } from "./futuQuotes";
import { getCryptoQuote } from "./assetQuotes";
import { proxyFetch } from "./net";

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
  /** 上一常规交易日收盘价。 */
  prevClose?: number;
  /** PRE / AFTER 表示当前 price 已切换为扩展时段有效价。 */
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
    default:
      return "";
  }
}

function parseLine(line: string): { symbol: string; fields: string[] } | null {
  const match = /v_([^=]+)="([^"]*)"/.exec(line);
  if (!match) return null;
  return { symbol: match[1], fields: match[2].split("~") };
}

export async function fetchBatch(symbols: string[]): Promise<Map<string, Quote>> {
  if (symbols.length === 0) return new Map();
  const base = getSiteSettings().quoteApiUrl || DEFAULT_QUOTE_URL;
  const map = new Map<string, Quote>();
  // 腾讯行情接口当前每次请求只返回第一条（批量已失效），改为并发逐条请求
  const CONCURRENCY = 6;
  for (let i = 0; i < symbols.length; i += CONCURRENCY) {
    const batch = symbols.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (symbol) => {
        try {
          const res = await fetch(base + symbol, {
            headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
            signal: AbortSignal.timeout(8000)
          });
          if (!res.ok) return;
          const buffer = await res.arrayBuffer();
          let text: string;
          try {
            text = new TextDecoder("gbk").decode(buffer);
          } catch {
            text = new TextDecoder("utf-8").decode(buffer);
          }
          const parsed = parseLine(text);
          if (!parsed || parsed.fields.length < 35) return;
          const f = parsed.fields;
          const price = Number(f[3]);
          if (!price) return;
          // 无效代码会被行情源模糊匹配成某个“幽灵”证券：成交量/成交额、涨跌、涨跌幅全为 0，且时间停留在很久以前。
          // 这类占位行情不是真实股价，直接丢弃，避免“不存在股票却显示股价/市场图标/旧日期”。
          const change = Number(f[31]) || 0;
          const changePct = Number(f[32]) || 0;
          const volume = Number(f[36]) || 0;
          const amount = Number(f[37]) || 0;
          if (volume === 0 && change === 0 && changePct === 0 && amount === 0) return;
          map.set(parsed.symbol, {
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
          });
        } catch {
          /* 单条失败不影响其他 */
        }
      })
    );
  }
  return map;
}

export async function fetchQuotes(items: QuoteItem[]): Promise<Record<string, Quote>> {
  const result: Record<string, Quote> = {};
  const cryptoItems = items.filter((item) => item.market === "ASSET");
  await Promise.all(cryptoItems.map(async (item) => {
    const q = await getCryptoQuote(item.code);
    if (q) result[item.id] = { name: item.code, price: q.price, change: q.price * q.changePct / 100, changePct: q.changePct, open: q.price, high: q.price, low: q.price, time: new Date().toISOString(), marketCap: q.marketCap, source: "auto" };
  }));
  const quoteSource = getSiteSettings().quoteSource || "auto";
  const usItems = items.filter((item) => item.market === "US");
  const nonUsItems = items.filter((item) => item.market !== "US" && item.market !== "ASSET");

  // 美股主行情走富途 OpenAPI（盘前/盘后/夜盘口径统一，支持 24 小时行情）；
  // 港股/A股直接走腾讯（更成熟稳定，且避免与美股混批导致富途桥接超时拖垮整体）。
  if (quoteSource !== "tencent" && usItems.length > 0) {
    try {
      const futuMap = await fetchFutuQuotes(usItems);
      futuMap.forEach((quote, id) => {
        result[id] = { ...quote, source: "futu" };
      });
    } catch {
      /* 富途失败按配置处理 */
    }
  }

  const missing = [...nonUsItems, ...usItems].filter((item) => !result[item.id]);
  // 强制富途：美股不回退腾讯/Yahoo（OpenD 不可用时美股返回空）；港股/A股仍走腾讯（更成熟稳定）
  const tencentMissing = quoteSource === "futu" ? missing.filter((item) => item.market !== "US") : missing;
  const symbolMap = new Map<string, QuoteItem[]>();

  tencentMissing.forEach((item) => {
    const symbol = toTencentSymbol(item.market, item.code);
    if (!symbol) return;
    const list = symbolMap.get(symbol) || [];
    list.push(item);
    symbolMap.set(symbol, list);
  });

  const symbols = [...symbolMap.keys()];
  const CHUNK = 45;
  for (let i = 0; i < symbols.length; i += CHUNK) {
    const chunk = symbols.slice(i, i + CHUNK);
    const quotes = await fetchBatch(chunk);
    chunk.forEach((symbol) => {
      const quote = quotes.get(symbol);
      if (!quote) return;
      symbolMap.get(symbol)!.forEach((item) => {
        result[item.id] = { ...quote, name: item.code, source: "tencent" };
      });
    });
  }
  if (quoteSource === "futu") return result;

  // 美股盘前/盘后统一覆盖有效价与涨跌口径。失败时保留腾讯常规盘行情，不影响整批。
  // 按代码去重（同一只股可能同时出现在持仓与自选），并把并发从 6 降到 4，降低 Yahoo 限流概率。
  const usMissing = missing.filter((item) => item.market === "US" && result[item.id]);
  if (usMissing.length > 0) {
    const byCode = new Map<string, typeof usMissing>();
    for (const item of usMissing) {
      const code = item.code.toUpperCase().replace(US_EXCHANGE_SUFFIX, "");
      const list = byCode.get(code) || [];
      list.push(item);
      byCode.set(code, list);
    }
    const codes = [...byCode.keys()];
    const CONCURRENCY = 4;
    const extendedMap = new Map<string, Awaited<ReturnType<typeof fetchUsExtendedQuote>>>();
    for (let i = 0; i < codes.length; i += CONCURRENCY) {
      await Promise.all(codes.slice(i, i + CONCURRENCY).map(async (code) => {
        const extended = await fetchUsExtendedQuote(code);
        extendedMap.set(code, extended);
      }));
    }
    for (const [code, list] of byCode) {
      const extended = extendedMap.get(code);
      if (!extended) continue;
      list.forEach((item) => {
        if (!result[item.id]) return;
        // 扩展时段（盘前/盘后）统一以扩展行情自带的最近常规收盘价为基准：
        // 腾讯在盘前刚开始时仍返回上一交易日的「昨收」，直接用它会把昨日涨跌混进当日盈亏。
        const previousClose = extended.previousClose;
        const change = extended.price - previousClose;
        result[item.id] = {
          ...result[item.id],
          price: extended.price,
          prevClose: previousClose,
          change,
          changePct: change / previousClose * 100,
          time: `${extended.date} ${extended.time}:00`,
          session: extended.session,
          source: "yahoo"
        };
      });
    }
  }
  // 统一清洗：行情源（富途/腾讯/Yahoo）对无效代码可能返回“幽灵”行情——
  // 成交量/成交额、涨跌、涨跌幅全为 0。这类不是真实股价，剔除后详情页可正常显示“无数据”。
  Object.keys(result).forEach((id) => {
    const q = result[id];
    if (!q) return;
    if ((q.volume ?? 0) === 0 && (q.amount ?? 0) === 0 && (q.change ?? 0) === 0 && (q.changePct ?? 0) === 0) {
      delete result[id];
    }
  });
  return result;
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
}

const yahooIntradayCache = new Map<string, { at: number; data: Intraday }>();
const tencentIntradayCache = new Map<string, { at: number; data: Intraday }>();

/** 迷你走势抽样：只保留 target 个代表点（等距取，首尾必留），供批量迷你 sparkline 使用。 */
export function samplePoints(points: IntradayPoint[], target = 60): IntradayPoint[] {
  if (!Array.isArray(points)) return points;
  if (points.length <= target) return points;
  const step = (points.length - 1) / (target - 1);
  const out: IntradayPoint[] = [];
  for (let i = 0; i < target; i++) {
    const idx = Math.round(i * step);
    out.push(points[Math.min(idx, points.length - 1)]);
  }
  return out;
}

function minuteQueryCodes(item: QuoteItem): string[] {
  const c = item.code.trim().toUpperCase();
  switch (item.market) {
    case "CN": {
      if (/^(4|8|920)/.test(c)) return [`bj${c}`]; // 北交所：4xx / 8xx / 920xxx
      if (/^[69]/.test(c)) return [`sh${c}`];
      if (/^[0-3]/.test(c)) return [`sz${c}`];
      return [`bj${c}`];
    }
    case "HK":
      return [`hk${c.padStart(5, "0")}`];
    case "US":
      return [`us${c.replace(US_EXCHANGE_SUFFIX, "")}`, `us${c}.OQ`, `us${c}.N`];
    default:
      return [];
  }
}

function parseMinutePoints(raw: unknown[]): IntradayPoint[] {
  const points: IntradayPoint[] = [];
  for (const row of raw) {
    if (typeof row !== "string") continue;
    const parts = row.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const time = parts[0];
    const price = Number(parts[1]);
    if (!price || !time) continue;
    points.push({
      time: time.length === 4 ? `${time.slice(0, 2)}:${time.slice(2)}` : time,
      price,
      volume: Number(parts[2]) || 0
    });
  }
  return points;
}

async function fetchIntradayForCode(code: string): Promise<Intraday | null> {
  const cached = tencentIntradayCache.get(code);
  if (cached && Date.now() - cached.at < 30_000) return cached.data;
  const tpl = getSiteSettings().chartApiUrl || DEFAULT_CHART_URL;
  const res = await fetch(
    tpl.replace("{code}", encodeURIComponent(code)),
    {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
      signal: AbortSignal.timeout(8000)
    }
  );
  if (!res.ok) return null;
  const json = await res.json().catch(() => null);
  const node = json?.data?.[code]?.data;
  if (!node || typeof node !== "object") return null;
  const raw = Array.isArray(node.data) ? node.data : null;
  const date = typeof node.date === "string" ? node.date : "";
  if (!raw || raw.length === 0) return null;
  const points = parseMinutePoints(raw);
  if (points.length === 0) return null;
  const data = { date, points };
  tencentIntradayCache.set(code, { at: Date.now(), data });
  return data;
}

function yahooMinuteSymbols(item: QuoteItem) {
  const code = item.code.trim().toUpperCase();
  if (item.market === "US") return [code.replace(US_EXCHANGE_SUFFIX, "")];
  if (item.market === "HK") return [`${code.replace(/^0+/, "").padStart(4, "0")}.HK`];
  if (item.market === "CN") {
    if (/^[69]/.test(code)) return [`${code}.SS`];
    if (/^[0-3]/.test(code)) return [`${code}.SZ`];
    return [];
  }
  if (item.market === "JP") return [`${code}.T`];
  if (item.market === "KR") return [`${code}.KS`, `${code}.KQ`];
  if (item.market === "SG") return [`${code}.SI`];
  return [];
}

async function fetchYahooIntraday(item: QuoteItem): Promise<Intraday | null> {
  const key = `${item.market}:${item.code.trim().toUpperCase()}`;
  const cached = yahooIntradayCache.get(key);
  if (cached && Date.now() - cached.at < 30_000) return cached.data;
  for (const symbol of yahooMinuteSymbols(item)) try {
    // Yahoo 属境外源：走可选代理（STOCKLOG_PROXY），代理不可达自动回退直连
    const response = await proxyFetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d&includePrePost=${item.market === "US" ? "true" : "false"}&events=div%2Csplits`, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" }, signal: AbortSignal.timeout(12_000)
    });
    if (!response.ok) continue;
    const chart = (await response.json())?.chart?.result?.[0];
    const timestamps: number[] = Array.isArray(chart?.timestamp) ? chart.timestamp : [];
    const quote = chart?.indicators?.quote?.[0] || {};
    const closes: Array<number | null> = Array.isArray(quote.close) ? quote.close : [];
    const volumes: Array<number | null> = Array.isArray(quote.volume) ? quote.volume : [];
    const points: IntradayPoint[] = [];
    let date = "";
    const timeZone = typeof chart?.meta?.exchangeTimezoneName === "string" ? chart.meta.exchangeTimezoneName : item.market === "US" ? "America/New_York" : "UTC";
    timestamps.forEach((timestamp, index) => {
      const price = Number(closes[index]);
      if (!Number.isFinite(price) || price <= 0) return;
      const parts: Record<string, string> = {};
      new Intl.DateTimeFormat("en-CA", {
        timeZone, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hour12: false
      }).formatToParts(new Date(timestamp * 1000)).forEach((part) => { parts[part.type] = part.value; });
      const hour = Number(parts.hour) % 24;
      const minute = hour * 60 + Number(parts.minute);
      if (item.market === "US" && (minute < 240 || minute >= 1200)) return;
      date = `${parts.year}-${parts.month}-${parts.day}`;
      points.push({ time: `${String(hour).padStart(2, "0")}:${parts.minute}`, price, volume: Number(volumes[index]) || 0 });
    });
    if (points.length < 2) continue;
    const data = { date, points };
    yahooIntradayCache.set(key, { at: Date.now(), data });
    return data;
  } catch {
    continue;
  }
  return null;
}

export async function fetchIntraday(items: QuoteItem[]): Promise<Record<string, Intraday>> {
  const result: Record<string, Intraday> = {};
  const grouped = new Map<string, QuoteItem[]>();
  items.forEach((item) => {
    if (item.market === "US") return;
    minuteQueryCodes(item).forEach((code) => {
      const list = grouped.get(code) || [];
      list.push(item);
      grouped.set(code, list);
    });
  });

  const codes = [...grouped.keys()];
  const CHUNK = 12;
  for (let i = 0; i < codes.length; i += CHUNK) {
    const chunk = codes.slice(i, i + CHUNK);
    await Promise.all(
      chunk.map(async (code) => {
        const data = await fetchIntradayForCode(code);
        if (data) {
          grouped.get(code)!.forEach((item) => {
            if (!result[item.id] || data.points.length > result[item.id].points.length) {
              result[item.id] = data;
            }
          });
        }
      })
    );
  }
  // 腾讯分钟行情缺失时统一回退 Yahoo；美股直接使用 Yahoo（覆盖盘前 / 盘中 / 盘后）。
  const fallbackGroups = new Map<string, QuoteItem[]>();
  items.filter((item) => !result[item.id]).forEach((item) => {
    if (!yahooMinuteSymbols(item).length) return;
    const key = `${item.market}:${item.code.trim().toUpperCase()}`;
    const list = fallbackGroups.get(key) || [];
    list.push(item); fallbackGroups.set(key, list);
  });
  const fallbackKeys = [...fallbackGroups.keys()];
  for (let i = 0; i < fallbackKeys.length; i += 6) {
    await Promise.all(fallbackKeys.slice(i, i + 6).map(async (key) => {
      const matches = fallbackGroups.get(key)!;
      const data = await fetchYahooIntraday(matches[0]);
      if (data) matches.forEach((item) => { result[item.id] = data; });
    }));
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
