import fs from "node:fs";
import path from "node:path";
import { listCardAmounts, listCardHoldings, listCardTags, type CardAmount } from "./cardAmounts";
import { listCardDetails, type CardDetails } from "./cardWallet";
import { REGION_CURRENCY } from "./cardCurrencies";
import { FALLBACK_RATES } from "./types";

/** 卡面库清单（由 scripts/fetch-card-assets.mjs 生成） */
const CARDS_DIR = path.join(process.cwd(), "public", "uploads", "cards");
const MANIFEST = path.join(CARDS_DIR, "manifest.json");

export interface CardManifest {
  regions: unknown[];
  typeOrder: string[];
  updatedAt: string | null;
  source: string;
}

export interface CardLibraryPayload extends CardManifest {
  amounts: CardAmount[];
  tags: Record<string, string[]>;
  holdings: string[];
  /** 卡背信息（卡号 / 有效期 / 安全码 / 备注 / 币种）：卡包与卡片详情首帧就要用 */
  details: Record<string, CardDetails>;
}

let cache: { data: CardManifest | null; at: number } | null = null;
const CACHE_TTL = 60 * 1000;

/** 读清单（60 秒内存缓存）：接口与页面首屏注入共用 */
export function readCardManifest(): CardManifest | null {
  if (cache && Date.now() - cache.at < CACHE_TTL) return cache.data;
  try {
    const parsed = JSON.parse(fs.readFileSync(MANIFEST, "utf8")) as {
      regions?: unknown;
      typeOrder?: unknown;
      generatedAt?: string;
      source?: string;
    };
    const data: CardManifest | null = Array.isArray(parsed?.regions)
      ? {
          regions: parsed.regions as unknown[],
          typeOrder: Array.isArray(parsed.typeOrder) ? (parsed.typeOrder as string[]) : [],
          updatedAt: typeof parsed.generatedAt === "string" ? parsed.generatedAt : null,
          source: typeof parsed.source === "string" ? parsed.source : ""
        }
      : null;
    cache = { data, at: Date.now() };
    return data;
  } catch {
    cache = { data: null, at: Date.now() };
    return null;
  }
}

/** 首屏注入用：清单 + 当前用户的持有 / 金额 / 标签 */
export function cardLibraryForUser(userId: string): CardLibraryPayload {
  const manifest = readCardManifest();
  return {
    regions: manifest?.regions ?? [],
    typeOrder: manifest?.typeOrder ?? [],
    updatedAt: manifest?.updatedAt ?? null,
    source: manifest?.source ?? "",
    amounts: listCardAmounts(userId),
    tags: listCardTags(userId),
    holdings: listCardHoldings(userId),
    details: listCardDetails(userId)
  };
}

/* ---------- 银行卡现金（资产分析的资金系统 / 可用现金联动） ---------- */

/**
 * 「卡上的钱」才算现金的卡类型：信用卡的「金额」是**额度**不是余额，
 * 预付费种（预付卡）与借记卡一样是实打实已经存进去的钱。
 */
const CASH_CARD_TYPES = new Set(["借记卡", "预付卡"]);

/** 有汇率、能折算成现金的币种；没有汇率的（卢布 / 坚戈）宁可不算，也绝不能按 1:1 当成美元 */
const RATE_CURRENCIES = new Set(Object.keys(FALLBACK_RATES));

let metaCache: { map: Map<string, { type: string; region: string }>; at: number } | null = null;

/** 卡面 file → { 卡类型, 地区 }（都来自清单）：用来区分借记卡 / 信用卡，并兜底卡币种 */
function cardMetaMap(): Map<string, { type: string; region: string }> {
  if (metaCache && Date.now() - metaCache.at < CACHE_TTL) return metaCache.map;
  const map = new Map<string, { type: string; region: string }>();
  const regions = readCardManifest()?.regions ?? [];
  regions.forEach((region) => {
    const label = String((region as { label?: unknown })?.label ?? "");
    const banks = (region as { banks?: unknown })?.banks;
    if (!Array.isArray(banks)) return;
    banks.forEach((bank) => {
      const cards = (bank as { cards?: unknown })?.cards;
      if (!Array.isArray(cards)) return;
      cards.forEach((card) => {
        const item = card as { file?: unknown; type?: unknown };
        if (typeof item?.file !== "string") return;
        map.set(item.file, { type: typeof item.type === "string" ? item.type : "", region: label });
      });
    });
  });
  metaCache = { map, at: Date.now() };
  return map;
}

/**
 * 银行卡现金：只统计「我的卡」里的**借记卡 / 预付卡**余额（信用卡额度不计），按卡币种汇总。
 * 资金系统会把它并进现金余额与「其他净流入」（见 app/api/v1/funds），
 * 于是资产分析的可用现金 / 净资产与资金系统的期末总资产看到的是同一个现金口径。
 *
 * 卡币种取值顺序与卡包 / 卡面库一致（金额上记的币种 → 卡背信息里的币种 → 地区默认币种），
 * 保证「卡包上显示的这个余额」和「算进现金的这个余额」是同一笔、同一币种。
 */
export function cardCashByCurrency(userId: string): Record<string, number> {
  const meta = cardMetaMap();
  const held = new Set(listCardHoldings(userId));
  const details = listCardDetails(userId);
  const out: Record<string, number> = {};
  listCardAmounts(userId).forEach((amount) => {
    if (!held.has(amount.cardKey)) return;
    const info = meta.get(amount.cardKey);
    if (!CASH_CARD_TYPES.has(info?.type ?? "")) return;
    const currency = String(
      amount.currency || details[amount.cardKey]?.currency || REGION_CURRENCY[info?.region ?? ""] || ""
    ).toUpperCase();
    if (!RATE_CURRENCIES.has(currency)) return;
    const value = Number(amount.amount) || 0;
    if (!value) return;
    out[currency] = (out[currency] || 0) + value;
  });
  return out;
}
