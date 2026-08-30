"use client";

import { useEffect, useState } from "react";

interface ToastItem {
  id: number;
  text: string;
  type: "ok" | "err";
}

export default function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    let next = 0;
    function onToast(e: Event) {
      const d = (e as CustomEvent).detail as { text?: string; type?: "ok" | "err" };
      if (!d?.text) return;
      const id = ++next;
      setItems((prev) => [...prev, { id, text: d.text!, type: d.type === "err" ? "err" : "ok" }]);
      setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), 2400);
    }
    window.addEventListener("fire:toast", onToast);
    return () => window.removeEventListener("fire:toast", onToast);
  }, []);

  return (
    <div className="pointer-events-none fixed left-0 right-0 top-[84px] z-[10001] flex flex-col items-center gap-2 px-4">
      {items.map((t) => (
        <div
          key={t.id}
          className={`toast-in flex items-center rounded-full px-5 py-2.5 text-sm font-medium shadow-pop ${
            t.type === "err" ? "bg-up text-white" : "bg-black text-white"
          }`}
        >
          {t.type === "ok" ? (
            <span className="mr-1.5 inline-flex h-4 w-4 items-center justify-center rounded-full bg-white text-ink-2 border border-edge-strong shadow-sm">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="h-2.5 w-2.5"><path d="m5 13 4 4L19 7" /></svg>
            </span>
          ) : (
            <span className="mr-1.5 inline-flex h-4 w-4 items-center justify-center rounded-full bg-white/25 text-xs font-bold">!</span>
          )}
          {t.text}
        </div>
      ))}
    </div>
  );
}
