import { getDb } from "./db";
import type { HomeNavItem, Market, SiteSettings, TabConfig, TickerConfig } from "./types";
import { DEFAULT_HOLDING_COLUMNS, normalizeHoldingColumns } from "./holdingColumns";
import fs from "fs";
import path from "path";

export const DEFAULT_HOME_NAV: HomeNavItem[] = [
  { key: "preview", label: "产品预览", href: "#preview", enabled: true },
  { key: "features", label: "功能介绍", href: "#features", enabled: true },
  { key: "records", label: "自选记录", href: "/records", enabled: false }
];

export const DEFAULT_TICKER: TickerConfig = {
  items: [
    { key: "usDJI", secid: "100.DJIA", label: "道琼斯", market: "US" },
    { key: "usIXIC", secid: "100.NDX", label: "纳斯达克综合指数", market: "US" },
    { key: "usINX", secid: "100.SPX", label: "标普500", market: "US" },
    { key: "hkHSI", secid: "100.HSI", label: "恒生指数", market: "HK" },
    { key: "sgSTI", secid: "100.STI", label: "新加坡STI", market: "SG" },
    { key: "jpN225", secid: "100.N225", label: "日经225", market: "JP" },
    { key: "krKS11", secid: "100.KS11", label: "韩国KOSPI", market: "KR" }
  ],
  interval: 5
};

const DEFAULTS: SiteSettings = {
  domain: "localhost:3000",
  title: "Fire - 股票记录与持仓管理",
  ico: "",
  homepageBg: "",
  loginSideImage: "",
  tabs: [
    { key: "holdings", label: "账户资产", url: "/holdings", default: true },
    { key: "assets", label: "资产分析", url: "/asset-analysis" },
    { key: "fire", label: "FIRE", url: "/fire" },
    { key: "watchlist", label: "自选股", url: "/watchlist" },
    { key: "global", label: "全球经济", url: "/global" },
    { key: "trading", label: "交易广场", url: "/trading" },
    { key: "earnings", label: "财报日历", url: "/earnings" },
    { key: "celebs", label: "名人持仓", url: "/celebs" },
    { key: "users", label: "用户管理", url: "/users" },
    { key: "attachments", label: "附件管理", url: "/attachments" },
    { key: "library", label: "素材库", url: "/library" },
    { key: "activities", label: "日志", url: "/activities" },
    { key: "settings", label: "设置", url: "/settings" }
  ],
  groups: [],
  homeNav: DEFAULT_HOME_NAV,
  markets: [],
  marketLabels: [],
  assetMarketOrder: [],
  indicesOrder: [],
  holdingColumns: DEFAULT_HOLDING_COLUMNS,
  allowRegister: true,
  stockIconCdn: false,
  siteLogo: "",
  logoText: "Fire",
  logoFont: "diatype",
  quoteSource: "auto",
  futuHost: "127.0.0.1",
  futuPort: "11111",
  footerDesc: "一个轻量、免费的股票记录网站，帮你管理自选与持仓。",
  quoteApiUrl: "https://qt.gtimg.cn/q=",
  searchApiUrl: "https://smartbox.gtimg.cn/s3/?v=2&q={q}&t=all",
  chartApiUrl: "https://web.ifzq.gtimg.cn/appstock/app/minute/query?code={code}",
  currencyApiUrl: "https://api.frankfurter.dev/v1/latest",
  earningsApiUrl: "https://api.nasdaq.com/api/calendar/earnings?date=",
  cnEarningsApiUrl: "https://datacenter.eastmoney.com/securities/api/data/v1/get",
  usLogoApiUrl: "https://g.foolcdn.com/art/companylogos/square/",
  cnLogoApiUrl: "https://assets.parqet.com/logos/symbol/",
  trumpArchiveApiUrl: "https://trumpstruth.org/",
  translationApiUrl: "https://api.mymemory.translated.net/get",
  translationEnabled: true,
  translationProvider: "mymemory",
  deepseekApiUrl: "https://api.deepseek.com/chat/completions",
  deepseekModel: "deepseek-chat",
  deepseekApiKey: "",
  llmProvider: "deepseek",
  llmApiUrl: "https://api.deepseek.com/chat/completions",
  llmModel: "deepseek-chat",
  llmApiKey: "",
  dbType: "sqlite",
  pgHost: "",
  pgPort: "5432",
  pgDatabase: "",
  pgUser: "",
  pgPassword: "",
  ticker: DEFAULT_TICKER
};

