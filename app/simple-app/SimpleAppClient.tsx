"use client";

import Script from "next/script";
import { useEffect, useLayoutEffect } from "react";

const WINDOW_KEY = "fire-simple-win";

export default function SimpleAppClient() {
  useLayoutEffect(() => {
    try {
      document.documentElement.classList.toggle("dark", localStorage.getItem("fire-simple-theme") === "dark");
      const saved = JSON.parse(localStorage.getItem(WINDOW_KEY) || "null") as { w?: number } | null;
      if (saved && Number.isFinite(saved.w)) {
        document.documentElement.style.setProperty("--saved-win-w", `${Math.max(360, saved.w!)}px`);
      }
    } catch {}
  }, []);

  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;
    let current = "";
    let stopped = false;
    const check = async () => {
      try {
        const response = await fetch("/api/simple-app/dev-version", { cache: "no-store" });
        const next = await response.text();
        if (stopped) return;
        if (current && next && next !== current) location.reload();
        current = next;
      } catch {}
    };
    void check();
    const timer = window.setInterval(check, 700);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <>
      <div className="win" id="win">
        <div className="win-bar" id="winBar" title="按住拖动窗口">
          <button type="button" id="pinBtn" title="固定窗口" aria-label="固定窗口" onClick={() => window.togglePin?.()}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 4v5l3 3v2H7v-2l3-3V4"/><path d="M9 4h6"/><path d="M12 14v6"/></svg>
          </button>
          <button type="button" id="themeBtn" title="浅色 / 深色" aria-label="浅色深色切换" onClick={() => window.toggleTheme?.()}>
            <span className="th-wrap" aria-hidden="true">
              <svg className="th-sun" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <circle cx="12" cy="12" r="4.5"/><path d="M12 2.5v2.3M12 19.2v2.3M2.5 12h2.3M19.2 12h2.3M4.9 4.9l1.6 1.6M17.5 17.5l1.6 1.6M4.9 19.1l1.6-1.6M17.5 6.5l1.6-1.6"/>
              </svg>
              <svg className="th-moon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>
            </span>
          </button>
        </div>
        <div className="win-body" id="app" />
        <div className="dock" id="foot" />
        <div className="sk-full" id="skFull" />
        {(["nw", "n", "ne", "e", "w", "sw", "s", "se"] as const).map((direction) => (
          <i className={`handle ${direction}`} data-dir={direction} key={direction} />
        ))}
      </div>
      <div className="mask" id="mask" onClick={(event) => {
        if (event.target === event.currentTarget) window.closeMask?.();
      }} />
      <div className="toast" id="toast" />
      <Script
        src="/simple-app-runtime.js"
        strategy="afterInteractive"
        onReady={() => {
          if (!document.getElementById("app")?.childElementCount) window.remountSimpleApp?.();
        }}
      />
    </>
  );
}

declare global {
  interface Window {
    togglePin?: () => void;
    toggleTheme?: () => void;
    closeMask?: () => void;
    remountSimpleApp?: () => void;
  }
}
