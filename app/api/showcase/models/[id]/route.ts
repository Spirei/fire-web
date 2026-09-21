import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/requestBody";
import { getAuthUser, isAdmin, isTrustedMutationRequest } from "@/lib/auth";
import { ensureRegistry, setModelHidden, removeStoredModel, sanitizeParams, upsertStoredModel, validModelId } from "@/lib/showcaseModels";
import { clientIp, rateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

function guard(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  // 改参数 / 删除车型（连素材一起删）会影响首页对外的车型条：限管理员
  if (!isAdmin(user)) return NextResponse.json({ error: "只有管理员能改车型" }, { status: 403 });
  if (!isTrustedMutationRequest(request)) return NextResponse.json({ error: "请求来源不可信" }, { status: 403 });
  if (!rateLimit(`showcase-model-edit:${clientIp(request)}`, 60, 60 * 60 * 1000)) {
    return NextResponse.json({ error: "操作过于频繁，请稍后再试" }, { status: 429 });
  }
  return null;
}

/** 改车型名称 / 年份 / 渲染参数（重新摆正、换轮子材质、改车长都走这里） */
export async function PUT(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const blocked = guard(request);
  if (blocked) return blocked;
  const { id } = await ctx.params;
  if (!validModelId(id)) return NextResponse.json({ error: "车型不存在" }, { status: 404 });
  const existing = ensureRegistry().find((item) => item.id === id);
  if (!existing) return NextResponse.json({ error: "车型不存在（内置车型不能改参数）" }, { status: 404 });
  let body: Record<string, unknown>;
  try {
    body = ((await readJsonBody(request, 256 * 1024)) ?? {}) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "请求格式不正确" }, { status: 400 });
  }
  try {
    const entry = upsertStoredModel({
      id,
      label: String(body.label ?? existing.label),
      note: String(body.note ?? existing.note),
      file: existing.file,
      params: body.params === undefined ? existing.params : sanitizeParams(body.params)
    });
    return NextResponse.json({ model: entry });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "保存失败" }, { status: 400 });
  }
}

/** 删除车型；?file=1 时连 uploads 卷里的 glb 一起删掉 */
export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const blocked = guard(request);
  if (blocked) return blocked;
  const { id } = await ctx.params;
  const withFile = new URL(request.url).searchParams.get("file") === "1";
  try {
    const entry = removeStoredModel(id, { deleteFile: withFile });
    return NextResponse.json({ removed: entry.id, fileDeleted: withFile });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "删除失败" }, { status: 400 });
  }
}

/** 首页显隐；隐藏车型不进入首页清单和预载。 */
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const blocked = guard(request);
  if (blocked) return blocked;
  const { id } = await ctx.params;
  if (!validModelId(id)) return NextResponse.json({ error: "车型不存在" }, { status: 404 });
  try {
    const body = await readJsonBody(request, 1024) as { hidden?: unknown } | null;
    if (typeof body?.hidden !== "boolean") return NextResponse.json({ error: "hidden 必须是布尔值" }, { status: 400 });
    return NextResponse.json(setModelHidden(id, body.hidden));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "保存失败" }, { status: 400 });
  }
}
