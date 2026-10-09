"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AllocationClientError, readAllocation, validAllocationSnapshot } from "./assetAllocationClient";
import { ALLOCATION_REFRESH_MS } from "./assetAllocationContract";
import type { AllocationSnapshot } from "./assetAllocationTypes";

type Mode = "manual" | "background" | "mutation";
export type AllocationReadEvent = { id: number; phase: "request" | "response" | "stop"; animate: boolean; startedAt: number; hadSnapshot: boolean };

/** Private snapshots stay in memory. Currency changes retain correctly labelled old values until the next snapshot arrives. */
export function useAssetAllocationSnapshot(currency: string, foreground: boolean, onRead: (event: AllocationReadEvent) => void, initial?: AllocationSnapshot | null) {
  const [data, setData] = useState<AllocationSnapshot | null>(() => validAllocationSnapshot(initial, currency) ? initial : null), [error, setError] = useState(""), [loading, setLoading] = useState(false), [checkedAt, setCheckedAt] = useState(() => validAllocationSnapshot(initial, currency) ? initial.observedAt : "");
  const snapshot = useRef(data), context = useRef({ currency, foreground, onRead }); context.current = { currency, foreground, onRead };
  const sequence = useRef(0), alive = useRef(false), failures = useRef(0), nextDue = useRef(0), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pending = useRef<{ currency: string; controller: AbortController; event: AllocationReadEvent; promise: Promise<AllocationSnapshot | null> } | null>(null);
  const cancel = useCallback(() => {
    ++sequence.current; clearTimeout(timer.current); timer.current = undefined;
    pending.current?.controller.abort(); pending.current = null; setLoading(false);
    context.current.onRead({ id: sequence.current, phase: "stop", animate: false, startedAt: 0, hadSnapshot: false });
  }, []);
  const refresh = useCallback((mode: Mode = "manual"): Promise<AllocationSnapshot | null> => {
    const ctx = context.current;
    clearTimeout(timer.current); timer.current = undefined;
    if (!alive.current || !ctx.foreground) { nextDue.current = 0; return Promise.resolve(null); }
    const old = pending.current;
    if (old && old.currency === ctx.currency && mode !== "mutation") {
      if (mode === "manual" && !old.event.animate) { old.event.animate = true; setLoading(true); ctx.onRead({ ...old.event }); }
      return old.promise;
    }
    if (old) cancel();
    const id = ++sequence.current, controller = new AbortController();
    const event: AllocationReadEvent = { id, phase: "request", animate: mode !== "background", startedAt: performance.now(), hadSnapshot: !!snapshot.current };
    setLoading(event.animate); setError(""); ctx.onRead(event);
    const current = () => alive.current && id === sequence.current && context.current.foreground && context.current.currency === ctx.currency;
    const promise = (async () => {
      try {
        const result = await readAllocation(ctx.currency, snapshot.current, controller.signal);
        if (!current()) return null;
        snapshot.current = result.snapshot; setData(result.snapshot); setCheckedAt(result.checkedAt); failures.current = 0; setError("");
        context.current.onRead({ ...event, phase: "response" });
        return result.snapshot;
      } catch (failure) {
        if (!current() || controller.signal.aborted) return null;
        if (failure instanceof AllocationClientError && [401, 403, 409].includes(failure.status)) { snapshot.current = null; setData(null); setCheckedAt(""); }
        failures.current++; setError(failure instanceof AllocationClientError ? failure.message : "账户暂时无法读取，请重试");
        context.current.onRead({ ...event, phase: "stop" }); return null;
      } finally {
        if (current()) {
          pending.current = null; setLoading(false);
          nextDue.current = Date.now() + ALLOCATION_REFRESH_MS * Math.min(4, 2 ** Math.max(0, failures.current - 1));
          timer.current = setTimeout(() => void refresh("background"), Math.max(0, nextDue.current - Date.now()));
        }
      }
    })();
    pending.current = { currency: ctx.currency, controller, event, promise }; return promise;
  }, [cancel]);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; cancel(); };
  }, [cancel]);
  useEffect(() => {
    cancel(); setError("");
    if (!foreground) return;
    if (!snapshot.current || snapshot.current.currency !== currency || Date.now() >= nextDue.current) void refresh(snapshot.current?.currency === currency ? "background" : "manual");
    else timer.current = setTimeout(() => void refresh("background"), Math.max(0, nextDue.current - Date.now()));
    return cancel;
  }, [currency, foreground, cancel, refresh]);
  useEffect(() => {
    let changeTimer: ReturnType<typeof setTimeout> | undefined;
    const changed = () => {
      nextDue.current = 0; clearTimeout(changeTimer);
      if (foreground) changeTimer = setTimeout(() => void refresh("mutation"), 0);
    };
    const events = ["fire:allocation-updated", "fire:records-updated", "fire:orders-updated", "fire:funds-updated", "fire:cards-updated", "fire:rates-updated", "fire:settings-updated"];
    for (const name of events) window.addEventListener(name, changed);
    return () => { clearTimeout(changeTimer); for (const name of events) window.removeEventListener(name, changed); };
  }, [refresh, foreground]);
  return { data, error, loading, checkedAt, refresh, changingCurrency: !!data && data.currency !== currency };
}
