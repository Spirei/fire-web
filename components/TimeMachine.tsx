"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { IconClockHour4 } from "@tabler/icons-react";
import DoraemonTravel, { DORAEMON_IMAGE } from "./DoraemonTravel";

export function TimeMachineLink({ to }: { to: "simple" | "full" }) {
  return <a href={to === "simple" ? "/simple-app" : "/records"} data-time-machine={to}
    className="fire-time-link" title={`时光机 · 穿越至${to === "simple" ? "简化版" : "完整版"}`}>
    <span className="fire-time-link-orbit"><IconClockHour4 size={18} stroke={1.65} /></span>
    <span>{to === "simple" ? "简化版" : "完整版"}</span>
  </a>;
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
