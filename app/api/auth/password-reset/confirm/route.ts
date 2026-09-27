import { NextResponse } from "next/server";
import { deleteOtherSessions, isTrustedMutationRequest, updatePassword } from "@/lib/auth";
import { validatePassword } from "@/lib/password";
import { consumePasswordResetToken } from "@/lib/passwordReset";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";
import { readJsonBody } from "@/lib/requestBody";
import { logSecurityEvent } from "@/lib/securityAudit";

export async function POST(request: Request) {
  if (!isTrustedMutationRequest(request)) return NextResponse.json({ error: "请求来源不受信任" }, { status: 403 });
  const ip = clientIp(request);
  if (!rateLimit(`password-reset-confirm:${ip}`, 10, 15 * 60 * 1000) || !rateLimitGlobal("password-reset-confirm", 120, 15 * 60 * 1000)) {
    return NextResponse.json({ error: "尝试过于频繁，请稍后再试" }, { status: 429 });
  }
  const body = await readJsonBody(request, 16 * 1024).catch(() => null);
  const token = String(body?.token ?? "");
  const newPassword = String(body?.newPassword ?? "");
  const passwordError = validatePassword(newPassword);
  if (passwordError) return NextResponse.json({ error: passwordError }, { status: 400 });
  const userId = consumePasswordResetToken(token, id => {
    updatePassword(id, newPassword);
    deleteOtherSessions(id, null);
  });
  if (!userId) return NextResponse.json({ error: "链接无效或已过期，请重新申请" }, { status: 400 });
  logSecurityEvent(request, userId, "password_reset", "email token verified; all sessions revoked");
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