const SIMPLE_KEYS: ("domain" | "title" | "ico" | "homepageBg" | "loginSideImage" | "siteLogo" | "logoText" | "logoFont" | "quoteSource" | "futuHost" | "futuPort" | "footerDesc" | "quoteApiUrl" | "searchApiUrl" | "chartApiUrl" | "currencyApiUrl" | "earningsApiUrl" | "cnEarningsApiUrl" | "usLogoApiUrl" | "cnLogoApiUrl" | "trumpArchiveApiUrl" | "translationApiUrl" | "translationProvider" | "deepseekApiUrl" | "deepseekModel" | "deepseekApiKey" | "pgHost" | "pgPort" | "pgDatabase" | "pgUser" | "pgPassword")[] = [
  "domain", "title", "ico", "homepageBg", "loginSideImage", "siteLogo", "logoText", "logoFont", "quoteSource", "futuHost", "futuPort", "footerDesc",
  "quoteApiUrl", "searchApiUrl", "chartApiUrl", "currencyApiUrl", "earningsApiUrl", "cnEarningsApiUrl", "usLogoApiUrl", "cnLogoApiUrl", "trumpArchiveApiUrl", "translationApiUrl", "translationProvider", "deepseekApiUrl", "deepseekModel", "deepseekApiKey", "llmProvider", "llmApiUrl", "llmModel", "llmApiKey",
  "pgHost", "pgPort", "pgDatabase", "pgUser", "pgPassword"
];

export const NAV_KEYS = ["holdings", "assets", "fire", "watchlist", "global", "trading", "earnings", "celebs", "users", "attachments", "library", "activities", "settings"] as const;
const DEFAULT_LABELS: Record<string, string> = Object.fromEntries(
  DEFAULTS.tabs.map((t) => [t.key, t.label])
);

