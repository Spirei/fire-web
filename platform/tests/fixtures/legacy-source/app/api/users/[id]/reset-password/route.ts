import { readJsonBody } from "@/lib/requestBody";
import { NextResponse } from "next/server";
import { deleteOtherSessions, getAuthUser, isAdmin, resetUserPassword } from "@/lib/auth";
import { clearTotp } from "@/lib/totpAuth";
import { validatePassword } from "@/lib/password";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";
import { logSecurityEvent } from "@/lib/securityAudit";
import { verifyAdminStepUp } from "@/lib/adminStepUp";
import { getDb } from "@/lib/db";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = getAuthUser(request);
  if (!me) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!isAdmin(me)) return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });
  if (!rateLimit(`admin-reset-password:${clientIp(request)}:${me.id}`, 10, 15 * 60 * 1000) || !rateLimitGlobal("admin-reset-password", 50, 15 * 60 * 1000)) return NextResponse.json({ error: "尝试过于频繁，请稍后再试" }, { status: 429 });

  const { id } = await params;
  const body = await readJsonBody(request).catch(() => null);
  const newPassword = String(body?.newPassword ?? "");
  const pwdErr = validatePassword(newPassword);
  if (pwdErr) {
    return NextResponse.json({ error: pwdErr }, { status: 400 });
  }
  const stepUp = verifyAdminStepUp(me.id, body);
  if (!stepUp.ok) {
    logSecurityEvent(request, me.id, "admin.password_reset_rejected", stepUp.error);
    return NextResponse.json({ error: stepUp.error }, { status: 403 });
  }
  const ok = getDb().transaction(() => {
    if (!resetUserPassword(id, newPassword)) return false;
    clearTotp(id);
    deleteOtherSessions(id, null);
    getDb().prepare("DELETE FROM passkeys WHERE user_id=?").run(id);
    getDb().prepare("DELETE FROM passkey_challenges WHERE user_id=?").run(id);
    return true;
  })();
  if (!ok) return NextResponse.json({ error: "用户不存在" }, { status: 404 });
  logSecurityEvent(request, me.id, "admin.password_reset", `user=${id}`);
  return NextResponse.json({ ok: true, totpDisabled: true, passkeysRevoked: true });
}
