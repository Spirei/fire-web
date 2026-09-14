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
  headerActions,
  size = "sm",
  className = "",
  draggable = false
}: {
  title?: string;
  desc?: string;
  onClose: () => void;
  children: React.ReactNode;
  headerActions?: React.ReactNode;
  size?: ModalSize;
  className?: string;
  draggable?: boolean;
}) {
  const [closing, setClosing] = useState(false);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const panelRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; startX: number; startY: number; rect: DOMRect } | null>(null);

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

  function startDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (!draggable || event.button !== 0 || (event.target as HTMLElement).closest("button, a, input, select, textarea")) return;
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, startX: offset.x, startY: offset.y, rect };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function moveDrag(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const margin = 8;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    const minDx = margin - drag.rect.left;
    const maxDx = window.innerWidth - margin - drag.rect.right;
    const minDy = margin - drag.rect.top;
    const maxDy = window.innerHeight - margin - drag.rect.bottom;
    setOffset({ x: drag.startX + Math.max(minDx, Math.min(maxDx, dx)), y: drag.startY + Math.max(minDy, Math.min(maxDy, dy)) });
  }

  function stopDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  return createPortal(
    <div className="fixed inset-0 z-[11000] flex items-center justify-center p-4 sm:p-8" role="dialog" aria-modal="true" aria-label={title || "弹窗"}>
      {/* 毛玻璃遮罩（iOS 风格），保持页面可读 */}
      <div
        className={`modal-scrim absolute inset-0 ${closing ? "modal-overlay-closing" : "modal-overlay"}`}
        onClick={requestClose}
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        style={draggable ? { translate: `${offset.x}px ${offset.y}px` } : undefined}
        className={`modal-glass relative w-full ${SIZES[size]} ${className} max-h-[calc(100vh-2rem)] overflow-y-auto rounded-[26px] border border-white/60 p-6 shadow-[0_24px_64px_rgba(0,0,0,.22)] outline-none dark:border-white/10 dark:shadow-[0_24px_64px_rgba(0,0,0,.5)] sm:rounded-[28px] sm:p-7 ${
          closing ? "modal-panel-closing" : "modal-panel"
        }`}
      >
        <div className={`mb-5 flex items-start justify-between gap-3 ${draggable ? "cursor-move touch-none select-none" : ""}`} onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={stopDrag} onPointerCancel={stopDrag}>
          <div className="min-w-0">
            {title && <h3 className="text-[19px] font-bold leading-snug text-ink">{title}</h3>}
            {desc && <p className="mt-1 text-[13px] text-muted">{desc}</p>}
          </div>
          {headerActions && <div className="ml-auto min-w-0 flex-1 sm:max-w-[240px]">{headerActions}</div>}
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
