import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { applySessionCookie, createSession, createUser, findUserByUsername, isTrustedMutationRequest, needsSetup } from "@/lib/auth";
import { validatePassword } from "@/lib/password";
import { getSiteSettings } from "@/lib/settings";
import { logSecurityEvent } from "@/lib/securityAudit";
import { credentials, readAuthObject } from "@/lib/authInput";
import { AuthBudgetError, authBudgetHeaders, registrationAttempt, registrationCreation } from "@/lib/authAbuse";
import { getDb } from "@/lib/db";

class RegistrationClosed extends Error {}

export async function POST(request: Request) {
  if (!isTrustedMutationRequest(request)) return NextResponse.json({ error: "请求来源不受信任" }, { status: 403, headers: { "Cache-Control": "no-store" } });
  try { registrationAttempt(request); }
  catch (error) {
    if (!(error instanceof AuthBudgetError)) throw error;
    return NextResponse.json({ error: error.unavailable ? error.message : "注册过于频繁，请稍后再试" }, { status: error.unavailable ? 503 : 429, headers: authBudgetHeaders(error) });
  }
  const body = await readAuthObject(request, ["username", "password", "setupToken", "isTest"]);
  if (!body || (body.setupToken !== undefined && (typeof body.setupToken !== "string" || body.setupToken.length > 512))
      || (body.isTest !== undefined && typeof body.isTest !== "boolean")) {
    return NextResponse.json({ error: "请求参数无效" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }

  if (process.env.NODE_ENV === "production" && needsSetup()) {
    const expected = process.env.FIRE_SETUP_TOKEN || "";
    if (expected.length < 32) return NextResponse.json({ error: "请先配置至少 32 字符的 FIRE_SETUP_TOKEN" }, { status: 503 });
    const provided = Buffer.from(typeof body.setupToken === "string" ? body.setupToken : "");
    const wanted = Buffer.from(expected);
    if (provided.length !== wanted.length || !timingSafeEqual(provided, wanted)) return NextResponse.json({ error: "安装令牌无效" }, { status: 403 });
  }
  const input = credentials(body);
  if (!input) return NextResponse.json({ error: "请求参数无效" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  const { username, password } = input;
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

  let user, token;
  try {
    ({ user, token } = getDb().transaction(() => {
      // Recheck the unique name before consuming creation slots. All successful
      // budgets, the user and its session commit or roll back together.
      if (findUserByUsername(username)) throw new Error("duplicate username");
      if (!isTest && !getSiteSettings().allowRegister && !needsSetup()) throw new RegistrationClosed();
      registrationCreation(request);
      const user = createUser(username, password, isTest);
      return { user, token: createSession(user.id) };
    }).immediate());
  } catch (error) {
    if (error instanceof RegistrationClosed) return NextResponse.json({ error: "管理员已关闭注册" }, { status: 403, headers: { "Cache-Control": "no-store" } });
    if (error instanceof AuthBudgetError) {
      return NextResponse.json({ error: error.unavailable ? error.message : "注册过于频繁，请稍后再试" }, { status: error.unavailable ? 503 : 429, headers: authBudgetHeaders(error) });
    }
    // 并发注册可能都通过预检查，最终以数据库唯一约束为准，不暴露底层异常。
    if (findUserByUsername(username)) {
      return NextResponse.json({ error: "用户名已存在" }, { status: 409 });
    }
    return NextResponse.json({ error: "注册结果未确认，请尝试登录" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  logSecurityEvent(request, user.id, "auth.register.success", isTest ? "创建测试账号" : "注册账号");
  const res = NextResponse.json({ user }, { status: 201, headers: { "Cache-Control": "no-store" } });
  applySessionCookie(res, token, request);
  return res;
}
