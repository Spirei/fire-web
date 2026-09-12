/**
 * 卡面库的多语言显示：中文卡名 ↔ 英文卡名双向对照。
 *
 * 素材里银行名自带 englishName（官方英文名），卡名则中英混杂：
 * 中文卡名（中银长城借记卡）与英文卡名（Chase Debit Card）都有，所以两边都要一份对照表 ——
 * 由 `scripts/gen-card-en.mjs` 用大模型一次性生成、落成静态 JSON，前端直接查表（不联网、不花钱）。
 * 素材库新增卡片后重跑一次脚本，只补缺的那几张。
 *
 * 数据文件：data/card-names-en.json
 *   cards   中文卡名 → 英文名
 *   cardsZh 英文卡名 → 中文名
 *   banksZh 英文银行名 → 中文名
 */

import cardNamesEnData from "@/data/card-names-en.json";
import { hanSimplified, hanTraditional } from "@/lib/hanConvert";

/** 卡面库里卡名 / 银行名的显示方式 */
export type CardScript = "original" | "simplified" | "traditional" | "english";

type CardNameData = {
  cards?: Record<string, string>;
  cardsZh?: Record<string, string>;
  banksZh?: Record<string, string>;
};

const DATA = cardNamesEnData as CardNameData;
const TO_EN = DATA.cards ?? {};
const TO_ZH = DATA.cardsZh ?? {};
const BANKS_TO_ZH = DATA.banksZh ?? {};

/** 卡名的英文写法；没有对照（比如自建的新卡）就原样返回 */
export function cardNameEn(name: string): string {
  return TO_EN[name] ?? name;
}

/** 英文卡名的中文写法；本来就是中文的卡名原样返回 */
export function cardNameZh(name: string): string {
  return TO_ZH[name] ?? name;
}

/** 银行名的中文写法（Chase 这种英文行名给一个通行中文名） */
export function bankNameZh(name: string): string {
  return BANKS_TO_ZH[name] ?? name;
}

/** 按当前显示方式取卡名：原文 / 简体 / 繁體 / 英文 */
export function cardTitle(name: string, script: CardScript): string {
  if (script === "english") return cardNameEn(name);
  if (script === "original") return name;
  const base = cardNameZh(name);
  return script === "simplified" ? hanSimplified(base) : hanTraditional(base);
}

/** 按当前显示方式取银行名：英文模式优先素材里的官方英文名 */
export function bankTitle(bank: { name: string; englishName?: string }, script: CardScript): string {
  if (script === "english") return bank.englishName || bank.name;
  if (script === "original") return bank.name;
  const base = bankNameZh(bank.name);
  return script === "simplified" ? hanSimplified(base) : hanTraditional(base);
}

/** 卡种：素材里 type 是中文，brand / level 本来就是英文 */
const TYPE_EN: Record<string, string> = {
  借记卡: "Debit Card",
  信用卡: "Credit Card",
  预付卡: "Prepaid Card",
  签账卡: "Charge Card",
  取现卡: "Cash Card",
  交通卡: "Transit Card",
  礼品卡: "Gift Card",
  虚拟卡: "Virtual Card",
  其他: "Other"
};

export function typeTitle(type: string, script: CardScript): string {
  return script === "english" ? TYPE_EN[type] ?? type : type;
}

/** 地区名：只有英文模式需要翻译，中文三种模式都沿用素材写法 */
const REGION_EN: Record<string, string> = {
  中国内地: "Mainland China",
  中国香港: "Hong Kong SAR",
  中国澳门: "Macau SAR",
  中国台湾: "Taiwan",
  美国: "United States",
  日本: "Japan",
  英国: "United Kingdom",
  新加坡: "Singapore",
  加拿大: "Canada",
  澳大利亚: "Australia",
  德国: "Germany",
  爱尔兰: "Ireland",
  哈萨克斯坦: "Kazakhstan",
  俄罗斯: "Russia"
};

export function regionTitle(region: string, script: CardScript): string {
  return script === "english" ? REGION_EN[region] ?? region : region;
}

/** 对照表里已经收了多少条（详情页提示用） */
export function englishCardNameCount(): number {
  return Object.keys(TO_EN).length + Object.keys(TO_ZH).length + Object.keys(BANKS_TO_ZH).length;
}
