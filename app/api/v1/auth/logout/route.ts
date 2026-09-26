import { deleteSession, getSessionToken, isTrustedMutationRequest, LEGACY_SESSION_COOKIE, SESSION_COOKIE } from "@/lib/auth";
import { fail, ok } from "@/lib/api";

/** v1 登出：使当前会话失效 */
export async function POST(request: Request) {
  if (!request.headers.get("authorization")?.startsWith("Bearer ") && !isTrustedMutationRequest(request)) return fail(40301, "请求来源不受信任", 403);
  const token = getSessionToken(request);
  deleteSession(token);
  const res = ok({ loggedOut: true });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  res.cookies.set(LEGACY_SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
