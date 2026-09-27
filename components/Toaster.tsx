"use client";

import { useEffect, useState } from "react";
import { conciseToast, type ToastType } from "@/lib/toast";

interface ToastItem {
  id: number;
  text: string;
  type: ToastType;
  leaving: boolean;
}

export default function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    let next = 0;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    function later(callback: () => void, delay: number) {
      const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay);
      timers.add(timer);
    }
    function onToast(e: Event) {
      const d = (e as CustomEvent).detail as { text?: string; type?: ToastType };
      if (!d?.text) return;
      const id = ++next;
      const text = conciseToast(d.text);
      const type: ToastType = d.type === "err" ? "err" : d.type === "cancel" || text === "已取消" ? "cancel" : "ok";
      setItems((prev) => [...prev.filter(item => item.text !== text || item.type !== type), { id, text, type, leaving: false }].slice(-3));
      later(() => {
        setItems(prev => prev.map(item => item.id === id ? { ...item, leaving: true } : item));
        later(() => setItems(prev => prev.filter(item => item.id !== id)), 180);
      }, type === "err" ? Math.min(8000, Math.max(4000, text.length * 100)) : 2200);
    }
    window.addEventListener("fire:toast", onToast);
    return () => { window.removeEventListener("fire:toast", onToast); timers.forEach(clearTimeout); };
  }, []);

  return (
    /* z-index 必须高于设置详情（10900）及全站其他弹层，保证成功和错误反馈始终可见。 */
    <div className="pointer-events-none fixed left-0 right-0 top-[84px] z-[13000] flex flex-col items-center gap-2 px-4" role="region" aria-label="操作提示" aria-live="polite">
      {items.map((t) => (
        <div
          key={t.id}
          className={`fire-toast is-${t.type}${t.leaving ? " is-leaving" : ""}`}
          role={t.type === "err" ? "alert" : "status"}
        >
          <svg className="fire-toast-icon" viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <circle cx="12" cy="12" r="10" fill="currentColor" />
            <g className="fire-toast-symbol" stroke="#fff">
              {t.type === "ok" ? <path className="fire-toast-mark" pathLength="1" d="m7.5 12 3 3 6-6" /> : t.type === "err" ? <><path d="M12 7v6" /><circle cx="12" cy="16.5" r="1" fill="#fff" stroke="none" /></> : <path d="M8 12h8" />}
            </g>
          </svg>
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}
