/** One visible-page request at a time; resume only when its interval has elapsed. */
export function startVisiblePolling({
  read, interval,
}: {
  read: (signal: AbortSignal) => Promise<void>;
  interval: () => number;
}) {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let repeat = false;
  let suspended = false;
  let due = 0;

  const schedule = () => {
    clearTimeout(timer);
    if (!disposed && !document.hidden)
      timer = setTimeout(() => { void run(); }, Math.max(0, due - Date.now()));
  };
  function run(force = false): Promise<void> {
    if (force) due = 0;
    if (disposed || document.hidden) return Promise.resolve();
    if (pending) {
      if (force) { repeat = true; controller?.abort(); }
      return pending;
    }
    if (!force && Date.now() < due) { schedule(); return Promise.resolve(); }
    clearTimeout(timer);
    const current = controller = new AbortController();
    suspended = false;
    const deadline = setTimeout(() => current.abort(), 30000);
    pending = Promise.resolve().then(() => {
      if (!current.signal.aborted) return read(current.signal);
    }).catch(() => {
      // The consumer retains its last observation and handles its own error UI.
    }).finally(() => {
      clearTimeout(deadline);
      pending = undefined;
      if (disposed) return;
      due = suspended ? 0 : Date.now() + interval();
      if (repeat) { repeat = false; void run(true); }
      else schedule();
    });
    return pending;
  }
  const visibility = () => {
    if (document.hidden) { clearTimeout(timer); if (pending) { suspended = true; controller?.abort(); } }
    else void run();
  };
  document.addEventListener("visibilitychange", visibility);
  void run();
  return {
    refresh: () => run(true),
    stop() {
      disposed = true;
      repeat = false;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", visibility);
    },
  };
}
