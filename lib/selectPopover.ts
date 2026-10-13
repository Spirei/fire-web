type Rect = { left: number; top: number; bottom: number; width: number };
type Viewport = { left: number; top: number; width: number; height: number };

/** Keep the original menu size whenever it fits, with a 6px gap to its trigger. */
export function selectPopoverPlacement(trigger: Rect, menu: { width: number; height: number }, viewport: Viewport) {
  const margin = 8, gap = 6;
  const minLeft = viewport.left + margin, minTop = viewport.top + margin;
  const right = viewport.left + viewport.width - margin;
  const bottom = viewport.top + viewport.height - margin;
  const maxWidth = Math.max(0, viewport.width - margin * 2);
  const width = Math.min(Math.max(trigger.width, menu.width, 148), maxWidth);
  const below = Math.max(0, bottom - trigger.bottom - gap);
  const aboveRoom = Math.max(0, trigger.top - minTop - gap);
  const desiredHeight = Math.min(menu.height, 300);
  const above = below < desiredHeight && aboveRoom > below;
  const maxHeight = Math.min(300, above ? aboveRoom : below);
  const height = Math.min(menu.height, maxHeight);
  const left = Math.max(minLeft, Math.min(trigger.left, right - width));
  const top = Math.max(minTop, Math.min(above ? trigger.top - gap - height : trigger.bottom + gap, bottom - height));
  return { left, top, width, maxWidth, maxHeight, above };
}
