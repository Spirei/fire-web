import { NextResponse } from "next/server";
import { getAuthUser, isTrustedMutationRequest } from "@/lib/auth";
import {
  ensureRegistry,
  listShowcaseOptions,
  upsertStoredModel,
  validModelFile,
  validModelId
} from "@/lib/showcaseModels";
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
    })),
    stored: ensureRegistry()
  });
}

/** 保存导入车型的参数（管理员） */
export async function POST(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!isTrustedMutationRequest(request)) return NextResponse.json({ error: "请求来源不可信" }, { status: 403 });
  if (!rateLimit(`showcase-model-save:${clientIp(request)}`, 60, 60 * 60 * 1000)) {
    return NextResponse.json({ error: "操作过于频繁，请稍后再试" }, { status: 429 });
  }
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "请求格式不正确" }, { status: 400 });
  }
  const id = String(body.id ?? "").trim().toLowerCase();
  const file = String(body.file ?? "").trim();
  if (!validModelId(id)) return NextResponse.json({ error: "车型代号只能用 a-z、0-9、-、_（2-40 位）" }, { status: 400 });
  if (!validModelFile(file)) return NextResponse.json({ error: "素材文件名不合法（只支持 .glb）" }, { status: 400 });
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
