"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { mobileGestureAxis, shouldFinishMobileBack } from "@/lib/mobileNavigation";

/** Passive listeners preserve native vertical inertia, pinch zoom and nested horizontal controls. */
export default function MobileBackGesture({ onBack, children }: { onBack: () => void; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const callback = useRef(onBack);
  callback.current = onBack;
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const mobile = window.matchMedia("(max-width:767px)");
    const reduced = window.matchMedia("(prefers-reduced-motion:reduce)");
    let gesture: { id: number; x: number; y: number; width: number; dx: number; lastX: number; lastTime: number; velocity: number; axis: "pending" | "back" | "scroll" } | null = null;
    let frame = 0;
    let animation: Animation | null = null;
    const reset = () => { element.style.transform = ""; element.style.willChange = ""; element.removeAttribute("data-dragging"); };
    const settle = (finish: boolean) => {
      cancelAnimationFrame(frame);
      frame = 0;
      const distance = gesture?.dx || 0;
      gesture = null;
      const complete = () => { animation = null; reset(); if (finish) callback.current(); };
      if (reduced.matches || distance <= 0) { complete(); return; }
      animation = element.animate([{ transform: `translate3d(${distance}px,0,0)`, opacity: 1 }, { transform: finish ? `translate3d(${Math.max(distance, element.clientWidth * .65)}px,0,0)` : "translate3d(0,0,0)", opacity: finish ? 0 : 1 }], { duration: finish ? 170 : 200, easing: "cubic-bezier(.2,.8,.2,1)", fill: "forwards" });
      const current = animation;
      animation.onfinish = () => { current.cancel(); complete(); };
    };
    const start = (event: TouchEvent) => {
      if (gesture && event.touches.length !== 1) { settle(false); return; }
      if (!mobile.matches || animation || event.touches.length !== 1 || document.querySelector('[role="dialog"]')) return;
      const touch = event.touches[0];
      // Leave the OS/browser edge-back zone alone, and never steal chart/table/control gestures.
      if (touch.clientX < 24 || touch.clientX > window.innerWidth - 24 || !(event.target instanceof Element) || event.target.closest('button,a,input,select,textarea,summary,table,canvas,svg,[role="slider"],[role="tablist"],[data-no-back-gesture]')) return;
      for (let node: Element | null = event.target; node && node !== element; node = node.parentElement) {
        if (node.scrollWidth > node.clientWidth + 2 && /auto|scroll/.test(getComputedStyle(node).overflowX)) return;
      }
      gesture = { id: touch.identifier, x: touch.clientX, y: touch.clientY, width: element.clientWidth, dx: 0, lastX: touch.clientX, lastTime: performance.now(), velocity: 0, axis: "pending" };
    };
    const move = (event: TouchEvent) => {
      if (!gesture) return;
      if (event.touches.length !== 1) { settle(false); return; }
      const touch = Array.from(event.touches).find(item => item.identifier === gesture?.id);
      if (!touch) { settle(false); return; }
      const dx = touch.clientX - gesture.x, dy = touch.clientY - gesture.y;
      if (gesture.axis === "pending") {
        gesture.axis = mobileGestureAxis(dx, dy);
        if (gesture.axis === "back") {
          element.setAttribute("data-dragging", "true");
          if (!reduced.matches) element.style.willChange = "transform";
        }
      }
      if (gesture.axis === "back" && Math.abs(dy) > Math.abs(dx) * 1.3) { settle(false); return; }
      if (gesture.axis !== "back") return;
      const now = performance.now();
      gesture.velocity = (touch.clientX - gesture.lastX) / Math.max(1, now - gesture.lastTime);
      gesture.lastTime = now; gesture.lastX = touch.clientX;
      gesture.dx = Math.max(0, Math.min(dx, gesture.width * .8));
      if (!frame) frame = requestAnimationFrame(() => {
        frame = 0;
        if (!gesture) return;
        if (!reduced.matches) element.style.transform = `translate3d(${gesture.dx}px,0,0)`;
      });
    };
    const end = () => {
      if (!gesture) return;
      const recentVelocity = performance.now() - gesture.lastTime < 100 ? gesture.velocity : 0;
      settle(gesture.axis === "back" && shouldFinishMobileBack(gesture.dx, gesture.width, recentVelocity));
    };
    const cancel = () => { if (gesture) settle(false); };
    const options = { passive: true };
    element.addEventListener("touchstart", start, options);
    element.addEventListener("touchmove", move, options);
    element.addEventListener("touchend", end, options);
    element.addEventListener("touchcancel", cancel, options);
    window.addEventListener("resize", cancel);
    return () => {
      element.removeEventListener("touchstart", start); element.removeEventListener("touchmove", move);
      element.removeEventListener("touchend", end); element.removeEventListener("touchcancel", cancel);
      window.removeEventListener("resize", cancel); cancelAnimationFrame(frame); animation?.cancel(); reset();
    };
  }, []);
  return <div ref={root} className="mobile-back-gesture">{children}</div>;
}
