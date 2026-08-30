import { getAuthUser } from "@/lib/auth";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";
import { fail, ok } from "@/lib/api";
import { deleteWatchGroup, updateWatchGroup } from "@/lib/watchGroupsStore";

export const dynamic = "force-dynamic";

/** v1 自选股分组：更新（重命名 / 图标 / 显隐） */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = getAuthUser(request);
  if (!user) return fail(40101, "未登录", 401);
  if (!rateLimit(`watch-groups:${clientIp(request)}`, 60, 60 * 1000) || !rateLimitGlobal("watch-groups", 300, 60 * 1000)) {
    return fail(42901, "请求过于频繁，请稍后再试", 429);
  }
  const { id } = await params;
  const body = await request.json().catch(() => null);
  const input: { name?: string; icon?: string; visible?: number } = {};
  if (body?.name !== undefined) input.name = String(body.name);
  if (body?.icon !== undefined) {
    const icon = String(body.icon).trim();
    if (icon.length > 2048 || (icon && !/^\/uploads\//.test(icon) && !/^https:\/\//i.test(icon))) {
      return fail(40001, "分组图标地址不合法", 400);
    }
    input.icon = icon;
  }
  if (body?.visible !== undefined) {
    const visible = Number(body.visible);
    if (![-1, 0, 1].includes(visible)) return fail(40001, "visible 必须为 -1 / 0 / 1", 400);
    input.visible = visible;
  }
  try {
    return ok({ group: updateWatchGroup(user.id, id, input) });
  } catch (err) {
    return fail(40901, err instanceof Error ? err.message : "更新分组失败", 409);
  }
}

/** v1 自选股分组：删除自定义分组（清空记录归属 + 素材图标） */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = getAuthUser(request);
  if (!user) return fail(40101, "未登录", 401);
  if (!rateLimit(`watch-groups:${clientIp(request)}`, 60, 60 * 1000) || !rateLimitGlobal("watch-groups", 300, 60 * 1000)) {
    return fail(42901, "请求过于频繁，请稍后再试", 429);
  }
  const { id } = await params;
  try {
    const okDeleted = deleteWatchGroup(user.id, id);
    return ok({ deleted: okDeleted });
  } catch (err) {
    return fail(40001, err instanceof Error ? err.message : "删除分组失败", 400);
  }
}
