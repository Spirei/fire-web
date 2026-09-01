"use client";

import { useRates } from "./useRates";
import { usePersistedState } from "./usePersistedState";

/** 全站展示币种（7 种；FIRE 页除外） */
export type CurrencyCode = "USD" | "EUR" | "HKD" | "CNY" | "JPY" | "KRW" | "SGD";

export const CURRENCIES: { code: CurrencyCode; label: string; market: string; flag: string }[] = [
  { code: "USD", label: "美元", market: "US", flag: "🇺🇸" },
  { code: "EUR", label: "欧元", market: "EU", flag: "🇪🇺" },
  { code: "HKD", label: "港元", market: "HK", flag: "🇭🇰" },
  { code: "CNY", label: "人民币", market: "CN", flag: "🇨🇳" },
  { code: "JPY", label: "日元", market: "JP", flag: "🇯🇵" },
  { code: "KRW", label: "韩元", market: "KR", flag: "🇰🇷" },
  { code: "SGD", label: "新加坡元", market: "SG", flag: "🇸🇬" }
];

export const CURRENCY_SYMBOLS: Record<CurrencyCode, string> = {
  USD: "$",
  EUR: "€",
  HKD: "HK$",
  CNY: "¥",
  JPY: "¥",
  KRW: "₩",
  SGD: "S$"
};

export const DISPLAY_CURRENCY_KEY = "fire:display-currency";
export const DEFAULT_DISPLAY_CURRENCY: CurrencyCode = "USD";

/** 金额单位偏好：auto 在小屏使用紧凑单位，桌面保持完整金额。 */
export type CurrencyDisplayUnit = "auto" | "full" | "compact";
export const CURRENCY_DISPLAY_UNIT_KEY = "fire:currency-display-unit";
export const DEFAULT_CURRENCY_DISPLAY_UNIT: CurrencyDisplayUnit = "auto";

export function useCurrencyDisplayUnit() {
  const [unit, setUnit] = usePersistedState<CurrencyDisplayUnit>(CURRENCY_DISPLAY_UNIT_KEY, DEFAULT_CURRENCY_DISPLAY_UNIT);
  return { unit, setUnit };
}

/** 全站共享的展示币种状态（localStorage 持久化），并返回汇率换算助手 */
export function useDisplayCurrency() {
  const [currency, setCurrency] = usePersistedState<CurrencyCode>(DISPLAY_CURRENCY_KEY, DEFAULT_DISPLAY_CURRENCY);
  const rates = useRates();
  const rate = rates[currency] ?? (currency === "USD" ? 1 : 0);
  const symbol = CURRENCY_SYMBOLS[currency] ?? currency;
  const fx = (usd: number) => usd * rate;
  return { currency, setCurrency, rates, rate, symbol, fx };
}
