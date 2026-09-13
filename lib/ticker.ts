/* ---------- 顶部全球指数栏（东方财富数据源） ---------- */

import { getSiteSettings } from "./settings";
import type { TickerConfig } from "./types";
import { fetchFutuMinuteCloses } from "./futuQuotes";

export interface TickerItem {
  key: string;
  label: string;
  market: string;
  price: number | null;
  change: number | null;
  changePct: number | null;
  points: number[];
}

/**
 * 顶部走势图只有 56px 宽：按区间保留局部高低点，并固定保留首尾点。
 * 相比等距抽样，它不会漏掉短暂的日内尖峰；结果最多 target 个点。
 */
export function sampleTickerPoints(points: number[], target = 56): number[] {
  if (!Array.isArray(points) || points.length <= target) return points;
  const limit = Math.max(4, Math.floor(target));
  const middleCount = points.length - 2;
  const bucketCount = Math.max(1, Math.floor((limit - 2) / 2));
  const sampled = [points[0]];

  for (let bucket = 0; bucket < bucketCount; bucket++) {
    const start = 1 + Math.floor((bucket * middleCount) / bucketCount);
    const end = 1 + Math.floor(((bucket + 1) * middleCount) / bucketCount);
    let minIndex = start;
    let maxIndex = start;
    for (let index = start + 1; index < end; index++) {
      if (points[index] < points[minIndex]) minIndex = index;
      if (points[index] > points[maxIndex]) maxIndex = index;
    }
    if (minIndex === maxIndex) sampled.push(points[minIndex]);
    else if (minIndex < maxIndex) sampled.push(points[minIndex], points[maxIndex]);
    else sampled.push(points[maxIndex], points[minIndex]);
  }

  sampled.push(points[points.length - 1]);
  return sampled;
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
 * 停得越久退得越远（隔夜 15 分钟、跨夜/周末/长假 30 分钟），避免周末一直刷；
 * 首次拉取没有上轮数据、或全部指数都取不到（上游故障）时都保持 60 秒，尽快恢复。
 * previous / staleMs 参数便于测试注入。
 */
export function tickerAdvanced(
  rows: Array<{ key: string; lastBarAt: number; points: number }>,
  previous: Map<string, { lastBarAt: number; points: number }>
): boolean {
  const usable = rows.filter((row) => row.points > 0);
  if (!usable.length || !previous.size) return true;
  return usable.some((row) => {
    const before = previous.get(row.key);
    if (!before) return true;
    return row.lastBarAt > before.lastBarAt || row.points > before.points;
  });
}

export function tickerPollSec(
  rows: Array<{ key: string; lastBarAt: number; points: number }>,
  previous: Map<string, { lastBarAt: number; points: number }>,
  staleMs = 0
): number {
  if (!rows.length || !rows.some((row) => row.points > 0)) return 60; // 全取不到：尽快重试，别当成收市
  if (!previous.size) return 60;
  if (tickerAdvanced(rows, previous)) return 60;
  if (staleMs < 30 * 60_000) return 300;      // 刚收市 / 盘中短暂无更新
  if (staleMs < 3 * 3600_000) return 900;     // 隔夜
  return 1800;                                 // 跨夜、周末、长假：30 分钟兜底
}

/**
 * 与富途逐根比对（低频校对）：两边按当日第 N 根对齐（两个源都是完整当日分时，
 * 按时间戳对齐反而会踩时区差异），错位超过 20% 根数就判定口径漂移。
 * 实测：东财取开盘价的旧写法与富途 331 根里只有 1 根相同（最大差 65.6 点）。
 */
export function compareIndexSeries(eastmoney: number[], futu: number[], tolerance = 0.5): { bars: number; mismatched: number; maxDiff: number; drift: boolean } {
  const bars = Math.min(eastmoney.length, futu.length);
  if (bars < 10) return { bars, mismatched: 0, maxDiff: 0, drift: false };
  let mismatched = 0;
  let maxDiff = 0;
  for (let index = 0; index < bars; index++) {
    const left = eastmoney[eastmoney.length - bars + index];
    const right = futu[futu.length - bars + index];
    if (!Number.isFinite(left) || !Number.isFinite(right)) continue;
    const diff = Math.abs(left - right);
    if (diff > maxDiff) maxDiff = diff;
    if (diff > tolerance) mismatched += 1;
  }
  return { bars, mismatched, maxDiff, drift: mismatched > bars * 0.2 };
}

/** 已完成的校对结果（供 /api/health 与 /api/ticker 展示） */
export function getTickerCrossCheck(): TickerCrossCheck[] {
  return [...crossChecks.values()];
}

/**
 * 收盘后与富途对一次账：只对富途 OpenAPI 支持的指数、每个交易日一次。
 * 开市时不比（两边延迟不同会误报），等「10 分钟没出新数据」说明当日分时已定型再比。
 */
function scheduleCrossCheck(
  pending: Array<{ key: string; label: string; secid: string; market: string; date: string; points: number[] }>
) {
  if (crossChecking || !pending.length) return;
  crossChecking = true;
  void (async () => {
    try {
      for (const row of pending) {
        const futuCode = FUTU_INDEX_CODES[row.secid];
        if (!futuCode) continue;
        const futuSeries = await fetchFutuMinuteCloses(futuCode.market, futuCode.code, row.date);
        if (futuSeries.length < 10) continue;
        const result = compareIndexSeries(row.points, futuSeries);
        crossChecks.set(row.key, { at: Date.now(), key: row.key, label: row.label, date: row.date, ...result });
        if (result.drift) {
          console.warn(`[ticker] 与富途对账发现口径漂移：${row.label} ${row.date}，${result.mismatched}/${result.bars} 根不一致，最大差 ${result.maxDiff.toFixed(2)}`);
        }
      }
    } catch {
      /* 校对失败不影响行情 */
    } finally {
      crossChecking = false;
    }
  })();
}

async function fetchTrend(secid: string): Promise<{ points: number[]; lastBarAt: number; date: string }> {
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
      if (points.length > 0) return { points, lastBarAt, date: String(trends[trends.length - 1]).slice(0, 10) };
    } catch {
      /* 尝试下一个主机 */
    }
  }
  return { points: [], lastBarAt: 0, date: "" };
}

