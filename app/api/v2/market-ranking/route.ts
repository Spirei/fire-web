import { fail, ok } from "@/lib/api";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";
import { RANKING_MARKETS, volumeRanking, type RankingMarket } from "@/lib/marketVolumeRanking";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  if (!rateLimit(`volume-ranking:${clientIp(request)}`, 60, 60000) || !rateLimitGlobal("volume-ranking", 300, 60000)) return fail(42901, "请求过于频繁，请稍后再试", 429);
  const market = new URL(request.url).searchParams.get("market") as RankingMarket;
  if (!RANKING_MARKETS.includes(market)) return fail(40001, "不支持的排行市场", 400);
  try { return ok(await volumeRanking(market)); } catch { return fail(50002, "成交量榜暂时不可用", 502); }
}
