import fs from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { getAuthUser, isAdmin } from "@/lib/auth";
import { inspectGlb } from "@/lib/glbInspect";
import { MODELS_DIR, readStoredModels, validModelId } from "@/lib/showcaseModels";
import { SHOWCASE_MODELS } from "@/components/showcase/presets/models";
import { clientIp, rateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

/** Read-only inspection of an already saved model; never materializes a second copy. */
export async function GET(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!isAdmin(user)) return NextResponse.json({ error: "只有管理员能查看模型体检" }, { status: 403 });
  if (!rateLimit(`showcase-inspect:${clientIp(request)}`, 20, 60 * 60 * 1000)) return NextResponse.json({ error: "检查过于频繁，请稍后再试" }, { status: 429 });
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!validModelId(id)) return NextResponse.json({ error: "车型不存在" }, { status: 404 });
  const stored = readStoredModels().find((item) => item.id === id);
  const builtin = SHOWCASE_MODELS.find((item) => item.id === id);
  if (!stored && !builtin) return NextResponse.json({ error: "车型不存在" }, { status: 404 });
  const source = stored ? path.join(MODELS_DIR, stored.file) : path.join(process.cwd(), "public", builtin!.config.assets.model.split("?")[0].replace(/^\/+/, ""));
  if (!fs.existsSync(source)) return NextResponse.json({ error: "原件缺失" }, { status: 404 });
  try { return NextResponse.json({ report: await inspectGlb(source, stored?.file ?? builtin!.label) }); }
  catch (cause) { return NextResponse.json({ error: cause instanceof Error ? cause.message : "模型体检失败" }, { status: 422 }); }
}
