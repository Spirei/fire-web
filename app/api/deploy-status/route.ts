import { NextResponse } from "next/server";

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

export async function GET() {
  const imageRepository = process.env.GHCR_IMAGE?.replace(/^ghcr\.io\//, "").replace(/:[^/]+$/, "");
  const repository = process.env.GITHUB_REPOSITORY || imageRepository || "owner/repository";
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

export async function POST() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return NextResponse.json({ error: "未配置 GITHUB_TOKEN，无法手动触发发布" }, { status: 503 });
  const imageRepository = process.env.GHCR_IMAGE?.replace(/^ghcr\.io\//, "").replace(/:[^/]+$/, "");
  const repository = process.env.GITHUB_REPOSITORY || imageRepository || "owner/repository";
  const response = await fetch(`https://api.github.com/repos/${repository}/actions/workflows/docker-publish.yml/dispatches`, {
    method: "POST",
    headers: { accept: "application/vnd.github+json", "content-type": "application/json", authorization: `Bearer ${token}`, "user-agent": "fire-deploy-status" },
    body: JSON.stringify({ ref: "main" }),
    cache: "no-store"
  });
  if (!response.ok) return NextResponse.json({ error: `触发失败（GitHub API ${response.status}）` }, { status: 502 });
  return NextResponse.json({ ok: true, repository, message: "已触发手动发布，请稍候查看状态" });
}
