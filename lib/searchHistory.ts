export const SEARCH_HISTORY_LIMIT = 20;
export type SearchHistoryItem = { id: string; query: string; searchedAt: string };
export type SearchHistorySnapshot = { revision: number; items: SearchHistoryItem[] };
export type SearchHistoryMutation =
  | { action: "record"; query: string; revision: number }
  | { action: "remove"; id: string; revision: number }
  | { action: "clear"; revision: number };

export function normalizeSearchQuery(value: unknown): string {
  if (typeof value !== "string") return "";
  const query = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  return query && Array.from(query).length <= 80 && !/[\x00-\x1f\x7f]/.test(query) ? query : "";
}

export function parseSearchMutation(value: unknown): SearchHistoryMutation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!Number.isSafeInteger(raw.revision) || Number(raw.revision) < 0) return null;
  const revision = Number(raw.revision);
  if (raw.action === "record" && Object.keys(raw).every(k => ["action", "revision", "query"].includes(k))) {
    const query = normalizeSearchQuery(raw.query);
    return query ? { action: "record", query, revision } : null;
  }
  if (raw.action === "remove" && Object.keys(raw).every(k => ["action", "revision", "id"].includes(k)) && typeof raw.id === "string" && /^[0-9a-f-]{36}$/i.test(raw.id))
    return { action: "remove", id: raw.id, revision };
  if (raw.action === "clear" && Object.keys(raw).every(k => ["action", "revision"].includes(k))) return { action: "clear", revision };
  return null;
}
