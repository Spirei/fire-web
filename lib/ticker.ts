/* ---------- 顶部全球指数栏（东方财富数据源） ---------- */

import { getSiteSettings } from "./settings";
import type { TickerConfig } from "./types";

export interface TickerItem {
  key: string;
  label: string;
  market: string;
  price: number | null;
  change: number | null;
  changePct: number | null;
  points: number[];
}

// 东方财富行情/分时主机：push2delay 为可用主机（2026-08 起 push2 / push2his 对指数返回空），
// 保留原主机作为回退，避免单一主机失效导致首页指数消失。
const EM_QUOTE_HOSTS = [
  "https://push2delay.eastmoney.com",
  "https://push2.eastmoney.com"
];
const EM_TREND_HOSTS = [
  "https://push2delay.eastmoney.com",
  "https://push2his.eastmoney.com"
];

const EM_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  Referer: "https://quote.eastmoney.com/",
  Accept: "application/json, text/plain, */*"
};

async function fetchQuotes(symbols: { secid: string }[]): Promise<Map<string, { price: number; change: number; changePct: number }>> {
  const secids = symbols.map((s) => s.secid).join(",");
  for (const host of EM_QUOTE_HOSTS) {
    try {
      const url = `${host}/api/qt/ulist.np/get?secids=${secids}&fields=f2,f3,f4,f12&fltt=2`;
      const res = await fetch(url, { headers: EM_HEADERS, signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const json = await res.json().catch(() => null);
      const diff = json?.data?.diff;
      if (!Array.isArray(diff) || diff.length === 0) continue;
      const map = new Map<string, { price: number; change: number; changePct: number }>();
      for (const it of diff) {
        const price = Number(it?.f2);
        if (!Number.isFinite(price) || price <= 0) continue;
        const change = Number(it?.f4);
        const changePct = Number(it?.f3);
        map.set(String(it?.f12), {
          price,
          change: Number.isFinite(change) ? change : 0,
          changePct: Number.isFinite(changePct) ? changePct : 0
        });
      }
      if (map.size > 0) return map;
    } catch {
      /* 尝试下一个主机 */
    }
  }
  return new Map();
}

async function fetchTrend(secid: string): Promise<number[]> {
  for (const host of EM_TREND_HOSTS) {
    try {
      const url = `${host}/api/qt/stock/trends2/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ndays=1&iscr=0`;
      const res = await fetch(url, { headers: EM_HEADERS, signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const json = await res.json().catch(() => null);
      const trends = json?.data?.trends;
      if (!Array.isArray(trends) || trends.length === 0) continue;
      const points: number[] = [];
      for (const row of trends) {
        const price = Number(String(row).split(",")[1]);
        if (Number.isFinite(price) && price > 0) points.push(price);
      }
      if (points.length > 0) return points;
    } catch {
      /* 尝试下一个主机 */
    }
  }
  return [];
}

const TTL = 30_000;
let cache: { at: number; data: TickerItem[]; config: string } | null = null;
let inflight: Promise<{ items: TickerItem[]; interval: number }> | null = null;

export async function fetchTicker(): Promise<{ items: TickerItem[]; interval: number }> {
  const config: TickerConfig = getSiteSettings().ticker;
  const symbols = config.items.length > 0
    ? config.items.map((i) => ({ key: i.key, secid: i.secid, label: i.label, market: i.market }))
    : [];
  const interval = config.interval;
  const configKey = JSON.stringify(config);
  if (cache && Date.now() - cache.at < TTL && cache.config === configKey) return { items: cache.data, interval };
  if (inflight) return inflight;
  inflight = (async () => {
    const quotes = await fetchQuotes(symbols);
    const items = await Promise.all(
      symbols.map(async (s) => {
        const code = s.secid.split(".")[1];
        const q = quotes.get(code);
        const points = await fetchTrend(s.secid).catch(() => []);
        return {
          key: s.key,
          label: s.label,
          market: s.market,
          price: q?.price ?? null,
          change: q?.change ?? null,
          changePct: q?.changePct ?? null,
          points
        };
      })
    );
    cache = { at: Date.now(), data: items, config: configKey };
    return { items, interval };
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}
