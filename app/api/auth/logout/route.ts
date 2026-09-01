import { NextResponse } from "next/server";
import { deleteSession, getAuthUser, getCookie, LEGACY_SESSION_COOKIE, SESSION_COOKIE } from "@/lib/auth";
import { logSecurityEvent } from "@/lib/securityAudit";

export async function POST(request: Request) {
  const token = getCookie(request, SESSION_COOKIE) || getCookie(request, LEGACY_SESSION_COOKIE);
  const user = getAuthUser(request);
  if (user) logSecurityEvent(request, user.id, "auth.logout", "网页登录退出");
  deleteSession(token);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  res.cookies.set(LEGACY_SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
