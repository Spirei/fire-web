"use client";

import { createContext, useContext, useEffect, type ReactNode } from "react";
import { useRates } from "./useRates";
import { usePersistedState } from "./usePersistedState";

/** 全站展示币种（7 种；FIRE 页除外） */
export type CurrencyCode = "USD" | "HKD" | "CNY" | "SGD" | "JPY" | "KRW" | "EUR";

export const CURRENCIES: { code: CurrencyCode; label: string; market: string; flag: string }[] = [
  { code: "USD", label: "美元", market: "US", flag: "🇺🇸" },
  { code: "HKD", label: "港元", market: "HK", flag: "🇭🇰" },
  { code: "CNY", label: "人民币", market: "CN", flag: "🇨🇳" },
  { code: "SGD", label: "新加坡元", market: "SG", flag: "🇸🇬" },
  { code: "JPY", label: "日元", market: "JP", flag: "🇯🇵" },
  { code: "KRW", label: "韩元", market: "KR", flag: "🇰🇷" },
  { code: "EUR", label: "欧元", market: "EU", flag: "🇪🇺" }
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
// 没有保存偏好时仍以美元作为系统默认；已有本地偏好由挂载后的恢复逻辑接管。
export const DEFAULT_DISPLAY_CURRENCY: CurrencyCode = "USD";

/** 金额单位偏好：auto 为同一页面统一启用或关闭智能缩写。 */
export type CurrencyDisplayUnit = "auto" | "full" | "compact";
export const CURRENCY_DISPLAY_UNIT_KEY = "fire:currency-display-unit";
export const DEFAULT_CURRENCY_DISPLAY_UNIT: CurrencyDisplayUnit = "auto";

/** 币种偏好的 cookie：服务端首屏能直接读到，避免刷新时先画默认货币再切回选择 */
export const DISPLAY_CURRENCY_COOKIE = "fire-display-currency";
const ONE_YEAR = 60 * 60 * 24 * 365;

export function writeDisplayCurrencyCookie(code: CurrencyCode) {
  try {
    document.cookie = `${DISPLAY_CURRENCY_COOKIE}=${encodeURIComponent(code)}; path=/; max-age=${ONE_YEAR}; samesite=lax`;
  } catch {
    /* 忽略（隐私模式等） */
  }
}

const ServerCurrencyContext = createContext<CurrencyCode | null>(null);

/**
 * 布局（服务端组件）读取 cookie 后把值传进来：SSR 与客户端首帧都用它，
 * 于是刷新后首屏就是用户选的货币，不会再闪一下默认值。
 */
export function CurrencyProvider({ initialCurrency, children }: { initialCurrency?: CurrencyCode | null; children: ReactNode }) {
  return <ServerCurrencyContext.Provider value={initialCurrency ?? null}>{children}</ServerCurrencyContext.Provider>;
}

export function useServerCurrency(): CurrencyCode | null {
  return useContext(ServerCurrencyContext);
}

export function useCurrencyDisplayUnit() {
  const [unit, setUnit] = usePersistedState<CurrencyDisplayUnit>(CURRENCY_DISPLAY_UNIT_KEY, DEFAULT_CURRENCY_DISPLAY_UNIT);
  return { unit, setUnit };
}

/** 全站共享的展示币种状态（localStorage 持久化），并返回汇率换算助手 */
export function useDisplayCurrency() {
  const serverCurrency = useServerCurrency();
  const [currency, setCurrencyState] = usePersistedState<CurrencyCode>(DISPLAY_CURRENCY_KEY, serverCurrency ?? DEFAULT_DISPLAY_CURRENCY);
  const setCurrency = (next: CurrencyCode) => {
    setCurrencyState(next);
    writeDisplayCurrencyCookie(next);
  };
  // 老用户此前只有 localStorage（没有 cookie）：挂载后补写一次，下次刷新服务端就能直接读到。
  // 第一次仍会闪一下（服务端无从得知 localStorage），之后不再闪。
  useEffect(() => {
    writeDisplayCurrencyCookie(currency);
  }, [currency]);
  const rates = useRates();
  const rate = rates[currency] ?? (currency === "USD" ? 1 : 0);
  const symbol = CURRENCY_SYMBOLS[currency] ?? currency;
  const fx = (usd: number) => usd * rate;
  return { currency, setCurrency, rates, rate, symbol, fx };
}
