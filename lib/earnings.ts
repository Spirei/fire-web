import { fetchBatch } from "./quotes";
import { getSiteSettings } from "./settings";
import fs from "fs";
import path from "path";

export type EarningsMarket = "US" | "CN";

export interface EarningsItem {
  symbol: string;
  name: string;
  nameZh: string;
  market: EarningsMarket;
  date: string;
  time: string;
  quarter: string;
  epsForecast: string;
  ests: number;
  marketCap: number; // 美股为 USD；A股为 RMB
  price: number | null;
  changePct: number | null;
}

const DEFAULT_EARNINGS_URL = "https://api.nasdaq.com/api/calendar/earnings?date=";
const NASDAQ_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  Referer: "https://www.nasdaq.com/"
};

// 财报日期每月基本固定：缓存拉长到 12 小时，并持久化到磁盘，刷新 / 重启后直接读缓存秒出
const CACHE_TTL = 12 * 60 * 60 * 1000;
// 空月份（上游确实没有安排，例如 A 股 9 月）只缓存 30 分钟：新财报季一发布预约日期就能很快显示出来，
// 也避免上游偶发抽风时把「空」当成结论存满 12 小时
const EMPTY_CACHE_TTL = 30 * 60 * 1000;
// 可浏览范围：上月 ~ 未来 4 个月
export const EARNINGS_MIN_MONTHS_AGO = 1;
export const EARNINGS_MAX_MONTHS_AHEAD = 4;

/**
 * 每月的财报缓存。
 * - items / at：最后一次**确实拿到数据**的内容与时间（`updatedAt` 用 at 展示）；
 * - checkedAt / ttl：上次问上游的时间与这份记录的有效期，用来决定何时再问一次。
 * 两者分开是因为上游偶发抽风或返回空时，我们只更新 checkedAt，不动磁盘上那份好数据
 * —— 本地永远留着最后一次成功抓到的财报，不会因为一次空响应把整月清空。
 */
type EarningsCacheRecord = { items: EarningsItem[]; at: number; checkedAt: number; ttl: number };

// 缓存：key = "US:2026-08" / "CN:2026-08"
const cache: Record<string, EarningsCacheRecord> = {};
const refreshInflight: Record<string, Promise<EarningsCacheRecord> | undefined> = {};
const EARNINGS_CACHE_DIR = path.join(process.cwd(), "data", "earnings-cache");

function loadDiskCache(key: string): EarningsCacheRecord | null {
  try {
    const file = path.join(EARNINGS_CACHE_DIR, `${key}.json`);
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
      items?: unknown;
      at?: unknown;
      ttl?: unknown;
      checkedAt?: unknown;
    };
    if (Array.isArray(parsed.items) && typeof parsed.at === "number") {
      const items = parsed.items as EarningsItem[];
      return {
        items,
        at: parsed.at,
        // 旧版本缓存没有这两个字段：按「刚抓过」补齐，行为与之前一致
        checkedAt: typeof parsed.checkedAt === "number" ? parsed.checkedAt : parsed.at,
        ttl: typeof parsed.ttl === "number" ? parsed.ttl : items.length > 0 ? CACHE_TTL : EMPTY_CACHE_TTL
      };
    }
  } catch {
    /* 缓存损坏忽略 */
  }
  return null;
}

function saveDiskCache(key: string, data: EarningsCacheRecord) {
  try {
    fs.mkdirSync(EARNINGS_CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(EARNINGS_CACHE_DIR, `${key}.json`), JSON.stringify(data), "utf8");
  } catch {
    /* 写入失败不影响主流程 */
  }
}

function nyToday(): Date {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  const parts: Record<string, string> = {};
  fmt.formatToParts(new Date()).forEach((p) => {
    parts[p.type] = p.value;
  });
  return new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
}

function dateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function parseCap(raw: unknown): number {
  if (typeof raw !== "string") return 0;
  const n = Number(raw.replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

export function monthKey(year: number, month: number): string {
  return `${year}-${String(month + 1).padStart(2, "0")}`;
}

export function isValidEarningsMonth(year: number, month: number): boolean {
  const now = new Date();
  const min = new Date(now.getFullYear(), now.getMonth() - EARNINGS_MIN_MONTHS_AGO, 1);
  const max = new Date(now.getFullYear(), now.getMonth() + 1 + EARNINGS_MAX_MONTHS_AHEAD, 0);
  const first = new Date(year, month, 1);
  return first >= min && first <= max;
}

/* ============================ 美股（Nasdaq） ============================ */
async function fetchNasdaqDay(date: string): Promise<EarningsItem[]> {
  const base = getSiteSettings().earningsApiUrl || DEFAULT_EARNINGS_URL;
  const res = await fetch(base + date, { headers: NASDAQ_HEADERS, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Nasdaq 返回 ${res.status}`);
  const data = await res.json().catch(() => null);
  const rows = data?.data?.rows;
  // 结构不对（HTML 挑战页 / 风控拦截 / 字段改名）一律当失败，不要静默当成「这天没有财报」
  if (!Array.isArray(rows)) throw new Error("Nasdaq 返回结构异常");
  return rows
    .filter((r: Record<string, unknown>) => typeof r.symbol === "string" && r.symbol && typeof r.name === "string")
    .map((r: Record<string, unknown>): EarningsItem => ({
      symbol: r.symbol as string,
      name: r.name as string,
      nameZh: "",
      market: "US",
      date,
      time: typeof r.time === "string" ? r.time : "time-unknown",
      quarter: typeof r.fiscalQuarterEnding === "string" ? r.fiscalQuarterEnding : "",
      epsForecast: typeof r.epsForecast === "string" ? r.epsForecast : "",
      ests: Number(r.noOfEsts) || 0,
      marketCap: parseCap(r.marketCap),
      price: null,
      changePct: null
    }));
}

async function fetchUsMonth(year: number, month: number): Promise<EarningsItem[]> {
  const days: string[] = [];
  const first = new Date(Date.UTC(year, month, 1));
  const last = new Date(Date.UTC(year, month + 1, 0));
  for (let d = new Date(first); d <= last; d.setUTCDate(d.getUTCDate() + 1)) {
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    days.push(dateStr(d));
  }
  const collected: EarningsItem[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < days.length; i += 5) {
    const chunk = days.slice(i, i + 5);
    const dayResults = await Promise.all(chunk.map((ds) => fetchNasdaqDay(ds).catch(() => [] as EarningsItem[])));
    dayResults.forEach((day) => {
      day
        .filter((item) => {
          if (seen.has(item.symbol)) return false;
          seen.add(item.symbol);
          return true;
        })
        .sort((a, b) => b.marketCap - a.marketCap)
        .slice(0, 5)
        .forEach((item) => collected.push(item));
    });
  }
  collected.sort((a, b) => (a.date === b.date ? b.marketCap - a.marketCap : a.date.localeCompare(b.date)));

  try {
    const quotes = await fetchBatch(collected.map((i) => "us" + i.symbol));
    collected.forEach((i) => {
      const q = quotes.get("us" + i.symbol);
      i.price = q?.price ?? null;
      i.changePct = q?.changePct ?? null;
      if (q?.name) i.nameZh = q.name;
    });
  } catch {
    /* 行情补充失败不影响财报日历 */
  }
  return collected;
}

/* ============================ A股（东方财富预约披露） ============================ */
const DEFAULT_EM_DATACENTER = "https://datacenter.eastmoney.com/securities/api/data/v1/get";
const EM_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36",
  Referer: "https://data.eastmoney.com/bbsj/yysj.html"
};

function cnSecid(code: string): string {
  const c = code.trim();
  if (/^6/.test(c)) return "1." + c;
  if (/^[48]/.test(c)) return "2." + c;
  return "0." + c;
}

async function fetchCnAppointments(year: number, month: number): Promise<EarningsItem[]> {
  const start = `${year}-${pad2(month + 1)}-01`;
  const end = `${year}-${pad2(month + 1)}-${new Date(year, month + 1, 0).getDate()}`;
  const filter = `(FIRST_APPOINT_DATE>='${start}')(FIRST_APPOINT_DATE<='${end}')`;
  const collected: EarningsItem[] = [];
  let page = 1;
  let totalPages = 1;
  while (page <= totalPages) {
    const qs = new URLSearchParams({
      reportName: "RPT_PUBLIC_BS_APPOIN",
      columns: "ALL",
      sortColumns: "FIRST_APPOINT_DATE,SECURITY_CODE",
      sortTypes: "1,1",
      pageSize: "500",
      pageNumber: String(page),
      filter
    });
    const base = getSiteSettings().cnEarningsApiUrl || DEFAULT_EM_DATACENTER;
    const res = await fetch(`${base}?${qs}`, { headers: EM_HEADERS, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`东方财富返回 ${res.status}`);
    const data = (await res.json().catch(() => null)) as
      | { result?: { data?: unknown; pages?: number }; success?: boolean; code?: number; message?: string }
      | null;
    if (!data || typeof data !== "object") throw new Error("东方财富返回非 JSON（可能被风控拦截）");
    const result = data?.result;
    const rows = result?.data;
    if (!Array.isArray(rows)) {
      // 上游明确回「返回数据为空」(code 9201)：该月确实没有预约披露（例如 A 股 9 月是财报空档）
      if (data.success === false && (data.code === 9201 || /为空/.test(String(data.message || "")))) break;
      throw new Error(`东方财富返回结构异常：${String(data.message || data.code || "unknown")}`);
    }
    if (rows.length === 0) break;
    totalPages = result?.pages || 1;
    rows.forEach((r: Record<string, unknown>) => {
      const code = typeof r.SECURITY_CODE === "string" ? r.SECURITY_CODE : "";
      const name = typeof r.SECURITY_NAME_ABBR === "string" ? r.SECURITY_NAME_ABBR.trim() : "";
      const date = typeof r.FIRST_APPOINT_DATE === "string" ? r.FIRST_APPOINT_DATE.slice(0, 10) : "";
      if (!code || !name || !date) return;
      collected.push({
        symbol: code,
        name,
        nameZh: name,
        market: "CN",
        date,
        time: "",
        quarter: typeof r.REPORT_TYPE_NAME === "string" ? r.REPORT_TYPE_NAME.trim() : "",
        epsForecast: "",
        ests: 0,
        marketCap: 0,
        price: null,
        changePct: null
      });
    });
    page++;
  }
  return collected;
}

async function enrichCn(items: EarningsItem[]): Promise<void> {
  if (items.length === 0) return;
  const byCode = new Map(items.map((i) => [i.symbol, i]));
  const secids = items.map((i) => cnSecid(i.symbol));
  const CHUNK = 400;
  for (let i = 0; i < secids.length; i += CHUNK) {
    const chunk = secids.slice(i, i + CHUNK);
    let diff: Record<string, unknown>[] = [];
    for (const host of ["push2delay.eastmoney.com", "push2.eastmoney.com"]) {
      try {
        const url = `https://${host}/api/qt/ulist.np/get?fltt=2&secids=${encodeURIComponent(chunk.join(","))}&fields=f2,f3,f12,f20`;
        const res = await fetch(url, { headers: EM_HEADERS, signal: AbortSignal.timeout(8000) });
        const data = await res.json().catch(() => null);
        const d = data?.data?.diff;
        if (Array.isArray(d)) {
          diff = d as Record<string, unknown>[];
          break;
        }
      } catch {
        /* 尝试下一个主机 */
      }
    }
    diff.forEach((d: Record<string, unknown>) => {
      const item = byCode.get(String(d.f12 ?? ""));
      if (!item) return;
      item.marketCap = Number(d.f20) || 0;
      const price = Number(d.f2);
      if (price > 0) item.price = price;
      const pct = Number(d.f3);
      if (Number.isFinite(pct) && d.f3 !== null && d.f3 !== undefined) item.changePct = pct;
    });
  }
}

async function fetchCnMonth(year: number, month: number): Promise<EarningsItem[]> {
  const items = await fetchCnAppointments(year, month);
  try {
    await enrichCn(items);
  } catch {
    /* 市值/行情补充失败不影响列表 */
  }
  // 按日按市值取前 5，避免单日过多
  const byDate = new Map<string, EarningsItem[]>();
  items.forEach((it) => {
    const list = byDate.get(it.date) || [];
    list.push(it);
    byDate.set(it.date, list);
  });
  const out: EarningsItem[] = [];
  [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .forEach(([, list]) => {
      list.sort((a, b) => b.marketCap - a.marketCap);
      list.slice(0, 5).forEach((it) => out.push(it));
    });
  return out.slice(0, 300);
}

export async function getEarningsMonth(
  year: number,
  month: number,
  market: EarningsMarket = "US"
): Promise<{ items: EarningsItem[]; updatedAt: string; month: string; market: EarningsMarket }> {
  const key = `${market}:${monthKey(year, month)}`;
  const view = (record: EarningsCacheRecord) => ({
    items: record.items,
    updatedAt: new Date(record.at).toISOString(),
    month: monthKey(year, month),
    market
  });
  const fresh = (record: EarningsCacheRecord) => Date.now() - record.checkedAt < record.ttl;

  const cached = cache[key];
  if (cached && fresh(cached)) return view(cached);
  // 磁盘缓存：服务重启后仍可秒出
  const disk = loadDiskCache(key);
  if (disk && fresh(disk)) {
    cache[key] = disk;
    return view(disk);
  }

  const refresh = () => {
    if (refreshInflight[key]) return refreshInflight[key];
    const task = (async () => {
      const items = market === "CN" ? await fetchCnMonth(year, month) : await fetchUsMonth(year, month);
      const now = Date.now();
      // 这一轮上游什么都没给（空档月 / 抽风）：磁盘上若已有当月好数据就留着，只记「刚问过一次」
      const previous = cache[key] ?? loadDiskCache(key);
      const keepPrevious = !!previous && previous.items.length > 0 && items.length === 0;
      const record: EarningsCacheRecord = keepPrevious && previous
        ? { items: previous.items, at: previous.at, checkedAt: now, ttl: EMPTY_CACHE_TTL }
        : { items, at: now, checkedAt: now, ttl: items.length > 0 ? CACHE_TTL : EMPTY_CACHE_TTL };
      cache[key] = record;
      // 保留旧数据时不覆盖磁盘文件，重启后依然能直接读到上次抓到的财报
      if (!keepPrevious) saveDiskCache(key, record);
      return record;
    })().finally(() => {
      if (refreshInflight[key] === task) delete refreshInflight[key];
    });
    refreshInflight[key] = task;
    return task;
  };

  // stale-while-revalidate：只要存在历史数据就立即返回，后台单飞刷新。
  // 财报日期不会高频变化，不应让用户在缓存过期瞬间等待十几秒。
  const stale = cached ?? disk;
  if (stale) {
    cache[key] = stale;
    void refresh().catch(() => {
      /* 后台刷新失败继续保留旧缓存 */
    });
    return view(stale);
  }

  try {
    const data = await refresh();
    return view(data);
  } catch (err) {
    throw err;
  }
}

export async function getEarningsForecast(): Promise<{ items: EarningsItem[]; updatedAt: string }> {
  // 兼容无 month 参数调用：返回当前月份美股
  const now = nyToday();
  const result = await getEarningsMonth(now.getUTCFullYear(), now.getUTCMonth(), "US");
  return { items: result.items, updatedAt: result.updatedAt };
}
