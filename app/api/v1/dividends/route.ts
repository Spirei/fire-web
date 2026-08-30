import { getDividends } from "@/lib/dividends";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";
import { fail, ok } from "@/lib/api";

export const dynamic = "force-dynamic";

const MARKETS = ["US", "HK", "CN"];

/** v1 股息记录（富途公司行动-分红派息，带缓存） */
export async function GET(request: Request) {
  if (!rateLimit(`dividends:${clientIp(request)}`, 60, 60 * 1000) || !rateLimitGlobal("dividends", 300, 60 * 1000)) {
    return fail(42901, "请求过于频繁，请稍后再试", 429);
  }
  const { searchParams } = new URL(request.url);
  const market = String(searchParams.get("market") ?? "").trim().toUpperCase();
  const code = String(searchParams.get("code") ?? "").trim().toUpperCase();
  if (!MARKETS.includes(market)) return fail(40001, "暂不支持该市场", 400);
  if (!/^[A-Z0-9._-]{1,40}$/.test(code)) return fail(40001, "股票代码不合法", 400);

  const { ok: sourceOk, dividends } = await getDividends(market, code);
  return ok({
    market,
    code,
    source: sourceOk ? (market === "CN" ? "eastmoney" : "futu") : "unavailable",
    dividends
  });
}
