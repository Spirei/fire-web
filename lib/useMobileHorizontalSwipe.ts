"use client";

import { useRef, type TouchEvent } from "react";

export type SwipeDirection = "left" | "right";
type Point = { x: number; y: number };

/** 窄屏预览与有触摸屏的设备都可使用；普通桌面指针不接管横向滚动。 */
export function acceptsSwipeTouch(width: number, hasCoarsePointer: boolean): boolean {
  return width < 768 || hasCoarsePointer;
}

/** 只识别明确的横向手势，避免把列表上下滚动误判成切换。 */
export function horizontalSwipeDirection(start: Point, end: Point): SwipeDirection | null {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (Math.abs(dx) < 48 || Math.abs(dx) <= Math.abs(dy) * 1.4) return null;
  return dx < 0 ? "left" : "right";
}

export function useMobileHorizontalSwipe(onSwipe: (direction: SwipeDirection) => void) {
  const start = useRef<Point | null>(null);

  return {
    "data-no-back-gesture": "true" as const,
    onTouchStart(event: TouchEvent<HTMLElement>) {
      const touch = event.touches[0];
      const width = window.innerWidth;
      const touchDevice = acceptsSwipeTouch(width, window.matchMedia("(any-pointer: coarse)").matches);
      // 两侧 24px 留给浏览器/系统的返回手势；只处理单指触摸。
      start.current = touchDevice && event.touches.length === 1 && touch.clientX >= 24 && touch.clientX <= width - 24
        ? { x: touch.clientX, y: touch.clientY }
        : null;
    },
    onTouchEnd(event: TouchEvent<HTMLElement>) {
      const origin = start.current;
      start.current = null;
      const touch = event.changedTouches[0];
      if (!origin || !touch) return;
      const direction = horizontalSwipeDirection(origin, { x: touch.clientX, y: touch.clientY });
      if (direction) onSwipe(direction);
    },
    onTouchCancel() { start.current = null; }
  };
}
