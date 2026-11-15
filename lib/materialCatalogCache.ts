/** Last accepted material catalog page, used to paint before the network read. */
const MATERIAL_PAGE_CACHE = "fire:material:page:v1";
const MAX_CACHED_BYTES = 1_000_000;

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
  try {
    const prefix = `${MATERIAL_PAGE_CACHE}:${ownerId || "guest"}:`;
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(prefix)) localStorage.removeItem(key);
    }
  } catch { /* optional view cache */ }
}

/** Warm the default catalog page when the mouse reaches the sidebar entry. */
export async function prefetchMaterialCatalog(ownerId: string, type = "market") {
  const key = `${ownerId || "guest"}|${type}|ALL||1|`;
  try {
    const response = await fetch(`/api/assets/catalog?${new URLSearchParams({ type, market: "ALL", q: "", page: "1", removed: "0" })}`, {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!response.ok) return;
    const data = await response.json();
    if (!data || !Array.isArray(data.assets) || !Number.isFinite(data.total)) return;
    saveCachedMaterialListing(ownerId, key, data);
  } catch { /* the view still loads on click */ }
}
