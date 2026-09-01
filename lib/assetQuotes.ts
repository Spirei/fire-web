/* ---------- 素材库加密货币 / 贵金属行情 ----------
 *
 * 素材库 crypto / metal 分类需要 市值 / 最新价 / 涨跌幅：
 *  - 加密货币：CoinGecko simple/price（代码 → CoinGecko id 映射，含市值 / 现价 / 24h 涨跌幅）
 *  - 贵金属：companiesmarketcap 全球资产榜（GOLD / SILVER / PLAT，含市值 / 现价 / 涨跌幅）
 *
 * 行情缓存到内存 + data/asset-quotes-cache.json：加密货币 5 分钟、贵金属 6 小时（与 CMC 缓存一致），
 * 冷启动读磁盘缓存秒出；缓存过期后在后台刷新，不阻塞页面请求。
 */
import fs from "node:fs";
import path from "node:path";
import { proxyFetch } from "@/lib/net";
import { getTopStocks } from "@/lib/topStocks";

export interface AssetQuote {
  price: number;
  changePct: number;
  marketCap: number;
}

/** 素材库加密货币代码 → CoinGecko id（39 个内置币种） */
const CRYPTO_IDS: Record<string, string> = {
  AAVE: "aave",
  ALGO: "algorand",
  AVAX: "avalanche-2",
  LINK: "chainlink",
  ATOM: "cosmos",
  CRO: "cronos",
  CRV: "curve-dao-token",
  FET: "fetch-ai",
  FIL: "filecoin",
  HBAR: "hedera-hashgraph",
  ICP: "internet-computer",
  INJ: "injective",
  LDO: "lido-dao",
  NEAR: "near",
  CAKE: "pancakeswap",
  PEPE: "pepe",
  QNT: "quant-network",
  RNDR: "render-token",
  SEI: "sei-network",
  SHIB: "shiba-inu",
  SOL: "solana",
  SUI: "sui",
  UNI: "uniswap",
  ZEC: "zcash",
  ETH: "ethereum",
  ETC: "ethereum-classic",
  VET: "vechain",
  BNB: "binancecoin",
  XLM: "stellar",
  BTC: "bitcoin",
  BCH: "bitcoin-cash",
  DOT: "polkadot",
  TRX: "tron",
  DOGE: "dogecoin",
  XRP: "xrp",
  ADA: "cardano",
  LTC: "litecoin",
  DASH: "dash",
  XMR: "monero"
};

export async function getCryptoQuote(code: string): Promise<AssetQuote | null> {
  const key = code.trim().toUpperCase();
  if (!key || !CRYPTO_IDS[key]) return null;
  const rows = await enrichAssetQuotes([{ type: "crypto", code: key, price: null, changePct: null, marketCap: 0 }]);
  const row = rows[0];
  return row?.price != null ? { price: row.price, changePct: row.changePct ?? 0, marketCap: row.marketCap ?? 0 } : null;
}

const CACHE_FILE = path.join(process.cwd(), "data", "asset-quotes-cache.json");
const CRYPTO_TTL = 5 * 60 * 1000;
const METAL_TTL = 6 * 60 * 60 * 1000;

interface QuoteCache {
  crypto: Record<string, AssetQuote>;
  cryptoAt: number;
  metal: Record<string, AssetQuote>;
  metalAt: number;
}

let memCache: QuoteCache | null = null;
let refreshing = false;
let refreshPromise: Promise<void> | null = null;

function loadDiskCache(): QuoteCache | null {
  try {
    const raw = fs.readFileSync(CACHE_FILE, "utf8");
    const parsed = JSON.parse(raw) as QuoteCache;
    if (parsed && typeof parsed.cryptoAt === "number" && typeof parsed.metalAt === "number") {
      return {
        crypto: parsed.crypto && typeof parsed.crypto === "object" ? parsed.crypto : {},
        cryptoAt: parsed.cryptoAt,
        metal: parsed.metal && typeof parsed.metal === "object" ? parsed.metal : {},
        metalAt: parsed.metalAt
      };
    }
  } catch {
    /* 无缓存或损坏，忽略 */
  }
  return null;
}

function saveDiskCache(cache: QuoteCache) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  } catch {
    /* 写盘失败不影响请求 */
  }
}

