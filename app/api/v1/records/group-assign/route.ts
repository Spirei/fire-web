import { getAuthUser } from "@/lib/auth";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";
import { fail, ok } from "@/lib/api";
import { assignRecordsGroup } from "@/lib/watchGroupsStore";

export const dynamic = "force-dynamic";

/** v1 批量分配 / 移出分组：body { ids: string[], groupId: string }（groupId 空串 = 移出分组） */
export async function POST(request: Request) {
  const user = getAuthUser(request);
  if (!user) return fail(40101, "未登录", 401);
  if (!rateLimit(`group-assign:${clientIp(request)}`, 60, 60 * 1000) || !rateLimitGlobal("group-assign", 300, 60 * 1000)) {
    return fail(42901, "请求过于频繁，请稍后再试", 429);
  }
  const body = await request.json().catch(() => null);
  const ids: string[] = Array.isArray(body?.ids)
    ? [...new Set<string>((body.ids as unknown[]).filter((x: unknown): x is string => typeof x === "string" && x.length > 0 && x.length <= 100))]
    : [];
  if (ids.length === 0) return fail(40001, "缺少记录 id", 400);
  if (ids.length > 2000) return fail(40001, "单次最多分配 2000 条记录", 400);
  const groupId = String(body?.groupId ?? "").trim();
  try {
    const updated = assignRecordsGroup(user.id, ids, groupId);
    return ok({ updated });
  } catch (err) {
    return fail(40001, err instanceof Error ? err.message : "分配分组失败", 400);
  }
}
