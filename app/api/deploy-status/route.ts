import { NextResponse } from "next/server";
import { getAuthUser, isAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { decryptDeploySecret } from "@/lib/deploySecrets";

export const dynamic = "force-dynamic";

type GithubRun = {
  id: number;
  name: string;
  display_title?: string;
  head_sha: string;
  status: "queued" | "in_progress" | "completed" | string;
  conclusion: "success" | "failure" | "cancelled" | "skipped" | null | string;
  event: string;
  run_started_at?: string;
  updated_at: string;
  html_url: string;
};

function repositoryName() {
  const imageRepository = process.env.GHCR_IMAGE?.replace(/^ghcr\.io\//, "").replace(/:[^/]+$/, "");
  return process.env.GITHUB_REPOSITORY || imageRepository || (getDb().prepare("SELECT value FROM site_settings WHERE key = 'deployGithubRepository'").get() as { value?: string } | undefined)?.value || "owner/repository";
}

function deployToken() {
  const db = getDb();
  const oauth = (db.prepare("SELECT value FROM site_settings WHERE key = 'deployGithubOauthToken'").get() as { value?: string } | undefined)?.value || "";
  const fallback = (db.prepare("SELECT value FROM site_settings WHERE key = 'deployGithubToken'").get() as { value?: string } | undefined)?.value || "";
  return (oauth ? decryptDeploySecret(oauth) : "") || process.env.GITHUB_TOKEN || (fallback ? decryptDeploySecret(fallback) : "");
}

export async function GET() {
  const repository = repositoryName();
  const endpoint = `https://api.github.com/repos/${repository}/actions/runs?branch=main&per_page=20`;
  try {
    const response = await fetch(endpoint, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "fire-deploy-status",
        ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {})
      },
      cache: "no-store"
    });
    if (!response.ok) return NextResponse.json({ error: `GitHub API ${response.status}`, repository }, { status: 502 });
    const payload = await response.json() as { workflow_runs?: GithubRun[] };
    const runs = (payload.workflow_runs || []).map((run) => ({
      id: run.id,
      name: run.name,
      title: run.display_title || run.name,
      sha: run.head_sha.slice(0, 7),
      status: run.status,
      conclusion: run.conclusion,
      event: run.event,
      startedAt: run.run_started_at || run.updated_at,
      updatedAt: run.updated_at,
      url: run.html_url
    }));
    return NextResponse.json({ repository, runs, checkedAt: new Date().toISOString() }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "无法读取 GitHub 状态", repository }, { status: 502 });
  }
}

export async function POST(request: Request) {
  const user = getAuthUser(request);
  if (!user || !isAdmin(user)) return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });
  const token = deployToken();
  if (!token) return NextResponse.json({ error: "未配置 GITHUB_TOKEN，无法手动触发发布" }, { status: 503 });
  const repository = repositoryName();
  const response = await fetch(`https://api.github.com/repos/${repository}/actions/workflows/docker-publish.yml/dispatches`, {
    method: "POST",
    headers: { accept: "application/vnd.github+json", "content-type": "application/json", authorization: `Bearer ${token}`, "user-agent": "fire-deploy-status" },
    body: JSON.stringify({ ref: "main" }),
    cache: "no-store"
  });
  if (!response.ok) return NextResponse.json({ error: `触发失败（GitHub API ${response.status}）` }, { status: 502 });
  return NextResponse.json({ ok: true, repository, message: "已触发手动发布，请稍候查看状态" });
}
