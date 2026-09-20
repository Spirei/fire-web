import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/requestBody";
import { getAuthUser, isAdmin, isTrustedMutationRequest } from "@/lib/auth";
import { ensureRegistry, listShowcaseOptions, upsertStoredModel, validModelFile, validModelId } from "@/lib/showcaseModels";
import { clientIp, rateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

/** 车型清单：内置 + 手动导入（公开，首页要用） */
export async function GET() {
  return NextResponse.json({
    models: listShowcaseOptions().map((item) => ({
      id: item.id,
      label: item.label,
      note: item.note,
      builtin: item.builtin,
      present: item.present,
      config: item.config
    }))
  });
}

/** 保存导入车型的参数（管理员） */
export async function POST(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  // 车型条是首页对外的公共内容：改动一律限管理员（与素材库 / 名人 / 站点设置一致）
  if (!isAdmin(user)) return NextResponse.json({ error: "只有管理员能改车型" }, { status: 403 });
  if (!isTrustedMutationRequest(request)) return NextResponse.json({ error: "请求来源不可信" }, { status: 403 });
  if (!rateLimit(`showcase-model-save:${clientIp(request)}`, 60, 60 * 60 * 1000)) {
    return NextResponse.json({ error: "操作过于频繁，请稍后再试" }, { status: 429 });
  }
  // 请求体封顶 256KB：车型参数只有几十个字段，解析前先拦住超大 body
  let body: Record<string, unknown>;
  try {
    body = ((await readJsonBody(request, 256 * 1024)) ?? {}) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "请求格式不正确" }, { status: 400 });
  }
  const id = String(body.id ?? "").trim().toLowerCase();
  const file = String(body.file ?? "").trim();
  if (!validModelId(id)) return NextResponse.json({ error: "车型代号只能用 a-z、0-9、-、_（2-40 位）" }, { status: 400 });
  if (!validModelFile(file)) return NextResponse.json({ error: "素材文件名不合法（只支持 .glb）" }, { status: 400 });
  if (ensureRegistry().some((item) => item.id === id)) {
    return NextResponse.json({ error: "车型代号已存在；请换一个代号，或在车型清单中点“改参数”" }, { status: 409 });
  }
  try {
    const entry = upsertStoredModel({
      id,
      label: String(body.label ?? ""),
      note: String(body.note ?? ""),
      file,
      params: body.params as Record<string, unknown>
    });
    return NextResponse.json({ model: entry });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "保存失败" }, { status: 400 });
  }
}
