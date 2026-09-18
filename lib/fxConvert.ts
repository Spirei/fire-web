/**
 * 汇率换算：金额按「对美元中间价」折算。
 * rates[code] = 1 美元可兑换的该币种数量（与 /api/rates、FALLBACK_RATES 同一口径）。
 */

import { FUND_CURRENCY_META } from "./fundCurrencies";

/** 换算页 14 个币种，两两一排。去掉澳门元，补瑞士法郎。 */
export const FX_CURRENCIES = [
  "USD",
  "EUR",
  "HKD",
  "CNY",
  "JPY",
  "KRW",
  "SGD",
  "GBP",
  "AUD",
  "CAD",
  "TWD",
  "CHF",
  "INR",
  "BRL"
] as const;

export type FxCurrency = (typeof FX_CURRENCIES)[number];

export const FX_CURRENCY_META: Record<FxCurrency, { label: string; symbol: string; iso: string }> = {
  USD: FUND_CURRENCY_META.USD,
  EUR: FUND_CURRENCY_META.EUR,
  HKD: FUND_CURRENCY_META.HKD,
  CNY: FUND_CURRENCY_META.CNY,
  JPY: FUND_CURRENCY_META.JPY,
  KRW: FUND_CURRENCY_META.KRW,
  SGD: FUND_CURRENCY_META.SGD,
  GBP: FUND_CURRENCY_META.GBP,
  AUD: FUND_CURRENCY_META.AUD,
  CAD: FUND_CURRENCY_META.CAD,
  TWD: FUND_CURRENCY_META.TWD,
  CHF: { label: "瑞士法郎", symbol: "Fr.", iso: "CH" },
  INR: FUND_CURRENCY_META.INR,
  BRL: FUND_CURRENCY_META.BRL
};

const FX_CURRENCY_SET = new Set<string>(FX_CURRENCIES);

export function isFxCurrency(value: unknown): value is FxCurrency {
  return typeof value === "string" && FX_CURRENCY_SET.has(value);
}

export function normalizeFxOrder(saved: unknown): FxCurrency[] {
  const seen = new Set<FxCurrency>();
  const next: FxCurrency[] = [];
  if (Array.isArray(saved)) {
    for (const code of saved) {
      if (isFxCurrency(code) && !seen.has(code)) {
        seen.add(code);
        next.push(code);
      }
    }
  }
  for (const code of FX_CURRENCIES) {
    if (!seen.has(code)) next.push(code);
  }
  return next;
}

export function moveFxOrder(order: FxCurrency[], from: number, to: number): FxCurrency[] {
  if (!Number.isInteger(from) || !Number.isInteger(to)) return order;
  if (from === to || from < 0 || to < 0 || from >= order.length || to >= order.length) return order;
  const next = order.slice();
  const [item] = next.splice(from, 1);
  if (!item) return order;
  next.splice(to, 0, item);
  return next;
}

export function usdRate(code: string, rates: Record<string, number>): number {
  if (code === "USD") return 1;
  const rate = rates[code];
  return typeof rate === "number" && rate > 0 ? rate : 0;
}

/** 把 from 币种的金额换算成 to 币种；缺汇率时返回 null。 */
export function convertAmount(
  amount: number,
  from: string,
  to: string,
  rates: Record<string, number>
): number | null {
  if (!Number.isFinite(amount)) return null;
  if (from === to) return amount;
  const fromRate = usdRate(from, rates);
  const toRate = usdRate(to, rates);
  if (!fromRate || !toRate) return null;
  return (amount / fromRate) * toRate;
}

/** 1 from = ? to */
export function pairRate(from: string, to: string, rates: Record<string, number>): number | null {
  return convertAmount(1, from, to, rates);
}

export function parseFxAmount(text: string): number | null {
  const trimmed = text.replace(/,/g, "").trim();
  if (!trimmed || trimmed === ".") return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0 || value > 1e15) return null;
  return value;
}

/** 输入时只保留数字和一个小数点，避免 type=number 把「1.」吃掉。 */
export function sanitizeFxInput(raw: string): string {
  const next = raw.replace(/[^\d.]/g, "");
  const dot = next.indexOf(".");
  if (dot === -1) return next.slice(0, 15);
  return `${next.slice(0, dot).slice(0, 12)}.${next.slice(dot + 1).replace(/\./g, "").slice(0, 6)}`;
}

export function formatFxAmount(value: number, code: string): string {
  if (!Number.isFinite(value)) return "—";
  const whole = code === "JPY" || code === "KRW";
  const digits = whole ? 0 : value >= 1000 ? 2 : value >= 1 ? 2 : 4;
  return value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function formatPairRate(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "—";
  const digits = value >= 100 ? 2 : value >= 1 ? 4 : 6;
  return value.toLocaleString("en-US", { minimumFractionDigits: Math.min(digits, 2), maximumFractionDigits: digits });
}

export function amountToDraft(value: number, code: string): string {
  if (!Number.isFinite(value)) return "";
  if (code === "JPY" || code === "KRW") return String(Math.round(value));
  const digits = value >= 1 ? 2 : 4;
  const text = value.toFixed(digits);
  if (!text.includes(".")) return text;
  return text.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

export function formatRatesDate(at: number | null | undefined): string {
  if (!at || !Number.isFinite(at)) return "—";
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "—";
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}
