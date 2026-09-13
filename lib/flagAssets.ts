const DEFAULT_FLAG_OVERRIDES: Record<string, string> = {
  eu: "/uploads/asset/flag/欧盟EU.svg"
};

/** 全站固定的 7 种展示货币；资金系统的扩展币种在实际出现时再按代码读取。 */
export const CURRENCY_FLAG_CODES = ["US", "EU", "HK", "CN", "JP", "KR", "SG"] as const;

const DISPLAY_CURRENCY_FLAG: Record<string, (typeof CURRENCY_FLAG_CODES)[number]> = {
  USD: "US", EUR: "EU", HKD: "HK", CNY: "CN", JPY: "JP", KRW: "KR", SGD: "SG"
};

/** 服务端也能安全调用；不要从带 `use client` 的 currencyPrefs 模块读取运行时常量。 */
export function displayCurrencyFlagCode(currency?: string): (typeof CURRENCY_FLAG_CODES)[number] {
  return DISPLAY_CURRENCY_FLAG[String(currency || "").toUpperCase()] || "US";
}

/** 返回随源码 / Docker 镜像发布的默认国旗路径。 */
export function defaultFlagUrl(code: string): string {
  const normalized = code.trim().toLowerCase();
  return DEFAULT_FLAG_OVERRIDES[normalized] || `/uploads/asset/flag/${normalized}.svg`;
}
