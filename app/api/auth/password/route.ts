import { NextResponse } from "next/server";
import { deleteOtherSessions, findUserById, getAuthUser, getCookie, LEGACY_SESSION_COOKIE, SESSION_COOKIE, updatePassword } from "@/lib/auth";
import { validatePassword, verifyPassword } from "@/lib/password";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";
import { logSecurityEvent } from "@/lib/securityAudit";

export async function POST(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  // 改密限流：同 IP 15 分钟最多 10 次尝试
  if (!rateLimit(`pwd:${clientIp(request)}:${user.id}`, 20, 15 * 60 * 1000)) {
    return NextResponse.json({ error: "尝试过于频繁，请稍后再试" }, { status: 429 });
  }
  if (!rateLimitGlobal("pwd", 100, 15 * 60 * 1000)) {
    return NextResponse.json({ error: "尝试过于频繁，请稍后再试" }, { status: 429 });
  }

  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "无效的请求体" }, { status: 400 });

  const oldPassword = String(body.oldPassword ?? "");
  const newPassword = String(body.newPassword ?? "");
  const row = findUserById(user.id);
  if (!row || !verifyPassword(oldPassword, row.password_hash)) {
    logSecurityEvent(request, user.id, "password_change_rejected", "old password mismatch");
    return NextResponse.json({ error: "原密码错误" }, { status: 400 });
  }
  const pwdErr = validatePassword(newPassword);
  if (pwdErr) {
    return NextResponse.json({ error: pwdErr }, { status: 400 });
  }

  updatePassword(user.id, newPassword);
  // 修改密码后踢掉其它登录会话，防止被盗会话继续使用
  deleteOtherSessions(user.id, getCookie(request, SESSION_COOKIE) || getCookie(request, LEGACY_SESSION_COOKIE));
  logSecurityEvent(request, user.id, "password_change", "other sessions revoked");
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
