"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { IconCheck, IconChevronDown } from "@tabler/icons-react";
import { selectPopoverPlacement } from "@/lib/selectPopover";

export type AppSelectOption = { value: string; label: string; disabled?: boolean };

export default function AppSelect({ value, options, onChange, className = "", menuClassName = "", ariaLabel, disabled = false }: {
  value: string | number;
  options: AppSelectOption[];
  onChange: (value: string) => void;
  className?: string;
  menuClassName?: string;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 0, maxWidth: 300, maxHeight: 300, above: false });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const initialFocus = useRef(-1);
  const menuId = useId();
  const selected = options.find((option) => option.value === String(value));

  function place() {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const menu = menuRef.current;
    const viewport = window.visualViewport;
    const next = selectPopoverPlacement(rect, {
      width: menu?.offsetWidth || rect.width,
      // offset/scroll dimensions are unaffected by the opening scale animation.
      height: menu ? menu.scrollHeight + menu.offsetHeight - menu.clientHeight : options.length * 36 + 14
    }, { left: viewport?.offsetLeft ?? 0, top: viewport?.offsetTop ?? 0, width: viewport?.width ?? window.innerWidth, height: viewport?.height ?? window.innerHeight });
    setPosition(current => Object.keys(next).every(key => current[key as keyof typeof next] === next[key as keyof typeof next]) ? current : next);
  }

  function close(restoreFocus = true) {
    setOpen(false);
    if (restoreFocus) buttonRef.current?.focus({ preventScroll: true });
  }

  function focusOption(index: number) {
    const option = optionRefs.current[index], menu = menuRef.current;
    if (!option || !menu) return;
    option.focus({ preventScroll: true });
    // Scroll only this menu; scrollIntoView could also move the dialog/page behind it.
    if (option.offsetTop < menu.scrollTop) menu.scrollTop = option.offsetTop;
    else if (option.offsetTop + option.offsetHeight > menu.scrollTop + menu.clientHeight) menu.scrollTop = option.offsetTop + option.offsetHeight - menu.clientHeight;
  }

  function show(edge?: "first" | "last") {
    if (disabled || buttonRef.current?.matches(":disabled")) return;
    const enabled = options.map((option, index) => option.disabled ? -1 : index).filter(index => index >= 0);
    if (!enabled.length) return;
    const selectedIndex = options.findIndex(option => option.value === String(value) && !option.disabled);
    initialFocus.current = edge === "first" ? enabled[0] : edge === "last" ? enabled[enabled.length - 1] : selectedIndex >= 0 ? selectedIndex : enabled[0];
    place();
    setOpen(true);
  }

  function menuKey(event: ReactKeyboardEvent) {
    if (event.key === "Tab") { close(); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const enabled = options.map((option, index) => option.disabled ? -1 : index).filter(index => index >= 0);
    if (!enabled.length) return;
    const current = enabled.findIndex(index => optionRefs.current[index] === document.activeElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? enabled.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + enabled.length) % enabled.length;
    focusOption(enabled[next]);
  }

  useLayoutEffect(() => {
    if (!open) return;
    if (disabled) { close(false); return; }
    place();
    focusOption(initialFocus.current);
    // Opening owns initial focus. Data refreshes must not steal it again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, disabled]);

  useEffect(() => {
    if (!open) return;
    const dismiss = () => close(false);
    const outside = (event: Event) => {
      if (event.target instanceof Node && (menuRef.current?.contains(event.target) || buttonRef.current?.contains(event.target))) return;
      dismiss();
    };
    // Capture before the parent dialog's Escape handler: dismiss exactly one layer.
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    };
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", outside, true);
    window.addEventListener("keydown", key, true);
    document.addEventListener("focusin", outside);
    window.visualViewport?.addEventListener("resize", dismiss);
    return () => {
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", outside, true);
      window.removeEventListener("keydown", key, true);
      document.removeEventListener("focusin", outside);
      window.visualViewport?.removeEventListener("resize", dismiss);
    };
  }, [open]);

  return <>
    <button ref={buttonRef} type="button" disabled={disabled} aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? menuId : undefined} onClick={() => open ? close() : show()} onKeyDown={event => { if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); show(event.key === "ArrowUp" ? "last" : undefined); } }} className={`app-select-trigger inline-flex items-center justify-between gap-2 text-left outline-none disabled:cursor-not-allowed disabled:opacity-50 ${className}`}>
      <span className="min-w-0 truncate">{selected?.label ?? String(value)}</span><IconChevronDown className={`h-4 w-4 flex-none text-muted transition-transform duration-150 motion-reduce:transition-none ${open ? "rotate-180" : ""}`} />
    </button>
    {open && createPortal(<>
      <button type="button" tabIndex={-1} aria-label="关闭选择菜单" className="fixed inset-0 z-[11990] cursor-default" onMouseDown={event => event.preventDefault()} onClick={() => close()} />
      <div ref={menuRef} id={menuId} role="listbox" aria-label={ariaLabel} onKeyDown={menuKey} data-side={position.above ? "top" : "bottom"} style={{ left: position.left, top: position.top, minWidth: position.width, maxWidth: position.maxWidth, maxHeight: position.maxHeight }} className={`app-select-menu fixed z-[12000] overflow-auto overscroll-contain rounded-xl border border-edge bg-white p-1.5 shadow-[0_18px_50px_rgba(15,23,42,.18)] dark:bg-[#252525] dark:shadow-[0_20px_60px_rgba(0,0,0,.48)] ${menuClassName}`}>
        {options.map((option, index) => <button ref={node => { optionRefs.current[index] = node; }} key={option.value} type="button" role="option" tabIndex={-1} aria-selected={option.value === String(value)} disabled={option.disabled} onClick={() => { onChange(option.value); close(); }} className={`flex min-h-9 w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors disabled:opacity-40 ${option.value === String(value) ? "bg-bg-gray font-semibold text-ink dark:bg-white/10" : "text-ink-2 hover:bg-bg-gray dark:hover:bg-white/[.07]"}`}>
          <span className="min-w-0 flex-1 truncate">{option.label}</span>{option.value === String(value) && <IconCheck className="h-4 w-4 flex-none" />}
        </button>)}
      </div>
    </>, document.body)}
  </>;
}
