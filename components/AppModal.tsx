"use client";

import { CloseButton } from "@/components/Capsule";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isTopPriorityModal, lockScroll, trapModalTab } from "@/lib/overlayLifecycle";

const SIZES = {
  xs: "max-w-[320px]",
  sm: "max-w-[380px]",
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
  titleAddon,
  size = "sm",
  className = "",
  draggable = false,
  closeDisabled = false,
  priority = false,
  hideHeader = false,
  footer
}: {
  title?: string;
  desc?: string;
  onClose: () => void;
  children: React.ReactNode | ((requestClose: () => void) => React.ReactNode);
  headerActions?: React.ReactNode;
  titleAddon?: React.ReactNode;
  size?: ModalSize;
  className?: string;
  draggable?: boolean;
  closeDisabled?: boolean;
  priority?: boolean;
  hideHeader?: boolean;
  footer?: React.ReactNode;
}) {
  const [mounted, setMounted] = useState(false);
  useLayoutEffect(() => { setMounted(true); }, []);
  const [closing, setClosing] = useState(false);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const panelRef = useRef<HTMLDivElement>(null);
  const originalFocus = useRef<HTMLElement | null>(typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closingRef = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const closeDisabledRef = useRef(closeDisabled);
  closeDisabledRef.current = closeDisabled;
  const dragRef = useRef<{ pointerId: number; x: number; y: number; startX: number; startY: number; rect: DOMRect } | null>(null);

  useEffect(() => {
    if (!mounted) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !isTopPriorityModal(panelRef.current)) return;
      if (e.key === "Tab" && panelRef.current) { trapModalTab(e, panelRef.current); return; }
      if (e.key !== "Escape" || e.repeat) return;
      e.preventDefault();
      e.stopPropagation();
      requestClose();
    };
    window.addEventListener("keydown", onKey);
    const unlockScroll = lockScroll();
    const previousFocus = originalFocus.current;
    const panel = panelRef.current;
    // Forms can place focus directly in their first required field.
    if (isTopPriorityModal(panel) && !panel?.contains(document.activeElement)) (panel?.querySelector<HTMLElement>("[data-autofocus]") || panel)?.focus({ preventScroll: true });
    return () => {
      window.removeEventListener("keydown", onKey);
      unlockScroll();
      if (closeTimer.current) clearTimeout(closeTimer.current);
      closeTimer.current = null;
      // Do not steal focus from a newer dialog or an explicit navigation target.
      if (previousFocus?.isConnected && (document.activeElement === document.body || panel?.contains(document.activeElement))) previousFocus.focus({ preventScroll: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted]);

  useEffect(() => {
    if (!mounted || !draggable) return;
    const recenter = () => setOffset({x:0,y:0});
    window.addEventListener("resize", recenter);
    window.visualViewport?.addEventListener("resize", recenter);
    return () => { window.removeEventListener("resize", recenter); window.visualViewport?.removeEventListener("resize", recenter); };
  }, [mounted, draggable]);

  function requestClose() {
    if (closingRef.current || closeDisabledRef.current) return;
    closingRef.current = true;
    setClosing(true);
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      if (closeDisabledRef.current) { closingRef.current = false; setClosing(false); return; }
      onCloseRef.current();
    }, window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 160);
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

  const content = (
    <div data-priority-modal="true" data-system-modal={priority ? "true" : undefined} className={`app-modal-layer fixed inset-0 ${priority ? "z-[12500]" : "z-[11000]"}`} role="dialog" aria-modal="true" aria-label={title || "弹窗"}>
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
        className={`app-modal-panel modal-glass relative w-full ${SIZES[size]} ${className} ${headerActions ? "modal-with-header-actions" : ""} ${closing ? "modal-panel-closing" : "modal-panel"}`}
      >
        {!hideHeader && <div className={`app-modal-header ${draggable ? "cursor-move touch-none select-none" : ""}`} onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={stopDrag} onPointerCancel={stopDrag}>
          <div className="min-w-0">
            {title && <h3 className={`text-[17px] font-semibold leading-snug text-ink ${titleAddon ? "flex flex-wrap items-center gap-3" : ""}`}>{title}{titleAddon}</h3>}
            {desc && <p className="mt-1 text-[13px] text-muted">{desc}</p>}
          </div>
          {headerActions && <div className="ml-auto min-w-0 flex-1 sm:max-w-[240px]">{headerActions}</div>}
          <CloseButton disabled={closeDisabled} onClick={requestClose} />
        </div>}
        <div className="app-modal-body">
        {typeof children === "function" ? children(requestClose) : children}
        </div>
        {footer && <div className="app-modal-footer">{footer}</div>}
      </div>
    </div>
  );
  return mounted ? createPortal(content, document.body) : content;
}

export function ModalActions({ children, className = "" }: {children: React.ReactNode; className?: string}) {
  return <div className={`app-modal-actions ${className}`}>{children}</div>;
}

/** Compact editor layout shared by simple forms, independent of page styles. */
export function ModalForm({ className = "", ...props }: React.FormHTMLAttributes<HTMLFormElement>) {
  return <form {...props} className={`app-modal-form ${className}`} />;
}
export function ModalField({ className = "", ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label {...props} className={`app-modal-field ${className}`} />;
}
export function ModalMedia({ preview, children, plain = false, card = false }: { preview: React.ReactNode; children: React.ReactNode; plain?: boolean; card?: boolean }) {
  return <div className="app-modal-media" data-plain={plain || undefined} data-card={card || undefined}><span className="app-modal-preview">{preview}</span>{children}</div>;
}

export function ModalChoiceGrid({ options, values, onChange, disabled = false }: {
  options: { value: string; label: string }[]; values: string[]; onChange: (values: string[]) => void; disabled?: boolean;
}) {
  return <div className="app-modal-choice-grid">{options.map(option => <label key={option.value} data-selected={values.includes(option.value) || undefined}>
    <input type="checkbox" checked={values.includes(option.value)} disabled={disabled}
      onChange={event => onChange(event.target.checked ? [...values, option.value] : values.filter(value => value !== option.value))} />
    <span>{option.label}</span>
  </label>)}</div>;
}
