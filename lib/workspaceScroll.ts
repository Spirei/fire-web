/** Claim history restoration after a workspace navigation; initial refresh stays browser-owned. */
export function ownWorkspaceScroll(history: Pick<History, "scrollRestoration">, events: Pick<Window, "addEventListener" | "removeEventListener">) {
  const previous = history.scrollRestoration;
  const claim = () => { history.scrollRestoration = "manual"; };
  const release = () => { history.scrollRestoration = previous; };
  claim();
  // A reload/full navigation returns restoration to the browser; BFCache return reclaims it.
  events.addEventListener("pagehide", release);
  events.addEventListener("pageshow", claim);
  return () => {
    events.removeEventListener("pagehide", release);
    events.removeEventListener("pageshow", claim);
    release();
  };
}

/** Restore a reload snapshot once content is ready; user input always wins. */
export function restoreWorkspaceScroll(element: HTMLElement, restore: () => void) {
  let frame = 0, stopped = false;
  const observer = new MutationObserver(check);
  const inputs = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
  function stop() {
    stopped = true;
    observer.disconnect();
    cancelAnimationFrame(frame);
    inputs.forEach(type => window.removeEventListener(type, stop));
  }
  function check() {
    if (stopped || frame || element.querySelector('.workspace-view-loading, [data-feed-state="loading"]')) return;
    frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => {
      frame = 0;
      if (stopped) return;
      if (element.querySelector('.workspace-view-loading, [data-feed-state="loading"]')) return;
      stop();
      restore();
    }); });
  }
  inputs.forEach(type => window.addEventListener(type, stop, { passive: true }));
  observer.observe(element, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-feed-state"] });
  check();
  return stop;
}
