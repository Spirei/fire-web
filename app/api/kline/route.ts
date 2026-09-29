import { NextResponse } from "next/server";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";
import { fetchMonthlyKline } from "@/lib/monthlyKline";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

/** 旧版迷你曲线响应保留 { closes }，与 v1 共享同一月收盘数据，只取最近 12 月。 */
export async function GET(request: Request) {
  if (!rateLimit(`kline:${clientIp(request)}`, 120, 60 * 1000) || !rateLimitGlobal("kline", 600, 60 * 1000)) {
    return NextResponse.json({ error: "请求过于频繁，请稍后再试" }, { status: 429, headers });
  }
  const { searchParams } = new URL(request.url);
  const market = (searchParams.get("market") || "").trim().toUpperCase();
  const code = (searchParams.get("code") || "").trim().toUpperCase();
  if (!code) return NextResponse.json({ error: "缺少代码" }, { status: 400, headers });
  if (!/^[A-Z0-9._-]{1,32}$/.test(code)) return NextResponse.json({ error: "股票代码不合法" }, { status: 400, headers });
  if (!["CN", "US", "HK", "JP", "KR"].includes(market)) return NextResponse.json({ closes: [] }, { headers });
  try {
    const series = await fetchMonthlyKline(market, code);
    return NextResponse.json({ closes: series.closes.slice(-12) }, { headers });
  } catch {
    return NextResponse.json({ error: "K 线获取失败，请稍后重试" }, { status: 502, headers });
  }
}
