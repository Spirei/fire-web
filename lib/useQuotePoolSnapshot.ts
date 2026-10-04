"use client";

import { useEffect, useRef, useState } from "react";
import { POOL_STATES, type PoolBootstrap, type PoolScope, type PoolSnapshot } from "./quotePoolView";

/** Observer only: manual loading feedback, quiet background reads and no overlapping requests. */
export function useQuotePoolSnapshot(initial: PoolBootstrap | null | undefined, scope: PoolScope, active: boolean) {
  const [bank, setBank] = useState<Partial<Record<PoolScope, PoolSnapshot>>>(initial ?? {});
  const [revision, setRevision] = useState(0), lastRevision = useRef(0), bankRef = useRef(bank);
  const [loading, setLoading] = useState<PoolScope | null>(null);
  const [failure, setFailure] = useState<{ scope: PoolScope; message: string } | null>(null);
  const [visible, setVisible] = useState(true);
  useEffect(() => { bankRef.current = bank; }, [bank]);
  useEffect(() => {
    if (!active) return;
    let disposed = false, current: AbortController | undefined, resume = false;
    let timer: ReturnType<typeof setTimeout> | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
    const manual = revision !== lastRevision.current;
    lastRevision.current = revision;
    const read = async (foreground = false) => {
      if (disposed || document.hidden || current) return;
      const controller = new AbortController(); current = controller;
      if (foreground) setLoading(scope);
      let timedOut = false;
      deadline = setTimeout(() => { timedOut = true; controller.abort(); }, 8_000);
      try {
        const response = await fetch(`/api/quote-pool?scope=${scope}`, { signal: controller.signal, cache: "no-store" });
        const body = await response.json();
        if (!response.ok) throw new Error(body.message || "股票池读取失败");
        const snapshot = body.data as PoolSnapshot;
        if (snapshot?.scope !== scope || !Number.isFinite(snapshot.at) || !Array.isArray(snapshot.entries)
          || snapshot.entries.some(row => !row || typeof row.market !== "string" || typeof row.code !== "string"
            || !Object.hasOwn(POOL_STATES, row.state) || !Number.isFinite(row.expiresAt) || !Number.isFinite(row.lastRequestedAt)
            || (row.name !== undefined && typeof row.name !== "string") || (row.icon !== undefined && typeof row.icon !== "string"))) throw new Error("股票池暂时无法读取");
        if (!disposed && !controller.signal.aborted) {
          setBank(previous => ({ ...previous, [scope]: snapshot })); setFailure(null);
        }
      } catch (error) {
        if (!disposed && !document.hidden && (timedOut || !controller.signal.aborted)) {
          const message = timedOut ? "股票池读取超时" : error instanceof Error && !["TypeError", "SyntaxError"].includes(error.name) ? error.message : "股票池暂时无法读取";
          setFailure({ scope, message });
        }
      } finally {
        clearTimeout(deadline); current = undefined;
        if (!disposed) {
          setLoading(null);
          if (!document.hidden) { timer = setTimeout(() => void read(), resume ? 0 : 10_000); resume = false; }
        }
      }
    };
    const visibility = () => {
      setVisible(!document.hidden);
      if (timer) clearTimeout(timer);
      if (document.hidden) current?.abort();
      else if (current) resume = current.signal.aborted;
      else void read(!bankRef.current[scope]);
    };
    setVisible(!document.hidden); void read(manual || !bankRef.current[scope]);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      disposed = true; if (timer) clearTimeout(timer); if (deadline) clearTimeout(deadline);
      current?.abort(); setLoading(null); document.removeEventListener("visibilitychange", visibility);
    };
  }, [active, scope, revision]);
  return { snapshot: bank[scope], visible, busy: active && loading === scope,
    error: failure?.scope === scope ? failure.message : "", refresh: () => setRevision(value => value + 1) };
}
