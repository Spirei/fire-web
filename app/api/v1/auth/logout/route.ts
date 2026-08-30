import { deleteSession, getCookie, LEGACY_SESSION_COOKIE, SESSION_COOKIE } from "@/lib/auth";
import { ok } from "@/lib/api";

/** v1 登出：使当前会话失效 */
export async function POST(request: Request) {
  const auth = request.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const token = bearer || getCookie(request, SESSION_COOKIE) || getCookie(request, LEGACY_SESSION_COOKIE);
  deleteSession(token);
  const res = ok({ loggedOut: true });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  res.cookies.set(LEGACY_SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
