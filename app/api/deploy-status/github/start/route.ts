import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { getAuthUser, isAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = getAuthUser(request);
  if (!user || !isAdmin(user)) return NextResponse.json({ error: "需要管理员登录后授权" }, { status: 403 });
  if (!process.env.GITHUB_CLIENT_ID || !process.env.GITHUB_CLIENT_SECRET) return NextResponse.json({ error: "服务端尚未配置 GitHub OAuth App" }, { status: 503 });
  const state = crypto.randomBytes(24).toString("hex");
  const db = getDb();
  db.prepare("INSERT INTO site_settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run("deployGithubOauthState", JSON.stringify({ state, userId: user.id, expiresAt: Date.now() + 10 * 60 * 1000 }));
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", process.env.GITHUB_CLIENT_ID);
  url.searchParams.set("redirect_uri", process.env.GITHUB_OAUTH_CALLBACK_URL || new URL("/api/deploy-status/github/callback", request.url).toString());
  url.searchParams.set("scope", "workflow");
  url.searchParams.set("state", state);
  const response = NextResponse.redirect(url);
  response.cookies.set("fire_github_oauth_state", state, { httpOnly: true, sameSite: "lax", secure: new URL(request.url).protocol === "https:", maxAge: 600, path: "/" });
  return response;
}
