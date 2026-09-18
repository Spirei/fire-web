/**
 * 汇率换算：金额按「对美元中间价」折算。
 * rates[code] = 1 美元可兑换的该币种数量（与 /api/rates、FALLBACK_RATES 同一口径）。
 */

import { FUND_CURRENCIES, isFundCurrency, type FundCurrency } from "./fundCurrencies";

export function normalizeFxOrder(saved: unknown): FundCurrency[] {
  const seen = new Set<FundCurrency>();
  const next: FundCurrency[] = [];
  if (Array.isArray(saved)) {
    for (const code of saved) {
      if (isFundCurrency(code) && !seen.has(code)) {
        seen.add(code);
        next.push(code);
      }
    }
  }
  for (const code of FUND_CURRENCIES) {
    if (!seen.has(code)) next.push(code);
  }
  return next;
}

export function moveFxOrder(order: FundCurrency[], from: number, to: number): FundCurrency[] {
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
