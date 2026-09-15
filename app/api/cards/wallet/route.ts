import { readJsonBody } from "@/lib/requestBody";
import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import {
  addCardBalanceEntry,
  deleteCardBalanceEntry,
  listCardBalanceHistoryForCard,
  listCardDetails,
  saveCardDetails,
  type CardBalanceKind
} from "@/lib/cardWallet";
import { clientIp, rateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

/** 卡面 key 归一化（与金额 / 标签 / 持有同一套：按路径分段 URL 编码，幂等） */
function normalizeCardKey(value: string): string {
  return value
    .split("/")
    .map((segment) => {
      try {
        return encodeURIComponent(decodeURIComponent(segment));
      } catch {
        return encodeURIComponent(segment);
      }
    })
    .join("/");
}

const NO_STORE = { headers: { "Cache-Control": "no-store" } };
const KINDS: CardBalanceKind[] = ["deposit", "withdraw", "adjust"];

/** GET：不带 cardKey 返回全部卡背信息（挂载后静默刷新用）；带 cardKey 额外返回这张卡的余额流水 */
export async function GET(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const raw = String(new URL(request.url).searchParams.get("cardKey") || "").trim();
  if (!raw) return NextResponse.json({ details: listCardDetails(user.id) }, NO_STORE);
  const cardKey = normalizeCardKey(raw);
  if (!cardKey || cardKey.length > 600) return NextResponse.json({ error: "卡面标识无效" }, { status: 400 });
  const details = listCardDetails(user.id);
  return NextResponse.json(
    { cardKey, details: details[cardKey] ?? null, entries: listCardBalanceHistoryForCard(user.id, cardKey) },
    NO_STORE
  );
}

/** PUT：保存卡背信息（卡号 / 有效期 / 安全码 / 备注 / 币种），只覆盖传入的字段 */
export async function PUT(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!rateLimit(`card-wallet:${user.id}:${clientIp(request)}`, 120, 60 * 1000)) {
    return NextResponse.json({ error: "操作过于频繁，请稍后再试" }, { status: 429 });
  }
  const body = await readJsonBody(request).catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "无效请求" }, { status: 400 });
  const cardKey = normalizeCardKey(String((body as { cardKey?: unknown }).cardKey ?? "").trim());
  if (!cardKey || cardKey.length > 600) return NextResponse.json({ error: "卡面标识无效" }, { status: 400 });
  const raw = body as { number?: unknown; expiry?: unknown; cvv?: unknown; note?: unknown; currency?: unknown; currencyScope?: unknown; image?: unknown };
  if (raw.number !== undefined && String(raw.number).replace(/[^\d ]/g, "").length > 30) {
    return NextResponse.json({ error: "卡号过长" }, { status: 400 });
  }
  if (raw.note !== undefined && String(raw.note).length > 60) {
    return NextResponse.json({ error: "备注过长" }, { status: 400 });
  }
  // 自定义卡面只接受本站 /uploads/ 下的地址（空字符串 = 恢复清单原图），
  // 挡掉外链 / data: / javascript: 之类会被塞进 <img src> 的内容
  if (raw.image !== undefined) {
    const candidate = String(raw.image).trim();
    if (candidate !== "" && (!candidate.startsWith("/uploads/") || candidate.length > 500)) {
      return NextResponse.json({ error: "卡面地址无效" }, { status: 400 });
    }
  }
  const details = saveCardDetails(user.id, cardKey, {
    number: raw.number === undefined ? undefined : String(raw.number),
    expiry: raw.expiry === undefined ? undefined : String(raw.expiry),
    cvv: raw.cvv === undefined ? undefined : String(raw.cvv),
    note: raw.note === undefined ? undefined : String(raw.note),
    currency: raw.currency === undefined ? undefined : String(raw.currency),
    currencyScope: raw.currencyScope === undefined ? undefined : String(raw.currencyScope),
    image: raw.image === undefined ? undefined : String(raw.image)
  });
  return NextResponse.json({ details }, NO_STORE);
}

/** POST：记一笔余额变动（存钱 / 取钱 / 余额调整），返回这笔流水与最新余额 */
export async function POST(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!rateLimit(`card-wallet-balance:${user.id}:${clientIp(request)}`, 240, 60 * 1000)) {
    return NextResponse.json({ error: "操作过于频繁，请稍后再试" }, { status: 429 });
  }
  const body = await readJsonBody(request).catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "无效请求" }, { status: 400 });
  const cardKey = normalizeCardKey(String((body as { cardKey?: unknown }).cardKey ?? "").trim());
  if (!cardKey || cardKey.length > 600) return NextResponse.json({ error: "卡面标识无效" }, { status: 400 });
  const kind = String((body as { kind?: unknown }).kind ?? "") as CardBalanceKind;
  if (!KINDS.includes(kind)) return NextResponse.json({ error: "类型无效" }, { status: 400 });
  const amount = Number((body as { amount?: unknown }).amount);
  if (!Number.isFinite(amount) || Math.abs(amount) > 1e12) return NextResponse.json({ error: "金额无效" }, { status: 400 });
  const currentBalanceRaw = (body as { currentBalance?: unknown }).currentBalance;
  const currentBalance = currentBalanceRaw === undefined ? undefined : Number(currentBalanceRaw);
  if (currentBalance !== undefined && (!Number.isFinite(currentBalance) || Math.abs(currentBalance) > 1e12)) {
    return NextResponse.json({ error: "余额无效" }, { status: 400 });
  }
  if (kind === "adjust" && currentBalance === undefined) {
    return NextResponse.json({ error: "余额调整需要提供调整后的余额" }, { status: 400 });
  }
  const note = String((body as { note?: unknown }).note ?? "").trim().slice(0, 100);
  const occurredAt = String((body as { occurredAt?: unknown }).occurredAt ?? "").trim();
  /** "broker" = 这笔钱的另一端在券商账户：同时记一笔方向相反的资金流水，避免总现金重复计算 */
  const fundAccount = String((body as { fundAccount?: unknown }).fundAccount ?? "").trim() === "broker" ? ("broker" as const) : undefined;
  const fundNote = String((body as { fundNote?: unknown }).fundNote ?? "").trim().slice(0, 60);
  try {
    const { entry, balance } = addCardBalanceEntry(user.id, {
      cardKey,
      amount,
      kind,
      note,
      occurredAt: occurredAt || undefined,
      currentBalance,
      fundAccount,
      fundNote: fundNote || undefined
    });
    return NextResponse.json({ entry, balance }, NO_STORE);
  } catch (error) {
    // 币种不在资金系统里（或这张卡还没填币种）时要说清原因，别静默少记一笔
    return NextResponse.json({ error: error instanceof Error ? error.message : "保存失败" }, { status: 400 });
  }
}

/** DELETE：删掉一笔余额流水，并按剩余流水重放余额 */
export async function DELETE(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!rateLimit(`card-wallet-balance:${user.id}:${clientIp(request)}`, 240, 60 * 1000)) {
    return NextResponse.json({ error: "操作过于频繁，请稍后再试" }, { status: 429 });
  }
  const id = String(new URL(request.url).searchParams.get("id") || "").trim();
  if (!id) return NextResponse.json({ error: "缺少流水 id" }, { status: 400 });
  const result = deleteCardBalanceEntry(user.id, id);
  if (!result) return NextResponse.json({ error: "流水不存在" }, { status: 404 });
  return NextResponse.json({ ok: true, cardKey: result.cardKey, balance: result.balance }, NO_STORE);
}
