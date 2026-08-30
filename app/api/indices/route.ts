import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { fetchIndices } from "@/lib/quotes";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";

export async function GET(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!rateLimit(`indices:${clientIp(request)}`, 60, 60 * 1000) || !rateLimitGlobal("indices", 300, 60 * 1000)) {
    return NextResponse.json({ error: "请求过于频繁，请稍后再试" }, { status: 429 });
  }
  try {
    const groups = await fetchIndices();
    return NextResponse.json({ groups });
  } catch (err) {
    return NextResponse.json({ error: "指数获取失败，请稍后重试" }, { status: 502 });
  }
}
