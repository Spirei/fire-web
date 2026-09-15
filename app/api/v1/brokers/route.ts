import { readJsonBody } from "@/lib/requestBody";
import { NextRequest } from "next/server";
import { getAuthUser, isAdmin } from "@/lib/auth";
import { getBrokers, saveBrokers, type Broker } from "@/lib/brokers";
import { deleteAsset, getAssets } from "@/lib/assets";
import { fail, ok } from "@/lib/api";
import { getSiteSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

/**
 * 券商（Broker）v1 接口 —— 供 iOS / Android 客户端读取与维护券商列表。
 * 数据模型：{ id, name, icon }，详见 docs/api-spec.md「券商 Brokers」章节。
 */

/** 券商列表（登录即可读） */
export async function GET(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) return fail(40101, "未登录", 401);
  return ok(getBrokers());
}

/** 全量保存券商列表（仅管理员；覆盖式，顺序即展示顺序） */
export async function POST(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) return fail(40101, "未登录", 401);
  if (!isAdmin(user)) return fail(40301, "需要管理员权限", 403);
  const body = await readJsonBody(request).catch(() => null);
  if (!body || !Array.isArray(body.groups)) {
    return fail(40001, "groups 必须为券商数组 [{ id, name }]", 400);
  }
  const seen = new Set<string>();
  const groups = body.groups
    .filter(
      (g: unknown): g is { id: string; name: string; alias?: string } =>
        !!g &&
        typeof (g as { id?: unknown }).id === "string" &&
        typeof (g as { name?: unknown }).name === "string" &&
        ((g as { alias?: unknown }).alias === undefined || typeof (g as { alias?: unknown }).alias === "string")
    )
    .filter((g: { id: string; name: string; alias?: string }) => {
      const id = g.id.trim().toLowerCase();
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .map((g: { id: string; name: string; alias?: string }) => ({
      id: g.id.trim().toLowerCase(),
      name: g.name.trim() || "未命名券商",
      alias: typeof g.alias === "string" && g.alias.trim() ? g.alias.trim() : undefined
    }));
  const brokers: Broker[] = saveBrokers(groups);
  return ok(brokers);
}

/** 删除券商（仅管理员；DELETE /api/v1/brokers?id=xxx，同时清空对应持仓记录的券商并删除图标素材） */
export async function DELETE(request: NextRequest) {
  const user = getAuthUser(request);
  if (!user) return fail(40101, "未登录", 401);
  if (!isAdmin(user)) return fail(40301, "需要管理员权限", 403);
  const { searchParams } = new URL(request.url);
  const id = String(searchParams.get("id") ?? "").trim().toLowerCase();
  if (!id) return fail(40001, "缺少券商 id", 400);
  const current = getSiteSettings().groups;
  if (!current.some((g) => g.id.toLowerCase() === id)) return fail(40401, "券商不存在", 404);
  const next = current.filter((g) => g.id.toLowerCase() !== id);
  const brokers: Broker[] = saveBrokers(next);
  // 删除该券商的素材图标（assets 行 + 本地文件）
  getAssets()
    .filter((a) => a.type === "broker" && a.code.toLowerCase() === id)
    .forEach((a) => deleteAsset(a.id));
  return ok(brokers);
}