async function fetchCryptoQuotes(): Promise<Record<string, AssetQuote>> {
  const ids = [...new Set(Object.values(CRYPTO_IDS))].join(",");
  if (!ids) return {};
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_market_cap=true&include_24hr_change=true`;
  const res = await proxyFetch(url, { signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`CoinGecko 返回 ${res.status}`);
  const data = (await res.json().catch(() => null)) as Record<string, Record<string, unknown>> | null;
  if (!data || typeof data !== "object") throw new Error("CoinGecko 数据异常");
  const out: Record<string, AssetQuote> = {};
  for (const [code, id] of Object.entries(CRYPTO_IDS)) {
    const row = data[id];
    if (!row) continue;
    const price = Number(row.usd);
    const marketCap = Number(row.usd_market_cap);
    const changePct = Number(row.usd_24h_change);
    if (Number.isFinite(price) && price > 0) {
      out[code] = {
        price,
        marketCap: Number.isFinite(marketCap) && marketCap > 0 ? marketCap : 0,
        changePct: Number.isFinite(changePct) ? changePct : 0
      };
    }
  }
  // CoinGecko 可能只返回价格而暂时缺少市值；用同一全球资产榜的加密货币行补齐，避免 0 市值参与排序。
  if (Object.values(CRYPTO_IDS).some((id) => {
    const code = Object.entries(CRYPTO_IDS).find(([, value]) => value === id)?.[0];
    return code && (!out[code] || out[code].marketCap <= 0);
  })) {
    try {
      const fallback = await getTopStocks("ALL");
      fallback.items.forEach((item) => {
        if (item.type !== "crypto" || item.marketCap <= 0) return;
        const code = item.code.toUpperCase();
        if (!out[code]) out[code] = { price: item.price ?? 0, marketCap: item.marketCap, changePct: item.changePct ?? 0 };
        else if (out[code].marketCap <= 0) out[code].marketCap = item.marketCap;
      });
    } catch {
      /* 备用来源失败时保留 CoinGecko 已返回的价格 */
    }
  }
  return out;
}

async function fetchMetalQuotes(): Promise<Record<string, AssetQuote>> {
  const { items } = await getTopStocks("ALL");
  const out: Record<string, AssetQuote> = {};
  for (const it of items) {
    if (it.type !== "metal") continue;
    out[it.code.toUpperCase()] = {
      price: it.price ?? 0,
      marketCap: it.marketCap || 0,
      changePct: it.changePct ?? 0
    };
  }
  return out;
}

async function refreshQuotes(): Promise<void> {
  const base = memCache ?? loadDiskCache() ?? { crypto: {}, cryptoAt: 0, metal: {}, metalAt: 0 };
  const cryptoStale = Date.now() - base.cryptoAt > CRYPTO_TTL;
  const metalStale = Date.now() - base.metalAt > METAL_TTL;
  const [cryptoRes, metalRes] = await Promise.allSettled([
    cryptoStale ? fetchCryptoQuotes() : Promise.resolve(base.crypto),
    metalStale ? fetchMetalQuotes() : Promise.resolve(base.metal)
  ]);
  const next: QuoteCache = {
    crypto: cryptoRes.status === "fulfilled" && Object.keys(cryptoRes.value).length > 0 ? cryptoRes.value : base.crypto,
    cryptoAt: cryptoRes.status === "fulfilled" && Object.keys(cryptoRes.value).length > 0 ? Date.now() : base.cryptoAt,
    metal: metalRes.status === "fulfilled" && Object.keys(metalRes.value).length > 0 ? metalRes.value : base.metal,
    metalAt: metalRes.status === "fulfilled" && Object.keys(metalRes.value).length > 0 ? Date.now() : base.metalAt
  };
  memCache = next;
  saveDiskCache(next);
}

function ensureRefresh() {
  const cache = memCache ?? loadDiskCache();
  const now = Date.now();
  const cryptoMissingCaps = !cache || Object.values(cache.crypto).some((quote) => !Number.isFinite(quote.marketCap) || quote.marketCap <= 0);
  const stale = !cache || cryptoMissingCaps || now - cache.cryptoAt > CRYPTO_TTL || now - cache.metalAt > METAL_TTL;
  if (stale && !refreshing) {
    refreshing = true;
    refreshPromise = refreshQuotes()
      .catch(() => {})
      .finally(() => {
        refreshing = false;
        refreshPromise = null;
      });
  }
}

/** 全球市值榜首次加载必须等待行情补齐，避免冷启动把加密货币以 0 市值排到末尾。 */
export async function ensureAssetQuotesReady() {
  ensureRefresh();
  if (refreshPromise) await refreshPromise;
}

/**
 * 将最新行情合并到素材行（crypto 按代码 / metal 按代码），返回合并后的数组。
 * 数据源不可用时保留原值（行内已有数据不受影响）。
 */
export function enrichAssetQuotes<T extends { type: string; code: string; price: number | null; changePct: number | null; marketCap: number }>(
  assets: T[]
): T[] {
  ensureRefresh();
  const cache = memCache ?? loadDiskCache();
  if (!cache) return assets;
  for (const a of assets) {
    const q =
      a.type === "crypto"
        ? cache.crypto[a.code.toUpperCase()]
        : a.type === "metal"
          ? cache.metal[a.code.toUpperCase()]
          : undefined;
    if (!q) continue;
    a.price = q.price;
    a.changePct = q.changePct;
    if (q.marketCap > 0) a.marketCap = q.marketCap;
  }
  return assets;
}

/**
 * 默认股票素材只携带名称与图标；线上新数据库不能依赖本地历史回填结果。
 * 这里从与「全球预览」相同的持久化行情缓存补齐股票字段，使本地/GHCR 使用同一数据链路。
 */
export async function enrichStockAssetQuotes<T extends { type: string; market: string; code: string; price: number | null; changePct: number | null; marketCap: number }>(assets: T[]): Promise<T[]> {
  if (!assets.some((asset) => asset.type === "stock" && (asset.price == null || !asset.marketCap))) return assets;
  const markets = ["US", "HK", "CN", "JP", "KR"] as const;
  const results = await Promise.allSettled(markets.map((market) => getTopStocks(market)));
  const quotes = new Map<string, AssetQuote>();
  results.forEach((result) => {
    if (result.status !== "fulfilled") return;
    result.value.items.forEach((item) => quotes.set(`${item.market}:${item.code.toUpperCase()}`, {
      price: item.price ?? 0,
      changePct: item.changePct ?? 0,
      marketCap: item.marketCap || 0
    }));
  });
  assets.forEach((asset) => {
    if (asset.type !== "stock") return;
    const quote = quotes.get(`${asset.market.toUpperCase()}:${asset.code.toUpperCase()}`);
    if (!quote) return;
    if (quote.price > 0) asset.price = quote.price;
    asset.changePct = quote.changePct;
    if (quote.marketCap > 0) asset.marketCap = quote.marketCap;
  });
  return assets;
}
