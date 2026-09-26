/** Bound original-image work independently of the number of nearby preview tiles. */
export function createCardImageQueue(limit = 2) {
  type Job = { run: (signal: AbortSignal) => Promise<void>; controller: AbortController };
  const waiting: Job[] = [];
  let active = 0, paused = false;
  const pump = () => {
    while (!paused && active < limit && waiting.length) {
      const job = waiting.shift()!;
      if (job.controller.signal.aborted) continue;
      active++;
      void Promise.resolve().then(() => job.run(job.controller.signal)).catch(() => {}).finally(() => { active--; pump(); });
    }
  };
  return {
    enqueue(run: Job['run']) {
      const job = { run, controller: new AbortController() };
      waiting.push(job); pump();
      return () => { job.controller.abort(); const index = waiting.indexOf(job); if (index >= 0) waiting.splice(index, 1); };
    },
    pause(value: boolean) { paused = value; pump(); }
  };
}

export const wanderOriginalQueue = createCardImageQueue(2);
