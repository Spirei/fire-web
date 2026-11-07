const scrollLocks = new WeakMap<HTMLElement, { count: number; overflow: string }>();

/** Overlapping overlays may unmount in any order; only the last owner restores scrolling. */
export function lockScroll(element: HTMLElement = document.body) {
  const state = scrollLocks.get(element) ?? { count: 0, overflow: element.style.overflow };
  state.count++;
  scrollLocks.set(element, state);
  element.style.overflow = "hidden";
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--state.count === 0) {
      element.style.overflow = state.overflow;
      scrollLocks.delete(element);
    }
  };
}

/** System confirmations sit above ordinary dialogs; equal layers follow portal paint order. */
export function isTopPriorityModal(panel: HTMLElement | null) {
  if (!panel) return false;
  const layers = Array.from(document.querySelectorAll<HTMLElement>("[data-priority-modal='true']"));
  const top = layers.filter(layer => layer.dataset.systemModal === "true").at(-1) ?? layers.at(-1);
  return Boolean(top?.contains(panel));
}

/** Keep keyboard navigation inside the active modal; nested menus handle their own keys first. */
export function trapModalTab(event: KeyboardEvent, panel: HTMLElement) {
  if (event.key !== "Tab") return;
  const controls = Array.from(panel.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex]:not([tabindex="-1"])'))
    .filter(node => !node.closest('[inert],[hidden]') && node.getAttribute("aria-hidden") !== "true" && node.tabIndex >= 0 && node.getClientRects().length > 0);
  const first = controls[0], last = controls[controls.length - 1], active = document.activeElement;
  if (!first) { event.preventDefault(); panel.focus(); return; }
  if (event.shiftKey && (active === first || active === panel || !panel.contains(active))) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && (active === last || !panel.contains(active))) { event.preventDefault(); first.focus(); }
}
