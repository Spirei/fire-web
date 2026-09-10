/* ---------- 日 K 数据层（Web / iOS 共用） ----------
 *
 * 个股详情页的 K 线数据统一从这里拉取（/api/kline/full 与 /api/v1/stock-detail 共用），
 * 保证 Web 与移动端拿到同一份解析规则与缓存：
 *   - 美股：Yahoo 日 K（拆股复权）→ 新浪兜底；周/月/季/年K 另走富途周期K（前复权精确）
 *   - 港股 / A股 / 日股 / 韩股：腾讯前复权日 K（fqkline，qfq）
 *   - 资产分析 / 名人持仓的少量基准指数（SPY/QQQ/DIA/02800）优先本地富途 OpenD 日 K，
 *     避免外网源（Yahoo / 新浪 / 腾讯）限流或失效导致基准空数据；失败才回退原链路。
 * 行格式统一为 KlineItem[]（d / o / h / l / c / v），与前端 ECharts candlestick 维度
 * [open, close, lowest, highest] 对应。
 */

import { fetchFutuDailyKline } from "./futuQuotes";
import { proxyFetch } from "./net";

export interface KlineItem {
  d: string; // YYYY-MM-DD
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

const cache = new Map<string, { items: KlineItem[]; at: number }>();
const CACHE_TTL = 10 * 60 * 1000;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";

// 资产分析 / 名人持仓收益率对比基准用到的“指数”（少量标的，SPY/QQQ/DIA 为美股指数 ETF，02800 为恒指 ETF）。
// 这类少量标的优先走本地富途 OpenD 日 K（不受外网源限流 / 新浪失效影响），失败再回退到原 Yahoo/腾讯链。
const FUTU_BENCHMARK: Record<string, Set<string>> = {
  US: new Set(["SPY", "QQQ", "DIA"]),
  HK: new Set(["02800"])
};

function isFutuBenchmark(market: string, code: string): boolean {
  const set = FUTU_BENCHMARK[market.toUpperCase()];
  return !!set && set.has(code.toUpperCase());
}

/** 富途日 K 的复权参数：无 none 选项（富途仅 qfq/hfq），非 hfq 一律按 qfq 前复权。 */
function futuAutype(adjust: "qfq" | "none" | "hfq"): "qfq" | "hfq" {
  return adjust === "hfq" ? "hfq" : "qfq";
}

/** 市场 + 代码 → 腾讯行情代码（us / hk / sh / sz / bj / jp / kr 前缀） */
export function tencentSymbol(market: string, code: string, index = false): string {
  // 指数模式：CN 直接使用完整行情代码（sh000001 / sz399001 等）
  if (index && market === "CN" && /^(sh|sz|bj)\d+$/i.test(code)) return code.toLowerCase();
  const c = code.toUpperCase().replace(/\.(AM|N|OQ|PS|K)$/, "");
  if (market === "US") return `us${c}`;
  if (market === "HK") return `hk${c.padStart(5, "0")}`;
  if (market === "CN") {
    if (/^(4|8|920)/.test(c)) return `bj${c}`;
    if (/^[69]/.test(c)) return `sh${c}`;
    if (/^[0-3]/.test(c)) return `sz${c}`;
    return `bj${c}`;
  }
  if (market === "JP") return `jp${c.replace(/\.T$/, "")}`;
  if (market === "KR") return `kr${c.replace(/\.(KS|KQ)$/, "")}`;
  return "";
}

/** 腾讯 K 线行解析：行格式 [date, open, close, high, low, volume] */
function parseRows(raw: unknown): KlineItem[] {
  if (!Array.isArray(raw)) return [];
  const out: KlineItem[] = [];
  for (const r of raw) {
    if (!Array.isArray(r) || r.length < 6) continue;
    const d = String(r[0]);
    const o = Number(r[1]);
    const c = Number(r[2]);
    const h = Number(r[3]);
    const l = Number(r[4]);
    const v = Number(r[5]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !o || !c || !h || !l) continue;
    out.push({ d, o, h, l, c, v: Number.isFinite(v) ? v : 0 });
  }
  return out;
}

function normalizedUsCode(code: string) {
  return code.trim().toUpperCase().replace(/\.(AM|N|OQ|PS|K)$/, "");
}

async function fetchYahooDaily(code: string, limit: number, adjust: "qfq" | "none" | "hfq" = "qfq"): Promise<KlineItem[]> {
  const range = limit > 7000 ? "max" : limit > 2600 ? "15y" : limit > 1300 ? "10y" : limit > 800 ? "5y" : limit > 300 ? "2y" : "1y";
  let result: { timestamp?: number[]; indicators?: Record<string, Array<Record<string, Array<number | null>>>> } | null = null;
  // query2 实测更稳（query1 对美股大 range 常 429 限流），优先 query2，其次 query1。
  for (const host of ["query2.finance.yahoo.com", "query1.finance.yahoo.com"]) {
    try {
      // Yahoo 日 K 属境外源：优先走可选代理（STOCKLOG_PROXY），失败自动回退直连
      const response = await proxyFetch(
        `https://${host}/v8/finance/chart/${encodeURIComponent(code)}?interval=1d&range=${range}`,
        // Yahoo 对完整 Chrome UA（Chrome/126...）会 429 限流，简单 Mozilla UA 更稳。
        { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" }, signal: AbortSignal.timeout(16000) }
      );
      if (!response.ok) throw new Error(`yahoo ${response.status}`);
      const json = await response.json().catch(() => null);
      const r = json?.chart?.result?.[0];
      if (r) { result = r; break; }
    } catch {
      /* 当前主机失败，切下一个 */
    }
  }
  if (!result) return [];
  const timestamps: number[] = Array.isArray(result?.timestamp) ? result.timestamp : [];
  const quote = result?.indicators?.quote?.[0] || {};
  const opens: Array<number | null> = Array.isArray(quote.open) ? quote.open : [];
  const highs: Array<number | null> = Array.isArray(quote.high) ? quote.high : [];
  const lows: Array<number | null> = Array.isArray(quote.low) ? quote.low : [];
  const closes: Array<number | null> = Array.isArray(quote.close) ? quote.close : [];
  const volumes: Array<number | null> = Array.isArray(quote.volume) ? quote.volume : [];
  // Yahoo adjclose 为复权收盘价；用它把 o/h/l/c 前复权，消除拆股/除权造成的价格断裂
  // （如 GOOGL 2022-07 拆股 20:1 后 2200→110 的跳空，否则月/年K会出现假暴跌线）。
  const adjclose: Array<number | null> = Array.isArray(result?.indicators?.adjclose?.[0]?.adjclose)
    ? result.indicators.adjclose[0].adjclose
    : closes;
  // 复权因子：qfq=前复权(adjclose/close)，hfq=后复权(close/adjclose)，none=不复权(1)。
  // Yahoo adjclose 为前复权收盘；归一化到最新一根=原始收盘，保证最新价不被复权系数偏移。
  const factors: number[] = [];
  for (let i = 0; i < timestamps.length; i += 1) {
    const c = Number(closes[i]); const adj = Number(adjclose[i]);
    if (!Number.isFinite(c) || !Number.isFinite(adj) || c <= 0 || adj <= 0) { factors.push(0); continue; }
    const ratio = adj / c;
    factors.push(adjust === "none" ? 1 : adjust === "qfq" ? ratio : 1 / ratio);
  }
  let norm = 1;
  for (let i = timestamps.length - 1; i >= 0; i -= 1) {
    if (factors[i] > 0) { const c = Number(closes[i]); if (c > 0) norm = c / (c * factors[i]); break; }
  }
  const rows: KlineItem[] = [];
  timestamps.forEach((timestamp, index) => {
    const o = Number(opens[index]); const h = Number(highs[index]);
    const l = Number(lows[index]); const c = Number(closes[index]);
    const f = factors[index];
    if (![o, h, l, c].every((value) => Number.isFinite(value) && value > 0) || f <= 0) return;
    const k = f * norm;
    const d = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(timestamp * 1000));
    rows.push({ d, o: o * k, h: h * k, l: l * k, c: c * k, v: Number(volumes[index]) || 0 });
  });
  return rows.slice(-limit);
}

/** 东方财富 A 股全量历史日 K（前复权），腾讯前复权最多约 640 条、大 limit 直接报错时兜底。 */
async function fetchEastmoneyDaily(code: string, limit: number, adjust: "qfq" | "none" | "hfq" = "qfq"): Promise<KlineItem[]> {
  const c = code.toUpperCase();
  // 东方财富 secid：沪市 1.xxxxxx，深市 / 北交所 0.xxxxxx。
  // 指数/带前缀代码（sh000001 / sz399001 / SH... ）会把前缀留在 code 里，需先归一化再拼 secid。
  const digits = c.replace(/\D/g, "");
  const hasPrefix = /^(SH|SZ|BJ)/.test(c);
  const secid = hasPrefix
    ? (c.startsWith("SH") ? `1.${digits}` : `0.${digits}`)
    : /^[69]/.test(c) ? `1.${digits}` : `0.${digits}`;
  const fqt = adjust === "hfq" ? 2 : adjust === "none" ? 0 : 1;
  const qs = `secid=${secid}&klt=101&fqt=${fqt}&beg=0&end=20500000&lmt=${limit}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58`;
  for (const host of ["push2his.eastmoney.com", "push2his2.eastmoney.com"]) {
    try {
      const res = await fetch(`https://${host}/api/qt/stock/kline/get?${qs}`, {
        headers: { "User-Agent": UA, Referer: "https://quote.eastmoney.com/" },
        signal: AbortSignal.timeout(12000)
      });
      if (!res.ok) continue;
      const data = (await res.json().catch(() => null)) as { data?: { klines?: string[] } } | null;
      const rows = data?.data?.klines ?? [];
      if (rows.length === 0) continue;
      const items: KlineItem[] = [];
      for (const line of rows) {
        const p = line.split(",");
        const d = p[0];
        const o = Number(p[1]);
        const c2 = Number(p[2]);
        const h = Number(p[3]);
        const l = Number(p[4]);
        const v = Number(p[5]);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !o || !c2 || !h || !l) continue;
        items.push({ d, o, h, l, c: c2, v: Number.isFinite(v) ? v : 0 });
      }
      if (items.length > 0) return items.slice(-limit);
    } catch {
      /* 尝试下一个主机 */
    }
  }
  return [];
}

