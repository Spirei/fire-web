import { getDb } from "./db";
import { isLocalUrl, removeFileIfUnused } from "./fileCleanup";
import fs from "fs";
import path from "path";
import { RELATED_ETF_MAIN_STOCK } from "./relatedEtfs";
import { getSiteSettings } from "./settings";
import { applyRelatedEtfMainStockIcons, stockIconLookupCodes } from "./stockIconKey";

const seeded = {
  icon: false,
  market: false,
  stock: false,
  broker: false,
  category: new Set<string>()
};
const existsCache = new Map<string, boolean>();

export type AssetType = "stock" | "market" | "flag" | "crypto" | "metal" | "broker" | "group" | "icon" | "card";

export interface Asset {
  id: string;
  type: AssetType;
  market: string;
  code: string;
  name: string;
  url: string;
  urlDark: string;
  marketCap: number;
  price: number | null;
  changePct: number | null;
  source: "auto" | "manual";
  lastCheckedAt: string;
  board: string;
  updatedAt: string;
}

function rowToAsset(r: Record<string, unknown>): Asset {
  const rawUrl = String(r.url ?? "");
  const rawUrlDark = String(r.url_dark ?? "");
  return {
    id: String(r.id),
    type: String(r.type) as AssetType,
    market: String(r.market ?? ""),
    code: String(r.code ?? ""),
    name: String(r.name ?? ""),
    // 数据库可能保留已被迁移/清理的历史文件 URL。不再把必然 404 的地址下发给全站，
    // 让各组件走现有的内置图标/首字母/CDN 兜底。resource-default 可读时仍视为有效。
    url: localAssetExists(rawUrl) ? rawUrl : "",
    urlDark: localAssetExists(rawUrlDark) ? rawUrlDark : "",
    marketCap: Number(r.market_cap) || 0,
    price: r.price === null || r.price === undefined ? null : Number(r.price),
    changePct: r.change_pct === null || r.change_pct === undefined ? null : Number(r.change_pct),
    source: (r.source === "auto" ? "auto" : "manual") as Asset["source"],
    lastCheckedAt: String(r.last_checked_at ?? ""),
    board: String(r.board ?? ""),
    updatedAt: String(r.updated_at)
  };
}

export function assetId(type: AssetType, market: string, code = ""): string {
  if (type === "market") return `market:${market.trim().toUpperCase()}`;
  if (type === "flag" || type === "crypto" || type === "metal" || type === "icon") return `${type}:${code.trim().toUpperCase()}`;
  if (type === "broker") return `broker:${code.trim().toUpperCase()}`;
  // 卡片素材：code 就是卡面文件路径，大小写敏感（含 ASCII 文件名的路径不能大写化）
  if (type === "card") return `card:${code}`;
  return `stock:${market.trim().toUpperCase()}:${code.trim().toUpperCase()}`;
}

/** 内置 UI 图标（素材库 → icon，可上传替换全局生效） */
const ICON_NAMES: Record<string, string> = {
  settings: "设置",
  holdings: "持仓",
  assets: "资产",
  watchlist: "自选",
  global: "全球经济",
  earnings: "盈利",
  celebs: "名人",
  activities: "动态",
  users: "用户",
  attachments: "附件",
  library: "素材库",
  site: "网站",
  sitemanage: "网站管理",
  stocks: "股票",
  profile: "个人信息",
  database: "数据库",
  api: "接口",
  cron: "定时",
  about: "关于",
  trade: "交易",
  fire: "fire",
  search: "搜索",
  plus: "新增",
  refresh: "刷新",
  close: "关闭",
  check: "完成"
};

export const DEFAULT_ICONS: { code: string; name: string; url: string }[] = [
  "settings", "holdings", "assets", "watchlist", "global", "earnings", "celebs", "activities",
  "users", "attachments", "library", "site", "sitemanage", "stocks", "profile", "database",
  "api", "cron", "about", "trade", "fire", "search", "plus", "refresh", "close", "check"
].map((code) => ({
  code,
  name: ICON_NAMES[code] ?? code, // 名称按素材库编辑时可改
  url: `/uploads/asset/icon/${code}.svg`
}));

