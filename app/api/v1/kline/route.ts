import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";
import { fail, ok } from "@/lib/api";

export const dynamic = "force-dynamic";

const cache = new Map<string, { closes: number[]; months: string[]; at: number }>();
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";

interface MonthlySeries {
  closes: number[];
  months: string[];
}

/** 东方财富月 K（约 2020 年起），行格式 YYYY-MM-DD,open,close,high,low,... */
async function fetchEastmoneyMonthly(secid: string): Promise<MonthlySeries> {
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${encodeURIComponent(
    secid
  )}&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57&klt=103&fqt=1&beg=20200101&end=20500101`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(12000)
  });
  const data = await res.json().catch(() => null);
  const klines: string[] = data?.data?.klines ?? [];
  const closes: number[] = [];
  const months: string[] = [];
  klines.forEach((line) => {
    const parts = String(line).split(",");
    const date = parts[0] ?? "";
    const close = Number(parts[2]);
    const month = /^\d{4}-\d{2}/.test(date) ? date.slice(0, 7) : "";
    if (month && Number.isFinite(close) && close > 0) {
      months.push(month);
      closes.push(close);
    }
  });
  return { closes, months };
}

/** 腾讯月 K 兜底（港股 / 兜底市场，通常只有最近少量月份） */
async function fetchTencentMonthly(symbol: string, count = 12): Promise<MonthlySeries> {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=${encodeURIComponent(
    `${symbol},month,,,${count}`
  )}`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(12000)
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

/** A股 secid：6/9 开头沪市 1.xxx，其余深市 0.xxx */
function cnSecid(code: string): string {
  return /^[69]/.test(code) ? `1.${code}` : `0.${code}`;
}

/** 新浪日线转月线（A股兜底，约 4 年） */
async function fetchSinaMonthly(code: string): Promise<MonthlySeries> {
  const symbol = /^6/.test(code) ? `sh${code}` : `sz${code}`;
  const res = await fetch(
    `https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20_=/CN_MarketDataService.getKLineData?symbol=${encodeURIComponent(
      symbol
    )}&scale=240&ma=no&datalen=1023`,
    { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(12000) }
  );
  const text = await res.text();
  const m = text.match(/\((\[.*\])\)/s);
  if (!m) return { closes: [], months: [] };
  const arr = JSON.parse(m[1]) as { day: string; close: string }[];
  const monthly = new Map<string, number>();
  arr.forEach((r) => {
    const day = String(r.day ?? "");
    const month = /^\d{4}-\d{2}/.test(day) ? day.slice(0, 7) : "";
    const close = Number(r.close);
    if (month && Number.isFinite(close) && close > 0) monthly.set(month, close);
  });
  const months = [...monthly.keys()].sort();
  return { closes: months.map((mo) => monthly.get(mo)!), months };
}

/** v1 K 线（月收盘 + 月份，约 2020 年起；?market=US&code=AAPL） */
export async function GET(request: Request) {
  if (!rateLimit(`kline:${clientIp(request)}`, 120, 60 * 1000) || !rateLimitGlobal("kline", 600, 60 * 1000)) {
    return fail(42901, "请求过于频繁，请稍后再试", 429);
  }
  const { searchParams } = new URL(request.url);
  const market = (searchParams.get("market") || "").toUpperCase();
  const code = (searchParams.get("code") || "").toUpperCase();
  if (!code) return fail(40001, "缺少代码", 400);
  if (!/^[A-Z0-9._-]+$/.test(code)) return fail(40001, "股票代码不合法", 400);
  if (!["US", "HK", "CN", "JP", "KR"].includes(market)) return fail(40001, "暂不支持该市场", 400);
  const key = `${market}:${code}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return ok({ closes: cached.closes, months: cached.months });

  let series: MonthlySeries = { closes: [], months: [] };
  try {
    if (market === "CN") {
      try {
        series = await fetchEastmoneyMonthly(cnSecid(code));
        if (series.months.length === 0) throw new Error("empty");
      } catch {
        series = await fetchSinaMonthly(code);
      }
    } else if (market === "HK") {
      try {
        series = await fetchEastmoneyMonthly(`116.${code}`);
        if (series.months.length === 0) throw new Error("empty");
      } catch {
        series = await fetchTencentMonthly(`hk${code}`, 60);
      }
    } else if (market === "JP") {
      series = await fetchTencentMonthly(`jp${code.replace(/\.T$/, "")}`, 60);
    } else if (market === "KR") {
      series = await fetchTencentMonthly(`kr${code.replace(/\.(KS|KQ)$/, "")}`, 60);
    } else {
      // 美股市场代码 105 纳斯达克 / 106 纽交所 / 107 美交所，逐个尝试
      for (const mkt of [105, 106, 107]) {
        series = await fetchEastmoneyMonthly(`${mkt}.${code}`);
        if (series.months.length > 0) break;
      }
      if (series.months.length === 0) {
        series = await fetchTencentMonthly(`us${code}`);
      }
    }
  } catch {
    return fail(50002, "K 线获取失败，请稍后重试", 502);
  }
  cache.set(key, { closes: series.closes, months: series.months, at: Date.now() });
  return ok({ closes: series.closes, months: series.months });
}
