import { getEarningsMonth, getEarningsForecast, isValidEarningsMonth, type EarningsMarket } from "@/lib/earnings";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";
import { fail, ok } from "@/lib/api";

export const dynamic = "force-dynamic";

/** v1 财报日历（?month=YYYY-MM&market=US|CN；不带 month 返回未来预测） */
export async function GET(request: Request) {
  if (!rateLimit(`earnings:${clientIp(request)}`, 60, 60 * 1000) || !rateLimitGlobal("earnings", 300, 60 * 1000)) {
    return fail(42901, "请求过于频繁，请稍后再试", 429);
  }
  const { searchParams } = new URL(request.url);
  const monthParam = searchParams.get("month");
  const marketParam = (searchParams.get("market") || "US").toUpperCase() as EarningsMarket;
  if (marketParam !== "US" && marketParam !== "CN") {
    return fail(40001, "该市场财报数据源暂未接入", 400);
  }
  if (!monthParam) {
    try {
      return ok(await getEarningsForecast());
    } catch {
      return fail(50002, "财报接口暂时不可用，请稍后重试", 502);
    }
  }
  const match = /^(\d{4})-(\d{2})$/.exec(monthParam);
  if (!match) return fail(40001, "month 格式应为 YYYY-MM", 400);
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  if (!isValidEarningsMonth(year, month)) return fail(40001, "超出财报日历可浏览范围", 400);
  try {
    return ok(await getEarningsMonth(year, month, marketParam));
  } catch {
    return fail(50002, "财报接口暂时不可用，请稍后重试", 502);
  }
}
