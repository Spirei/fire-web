import { readJsonBody } from "@/lib/requestBody";
import { NextResponse } from "next/server";
import { getAuthUser, isAdmin } from "@/lib/auth";
import { fetchFutuQuota } from "@/lib/futuQuotes";
import { getSiteSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

/** 富途 OpenAPI 额度查询（设置 → 交易）：实时订阅与历史K线 已用 / 总额度 */
export async function POST(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!isAdmin(user)) return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });

  const body = await readJsonBody(request).catch(() => null);
  const saved = getSiteSettings();
  const host =
    typeof body?.host === "string" && body.host.trim()
      ? body.host.trim()
      : saved.futuHost || "127.0.0.1";
  const port = /^\d{1,5}$/.test(String(body?.port ?? ""))
    ? Number(body.port)
    : Number(saved.futuPort) || 11111;
  if (port < 1 || port > 65535) return NextResponse.json({ error: "端口不合法" }, { status: 400 });

  const quota = await fetchFutuQuota(host, port);
  return NextResponse.json({ ok: !!quota, quota });
}
