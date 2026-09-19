import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/requestBody";
import { getAuthUser, isAdmin, isTrustedMutationRequest } from "@/lib/auth";
import { saveModelOrder } from "@/lib/showcaseModels";
import { clientIp, rateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

/** 保存车型展示顺序（首页右下角车型条照这个顺序排） */
export async function PUT(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  // 顺序就是首页车型条的顺序：限管理员
  if (!isAdmin(user)) return NextResponse.json({ error: "只有管理员能调整车型顺序" }, { status: 403 });
  if (!isTrustedMutationRequest(request)) return NextResponse.json({ error: "请求来源不可信" }, { status: 403 });
  if (!rateLimit(`showcase-order:${clientIp(request)}`, 120, 60 * 60 * 1000)) {
    return NextResponse.json({ error: "操作过于频繁，请稍后再试" }, { status: 429 });
  }
  // 请求体封顶 64KB：顺序表最多几十个 id，解析前就该拦住超大 body
  let body: { ids?: unknown };
  try {
    body = ((await readJsonBody(request, 64 * 1024)) ?? {}) as { ids?: unknown };
  } catch {
    return NextResponse.json({ error: "请求格式不正确" }, { status: 400 });
  }
  const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === "string") : [];
  if (!ids.length) return NextResponse.json({ error: "顺序为空" }, { status: 400 });
  try {
    return NextResponse.json({ order: saveModelOrder(ids) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "保存失败" }, { status: 400 });
  }
}
