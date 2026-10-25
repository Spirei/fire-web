import { fetchChartSeries, CHART_SERIES_MARKETS } from "@/lib/chartSeries";
import { marketResponse } from "@/lib/marketResponse";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";
import { fail } from "@/lib/api";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  if (!rateLimit(`chart-series:${clientIp(request)}`, 90, 60000) || !rateLimitGlobal("chart-series", 500, 60000)) return fail(42901, "请求过于频繁，请稍后重试", 429);
  const params = new URL(request.url).searchParams;
  const market = (params.get("market") || "").toUpperCase(), code = (params.get("code") || "").toUpperCase(), days = Number(params.get("days"));
  if (!CHART_SERIES_MARKETS.includes(market) || !/^[A-Z0-9._-]{1,40}$/.test(code) || ![1, 5].includes(days)) return fail(40001, "分时参数无效", 400);
  try { return await marketResponse(request, await fetchChartSeries(market, code, days)); }
  catch { return fail(50002, "分时行情获取失败，请稍后重试", 502); }
}
