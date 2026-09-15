import { readJsonBody } from "@/lib/requestBody";
import { NextResponse } from "next/server";
import { getAuthUser, isAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { encryptDeploySecret } from "@/lib/deploySecrets";

export const dynamic = "force-dynamic";
const read = (key: string) => (getDb().prepare("SELECT value FROM site_settings WHERE key = ?").get(key) as { value?: string } | undefined)?.value || "";
const write = (key: string, value: string) => getDb().prepare("INSERT INTO site_settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);

export async function GET(request: Request) {
  const user = getAuthUser(request);
  if (!user || !isAdmin(user)) return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });
  const repository = read("deployGithubRepository") || process.env.GITHUB_REPOSITORY || process.env.GHCR_IMAGE?.replace(/^ghcr\.io\//, "").replace(/:[^/]+$/, "") || "";
  return NextResponse.json({ repository, hasToken: Boolean(process.env.GITHUB_TOKEN || read("deployGithubToken") || read("deployGithubOauthToken")), githubAccount: read("deployGithubAccount") });
}

export async function PUT(request: Request) {
  const user = getAuthUser(request);
  if (!user || !isAdmin(user)) return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });
  const body = await readJsonBody(request).catch(() => null) as { repository?: unknown; token?: unknown; clearToken?: unknown } | null;
  const repository = String(body?.repository || "").trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) return NextResponse.json({ error: "仓库格式应为 账号/仓库名" }, { status: 400 });
  write("deployGithubRepository", repository);
  if (body?.clearToken === true) write("deployGithubToken", "");
  else if (typeof body?.token === "string" && body.token.trim()) {
    try { write("deployGithubToken", encryptDeploySecret(body.token.trim())); }
    catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "无法安全保存 Token" }, { status: 503 }); }
  }
  return NextResponse.json({ repository, hasToken: Boolean(process.env.GITHUB_TOKEN || read("deployGithubToken") || read("deployGithubOauthToken")), githubAccount: read("deployGithubAccount") });
}

export async function DELETE(request: Request) {
  const user = getAuthUser(request);
  if (!user || !isAdmin(user)) return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });
  write("deployGithubOauthToken", ""); write("deployGithubAccount", "");
  return NextResponse.json({ ok: true });
}
