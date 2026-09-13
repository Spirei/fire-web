import fs from "node:fs";
import path from "node:path";
import { getDb } from "./db";
import { upsertAsset } from "./assets";
import { isSafeSvg, sniffImageExt } from "./imageSecurity";

export type SyncMarket = "US" | "HK" | "CN" | "JP" | "KR";

interface StockMeta {
  market: SyncMarket;
  code: string;
  name: string;
  marketCap: number;
  price: number | null;
  changePct: number | null;
  board: string;
}

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";
const EM_HEADERS = { "User-Agent": UA, Referer: "https://quote.eastmoney.com/" };
const WEBULL_SEARCH = "https://quotes-gw.webullfintech.com/api/search/pc/tickers";
const WEBULL_ICON = (tid: number) => `https://quotes-static.webullfintech.com/ticker-icon/${tid}.png`;
const PARQET_ICON = (code: string) => `https://assets.parqet.com/logos/symbol/${code}`;
const CMC_BASE = "https://companiesmarketcap.com";
const TRADINGVIEW_EXCHANGES: Record<SyncMarket, string[]> = {
  US: ["NASDAQ", "NYSE", "AMEX", "OTC"],
  HK: ["HKEX"],
  CN: ["SSE", "SZSE", "BSE"],
  JP: ["TSE"],
  KR: ["KRX"]
};

const EM_FS: Record<"US" | "HK" | "CN", string> = {
  US: "m:105,m:106,m:107",
  HK: "m:128+t:3,m:128+t:4,m:128+t:1,m:128+t:8",
  CN: "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23"
};
const WEBULL_REGION: Record<"US" | "HK" | "CN", number> = { US: 6, HK: 2, CN: 1 };
const CMC_PAGES: Record<"JP" | "KR", string> = {
  JP: "/japan/largest-companies-in-japan-by-market-cap/",
  KR: "/south-korea/largest-companies-in-south-korea-by-market-cap/"
};
// 市值门槛（本地货币）：美股 100 亿美元；港股/A股 150 亿本地货币；日股/韩股取前 300 大市值
const THRESHOLDS: Record<SyncMarket, number> = { US: 10e9, HK: 15e9, CN: 15e9, JP: 0, KR: 0 };
const CMC_LIMIT = 300;

const ASSET_DIR = path.join(process.cwd(), "public", "uploads", "asset");

const syncState = {
  running: false,
  total: 0,
  done: 0,
  current: "",
  error: ""
};

function nowIso(): string {
  return new Date().toISOString();
}

/* 归属市场：美股按交易所（东财 f13），A股/港股按代码前缀规则 */
function boardOf(market: SyncMarket, code: string, emF13?: number): string {
  const c = code.toUpperCase().replace(/[.\-].*$/, "");
  if (market === "US") {
    if (emF13 === 106) return "纽交所";
    if (emF13 === 107) return "美交所";
    return "纳斯达克";
  }
  if (market === "CN") {
    if (/^(688|689)/.test(c)) return "科创板";
    if (/^(300|301|302)/.test(c)) return "创业板";
    if (/^(8|4|920)/.test(c)) return "北交所";
    return /^6/.test(c) ? "沪主板" : "深主板";
  }
  if (market === "HK") {
    return /^08/.test(c) ? "创业板" : "主板";
  }
  return "";
}

/* ---------- 列表拉取 ---------- */

