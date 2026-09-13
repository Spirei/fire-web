import { NextResponse } from "next/server";
import { searchStocks } from "@/lib/quotes";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";
import { proxyFetch } from "@/lib/net";
import { getAssetsPage } from "@/lib/assets";
import { isMainstreamCryptoCode, searchMainstreamCrypto } from "@/lib/mainstreamCrypto";

type SearchResult = Awaited<ReturnType<typeof searchStocks>>[number];
const SEARCH_CACHE_TTL = 30_000;
const searchCache = new Map<string, { expiresAt: number; results: SearchResult[] }>();

function rememberResults(key: string, results: SearchResult[]): void {
  searchCache.delete(key);
  searchCache.set(key, { expiresAt: Date.now() + SEARCH_CACHE_TTL, results });
  while (searchCache.size > 200) {
    const oldest = searchCache.keys().next().value;
    if (!oldest) break;
    searchCache.delete(oldest);
  }
}

async function searchCrypto(q: string, signal: AbortSignal): Promise<SearchResult[]> {
  try {
    const res = await proxyFetch(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(q)}`, { signal });
    if (!res.ok) return [];
    const data = (await res.json().catch(() => null)) as { coins?: { id?: string; symbol?: string; name?: string }[] } | null;
    return (data?.coins ?? []).filter((c) => isMainstreamCryptoCode(String(c.symbol ?? ""))).slice(0, 5).map((c) => ({
      symbol: `CRYPTO:${String(c.id ?? c.symbol ?? "").toLowerCase()}`,
      code: String(c.symbol ?? "").toUpperCase(),
      name: String(c.name ?? "").trim(),
      market: "ASSET" as const,
      price: null,
      changePct: null,
      type: "crypto" as const
    })).filter((c) => c.code && c.name);
  } catch {
    return [];
  }
}

function localStockMatches(q: string): SearchResult[] {
  const assets = getAssetsPage({ type: "stock", query: q, sort: "marketCap", dir: "desc", pageSize: 8 }).assets;
  return assets.map((asset) => {
    const market = asset.market as SearchResult["market"];
    const code = asset.code.toUpperCase();
    const symbol = market === "CN"
      ? `${/^(4|8|920)/.test(code) ? "bj" : /^[69]/.test(code) ? "sh" : "sz"}${code}`
      : `${market.toLowerCase()}${market === "HK" ? code.padStart(5, "0") : code}`;
    return { symbol, code, name: asset.name, market, price: asset.price, changePct: asset.changePct };
  });
}

function specialStockMatches(q: string): SearchResult[] {
  const normalized = q.trim().toLocaleLowerCase().replace(/[\s_-]+/g, "");
  const isRam = normalized === "ram"
    || (/dram/.test(normalized) && (/(?:2x|2倍|两倍|二倍|2做多|long)/.test(normalized)));
  if (!isRam) return [];
  return [{
    symbol: "usRAM",
    code: "RAM",
    name: "DRAM 2 倍做多 ETF",
    market: "US",
    price: null,
    changePct: null
  }];
}

export async function GET(request: Request) {
  if (!rateLimit(`search:${clientIp(request)}`, 60, 60 * 1000) || !rateLimitGlobal("search", 300, 60 * 1000)) {
    return NextResponse.json({ error: "请求过于频繁，请稍后再试" }, { status: 429 });
  }
  const q = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  if (!q) return NextResponse.json({ results: [] });
  if (q.length > 50) return NextResponse.json({ error: "搜索关键词过长" }, { status: 400 });

  const cacheKey = q.toLocaleLowerCase();
  const cached = searchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return NextResponse.json({ results: cached.results });
  }

  try {
    // 新上市产品可能尚未进入腾讯 smartbox / 本地素材库，用受控别名保证代码和常见描述可命中。
    const specialStocks = specialStockMatches(q);
    if (specialStocks.length > 0) {
      rememberResults(cacheKey, specialStocks);
      return NextResponse.json({ results: specialStocks });
    }

    // 主流币别名命中时只返回币本体，避免“比特币”混入 ETF、储备公司和策略基金。
    const mainstreamCrypto = searchMainstreamCrypto(q);
    if (mainstreamCrypto.length > 0) {
      rememberResults(cacheKey, mainstreamCrypto);
      return NextResponse.json({ results: mainstreamCrypto });
    }

    // 素材库覆盖常用股票，SQLite 本地命中可直接返回，省去两次外部行情往返。
    const localResults = localStockMatches(q);
    if (localResults.length > 0) {
      rememberResults(cacheKey, localResults);
      return NextResponse.json({ results: localResults });
    }

    // 股票与加密货币并行查询；股票已命中时立即返回，不再串行等待境外 CoinGecko。
    const cryptoController = new AbortController();
    const cryptoTimer = setTimeout(() => cryptoController.abort(), 2500);
    const cryptoPromise = searchCrypto(q, cryptoController.signal);
    const results = await searchStocks(q);
    const combined = results.length > 0 ? results : await cryptoPromise;
    if (results.length > 0) cryptoController.abort();
    clearTimeout(cryptoTimer);
    rememberResults(cacheKey, combined);
    return NextResponse.json({ results: combined });
  } catch (err) {
    return NextResponse.json({ error: "搜索失败，请稍后重试" }, { status: 502 });
  }
}
