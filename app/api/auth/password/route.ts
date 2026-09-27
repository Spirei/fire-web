import { readJsonBody } from "@/lib/requestBody";
import { NextResponse } from "next/server";
import { deleteOtherSessions, findUserById, getAuthUser, getSessionToken, updatePassword } from "@/lib/auth";
import { consumeTotpFactor, userTotpEnabled } from "@/lib/totpAuth";
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

  const body = await readJsonBody(request, 16 * 1024).catch(() => null);
  if (!body) return NextResponse.json({ error: "无效的请求体" }, { status: 400 });

  const oldPassword = String(body.oldPassword ?? "");
  const newPassword = String(body.newPassword ?? "");
  const signOutOthers = body.signOutOthers !== false;
  const row = findUserById(user.id);
  const sessionToken = getSessionToken(request);
  if (!row || !verifyPassword(oldPassword, row.password_hash)) {
    logSecurityEvent(request, user.id, "password_change_rejected", "old password mismatch");
    return NextResponse.json({ error: "原密码错误" }, { status: 400 });
  }
  if (userTotpEnabled(user.id) && !consumeTotpFactor(user.id, String(body.code ?? ""))) {
    logSecurityEvent(request, user.id, "password_change_rejected", "totp mismatch");
    return NextResponse.json({ error: "二次验证失败" }, { status: 400 });
  }
  const pwdErr = validatePassword(newPassword);
  if (pwdErr) {
    return NextResponse.json({ error: pwdErr }, { status: 400 });
  }

  updatePassword(user.id, newPassword);
  if (signOutOthers) deleteOtherSessions(user.id, sessionToken);
  logSecurityEvent(request, user.id, "password_change", `password verified; ${signOutOthers ? "other sessions revoked" : "other sessions preserved"}`);
  return NextResponse.json({ ok: true, signedOutOthers: signOutOthers }, { headers: { "Cache-Control": "no-store" } });
}
