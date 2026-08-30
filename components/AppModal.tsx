"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const SIZES = {
  sm: "max-w-[400px]",
  md: "max-w-[540px]",
  lg: "max-w-[680px]",
  xl: "max-w-[880px]"
} as const;

type ModalSize = keyof typeof SIZES;

export default function AppModal({
  title,
  desc,
  onClose,
  children,
  size = "sm",
  className = ""
}: {
  title?: string;
  desc?: string;
  onClose: () => void;
  children: React.ReactNode;
  size?: ModalSize;
  className?: string;
}) {
  const [closing, setClosing] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // 自动聚焦面板，方便键盘操作
    panelRef.current?.focus({ preventScroll: true });
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function requestClose() {
    if (closing) return;
    setClosing(true);
    closeTimer.current = setTimeout(() => onClose(), 140);
  }

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 sm:p-8" role="dialog" aria-modal="true" aria-label={title || "弹窗"}>
      {/* 毛玻璃遮罩（iOS 风格），保持页面可读 */}
      <div
        className={`modal-scrim absolute inset-0 ${closing ? "modal-overlay-closing" : "modal-overlay"}`}
        onClick={requestClose}
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className={`modal-glass relative w-full ${SIZES[size]} ${className} max-h-[calc(100vh-2rem)] overflow-y-auto rounded-[26px] border border-white/60 p-6 shadow-[0_24px_64px_rgba(0,0,0,.22)] outline-none dark:border-white/10 dark:shadow-[0_24px_64px_rgba(0,0,0,.5)] sm:rounded-[28px] sm:p-7 ${
          closing ? "modal-panel-closing" : "modal-panel"
        }`}
      >
        <div className="mb-5 flex items-start justify-between gap-3">
          <div className="min-w-0">
            {title && <h3 className="text-[19px] font-bold leading-snug text-ink">{title}</h3>}
            {desc && <p className="mt-1 text-[13px] text-muted">{desc}</p>}
          </div>
          <button
            type="button"
            onClick={requestClose}
            className="inline-flex h-8 w-8 flex-none items-center justify-center rounded-full text-muted transition-colors duration-200 hover:bg-black/5 hover:text-ink dark:hover:bg-white/10"
            aria-label="关闭"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-4 w-4">
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body
  );
}
