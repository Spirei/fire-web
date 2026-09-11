/**
 * 资金系统支持的币种（客户端 / 服务端共用；本文件不引入任何服务端依赖）。
 *
 * 口径：**能折算的币种才收**。每个币种都必须在 `lib/types.ts` 的 `FALLBACK_RATES` 里
 * 有汇率兜底（实时汇率来自 ECB / 腾讯外汇，见 lib/rates.ts）—— 没有汇率的币种进来，
 * 跨币种汇总时就会按 1:1 当成美元，凭空算错总资产。所以卢布 / 坚戈不在清单里。
 *
 * 这份清单 = 7 个主币种 + 卡面素材里实际会出现的台币 / 澳门元 / 英镑 / 澳元 / 加元
 * + 有汇率但暂时没有卡面的印度卢比 / 巴西雷亚尔。卡面库「我的卡」里任何落在清单内的
 * 币种都能联动券商账户记账（见 lib/cardWallet.ts）。
 *
 * 新增币种时：本文件 + `FALLBACK_RATES` 同步加，DB 侧的 currency 约束已放宽为
 * 「三字母大写」的通用约束（见 lib/db.ts），不需要再重建资金流水表。
 */
export const FUND_CURRENCIES = [
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
  "MOP",
  "INR",
  "BRL"
] as const;

export type FundCurrency = (typeof FUND_CURRENCIES)[number];

/** 币种展示信息：符号沿用全站「符号在前」规范，iso 用于取国旗 */
export const FUND_CURRENCY_META: Record<FundCurrency, { label: string; symbol: string; iso: string }> = {
  USD: { label: "美元", symbol: "$", iso: "US" },
  EUR: { label: "欧元", symbol: "€", iso: "EU" },
  HKD: { label: "港元", symbol: "HK$", iso: "HK" },
  CNY: { label: "人民币", symbol: "¥", iso: "CN" },
  JPY: { label: "日元", symbol: "¥", iso: "JP" },
  KRW: { label: "韩元", symbol: "₩", iso: "KR" },
  SGD: { label: "新加坡元", symbol: "S$", iso: "SG" },
  GBP: { label: "英镑", symbol: "£", iso: "GB" },
  AUD: { label: "澳元", symbol: "A$", iso: "AU" },
  CAD: { label: "加元", symbol: "C$", iso: "CA" },
  TWD: { label: "新台币", symbol: "NT$", iso: "TW" },
  MOP: { label: "澳门元", symbol: "MOP$", iso: "MO" },
  INR: { label: "印度卢比", symbol: "₹", iso: "IN" },
  BRL: { label: "巴西雷亚尔", symbol: "R$", iso: "BR" }
};

const FUND_CURRENCY_SET = new Set<string>(FUND_CURRENCIES);

export function isFundCurrency(value: unknown): value is FundCurrency {
  return typeof value === "string" && FUND_CURRENCY_SET.has(value);
}

export function fundCurrencySymbol(code: string): string {
  return isFundCurrency(code) ? FUND_CURRENCY_META[code].symbol : code ? `${code} ` : "";
}

/** 空余额表（每个币种 0），每次返回新对象，避免调用方改到共享引用 */
export function emptyFundBalances(): Record<FundCurrency, number> {
  return Object.fromEntries(FUND_CURRENCIES.map((code) => [code, 0])) as Record<FundCurrency, number>;
}

/** CurrencySelect 用的选项（label + 国旗二字码） */
export function fundCurrencyOptions(): { code: FundCurrency; label: string; iso: string }[] {
  return FUND_CURRENCIES.map((code) => ({ code, label: FUND_CURRENCY_META[code].label, iso: FUND_CURRENCY_META[code].iso }));
}
