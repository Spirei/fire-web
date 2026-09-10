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
      const res = await fetch(url, { headers: EM_HEADERS, signal: AbortSignal.timeout(3000) });
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

/** 把「2026-09-10 16:00」这种墙上时间换算成可比较的毫秒（Date.UTC 只为对齐，不做时区转换） */
function wallClockMs(text: string): number {
  const match = String(text).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!match) return 0;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]));
}

/**
 * 轮询间隔：还有指数在出新分时数据 → 60 秒；全部不再更新（收市）→ 5 分钟兜底。
 * 判断方式是「让数据自证」——比上一轮看最后一根的时间和点数有没有前进，
 * 不靠开市时间表，也不靠时区（东财给美股的时间戳是北京时间，按市场本地时间判断会算错）。
 * 首次拉取没有上轮数据，按开市处理，避免白天首访就落到 5 分钟。previous 参数便于测试注入。
 */
export function tickerPollSec(
  rows: Array<{ key: string; lastBarAt: number; points: number }>,
  previous: Map<string, { lastBarAt: number; points: number }>
): number {
  if (!rows.length) return 300;
  if (!previous.size) return 60;
  const live = rows.some((row) => {
    const before = previous.get(row.key);
    if (!before) return true;
    return row.lastBarAt > before.lastBarAt || row.points > before.points;
  });
  return live ? 60 : 300;
}

async function fetchTrend(secid: string): Promise<{ points: number[]; lastBarAt: number }> {
  for (const host of EM_TREND_HOSTS) {
    try {
      const url = `${host}/api/qt/stock/trends2/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ndays=1&iscr=0`;
      const res = await fetch(url, { headers: EM_HEADERS, signal: AbortSignal.timeout(3000) });
      if (!res.ok) continue;
      const json = await res.json().catch(() => null);
      const trends = json?.data?.trends;
      if (!Array.isArray(trends) || trends.length === 0) continue;
      const points: number[] = [];
      let lastBarAt = 0;
      for (const row of trends) {
        // 取每分钟「收盘价」（第 3 列）——与富途等券商分时一致；取第 2 列（开盘）会整体偏移，
        // 实测恒指 331 根中与富途完全一致的只有 1 根、最大差 65.6 点，收盘口径 331/331 全同。
        const cols = String(row).split(",");
        const price = Number(cols[2]);
        if (Number.isFinite(price) && price > 0) {
          points.push(price);
          lastBarAt = wallClockMs(cols[0]);
        }
      }
      if (points.length > 0) return { points, lastBarAt };
    } catch {
      /* 尝试下一个主机 */
    }
  }
  return { points: [], lastBarAt: 0 };
}

const TTL = 60_000;
/** 上一轮各指数的「最后一根分时时间 + 点数」，用于判断有没有市场还在出新数据 */
let lastSeen = new Map<string, { lastBarAt: number; points: number }>();
let cache: { at: number; data: TickerItem[]; config: string; pollSec: number } | null = null;
let inflight: Promise<{ items: TickerItem[]; interval: number; pollSec: number }> | null = null;

export async function fetchTicker(): Promise<{ items: TickerItem[]; interval: number; pollSec: number }> {
  const config: TickerConfig = getSiteSettings().ticker;
  const symbols = config.items.length > 0
    ? config.items.map((i) => ({ key: i.key, secid: i.secid, label: i.label, market: i.market }))
    : [];
  const interval = config.interval;
  const configKey = JSON.stringify(config);
  if (cache && Date.now() - cache.at < TTL && cache.config === configKey) return { items: cache.data, interval, pollSec: cache.pollSec };
  if (inflight) return inflight;
  inflight = (async () => {
    const quotes = await fetchQuotes(symbols);
    const built = await Promise.all(
      symbols.map(async (s) => {
        const code = s.secid.split(".")[1];
        const q = quotes.get(code);
        const trend = await fetchTrend(s.secid).catch(() => ({ points: [] as number[], lastBarAt: 0 }));
        const item: TickerItem = {
          key: s.key,
          label: s.label,
          market: s.market,
          price: q?.price ?? null,
          change: q?.change ?? null,
          changePct: q?.changePct ?? null,
          points: trend.points
        };
        return { item, lastBarAt: trend.lastBarAt };
      })
    );
    const items = built.map((row) => row.item);
    // 有任何市场在出新数据 → 60 秒；全部收市 → 5 分钟兜底（页面重新可见时客户端另外会立刻刷新一次）
    const rows = built.map((row) => ({ key: row.item.key, lastBarAt: row.lastBarAt, points: row.item.points.length }));
    const pollSec = tickerPollSec(rows, lastSeen);
    lastSeen = new Map(rows.map((row) => [row.key, { lastBarAt: row.lastBarAt, points: row.points }]));
    cache = { at: Date.now(), data: items, config: configKey, pollSec };
    return { items, interval, pollSec };
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}
