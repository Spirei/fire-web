import { getAuthUser } from "@/lib/auth";
import { fail, ok } from "@/lib/api";
import { reorderGroupRecords } from "@/lib/watchGroupsStore";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const user = getAuthUser(request);
  if (!user) return fail(40101, "未登录", 401);
  const body = await request.json().catch(() => null);
  const groupId = typeof body?.groupId === "string" ? body.groupId.trim() : "";
  const ids = Array.isArray(body?.ids) ? body.ids.filter((id: unknown): id is string => typeof id === "string" && id.length > 0) : [];
  if (!groupId || ids.length > 2000) return fail(40001, "排序参数无效", 400);
  try {
    return ok({ updated: reorderGroupRecords(user.id, groupId, ids) });
  } catch (error) {
    return fail(40001, error instanceof Error ? error.message : "排序失败", 400);
  }
}