/** 进入「图标」类目时补齐缺失的内置图标（按 code 逐条补齐，幂等，不覆盖已有素材） */
export function ensureIconAssets(): void {
  if (seeded.icon) return;
  seeded.icon = true;
  const db = getDb();
  DEFAULT_ICONS.forEach((it) => {
    const existing = db
      .prepare("SELECT COUNT(*) AS n FROM assets WHERE type = 'icon' AND code = ?")
      .get(it.code.toUpperCase()) as { n: number };
    if (existing.n > 0) return;
    upsertAsset({ type: "icon", market: "", code: it.code, name: it.name, url: it.url });
  });
}

/** 默认市场图标：随镜像打包在 /uploads/asset/market，供新用户开箱即用（市场标签/全球预览等） */
export const DEFAULT_MARKET_ICONS: { market: string; name: string; url: string }[] = [
  { market: "HK", name: "港股", url: "/uploads/asset/market/港股HK.svg" },
  { market: "CN", name: "A股", url: "/uploads/asset/market/A股CN.svg" },
  { market: "US", name: "美股", url: "/uploads/asset/market/美股US.svg" },
  { market: "JP", name: "日股", url: "/uploads/asset/market/日股JP.svg" },
  { market: "KR", name: "韩股", url: "/uploads/asset/market/韩股KR.svg" }
];

/** 进入「市场」类目时补齐缺失的内置市场图标（按 market 判断，缺失才播种，不覆盖用户已上传图标） */
export function ensureMarketAssets(): void {
  if (seeded.market) return;
  seeded.market = true;
  const db = getDb();
  DEFAULT_MARKET_ICONS.forEach((it) => {
    const market = it.market.toUpperCase();
    const existing = db.prepare("SELECT COUNT(*) AS n FROM assets WHERE type = 'market' AND market = ?").get(market) as { n: number };
    if (existing.n > 0) return;
    upsertAsset({ type: "market", market, code: market, name: it.name, url: it.url });
  });
}

function brokerNameKey(value: string): string {
  return value.trim().toLocaleLowerCase("zh-CN").replace(/[\s·._-]+/g, "").replace(/证[劵卷]/g, "证券");
}

function bundledAssetUrl(folder: string, file: string): string {
  return `/uploads/asset/${folder}/${encodeURIComponent(file)}`;
}

function localAssetExists(url: string): boolean {
  if (!url.startsWith("/uploads/")) return true;
  const cached = existsCache.get(url);
  if (cached !== undefined) return cached;
  let rel = url.slice("/uploads/".length);
  try { rel = decodeURIComponent(rel); } catch { /* malformed legacy URL: treat as missing */ }
  const ok = [
    path.join(process.cwd(), "public", "uploads", rel),
    path.join(process.cwd(), "resource-default", rel)
  ].some((file) => {
    try { return fs.statSync(file).isFile(); } catch { return false; }
  });
  existsCache.set(url, ok);
  return ok;
}

/** 当前持仓/自选需要的股票图标，按条查询，避免每次把 3000+ 素材扫一遍。 */
export function stockIconKeysForRecords(records: { market: string; code: string }[]): Array<{ market: string; code: string }> {
  const seen = new Set<string>();
  const pairs: Array<{ market: string; code: string }> = [];
  const add = (market: string, code: string) => {
    const key = `${market}:${code}`;
    if (!code || seen.has(key)) return;
    seen.add(key);
    pairs.push({ market, code });
  };
  records.forEach((record) => {
    const market = record.market.toUpperCase();
    const code = record.code.toUpperCase();
    add(market, code);
    if (market === "US") {
      const baseCode = code.replace(/\.(AM|N|OQ|PS|K)$/i, "");
      add("US", baseCode);
      const main = RELATED_ETF_MAIN_STOCK[baseCode];
      if (main) add("US", main);
    }
  });
  return pairs;
}

export function getStockIconMap(pairs: Array<{ market: string; code: string }>): Record<string, string> {
  if (!pairs.length) return {};
  const db = getDb();
  const stmt = db.prepare("SELECT market, code, url FROM assets WHERE type = 'stock' AND upper(market) = upper(?) AND upper(code) = upper(?) LIMIT 1");
  const out: Record<string, string> = {};
  pairs.forEach((pair) => {
    const market = pair.market.toUpperCase();
    for (const code of stockIconLookupCodes(market, pair.code)) {
      const row = stmt.get(market, code) as { market?: string; code?: string; url?: string } | undefined;
      const url = String(row?.url || "");
      if (!url || !localAssetExists(url)) continue;
      const storedMarket = String(row?.market).toUpperCase();
      const storedCode = String(row?.code).toUpperCase();
      out[`${storedMarket}:${storedCode}`] = url;
      out[`${market}:${pair.code.toUpperCase()}`] = url;
      break;
    }
  });
  return applyRelatedEtfMainStockIcons(out);
}

