import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { createCustomCard, customCardImageOf, deleteCustomCard, listCustomCards } from "@/lib/cardCustom";
import { setCardHeld } from "@/lib/cardAmounts";
import { upsertAsset, deleteAsset } from "@/lib/assets";
import { cardAssetId } from "@/lib/cardAssets";
import { readCardManifest } from "@/lib/cardLibrary";
import { clientIp, rateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const CARD_TYPES = ["借记卡", "信用卡", "预付卡", "签账卡", "取现卡", "交通卡", "礼品卡", "虚拟卡", "其他"];
const SCOPES = ["single", "dual", "multi", "unknown"];

function clean(value: unknown, max: number): string {
  return String(value ?? "").trim().slice(0, max);
}

/** 卡名 / 银行归一化：去空格、转小写，用于查重（「标准 白金卡」和「标准白金卡」算同一张） */
function keyOf(value: string): string {
  return value.replace(/\s+/g, "").toLowerCase();
}

/**
 * 库里已经有的卡（清单里的 436 张 + 自己新建的）：同名 + 同银行就算重复。
 * 清单里很多卡叫「标准普卡」但属于不同银行，所以必须连着银行一起比。
 */
function existingCardKeys(userId: string): Set<string> {
  const keys = new Set<string>();
  const manifest = readCardManifest();
  const regions = (manifest?.regions ?? []) as { banks?: { name?: string; cards?: { name?: string }[] }[] }[];
  regions.forEach((region) => {
    (region.banks ?? []).forEach((bank) => {
      const bankName = keyOf(String(bank?.name ?? ""));
      (bank.cards ?? []).forEach((card) => {
        if (card?.name) keys.add(`${keyOf(String(card.name))}@${bankName}`);
      });
    });
  });
  listCustomCards(userId).forEach((card) => {
    keys.add(`${keyOf(card.name)}@${keyOf(card.bank)}`);
  });
  return keys;
}

export async function GET(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  return NextResponse.json({ cards: listCustomCards(user.id) }, { headers: NO_STORE });
}

/** POST：新增一张素材库里没有的卡（上传的卡面 + 卡片信息），保存后自动进「我的卡」 */
export async function POST(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!rateLimit(`card-custom:${user.id}:${clientIp(request)}`, 60, 60 * 1000)) {
    return NextResponse.json({ error: "操作过于频繁，请稍后再试" }, { status: 429 });
  }
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "无效请求" }, { status: 400 });

  const raw = body as { name?: unknown; bank?: unknown; region?: unknown; type?: unknown; brand?: unknown; level?: unknown; image?: unknown; currencyScope?: unknown };
  const name = clean(raw.name, 60);
  const bank = clean(raw.bank, 60);
  const region = clean(raw.region, 24);
  const type = CARD_TYPES.includes(clean(raw.type, 12)) ? clean(raw.type, 12) : "其他";
  const image = clean(raw.image, 300);
  const currencyScope = SCOPES.includes(clean(raw.currencyScope, 12).toLowerCase()) ? clean(raw.currencyScope, 12).toLowerCase() : "";

  if (!name) return NextResponse.json({ error: "请填写卡名" }, { status: 400 });
  if (!bank) return NextResponse.json({ error: "请填写银行" }, { status: 400 });
  if (!image.startsWith("/uploads/")) return NextResponse.json({ error: "请先上传卡面图片" }, { status: 400 });
  if (existingCardKeys(user.id).has(`${keyOf(name)}@${keyOf(bank)}`)) {
    return NextResponse.json({ error: "卡面库里已经有这张卡了（同名 + 同银行）" }, { status: 409 });
  }

  const card = createCustomCard(user.id, {
    name,
    bank,
    region,
    type,
    brand: clean(raw.brand, 24),
    level: clean(raw.level, 24),
    image,
    currencyScope
  });
  // 自己新建的卡默认就在「我的卡」里
  setCardHeld(user.id, card.image, true);
  // 同步登记到「素材库 → 卡片」：和清单里的卡面一样是一条 type=card 的素材，
  // 素材库里能替换 / 删除，卡面库与卡包读的也是这条素材的 url
  upsertAsset({
    id: cardAssetId(card.image),
    type: "card",
    market: card.region || "OTHER",
    code: card.name || "CARD",
    name: card.name,
    url: card.image
  });
  return NextResponse.json({ card }, { headers: NO_STORE });
}

/** DELETE：删掉自定义卡（卡片本身 + 它的持有记录） */
export async function DELETE(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!rateLimit(`card-custom-del:${user.id}:${clientIp(request)}`, 60, 60 * 1000)) {
    return NextResponse.json({ error: "操作过于频繁，请稍后再试" }, { status: 429 });
  }
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!id) return NextResponse.json({ error: "缺少卡片标识" }, { status: 400 });
  const image = customCardImageOf(user.id, id);
  const removed = deleteCustomCard(user.id, id);
  if (!removed) return NextResponse.json({ error: "这张卡不存在" }, { status: 404 });
  // 素材库 → 卡片 里那条也一起摘掉，避免留下孤儿素材
  if (image) deleteAsset(cardAssetId(image));
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
