import { NextResponse } from "next/server";
import { getAuthUser, isTrustedMutationRequest } from "@/lib/auth";
import { ensureRegistry, removeStoredModel, sanitizeParams, upsertStoredModel, validModelId } from "@/lib/showcaseModels";

export const dynamic = "force-dynamic";

function guard(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!isTrustedMutationRequest(request)) return NextResponse.json({ error: "请求来源不可信" }, { status: 403 });
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
    body = (await request.json()) as Record<string, unknown>;
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
