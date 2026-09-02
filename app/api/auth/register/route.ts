import { NextResponse } from "next/server";
import { createSession, createUser, findUserByUsername, LEGACY_SESSION_COOKIE, needsSetup, sessionCookieMaxAge, sessionCookieSecure, SESSION_COOKIE } from "@/lib/auth";
import { validatePassword } from "@/lib/password";
import { getSiteSettings } from "@/lib/settings";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";
import { logSecurityEvent } from "@/lib/securityAudit";

export async function POST(request: Request) {
  // 注册限流：同 IP 15 分钟最多 5 次，防批量注册
  if (!rateLimit(`register:${clientIp(request)}`, 20, 15 * 60 * 1000)) {
    return NextResponse.json({ error: "注册过于频繁，请稍后再试" }, { status: 429 });
  }
  if (!rateLimitGlobal("register", 50, 15 * 60 * 1000)) {
    return NextResponse.json({ error: "注册过于频繁，请稍后再试" }, { status: 429 });
  }
  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "无效的请求体" }, { status: 400 });

  const username = String(body.username ?? "").trim();
  const password = String(body.password ?? "");
  const isTest = body.isTest === true;

  // 测试账号不占用 UID；生产环境不允许通过注册接口创建，避免被滥用
  if (isTest && process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "生产环境不支持创建测试账号" }, { status: 403 });
  }
  // 网站设置关闭注册时，普通注册一律拒绝；空实例首次创建管理员除外。
  if (!isTest && !getSiteSettings().allowRegister && !needsSetup()) {
    return NextResponse.json({ error: "管理员已关闭注册" }, { status: 403 });
  }

  if (username.length < 3 || username.length > 20) {
    return NextResponse.json({ error: "用户名需为 3-20 个字符" }, { status: 400 });
  }
  if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]+$/.test(username)) {
    return NextResponse.json({ error: "用户名只能包含字母、数字、下划线或中文" }, { status: 400 });
  }
  const pwdErr = validatePassword(password);
  if (pwdErr) {
    return NextResponse.json({ error: pwdErr }, { status: 400 });
  }
  if (findUserByUsername(username)) {
    return NextResponse.json({ error: "用户名已存在" }, { status: 409 });
  }

  const user = createUser(username, password, isTest);
  logSecurityEvent(request, user.id, "auth.register.success", isTest ? "创建测试账号" : "注册账号");
  const token = createSession(user.id);
  const res = NextResponse.json({ user }, { status: 201 });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: sessionCookieMaxAge(),
    secure: sessionCookieSecure(request)
  });
  res.cookies.set(LEGACY_SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
