/**
 * 卡面库的「币种范围」：单币 / 双币 / 多币种。
 *
 * 上游素材（HarukaKinen/Cardentify）只有 type / brand / level，没有币种字段，
 * 卡名里写明币种的也极少，所以这里按优先级推断，并把依据与置信度一起给出来：
 *   1. 卡名关键词（双币 / Dual Currency / 全币种 / 全球账户 …）→ 最硬
 *   2. 发行方产品（Wise / Revolut / Payoneer / UOB FX+ / HSBC EGA·Global Money …）
 *   3. 地区本币（中国香港 = HKD，美国 = USD …）
 *   4. 卡组织 + 地区规则（内地银联 / 运通人民币 / 万事达人民币 = 人民币单币）
 *
 * 推断不可能全对（素材以 Apple Pay 卡面为主，内地双币 Visa/Mastercard 基本没收录；
 * 港澳新又多币种账户），所以卡片详情里可以手动覆盖，覆盖值存 card_details.currency_scope。
 */
import { REGION_CURRENCY, CARD_CURRENCIES } from "./cardCurrencies";

export type CurrencyScope = "single" | "dual" | "multi" | "unknown";

export interface CurrencyScopeInfo {
  scope: CurrencyScope;
  /** 推断涉及的主要币种（单币给本币，双币给两个，多币种留空表示"多"） */
  currencies: string[];
  /** 判定依据：直接展示给用户，方便人工纠正 */
  reason: string;
  confidence: "high" | "medium" | "low";
}

export const CURRENCY_SCOPE_LABEL: Record<CurrencyScope, string> = {
  single: "单币",
  dual: "双币",
  multi: "多币种",
  unknown: "待确认"
};

/** 筛选与手动覆盖时的展示顺序 */
export const CURRENCY_SCOPE_ORDER: CurrencyScope[] = ["single", "dual", "multi", "unknown"];

/** 卡名里直接写明双币的写法（简繁 + 英文） */
const DUAL_WORDS = ["双币", "雙幣", "Dual Currency"];
/** 卡名里直接写明多币种 / 全球账户的写法 */
const MULTI_WORDS = ["全币种", "全幣種", "多币种", "多幣種", "Global Money", "Everyday Global", "多幣別"];
/** 多币种钱包 / 账户卡（卡本身不写币种，但产品就是多币种） */
const MULTI_ISSUERS = ["Wise", "Revolut", "Payoneer"];
/** 币种信息本身待确认的产品：两地通、以及"支持多币种消费但账户为本币"的券商卡 */
const UNKNOWN_WORDS = ["两地通"];
const UNKNOWN_ISSUERS = ["Trading 212"];

const cache = new Map<string, CurrencyScopeInfo>();

export function isCurrencyScope(value: unknown): value is CurrencyScope {
  return value === "single" || value === "dual" || value === "multi" || value === "unknown";
}

/** 币种中文名（用于「单币 · 人民币」这类展示） */
export function currencyName(code: string): string {
  return CARD_CURRENCIES.find((item) => item.code === code)?.label ?? code;
}

/** 「单币 · 人民币」/「多币种」这类一句话摘要 */
export function currencyScopeSummary(info: CurrencyScopeInfo): string {
  const label = CURRENCY_SCOPE_LABEL[info.scope];
  if (info.scope === "multi" || info.currencies.length === 0) return label;
  return `${label} · ${info.currencies.map(currencyName).join(" + ")}`;
}

/**
 * 推断一张卡的币种范围。按卡名 + 卡组织 + 发卡行 + 地区计算，结果带缓存。
 */
export function cardCurrencyScope(card: {
  name?: string;
  brand?: string;
  bank?: string;
  region?: string;
}): CurrencyScopeInfo {
  const name = String(card.name || "");
  const brand = String(card.brand || "").trim();
  const bank = String(card.bank || "").trim();
  const region = String(card.region || "").trim();
  const key = `${name}|${brand}|${bank}|${region}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const info = infer(name, brand, bank, region);
  cache.set(key, info);
  return info;
}

function infer(name: string, brand: string, bank: string, region: string): CurrencyScopeInfo {
  const local = REGION_CURRENCY[region] || "";

  // 1. 卡名写明双币：内地多为「人民币 + 美元」，港澳多为「本地币 + 人民币」
  if (DUAL_WORDS.some((word) => name.includes(word))) {
    const currencies = region === "中国内地" ? ["CNY", "USD"] : [local, "CNY"].filter(Boolean);
    return { scope: "dual", currencies, reason: "卡名写明「双币」", confidence: "high" };
  }
  if (MULTI_WORDS.some((word) => name.includes(word))) {
    return { scope: "multi", currencies: [], reason: "卡名写明多币种 / 全球账户", confidence: "high" };
  }

  // 2. 多币种钱包 / 账户卡
  const issuer = MULTI_ISSUERS.find((word) => bank.includes(word) || name.includes(word));
  if (issuer) {
    return { scope: "multi", currencies: [], reason: `${issuer} 属于多币种钱包 / 账户卡`, confidence: "high" };
  }
  if (name.includes("FX+")) {
    return { scope: "multi", currencies: [], reason: "FX+ 多币种账户卡", confidence: "high" };
  }
  if (/\bEGA\b/.test(name)) {
    return { scope: "multi", currencies: [], reason: "HSBC Everyday Global Account（多币种）", confidence: "high" };
  }

  // 3. 明确待确认
  if (UNKNOWN_WORDS.some((word) => name.includes(word))) {
    return { scope: "unknown", currencies: [local, "HKD"].filter(Boolean), reason: "两地通（内地 + 香港），币种说明缺失", confidence: "low" };
  }
  if (UNKNOWN_ISSUERS.some((word) => bank.includes(word) || name.includes(word))) {
    return { scope: "unknown", currencies: [local].filter(Boolean), reason: "支持多币种消费，账户币种待确认", confidence: "low" };
  }

  // 4. 内地：新规后银联 / 运通 / 万事达都是人民币卡，双币卡在卡名里一般会写
  if (region === "中国内地") {
    if (brand === "UnionPay") return { scope: "single", currencies: ["CNY"], reason: "银联人民币卡", confidence: "high" };
    if (brand === "AMEX") return { scope: "single", currencies: ["CNY"], reason: "美国运通人民币卡（连通）", confidence: "medium" };
    if (brand === "MasterCard" || brand === "Mastercard") {
      return { scope: "single", currencies: ["CNY"], reason: "万事达人民币卡（万事网联）", confidence: "medium" };
    }
    return { scope: "single", currencies: ["CNY"], reason: "内地卡按人民币推断（卡组织字段缺失）", confidence: "low" };
  }

  // 5. 其他地区：按本币推断为单币；港澳新这类多币种账户常见，置信度给中
  if (!local) return { scope: "unknown", currencies: [], reason: "素材里没有这个地区的币种信息", confidence: "low" };
  return { scope: "single", currencies: [local], reason: `按${region}本币推断`, confidence: "medium" };
}
