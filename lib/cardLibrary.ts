import fs from "node:fs";
import path from "node:path";
import { listCardAmounts, listCardHoldings, listCardTags, type CardAmount } from "./cardAmounts";
import { listCardDetails, type CardDetails } from "./cardWallet";
import { listCustomCards, type CustomCard } from "./cardCustom";
import { cardAssetId, cardKeyOfAssetId, manifestCoverUrl } from "./cardAssets";
import { CARD_VARIANT_DROPPED } from "./cardVariants";
import { REGION_CURRENCY } from "./cardCurrencies";
import { hasSecurityCode } from "./cardSecurity";
import { upsertAsset } from "./assets";
import { getDb } from "./db";
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
  /**
   * 服务端当前时间（毫秒）：首帧就要用 —— 「新加的卡置顶」和 NEW 角标都按 3 天窗口算，
   * 客户端自己取时间的话，服务端首帧只能画默认顺序，挂载后重排会让卡片"跳位置"。
   */
  nowMs: number;
  /**
   * 卡面首次入库时间（卡面 key → ISO）：新入库的卡（脚本导入的新卡 / 自己新建的卡）
   * 3 天内置顶并挂 NEW。升级前的老素材不在表里 → 视为不是新卡。
   */
  firstSeen: Record<string, string>;
  /** 卡背信息（卡号 / 有效期 / 安全码 / 备注 / 币种）：卡包与卡片详情首帧就要用 */
  details: Record<string, CardDetails>;
  /** 卡面覆盖表（卡面文件 → 实际图片地址）：素材库换过图的卡走这里，没登记的卡回退清单原图 */
  covers: Record<string, string>;
  /** 用户自建卡（素材库里没有的卡）：并进卡面库一起展示 */
  customCards: CustomCard[];
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
  sweepLegacyCardCvv();
  // 先跟清单对一次账：脚本新导入的卡面在这里登记进素材库（顺手写下「首次入库时间」），
  // 于是打开卡面库就能看到新卡置顶 + NEW，而不必先去一趟素材库页面。
  ensureCardAssets();
  const manifest = readCardManifest();
  return {
    regions: manifest?.regions ?? [],
    typeOrder: manifest?.typeOrder ?? [],
    updatedAt: manifest?.updatedAt ?? null,
    source: manifest?.source ?? "",
    amounts: listCardAmounts(userId),
    tags: listCardTags(userId),
    holdings: listCardHoldings(userId),
    nowMs: Date.now(),
    firstSeen: cardFirstSeenMap(),
    details: listCardDetails(userId),
    covers: cardCoverMap(),
    customCards: listCustomCards(userId)
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

/* ---------- 一次性数据清洗 ---------- */

let cvvSweepDone = false;

/**
 * 清掉「本来就没有安全码的卡」上残留的 cvv。
 *
 * 背景：卡包的编辑弹窗此前对**中国大陆的借记卡**也给安全码输入框，早期数据里可能留了值；
 * 现在这类卡既不显示、也不能编辑该字段（见 lib/cardSecurity.ts），那些值就是脏数据。
 *
 * 幂等且只在每个进程第一次读卡面库时跑一次（本地与线上容器都会自动清）：
 * 只 UPDATE cvv 非空的行，跑完之后再跑就没有匹配行；清单还没抓到（没跑过抓取脚本）时直接跳过、
 * 等下次有清单再来，避免在拿不到卡类型的情况下乱清。
 */
export function sweepLegacyCardCvv(): number {
  if (cvvSweepDone) return 0;
  const meta = cardMetaMap();
  if (meta.size === 0) return 0;
  cvvSweepDone = true;
  const rows = getDb().prepare("SELECT user_id, card_key FROM card_details WHERE cvv <> ''").all() as { user_id: string; card_key: string }[];
  const stale = rows.filter((row) => {
    const info = meta.get(row.card_key);
    return info !== undefined && !hasSecurityCode(info);
  });
  if (stale.length === 0) return 0;
  const db = getDb();
  const clear = db.prepare("UPDATE card_details SET cvv = '', updated_at = ? WHERE user_id = ? AND card_key = ?");
  const now = new Date().toISOString();
  db.transaction(() => stale.forEach((row) => clear.run(now, row.user_id, row.card_key)))();
  console.log(`[card] 已清理 ${stale.length} 张「无安全码」卡片上残留的 CVV（中国大陆借记卡）`);
  return stale.length;
}

/* ---------- 卡面素材（素材库 → 「卡片」类目） ---------- */

/**
 * 把清单里的卡面**全部登记进素材库**（`assets.type = "card"`），素材库就有了「卡片」类目。
 * 幂等：只补缺失的行，已存在的一律不动 —— 用户可能已经在素材库把某张卡换成自己的照片了，
 * 这里绝不能把 url 覆盖回清单原图。
 */
export function ensureCardAssets(): number {
  const db = getDb();
  const existing = new Set((db.prepare("SELECT id FROM assets WHERE type = 'card'").all() as { id: string }[]).map((row) => row.id));
  // 被合并掉的重复素材（同一张卡的同一张图多次收录）在素材库里也一并清掉
  CARD_VARIANT_DROPPED.forEach((file) => {
    const id = cardAssetId(file);
    if (!existing.has(id)) return;
    db.prepare("DELETE FROM assets WHERE id = ? AND type = 'card'").run(id);
    existing.delete(id);
  });
  let added = 0;
  (readCardManifest()?.regions ?? []).forEach((region) => {
    const label = String((region as { label?: unknown })?.label ?? "");
    const banks = (region as { banks?: unknown })?.banks;
    if (!Array.isArray(banks)) return;
    banks.forEach((bank) => {
      const cards = (bank as { cards?: unknown })?.cards;
      if (!Array.isArray(cards)) return;
      cards.forEach((card) => {
        const item = card as { file?: unknown; name?: unknown };
        if (typeof item?.file !== "string" || !item.file) return;
        const id = cardAssetId(item.file);
        if (existing.has(id)) return;
        if (CARD_VARIANT_DROPPED.has(item.file)) return;
        const name = typeof item.name === "string" && item.name ? item.name : item.file;
        // code 只用于展示（upsertAsset 会转大写），真正的身份是 id 里的完整卡面路径
        const stem = item.file.split("/").pop()?.replace(/\.[^.]+$/, "") || name;
        upsertAsset({ id, type: "card", market: label || "OTHER", code: stem, name, url: manifestCoverUrl(item.file) });
        existing.add(id);
        added += 1;
      });
    });
  });
  return added;
}

/** 卡面覆盖表：卡面文件 → 当前图片地址（素材库里换过图的就是新地址） */
export function cardCoverMap(): Record<string, string> {
  const rows = getDb().prepare("SELECT id, url FROM assets WHERE type = 'card'").all() as { id: string; url: string }[];
  const out: Record<string, string> = {};
  rows.forEach((row) => {
    const key = cardKeyOfAssetId(row.id);
    if (key && row.url) out[key] = row.url;
  });
  return out;
}

/**
 * 卡面首次入库时间表：卡面文件 → 素材首次登记时间（ISO）。
 *
 * 卡面库用它判断「新入库的卡」—— 不管是**抓取脚本导入的新卡**（ensureCardAssets 登记）
 * 还是**自己上传卡面新建的卡**（新增卡片时登记），都会在这里留下首次入库时间；
 * 升级前就存在的老素材留空字符串，一律按「不是新素材」处理，不会误标。
 */
export function cardFirstSeenMap(): Record<string, string> {
  const rows = getDb()
    .prepare("SELECT id, created_at FROM assets WHERE type = 'card' AND created_at <> ''")
    .all() as { id: string; created_at: string }[];
  const out: Record<string, string> = {};
  rows.forEach((row) => {
    const key = cardKeyOfAssetId(row.id);
    if (key && row.created_at) out[key] = row.created_at;
  });
  return out;
}
