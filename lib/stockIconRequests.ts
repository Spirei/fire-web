import { relatedStock } from './relatedEtfs';
import { applyRelatedEtfMainStockIcons, pickStockIcon } from './stockIconKey';

export type StockIconPair = { market: string; code: string };
export type StockIconAsset = { type?: string; market?: string; code?: string; imageUrl?: string; url?: string };

/** Include the underlying in the same read; related ETF artwork is derived from it. */
export function stockIconBatches(pairs: readonly StockIconPair[]): string[][] {
  const keys = new Set<string>();
  for (const pair of pairs) {
    const market = pair.market.trim().toUpperCase(), code = pair.code.trim().toUpperCase();
    if (!market || market === 'ASSET' || !code || /[:,\s]/.test(market + code)) continue;
    const main = relatedStock(market, code);
    if (main) keys.add(`${market}:${main.code}`);
    keys.add(`${market}:${code}`);
  }
  const values = [...keys], batches: string[][] = [];
  // The Web exact-lookup contract accepts 200 keys; leave space for related artwork.
  for (let at = 0; at < values.length; at += 100) batches.push(values.slice(at, at + 100));
  return batches;
}

export function stockIconMap(assets: readonly StockIconAsset[]): Record<string, string> {
  const icons: Record<string, string> = {};
  for (const asset of assets) {
    const url = asset.imageUrl || asset.url;
    if (asset.type === 'stock' && asset.market && asset.code && url) icons[`${asset.market.toUpperCase()}:${asset.code.toUpperCase()}`] = url;
  }
  return icons;
}

/** Request-local, read-only preload. Missing batches do not hide available artwork. */
export async function readStockIcons(pairs: readonly StockIconPair[], read: <T>(path: string) => Promise<T>) {
  const batches = stockIconBatches(pairs), icons: Record<string, string> = {};
  for (let at = 0; at < batches.length; at += 2) {
    const results = await Promise.all(batches.slice(at, at + 2).map(async keys => {
      try { return await read<{ assets: StockIconAsset[] }>('/api/assets?type=stock&keys=' + encodeURIComponent(keys.join(','))); }
      catch { return { assets: [] }; }
    }));
    for (const result of results) Object.assign(icons, stockIconMap(result.assets || []));
  }
  return icons;
}

/** Prioritize a small set of visible-page images without downloading the whole catalog. */
export function stockIconPreloads(pairs: readonly StockIconPair[], icons: Record<string, string>, limit = 12) {
  const resolved = applyRelatedEtfMainStockIcons({ ...icons });
  return [...new Set(pairs.map(pair => pickStockIcon(resolved, pair.market, pair.code)).filter((url): url is string => !!url))].slice(0, limit);
}
