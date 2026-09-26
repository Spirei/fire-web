import { timingSafeEqual } from "node:crypto";
import { readJsonBody } from "@/lib/requestBody";
import { NextResponse } from "next/server";
import { applySessionCookie, createSession, createUser, findUserByUsername, needsSetup } from "@/lib/auth";
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
  const body = await readJsonBody(request, 16 * 1024).catch(() => null);
  if (!body) return NextResponse.json({ error: "无效的请求体" }, { status: 400 });

  if (process.env.NODE_ENV === "production" && needsSetup()) {
    const expected = process.env.FIRE_SETUP_TOKEN || "";
    if (expected.length < 32) return NextResponse.json({ error: "请先配置至少 32 字符的 FIRE_SETUP_TOKEN" }, { status: 503 });
    const provided = Buffer.from(String(body.setupToken || ""));
    const wanted = Buffer.from(expected);
    if (provided.length !== wanted.length || !timingSafeEqual(provided, wanted)) return NextResponse.json({ error: "安装令牌无效" }, { status: 403 });
  }
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

  let user;
  try {
    user = createUser(username, password, isTest);
  } catch (error) {
    // 并发注册可能都通过预检查，最终以数据库唯一约束为准，不暴露底层异常。
    if (findUserByUsername(username)) {
      return NextResponse.json({ error: "用户名已存在" }, { status: 409 });
    }
    throw error;
  }
  logSecurityEvent(request, user.id, "auth.register.success", isTest ? "创建测试账号" : "注册账号");
  const token = createSession(user.id);
  const res = NextResponse.json({ user }, { status: 201, headers: { "Cache-Control": "no-store" } });
  applySessionCookie(res, token, request);
  return res;
}
