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

/** 加号只提供主要国家／地区法币；具体可添加项仍取决于当前接口有无报价。 */
export const FX_EXTRA_CURRENCIES = [
  "MOP", "AED", "SAR", "ILS", "THB", "MYR", "IDR", "PHP", "VND", "TRY", "PKR", "BDT", "KZT",
  "SEK", "NOK", "DKK", "PLN", "CZK", "HUF", "RON", "RUB", "UAH",
  "MXN", "ARS", "CLP", "COP", "PEN", "NZD", "ZAR", "EGP", "NGN", "MAD", "KES"
] as const;

export type FxCurrency = string;

export const FX_CURRENCY_META: Record<string, { label: string; symbol: string; iso: string }> = {
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
  BRL: FUND_CURRENCY_META.BRL,
  MOP: FUND_CURRENCY_META.MOP,
  NZD: { label: "新西兰元", symbol: "NZ$", iso: "NZ" },
  SEK: { label: "瑞典克朗", symbol: "kr", iso: "SE" },
  NOK: { label: "挪威克朗", symbol: "kr", iso: "NO" },
  DKK: { label: "丹麦克朗", symbol: "kr", iso: "DK" },
  THB: { label: "泰铢", symbol: "฿", iso: "TH" },
  MYR: { label: "马来西亚林吉特", symbol: "RM", iso: "MY" },
  IDR: { label: "印尼盾", symbol: "Rp", iso: "ID" },
  PHP: { label: "菲律宾比索", symbol: "₱", iso: "PH" },
  AED: { label: "阿联酋迪拉姆", symbol: "د.إ", iso: "AE" },
  SAR: { label: "沙特里亚尔", symbol: "﷼", iso: "SA" },
  ILS: { label: "以色列新谢克尔", symbol: "₪", iso: "IL" },
  VND: { label: "越南盾", symbol: "₫", iso: "VN" },
  TRY: { label: "土耳其里拉", symbol: "₺", iso: "TR" },
  PKR: { label: "巴基斯坦卢比", symbol: "₨", iso: "PK" },
  BDT: { label: "孟加拉塔卡", symbol: "৳", iso: "BD" },
  KZT: { label: "哈萨克斯坦坚戈", symbol: "₸", iso: "KZ" },
  PLN: { label: "波兰兹罗提", symbol: "zł", iso: "PL" },
  CZK: { label: "捷克克朗", symbol: "Kč", iso: "CZ" },
  HUF: { label: "匈牙利福林", symbol: "Ft", iso: "HU" },
  RON: { label: "罗马尼亚列伊", symbol: "lei", iso: "RO" },
  RUB: { label: "俄罗斯卢布", symbol: "₽", iso: "RU" },
  UAH: { label: "乌克兰格里夫纳", symbol: "₴", iso: "UA" },
  MXN: { label: "墨西哥比索", symbol: "MX$", iso: "MX" },
  ARS: { label: "阿根廷比索", symbol: "AR$", iso: "AR" },
  CLP: { label: "智利比索", symbol: "CL$", iso: "CL" },
  COP: { label: "哥伦比亚比索", symbol: "COL$", iso: "CO" },
  PEN: { label: "秘鲁索尔", symbol: "S/", iso: "PE" },
  ZAR: { label: "南非兰特", symbol: "R", iso: "ZA" },
  EGP: { label: "埃及镑", symbol: "E£", iso: "EG" },
  NGN: { label: "尼日利亚奈拉", symbol: "₦", iso: "NG" },
  MAD: { label: "摩洛哥迪拉姆", symbol: "د.م.", iso: "MA" },
  KES: { label: "肯尼亚先令", symbol: "KSh", iso: "KE" }
};

export function fxCurrencyMeta(code: string): { label: string; symbol: string; iso: string } {
  if (FX_CURRENCY_META[code]) return FX_CURRENCY_META[code];
  let label = code;
  let symbol = code;
  try {
    label = new Intl.DisplayNames(["zh-CN"], { type: "currency" }).of(code) || code;
    symbol = new Intl.NumberFormat("zh-CN", { style: "currency", currency: code, currencyDisplay: "narrowSymbol" })
      .formatToParts(1).find(part => part.type === "currency")?.value || code;
  } catch { /* 未识别币种仍展示代码 */ }
  return { label, symbol, iso: "" };
}

/** 新增菜单按货币主要使用地区归类；接口返回的新代码仍可落在「其他」。 */
export const FX_CONTINENTS = ["亚洲", "欧洲", "北美洲", "南美洲", "大洋洲", "非洲", "其他"] as const;
export type FxContinent = typeof FX_CONTINENTS[number];

const FX_CONTINENT_CODES: Record<Exclude<FxContinent, "其他">, readonly string[]> = {
  亚洲: ["AED", "CNY", "HKD", "IDR", "ILS", "INR", "JPY", "KRW", "MOP", "MYR", "PHP", "SAR", "SGD", "THB", "TRY", "TWD", "VND"],
  欧洲: ["BGN", "CHF", "CZK", "DKK", "EUR", "GBP", "HUF", "ISK", "NOK", "PLN", "RON", "RSD", "RUB", "SEK", "UAH"],
  北美洲: ["CAD", "MXN", "USD"],
  南美洲: ["ARS", "BOB", "BRL", "CLP", "COP", "PEN", "UYU"],
  大洋洲: ["AUD", "FJD", "NZD", "PGK"],
  非洲: ["EGP", "GHS", "KES", "MAD", "NGN", "TND", "ZAR"]
};

export function fxContinent(code: string): FxContinent {
  for (const continent of FX_CONTINENTS) {
    if (continent !== "其他" && FX_CONTINENT_CODES[continent].includes(code)) return continent;
  }
  return "其他";
}

export function isFxCurrency(value: unknown): value is FxCurrency {
  return typeof value === "string" && /^[A-Z]{3}$/.test(value);
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
