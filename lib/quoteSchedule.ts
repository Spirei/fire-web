/** One schedule for automatic, manual and foreground refreshes. Hidden tabs retain their deadline. */
export function createQuoteSchedule(options: {
  interval: number; refresh: (force: boolean) => void; hidden: () => boolean;
  now?: () => number; setTimer?: (fn: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}) {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? setTimeout, clearTimer = options.clearTimer ?? clearTimeout;
  let due = now() + options.interval;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  function arm() { if (!stopped) timer = setTimer(tick, Math.max(0, due - now())); }
  function tick() {
    if (stopped || options.hidden()) return;
    due = now() + options.interval;
    options.refresh(false); arm();
  }
  arm();
  return {
    manual() {
      if (stopped) return;
      if (timer !== undefined) clearTimer(timer);
      due = now() + options.interval;
      options.refresh(true); arm();
    },
    foreground() {
      if (stopped || options.hidden() || now() < due) return;
      if (timer !== undefined) clearTimer(timer);
      tick();
    },
    stop() { stopped = true; if (timer !== undefined) clearTimer(timer); }
  };
}