function normTabUrl(key: string, raw: unknown): string {
  const fallback = key === "assets" ? "/asset-analysis" : `/${key}`;
  if (typeof raw !== "string") return fallback;
  const v = raw.trim();
  if (!v.startsWith("/") || /[?#]/.test(v)) return fallback;
  const u = v.replace(/\/+$/, "") || fallback;
  if (key === "assets" && u === "/assets") return "/asset-analysis";
  return u;
}

function defaultTabUrl(key: string): string {
  return key === "assets" ? "/asset-analysis" : `/${key}`;
}

// 首页导航链接白名单：仅允许锚点 / 站内相对路径 / http(s)，防止 javascript: 等危险协议
function safeHref(href: string): string {
  const v = href.trim();
  if (!v) return "#";
  if (v.startsWith("#") || v.startsWith("/")) return v;
  if (/^https?:\/\//i.test(v)) return v;
  return "#";
}

function parseTabs(raw: string | undefined): TabConfig[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const seen = new Set<string>();
    const valid: TabConfig[] = [];
    parsed.forEach((t: unknown) => {
      if (t && typeof t === "object" && typeof (t as TabConfig).key === "string" && typeof (t as TabConfig).label === "string") {
        const key = (t as TabConfig).key;
        if ((NAV_KEYS as readonly string[]).includes(key) && !seen.has(key)) {
          seen.add(key);
          valid.push({
            key,
            label: (t as TabConfig).label.trim() || DEFAULT_LABELS[key],
            url: normTabUrl(key, (t as TabConfig).url),
            default: (t as TabConfig).default === true
          });
        }
      }
    });
    (NAV_KEYS as readonly string[]).forEach((key) => {
      if (seen.has(key)) return;
      // 缺失的导航项插到其 NAV 前序键之后（如「名人持仓」紧跟「财报日历」下方）；
      // 前序键不存在时再按 NAV_KEYS 顺序找下一个已存在项的位置
      const navIdx = (NAV_KEYS as readonly string[]).indexOf(key);
      const prev = navIdx > 0 ? (NAV_KEYS as readonly string[])[navIdx - 1] : null;
      let pos = -1;
      if (prev) {
        const pi = valid.findIndex((v) => v.key === prev);
        if (pi !== -1) pos = pi + 1;
      }
      if (pos === -1) {
        pos = valid.findIndex((v) => (NAV_KEYS as readonly string[]).indexOf(v.key) > navIdx);
      }
      const entry = { key, label: DEFAULT_LABELS[key], url: defaultTabUrl(key) };
      if (pos === -1) valid.push(entry);
      else valid.splice(pos, 0, entry);
    });
    normalizeDefault(valid);
    return valid.length > 0 ? valid : null;
  } catch {
    return null;
  }
}

function parseHomeNav(raw: string | undefined): HomeNavItem[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const seen = new Set<string>();
    const valid: HomeNavItem[] = [];
    parsed.forEach((n: unknown) => {
      if (!n || typeof n !== "object") return;
      const item = n as Partial<HomeNavItem>;
      if (typeof item.key !== "string" || !item.key.trim() || seen.has(item.key)) return;
      seen.add(item.key);
      valid.push({
        key: item.key,
        label: typeof item.label === "string" && item.label.trim() ? item.label.trim() : item.key,
        href: typeof item.href === "string" ? safeHref(item.href) : "#",
        enabled: item.enabled !== false
      });
    });
    return valid.length > 0 ? valid : null;
  } catch {
    return null;
  }
}

function normalizeDefault(tabs: TabConfig[]) {
  const marked = tabs.filter((t) => t.default === true);
  if (marked.length === 1) return;
  if (marked.length > 1) {
    marked.slice(1).forEach((t) => {
      t.default = false;
    });
    return;
  }
  if (tabs.length > 0) tabs[0].default = true;
}

// 站点设置极高频读取（每个页面请求 / 每次行情批次都会读），且几乎不变：
// 用内存缓存避免每次全表 SELECT + 逐项 JSON.parse。写入口只有 updateSiteSettings，
// 写后统一失效重建，保证跨请求一致。
let settingsCache: SiteSettings | null = null;

/** OpenD 主机只接受 hostname/IP；兼容旧版误填的 http(s)://地址和附带端口。 */
export function normalizeFutuHost(value: string): string {
  const raw = value.trim();
  if (!raw) return "127.0.0.1";
  try {
    return new URL(raw.includes("://") ? raw : `http://${raw}`).hostname || raw;
  } catch {
    return raw.replace(/^https?:\/\//i, "").split("/")[0] || "127.0.0.1";
  }
}

export function getSiteSettings(): SiteSettings {
  if (settingsCache) return settingsCache;
  const rows = getDb()
    .prepare("SELECT key, value FROM site_settings")
    .all() as { key: string; value: string }[];
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const result: SiteSettings = { ...DEFAULTS };
  SIMPLE_KEYS.forEach((k) => {
    if (typeof map[k] === "string" && map[k] !== "") (result as unknown as Record<string, string>)[k] = map[k];
  });
  // 用户可能在外部删除 uploads 文件，或从旧备份恢复了已过期路径。
  // 本地站点素材不存在时按空值下发，让首页/登录页正常显示内置兜底，而不是空白或破图。
  (["ico", "homepageBg", "siteLogo", "loginSideImage"] as const).forEach((key) => {
    const value = result[key];
    if (!value.startsWith("/uploads/")) return;
    let rel = value.slice("/uploads/".length);
    try { rel = decodeURIComponent(rel); } catch { /* 非法编码按原字符检查 */ }
    const exists = [
      path.join(process.cwd(), "public", "uploads", rel),
      path.join(process.cwd(), "resource-default", rel)
    ].some((file) => {
      try { return fs.statSync(file).isFile(); } catch { return false; }
    });
    if (!exists) result[key] = "";
  });
  if (map.logoFont !== "diatype" && map.logoFont !== "diatype-regular" && map.logoFont !== "system") {
    result.logoFont = "diatype";
  }
  if (map.quoteSource !== "auto" && map.quoteSource !== "futu" && map.quoteSource !== "tencent") {
    result.quoteSource = "auto";
  }
  result.futuHost = normalizeFutuHost(result.futuHost);
  if (!/^\d{1,5}$/.test(result.futuPort)) result.futuPort = "11111";
  if (map.dbType === "postgres") result.dbType = "postgres";
  const parsedTabs = parseTabs(map.tabs);
  if (parsedTabs) {
    // 旧版本迁移：股票添加（quotes）/ 全球预览 → 全球经济（global）
    result.tabs = parsedTabs.map((t) => {
      if (t.key === "quotes") return { ...t, key: "global", label: "全球经济", url: t.url === "/quotes" ? "/global" : t.url };
      if (t.key === "global" && t.label === "全球预览") return { ...t, label: "全球经济" };
      return t;
    });
  }
  if (typeof map.groups === "string") {
    try {
      const parsed = JSON.parse(map.groups);
      if (Array.isArray(parsed)) {
        result.groups = parsed.filter(
          (g: unknown): g is { id: string; name: string; alias?: string } =>
            !!g && typeof (g as { id?: unknown }).id === "string" && typeof (g as { name?: unknown }).name === "string"
        ).map((g) => ({
          id: g.id,
          name: g.name,
          alias: typeof (g as { alias?: unknown }).alias === "string" ? (g as { alias: string }).alias : undefined
        }));
      }
    } catch { /* 无效分组配置忽略 */ }
  }
  const parsedHomeNav = parseHomeNav(map.homeNav);
  if (parsedHomeNav) result.homeNav = parsedHomeNav;
  if (typeof map.markets === "string") {
    try {
      const parsed = JSON.parse(map.markets);
      if (Array.isArray(parsed)) {
        const seen = new Set<string>();
        result.markets = parsed.filter((m: unknown): m is Market => {
          if (typeof m !== "string" || m.trim().length === 0 || seen.has(m)) return false;
          seen.add(m);
          return true;
        });
      }
    } catch { /* 无效市场配置忽略 */ }
  }
  if (typeof map.marketLabels === "string") {
    try {
      const parsed = JSON.parse(map.marketLabels);
      if (Array.isArray(parsed)) {
        result.marketLabels = parsed.filter(
          (l: unknown): l is { key: string; label: string; flag: string } =>
            !!l && typeof (l as { key?: unknown }).key === "string" &&
            (l as { key: string }).key.length > 0 &&
            typeof (l as { label?: unknown }).label === "string" &&
            typeof (l as { flag?: unknown }).flag === "string"
        );
      }
    } catch { /* 无效市场标签忽略 */ }
  }
  if (typeof map.assetMarketOrder === "string") {
    try {
      const parsed = JSON.parse(map.assetMarketOrder);
      if (Array.isArray(parsed)) {
        const seen = new Set<string>();
        result.assetMarketOrder = parsed.filter((m: unknown): m is string => {
          if (typeof m !== "string" || m.trim().length === 0 || seen.has(m)) return false;
          seen.add(m);
          return true;
        });
      }
    } catch { /* 无效市场顺序忽略 */ }
  }
  if (typeof map.indicesOrder === "string") {
    try {
      const parsed = JSON.parse(map.indicesOrder);
      if (Array.isArray(parsed)) {
        const seen = new Set<string>();
        result.indicesOrder = parsed.filter((m: unknown): m is string => {
          if (typeof m !== "string" || m.trim().length === 0 || seen.has(m)) return false;
          seen.add(m);
          return true;
        });
      }
    } catch { /* 无效顺序忽略 */ }
  }
  if (typeof map.holdingColumns === "string") {
    try {
      result.holdingColumns = normalizeHoldingColumns(JSON.parse(map.holdingColumns));
    } catch { /* 无效持仓列配置忽略 */ }
  }
  if (typeof map.ticker === "string") {
    try {
      const parsed = JSON.parse(map.ticker) as { items?: unknown; interval?: unknown };
      if (parsed && typeof parsed === "object") {
        const seen = new Set<string>();
        const items = Array.isArray(parsed.items)
          ? (parsed.items as unknown[])
              .filter(
                (it): it is { key: string; label: string; secid: string; market: string } =>
                  !!it &&
                  typeof it === "object" &&
                  typeof (it as { key?: unknown }).key === "string" &&
                  (it as { key: string }).key.trim().length > 0 &&
                  !seen.has((it as { key: string }).key) &&
                  typeof (it as { secid?: unknown }).secid === "string" &&
                  (it as { secid: string }).secid.trim().length > 0 &&
                  typeof (it as { label?: unknown }).label === "string" &&
                  (it as { label: string }).label.trim().length > 0 &&
                  typeof (it as { market?: unknown }).market === "string" &&
                  (it as { market: string }).market.trim().length > 0
              )
              .map((it) => {
                seen.add(it.key.trim());
                return { key: it.key.trim(), label: it.label.trim(), secid: it.secid.trim(), market: it.market.trim() };
              })
          : [];
        if (items.length > 0) {
          const interval = Math.min(60, Math.max(3, Math.round(Number(parsed.interval)) || DEFAULT_TICKER.interval));
          result.ticker = { items, interval };
        }
      }
    } catch { /* 无效指数配置忽略 */ }
  }
  result.allowRegister = map.allowRegister !== "0";
  result.stockIconCdn = map.stockIconCdn === "1";
  settingsCache = result;
  return result;
}

export function updateSiteSettings(patch: Partial<SiteSettings>): SiteSettings {
  const db = getDb();
  const upsert = db.prepare(`
    INSERT INTO site_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  SIMPLE_KEYS.forEach((k) => {
    const v = patch[k];
    if (typeof v === "string") upsert.run(k, v.trim());
  });
  if (patch.dbType === "sqlite" || patch.dbType === "postgres") {
    upsert.run("dbType", patch.dbType);
  }
  if (Array.isArray(patch.tabs)) {
    const seen = new Set<string>();
    const valid: TabConfig[] = [];
    patch.tabs.forEach((t) => {
      if (t && typeof t.key === "string" && typeof t.label === "string") {
        const key = t.key;
        if ((NAV_KEYS as readonly string[]).includes(key) && !seen.has(key)) {
          seen.add(key);
          valid.push({
            key,
            label: t.label.trim() || DEFAULT_LABELS[key],
            url: normTabUrl(key, t.url),
            default: t.default === true
          });
        }
      }
    });
    (NAV_KEYS as readonly string[]).forEach((key) => {
      if (!seen.has(key)) valid.push({ key, label: DEFAULT_LABELS[key], url: defaultTabUrl(key) });
    });
    normalizeDefault(valid);
    upsert.run("tabs", JSON.stringify(valid));
  }
  if (Array.isArray(patch.groups)) {
    const valid = patch.groups
      .filter(
        (g): g is { id: string; name: string; alias?: string } =>
          !!g && typeof g.id === "string" && typeof g.name === "string"
      )
      .map((g) => ({
        id: g.id,
        name: g.name.trim() || "未命名分组",
        alias: typeof g.alias === "string" && g.alias.trim() ? g.alias.trim() : undefined
      }));
    upsert.run("groups", JSON.stringify(valid));
    // 券商改名时同步素材库 broker 素材名称（券商图标按名称映射全局生效）
    const brokerSync = db.prepare("UPDATE assets SET name = ?, updated_at = ? WHERE type = 'broker' AND UPPER(code) = ?");
    valid.forEach((g) => {
      brokerSync.run(g.name, new Date().toISOString(), g.id.toUpperCase());
    });
  }
  if (Array.isArray(patch.homeNav)) {
    const seen = new Set<string>();
    const valid = patch.homeNav
      .filter(
        (n): n is HomeNavItem =>
          !!n && typeof n.key === "string" && n.key.trim().length > 0 &&
          typeof n.label === "string" && typeof n.href === "string" && !seen.has(n.key)
      )
      .filter((n) => {
        if (seen.has(n.key)) return false;
        seen.add(n.key);
        return true;
      })
      .map((n) => ({
        key: n.key.trim(),
        label: n.label.trim() || n.key,
        href: safeHref(n.href),
        enabled: n.enabled !== false
      }));
    upsert.run("homeNav", JSON.stringify(valid.length > 0 ? valid : DEFAULT_HOME_NAV));
  }
  if (Array.isArray(patch.markets)) {
    const seen = new Set<string>();
    const valid = patch.markets.filter((m): m is Market => {
      if (typeof m !== "string" || m.trim().length === 0 || seen.has(m)) return false;
      seen.add(m);
      return true;
    });
    upsert.run("markets", JSON.stringify(valid.map((m) => m.trim())));
  }
  if (Array.isArray(patch.marketLabels)) {
    const seen = new Set<string>();
    const valid = patch.marketLabels
      .filter(
        (l) =>
          !!l &&
          typeof l.key === "string" &&
          l.key.length > 0 &&
          typeof l.label === "string" &&
          (l.flag === undefined || typeof l.flag === "string")
      )
      .filter((l) => {
        if (seen.has(l.key)) return false;
        seen.add(l.key);
        return true;
      })
      .map((l) => ({ key: l.key, label: l.label.trim() || l.key, flag: (l.flag || "🌍").trim() || "🌍" }));
    upsert.run("marketLabels", JSON.stringify(valid));
  }
  if (Array.isArray(patch.assetMarketOrder)) {
    const seen = new Set<string>();
    const valid = patch.assetMarketOrder.filter((m: unknown): m is string => {
      if (typeof m !== "string" || m.trim().length === 0 || seen.has(m)) return false;
      seen.add(m);
      return true;
    });
    upsert.run("assetMarketOrder", JSON.stringify(valid));
  }
  if (Array.isArray(patch.indicesOrder)) {
    const seen = new Set<string>();
    const valid = patch.indicesOrder.filter((m: unknown): m is string => {
      if (typeof m !== "string" || m.trim().length === 0 || seen.has(m)) return false;
      seen.add(m);
      return true;
    });
    upsert.run("indicesOrder", JSON.stringify(valid));
  }
  if (Array.isArray(patch.holdingColumns)) {
    upsert.run("holdingColumns", JSON.stringify(normalizeHoldingColumns(patch.holdingColumns)));
  }
  if (patch.ticker && typeof patch.ticker === "object" && Array.isArray(patch.ticker.items)) {
    const seen = new Set<string>();
    const valid = patch.ticker.items
      .filter((it): it is TickerConfig["items"][number] => {
        if (!it || typeof it !== "object") return false;
        const key = typeof (it as { key?: unknown }).key === "string" ? (it as { key: string }).key.trim() : "";
        const secid = typeof (it as { secid?: unknown }).secid === "string" ? (it as { secid: string }).secid.trim() : "";
        const label = typeof (it as { label?: unknown }).label === "string" ? (it as { label: string }).label.trim() : "";
        const market = typeof (it as { market?: unknown }).market === "string" ? (it as { market: string }).market.trim() : "";
        return key.length > 0 && secid.length > 0 && label.length > 0 && market.length > 0 && !seen.has(key);
      })
      .map((it) => {
        const o = it as { key: string; label: string; secid: string; market: string };
        seen.add(o.key.trim());
        return { key: o.key.trim(), label: o.label.trim(), secid: o.secid.trim(), market: o.market.trim() };
      });
    if (valid.length > 0) {
      const interval = Math.min(60, Math.max(3, Math.round(Number(patch.ticker.interval)) || DEFAULT_TICKER.interval));
      upsert.run("ticker", JSON.stringify({ items: valid, interval }));
    }
  }
  if (typeof patch.allowRegister === "boolean") {
    upsert.run("allowRegister", patch.allowRegister ? "1" : "0");
  }
  if (typeof patch.stockIconCdn === "boolean") {
    upsert.run("stockIconCdn", patch.stockIconCdn ? "1" : "0");
  }
  settingsCache = null;
  return getSiteSettings();
}
