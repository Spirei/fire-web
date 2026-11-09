export type BuildStep = {
  number: number;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
};
export type BuildJob = {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  url: string | null;
  steps: BuildStep[];
};
export type ImageProgress = {
  event?: string;
  id: number;
  status: string;
  conclusion: string | null;
  sha: string;
  startedAt: string;
  updatedAt: string;
  url: string;
  jobs: BuildJob[] | null;
};
export type BuildStage = Omit<BuildJob, "id" | "steps" | "url"> & {
  id: string;
  jobs: BuildJob[];
};
const CHECK =
  /^(完整平台检查|TypeScript check|TypeScript 检查)(?:\s*\((\d+)\))?$/;
const order = (name: string) =>
  /^(Check scheduled source changes|检查定时源码变更|核对发布条件)$/.test(name)
    ? 0
    : name === "源码与启动快检"
      ? 0.5
    : CHECK.test(name)
      ? 1
      : /^(Publish linux\/amd64 image|构建 linux\/amd64 镜像|发布 linux\/amd64 镜像)$/.test(
            name,
          )
        ? 2
        : /^(发布不可变版本清单|Publish immutable Fire manifest)$/.test(name)
          ? 3
          : 4;
export const failedBuild = (job: Pick<BuildJob, "status" | "conclusion">) =>
  job.status === "completed" &&
  !!job.conclusion &&
  job.conclusion !== "success" &&
  job.conclusion !== "skipped";
function observationTime(values: (string | null)[], latest = false) {
  const valid = values
    .filter(
      (v): v is string =>
        !!v && Number.isFinite(Date.parse(v)) && Date.parse(v) > 0,
    )
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  return (latest ? valid.at(-1) : valid[0]) || null;
}
/** Group presentation only: retain every observed job and leave the workflow untouched. */
export function buildStages(jobs: BuildJob[] | null | undefined): BuildStage[] {
  const groups = new Map<string, BuildJob[]>();
  for (const job of jobs || []) {
    const key = CHECK.test(job.name) ? "platform-checks" : `job:${job.id}`;
    groups.set(key, [...(groups.get(key) || []), job]);
  }
  return [...groups]
    .map(([id, members]) => {
      members.sort(
        (a, b) =>
          Number(a.name.match(CHECK)?.[2] ?? 0) -
            Number(b.name.match(CHECK)?.[2] ?? 0) || a.id - b.id,
      );
      const complete = members.every((j) => j.status === "completed");
      const failure = members.find(failedBuild);
      const active = members.some(
        (j) => j.status === "in_progress" || j.status === "completed",
      );
      const conclusion = complete
        ? failure
          ? failure.conclusion
          : members.some((j) => !j.conclusion)
            ? null
            : members.every((j) => j.conclusion === "skipped")
              ? "skipped"
              : "success"
        : null;
      return {
        id,
        name: members.length > 1 ? "完整平台检查" : members[0].name,
        status: complete
          ? "completed"
          : active
            ? "in_progress"
            : members[0].status,
        conclusion,
        startedAt: observationTime(members.map((j) => j.startedAt)),
        completedAt: complete
          ? observationTime(
              members.map((j) => j.completedAt),
              true,
            )
          : null,
        jobs: members,
      };
    })
    .sort((a, b) => order(a.name) - order(b.name));
}
export function buildDuration(
  startedAt: string | null,
  completedAt: string | null,
  fallback: string,
) {
  if (
    !startedAt ||
    !Number.isFinite(Date.parse(startedAt)) ||
    Date.parse(startedAt) <= 0
  )
    return "等待中";
  const end = Date.parse(completedAt || fallback);
  if (!Number.isFinite(end)) return "—";
  const seconds = Math.max(0, Math.round((end - Date.parse(startedAt)) / 1000));
  return seconds < 60
    ? `${seconds} 秒`
    : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
export function buildStatusLabel(status: string, conclusion: string | null) {
  if (status !== "completed")
    return status === "in_progress" ? "构建中" : "等待中";
  if (conclusion === "success") return "已完成";
  if (conclusion === "skipped") return "已跳过";
  if (conclusion === "cancelled") return "已取消";
  if (!conclusion) return "待核对";
  return "失败";
}
export function workflowLabel(label: string): string {
  if (label.startsWith("Build request receipt · ")) return "登记发布请求";
  if (/^Post Run astral-sh\/setup-uv@/.test(label)) return "收尾：Python 环境";
  if (/^Run astral-sh\/setup-uv@/.test(label)) return "准备 Python 环境";
  const shard = label.match(CHECK);
  if (shard?.[2]) return `第 ${Number(shard[2]) + 1} 组检查`;
  return (
    (
      {
        "TypeScript check": "TypeScript 检查",
        "Check scheduled source changes": "检查定时源码变更",
        "Publish linux/amd64 image": "发布 linux/amd64 镜像",
        "Set up job": "准备任务",
        Checkout: "检出代码",
        "Use Node.js 22": "使用 Node.js 22",
        "Install dependencies": "安装依赖",
        "Public repository safety audit": "公开仓库安全审计",
        "Local and GHCR deployment parity audit": "部署一致性审计",
        "Skip unchanged scheduled image": "跳过无变化的定时构建",
        "Allow manual image publish": "允许手动构建镜像",
        "Complete job": "完成任务",
        "Log in to GHCR": "登录 GHCR",
        "Docker metadata": "Docker 元数据",
        "Set up Buildx": "准备 Buildx",
        "Build and push": "构建并推送",
        "Post Build and push": "收尾：构建并推送",
        "Post Set up Buildx": "收尾：Buildx",
        "Post Log in to GHCR": "收尾：GHCR 登录",
        "Post Checkout": "收尾：检出代码",
        "Post Use Node.js 22": "收尾：Node.js",
        "Check commit titles": "检查提交标题",
        "Quick source and startup checks": "源码与启动快检",
        "Install internal backend dependencies": "安装内部后端依赖",
        "Install isolated cache and image runtime libraries":
          "准备隔离缓存与图像依赖",
        "Complete internal PostgreSQL and Worker regression":
          "内部后端完整回归",
        "Image publication regression": "镜像发布回归",
        "Security and site regression": "安全与站点回归",
        "Production build check": "生产构建检查",
        "Build Linux candidate without publishing": "构建 Linux 候选镜像",
        "Verify packaged Python, SVG, Node and PG tools": "校验镜像运行环境",
        "Decide whether image should be built": "核对源码是否需要构建",
        "Write immutable release identity": "记录不可变发布版本",
        "Publish immutable release manifest": "发布不可变版本清单",
        "Publish immutable Fire manifest": "发布不可变版本清单",
      } as Record<string, string>
    )[label] || label
  );
}
