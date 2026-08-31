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
  path?: string;
  run_started_at?: string;
  updated_at: string;
  html_url: string;
};

type GithubJob = {
  id: number;
  name: string;
  status: "queued" | "in_progress" | "completed" | string;
  conclusion: "success" | "failure" | "cancelled" | "skipped" | null | string;
  started_at: string | null;
  completed_at: string | null;
  html_url: string;
  steps?: Array<{
    number: number;
    name: string;
    status: "queued" | "in_progress" | "completed" | string;
    conclusion: "success" | "failure" | "cancelled" | "skipped" | null | string;
    started_at: string | null;
    completed_at: string | null;
  }>;
};

type GithubCommit = {
  sha: string;
  html_url: string;
};

const DISPATCH_COOLDOWN_MS = 30_000;
let lastDispatchAt = 0;
const jobsCache = new Map<string, { fetchedAt: number; jobs: GithubJob[] }>();

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

export async function GET(request: Request) {
  const user = getAuthUser(request);
  if (!user || !isAdmin(user)) return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });
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
    const workflowRuns = payload.workflow_runs || [];
    const runs = workflowRuns.map((run) => ({
      id: run.id,
      name: run.name,
      title: run.display_title || run.name,
      sha: run.head_sha.slice(0, 7),
      status: run.status,
      conclusion: run.conclusion,
      event: run.event,
      workflowPath: run.path || "",
      startedAt: run.run_started_at || run.updated_at,
      updatedAt: run.updated_at,
      url: run.html_url
    }));
    const latestImageRun = workflowRuns.find((run) => run.path === ".github/workflows/docker-publish.yml" && (run.event === "schedule" || run.event === "workflow_dispatch"));
    let imageProgress = null;
    if (latestImageRun) {
      let jobs: GithubJob[] = [];
      const cacheKey = `${repository}:${latestImageRun.id}`;
      const cachedJobs = jobsCache.get(cacheKey);
      // 不能只看 run：run 可能刚完成，而缓存里的 jobs 仍停留在进行中。
      const cachedJobsComplete = cachedJobs?.jobs.length && cachedJobs.jobs.every((job) => job.status === "completed");
      const cacheTtl = cachedJobsComplete ? 300_000 : 15_000;
      if (cachedJobs && Date.now() - cachedJobs.fetchedAt < cacheTtl) {
        jobs = cachedJobs.jobs;
      } else {
        const jobsResponse = await fetch(`https://api.github.com/repos/${repository}/actions/runs/${latestImageRun.id}/jobs?per_page=20`, {
          headers: {
            accept: "application/vnd.github+json",
            "user-agent": "fire-deploy-status",
            ...(token ? { authorization: `Bearer ${token}` } : {})
          },
          cache: "no-store"
        });
        if (jobsResponse.ok) {
          const jobsPayload = await jobsResponse.json() as { jobs?: GithubJob[] };
          jobs = jobsPayload.jobs || [];
          jobsCache.set(cacheKey, { fetchedAt: Date.now(), jobs });
        }
      }
      imageProgress = {
        id: latestImageRun.id,
        status: latestImageRun.status,
        conclusion: latestImageRun.conclusion,
        sha: latestImageRun.head_sha.slice(0, 7),
        startedAt: latestImageRun.run_started_at || latestImageRun.updated_at,
        updatedAt: latestImageRun.updated_at,
        url: latestImageRun.html_url,
        jobs: jobs.map((job) => ({
          id: job.id,
          name: job.name,
          status: job.status,
          conclusion: job.conclusion,
          startedAt: job.started_at,
          completedAt: job.completed_at,
          url: job.html_url,
          steps: (job.steps || []).map((step) => ({
            number: step.number,
            name: step.name,
            status: step.status,
            conclusion: step.conclusion,
            startedAt: step.started_at,
            completedAt: step.completed_at
          }))
        }))
      };
    }
    let mainCommit: GithubCommit | null = null;
    try {
      const commitResponse = await fetch(`https://api.github.com/repos/${repository}/commits/main`, {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "fire-deploy-status",
          ...(token ? { authorization: `Bearer ${token}` } : {})
        },
        cache: "no-store"
      });
      if (commitResponse.ok) mainCommit = await commitResponse.json() as GithubCommit;
    } catch {
      // Actions 数据仍可展示，源码版本暂时标记为未知。
    }

    const imageRuns = workflowRuns.filter((run) => run.path === ".github/workflows/docker-publish.yml" && (run.event === "schedule" || run.event === "workflow_dispatch"));
    const latestSuccessfulImageRun = imageRuns.find((run) => run.status === "completed" && run.conclusion === "success") || null;
    const mainSha = mainCommit?.sha || "";
    const deployedSha = process.env.FIRE_BUILD_SHA?.trim() || "unknown";
    const packageName = repository.split("/").filter(Boolean).pop() || "fire-web";
    return NextResponse.json({
      repository,
      packageName,
      runs,
      imageProgress,
      source: mainSha ? { sha: mainSha, shortSha: mainSha.slice(0, 7), url: mainCommit?.html_url || `https://github.com/${repository}/commit/${mainSha}` } : null,
      image: {
        latestSuccessfulSha: latestSuccessfulImageRun?.head_sha || "",
        latestSuccessfulShortSha: latestSuccessfulImageRun?.head_sha.slice(0, 7) || "",
        latestSuccessfulAt: latestSuccessfulImageRun?.updated_at || "",
        latestSuccessfulUrl: latestSuccessfulImageRun?.html_url || "",
        matchesMain: Boolean(mainSha && latestSuccessfulImageRun?.head_sha === mainSha)
      },
      runtime: {
        sha: deployedSha,
        shortSha: deployedSha === "unknown" ? "unknown" : deployedSha.slice(0, 7),
        matchesImage: Boolean(latestSuccessfulImageRun?.head_sha && deployedSha === latestSuccessfulImageRun.head_sha),
        matchesMain: Boolean(mainSha && deployedSha === mainSha)
      },
      checkedAt: new Date().toISOString()
    }, { headers: { "cache-control": "no-store" } });
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
    const runsResponse = await fetch(`https://api.github.com/repos/${repository}/actions/workflows/docker-publish.yml/runs?branch=main&per_page=10`, {
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "fire-deploy-status" },
      cache: "no-store"
    });
    if (runsResponse.ok) {
      const payload = await runsResponse.json() as { workflow_runs?: GithubRun[] };
      const activeRun = payload.workflow_runs?.find((run) => (run.event === "schedule" || run.event === "workflow_dispatch") && run.status !== "completed");
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
