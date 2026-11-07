/** GitHub's workflow rename also changes the default title of older runs. */
export const IMAGE_WORKFLOW_NAME = "Build and publish Alcor image";
const renamedTitles = new Set([
  IMAGE_WORKFLOW_NAME,
  "Build and publish Fire image",
  "Fire 检查与镜像发布",
  "Fire 构建发布",
  "Fire 手动发布：检查并构建当前版本",
  "Fire 定时发布：检查并构建最新变更",
]);
const requestMarker = / · (?:[a-f0-9]{40}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i;
export function deploymentRunTitle(run: {name: string; title: string; event: string; workflowPath: string}) {
  const title = run.title || run.name;
  if (run.workflowPath !== ".github/workflows/docker-publish.yml" || !["schedule", "workflow_dispatch"].includes(run.event)) return title;
  // Normalize only known default release titles. Keep custom/commit titles and raw receipts intact.
  return renamedTitles.has(title.replace(requestMarker, "")) ? IMAGE_WORKFLOW_NAME : title;
}
