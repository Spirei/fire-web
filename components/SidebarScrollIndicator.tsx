"use client";

import { useEffect, useRef, type RefObject } from "react";

/** Scroll position only changes this rail, never the workspace's React state. */
export default function SidebarScrollIndicator({ navRef, enabled, itemCount }: { navRef: RefObject<HTMLElement | null>; enabled: boolean; itemCount: number }) {
  const indicatorRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const nav = navRef.current;
    const indicator = indicatorRef.current;
    if (!enabled || !nav || !indicator) return;
    let frame = 0;
    const paint = () => {
      frame = 0;
      const railHeight = nav.clientHeight;
      const travel = nav.scrollHeight - railHeight;
      indicator.style.display = travel > 1 ? "" : "none";
      if (travel <= 1) return;
      const height = Math.min(railHeight, Math.max(32, railHeight * railHeight / nav.scrollHeight));
      indicator.style.height = `${height}px`;
      indicator.style.top = `${Math.max(0, Math.min(1, nav.scrollTop / travel)) * (railHeight - height) + 1}px`;
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(paint); };
    const observer = new ResizeObserver(schedule);
    observer.observe(nav);
    nav.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      observer.disconnect();
      nav.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      cancelAnimationFrame(frame);
    };
  }, [navRef, enabled, itemCount]);
  return <span ref={indicatorRef} aria-hidden="true" className="fire-sidebar-scroll-indicator" style={{ display: "none" }} />;
}
