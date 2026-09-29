"use client";

import { useRef, type TouchEvent } from "react";

export type ProfitLossMode = "profit" | "loss";

type Point = { x: number; y: number };

/** 只把明确的横向手势视为切换；纵向滚动仍交给浏览器。 */
export function profitLossModeFromSwipe(start: Point, end: Point): ProfitLossMode | null {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (Math.abs(dx) < 48 || Math.abs(dx) <= Math.abs(dy) * 1.4) return null;
  return dx < 0 ? "loss" : "profit";
}

export function useProfitLossSwipe(onModeChange: (mode: ProfitLossMode) => void) {
  const start = useRef<Point | null>(null);

  return {
    onTouchStart(event: TouchEvent<HTMLElement>) {
      start.current = window.innerWidth < 640 && event.touches.length === 1
        ? { x: event.touches[0].clientX, y: event.touches[0].clientY }
        : null;
    },
    onTouchEnd(event: TouchEvent<HTMLElement>) {
      const origin = start.current;
      start.current = null;
      const touch = event.changedTouches[0];
      if (!origin || !touch) return;
      const mode = profitLossModeFromSwipe(origin, { x: touch.clientX, y: touch.clientY });
      if (mode) onModeChange(mode);
    },
    onTouchCancel() { start.current = null; }
  };
}
