/**
 * 富途 OpenAPI 行情源（主行情，替代腾讯 + Yahoo 盘前盘后）。
 *
 * 依赖本地富途 OpenD 网关（默认 127.0.0.1:11111，需在富途牛牛 / Futu_OpenD 登录），
 * 通过 scripts/futu_quotes.py（Python futu-api SDK）拉取市场快照。
 *
 * 可用性策略：
 * - 先做 TCP 端口预检（<1s），端口不通直接回退，不阻塞请求；
 * - 桥接脚本失败 / 返回空结果时短期缓存「不可用」，避免每次轮询反复打 OpenD。
 */
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { marketSessionState } from "./marketSessions";
import { getSiteSettings } from "./settings";
import type { Quote, QuoteItem } from "./quotes";
import type { SearchMatch } from "./types";

const BRIDGE = path.join(process.cwd(), "scripts", "futu_quotes.py");

let availabilityCache: { at: number; ok: boolean; host: string; port: number } | null = null;
const AVAILABLE_TTL = 15_000;
const UNAVAILABLE_TTL = 30_000;

function checkPort(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function isFutuAvailable(): Promise<boolean> {
  const now = Date.now();
  const { futuHost, futuPort } = getSiteSettings();
  const host = futuHost || "127.0.0.1";
  const port = Number(futuPort) || 11111;
  if (availabilityCache && availabilityCache.host === host && availabilityCache.port === port) {
    const ttl = availabilityCache.ok ? AVAILABLE_TTL : UNAVAILABLE_TTL;
    if (now - availabilityCache.at < ttl) return availabilityCache.ok;
  }
  const ok = await checkPort(host, port, 800);
  availabilityCache = { at: now, ok, host, port };
  return ok;
}

/** 美股当前处于哪个扩展时段；闭市时区分「夜盘」（工作日 20:00-04:00）与普通收盘 */
function sessionHint(market: string): string {
  const key = market.toUpperCase();
  if (key !== "US") return "REGULAR";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date());
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value || "";
  const weekday = get("weekday") !== "Sat" && get("weekday") !== "Sun";
  const minute = Number(get("hour")) * 60 + Number(get("minute"));
  const session = marketSessionState("US").session;
  if (session === "pre") return "PRE";
  if (session === "post") return "AFTER";
  if (weekday && (minute >= 1200 || minute < 240)) return "OVERNIGHT";
  return "REGULAR";
}

function doRunBridge(input: Record<string, unknown>, host = "127.0.0.1", port = 11111): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [BRIDGE], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("futu bridge timeout"));
    }, 10_000);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `futu bridge exit ${code}`));
        return;
      }
      try {
        // 防御：SDK 日志可能混入 stdout，只解析首个 { 到最后一个 } 之间的内容
        const start = stdout.indexOf("{");
        const end = stdout.lastIndexOf("}");
        const raw = start >= 0 && end > start ? stdout.slice(start, end + 1) : stdout;
        const parsed = JSON.parse(raw) as { ok?: boolean; quotes?: Record<string, Quote>; results?: SearchMatch[]; error?: string };
        if (!parsed.ok) {
          reject(new Error(parsed.error || "futu bridge failed"));
          return;
        }
        resolve(parsed);
      } catch (err) {
        reject(err instanceof Error ? err : new Error("futu bridge bad output"));
      }
    });
    child.stdin.end(JSON.stringify({ ...input, host, port }));
  });
}

// OpenD 对并发连接数有限制（免费账户通常只允许 1 个），多个 python 进程同时连接会互相
// 阻塞甚至超时。所有桥接调用（行情/搜索/额度/测试）串行执行，避免偶发超时回退腾讯，
// 造成当日盈亏等数值在不同刷新间不一致。
let bridgeQueue: Promise<void> = Promise.resolve();
function runBridge(input: Record<string, unknown>, host = "127.0.0.1", port = 11111): Promise<Record<string, unknown>> {
  const task = bridgeQueue.then(() => doRunBridge(input, host, port));
  bridgeQueue = task.then(
    () => undefined,
    () => undefined
  );
  return task;
}

