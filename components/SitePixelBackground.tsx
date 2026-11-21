"use client";

import { useEffect, useRef, type CSSProperties } from "react";

const CELL_SIZE = 10;
const MAX_TILES = 44;
const MAX_STEPS_PER_MOVE = 6;
const MAX_LINK_DISTANCE = 24;
const INTERACTIVE_TARGETS = "a, button, input, select, textarea, [contenteditable]:not([contenteditable='false']), [role='button'], [role='dialog']";

export default function SitePixelBackground() {
  const trailRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = trailRef.current;
    if (!element) return;
    const trail = element;
    const root = document.documentElement;
    const canAnimate = window.matchMedia("(any-hover: hover) and (any-pointer: fine) and (prefers-reduced-motion: no-preference)");
    const tiles = new Map<string, HTMLSpanElement>();
    let previous: { col: number; row: number; time: number } | null = null;

    function resetPosition() {
      previous = null;
    }

    function clear() {
      resetPosition();
      tiles.clear();
      trail.replaceChildren();
    }

    function addTile(col: number, row: number, age: number) {
      const key = `${col},${row}`;
      tiles.get(key)?.remove();
      tiles.delete(key);
      if (tiles.size === MAX_TILES) {
        const oldest = tiles.entries().next().value;
        if (oldest) {
          const [oldestKey, oldestTile] = oldest;
          oldestTile.remove();
          tiles.delete(oldestKey);
        }
      }

      const hash = Math.imul(col + 1, 0x45d9f3b) ^ Math.imul(row + 1, 0x119de1f3);
      const color = ((hash ^ (hash >>> 16)) >>> 0) % 6;
      const tile = document.createElement("span");
      tile.className = "site-pixel-tile";
      tile.dataset.cell = key;
      tile.style.left = `${col * CELL_SIZE}px`;
      tile.style.top = `${row * CELL_SIZE}px`;
      tile.style.animationDelay = `${-age}ms`;
      tile.style.backgroundColor = `var(--site-pixel-color-${color})`;
      tiles.set(key, tile);
      trail.append(tile);
    }

    function move(event: PointerEvent) {
      const target = event.target;
      if (event.pointerType !== "mouse" || event.buttons !== 0 ||
          !(target instanceof Element) || !target.closest(".app-shell-main, .site-login-shell") ||
          target.closest(INTERACTIVE_TARGETS)) {
        resetPosition();
        return;
      }

      const col = Math.floor(event.clientX / CELL_SIZE);
      const row = Math.floor(event.clientY / CELL_SIZE);
      const time = event.timeStamp;
      const start = previous && time - previous.time < 180 ? previous : null;
      previous = { col, row, time };
      if (!start) {
        addTile(col, row, 0);
        return;
      }

      const dx = col - start.col;
      const dy = row - start.row;
      const distance = Math.max(Math.abs(dx), Math.abs(dy));
      if (distance > MAX_LINK_DISTANCE) {
        addTile(col, row, 0);
        return;
      }
      const steps = Math.min(MAX_STEPS_PER_MOVE, distance);
      for (let step = 1; step <= steps; step++) {
        const remaining = 1 - step / steps;
        const x = col - Math.round(dx * remaining);
        const y = row - Math.round(dy * remaining);
        addTile(x, y, Math.round(remaining * Math.min(time - start.time, 140)));
      }
    }

    function removeTile(event: AnimationEvent) {
      const tile = event.target;
      if (!(tile instanceof HTMLElement) || tile.parentElement !== trail) return;
      const key = tile.dataset.cell;
      if (key && tiles.get(key) === tile) tiles.delete(key);
      tile.remove();
    }

    function leave(event: PointerEvent) {
      if (!event.relatedTarget) resetPosition();
    }

    function sync() {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerdown", resetPosition);
      window.removeEventListener("pointerout", leave);
      clear();
      if (canAnimate.matches && !document.hidden &&
          root.dataset.platformPixelBackground === "true" && root.dataset.platformReduced !== "true") {
        window.addEventListener("pointermove", move, { passive: true });
        window.addEventListener("pointerdown", resetPosition, { passive: true });
        window.addEventListener("pointerout", leave, { passive: true });
      }
    }

    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ["data-platform-pixel-background", "data-platform-reduced"] });
    trail.addEventListener("animationend", removeTile);
    canAnimate.addEventListener("change", sync);
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("blur", clear);
    sync();
    return () => {
      observer.disconnect();
      trail.removeEventListener("animationend", removeTile);
      canAnimate.removeEventListener("change", sync);
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("blur", clear);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerdown", resetPosition);
      window.removeEventListener("pointerout", leave);
      clear();
    };
  }, []);

  return (
    <div aria-hidden="true" className="site-pixel-background" style={{ "--site-pixel-size": `${CELL_SIZE}px` } as CSSProperties}>
      <div ref={trailRef} />
    </div>
  );
}
