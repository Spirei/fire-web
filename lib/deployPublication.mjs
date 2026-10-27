export const IMAGE_WORKFLOW = '.github/workflows/docker-publish.yml';
export const PUBLISH_JOB = 'Publish linux/amd64 image';

/** @param {{ event: string, path?: string, workflowPath?: string }} run */
export function isImageRun(run) {
  return (run.path || run.workflowPath) === IMAGE_WORKFLOW && ['schedule', 'workflow_dispatch'].includes(run.event);
}

/** @param {{status:string, conclusion:string|null}} run @param {Array<{name:string, conclusion:string|null}>} jobs */
export function publicationOutcome(run, jobs) {
  if (run.status !== 'completed') return 'pending';
  const publish = jobs.find(job => job.name === PUBLISH_JOB);
  if (run.conclusion === 'success' && publish?.conclusion === 'success') return 'published';
  if (run.conclusion === 'success' && publish?.conclusion === 'skipped') return 'reused';
  if (run.conclusion !== 'success') return 'failed';
  return 'unknown';
}

/** Search successful release runs independently of ordinary push checks and skipped runs.
 * @param {(path:string)=>Promise<any>} api
 * @param {string} [sha]
 */
export async function findPublishedRun(api, sha) {
  for (let page = 1; page <= 20; page++) {
    const data = await api(`/actions/workflows/docker-publish.yml/runs?branch=main&status=success&per_page=100&page=${page}${sha ? `&head_sha=${encodeURIComponent(sha)}` : ''}`);
    if (!Array.isArray(data.workflow_runs)) throw new Error('GitHub 运行记录不完整');
    for (const run of data.workflow_runs) {
      if (!isImageRun(run) || (sha && run.head_sha !== sha)) continue;
      const result = await api(`/actions/runs/${run.id}/jobs?per_page=100`);
      if (!Array.isArray(result.jobs)) throw new Error('GitHub 发布步骤不完整');
      if (publicationOutcome(run, result.jobs) === 'published') return run;
    }
    if (data.workflow_runs.length < 100) return null;
  }
  throw new Error('GitHub 发布记录未核对完整，请稍后重试');
}
