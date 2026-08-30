import { getAuthUser } from "@/lib/auth";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";
import { fail, ok } from "@/lib/api";
import { createWatchGroup, listWatchGroups } from "@/lib/watchGroupsStore";

export const dynamic = "force-dynamic";

/** v1 自选股分组：列表（自动播种市场分组 + 迁移旧数据） */
export async function GET(request: Request) {
  const user = getAuthUser(request);
  if (!user) return fail(40101, "未登录", 401);
  if (!rateLimit(`watch-groups:${clientIp(request)}`, 120, 60 * 1000) || !rateLimitGlobal("watch-groups", 300, 60 * 1000)) {
    return fail(42901, "请求过于频繁，请稍后再试", 429);
  }
  try {
    return ok({ groups: listWatchGroups(user.id) });
  } catch {
    return fail(50001, "获取分组失败", 500);
  }
}

/** v1 自选股分组：新建自定义分组 */
export async function POST(request: Request) {
  const user = getAuthUser(request);
  if (!user) return fail(40101, "未登录", 401);
  if (!rateLimit(`watch-groups:${clientIp(request)}`, 60, 60 * 1000) || !rateLimitGlobal("watch-groups", 300, 60 * 1000)) {
    return fail(42901, "请求过于频繁，请稍后再试", 429);
  }
  const body = await request.json().catch(() => null);
  const name = String(body?.name ?? "").trim();
  if (!name) return fail(40001, "缺少分组名称", 400);
  try {
    return ok({ group: createWatchGroup(user.id, name) }, undefined);
  } catch (err) {
    return fail(40901, err instanceof Error ? err.message : "创建分组失败", 409);
  }
}
