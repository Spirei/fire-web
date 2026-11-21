"use client";

import { useEffect, useRef, type CSSProperties } from "react";

const CELL_SIZE = 10;
const MAX_TILES = 56;
const MAX_STEPS_PER_MOVE = 6;

export default function SitePixelBackground() {
  const trailRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = trailRef.current;
    if (!element) return;
    const trail = element;
    const root = document.documentElement;
    const canAnimate = window.matchMedia("(any-hover: hover) and (any-pointer: fine) and (prefers-reduced-motion: no-preference)");
    let previous: { col: number; row: number; time: number } | null = null;

    function clear() {
      previous = null;
      trail.replaceChildren();
    }

    function move(event: PointerEvent) {
      if (event.pointerType !== "mouse" || event.buttons !== 0 ||
          !(event.target instanceof Element) || !event.target.closest(".app-shell-main, .site-login-shell")) {
        previous = null;
        return;
      }

      const col = Math.floor(event.clientX / CELL_SIZE);
      const row = Math.floor(event.clientY / CELL_SIZE);
      const time = event.timeStamp;
      const start = previous && time - previous.time < 180 ? previous : null;
      previous = { col, row, time };

      const dx = start ? col - start.col : 0;
      const dy = start ? row - start.row : 0;
      const steps = start ? Math.min(MAX_STEPS_PER_MOVE, Math.max(Math.abs(dx), Math.abs(dy))) : 1;
      for (let step = 1; step <= steps; step++) {
        const x = col - Math.round(dx * (1 - step / steps));
        const y = row - Math.round(dy * (1 - step / steps));
        const tile = document.createElement("span");
        tile.className = "site-pixel-tile";
        tile.style.left = `${x * CELL_SIZE}px`;
        tile.style.top = `${y * CELL_SIZE}px`;
        tile.style.backgroundColor = `var(--site-pixel-color-${Math.abs(x * 7 + y * 13) % 6})`;
        if (trail.childElementCount >= MAX_TILES) trail.firstElementChild?.remove();
        trail.append(tile);
      }
    }

    function removeTile(event: AnimationEvent) {
      if (event.target instanceof HTMLElement && event.target.parentElement === trail) event.target.remove();
    }

    function sync() {
      window.removeEventListener("pointermove", move);
      clear();
      if (canAnimate.matches && !document.hidden &&
          root.dataset.platformPixelBackground === "true" && root.dataset.platformReduced !== "true") {
        window.addEventListener("pointermove", move, { passive: true });
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
      clear();
    };
  }, []);

  return (
    <div aria-hidden="true" className="site-pixel-background" style={{ "--site-pixel-size": `${CELL_SIZE}px` } as CSSProperties}>
      <div ref={trailRef} />
    </div>
  );
}
