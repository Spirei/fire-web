import fs from "node:fs";
import path from "node:path";
import { listCardAmounts, listCardHoldings, listCardTags, type CardAmount } from "./cardAmounts";
import { listCardDetails, type CardDetails } from "./cardWallet";

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
