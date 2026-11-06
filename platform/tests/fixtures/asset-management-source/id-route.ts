import { readJsonBody } from "@/lib/requestBody";
import { getAuthUser, isAdmin } from "@/lib/auth";
import { deleteAsset } from "@/lib/assets";
import { getDb } from "@/lib/db";
import { fail, ok } from "@/lib/api";

/** v1 素材重命名（仅管理员） */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = getAuthUser(request);
  if (!user) return fail(40101, "未登录", 401);
  if (!isAdmin(user)) return fail(40301, "需要管理员权限", 403);
  const { id } = await params;
  const body = await readJsonBody(request).catch(() => null);
  const name = String(body?.name ?? "").trim();
  if (!name) return fail(40001, "缺少素材名称", 400);
  const result = getDb()
    .prepare("UPDATE assets SET name = ?, updated_at = ? WHERE id = ?")
    .run(name, new Date().toISOString(), id);
  if (result.changes === 0) return fail(40401, "素材不存在", 404);
  return ok({ id, name });
}

/** v1 删除素材（仅管理员） */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = getAuthUser(_request);
  if (!user) return fail(40101, "未登录", 401);
  if (!isAdmin(user)) return fail(40301, "需要管理员权限", 403);
  const { id } = await params;
  deleteAsset(id);
  return ok({ deleted: true });
}