async function fetchEmTop(market: "US" | "HK" | "CN"): Promise<StockMeta[]> {
  const threshold = THRESHOLDS[market];
  const out: StockMeta[] = [];
  // 东财 clist 每页最多 100 条：按市值降序翻页，直到低于门槛或取完
  for (let pn = 1; pn <= 30; pn += 1) {
    const qs = `pn=${pn}&pz=100&po=1&np=1&fltt=2&invt=2&fid=f20&fs=${EM_FS[market]}&fields=f12,f13,f14,f2,f3,f20`;
    let data: unknown = null;
    for (const host of ["push2delay.eastmoney.com", "push2.eastmoney.com"]) {
      try {
        const res = await fetch(`https://${host}/api/qt/clist/get?${qs}`, { headers: EM_HEADERS, signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`东方财富 ${res.status}`);
        data = await res.json().catch(() => null);
        if (data) break;
      } catch {
        /* 换主机重试 */
      }
    }
    const diff = (data as { data?: { diff?: Record<string, unknown>[] } })?.data?.diff;
    if (!Array.isArray(diff) || diff.length === 0) break;
    let reachedEnd = false;
    for (const r of diff) {
      const capRaw = Number(r.f20);
      // 市值缺失 / 解析失败（接口偶发）时跳过该行，不误判为低于门槛导致提前截断
      if (!Number.isFinite(capRaw) || capRaw <= 0) continue;
      const cap = capRaw;
      if (cap < threshold) {
        reachedEnd = true;
        break;
      }
      const code = String(r.f12 ?? "").trim();
      if (!code) continue;
      const priceRaw = r.f2;
      const price = priceRaw === "-" || priceRaw === null || priceRaw === undefined ? null : Number(priceRaw);
      out.push({
        market,
        code,
        name: String(r.f14 ?? code).trim(),
        marketCap: cap,
        price: Number.isFinite(price as number) ? (price as number) : null,
        changePct: Number(r.f3) || 0,
        board: boardOf(market, code, Number(r.f13) || 0)
      });
    }
    if (reachedEnd || diff.length < 100) break;
  }
  return out;
}

function marketOfCode(code: string): SyncMarket {
  const c = code.toUpperCase();
  if (c.endsWith(".HK")) return "HK";
  if (c.endsWith(".SS") || c.endsWith(".SZ")) return "CN";
  if (c.endsWith(".T")) return "JP";
  if (c.endsWith(".KS") || c.endsWith(".KQ")) return "KR";
  return "US";
}

async function fetchCmcTop(market: "JP" | "KR", limit = CMC_LIMIT): Promise<StockMeta[]> {
  const out: StockMeta[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= 6 && out.length < limit; page += 1) {
    const url = `${CMC_BASE}${CMC_PAGES[market]}?page=${page}`;
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(18000) });
    if (!res.ok) break;
    const html = await res.text();
    const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
    let pageRows = 0;
    for (const row of rows) {
      if (out.length >= limit) break;
      if (!row.includes('company-name">')) continue;
      const name = row.match(/company-name">([^<]*)</)?.[1]?.trim();
      const code = row.match(/company-code"><span class="rank d-none"><\/span>([^<]*)</)?.[1]?.trim();
      if (!name || !code || seen.has(code)) continue;
      seen.add(code);
      const capRaw = row.match(/class="td-right" data-sort="(\d+)"><span class="currency-symbol-left">/)?.[1];
      const priceRaw = row.match(/data-sort="\d+">\$([\d,\.]+)<\/td>/)?.[1];
      const pctRaw = row.match(/([\d\.]+)%<\/span>/)?.[1];
      out.push({
        market,
        code,
        name,
        marketCap: Number(capRaw) || 0,
        price: priceRaw ? Number(priceRaw.replace(/,/g, "")) : null,
        changePct: pctRaw != null && pctRaw !== "" ? Number(pctRaw) : null,
        board: ""
      });
      pageRows += 1;
    }
    if (pageRows === 0) break;
  }
  return out;
}

/* ---------- 图标解析 ---------- */

function normCode(market: SyncMarket, code: string): string {
  const c = code.trim().toUpperCase();
  if (market === "HK") return c.padStart(5, "0");
  if (market === "JP") return c.endsWith(".T") ? c : `${c}.T`;
  if (market === "KR") return c.endsWith(".KS") ? c : `${c}.KS`;
  return c;
}

async function searchWebull(code: string, regionId: number): Promise<number | null> {
  const url = `${WEBULL_SEARCH}?keyword=${encodeURIComponent(code)}&regionIds=${regionId}&pageIndex=1&pageSize=20`;
  // 微牛搜索对连续请求会限流返回空（风控），失败时指数退避重试
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10000) });
      if (!res.ok) continue;
      const data = (await res.json().catch(() => null)) as { data?: { symbol?: string; disSymbol?: string; tickerId?: number; template?: string }[] } | null;
      const list = data?.data ?? [];
      if (list.length === 0) {
        await sleep(1200 * (attempt + 1)); // 空结果多半是限流，退避后重试
        continue;
      }
      // 精确匹配 symbol / disSymbol（港股带 0 前缀、日韩带后缀时做归一化），
      // 必须限定 template === "stock"：代码可能与指数/基金冲突（如 000858 命中 CSI 500 指数）
      const exact = list.find(
        (t) =>
          t.template === "stock" &&
          ((t.symbol || "").toUpperCase() === code ||
            (t.disSymbol || "").toUpperCase() === code ||
            (t.symbol || "").toUpperCase().replace(/^0+/, "") === code.replace(/^0+/, ""))
      );
      const hit = exact ?? list.find((t) => t.template === "stock");
      if (hit && typeof hit.tickerId === "number") return hit.tickerId;
    } catch {
      /* 重试 */
    }
    await sleep(800 * (attempt + 1));
  }
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function sanitizeName(name: string): string {
  return (
    name
      .replace(/[\\/:*?"<>|\s()（）[\]{}]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "stock"
  );
}

// 分市场文件夹保存，按市场自有名称命名：中文名称 + 股票代码（苹果AAPL / 寒武纪688256 / 腾讯控股00700）
function iconFilename(market: SyncMarket, code: string, name: string, ext: string): string {
  return `${sanitizeName(name)}${code}${ext}`;
}

async function downloadIcon(url: string, market: SyncMarket, code: string, name: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") || "";
    // 微牛部分图标 CDN 返回 application/octet-stream（类型不规范），放宽并靠魔数校验兜底
    if (!(type.startsWith("image/") || type === "application/octet-stream")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) return null;
    const ext = sniffImageExt(buf) ?? (type.includes("svg") ? "svg" : type.includes("webp") ? "webp" : type.includes("png") ? "png" : null);
    if (!ext) return null;
    if (ext === "svg" && !isSafeSvg(buf)) return null;
    const dir = path.join(ASSET_DIR, "stock", market);
    fs.mkdirSync(dir, { recursive: true });
    const filename = iconFilename(market, code, name, `.${ext}`);
    fs.writeFileSync(path.join(dir, filename), buf);
    return `/uploads/asset/stock/${market}/${encodeURIComponent(filename)}`;
  } catch {
    return null;
  }
}

/** 从 TradingView 标的页读取其官方 symbol logo；交易所不确定时按市场常用顺序尝试。 */
async function resolveTradingViewIcon(market: SyncMarket, code: string): Promise<string | null> {
  const symbol = code.toUpperCase().replace(/\.(OQ|N|AM|PS|K|HK|SS|SZ|T|KS|KQ)$/, "");
  const matches = await Promise.all(TRADINGVIEW_EXCHANGES[market].map(async (exchange) => {
    try {
      const page = await fetch(`https://www.tradingview.com/symbols/${exchange}-${encodeURIComponent(symbol)}/`, {
        headers: { "User-Agent": UA, Accept: "text/html" },
        signal: AbortSignal.timeout(3500)
      });
      if (!page.ok) return null;
      const html = await page.text();
      const match = html.match(/https:\/\/s3-symbol-logo\.tradingview\.com\/[A-Za-z0-9_/%.-]+--big\.svg/);
      return match?.[0] ?? null;
    } catch {
      return null;
    }
  }));
  return matches.find(Boolean) ?? null;
}

/* 图片魔数识别：octet-stream 场景下确认内容确为图片并推断扩展名 */
export { sniffImageExt } from "./imageSecurity";

export async function resolveIcon(market: SyncMarket, code: string, name: string): Promise<string | null> {
  const norm = normCode(market, code);
  // 新增股票缺图时优先采用 TradingView 标的页实际使用的官方图标，并保存为本地素材。
  const tradingView = await resolveTradingViewIcon(market, norm);
  if (tradingView) {
    const local = await downloadIcon(tradingView, market, norm, name);
    if (local) return local;
  }
  if (market === "US" || market === "HK" || market === "CN") {
    let tid = await searchWebull(norm, WEBULL_REGION[market]);
    // 代码搜不到时用中文名兜底（如「五粮液」），命中列表第一个股票
    if (!tid && name) tid = await searchWebull(name, WEBULL_REGION[market]);
    if (tid) {
      const local = await downloadIcon(WEBULL_ICON(tid), market, norm, name);
      if (local) return local;
    }
  } else {
    // 日韩：微牛不支持，用 parqet 图标
    const local = await downloadIcon(PARQET_ICON(norm), market, norm, name);
    if (local) return local;
  }
  return null;
}

/* ---------- 同步 / 退市 ---------- */

async function mapLimit<T>(arr: T[], limit: number, fn: (t: T) => Promise<void>): Promise<void> {
  const queue = [...arr];
  const workers = Array.from({ length: Math.min(limit, arr.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      try {
        await fn(item);
      } catch {
        /* 单个失败不中断 */
      }
    }
  });
  await Promise.all(workers);
}

export function getSyncStatus() {
  const row = getDb().prepare("SELECT value FROM site_settings WHERE key = ?").get("stockSyncAt") as { value?: string } | undefined;
  return { ...syncState, lastSyncAt: row?.value ?? "" };
}

/* 补齐归属市场：只拉列表更新现有 assets 的 board，不重新下载图标 */
export async function backfillBoard(): Promise<{ ok: boolean; updated: number }> {
  try {
    const [us, hk, cn] = await Promise.all([fetchEmTop("US"), fetchEmTop("HK"), fetchEmTop("CN")]);
    const db = getDb();
    // 补归属市场 + 市值（市值仅当列表值有效时写入，避免覆盖手动数据）
    const upd = db.prepare(
      "UPDATE assets SET board = ?, market_cap = CASE WHEN ? > 0 THEN ? ELSE market_cap END WHERE type = 'stock' AND market = ? AND code = ?"
    );
    let updated = 0;
    [...us, ...hk, ...cn].forEach((s) => {
      const r = upd.run(s.board, s.marketCap, s.marketCap, s.market, s.code);
      updated += r.changes;
    });
    return { ok: true, updated };
  } catch {
    return { ok: false, updated: 0 };
  }
}

export async function syncStocks(onlyIcons = false): Promise<{ ok: boolean; message: string }> {
  if (syncState.running) return { ok: false, message: "同步进行中，请稍候" };
  syncState.running = true;
  syncState.total = 0;
  syncState.done = 0;
  syncState.current = onlyIcons ? "补全缺失图标…" : "拉取市值排行…";
  syncState.error = "";
  try {
    if (!onlyIcons) {
      const [us, hk, cn, jp, kr] = await Promise.all([
        fetchEmTop("US"),
        fetchEmTop("HK"),
        fetchEmTop("CN"),
        fetchCmcTop("JP"),
        fetchCmcTop("KR")
      ]);
      const all = [...us, ...hk, ...cn, ...jp, ...kr];
      syncState.total = all.length;
      if (all.length === 0) {
        syncState.error = "外部数据源暂不可用";
        return { ok: false, message: "外部数据源暂不可用" };
      }
      const hasIconStmt = getDb().prepare(
        "SELECT url FROM assets WHERE type = 'stock' AND market = ? AND code = ? AND url <> ''"
      );
      await mapLimit(all, 3, async (item) => {
        // 已有图标的股票复用本地 URL，不重复下载（新股票 / 缺失图标才下载，显著加快全量同步）
        const existing = hasIconStmt.get(item.market, item.code) as { url?: string } | undefined;
        const local = existing?.url || (await resolveIcon(item.market, item.code, item.name));
        upsertAsset({
          type: "stock",
          market: item.market,
          code: item.code,
          name: item.name,
          url: local ?? "",
          marketCap: item.marketCap,
          price: item.price,
          changePct: item.changePct,
          source: "auto",
          lastCheckedAt: nowIso(),
          board: item.board
        });
        syncState.done += 1;
        syncState.current = `${item.market} ${item.code} ${item.name}`;
      });
    }
    // 补漏：为存量中图标缺失（url 为空）的股票重试下载，避免一次同步失败后长期缺图标
    const empty = getDb()
      .prepare("SELECT market, code, name FROM assets WHERE type = 'stock' AND source = 'auto' AND (url = '' OR url IS NULL)")
      .all() as { market: SyncMarket; code: string; name: string }[];
    syncState.total = empty.length;
    syncState.done = 0;
    let filled = 0;
    await mapLimit(empty, 2, async (r) => {
      const local = await resolveIcon(r.market, r.code, r.name);
      if (local) {
        getDb()
          .prepare("UPDATE assets SET url = ?, updated_at = ? WHERE type = 'stock' AND market = ? AND code = ?")
          .run(local, nowIso(), r.market, r.code);
        filled += 1;
      }
      syncState.done += 1;
    });
    syncState.current = `完成（补图标 ${filled}/${empty.length}）`;
    getDb().prepare("INSERT INTO site_settings (key, value) VALUES ('stockSyncAt', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(nowIso());
    return { ok: true, message: `同步完成，补图标 ${filled}/${empty.length}` };
  } catch (err) {
    syncState.error = err instanceof Error ? err.message : "同步失败";
    return { ok: false, message: syncState.error };
  } finally {
    syncState.running = false;
  }
}

/* 退市检测：东方财富行情接口批量探测 US/HK/CN（连续两次失败才删除，防停牌误删）；日韩暂无稳定行情源，暂不检测 */
function emSecid(market: "US" | "HK" | "CN", code: string): string {
  if (market === "US") return `105.${code}`;
  if (market === "HK") return `116.${code.padStart(5, "0")}`;
  return /^6/.test(code) ? `1.${code}` : `0.${code}`;
}

async function isDelisted(market: "US" | "HK" | "CN", code: string): Promise<boolean> {
  try {
    const res = await fetch(
      `https://push2.eastmoney.com/api/qt/stock/get?secid=${emSecid(market, code)}&fields=f57,f58`,
      { headers: EM_HEADERS, signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return false; // 网络问题不算退市
    const data = (await res.json().catch(() => null)) as { data?: { f58?: string } | null } | null;
    if (data?.data && data.data.f58) return false;
    if (data?.data === null || !data?.data) return true;
    return false;
  } catch {
    return false;
  }
}

export async function checkDelisted(): Promise<{ ok: boolean; removed: number }> {
  const rows = getDb()
    .prepare("SELECT id, market, code FROM assets WHERE type = 'stock' AND source = 'auto' AND market IN ('US','HK','CN')")
    .all() as { id: string; market: "US" | "HK" | "CN"; code: string }[];
  const candidates: { id: string; market: "US" | "HK" | "CN"; code: string }[] = [];
  await mapLimit(rows, 8, async (r) => {
    if (await isDelisted(r.market, r.code)) candidates.push(r);
  });
  // 二次确认：第一轮疑似退市的再验证一次
  const confirmed: string[] = [];
  await mapLimit(candidates, 8, async (r) => {
    if (await isDelisted(r.market, r.code)) confirmed.push(r.id);
  });
  if (confirmed.length > 0) {
    const del = getDb().prepare("DELETE FROM assets WHERE id = ?");
    getDb().transaction(() => confirmed.forEach((id) => del.run(id)))();
  }
  return { ok: true, removed: confirmed.length };
}