/**
 * 市场图标（素材库 type=market）随首屏 HTML 一起下发：市场下拉、市场筛选按钮首帧就是素材库图标，
 * 不再等客户端拿完 /api/assets 才切成真实图标（此前刷新/首次打开下拉会晚一拍才出现）。
 */
export function getMarketIconMap(): Record<string, string> {
  const db = getDb();
  const rows = db.prepare("SELECT market, code, url FROM assets WHERE type = 'market'").all() as Array<{
    market?: string;
    code?: string;
    url?: string;
  }>;
  const out: Record<string, string> = {};
  rows.forEach((row) => {
    const key = String(row.market || row.code || "").trim().toUpperCase();
    const url = String(row.url || "");
    if (!key || !url || !localAssetExists(url)) return;
    out[key] = url;
  });
  return out;
}

/** 当前导航所需的自定义图标随首屏下发，避免刷新后再等待完整 icon 素材接口。 */
export function getNavIconMap(codes: readonly string[]): Record<string, string> {
  const normalized = [...new Set(codes.map((code) => code.trim().toUpperCase()).filter(Boolean))];
  if (!normalized.length) return {};
  const stmt = getDb().prepare("SELECT code, url FROM assets WHERE type = 'icon' AND upper(code) = upper(?) LIMIT 1");
  const out: Record<string, string> = {};
  normalized.forEach((code) => {
    const row = stmt.get(code) as { code?: string; url?: string } | undefined;
    const url = String(row?.url || "");
    if (!url || !localAssetExists(url)) return;
    out[code] = url;
  });
  return out;
}

/** 用镜像内置券商素材补齐当前券商配置；按券商名称/别名匹配，幂等且不覆盖用户图标。 */
export function ensureBrokerAssets(): void {
  if (seeded.broker) return;
  seeded.broker = true;
  const dirs = [
    path.join(process.cwd(), "public", "uploads", "asset", "broker"),
    path.join(process.cwd(), "resource-default", "asset", "broker")
  ];
  const files = [...new Set(dirs.flatMap((dir) => {
    try { return fs.readdirSync(dir).filter((file) => /\.(svg|png|webp|jpg|jpeg)$/i.test(file)); } catch { return []; }
  }))];
  if (!files.length) return;
  const byName = new Map(files.map((file) => [brokerNameKey(file.replace(/\.(svg|png|webp|jpg|jpeg)$/i, "")), file]));
  const db = getDb();
  const findByCode = db.prepare("SELECT id, url FROM assets WHERE type = 'broker' AND upper(code) = upper(?) LIMIT 1");
  const repairUrl = db.prepare("UPDATE assets SET name = ?, url = ?, updated_at = ? WHERE id = ?");
  for (const group of getSiteSettings().groups) {
    const file = byName.get(brokerNameKey(group.name)) || (group.alias ? byName.get(brokerNameKey(group.alias)) : undefined);
    const existing = findByCode.get(group.id) as { id: string; url: string } | undefined;
    if (existing) {
      // 旧版曾把券商图标迁到 stock/GROUP；即使临时文件还在，也统一改回 broker 规范目录。
      const legacyFolder = existing.url.includes("/asset/stock/GROUP/");
      if (file && (legacyFolder || !existing.url || !localAssetExists(existing.url))) {
        repairUrl.run(group.name, bundledAssetUrl("broker", file), new Date().toISOString(), existing.id);
      }
      continue;
    }
    if (!file) continue;
    upsertAsset({ type: "broker", market: "GROUP", code: group.id, name: group.name, url: bundledAssetUrl("broker", file) });
  }
}

/**
 * 从镜像打包的默认素材目录播种素材库（crypto / metal / flag）。
 * - crypto / metal：文件名「名称 + 代码」，末尾大写串为代码（AaveAAVE.svg / 白银SILVER.svg）；
 * - flag：文件名即国家代码（us.svg / cn.svg）。
 * 素材库无条目时补种；已有条目的 URL 为空或本地文件丢失时恢复内置素材。
 * 有效的用户上传/同步素材始终保留。
 */
