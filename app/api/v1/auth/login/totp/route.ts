import { readJsonBody } from "@/lib/requestBody";
import { createSession, findUserById, sessionCookieMaxAge } from "@/lib/auth";
import { completeLoginTicket } from "@/lib/totpAuth";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";
import { fail, ok } from "@/lib/api";
import { logSecurityEvent } from "@/lib/securityAudit";

export async function POST(request: Request) {
  if (!rateLimit(`login-totp:${clientIp(request)}`, 40, 15 * 60 * 1000) || !rateLimitGlobal("login-totp", 80, 15 * 60 * 1000)) {
    return fail(42901, "尝试过于频繁，请稍后再试", 429);
  }
  const body = await readJsonBody(request, 8 * 1024).catch(() => null);
  if (!body) return fail(40002, "无效的请求体", 400);
  const result = completeLoginTicket(String(body.ticket ?? ""), String(body.code ?? ""));
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
