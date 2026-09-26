import { readJsonBody } from "@/lib/requestBody";
import { NextResponse } from "next/server";
import { applySessionCookie, authenticateUser, createSession, sessionCookieMaxAge } from "@/lib/auth";
import { createLoginTicket, userTotpEnabled } from "@/lib/totpAuth";
import { clientIp, loginIdentityKey, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";
import { logSecurityEvent } from "@/lib/securityAudit";

export async function POST(request: Request) {
  // 登录限流：同 IP 15 分钟最多 50 次尝试，防暴力破解（全局 100 次/15 分钟兜底）
  if (!rateLimit(`login:${clientIp(request)}`, 50, 15 * 60 * 1000)) {
    logSecurityEvent(request, "", "auth.login.rate_limited", "IP 登录尝试过于频繁");
    return NextResponse.json({ error: "尝试过于频繁，请 15 分钟后再试" }, { status: 429 });
  }
  // 全局预算：即使伪造 X-Forwarded-For 也无法无限尝试
  if (!rateLimitGlobal("login", 100, 15 * 60 * 1000)) {
    logSecurityEvent(request, "", "auth.login.rate_limited", "全局登录尝试过于频繁");
    return NextResponse.json({ error: "尝试过于频繁，请稍后再试" }, { status: 429 });
  }
  const body = await readJsonBody(request, 16 * 1024).catch(() => null);
  if (!body) return NextResponse.json({ error: "无效的请求体" }, { status: 400 });

  const username = String(body.username ?? "").trim();
  const password = String(body.password ?? "");
  // 兼容用户名（≤20）与邮箱（≤254）登录：统一放宽到邮箱长度上限
  if (username.length > 254 || password.length > 128) {
    return NextResponse.json({ error: "用户名或密码错误" }, { status: 401 });
  }
  if (!rateLimit(`login-account:${loginIdentityKey(username)}`, 20, 15 * 60 * 1000)) {
    logSecurityEvent(request, "", "auth.login.rate_limited", "账号登录尝试过于频繁");
    return NextResponse.json({ error: "尝试过于频繁，请 15 分钟后再试" }, { status: 429 });
  }
  const userRow = authenticateUser(username, password);

  if (!userRow) {
    logSecurityEvent(request, "", "auth.login.failed", `username=${username.slice(0, 80)}`);
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
