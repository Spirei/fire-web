import { getDb } from "./db";
import { getAssetMatches } from "./assets";
import { readActiveQuotePool } from "./quotes";
import { QuoteSubscriptionsStore } from "./quoteSubscriptionsStore";
import { poolView, type PoolScope, type PoolSnapshot } from "./quotePoolView";
import type { AssetLookupKey } from "./assetLookup";
import { normalizeMarketCode } from "./marketCode";

/** Read-only dashboard: no service initialization, touch, prune, or quote fetch. */
export function readQuotePool(userId: string, scope: PoolScope): PoolSnapshot {
  const at = Date.now(), store = new QuoteSubscriptionsStore(getDb(), { now: () => at });
  const snapshot = poolView(scope === "shared" ? store.aggregate() : store.demands(userId), readActiveQuotePool(), scope, at);
  const assets = getAssetMatches(snapshot.entries.flatMap<AssetLookupKey>(row => row.market === "ASSET"
    ? [{ type: "crypto" as const, market: "", code: row.code }, { type: "metal" as const, market: "", code: row.code }]
    : [{ type: "stock" as const, market: row.market, code: row.code }]));
  const icons = new Map(assets.map(asset => [`${asset.type === "stock" ? asset.market : "ASSET"}:${asset.type === "stock" ? normalizeMarketCode(asset.market, asset.code) : asset.code.toUpperCase()}`, asset]));
  return { ...snapshot, entries: snapshot.entries.map(row => {
    const asset = icons.get(`${row.market}:${row.code}`);
    return { ...row, name: asset?.name || row.code, icon: asset?.imageUrl || asset?.url || "" };
  }) };
}
