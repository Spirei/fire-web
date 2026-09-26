"use client";

import { sharedRead } from "@/lib/sharedRead";
import { useEffect, useLayoutEffect, useState } from "react";
export { MARKET_CURRENCY, MULTI_CURRENCIES, usdCap, fmtUsd } from "@/lib/currency";
import { FALLBACK_RATES } from "@/lib/types";

import { normalizeCachedRates, readCachedRates, writeCachedRates } from "./ratesCache";

/* 汇率（对 USD）：共享一次请求，素材库市值按本地货币统一换算为美元 */
export function useRates(): Record<string, number> {
  // 首帧直接用兜底汇率（已知币种不为 1），避免刷新瞬间按 1:1 显示错误数值
  const [rates, setRates] = useState<Record<string, number>>(() => ({ ...FALLBACK_RATES }));
  useLayoutEffect(() => {
    const cached = readCachedRates();
    if (cached) setRates(cached);
  }, []);
  useEffect(() => {
    let generation = 0;
    const load = async () => {
      const current = ++generation;
      try {
        const response = await sharedRead("/api/rates");
        const data = response.ok ? await response.json() : null;
        const next = normalizeCachedRates(data?.rates);
        if (current !== generation || !next) return;
        writeCachedRates(next);
        setRates(next);
      } catch { /* 失败时保留上次有效值 */ }
    };
    void load();
    window.addEventListener("fire:rates-updated", load);
    return () => { ++generation; window.removeEventListener("fire:rates-updated", load); };
  }, []);
  return rates;
}
