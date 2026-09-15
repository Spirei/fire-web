import { readJsonBody } from "@/lib/requestBody";
import { getAuthUser } from "@/lib/auth";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";
import { fail, ok } from "@/lib/api";
import { reorderWatchGroups } from "@/lib/watchGroupsStore";

export const dynamic = "force-dynamic";

/** v1 自选股分组：整体排序（body: { order: string[] }，按 id 顺序写入 sort） */
export async function POST(request: Request) {
  const user = getAuthUser(request);
  if (!user) return fail(40101, "未登录", 401);
  if (!rateLimit(`watch-groups:${clientIp(request)}`, 60, 60 * 1000) || !rateLimitGlobal("watch-groups", 300, 60 * 1000)) {
    return fail(42901, "请求过于频繁，请稍后再试", 429);
  }
  const body = await readJsonBody(request).catch(() => null);
  const order: string[] = Array.isArray(body?.order)
    ? [...new Set<string>((body.order as unknown[]).filter((x: unknown): x is string => typeof x === "string" && x.length > 0 && x.length <= 100))]
    : [];
  if (order.length === 0) return fail(40001, "缺少分组顺序", 400);
  if (order.length > 100) return fail(40001, "分组数量超出限制", 400);
  try {
    const updated = reorderWatchGroups(user.id, order);
    return ok({ updated });
  } catch {
    return fail(50001, "保存排序失败", 500);
  }
}
