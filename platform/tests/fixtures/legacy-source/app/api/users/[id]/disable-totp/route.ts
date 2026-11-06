import { readJsonBody } from "@/lib/requestBody";
import { NextResponse } from "next/server";
import { getAuthUser, isAdmin } from "@/lib/auth";
import { clearTotp, userTotpEnabled } from "@/lib/totpAuth";
import { logSecurityEvent } from "@/lib/securityAudit";
import { verifyAdminStepUp } from "@/lib/adminStepUp";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = getAuthUser(request);
  if (!me) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!isAdmin(me)) return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });
  if (!rateLimit(`admin-disable-totp:${clientIp(request)}:${me.id}`, 10, 15 * 60 * 1000) || !rateLimitGlobal("admin-disable-totp", 50, 15 * 60 * 1000)) {
    return NextResponse.json({ error: "尝试过于频繁，请稍后再试" }, { status: 429 });
  }
  const body = await readJsonBody(request, 4 * 1024).catch(() => null);
  const stepUp = verifyAdminStepUp(me.id, body);
  if (!stepUp.ok) {
    logSecurityEvent(request, me.id, "auth.totp.admin_disable_rejected", stepUp.error);
    return NextResponse.json({ error: stepUp.error }, { status: 403 });
  }
  const { id } = await params;
  if (!userTotpEnabled(id)) return NextResponse.json({ error: "该用户未开启二次验证" }, { status: 400 });
  clearTotp(id);
  logSecurityEvent(request, me.id, "auth.totp.admin_disabled", `user=${id}`);
  return NextResponse.json({ ok: true });
}
