import { readJsonBody } from "@/lib/requestBody";
import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { listCardHoldings, setCardHeld } from "@/lib/cardAmounts";
import { clientIp, rateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

/** 卡面 key 归一化（与录入金额 / 标签同一套：按路径分段 URL 编码，幂等） */
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

export async function GET(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  return NextResponse.json({ holdings: listCardHoldings(user.id) }, { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!rateLimit(`card-holdings:${user.id}:${clientIp(request)}`, 120, 60 * 1000)) {
    return NextResponse.json({ error: "操作过于频繁，请稍后再试" }, { status: 429 });
  }
  const body = await readJsonBody(request).catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "无效请求" }, { status: 400 });
  const cardKey = normalizeCardKey(String((body as { cardKey?: unknown }).cardKey ?? "").trim());
  const held = (body as { held?: unknown }).held === true;
  if (!cardKey || cardKey.length > 600) return NextResponse.json({ error: "卡面标识无效" }, { status: 400 });
  return NextResponse.json({ cardKey, held: setCardHeld(user.id, cardKey, held) }, { headers: { "Cache-Control": "no-store" } });
}
