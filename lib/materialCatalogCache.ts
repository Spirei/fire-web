import type { MaterialListing } from "./workspaceInitial";
import { readMaterialResponse } from "./materialRead";

/** Last accepted material catalog page, used to paint before the network read. */
const MATERIAL_PAGE_CACHE = "fire:material:page:v1";
const MAX_CACHED_BYTES = 1_000_000;
const prefetches = new Map<string, { ownerId: string; controller: AbortController; work: Promise<MaterialListing | null> }>();

export function materialListingScope(ownerId: string, type: string, removed: boolean) {
  return JSON.stringify([ownerId, type, removed]) + "|";
}

export function materialListingKey(ownerId: string, type: string, market = "ALL", query = "", page = 1, removed = false, review = false) {
  return materialListingScope(ownerId, type, removed) + JSON.stringify([market, query, page, review]);
}

export function materialPageKey(ownerId: string, readKey: string) {
  return `${MATERIAL_PAGE_CACHE}:${ownerId || "guest"}:${readKey}`;
}

export function readCachedMaterialListing<T>(ownerId: string, readKey: string): { data: T; at: number } | null {
  try {
    const saved = JSON.parse(localStorage.getItem(materialPageKey(ownerId, readKey)) || "null") as { data?: T; at?: number } | null;
    if (!saved?.data || !Array.isArray((saved.data as { assets?: unknown }).assets)) return null;
    return { data: saved.data, at: Number(saved.at) || 0 };
  } catch {
    return null;
  }
}

export function saveCachedMaterialListing<T>(ownerId: string, readKey: string, data: T) {
  try {
    const value = JSON.stringify({ data, at: Date.now() });
    if (value.length > MAX_CACHED_BYTES) return;
    localStorage.setItem(materialPageKey(ownerId, readKey), value);
  } catch { /* optional view cache */ }
}

export function clearCachedMaterialListings(ownerId: string) {
  for (const [key, request] of prefetches) {
    if (request.ownerId !== ownerId) continue;
    request.controller.abort();
    prefetches.delete(key);
  }
  try {
    const prefix = `${MATERIAL_PAGE_CACHE}:${ownerId || "guest"}:`;
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(prefix)) localStorage.removeItem(key);
    }
  } catch { /* optional view cache */ }
}

export function pendingMaterialCatalog(key: string) {
  return prefetches.get(key)?.work;
}

/** Share an in-flight category read between sidebar preparation and the active view. */
export function prefetchMaterialCatalog(ownerId: string, type = "market") {
  const key = materialListingKey(ownerId, type);
  const pending = pendingMaterialCatalog(key);
  if (pending) return pending;
  const cached = readCachedMaterialListing<MaterialListing>(ownerId, key);
  if (cached && Date.now() - cached.at < 60000) return;
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);
  const query = new URLSearchParams({ type, market: "ALL", q: "", page: "1", removed: "0" });
  const work = readMaterialResponse(`/api/assets/catalog?${query}`, signal)
    .then(data => {
      if (!Array.isArray(data.assets) || !Number.isFinite(data.total) || !Number.isFinite(data.page)) return null;
      saveCachedMaterialListing(ownerId, key, data);
      return data as MaterialListing;
    })
    .catch(() => null)
    .finally(() => {
      if (pendingMaterialCatalog(key) === work) prefetches.delete(key);
    });
  prefetches.set(key, { ownerId, controller, work });
  return work;
}
