import { NextResponse } from "next/server";
import { deleteSession, getCookie, LEGACY_SESSION_COOKIE, SESSION_COOKIE } from "@/lib/auth";

export async function POST(request: Request) {
  const token = getCookie(request, SESSION_COOKIE) || getCookie(request, LEGACY_SESSION_COOKIE);
  deleteSession(token);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  res.cookies.set(LEGACY_SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
