/**
 * 汇率浏览器缓存（fire:rates）
 *
 * ⚠️ 只能在「挂载之后」读取（useLayoutEffect / useEffect），**禁止在水合首帧读**：
 * 服务端渲染时 localStorage 不可用、只能用 FALLBACK_RATES，客户端首帧若读到实时缓存，
 * 两边算出的金额就会不一样，触发 hydration 报错（2026-09-11 资产分析页持仓总市值即此问题）。
 */
import { FALLBACK_RATES } from "./types";

const RATES_CACHE_KEY = "fire:rates";

export function normalizeCachedRates(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const valid = Object.entries(value).filter(([code, rate]) => /^[A-Z]{3}$/.test(code) && typeof rate === "number" && Number.isFinite(rate) && rate > 0);
  if (!valid.length) return null;
  return { ...FALLBACK_RATES, ...Object.fromEntries(valid), USD: 1 };
}

/** 读取上次成功保存的汇率（合并到兜底汇率之上）；读不到返回 null */
export function readCachedRates(): Record<string, number> | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(RATES_CACHE_KEY) || "null");
    return normalizeCachedRates(parsed);
  } catch {
    return null;
  }
}

export function writeCachedRates(rates: Record<string, number>) {
  const normalized = normalizeCachedRates(rates);
  if (!normalized) return;
  try {
    localStorage.setItem(RATES_CACHE_KEY, JSON.stringify(normalized));
  } catch {
    /* 存储不可用时忽略 */
  }
}