export function ensureCategoryAssets(type: "crypto" | "metal" | "flag"): void {
  if (seeded.category.has(type)) return;
  seeded.category.add(type);
  const subdir = type;
  const dirs = [
    path.join(process.cwd(), "public", "uploads", "asset", subdir),
    path.join(process.cwd(), "resource-default", "asset", subdir)
  ];
  const files = [...new Set(dirs.flatMap((dir) => {
    try { return fs.readdirSync(dir).filter((f) => /\.(svg|png|webp|jpg)$/i.test(f)); } catch { return []; }
  }))];
  if (!files.length) return;
  const db = getDb();
  files.forEach((file) => {
    const stem = file.replace(/\.(svg|png|webp|jpg)$/i, "");
    // 欧盟默认旗帜遵循素材库「中文名 + 代码」命名，但对外仍以 EU 作为唯一代码。
    if (type === "flag" && stem === "欧盟EU") {
      const existing = db.prepare("SELECT COUNT(*) AS n FROM assets WHERE type = 'flag' AND market = '' AND upper(code) = 'EU'").get() as { n: number };
      if (existing.n === 0) upsertAsset({ type, market: "", code: "EU", name: "欧盟", url: `/uploads/asset/${subdir}/${file}` });
      return;
    }
    const m = type === "flag" ? null : stem.match(/([A-Z0-9]{2,})$/);
    const code = type === "flag" ? stem : m ? m[1] : stem;
    const name = type === "flag" ? stem.toUpperCase() : m ? stem.slice(0, stem.length - m[1].length).trim().replace(/[-_]+$/, "") || stem : stem;
    if (!code) return;
    const existing = db.prepare("SELECT id, url FROM assets WHERE type = ? AND market = '' AND upper(code) = upper(?) LIMIT 1").get(type, code) as { id?: string; url?: string } | undefined;
    if (existing?.id) {
      // 默认素材升级时修复历史错误映射（例如 ETH 曾误指向 BTC 图标）。
      const expected = `/uploads/asset/${subdir}/${file}`;
      const currentUrl = existing.url || "";
      const missingLocalAsset = !currentUrl || !localAssetExists(currentUrl);
      if (currentUrl !== expected && (missingLocalAsset || /BTC|比特币/i.test(currentUrl) && code === "ETH")) {
        db.prepare("UPDATE assets SET url = ?, name = ?, updated_at = ? WHERE id = ?").run(expected, name, new Date().toISOString(), existing.id);
      }
      return;
    }
    upsertAsset({ type, market: "", code, name, url: `/uploads/asset/${subdir}/${file}` });
  });
}

/**
 * 播种素材库股票图标：读取镜像内置的 lib/assets-default-stock.json（来自本地高精度素材库、
 * 仅收录图标文件确已打包的条目，含正确 market/code/name/url），
 * 全新部署开箱即用，无需「同步大市值」按需填充。
 */
export function ensureStockAssets(): void {
  if (seeded.stock) return;
  seeded.stock = true;
  const seedPath = path.join(process.cwd(), "lib", "assets-default-stock.json");
  let list: { market: string; code: string; name: string; url: string }[] = [];
  try {
    list = JSON.parse(fs.readFileSync(seedPath, "utf-8"));
  } catch {
    return;
  }
  if (!Array.isArray(list) || list.length === 0) return;
  const db = getDb();
  const exists = db.prepare("SELECT COUNT(*) AS n FROM assets WHERE type = 'stock' AND market = ? AND code = ?");
  list.forEach((it) => {
    const market = (it.market || "").trim().toUpperCase();
    const code = (it.code || "").trim().toUpperCase();
    if (!market || !code || !it.url || !localAssetExists(it.url)) return;
    if ((exists.get(market, code) as { n: number }).n > 0) return;
    upsertAsset({ type: "stock", market, code, name: it.name || code, url: it.url, source: "manual" });
  });
}

export function getAssets(type?: AssetType): Asset[] {
  const db = getDb();
  const rows = type
    ? (db.prepare("SELECT * FROM assets WHERE type = ? ORDER BY market, code").all(type) as Record<string, unknown>[])
    : (db.prepare("SELECT * FROM assets ORDER BY type, market, code").all() as Record<string, unknown>[]);
  return rows.map(rowToAsset);
}

