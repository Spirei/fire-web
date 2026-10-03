import type { StockRecord } from "./types";

export const RECORDS_WORKSPACES = new Set(["holdings", "watchlist", "assets", "pnl", "fire", "earnings"]);

/** One owned read at a time; cancellation/generation protects local writes and resumed accounts. */
export function createRecordsRefresh(ownerId: string,
  read: (signal: AbortSignal) => Promise<{ ownerId: string; records: StockRecord[] }>,
  apply: (records: StockRecord[]) => void, now: () => number = Date.now, ownerChanged: () => void = () => {}) {
  let active = false, disposed = false, generation = 0, resumedAt = -Infinity;
  let pending: Promise<void> | null = null, controller: AbortController | null = null;
  const invalidate = () => { generation++; controller?.abort(); controller = null; pending = null; };
  const refresh = () => {
    if (!active || disposed) return Promise.resolve();
    if (pending) return pending;
    const token = generation, current = new AbortController();
    controller = current;
    const operation = Promise.resolve().then(() => read(current.signal)).then(snapshot => {
      if (!disposed && active && token === generation && !current.signal.aborted) {
        if (snapshot.ownerId === ownerId) apply(snapshot.records);
        else if (snapshot.ownerId) ownerChanged();
      }
    }).catch(() => { /* Keep confirmed data on a failed background read. */ }).finally(() => {
      if (controller === current) { controller = null; pending = null; }
    });
    pending = operation;
    return operation;
  };
  return {
    refresh, invalidate,
    setActive(next: boolean) { const entered = next && !active; active = next; if (!next) invalidate(); else if (entered) { resumedAt = now(); void refresh(); } },
    resume() { if (!active || disposed || now() - resumedAt < 1000) return; resumedAt = now(); void refresh(); },
    changed() { invalidate(); void refresh(); },
    dispose() { disposed = true; active = false; invalidate(); }
  };
}
