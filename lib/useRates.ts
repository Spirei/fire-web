"use client";

import { useEffect, useLayoutEffect, useState } from "react";
import { readFxRates, type FxRatesSnapshot } from "./fxRatesClient";
import { startVisiblePolling } from "./visiblePolling";
export { MARKET_CURRENCY, MULTI_CURRENCIES, usdCap, fmtUsd } from "@/lib/currency";
import { FALLBACK_RATES } from "@/lib/types";

import { normalizeCachedRates, readCachedRates, writeCachedRates } from "./ratesCache";
let pendingRates: Promise<FxRatesSnapshot> | undefined;
let pendingRefresh: Promise<FxRatesSnapshot> | undefined;
export function readObservedRates(force = false) {
  if (force) return pendingRefresh ??= readFxRates(true).finally(() => { pendingRefresh = undefined; });
  return pendingRefresh ?? (pendingRates ??= readFxRates().finally(() => { pendingRates = undefined; }));
}

/* 汇率（对 USD）：共享一次请求，素材库市值按本地货币统一换算为美元 */
export function useRates(): Record<string, number> {
  // 只有美元恒等汇率可以在没有来源时确定，其他币种等待已核实快照。
  const [rates, setRates] = useState<Record<string, number>>(() => ({ ...FALLBACK_RATES }));
  useLayoutEffect(() => {
    const cached = readCachedRates();
    if (cached) setRates(cached);
  }, []);
  useEffect(() => {
    const load = async (signal: AbortSignal) => {
      try {
        const data = await readObservedRates();
        const next = normalizeCachedRates(data.rates);
        if (signal.aborted || !next) return;
        writeCachedRates(next);
        setRates(previous => Object.keys(previous).length === Object.keys(next).length && Object.entries(next).every(([key,value]) => previous[key] === value) ? previous : next);
      } catch { /* 失败时保留上次有效值 */ }
    };
    const polling = startVisiblePolling({read:load, interval:()=>60000});
    const refresh = () => { void polling.refresh(); };
    window.addEventListener("fire:rates-updated", refresh);
    return () => { polling.stop(); window.removeEventListener("fire:rates-updated", refresh); };
  }, []);
  return rates;
}