/** 服务端首屏按代码读取货币国旗，避免客户端为一个按钮等待完整国旗素材目录。 */
export function getFlagIconMap(codes: readonly string[]): Record<string, string> {
  ensureCategoryAssets("flag");
  const normalized = [...new Set(codes.map((code) => code.trim().toUpperCase()).filter(Boolean))];
  if (!normalized.length) return {};
  const stmt = getDb().prepare("SELECT code, url FROM assets WHERE type = 'flag' AND upper(code) = upper(?) LIMIT 1");
  const map: Record<string, string> = {};
  normalized.forEach((code) => {
    const row = stmt.get(code) as { code?: string; url?: string } | undefined;
    const url = String(row?.url || "");
    if (url && localAssetExists(url)) map[code] = url;
  });
  return map;
}

function localUploadFile(url: string): string | null {
  if (!url.startsWith("/uploads/")) return null;
  let rel = url.slice("/uploads/".length);
  try { rel = decodeURIComponent(rel); } catch { return null; }
  for (const file of [path.join(process.cwd(), "public", "uploads", rel), path.join(process.cwd(), "resource-default", rel)]) {
    try { if (fs.statSync(file).isFile()) return file; } catch { /* 继续检查镜像默认素材 */ }
  }
  return null;
}

/**
 * 固定货币的首屏版本：仍按素材库记录找文件，但把几百字节的本地图标内联进 HTML，
 * 浏览器第一次绘制无需再等待 /uploads 请求。远程自定义素材保留原 URL。
 */
export function getInlineFlagIconMap(codes: readonly string[]): Record<string, string> {
  const urls = getFlagIconMap(codes);
  const map: Record<string, string> = {};
  Object.entries(urls).forEach(([code, url]) => {
    const file = localUploadFile(url);
    if (!file) {
      map[code] = url;
      return;
    }
    const ext = path.extname(file).toLowerCase();
    const mime = ext === ".svg" ? "image/svg+xml" : ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "application/octet-stream";
    try { map[code] = `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`; }
    catch { map[code] = url; }
  });
  return map;
}

/** 按代码批量读取股票素材，供搜索联想补充相关 ETF；返回顺序与 codes 一致。 */
export function getStockAssetsByCodes(market: string, codes: string[]): Asset[] {
  const normalized = [...new Set(codes.map((code) => code.trim().toUpperCase()).filter(Boolean))];
  if (normalized.length === 0) return [];
  const placeholders = normalized.map(() => "?").join(",");
  const rows = getDb().prepare(`SELECT * FROM assets WHERE type = 'stock' AND market = ? AND code IN (${placeholders})`)
    .all(market.trim().toUpperCase(), ...normalized) as Record<string, unknown>[];
  const byCode = new Map(rows.map((row) => {
    const asset = rowToAsset(row);
    return [asset.code.toUpperCase(), asset] as const;
  }));
  return normalized.map((code) => byCode.get(code)).filter((asset): asset is Asset => Boolean(asset));
}

