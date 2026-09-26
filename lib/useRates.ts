"use client";

import { sharedRead } from "@/lib/sharedRead";
import { useEffect, useState } from "react";
export { MARKET_CURRENCY, MULTI_CURRENCIES, usdCap, fmtUsd } from "@/lib/currency";
import { FALLBACK_RATES } from "@/lib/types";

let cache: Record<string, number> | null = null;
let inflight: Promise<void> | null = null;

/* 汇率（对 USD）：共享一次请求，素材库市值按本地货币统一换算为美元 */
export function useRates(): Record<string, number> {
  // 首帧直接用兜底汇率（已知币种不为 1），避免刷新瞬间按 1:1 显示错误数值
  const [rates, setRates] = useState<Record<string, number>>(() => cache ?? { ...FALLBACK_RATES });
  useEffect(() => {
    if (cache) {
      setRates(cache);
      return;
    }
    if (inflight) {
      inflight.then(() => {
        if (cache) setRates(cache);
      });
      return;
    }
    inflight = sharedRead("/api/rates")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.rates) {
          cache = d.rates;
          setRates(d.rates);
        }
      })
      .catch(() => {})
      .finally(() => {
        inflight = null;
      });
  }, []);
  return rates;
}
