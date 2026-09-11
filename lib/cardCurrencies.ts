/** 卡面库自己的币种表（覆盖素材里出现的国家地区，不走持仓的币种偏好） */
export const CARD_CURRENCIES: { code: string; symbol: string; label: string }[] = [
  { code: "CNY", symbol: "¥", label: "人民币" },
  { code: "USD", symbol: "$", label: "美元" },
  { code: "HKD", symbol: "HK$", label: "港元" },
  { code: "TWD", symbol: "NT$", label: "新台币" },
  { code: "MOP", symbol: "MOP$", label: "澳门元" },
  { code: "JPY", symbol: "¥", label: "日元" },
  { code: "KRW", symbol: "₩", label: "韩元" },
  { code: "SGD", symbol: "S$", label: "新加坡元" },
  { code: "GBP", symbol: "£", label: "英镑" },
  { code: "EUR", symbol: "€", label: "欧元" },
  { code: "AUD", symbol: "A$", label: "澳元" },
  { code: "CAD", symbol: "C$", label: "加元" },
  { code: "RUB", symbol: "₽", label: "卢布" },
  { code: "KZT", symbol: "₸", label: "坚戈" }
];

/** 地区 → 默认币种（新卡第一次录入时预选） */
export const REGION_CURRENCY: Record<string, string> = {
  中国内地: "CNY",
  中国香港: "HKD",
  中国台湾: "TWD",
  中国澳门: "MOP",
  美国: "USD",
  日本: "JPY",
  韩国: "KRW",
  新加坡: "SGD",
  英国: "GBP",
  德国: "EUR",
  爱尔兰: "EUR",
  澳大利亚: "AUD",
  加拿大: "CAD",
  俄罗斯: "RUB",
  哈萨克斯坦: "KZT"
};

export function currencySymbol(code: string): string {
  const found = CARD_CURRENCIES.find((item) => item.code === code);
  if (found) return found.symbol;
  return code ? `${code} ` : "";
}

/** 金额显示：符号 + 千分位（保留两位小数，负数带 - ） */
export function fmtCardMoney(amount: number, currency: string): string {
  const value = Number.isFinite(amount) ? amount : 0;
  const abs = Math.abs(value).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${value < 0 ? "-" : ""}${currencySymbol(currency)}${abs}`;
}

/** 卡号分组显示：4 位一组（不足 16 位也按 4 位硬切，读起来仍然顺） */
export function formatCardNumber(raw: string): string {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return "";
  return digits.replace(/(.{4})/g, "$1 ").trim();
}

/** 卡号尾号（后四位） */
export function cardLast4(raw: string): string {
  const digits = String(raw || "").replace(/\D/g, "");
  return digits ? digits.slice(-4) : "";
}