export function getAssetsPage(input: {
  type: AssetType;
  market?: string;
  query?: string;
  sort?: "rank" | "code" | "name" | "board" | "price" | "changePct" | "marketCap";
  dir?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}): { assets: Asset[]; total: number; page: number; pageSize: number } {
  const db = getDb();
  const pageSize = Math.min(100, Math.max(1, Math.floor(input.pageSize || 10)));
  const requestedPage = Math.max(1, Math.floor(input.page || 1));
  const where = ["type = ?"];
  const params: Array<string | number> = [input.type];
  if (input.market && input.market !== "ALL") {
    where.push("market = ?");
    params.push(input.market.toUpperCase());
  }
  const query = input.query?.trim();
  if (query) {
    where.push("(code LIKE ? OR name LIKE ?)");
    params.push(`%${query}%`, `%${query}%`);
  }
  const columns = { rank: "market_cap", code: "code", name: "name", board: "board", price: "price", changePct: "change_pct", marketCap: "market_cap" } as const;
  const column = columns[input.sort || "rank"] || columns.rank;
  const dir = input.dir === "asc" ? "ASC" : "DESC";
  const clause = where.join(" AND ");
  const total = Number((db.prepare(`SELECT COUNT(*) AS n FROM assets WHERE ${clause}`).get(...params) as { n: number }).n) || 0;
  const page = Math.min(requestedPage, Math.max(1, Math.ceil(total / pageSize)));
  const rows = db.prepare(`SELECT * FROM assets WHERE ${clause} ORDER BY ${column} ${dir}, code ASC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize) as Record<string, unknown>[];
  return { assets: rows.map(rowToAsset), total, page, pageSize };
}

export function upsertAsset(input: {
  type: AssetType;
  market: string;
  code?: string;
  name?: string;
  url?: string;
  id?: string;
  marketCap?: number;
  price?: number | null;
  changePct?: number | null;
  source?: "auto" | "manual";
  lastCheckedAt?: string;
  board?: string;
  urlDark?: string;
}): Asset {
  const db = getDb();
  const market = (input.market || "OTHER").trim().toUpperCase();
  const code = (input.code || "").trim().toUpperCase();
  const id = input.id || assetId(input.type, market, code);
  const name = (input.name || code || market || "").trim();
  const updatedAt = new Date().toISOString();
  const source = input.source ?? "manual";
  const marketCap = Number(input.marketCap) || 0;
  const price = input.price === undefined || input.price === null ? null : Number(input.price);
  const changePct = input.changePct === undefined || input.changePct === null ? null : Number(input.changePct);
  const lastCheckedAt = input.lastCheckedAt ?? "";
  const board = (input.board ?? "").trim();
  const url = input.url ?? "";
  const urlDark = input.urlDark === undefined ? null : input.urlDark;
  // 替换图标时删除旧本地文件，保留唯一（同一条素材多次上传不堆积）
  const oldRow = db.prepare("SELECT url, url_dark FROM assets WHERE id = ?").get(id) as { url?: string; url_dark?: string } | undefined;
  db.prepare(
    `INSERT INTO assets (id, type, market, code, name, url, url_dark, market_cap, price, change_pct, source, last_checked_at, board, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       type=excluded.type, market=excluded.market, code=excluded.code,
       name=CASE WHEN assets.source <> 'manual' OR excluded.source = 'manual' THEN excluded.name ELSE assets.name END,
       url=CASE WHEN excluded.url <> '' AND (assets.source <> 'manual' OR excluded.source = 'manual') THEN excluded.url ELSE assets.url END,
       url_dark=CASE WHEN excluded.url_dark IS NOT NULL THEN excluded.url_dark ELSE assets.url_dark END,
       market_cap=CASE WHEN excluded.market_cap > 0 THEN excluded.market_cap ELSE assets.market_cap END,
       price=CASE WHEN excluded.price IS NOT NULL THEN excluded.price ELSE assets.price END,
       change_pct=CASE WHEN excluded.change_pct IS NOT NULL THEN excluded.change_pct ELSE assets.change_pct END,
       source=CASE WHEN assets.source = 'manual' THEN assets.source ELSE excluded.source END,
       last_checked_at=excluded.last_checked_at,
       board=CASE WHEN assets.source <> 'manual' OR excluded.source = 'manual' THEN excluded.board ELSE assets.board END,
       -- 首次入库时间只在「第一次插入」时写入：冲突时原样保留（老素材留空 = 不是新素材）
       created_at=assets.created_at,
       updated_at=excluded.updated_at`
  ).run(id, input.type, market, code, name, url, urlDark, marketCap, price, changePct, source, lastCheckedAt, board, updatedAt, updatedAt);
  if (url) existsCache.set(url, true);
  if (urlDark) existsCache.set(urlDark, true);
  if (oldRow?.url && isLocalUrl(oldRow.url) && oldRow.url !== url) {
    // 旧文件仍被其它记录引用时保留（removeFileIfUnused 内部判断）
    removeFileIfUnused(oldRow.url);
  }
  if (oldRow?.url_dark && isLocalUrl(oldRow.url_dark) && oldRow.url_dark !== urlDark) {
    removeFileIfUnused(oldRow.url_dark);
  }
  const row = db.prepare("SELECT * FROM assets WHERE id = ?").get(id) as Record<string, unknown>;
  return rowToAsset(row);
}

export function deleteAsset(id: string): void {
  const db = getDb();
  const row = db.prepare("SELECT url FROM assets WHERE id = ?").get(id) as { url?: string } | undefined;
  db.prepare("DELETE FROM assets WHERE id = ?").run(id);
  if (row?.url) removeFileIfUnused(row.url);
}