/** 腾讯前复权日 K（单页最多约 640 条）。 */
async function fetchTencentDaily(symbol: string, limit: number, adjust: "qfq" | "none" | "hfq" = "qfq"): Promise<KlineItem[]> {
  const fq = adjust === "hfq" ? "hfq" : adjust === "none" ? "" : "qfq";
  const res = await fetch(
    `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},day,,,${Math.min(limit, 640)},${fq}`,
    { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(12000) }
  );
  if (!res.ok) throw new Error(`腾讯 K 线返回 ${res.status}`);
  const data = (await res.json().catch(() => null)) as {
    data?: Record<string, { day?: unknown; qfqday?: unknown; hfqday?: unknown }>;
  } | null;
  const node = data?.data?.[symbol];
  const raw = adjust === "hfq" ? node?.hfqday ?? node?.day ?? [] : adjust === "none" ? node?.day ?? [] : node?.qfqday ?? node?.day ?? [];
  return parseRows(raw);
}

/**
 * 腾讯前复权日 K（大数量分页）：单页上限约 640 条，超过时用「截止日」往前翻页，
 * 直到取够 limit 或到达上市首日（A股季K等长周期不再报「param error」）。
 */
async function fetchTencentDailyPaged(symbol: string, limit: number, adjust: "qfq" | "none" | "hfq" = "qfq"): Promise<KlineItem[]> {
  const perPage = 640;
  if (limit <= perPage) return fetchTencentDaily(symbol, limit, adjust);
  const fq = adjust === "hfq" ? "hfq" : adjust === "none" ? "" : "qfq";
  const pages: KlineItem[][] = [];
  let endDate = "";
  let collected = 0;
  for (let page = 0; page < 12; page++) {
    const res = await fetch(
      `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},day,,${endDate},${perPage},${fq}`,
      { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(12000) }
    );
    if (!res.ok) break;
    const data = (await res.json().catch(() => null)) as {
      data?: Record<string, { day?: unknown; qfqday?: unknown; hfqday?: unknown }>;
    } | null;
    const node = data?.data?.[symbol];
    const raw = adjust === "hfq" ? node?.hfqday ?? node?.day ?? [] : adjust === "none" ? node?.day ?? [] : node?.qfqday ?? node?.day ?? [];
    const items = parseRows(raw);
    if (items.length === 0) break;
    pages.push(items);
    collected += items.length;
    if (collected >= limit || items.length < perPage) break;
    endDate = items[0].d;
  }
  // 每页内部升序；把页序倒排（旧页在前）后拼接即整体升序，再取最近 limit 条
  return [...pages].reverse().flat().slice(-limit);
}

