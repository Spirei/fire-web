import { HistoryCache } from "./historyCache";
import { normalizeMarketCode } from "./marketCode";

const cache = new HistoryCache<MonthlySeries>();
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";

export interface MonthlySeries {
  closes: number[];
  months: string[];
}

/** 东方财富月 K（约 2020 年起），行格式 YYYY-MM-DD,open,close,high,low,... */
async function fetchEastmoneyMonthly(secid: string, signal?: AbortSignal): Promise<MonthlySeries> {
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${encodeURIComponent(
    secid
  )}&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57&klt=103&fqt=1&beg=20200101&end=20500101`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000)
  });
  if (!res.ok) throw new Error(`Kline upstream ${res.status}`);
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
  if (!res.ok) throw new Error(`Kline upstream ${res.status}`);
  const data = await res.json().catch(() => null);
  const rows: unknown[] = data?.data?.[symbol]?.month ?? [];
  const closes: number[] = [];
  const months: string[] = [];
  rows.forEach((r) => {
    const row = Array.isArray(r) ? r : [];
    const date = String(row[0] ?? "");
    const month = /^\d{4}-\d{2}/.test(date) ? date.slice(0, 7) : "";
    const close = Number(row[2]);
    if (month && Number.isFinite(close) && close > 0) {
      months.push(month);
      closes.push(close);
    }
  });
  return { closes, months };
}

/** A股 secid：6/9 开头沪市 1.xxx，其余深市 0.xxx */
function cnSecid(code: string): string {
  return /^(4|8|920)/.test(code) ? `0.${code}` : /^[69]/.test(code) ? `1.${code}` : `0.${code}`;
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
  if (!res.ok) throw new Error(`Kline upstream ${res.status}`);
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


/** 空结果及失败不缓存；美股交易所并行探测，首个有效结果终止其余请求。 */
export async function fetchMonthlyKline(market: string, rawCode: string): Promise<MonthlySeries> {
  market = market.trim().toUpperCase();
  const code = normalizeMarketCode(market, rawCode);
  return cache.fetch(`${market}:${code}`, async () => {
    let series: MonthlySeries = { closes: [], months: [] };
    if (market === "US") {
      const controller = new AbortController();
      try {
        series = await Promise.any([105, 106, 107].map(async exchange => {
          const result = await fetchEastmoneyMonthly(`${exchange}.${code.replace(/\./g, "_")}`, controller.signal);
          if (!result.months.length) throw new Error("empty");
          return result;
        }));
      } catch {
        series = await fetchTencentMonthly(`us${code}`, 60);
      } finally { controller.abort(); }
    } else if (market === "CN" || market === "HK") {
      try {
        series = await fetchEastmoneyMonthly(market === "CN" ? cnSecid(code) : `116.${code}`);
        if (!series.months.length) throw new Error("empty");
      } catch {
        series = market === "CN" ? await fetchSinaMonthly(code) : await fetchTencentMonthly(`hk${code}`, 60);
      }
    } else if (market === "JP" || market === "KR") {
      series = await fetchTencentMonthly(`${market.toLowerCase()}${code}`, 60);
    }
    // 供应商可能返回乱序/重复月份，按实际月末收盘对齐并过滤无效值。
    const values = new Map<string, number>();
    series.months.forEach((month, index) => {
      const close = series.closes[index];
      if (/^\d{4}-(0[1-9]|1[0-2])$/.test(month) && Number.isFinite(close) && close > 0) values.set(month, close);
    });
    const months = [...values.keys()].sort();
    if (!months.length) throw new Error("暂无 K 线数据");
    return { months, closes: months.map(month => values.get(month)!) };
  });
}
