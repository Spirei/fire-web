import { readJsonBody } from "@/lib/requestBody";
import { authenticateUser, createSession, sessionCookieMaxAge } from "@/lib/auth";
import { createLoginTicket, userTotpEnabled } from "@/lib/totpAuth";
import { clientIp, loginIdentityKey, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";
import { fail, ok } from "@/lib/api";

/** v1 登录：返回 token（移动端 Authorization: Bearer 使用）与用户信息 */
export async function POST(request: Request) {
  if (!rateLimit(`login:${clientIp(request)}`, 50, 15 * 60 * 1000) || !rateLimitGlobal("login", 100, 15 * 60 * 1000)) {
    return fail(42901, "尝试过于频繁，请 15 分钟后再试", 429);
  }
  const body = await readJsonBody(request, 16 * 1024).catch(() => null);
  if (!body) return fail(40002, "无效的请求体", 400);
  const username = String(body.username ?? "").trim();
  const password = String(body.password ?? "");
  if (username.length > 254 || password.length > 128) {
    return fail(40103, "用户名或密码错误", 401);
  }
  if (!rateLimit(`login-account:${loginIdentityKey(username)}`, 20, 15 * 60 * 1000)) {
    return fail(42901, "尝试过于频繁，请 15 分钟后再试", 429);
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
