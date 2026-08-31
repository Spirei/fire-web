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

const DISPATCH_COOLDOWN_MS = 30_000;
let lastDispatchAt = 0;

function repositoryName() {
  const imageRepository = process.env.GHCR_IMAGE?.replace(/^ghcr\.io\//, "").replace(/:[^/]+$/, "");
  const configuredRepository = (getDb().prepare("SELECT value FROM site_settings WHERE key = 'deployGithubRepository'").get() as { value?: string } | undefined)?.value || "";
  return configuredRepository || process.env.GITHUB_REPOSITORY || imageRepository || "owner/repository";
}

function deployToken() {
  const db = getDb();
  const oauth = (db.prepare("SELECT value FROM site_settings WHERE key = 'deployGithubOauthToken'").get() as { value?: string } | undefined)?.value || "";
  const fallback = (db.prepare("SELECT value FROM site_settings WHERE key = 'deployGithubToken'").get() as { value?: string } | undefined)?.value || "";
  return (oauth ? decryptDeploySecret(oauth) : "") || process.env.GITHUB_TOKEN || (fallback ? decryptDeploySecret(fallback) : "");
}

export async function GET() {
  const repository = repositoryName();
  const token = deployToken();
  const endpoint = `https://api.github.com/repos/${repository}/actions/runs?branch=main&per_page=50`;
  try {
    const response = await fetch(endpoint, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "fire-deploy-status",
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      cache: "no-store"
    });
    if (!response.ok) return NextResponse.json({ error: `GitHub API ${response.status}（仓库：${repository}）`, repository }, { status: 502 });
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
  if (!token) return NextResponse.json({ error: "未配置 GITHUB_TOKEN，无法执行 Push image" }, { status: 503 });
  const repository = repositoryName();
  const now = Date.now();
  if (now - lastDispatchAt < DISPATCH_COOLDOWN_MS) {
    return NextResponse.json({ error: "Push image 刚刚已触发，请勿重复点击" }, { status: 409 });
  }
  lastDispatchAt = now;
  try {
    const runsResponse = await fetch(`https://api.github.com/repos/${repository}/actions/workflows/docker-publish.yml/runs?event=workflow_dispatch&branch=main&per_page=10`, {
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "fire-deploy-status" },
      cache: "no-store"
    });
    if (runsResponse.ok) {
      const payload = await runsResponse.json() as { workflow_runs?: GithubRun[] };
      const activeRun = payload.workflow_runs?.find((run) => run.status !== "completed");
      if (activeRun) {
        lastDispatchAt = 0;
        return NextResponse.json({ error: "已有 Push image 正在排队或运行，请等待完成", runUrl: activeRun.html_url }, { status: 409 });
      }
    }
  } catch {
    // GitHub 状态预检失败时仍由下面的 dispatch 请求给出最终结果。
  }
  let response: Response;
  try {
    response = await fetch(`https://api.github.com/repos/${repository}/actions/workflows/docker-publish.yml/dispatches`, {
      method: "POST",
      headers: { accept: "application/vnd.github+json", "content-type": "application/json", authorization: `Bearer ${token}`, "user-agent": "fire-deploy-status" },
      body: JSON.stringify({ ref: "main" }),
      cache: "no-store"
    });
  } catch {
    lastDispatchAt = 0;
    return NextResponse.json({ error: "无法连接 GitHub，请稍后重试" }, { status: 502 });
  }
  if (!response.ok) {
    lastDispatchAt = 0;
    return NextResponse.json({ error: `触发失败（GitHub API ${response.status}）` }, { status: 502 });
  }
  return NextResponse.json({ ok: true, repository, message: "已触发 Push image，请稍候查看状态" });
}
