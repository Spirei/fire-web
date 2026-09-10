import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";
import { fail, ok } from "@/lib/api";
import { fetchFutuDailyKline } from "@/lib/futuQuotes";
import { proxyFetch } from "@/lib/net";

export const dynamic = "force-dynamic";

const cache = new Map<string, { closes: number[]; months: string[]; at: number }>();
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";

interface MonthlySeries {
  closes: number[];
  months: string[];
}

/** 指数清单（key → 名称 / 东方财富 secid / 腾讯符号 / 雅虎符号） */
const INDEX_MAP: Record<
  string,
  { name: string; secid: string; tencent: string; yahoo: string; futuDaily?: { market: string; code: string } }
> = {
  // 四个主要市场基准与 Web 资产分析保持一致：用同一 ETF（SPY/QQQ/DIA/02800）走本地富途日 K 聚合成月收盘，
  // 使 iOS 收益率对比曲线与网页口径一致；富途取不到时再落回东财“真指数”等兜底。
  dji: { name: "道琼斯", secid: "100.DJIA", tencent: "usDJI", yahoo: "^DJI", futuDaily: { market: "US", code: "DIA" } },
  spx: { name: "标普500", secid: "100.SPX", tencent: "usINX", yahoo: "^GSPC", futuDaily: { market: "US", code: "SPY" } },
  ndx: { name: "纳斯达克", secid: "100.NDX", tencent: "usIXIC", yahoo: "^IXIC", futuDaily: { market: "US", code: "QQQ" } },
  hsi: { name: "恒生指数", secid: "100.HSI", tencent: "hkHSI", yahoo: "^HSI", futuDaily: { market: "HK", code: "02800" } },
  sse: { name: "上证指数", secid: "1.000001", tencent: "sh000001", yahoo: "000001.SS" },
  szse: { name: "深证成指", secid: "0.399001", tencent: "sz399001", yahoo: "399001.SZ" },
  n225: { name: "日经225", secid: "100.N225", tencent: "jpN225", yahoo: "^N225" },
  ks11: { name: "韩国KOSPI", secid: "100.KS11", tencent: "krKS11", yahoo: "^KS11" },
  sti: { name: "富时新加坡海峡", secid: "100.STI", tencent: "sgSTI", yahoo: "^STI" }
};

/** 把日 K 聚合成月收盘（取每月最后一根收盘），供富途基准日 K → 月序列复用。 */
function aggregateMonthly(rows: { d: string; c: number }[]): MonthlySeries {
  const byMonth = new Map<string, number>();
  for (const r of rows) {
    const m = String(r.d || "").slice(0, 7);
    if (/^\d{4}-\d{2}$/.test(m) && Number.isFinite(r.c) && r.c > 0) byMonth.set(m, r.c);
  }
  const months = [...byMonth.keys()].sort();
  return { months, closes: months.map((m) => byMonth.get(m) as number) };
}

async function fetchEastmoneyMonthly(secid: string): Promise<MonthlySeries> {
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${encodeURIComponent(
    secid
  )}&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57&klt=103&fqt=1&beg=20200101&end=20500101`;
  const res = await proxyFetch(url, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(10000)
  });
  const data = await res.json().catch(() => null);
  const klines: string[] = data?.data?.klines ?? [];
  const closes: number[] = [];
  const months: string[] = [];
  klines.forEach((line) => {
    const parts = String(line).split(",");
    const date = parts[0] ?? "";
    const month = /^\d{4}-\d{2}/.test(date) ? date.slice(0, 7) : "";
    const close = Number(parts[2]);
    if (month && Number.isFinite(close) && close > 0) {
      months.push(month);
      closes.push(close);
    }
  });
  return { closes, months };
}

async function fetchTencentMonthly(symbol: string, count = 60): Promise<MonthlySeries> {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=${encodeURIComponent(
    `${symbol},month,,,${count}`
  )}`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(10000)
  });
  const data = await res.json().catch(() => null);
  const rows: unknown[] = data?.data?.[symbol]?.month ?? [];
  const closes: number[] = [];
  const months: string[] = [];
  rows.forEach((r) => {
    const row = Array.isArray(r) ? r : [];
    const date = String(row[0] ?? "");
    const month = /^\d{4}-\d{2}/.test(date) ? date.slice(0, 7) : "";
    const close = Number(row[1]);
    if (month && Number.isFinite(close) && close > 0) {
      months.push(month);
      closes.push(close);
    }
  });
  return { closes, months };
}

async function fetchYahooMonthly(symbol: string, host = "query1"): Promise<MonthlySeries> {
  const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?range=5y&interval=1mo`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(10000)
  });
  const data = await res.json().catch(() => null);
  const result = data?.chart?.result?.[0];
  const ts: number[] = result?.timestamp ?? [];
  const closesRaw: (number | null)[] = result?.indicators?.quote?.[0]?.close ?? [];
  const closes: number[] = [];
  const months: string[] = [];
  ts.forEach((t, i) => {
    const close = Number(closesRaw[i]);
    if (!Number.isFinite(close) || close <= 0) return;
    const d = new Date(t * 1000);
    const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    months.push(month);
    closes.push(close);
  });
  return { closes, months };
}

/** v1 指数月 K（?key=spx）。主要基准（spx/ndx/dji/hsi）优先本地富途日 K 聚合月收盘（与 Web 资产分析同口径），
 *  失败再按东财（真指数）→ 腾讯 → 雅虎兜底；n225/ks11/sti 等维持东财优先。 */
export async function GET(request: Request) {
  if (!rateLimit(`index-kline:${clientIp(request)}`, 120, 60 * 1000) || !rateLimitGlobal("index-kline", 600, 60 * 1000)) {
    return fail(42901, "请求过于频繁，请稍后再试", 429);
  }
  const { searchParams } = new URL(request.url);
  const key = (searchParams.get("key") || "").toLowerCase();
  const meta = INDEX_MAP[key];
  if (!meta) return fail(40001, "未知指数", 400);

  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return ok({ closes: cached.closes, months: cached.months });

  let series: MonthlySeries = { closes: [], months: [] };
  // 主要基准（spx/ndx/dji/hsi）：优先本地富途，用与 Web 资产分析一致的 ETF（SPY/QQQ/DIA/02800）
  // 日 K 聚合成月收盘，保证 iOS 收益率对比曲线与网页口径一致；富途取不到再落回东财真指数。
  if (meta.futuDaily) {
    try {
      const daily = await fetchFutuDailyKline(meta.futuDaily.market, meta.futuDaily.code, 1500);
      series = aggregateMonthly(daily);
    } catch {
      series = { closes: [], months: [] };
    }
  }
  if (series.months.length > 0) {
    cache.set(key, { closes: series.closes, months: series.months, at: Date.now() });
    return ok({ closes: series.closes, months: series.months });
  }
  try {
    try {
      series = await fetchEastmoneyMonthly(meta.secid);
      if (series.months.length === 0) throw new Error("empty");
    } catch {
      try {
        series = await fetchTencentMonthly(meta.tencent);
        if (series.months.length === 0) throw new Error("empty");
      } catch {
        try {
          series = await fetchYahooMonthly(meta.yahoo);
          if (series.months.length === 0) throw new Error("empty");
        } catch {
          series = { closes: [], months: [] };
        }
      }
    }
  } catch {
    return fail(50002, "指数数据获取失败，请稍后重试", 502);
  }
  cache.set(key, { closes: series.closes, months: series.months, at: Date.now() });
  return ok({ closes: series.closes, months: series.months });
}
