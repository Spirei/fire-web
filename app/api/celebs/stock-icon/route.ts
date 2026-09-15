import { readJsonBody } from "@/lib/requestBody";
import { NextResponse } from "next/server";
import { getAuthUser, isAdmin } from "@/lib/auth";
import { getCelebRow, updateCeleb } from "@/lib/celebsStore";
import { patchCelebCache } from "@/lib/celebsData";

export const dynamic = "force-dynamic";

/* 名人专属股票图标：上传后立即持久化（celebs.stock_icons_json），无需再点「保存」，并同步前台圆环 */
export async function POST(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!isAdmin(user)) return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });

  const body = await readJsonBody(request).catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "无效的请求体" }, { status: 400 });
  const id = String(body.id ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 40);
  const code = String(body.code ?? "")
    .trim()
    .toUpperCase()
    .slice(0, 20);
  const url = String(body.url ?? "").trim();
  if (!id || !code || !url) return NextResponse.json({ error: "缺少 id / code / url" }, { status: 400 });

  const row = getCelebRow(id);
  if (!row) return NextResponse.json({ error: "名人不存在" }, { status: 404 });

  const stockIcons = { ...(row.stockIcons ?? {}), [code]: url };
  updateCeleb(id, { stockIcons });
  patchCelebCache(id);
  return NextResponse.json({ ok: true, stockIcons });
}
