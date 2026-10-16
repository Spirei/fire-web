import { credentials, readAuthObject } from "@/lib/authInput";
import { AuthBudgetError, authBudgetHeaders, authenticationBurst } from "@/lib/authAbuse";
import { authenticateUser, createSession, sessionCookieMaxAge } from "@/lib/auth";
import { createLoginTicket, userTotpEnabled } from "@/lib/totpAuth";
import { clientIp, loginIdentityKey, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";
import { fail, ok } from "@/lib/api";

/** v1 登录：返回 token（移动端 Authorization: Bearer 使用）与用户信息 */
export async function POST(request: Request) {
  try { authenticationBurst(request); }
  catch (error) {
    if (!(error instanceof AuthBudgetError)) throw error;
    const response = fail(error.unavailable ? 50301 : 42901, error.message, error.unavailable ? 503 : 429);
    for (const [key, value] of Object.entries(authBudgetHeaders(error))) response.headers.set(key, value);
    return response;
  }
  if (!rateLimit(`login:${clientIp(request)}`, 50, 15 * 60 * 1000) || !rateLimitGlobal("login", 100, 15 * 60 * 1000)) {
    const response = fail(42901, "尝试过于频繁，请稍后再试", 429);
    response.headers.set("Retry-After", "900"); return response;
  }
  const input = credentials(await readAuthObject(request, ["username", "password"]));
  if (!input) return fail(40103, "用户名或密码错误", 401);
  const { username, password } = input;
  if (!rateLimit(`login-account:${loginIdentityKey(username)}`, 20, 15 * 60 * 1000)) {
    const response = fail(42901, "尝试过于频繁，请稍后再试", 429);
    response.headers.set("Retry-After", "900"); return response;
  }
  const userRow = authenticateUser(username, password);
  if (!userRow) {
    return fail(40103, "用户名或密码错误", 401);
  }
  if (userTotpEnabled(userRow.id)) {
    return ok({ requires2fa: true, ticket: createLoginTicket(userRow.id) });
  }
  const token = createSession(userRow.id);
  return ok({
    user: { id: userRow.id, username: userRow.username },
    token,
    expiresIn: sessionCookieMaxAge()
  });
}