/** 拉取日 K（内存缓存 10 分钟）；失败抛错，由调用方决定兜底策略 */
export async function fetchDailyKline(
  market: string,
  code: string,
  limit = 320,
  index = false,
  adjust: "qfq" | "none" | "hfq" = "qfq"
): Promise<KlineItem[]> {
  // 不同周期需要不同条数；limit 必须进入缓存键，否则先缓存 320 条会污染后续 3200 条请求。
  const key = `${market}:${code}:${limit}:${adjust}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.items;

  const symbol = tencentSymbol(market, code, index);
  let items: KlineItem[] = [];
  if (market === "US") {
    const usCode = normalizedUsCode(code);
    // 美股：基准指数优先本地富途日 K（最稳，不受外网源限流影响），失败再走 Yahoo（拆股复权）→ 新浪兜底
    if (isFutuBenchmark("US", usCode)) {
      items = await fetchFutuDailyKline("US", usCode, limit, futuAutype(adjust));
    }
    if (items.length === 0) {
      items = await fetchYahooDaily(usCode, limit, adjust);
    }
    if (items.length === 0) {
      const res = await fetch(
        `https://stock.finance.sina.com.cn/usstock/api/jsonp_v2.php/var%20_=/US_MinKService.getDailyK?symbol=${encodeURIComponent(usCode)}&___qn=3`,
        { headers: { "User-Agent": UA, Referer: "https://finance.sina.com.cn/" }, signal: AbortSignal.timeout(12000) }
      );
      const text = await res.text();
      const m = text.match(/\((\[.*\])\)/s);
      if (m) {
        const arr = JSON.parse(m[1]) as { d: string; o: string; h: string; l: string; c: string; v?: string }[];
        items = arr
          .map((r) => ({ d: r.d, o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), v: Number(r.v) || 0 }))
          .filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k.d) && k.o && k.c && k.h && k.l)
          .slice(-limit);
      }
    }
  } else if (symbol) {
    // 港股 / A股 / 日股 / 韩股：腾讯前复权日 K（日韩数据可能不全）
    // 港股基准（恒指 02800）优先本地富途日 K，失败再回退腾讯。
    if (isFutuBenchmark("HK", code)) {
      items = await fetchFutuDailyKline("HK", code, limit, futuAutype(adjust));
    }
    if (items.length === 0) {
      items = await fetchTencentDailyPaged(symbol, limit, adjust);
    }
    // A股：腾讯前复权最多约 640 条，长周期（季K等）或空结果时用东方财富全量历史兜底
    if (market === "CN" && items.length < Math.min(limit, 800)) {
      const em = await fetchEastmoneyDaily(code, limit, adjust);
      if (em.length > items.length) items = em;
    }
  }
  if (items.length === 0) throw new Error("暂无 K 线数据");
  cache.set(key, { items, at: Date.now() });
  return items;
}

