import { fetchIndices } from "@/lib/quotes";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";
import { fail, ok } from "@/lib/api";

/** v1 全球指数（分市场分组） */
export async function GET(request: Request) {
  if (!rateLimit(`indices:${clientIp(request)}`, 60, 60 * 1000) || !rateLimitGlobal("indices", 300, 60 * 1000)) {
    return fail(42901, "请求过于频繁，请稍后再试", 429);
  }
  try {
    return ok({ groups: await fetchIndices() });
  } catch {
    return fail(50002, "指数获取失败，请稍后重试", 502);
  }
}
