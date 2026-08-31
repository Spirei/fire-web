import { NextResponse } from "next/server";
import { getAuthUser, isAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { encryptDeploySecret } from "@/lib/deploySecrets";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = getAuthUser(request);
  const url = new URL(request.url);
  const fail = (message: string) => NextResponse.redirect(new URL(`/deploy-status?github_error=${encodeURIComponent(message)}`, request.url));
  if (!user || !isAdmin(user)) return fail("授权已失效，请先登录管理员账号");
  const state = url.searchParams.get("state") || "";
  const cookieState = request.headers.get("cookie")?.match(/(?:^|;\s*)fire_github_oauth_state=([^;]+)/)?.[1] || "";
  const row = getDb().prepare("SELECT value FROM site_settings WHERE key = 'deployGithubOauthState'").get() as { value?: string } | undefined;
  let stored: { state?: string; userId?: string; expiresAt?: number } = {};
  try { stored = JSON.parse(row?.value || "{}"); } catch { /* invalid state */ }
  if (!state || state !== cookieState || state !== stored.state || stored.userId !== user.id || !stored.expiresAt || stored.expiresAt < Date.now()) return fail("授权校验失败，请重新开始");
  const code = url.searchParams.get("code");
  if (!code) return fail("GitHub 未返回授权码");
  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ client_id: process.env.GITHUB_CLIENT_ID, client_secret: process.env.GITHUB_CLIENT_SECRET, code, redirect_uri: process.env.GITHUB_OAUTH_CALLBACK_URL || new URL("/api/deploy-status/github/callback", request.url).toString() }), cache: "no-store" });
  const tokenData = await tokenResponse.json() as { access_token?: string; error?: string };
  if (!tokenResponse.ok || !tokenData.access_token) return fail(tokenData.error || "GitHub 授权失败");
  const profileResponse = await fetch("https://api.github.com/user", { headers: { accept: "application/vnd.github+json", authorization: `Bearer ${tokenData.access_token}`, "user-agent": "fire-deploy-status" }, cache: "no-store" });
  const profile = profileResponse.ok ? await profileResponse.json() as { login?: string } : {};
  const db = getDb();
  const write = db.prepare("INSERT INTO site_settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  try { write.run("deployGithubOauthToken", encryptDeploySecret(tokenData.access_token)); }
  catch (error) { return fail(error instanceof Error ? error.message : "服务端无法安全保存授权"); }
  write.run("deployGithubAccount", profile.login || "GitHub");
  write.run("deployGithubOauthState", "");
  const response = NextResponse.redirect(new URL("/deploy-status?github=connected", request.url));
  response.cookies.set("fire_github_oauth_state", "", { maxAge: 0, path: "/" });
  return response;
}