/** 主入口：OpenD 可用时拉取富途快照；失败抛错由调用方回退腾讯。 */
export async function fetchFutuQuotes(items: QuoteItem[]): Promise<Map<string, Quote>> {
  if (items.length === 0 || !(await isFutuAvailable())) return new Map();
  const { futuHost, futuPort } = getSiteSettings();
  const withSession = items.map((item) => ({
    ...item,
    session: sessionHint(item.market)
  }));
  const parsed = await runBridge({ cmd: "quotes", items: withSession }, futuHost, Number(futuPort) || 11111);
  return new Map(Object.entries((parsed.quotes as Record<string, Quote> | undefined) || {}));
}

/** 富途搜索（get_search_quote + 快照补价）；失败抛错由调用方回退腾讯。 */
export async function searchFutu(keyword: string, limit = 8): Promise<SearchMatch[]> {
  if (!keyword.trim() || !(await isFutuAvailable())) return [];
  const { futuHost, futuPort } = getSiteSettings();
  const parsed = await runBridge({ cmd: "search", keyword: keyword.trim(), limit }, futuHost, Number(futuPort) || 11111);
  const rows = (parsed.results as SearchMatch[] | undefined) || [];
  return rows.map((row) => ({
    symbol: row.symbol,
    code: row.code,
    name: row.name,
    market: row.market,
    price: typeof row.price === "number" && Number.isFinite(row.price) ? row.price : null,
    changePct: typeof row.changePct === "number" && Number.isFinite(row.changePct) ? row.changePct : null
  }));
}

/** 供健康检查 / 设置页显示 OpenD 连接状态 */
export async function getFutuStatus(): Promise<{ available: boolean; host: string; port: number }> {
  const { futuHost, futuPort } = getSiteSettings();
  const host = futuHost || "127.0.0.1";
  const port = Number(futuPort) || 11111;
  const available = await isFutuAvailable();
  return { available, host, port };
}

/** 设置页「测试连接」：用指定 host/port 真实拉一次 AAPL 快照，验证 OpenD 可达且已登录。 */
export async function testFutuConnection(host: string, port: number): Promise<{ ok: boolean; message: string }> {
  const h = host.trim() || "127.0.0.1";
  const p = Number(port) || 11111;
  if (!(await checkPort(h, p, 1500))) {
    return { ok: false, message: `无法连接 ${h}:${p}（端口未开放）` };
  }
  try {
    const parsed = await runBridge({ cmd: "quotes", items: [{ id: "test", market: "US", code: "AAPL", session: "REGULAR" }] }, h, p);
    const quotes = (parsed.quotes as Record<string, Quote> | undefined) || {};
    if (quotes.test) {
      return { ok: true, message: `连接成功（${h}:${p}），AAPL 报价 ${quotes.test.price}` };
    }
    return { ok: false, message: "OpenD 可达，但未返回行情（可能未登录或行情权限不足）" };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "连接失败" };
  }
}

export interface FutuQuota {
  subscription?: {
    totalUsed: number;
    remain: number;
    ownUsed: number;
    totalQuota: number;
    ownTotalQuota: number;
  };
  historyKl?: {
    used: number;
    remain: number;
    totalQuota: number;
  };
}

/** 富途公司行动-分红派息原始记录（与脚本返回结构一致，字段由 lib/dividends.ts 统一解析）。 */
export interface FutuDividendRaw {
  pub_date?: string;
  statement?: string;
  record_date?: string;
  ex_date?: string;
  dividend_payable_date?: string;
  process?: string;
  fiscal_year?: string | number;
}

export interface FutuKlineRow {
  time_key: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
}

/** 富途分红派息（get_corporate_actions_dividends）；OpenD 不可用 / 失败返回 []。 */
export async function fetchFutuDividends(market: string, code: string): Promise<FutuDividendRaw[]> {
  if (!(await isFutuAvailable())) return [];
  const { futuHost, futuPort } = getSiteSettings();
  const parsed = await runBridge(
    { cmd: "dividends", items: [{ market, code }] },
    futuHost,
    Number(futuPort) || 11111
  );
  const rows = (parsed.dividends as FutuDividendRaw[] | undefined) || [];
  return rows;
}

