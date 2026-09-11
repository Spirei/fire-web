import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { deleteCardAmount, listCardAmounts, upsertCardAmount } from "@/lib/cardAmounts";
import { clientIp, rateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

/** 卡面 key 是「按路径分段 URL 编码」的形态；前端可能传编码或解码形式，这里统一归一化（幂等） */
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

/** 卡面库录入金额：每张卡每位用户一条（cardKey = manifest 里的 card.file） */
export async function GET(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  return NextResponse.json({ amounts: listCardAmounts(user.id) }, { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!rateLimit(`card-amounts:${user.id}:${clientIp(request)}`, 120, 60 * 1000)) {
    return NextResponse.json({ error: "操作过于频繁，请稍后再试" }, { status: 429 });
  }
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "无效请求" }, { status: 400 });
  const cardKey = normalizeCardKey(String((body as { cardKey?: unknown }).cardKey ?? "").trim());
  const amount = Number((body as { amount?: unknown }).amount);
  const currency = String((body as { currency?: unknown }).currency ?? "").trim().toUpperCase().slice(0, 8);
  const note = String((body as { note?: unknown }).note ?? "").trim().slice(0, 100);
  if (!cardKey || cardKey.length > 300) return NextResponse.json({ error: "卡面标识无效" }, { status: 400 });
  if (!Number.isFinite(amount) || amount < 0 || amount > 1e12) return NextResponse.json({ error: "金额无效" }, { status: 400 });
  const record = upsertCardAmount(user.id, { cardKey, amount, currency, note });
  return NextResponse.json({ amount: record }, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const cardKey = normalizeCardKey(String(new URL(request.url).searchParams.get("cardKey") || "").trim());
  if (!cardKey || cardKey.length > 300) return NextResponse.json({ error: "卡面标识无效" }, { status: 400 });
  deleteCardAmount(user.id, cardKey);
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
