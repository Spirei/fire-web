import { NextResponse } from "next/server";
import { applySessionCookie, getAuthUser, getSessionToken, isTrustedMutationRequest, renewSessionIfNeeded } from "@/lib/auth";

export async function GET(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  return NextResponse.json({ user }, { headers: { "Cache-Control": "no-store, private" } });
}

/** 同源浏览器活跃检查：Cookie 与数据库同时续期；GET 和移动端固定有效期不变。 */
export async function POST(request: Request) {
  if (!isTrustedMutationRequest(request)) return NextResponse.json({ error: "请求来源不受信任" }, { status: 403, headers: { "Cache-Control": "no-store" } });
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  const response = NextResponse.json({ user }, { headers: { "Cache-Control": "no-store, private" } });
  const token = getSessionToken(request);
  if (token && !request.headers.has("authorization") && renewSessionIfNeeded(token)) applySessionCookie(response, token, request);
  return response;
}
