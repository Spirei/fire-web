import { NextResponse } from "next/server";
import { fetchDailyKline, fetchPeriodKline } from "@/lib/kline";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

/** 完整日 K（前复权），供 K 线组件渲染（前端聚合周 / 月） */
export async function GET(request: Request) {
  // 资产分析一次页面加载需并发拉取全部持仓（30+ 只），预算按页面级放大；全局兜底不变
  if (!rateLimit(`kline-full:${clientIp(request)}`, 300, 60 * 1000) || !rateLimitGlobal("kline-full", 600, 60 * 1000)) {
    return NextResponse.json({ error: "请求过于频繁，请稍后再试" }, { status: 429 });
  }
  const { searchParams } = new URL(request.url);
  const market = String(searchParams.get("market") ?? "").trim().toUpperCase();
  const code = String(searchParams.get("code") ?? "").trim().toUpperCase();
  if (!market || !code) return NextResponse.json({ error: "缺少 market / code" }, { status: 400 });
  if (!/^[A-Z0-9._-]+$/.test(code)) return NextResponse.json({ error: "股票代码不合法" }, { status: 400 });
  if (!["US", "HK", "CN", "JP", "KR"].includes(market)) {
    return NextResponse.json({ error: "暂不支持该市场" }, { status: 400 });
  }
  // 季 K 需要覆盖近 12 年交易日；上限约 13 年，仍限制响应体规模。
  const limit = Math.min(3300, Math.max(60, Number(searchParams.get("limit")) || 320));
  const index = searchParams.get("index") === "1";
  const periodRaw = String(searchParams.get("period") ?? "").toUpperCase();
  const period = ["WEEK", "MONTH", "QUARTER", "YEAR"].includes(periodRaw)
    ? (periodRaw as "WEEK" | "MONTH" | "QUARTER" | "YEAR")
    : null;
  const adjustRaw = String(searchParams.get("adjust") ?? "").toLowerCase();
  const adjust = adjustRaw === "hfq" ? "hfq" : adjustRaw === "none" ? "none" : "qfq";
  try {
    const items = period
      ? await fetchPeriodKline(market, code, period, limit, adjust)
      : await fetchDailyKline(market, code, limit, index, adjust);
    return NextResponse.json({ market, code, period, adjust, items });
  } catch {
    return NextResponse.json({ error: "获取 K 线失败，请稍后重试" }, { status: 502 });
  }
}
