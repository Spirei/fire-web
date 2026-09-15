import { readJsonBody } from "@/lib/requestBody";
import { getAuthUser, isAdmin } from "@/lib/auth";
import { deleteAsset, getAssets, upsertAsset, type AssetType } from "@/lib/assets";
import { getDb } from "@/lib/db";
import { fail, ok, pageMeta, parsePage } from "@/lib/api";

export const dynamic = "force-dynamic";

/** v1 素材库列表（支持 type / q 过滤与统一分页） */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const type = searchParams.get("type") as AssetType | null;
  const all =
    type && ["stock", "market", "flag", "crypto", "metal"].includes(type) ? getAssets(type) : getAssets();
  const q = (searchParams.get("q") ?? "").trim().toUpperCase();
  const filtered = q
    ? all.filter((a) => a.code.toUpperCase().includes(q) || a.name.toUpperCase().includes(q))
    : all;
  const { page, pageSize } = parsePage(searchParams, 10, 100);
  const total = filtered.length;
  return ok(filtered.slice((page - 1) * pageSize, page * pageSize), pageMeta(page, pageSize, total));
}

/** v1 注册 / 更新素材（仅管理员；upsert 幂等，重复上传不堆积） */
export async function POST(request: Request) {
  const user = getAuthUser(request);
  if (!user) return fail(40101, "未登录", 401);
  if (!isAdmin(user)) return fail(40301, "需要管理员权限", 403);
  const body = await readJsonBody(request).catch(() => null);
  if (!body || !["stock", "market", "flag", "crypto", "metal"].includes(body.type)) {
    return fail(40001, "type 必须为 stock / market / flag / crypto / metal", 400);
  }
  const type = body.type as AssetType;
  const market = String(body.market ?? "").trim();
  if ((type === "stock" || type === "market") && !market) {
    return fail(40001, "缺少市场标识", 400);
  }
  if ((type === "flag" || type === "crypto" || type === "metal") && !String(body.code ?? "").trim()) {
    return fail(40001, "资产图标需要代码，如 BTC / GOLD", 400);
  }
  const url = String(body.url ?? "").trim();
  if (type === "stock" && !String(body.code ?? "").trim()) {
    return fail(40001, "股票图标需要股票代码", 400);
  }
  const asset = upsertAsset({
    type,
    market,
    code: String(body.code ?? ""),
    name: String(body.name ?? ""),
    url,
    id: body.id ? String(body.id) : undefined
  });
  if (body.id && typeof body.name === "string" && body.name.trim()) {
    getDb()
      .prepare("UPDATE assets SET name = ?, updated_at = ? WHERE id = ?")
      .run(body.name.trim(), new Date().toISOString(), String(body.id));
  }
  return ok(asset);
}

/** v1 批量删除素材（仅管理员；DELETE /api/v1/assets?id=xxx） */
export async function DELETE(request: Request) {
  const user = getAuthUser(request);
  if (!user) return fail(40101, "未登录", 401);
  if (!isAdmin(user)) return fail(40301, "需要管理员权限", 403);
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  if (!id) return fail(40001, "缺少素材 id", 400);
  deleteAsset(id);
  return ok({ deleted: true });
}
