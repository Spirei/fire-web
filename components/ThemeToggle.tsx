"use client";

import { useEffect, useState } from "react";
import { applySiteTheme, THEME_CHANGE_EVENT, THEME_KEY, type SiteTheme } from "@/lib/theme";
export { THEME_KEY } from "@/lib/theme";

function applyTheme(dark: boolean, emit = true) {
  applySiteTheme(dark ? "dark" : "light", emit);
}

export default function ThemeToggle() {
  const [dark, setDark] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      setDark(localStorage.getItem(THEME_KEY) === "dark");
    } catch {
      /* 忽略存储异常 */
    }
    setReady(true);
  }, []);

  useEffect(() => {
    const sync = (event: Event) => setDark((event as CustomEvent<{ theme: SiteTheme }>).detail?.theme === "dark");
    window.addEventListener(THEME_CHANGE_EVENT, sync);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, sync);
  }, []);

  useEffect(() => {
    if (!ready) return;
    applyTheme(dark, false);
  }, [dark, ready]);

  const toggleTheme = () => {
    const next = !document.documentElement.classList.contains("dark");
    applyTheme(next);
    setDark(next);
  };

  return (
    <button
      type="button"
      onClick={toggleTheme}
      className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-edge-strong text-muted transition-colors hover:bg-brand-hover hover:text-ink"
      title={dark ? "切换到浅色" : "切换到深色"}
      aria-label="切换深浅色"
    >
      {/* 太阳（浅色模式显示） */}
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 dark:hidden">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2" /><path d="M12 20v2" /><path d="m4.9 4.9 1.4 1.4" /><path d="m17.7 17.7 1.4 1.4" />
        <path d="M2 12h2" /><path d="M20 12h2" /><path d="m4.9 19.1 1.4-1.4" /><path d="m17.7 6.3 1.4-1.4" />
      </svg>
      {/* 月亮（深色模式显示） */}
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="hidden h-4 w-4 dark:block">
        <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
      </svg>
    </button>
  );
}
