const STORAGE_KEY = "fire:showcase:loaded-models:v1";
const completed = new Set<string>();

/** Successful rendering receipts, keyed by versioned asset, model parameters and quality. */
export function hasLoadedModel(key: string): boolean {
  if (completed.has(key)) return true;
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(saved) && saved.includes(key);
  } catch { return false; }
}

export function rememberLoadedModel(key: string): void {
  completed.add(key);
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    const previous = Array.isArray(saved) ? saved.filter((item): item is string => typeof item === "string" && item !== key) : [];
    localStorage.setItem(STORAGE_KEY, JSON.stringify([key, ...previous].slice(0, 64)));
  } catch { /* Storage disabled: keep this session silent without blocking rendering. */ }
}
