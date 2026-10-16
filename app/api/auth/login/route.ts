import { credentials, readAuthObject } from "@/lib/authInput";
import { AuthBudgetError, authBudgetHeaders, authenticationBurst } from "@/lib/authAbuse";
import { NextResponse } from "next/server";
import { applySessionCookie, authenticateUser, createSession, isTrustedMutationRequest, sessionCookieMaxAge } from "@/lib/auth";
import { createLoginTicket, userTotpEnabled } from "@/lib/totpAuth";
import { clientIp, loginIdentityKey, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";
import { logSecurityEvent } from "@/lib/securityAudit";

export async function POST(request: Request) {
  if (!isTrustedMutationRequest(request)) return NextResponse.json({ error: "请求来源不受信任" }, { status: 403, headers: { "Cache-Control": "no-store" } });
  try { authenticationBurst(request); }
  catch (error) {
    if (!(error instanceof AuthBudgetError)) throw error;
    return NextResponse.json({ error: error.message }, { status: error.unavailable ? 503 : 429, headers: authBudgetHeaders(error) });
  }
  // 登录限流：同 IP 15 分钟最多 50 次尝试，防暴力破解（全局 100 次/15 分钟兜底）
  if (!rateLimit(`login:${clientIp(request)}`, 50, 15 * 60 * 1000)) {
    logSecurityEvent(request, "", "auth.login.rate_limited", "IP 登录尝试过于频繁");
    return NextResponse.json({ error: "尝试过于频繁，请 15 分钟后再试" }, { status: 429, headers: { "Retry-After": "900", "Cache-Control": "no-store" } });
  }
  // 全局预算：即使伪造 X-Forwarded-For 也无法无限尝试
  if (!rateLimitGlobal("login", 100, 15 * 60 * 1000)) {
    logSecurityEvent(request, "", "auth.login.rate_limited", "全局登录尝试过于频繁");
    return NextResponse.json({ error: "尝试过于频繁，请稍后再试" }, { status: 429, headers: { "Retry-After": "900", "Cache-Control": "no-store" } });
  }
  const input = credentials(await readAuthObject(request, ["username", "password"]));
  if (!input) return NextResponse.json({ error: "用户名或密码错误" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  const { username, password } = input;
  if (!rateLimit(`login-account:${loginIdentityKey(username)}`, 20, 15 * 60 * 1000)) {
    logSecurityEvent(request, "", "auth.login.rate_limited", "账号登录尝试过于频繁");
    return NextResponse.json({ error: "尝试过于频繁，请 15 分钟后再试" }, { status: 429, headers: { "Retry-After": "900", "Cache-Control": "no-store" } });
  }
  const userRow = authenticateUser(username, password);

  if (!userRow) {
    logSecurityEvent(request, "", "auth.login.failed", "身份或凭证未通过核验");
    return NextResponse.json({ error: "用户名或密码错误" }, { status: 401 });
  }

  if (userTotpEnabled(userRow.id)) {
    const ticket = createLoginTicket(userRow.id);
    logSecurityEvent(request, userRow.id, "auth.login.totp_required", "网页登录需要二次验证");
    return NextResponse.json({ requires2fa: true, ticket }, { headers: { "Cache-Control": "no-store" } });
  }

  const token = createSession(userRow.id);
  logSecurityEvent(request, userRow.id, "auth.login.success", "网页登录成功");
  // Web 登录只通过 httpOnly Cookie 交付会话，避免 token 暴露给页面 JavaScript。
  // 原生客户端使用独立的 /api/v1/auth/login 获取 Bearer token。
  const res = NextResponse.json({
    user: { id: userRow.id, username: userRow.username },
    expiresIn: sessionCookieMaxAge()
  }, { headers: { "Cache-Control": "no-store" } });
  applySessionCookie(res, token, request);
  return res;
}
