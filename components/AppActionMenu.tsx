"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { selectPopoverPlacement } from "@/lib/selectPopover";

/** Compact action menu shared by portrait editors and other anchored actions. */
export default function AppActionMenu({ id, label, anchor, onClose, items }: {
  id: string; label: string; anchor: RefObject<HTMLButtonElement | null>; onClose: () => void;
  items: { label: string; icon: ReactNode; onClick: () => void; disabled?: boolean }[];
}) {
  const menu = useRef<HTMLDivElement>(null);
  const dismiss = useRef(onClose); dismiss.current = onClose;
  const [position, setPosition] = useState({left: 0, top: 0, width: 196, maxWidth: 196, maxHeight: 300});
  useLayoutEffect(() => {
    const rect = anchor.current?.getBoundingClientRect();
    if (!rect) return;
    const viewport = window.visualViewport;
    const placed = selectPopoverPlacement(rect, {width: 196, height: (menu.current?.scrollHeight || items.length * 38) + 12}, {
      left: viewport?.offsetLeft ?? 0, top: viewport?.offsetTop ?? 0,
      width: viewport?.width ?? window.innerWidth, height: viewport?.height ?? window.innerHeight,
    });
    setPosition(placed);
    menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({preventScroll: true});
  }, [anchor, items.length]);
  useEffect(() => {
    const close = (restore = false) => { dismiss.current(); if (restore) anchor.current?.focus({preventScroll: true}); };
    const outside = (event: Event) => {
      if (event.target instanceof Node && (menu.current?.contains(event.target) || anchor.current?.contains(event.target))) return;
      close();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Tab") {
        event.preventDefault(); event.stopImmediatePropagation(); close(true);
      }
    };
    const resize = () => close();
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    window.addEventListener("keydown", key, true);
    window.addEventListener("scroll", outside, true);
    window.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("resize", resize);
    return () => {
      document.removeEventListener("pointerdown", outside); document.removeEventListener("focusin", outside);
      window.removeEventListener("keydown", key, true); window.removeEventListener("scroll", outside, true);
      window.removeEventListener("resize", resize); window.visualViewport?.removeEventListener("resize", resize);
    };
  }, [anchor]);
  return createPortal(<div id={id} ref={menu} role="menu" aria-label={label} className="app-action-menu" style={position} onKeyDown={event => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus({preventScroll: true});
  }}>{items.map(item => <button key={item.label} type="button" role="menuitem" disabled={item.disabled} onClick={() => {dismiss.current(); item.onClick();}}>{item.icon}<span>{item.label}</span></button>)}</div>, document.body);
}
