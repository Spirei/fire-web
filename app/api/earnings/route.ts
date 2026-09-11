import { NextResponse } from "next/server";
import { getEarningsMonth, getEarningsForecast, isValidEarningsMonth, type EarningsMarket } from "@/lib/earnings";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!rateLimit(`earnings:${clientIp(request)}`, 60, 60 * 1000) || !rateLimitGlobal("earnings", 300, 60 * 1000)) {
    return NextResponse.json({ error: "请求过于频繁，请稍后再试" }, { status: 429 });
  }
  try {
    const { searchParams } = new URL(request.url);
    const monthParam = searchParams.get("month");
    const marketParam = (searchParams.get("market") || "US").toUpperCase() as EarningsMarket;
    if (marketParam !== "US" && marketParam !== "CN" && marketParam !== "HK") {
      return NextResponse.json({ items: [], error: "该市场财报数据源暂未接入" }, { status: 400 });
    }
    if (!monthParam) {
      const result = await getEarningsForecast();
      return NextResponse.json(result);
    }
    const match = /^(\d{4})-(\d{2})$/.exec(monthParam);
    if (!match) {
      return NextResponse.json({ items: [], error: "month 格式应为 YYYY-MM" }, { status: 400 });
    }
    const year = Number(match[1]);
    const month = Number(match[2]) - 1;
    if (!isValidEarningsMonth(year, month)) {
      return NextResponse.json({ items: [], error: "超出财报日历可浏览范围" }, { status: 400 });
    }
    const result = await getEarningsMonth(year, month, marketParam);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ items: [], error: "财报接口暂时不可用，请稍后重试" }, { status: 502 });
  }
}
