import { NextResponse } from "next/server";
import { getAuthUser, isAdmin } from "@/lib/auth";
import { testFutuConnection } from "@/lib/futuQuotes";
import { getSiteSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

/** 富途 OpenD 连接测试（设置 → 交易）：支持传 host/port，未传时用当前已保存配置 */
export async function POST(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!isAdmin(user)) return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });

  const body = await request.json().catch(() => null);
  const saved = getSiteSettings();
  const host =
    typeof body?.host === "string" && body.host.trim()
      ? body.host.trim()
      : saved.futuHost || "127.0.0.1";
  const port = /^\d{1,5}$/.test(String(body?.port ?? ""))
    ? Number(body.port)
    : Number(saved.futuPort) || 11111;
  if (port < 1 || port > 65535) return NextResponse.json({ error: "端口不合法" }, { status: 400 });

  const result = await testFutuConnection(host, port);
  return NextResponse.json(result);
}
