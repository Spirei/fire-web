import { loginFactor, readAuthObject } from "@/lib/authInput";
import { authenticationBurst, AuthBudgetError, authBudgetHeaders } from "@/lib/authAbuse";
import { createSession, findUserById, sessionCookieMaxAge } from "@/lib/auth";
import { completeLoginTicket } from "@/lib/totpAuth";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";
import { fail, ok } from "@/lib/api";
import { logSecurityEvent } from "@/lib/securityAudit";

export async function POST(request: Request) {
  try { authenticationBurst(request, true); }
  catch (error) {
    if (!(error instanceof AuthBudgetError)) throw error;
    const response = fail(error.unavailable ? 50301 : 42901, error.message, error.unavailable ? 503 : 429);
    for (const [key,value] of Object.entries(authBudgetHeaders(error))) response.headers.set(key,value);
    return response;
  }
  if (!rateLimit(`login-totp:${clientIp(request)}`, 40, 15 * 60 * 1000) || !rateLimitGlobal("login-totp", 80, 15 * 60 * 1000)) {
    const response = fail(42901, "尝试过于频繁，请稍后再试", 429); response.headers.set("Retry-After","900"); return response;
  }
  const factor = loginFactor(await readAuthObject(request, ["ticket", "code"]));
  if (!factor) return fail(40002, "请求参数无效", 400);
  const result = completeLoginTicket(factor.ticket, factor.code);
  if (!result.ok || !result.userId) {
    logSecurityEvent(request, "", "auth.login.totp_failed", "二次验证失败");
    return fail(40104, result.error || "验证码不正确", 401);
  }
  const userRow = findUserById(result.userId);
  if (!userRow) return fail(40104, "验证已失效，请重新登录", 401);
  const token = createSession(userRow.id);
  logSecurityEvent(request, userRow.id, "auth.login.success", "移动端二次验证登录成功");
  return ok({
    user: { id: userRow.id, username: userRow.username },
    token,
    expiresIn: sessionCookieMaxAge()
  });
}
