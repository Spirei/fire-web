import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { buildBackupPayload } from "@/lib/dataTransfer";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";
import { logSecurityEvent } from "@/lib/securityAudit";

export const dynamic = "force-dynamic";

/** v1 网站数据导出：返回可直接保存的 fire-site-backup JSON（版本化；按当前用户作用域，管理员额外含站点设置/名人持仓） */
export async function GET(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!rateLimit(`data-export:${clientIp(request)}:${user.id}`, 20, 60 * 60 * 1000) || !rateLimitGlobal("data-export", 200, 60 * 60 * 1000)) {
    return NextResponse.json({ error: "导出过于频繁，请稍后再试" }, { status: 429 });
  }
  try {
    const payload = buildBackupPayload(user.id, user.role === "admin");
    logSecurityEvent(request, user.id, "data_export", JSON.stringify(payload.manifest.counts));
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store, private", Pragma: "no-cache", "X-Content-Type-Options": "nosniff" } });
  } catch {
    return NextResponse.json({ error: "导出失败" }, { status: 500 });
  }
}