function aggregatePeriods(rows: KlineItem[], period: "WEEK" | "MONTH" | "QUARTER" | "YEAR"): KlineItem[] {
  const groups = new Map<string, KlineItem[]>();
  for (const row of rows) {
    const date = new Date(`${row.d}T00:00:00Z`);
    let key = row.d.slice(0, 7);
    if (period === "WEEK") {
      const day = date.getUTCDay() || 7;
      date.setUTCDate(date.getUTCDate() - day + 1);
      key = date.toISOString().slice(0, 10);
    } else if (period === "QUARTER") {
      key = `${date.getUTCFullYear()}-Q${Math.floor(date.getUTCMonth() / 3) + 1}`;
    } else if (period === "YEAR") {
      key = String(date.getUTCFullYear());
    }
    const group = groups.get(key) || [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    d: group[group.length - 1].d,
    o: group[0].o,
    c: group[group.length - 1].c,
    h: Math.max(...group.map((row) => row.h)),
    l: Math.min(...group.map((row) => row.l)),
    v: group.reduce((sum, row) => sum + row.v, 0)
  }));
}

/**
 * 周期 K 线（周/月/季/年）。美股优先富途周期K（qfq 前复权，与富途行情一致），
 * 不可用时回退「日K + 本地聚合」。
 */
export async function fetchPeriodKline(
  market: string,
  code: string,
  period: "WEEK" | "MONTH" | "QUARTER" | "YEAR",
  limit = 320,
  adjust: "qfq" | "none" | "hfq" = "qfq"
): Promise<KlineItem[]> {
  const key = `${market}:${code}:${period}:${limit}:${adjust}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.items;

  let items: KlineItem[] = [];
  // 周/月/季/年K一律用日K（qfq/hfq/none）聚合：富途周期K对拆股股未正确前复权（GOOGL 2022-07
  // 拆股 20:1 后仍是 2179→116），Yahoo 日K已前复权连续，聚合出连续月/年K。
  if (items.length === 0) {
    // 年K显示「上市以来」：拉取足够多日K（>7000 触发 Yahoo range=max 全量）。
    const daily = await fetchDailyKline(market, code, period === "YEAR" ? 12000 : 3300, false, adjust);
    items = aggregatePeriods(daily, period);
  }
  if (items.length === 0) throw new Error("暂无 K 线数据");
  cache.set(key, { items, at: Date.now() });
  return items.slice(-limit);
}
