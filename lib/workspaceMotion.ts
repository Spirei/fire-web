/** A short entrance on deliberate navigation; never hide the server-rendered first frame. */
export function animateWorkspaceEntrance(panel: HTMLElement) {
  const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
  if (preference.matches || typeof panel.animate !== "function") return () => {};

  let started = false;
  const animations: Animation[] = [];
  const observer = new MutationObserver(reveal);
  const timeout = window.setTimeout(stop, 5000);

  function stop() {
    observer.disconnect();
    window.clearTimeout(timeout);
    preference.removeEventListener("change", onPreference);
    animations.forEach(animation => animation.cancel());
  }
  function onPreference() { if (preference.matches) stop(); }
  function reveal() {
    if (started || panel.hidden || panel.querySelector(".workspace-view-loading")) return;
    started = true;
    observer.disconnect();
    window.clearTimeout(timeout);
    const bounds = panel.closest(".records-content")?.getBoundingClientRect();
    const top = Math.max(0, bounds?.top ?? 0);
    const bottom = Math.min(window.innerHeight, bounds?.bottom ?? window.innerHeight);
    const targets = Array.from(panel.querySelectorAll<HTMLElement>("[data-workspace-reveal]"))
      .filter(element => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.bottom > top && rect.top < bottom;
      })
      // Modules are sortable: animate in visual order, not their original DOM order.
      .sort((a, b) => {
        const left = a.getBoundingClientRect(), right = b.getBoundingClientRect();
        return Math.abs(left.top - right.top) > 24 ? left.top - right.top : left.left - right.left;
      }).slice(0, 8);

    if (!targets.length) {
      // Opacity only: a root transform would change the containing block of fixed children.
      animations.push(panel.animate([{ opacity: .65 }, { opacity: 1 }], { duration: 180, easing: "ease-out" }));
    } else {
      targets.forEach((element, index) => animations.push(element.animate(
        [{ opacity: .4, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }],
        { duration: 280, delay: Math.min(index * 35, 105), easing: "cubic-bezier(.22,1,.36,1)", fill: "backwards" }
      )));
    }
  }

  preference.addEventListener("change", onPreference);
  observer.observe(panel, { childList: true, subtree: true });
  reveal();
  return stop;
}
