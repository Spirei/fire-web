import { NextResponse } from "next/server";
import { searchStocks } from "@/lib/quotes";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";

export async function GET(request: Request) {
  if (!rateLimit(`search:${clientIp(request)}`, 60, 60 * 1000) || !rateLimitGlobal("search", 300, 60 * 1000)) {
    return NextResponse.json({ error: "请求过于频繁，请稍后再试" }, { status: 429 });
  }
  const q = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  if (!q) return NextResponse.json({ results: [] });
  if (q.length > 50) return NextResponse.json({ error: "搜索关键词过长" }, { status: 400 });

  try {
    const results = await searchStocks(q);
    return NextResponse.json({ results });
  } catch (err) {
    return NextResponse.json({ error: "搜索失败，请稍后重试" }, { status: 502 });
  }
}
