import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";
import { fail, ok } from "@/lib/api";
import { fetchMonthlyKline } from "@/lib/monthlyKline";

export const dynamic = "force-dynamic";

/** v1 月收盘与月份；Web / iOS 共用缓存与失败恢复。 */
export async function GET(request: Request) {
  if (!rateLimit(`kline:${clientIp(request)}`, 120, 60 * 1000) || !rateLimitGlobal("kline", 600, 60 * 1000)) {
    return fail(42901, "请求过于频繁，请稍后再试", 429);
  }
  const { searchParams } = new URL(request.url);
  const market = (searchParams.get("market") || "").trim().toUpperCase();
  const code = (searchParams.get("code") || "").trim().toUpperCase();
  if (!code) return fail(40001, "缺少代码", 400);
  if (code.length > 40 || !/^[A-Z0-9._-]+$/.test(code)) return fail(40001, "股票代码不合法", 400);
  if (!["US", "HK", "CN", "JP", "KR"].includes(market)) return fail(40001, "暂不支持该市场", 400);
  try { return ok(await fetchMonthlyKline(market, code)); }
  catch { return fail(50002, "K 线获取失败，请稍后重试", 502); }
}
