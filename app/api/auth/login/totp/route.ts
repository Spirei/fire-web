import { readJsonBody } from "@/lib/requestBody";
import { NextResponse } from "next/server";
import { applySessionCookie, createSession, findUserById, sessionCookieMaxAge } from "@/lib/auth";
import { completeLoginTicket } from "@/lib/totpAuth";
import { clientIp, rateLimit } from "@/lib/rateLimit";
import { logSecurityEvent } from "@/lib/securityAudit";

export async function POST(request: Request) {
  if (!rateLimit(`login-totp:${clientIp(request)}`, 40, 15 * 60 * 1000)) {
    return NextResponse.json({ error: "尝试过于频繁，请稍后再试" }, { status: 429 });
  }
  const body = await readJsonBody(request, 8 * 1024).catch(() => null);
  if (!body) return NextResponse.json({ error: "无效的请求体" }, { status: 400 });
  const ticket = String(body.ticket ?? "");
  const code = String(body.code ?? "");
  const result = completeLoginTicket(ticket, code);
  if (!result.ok || !result.userId) {
    logSecurityEvent(request, "", "auth.login.totp_failed", result.error || "二次验证失败");
    return NextResponse.json({ error: result.error || "验证码不正确" }, { status: 401 });
  }
  const userRow = findUserById(result.userId);
  if (!userRow) return NextResponse.json({ error: "验证已失效，请重新登录" }, { status: 401 });
  const token = createSession(userRow.id);
  logSecurityEvent(request, userRow.id, "auth.login.success", "网页二次验证登录成功");
  const res = NextResponse.json({
    user: { id: userRow.id, username: userRow.username },
    expiresIn: sessionCookieMaxAge()
  }, { headers: { "Cache-Control": "no-store" } });
  applySessionCookie(res, token, request);
  return res;
}