/** 富途周期 K 线（前复权 qfq，K_WEEK / K_MON / K_QUARTER / K_YEAR）。 */
export async function fetchFutuPeriodKline(
  code: string,
  ktype: "K_WEEK" | "K_MON" | "K_QUARTER" | "K_YEAR",
  maxCount = 100,
  autype: "qfq" | "hfq" = "qfq"
): Promise<{ d: string; o: number; h: number; l: number; c: number; v: number }[]> {
  if (!(await isFutuAvailable())) return [];
  const { futuHost, futuPort } = getSiteSettings();
  const end = new Date().toISOString().slice(0, 10);
  // 富途 get_history_kline 在区间内根数超过 max_count 时返回“最早”的 max_count 根，
  // 若 start 固定为 2010，周K（2010→今约 830 周 > max_count）只会回 2010-2016，导致周K全旧。
  // 改为按 max_count 回推一个“最近窗口”作为 start，让富途返回最近的 max_count 根。
  const periodDays = ktype === "K_WEEK" ? 7 : ktype === "K_MON" ? 31 : ktype === "K_QUARTER" ? 92 : 366;
  const start = new Date(Date.now() - maxCount * periodDays * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const parsed = await runBridge(
    { cmd: "kline", items: [{ market: "US", code }], ktype, start, end, maxCount, autype },
    futuHost,
    Number(futuPort) || 11111
  );
  const rows = (parsed.rows as FutuKlineRow[] | undefined) || [];
  const out: { d: string; o: number; h: number; l: number; c: number; v: number }[] = [];
  for (const r of rows) {
    const d = String(r.time_key || "").slice(0, 10);
    const o = Number(r.open);
    const h = Number(r.high);
    const l = Number(r.low);
    const c = Number(r.close);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !o || !h || !l || !c) continue;
    out.push({ d, o, h, l, c, v: Number(r.volume) || 0 });
  }
  return out;
}

/** 富途日 K 线（K_DAY，前复权 qfq）。OpenD 可用时最稳，供资产分析 / 名人持仓的少量基准指数优先使用。 */
export async function fetchFutuDailyKline(
  market: string,
  code: string,
  maxCount = 330,
  autype: "qfq" | "hfq" = "qfq"
): Promise<{ d: string; o: number; h: number; l: number; c: number; v: number }[]> {
  if (!(await isFutuAvailable())) return [];
  const { futuHost, futuPort } = getSiteSettings();
  const end = new Date().toISOString().slice(0, 10);
  // 富途 get_history_kline 在区间内根数超过 max_count 时返回“最早”的 max_count 根，
  // 因此需按 max_count 回推一个“最近窗口”作为 start。日 K 用约 1.35 倍日历日（剔除周末/节假日），
  // 让窗口内交易日 ≤ max_count，富途才会返回最近一段日 K；若窗口偏大则会丢掉最近几天。
  const startDays = Math.ceil(maxCount * 1.35);
  const start = new Date(Date.now() - startDays * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const parsed = await runBridge(
    { cmd: "kline", items: [{ market, code }], ktype: "K_DAY", start, end, maxCount, autype },
    futuHost,
    Number(futuPort) || 11111
  );
  const rows = (parsed.rows as FutuKlineRow[] | undefined) || [];
  const out: { d: string; o: number; h: number; l: number; c: number; v: number }[] = [];
  for (const r of rows) {
    const d = String(r.time_key || "").slice(0, 10);
    const o = Number(r.open);
    const h = Number(r.high);
    const l = Number(r.low);
    const c = Number(r.close);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !o || !h || !l || !c) continue;
    out.push({ d, o, h, l, c, v: Number(r.volume) || 0 });
  }
  return out;
}

/** 富途 OpenAPI 额度（实时订阅 + 历史K线）；不可用 / 失败返回 null */
export async function fetchFutuQuota(host = "127.0.0.1", port = 11111): Promise<FutuQuota | null> {
  try {
    const parsed = await runBridge({ cmd: "quota" }, host, port);
    return (parsed.quota as FutuQuota | undefined) ?? null;
  } catch {
    return null;
  }
}
