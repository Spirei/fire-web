import { NextResponse } from "next/server";
import { getAuthUser, isAdmin, isTrustedMutationRequest } from "@/lib/auth";
import { getSiteSettings } from "@/lib/settings";
import { rateLimit } from "@/lib/rateLimit";

const headers = { "Cache-Control": "no-store, private", Pragma: "no-cache", Vary: "Cookie, Authorization", "X-Content-Type-Options": "nosniff" };

/** Dedicated administrator action. General settings responses remain fully redacted. */
export async function POST(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401, headers });
  if (!isAdmin(user) || !isTrustedMutationRequest(request)) return NextResponse.json({ error: "需要管理员权限" }, { status: 403, headers });
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") return NextResponse.json({ error: "无效的请求" }, { status: 415, headers });
  if (!rateLimit(`xueqiu-cookie-read:${user.id}`, 20, 60_000)) return NextResponse.json({ error: "操作频繁，请稍后重试" }, { status: 429, headers: { ...headers, "Retry-After": "60" } });
  try {
    const cookie = getSiteSettings().xueqiuCookie;
    if (!cookie) return NextResponse.json({ error: "尚未配置 Cookie" }, { status: 404, headers });
    return NextResponse.json({ cookie }, { headers });
  } catch {
    return NextResponse.json({ error: "Cookie 读取失败，请重试" }, { status: 500, headers });
  }
}
