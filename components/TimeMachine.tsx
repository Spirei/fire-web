"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { IconBrandTelegram, IconDots } from "@tabler/icons-react";
import DoraemonTravel, { DORAEMON_IMAGE } from "./DoraemonTravel";

export function TimeMachineLink({ to }: { to: "simple" | "full" }) {
  return <a href={to === "simple" ? "/simple-app" : "/records"} data-time-machine={to}
    className="fire-time-link" aria-label={`穿越至${to === "simple" ? "简化版" : "完整版"}`} title={`时光机 · 穿越至${to === "simple" ? "简化版" : "完整版"}`}>
    <span className="fire-time-link-orbit" aria-hidden="true"><IconBrandTelegram size={19} stroke={1.45} /></span>
    <span className="fire-time-link-label">去另一面</span>
    <span className="fire-time-link-destination">{to === "simple" ? "简化版" : "完整版"}</span>
  </a>;
}

export function TimeMachineMenu() {
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (event.target instanceof Node && !menu.current?.contains(event.target) && menu.current) menu.current.open = false;
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && menu.current) menu.current.open = false; };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, []);
  return <details className="fire-time-menu" ref={menu}>
    <summary aria-label="更多选项" title="更多选项"><IconDots size={18} stroke={1.6} /></summary>
    <div className="fire-time-menu-panel"><TimeMachineLink to="full" /></div>
  </details>;
}

export default function TimeMachine() {
  const router = useRouter();
  const pathname = usePathname();
  const [trip, setTrip] = useState<{ to: string; arriving: boolean } | null>(null);
  const [error, setError] = useState("");
  const active = useRef<{ to: string; started: number; reduced: boolean } | null>(null);
  const watchdog = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const image = new Image(); image.src = DORAEMON_IMAGE;
    router.prefetch(pathname === "/simple-app" ? "/records" : "/simple-app");
  }, [pathname, router]);

  useEffect(() => {
    const journey = active.current;
    if (!journey || (journey.to === "simple") !== (pathname === "/simple-app")) return;
    if (watchdog.current) clearTimeout(watchdog.current);
    const finish = setTimeout(() => {
      setTrip(current => current ? { ...current, arriving: true } : null);
    }, Math.max(0, journey.started + (journey.reduced ? 0 : 1400) - performance.now()));
    const clear = setTimeout(() => { setTrip(null); active.current = null; }, Math.max(0, journey.started + (journey.reduced ? 0 : 1850) - performance.now()));
    return () => { clearTimeout(finish); clearTimeout(clear); };
  }, [pathname]);

  useEffect(() => {
    let alive = true;
    const click = async (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[data-time-machine]") : null;
      if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || link.target === "_blank") return;
      event.preventDefault(); event.stopPropagation();
      if (active.current) return;
      const to = link.dataset.timeMachine === "simple" ? "simple" : "full";
      const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
      const journey = { to, started: performance.now(), reduced };
      active.current = journey;
      setError("");
      if (!reduced) setTrip({ to, arriving: false });
      const fail = (message: string) => {
        active.current = null; setTrip(null); setError(message);
      };
      const flush = (window as Window & { flushSimpleApp?: () => Promise<boolean> }).flushSimpleApp;
      if (location.pathname === "/simple-app" && flush) {
        let saved = false;
        try { saved = await flush(); } catch { /* Keep local edits on the current page. */ }
        if (!alive) return;
        if (!saved) { fail("账本尚未同步，请稍后再试"); return; }
      }
      if (!alive || active.current !== journey) return;
      // Client navigation loads in parallel with the artwork, without a document reload.
      router.push(link.pathname + link.search);
      watchdog.current = setTimeout(() => fail("页面加载较慢，请重新点击版本入口"), 15000);
    };
    document.addEventListener("click", click, true);
    return () => { alive = false; document.removeEventListener("click", click, true); if (watchdog.current) clearTimeout(watchdog.current); };
  }, [router]);
  return <>
    {trip && <div className={`fire-time-scene ${trip.arriving ? "is-arriving" : "is-departing"}`} role="status" aria-live="polite" aria-label={`正在进入${trip.to === "simple" ? "简化版" : "完整版"}`}>
      <DoraemonTravel />
    </div>}
    {error && <div className="fire-time-error" role="alert" onClick={() => setError("")}>{error}</div>}
  </>;
}
