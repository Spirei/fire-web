import { getAuthUser, getCookie, getUserByToken, SESSION_COOKIE, LEGACY_SESSION_COOKIE, isTrustedMutationRequest } from "@/lib/auth";
import { assertAppOrigin, issueAppCode, parseAppAuthorization } from "@/lib/appAuth";
import { fail, ok } from "@/lib/api";
import { readJsonBody } from "@/lib/requestBody";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";
import { logSecurityEvent } from "@/lib/securityAudit";

export async function POST(request: Request) {
  if (!request.headers.get("origin") || !isTrustedMutationRequest(request) || request.headers.has("authorization")) return fail(40301, "请在 Fire 网页确认连接", 403);
  try { assertAppOrigin(request); } catch (error) { return fail(40301, (error as Error).message, 403); }
  const token = getCookie(request, SESSION_COOKIE) || getCookie(request, LEGACY_SESSION_COOKIE);
  const user = token && getUserByToken(token);
  if (!user || !getAuthUser(request)) return fail(40101, "请重新登录", 401);
  if (!rateLimit(`app-authorize:${user.id}:${clientIp(request)}`, 20, 60_000) || !rateLimitGlobal("app-authorize", 200, 60_000)) return fail(42901, "连接过于频繁，请稍后再试", 429);
  const body = await readJsonBody(request, 8192).catch(() => null);
  if (!body || !["allow", "deny"].includes(body.decision)) return fail(40002, "无效的授权请求", 400);
  try {
    const auth = parseAppAuthorization(body);
    const callback = new URL(auth.redirect_uri);
    callback.searchParams.set("state", auth.state);
    if (body.decision === "deny") callback.searchParams.set("error", "access_denied");
    else {
      callback.searchParams.set("code", issueAppCode(auth, user.id, token!));
      logSecurityEvent(request, user.id, "app.authorized", auth.device_name);
    }
    return ok({ callback: callback.toString() });
  } catch (error) { return fail(40001, (error as Error).message, 400); }
}
