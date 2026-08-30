import { searchStocks } from "@/lib/quotes";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";
import { fail, ok } from "@/lib/api";

/** v1 股票搜索（?q=关键词，限 50 字符） */
export async function GET(request: Request) {
  if (!rateLimit(`search:${clientIp(request)}`, 60, 60 * 1000) || !rateLimitGlobal("search", 300, 60 * 1000)) {
    return fail(42901, "请求过于频繁，请稍后再试", 429);
  }
  const q = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  if (!q) return ok({ results: [] });
  if (q.length > 50) return fail(40001, "搜索关键词过长", 400);
  try {
    return ok({ results: await searchStocks(q) });
  } catch {
    return fail(50002, "搜索失败，请稍后重试", 502);
  }
}
