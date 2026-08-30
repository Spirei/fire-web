import { NextResponse } from "next/server";
import { fetchTicker } from "@/lib/ticker";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";

export async function GET(request: Request) {
  if (!rateLimit(`ticker:${clientIp(request)}`, 60, 60 * 1000) || !rateLimitGlobal("ticker", 300, 60 * 1000)) {
    return NextResponse.json({ error: "请求过于频繁，请稍后再试" }, { status: 429 });
  }
  try {
    const data = await fetchTicker();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ items: [] });
  }
}
