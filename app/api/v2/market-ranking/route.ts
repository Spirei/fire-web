import { fail, ok } from "@/lib/api";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";
import { RANKING_MARKETS, volumeRanking, type RankingMarket } from "@/lib/marketVolumeRanking";
import { amountRanking } from "@/lib/marketAmountRanking";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  if (!rateLimit(`volume-ranking:${clientIp(request)}`, 60, 60000) || !rateLimitGlobal("volume-ranking", 300, 60000)) return fail(42901, "请求过于频繁，请稍后再试", 429);
  const params = new URL(request.url).searchParams;
  const market = params.get("market") as RankingMarket;
  const metric = params.get("metric") ?? "volume";
  if (!RANKING_MARKETS.includes(market)) return fail(40001, "不支持的排行市场", 400);
  if (metric !== "volume" && metric !== "amount") return fail(40001, "不支持的排行指标", 400);
  try { return ok(metric === "amount" ? await amountRanking(market) : await volumeRanking(market)); }
  catch { return fail(50002, metric === "amount" ? "热门股票暂时不可用" : "成交量榜暂时不可用", 502); }
}
