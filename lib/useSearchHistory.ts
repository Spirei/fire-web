"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { normalizeSearchQuery, type SearchHistoryMutation, type SearchHistorySnapshot } from "./searchHistory";
import { showToast } from "./toast";

export function useSearchHistory(ownerId: string, open: boolean) {
  const [history, setHistory] = useState<SearchHistorySnapshot | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const current = useRef<SearchHistorySnapshot | null>(null);
  const writes = useRef(Promise.resolve());
  const pendingCount = useRef(0), writeRevision = useRef(0), writeEpoch = useRef(0);
  const generation = useRef(0);
  const loadPromise = useRef<Promise<void> | null>(null);
  const apply = useCallback((next: SearchHistorySnapshot) => {
    if (current.current && next.revision < current.current.revision) return;
    current.current = next; setHistory(next);
  }, []);
  const refresh = useCallback(() => {
    if (loadPromise.current) return loadPromise.current;
    const token = generation.current;
    setLoading(true);
    const promise = (async () => {
      try {
        const response = await fetch("/api/auth/search-history", { cache: "no-store" });
        const data = await response.json();
        if (!response.ok) throw Error(data.error || "搜索历史暂不可用");
        if (token !== generation.current) return;
        apply(data); setError("");
      } catch (e) {
        if (token === generation.current) setError(e instanceof Error ? e.message : "搜索历史暂不可用");
      } finally {
        if (token === generation.current) { setLoading(false); loadPromise.current = null; }
      }
    })();
    loadPromise.current = promise;
    return promise;
  }, [apply]);
  useEffect(() => {
    generation.current++; current.current = null; writes.current = Promise.resolve(); pendingCount.current = 0; writeEpoch.current++; loadPromise.current = null;
    setHistory(null); setError(""); setBusy(false); setLoading(false);
    return () => { generation.current++; };
  }, [ownerId]);
  useEffect(() => {
    if (!open) return;
    void refresh();
    const reload = () => { if (!document.hidden) void refresh(); };
    window.addEventListener("focus", reload);
    const timer = window.setInterval(reload, 15000);
    return () => { window.removeEventListener("focus", reload); window.clearInterval(timer); };
  }, [open, ownerId, refresh]);
  async function mutate(change: Omit<Extract<SearchHistoryMutation, {action:"record"}>, "revision"> | Omit<Extract<SearchHistoryMutation, {action:"remove"}>, "revision"> | {action:"clear"}) {
    const token = generation.current;
    if (!current.current) await loadPromise.current;
    const snapshot = current.current;
    if (!snapshot || token !== generation.current) return;
    if (pendingCount.current === 0) writeRevision.current = snapshot.revision;
    const revision = writeRevision.current++, epoch = writeEpoch.current;
    pendingCount.current++; setBusy(true);
    writes.current = writes.current.then(async () => {
      try {
        if (token !== generation.current || epoch !== writeEpoch.current) return;
        const response = await fetch("/api/auth/search-history", { method: change.action === "record" ? "POST" : "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...change, revision }) });
        const data = await response.json();
        if (token !== generation.current) return;
        if (response.status === 409) {
          writeEpoch.current++; apply(data);
          if (change.action !== "record") showToast("历史已在其他设备更新，请重新操作");
          return;
        }
        if (!response.ok) throw Error(data.error || "历史保存失败");
        apply(data); setError("");
      } catch (e) {
        if (token !== generation.current) return;
        writeEpoch.current++;
        setError(e instanceof Error ? e.message : "搜索历史暂不可用");
        // Unknown writes and stale queued records are discarded, never replayed after a clear.
        void refresh();
      } finally {
        if (token === generation.current) { pendingCount.current--; setBusy(pendingCount.current > 0); }
      }
    });
    await writes.current;
  }

  return { items: history?.items || [], error, loading, busy, refresh,
    record: (value: string) => { const query = normalizeSearchQuery(value); if (query) void mutate({ action: "record", query }); },
    remove: (id: string) => { void mutate({ action: "remove", id }); },
    clear: () => { void mutate({ action: "clear" }); } };
}