const TTL = 60_000;
/**
 * 东财 secid → 富途指数代码（只用于「低频校对」）。实测 OpenAPI 可用的只有这几个：
 * 美股指数 OpenAPI 明确「暂不支持」、新加坡指数无权限、韩国市场 OpenAPI 根本没有。
 */
const FUTU_INDEX_CODES: Record<string, { market: string; code: string }> = {
  "100.HSI": { market: "HK", code: "800000" },
  "1.000001": { market: "SH", code: "000001" },
  "0.399001": { market: "SZ", code: "399001" },
  "100.N225": { market: "JP", code: ".N225" }
};

export interface TickerCrossCheck {
  at: number;
  key: string;
  label: string;
  date: string;
  bars: number;
  mismatched: number;
  maxDiff: number;
  /** true = 与富途逐根比对后判定为口径漂移（不是延迟） */
  drift: boolean;
}

/** 上一轮各指数的「最后一根分时时间 + 点数」，用于判断有没有市场还在出新数据 */
let lastSeen = new Map<string, { lastBarAt: number; points: number; advancedAt: number; date: string }>();
/** 最近一次「数据确实前进过」的时间：用来决定收市后要退避到哪一档 */
let lastAdvanceAt = 0;
const crossChecks = new Map<string, TickerCrossCheck>();
let crossChecking = false;
let cache: { at: number; data: TickerItem[]; config: string; pollSec: number } | null = null;
let inflight: Promise<{ items: TickerItem[]; interval: number; pollSec: number; crossCheck: TickerCrossCheck[] }> | null = null;

export async function fetchTicker(): Promise<{ items: TickerItem[]; interval: number; pollSec: number; crossCheck: TickerCrossCheck[] }> {
  const config: TickerConfig = getSiteSettings().ticker;
  const symbols = config.items.length > 0
    ? config.items.map((i) => ({ key: i.key, secid: i.secid, label: i.label, market: i.market }))
    : [];
  const interval = config.interval;
  const configKey = JSON.stringify(config);
  if (cache && Date.now() - cache.at < TTL && cache.config === configKey) return { items: cache.data, interval, pollSec: cache.pollSec, crossCheck: getTickerCrossCheck() };
  if (inflight) return inflight;
  inflight = (async () => {
    const quotes = await fetchQuotes(symbols);
    const built = await Promise.all(
      symbols.map(async (s) => {
        const code = s.secid.split(".")[1];
        const q = quotes.get(code);
        const trend = await fetchTrend(s.secid).catch(() => ({ points: [] as number[], lastBarAt: 0, date: "" }));
        const item: TickerItem = {
          key: s.key,
          label: s.label,
          market: s.market,
          price: q?.price ?? null,
          change: q?.change ?? null,
          changePct: q?.changePct ?? null,
          points: trend.points
        };
        return { item, lastBarAt: trend.lastBarAt, date: trend.date };
      })
    );
    // 行情推进判断和富途对账继续使用 built 内的完整分钟序列；仅压缩返回前端绘图的数据。
    const items = built.map((row) => ({ ...row.item, points: sampleTickerPoints(row.item.points) }));
    // 有任何市场在出新数据 → 60 秒；收市按「停了多久」逐档退避（5 / 15 / 30 分钟）；
    // 页面重新可见时客户端另外会立刻刷新一次
    const rows = built.map((row) => ({ key: row.item.key, lastBarAt: row.lastBarAt, points: row.item.points.length }));
    const now = Date.now();
    if (tickerAdvanced(rows, lastSeen)) lastAdvanceAt = now;
    const pollSec = tickerPollSec(rows, lastSeen, lastAdvanceAt ? now - lastAdvanceAt : 0);
    // 逐个指数记「有没有前进 / 最后前进的时间 / 当日日期」，用于退避与收盘后对账
    const nextSeen = new Map<string, { lastBarAt: number; points: number; advancedAt: number; date: string }>();
    const pendingCrossCheck: Array<{ key: string; label: string; secid: string; market: string; date: string; points: number[] }> = [];
    built.forEach((row) => {
      const before = lastSeen.get(row.item.key);
      const advanced = !before || row.lastBarAt > before.lastBarAt || row.item.points.length > before.points;
      const advancedAt = advanced ? now : before?.advancedAt ?? 0;
      nextSeen.set(row.item.key, { lastBarAt: row.lastBarAt, points: row.item.points.length, advancedAt, date: row.date });
      // 收盘后（10 分钟没出新数据）且当天还没对过账 → 与富途比一次
      const symbol = symbols.find((s) => s.key === row.item.key);
      const checkedToday = crossChecks.get(row.item.key)?.date === row.date;
      if (symbol && FUTU_INDEX_CODES[symbol.secid] && row.item.points.length >= 10 && row.date && !checkedToday && advancedAt && now - advancedAt >= 10 * 60_000) {
        pendingCrossCheck.push({ key: row.item.key, label: row.item.label, secid: symbol.secid, market: row.item.market, date: row.date, points: row.item.points });
      }
    });
    lastSeen = nextSeen;
    scheduleCrossCheck(pendingCrossCheck);
    cache = { at: Date.now(), data: items, config: configKey, pollSec };
    return { items, interval, pollSec, crossCheck: getTickerCrossCheck() };
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}
