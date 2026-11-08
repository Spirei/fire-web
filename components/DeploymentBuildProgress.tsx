"use client";
import {
  IconChevronRight,
  IconCircleCheck,
  IconCircleX,
  IconClock,
  IconExternalLink,
  IconLoader2,
} from "@tabler/icons-react";
import {
  buildStages,
  buildDuration,
  buildStatusLabel,
  failedBuild,
  workflowLabel,
  type BuildJob,
  type ImageProgress,
} from "@/lib/deployProgress";
function StatusIcon({
  status,
  conclusion,
  size = 18,
}: {
  status: string;
  conclusion: string | null;
  size?: number;
}) {
  if (status === "in_progress")
    return (
      <IconLoader2
        aria-hidden="true"
        className="motion-safe:animate-spin text-amber-500"
        size={size}
        stroke={2}
      />
    );
  if (status !== "completed" || !conclusion || conclusion === "skipped")
    return (
      <IconClock
        aria-hidden="true"
        className="text-slate-400"
        size={size}
        stroke={1.8}
      />
    );
  return conclusion === "success" ? (
    <IconCircleCheck
      aria-hidden="true"
      className="text-emerald-500"
      size={size}
      stroke={2}
    />
  ) : (
    <IconCircleX
      aria-hidden="true"
      className="text-red-500"
      size={size}
      stroke={2}
    />
  );
}
const info = (...parts: string[]) => [...new Set(parts)].join(" · ");
function Steps({ job, now }: { job: BuildJob; now: string }) {
  return (
    <div className="border-t border-slate-200 px-3.5 py-2.5 dark:border-slate-800">
      {job.steps.map((step) => (
        <div
          key={step.number}
          className="flex items-start gap-2.5 py-2 text-xs"
        >
          <span className="mt-0.5 shrink-0">
            <StatusIcon
              status={step.status}
              conclusion={step.conclusion}
              size={15}
            />
          </span>
          <span
            className={`min-w-0 flex-1 break-words ${step.status === "in_progress" ? "font-medium text-slate-800 dark:text-slate-200" : "text-slate-500 dark:text-slate-400"}`}
          >
            {workflowLabel(step.name)}
          </span>
          <span className="shrink-0 text-slate-400">
            {step.conclusion === "skipped"
              ? "已跳过"
              : buildDuration(step.startedAt, step.completedAt, now)}
          </span>
        </div>
      ))}
    </div>
  );
}
export default function DeploymentBuildProgress({
  progress,
  checkedAt,
}: {
  progress: ImageProgress;
  checkedAt: string;
}) {
  const stages = buildStages(progress.jobs),
    now = checkedAt || progress.updatedAt;
  const finished = stages.filter(
    (stage) => stage.status === "completed",
  ).length;
  return (
    <section
      aria-label="镜像构建进度"
      aria-live="polite"
      aria-busy={progress.status !== "completed"}
      className="mb-6 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-[#121923] dark:shadow-none"
    >
      <div className="flex flex-col gap-3 border-b border-slate-200 px-4 py-4 dark:border-slate-800 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <div className="min-w-0">
          <h2 className="text-sm font-medium">镜像构建进度</h2>
          <p className="mt-1 break-words text-xs text-slate-500">
            {progress.sha} ·{" "}
            {stages.length
              ? `${finished} / ${stages.length} 阶段`
              : "阶段待确认"}{" "}
            ·{" "}
            {buildDuration(
              progress.startedAt,
              progress.status === "completed" ? progress.updatedAt : null,
              now,
            )}
          </p>
        </div>
        <a
          href={progress.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex w-fit shrink-0 items-center gap-2 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-white/[.04]"
        >
          <StatusIcon
            status={progress.status}
            conclusion={progress.conclusion}
            size={16}
          />
          {buildStatusLabel(progress.status, progress.conclusion)}
          <IconExternalLink aria-hidden="true" size={14} stroke={1.8} />
        </a>
      </div>
      {stages.length ? (
        <div className="deployment-build-stages">
          {stages.map((stage) => {
            const current = stage.jobs
              .flatMap((job) => job.steps)
              .find((step) => step.status === "in_progress");
            const failed = stage.jobs.filter(failedBuild).length;
            const done = stage.jobs.filter(
              (job) => job.status === "completed",
            ).length;
            const grouped = stage.jobs.length > 1;
            const tone = failed
              ? "border-red-300 bg-red-50/60 dark:border-red-400/35 dark:bg-red-400/[.05]"
              : stage.status === "in_progress"
                ? "border-amber-300 bg-amber-50/60 dark:border-amber-400/35 dark:bg-amber-400/[.05]"
                : "border-slate-200 bg-slate-50/70 dark:border-slate-700 dark:bg-slate-950/20";
            return (
              <div key={stage.id} className="contents">
                <details
                  data-build-stage={stage.id}
                  open={
                    (!grouped && stage.status === "in_progress") || failed > 0
                      ? true
                      : undefined
                  }
                  className={`group min-w-0 flex-1 rounded-xl border ${tone} open:bg-white dark:open:bg-white/[.025]`}
                >
                  <summary className="flex min-h-16 cursor-pointer list-none items-start gap-3 px-3.5 py-3 [&::-webkit-details-marker]:hidden">
                    <span className="mt-0.5 shrink-0">
                      <StatusIcon
                        status={stage.status}
                        conclusion={stage.conclusion}
                      />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block break-words text-sm font-medium text-slate-800 dark:text-slate-200">
                        {workflowLabel(stage.name)}
                      </span>
                      <span className="mt-0.5 block break-words text-xs text-slate-500">
                        {info(
                          grouped
                            ? `${done} / ${stage.jobs.length} 组已结束${failed ? ` · ${failed} 组失败` : ""}`
                            : current
                              ? workflowLabel(current.name)
                              : buildStatusLabel(
                                  stage.status,
                                  stage.conclusion,
                                ),
                          stage.conclusion === "skipped"
                            ? "已跳过"
                            : buildDuration(
                                stage.startedAt,
                                stage.completedAt,
                                now,
                              ),
                        )}
                      </span>
                    </span>
                    <IconChevronRight
                      aria-hidden="true"
                      className="mt-0.5 shrink-0 text-slate-400 transition-transform duration-200 group-open:rotate-90"
                      size={16}
                      stroke={1.8}
                    />
                  </summary>
                  {grouped ? (
                    <div className="border-t border-slate-200 px-2 py-1 dark:border-slate-800">
                      {stage.jobs.map((job) => {
                        const step = job.steps.find(
                          (item) => item.status === "in_progress",
                        );
                        return (
                          <details
                            key={job.id}
                            data-build-job={job.id}
                            open={failedBuild(job) ? true : undefined}
                            className="group/job border-b border-slate-200 last:border-b-0 dark:border-slate-800"
                          >
                            <summary className="flex cursor-pointer list-none items-start gap-2 px-1.5 py-2.5 [&::-webkit-details-marker]:hidden">
                              <span className="mt-0.5 shrink-0">
                                <StatusIcon
                                  status={job.status}
                                  conclusion={job.conclusion}
                                  size={15}
                                />
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block text-xs font-medium">
                                  {workflowLabel(job.name)}
                                </span>
                                <span className="mt-1 block break-words text-xs text-slate-500">
                                  {info(
                                    step
                                      ? workflowLabel(step.name)
                                      : buildStatusLabel(
                                          job.status,
                                          job.conclusion,
                                        ),
                                    job.conclusion === "skipped"
                                      ? "已跳过"
                                      : buildDuration(
                                          job.startedAt,
                                          job.completedAt,
                                          now,
                                        ),
                                  )}
                                </span>
                              </span>
                              <IconChevronRight
                                aria-hidden="true"
                                className="mt-0.5 shrink-0 text-slate-400 transition-transform group-open/job:rotate-90"
                                size={14}
                              />
                            </summary>
                            <Steps job={job} now={now} />
                          </details>
                        );
                      })}
                    </div>
                  ) : (
                    stage.jobs[0].steps.length > 0 && (
                      <Steps job={stage.jobs[0]} now={now} />
                    )
                  )}
                </details>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="px-5 py-8 text-center text-sm text-slate-500">
          {progress.jobs === null
            ? "构建阶段暂不可用，请稍后刷新"
            : "GitHub 正在创建构建任务…"}
        </p>
      )}
    </section>
  );
}
