import type { searchStocks } from "@/lib/quotes";
import { getAssetsPage, getStockAssetsByCodes } from "@/lib/assets";
import { US_RELATED_ETFS } from "@/lib/relatedEtfs";
type SearchResult = Awaited<ReturnType<typeof searchStocks>>[number];

export function localStockMatches(q: string): SearchResult[] {
  const assets = getAssetsPage({ type: "stock", query: q, sort: "marketCap", dir: "desc", pageSize: 8 }).assets;
  const matches = assets.map((asset) => {
    const market = asset.market as SearchResult["market"];
    const code = asset.code.toUpperCase();
    const symbol = market === "CN"
      ? `${/^(4|8|920)/.test(code) ? "bj" : /^[69]/.test(code) ? "sh" : "sz"}${code}`
      : `${market.toLowerCase()}${market === "HK" ? code.padStart(5, "0") : code}`;
    return { symbol, code, name: asset.name, market, price: asset.price, changePct: asset.changePct };
  });
  const primary = matches.find((match) => match.market === "US" && US_RELATED_ETFS[match.code]);
  if (!primary) {
    if (matches.length) return matches;
    const code = q.trim().toUpperCase();
    for (const [root, entries] of Object.entries(US_RELATED_ETFS)) {
      const item = entries.find(value => value.code === code);
      if (!item) continue;
      const assets = getStockAssetsByCodes("US", [root, code]);
      const asset = assets.find(value => value.code === code), underlying = assets.find(value => value.code === root);
      const direction = item.kind === "long" ? "做多" : item.kind === "short" ? "做空" : "收益策略";
      return [{ symbol: `us${code}`, code, market: "US", name: asset?.name || `${underlying?.name || root} ${item.badge.match(/2X/i) ? "2 倍" : ""}${direction} ETF`.replace(/\s+/g, " "), price: asset?.price ?? null, changePct: asset?.changePct ?? null }];
    }
    return [];
  }

  const related = US_RELATED_ETFS[primary.code];
  const stored = new Map(getStockAssetsByCodes("US", related.map((item) => item.code)).map((asset) => [asset.code, asset]));
  const relatedMatches: SearchResult[] = related.map((item) => {
    const asset = stored.get(item.code);
    const direction = item.kind === "long" ? "做多" : item.kind === "short" ? "做空" : "收益策略";
    return {
      symbol: `us${item.code}`,
      code: item.code,
      name: asset?.name || `${primary.name} ${item.badge.match(/2X/i) ? "2 倍" : ""}${direction} ETF`.replace(/\s+/g, " "),
      market: "US",
      price: asset?.price ?? null,
      changePct: asset?.changePct ?? null
    };
  });
  const relatedCodes = new Set(related.map((item) => item.code));
  return [primary, ...relatedMatches, ...matches.filter((match) => match.code !== primary.code && !relatedCodes.has(match.code))].slice(0, 8);
}

