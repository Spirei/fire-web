import { getDb } from "./db";
import { isLocalUrl, removeFileIfUnused } from "./fileCleanup";
import fs from "fs";
import path from "path";
import { getSiteSettings } from "./settings";

export type AssetType = "stock" | "market" | "flag" | "crypto" | "metal" | "broker" | "group" | "icon";

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
  return {
    id: String(r.id),
    type: String(r.type) as AssetType,
    market: String(r.market ?? ""),
    code: String(r.code ?? ""),
    name: String(r.name ?? ""),
    url: String(r.url),
    urlDark: String(r.url_dark ?? ""),
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

/** 用镜像内置券商素材补齐当前券商配置；按券商名称/别名匹配，幂等且不覆盖用户图标。 */
export function ensureBrokerAssets(): void {
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
  const exists = db.prepare("SELECT COUNT(*) AS n FROM assets WHERE type = 'broker' AND upper(code) = upper(?)");
  for (const group of getSiteSettings().groups) {
    if ((exists.get(group.id) as { n: number }).n > 0) continue;
    const file = byName.get(brokerNameKey(group.name)) || (group.alias ? byName.get(brokerNameKey(group.alias)) : undefined);
    if (!file) continue;
    upsertAsset({ type: "broker", market: "GROUP", code: group.id, name: group.name, url: `/uploads/asset/broker/${file}` });
  }
}

/**
 * 从镜像打包的默认素材目录播种素材库（crypto / metal / flag）。
 * - crypto / metal：文件名「名称 + 代码」，末尾大写串为代码（AaveAAVE.svg / 白银SILVER.svg）；
 * - flag：文件名即国家代码（us.svg / cn.svg）。
 * 仅在素材库无该 type+code 条目时补种（幂等，不覆盖用户已上传/已同步的真实素材）。
 */
export function ensureCategoryAssets(type: "crypto" | "metal" | "flag"): void {
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
    const existing = db.prepare("SELECT COUNT(*) AS n FROM assets WHERE type = ? AND market = '' AND code = ?").get(type, code) as { n: number };
    if (existing.n > 0) return;
    upsertAsset({ type, market: "", code, name, url: `/uploads/asset/${subdir}/${file}` });
  });
}

/**
 * 播种素材库股票图标：读取镜像内置的 lib/assets-default-stock.json（来自本地高精度素材库、
 * 仅收录图标文件确已打包的条目，含正确 market/code/name/url），
 * 全新部署开箱即用，无需「同步大市值」按需填充。
 */
export function ensureStockAssets(): void {
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
    if (!market || !code || !it.url) return;
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
    `INSERT INTO assets (id, type, market, code, name, url, url_dark, market_cap, price, change_pct, source, last_checked_at, board, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
       updated_at=excluded.updated_at`
  ).run(id, input.type, market, code, name, url, urlDark, marketCap, price, changePct, source, lastCheckedAt, board, updatedAt);
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
