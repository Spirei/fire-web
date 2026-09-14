"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconCheck, IconChevronDown } from "@tabler/icons-react";

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
  const [position, setPosition] = useState({ left: 0, top: 0, width: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const selected = options.find((option) => option.value === String(value));

  function place() {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.max(rect.width, 148);
    const roomBelow = window.innerHeight - rect.bottom;
    const estimatedHeight = Math.min(options.length * 40 + 12, 300);
    setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), top: roomBelow >= estimatedHeight + 8 ? rect.bottom + 6 : Math.max(8, rect.top - estimatedHeight - 6), width });
  }

  useEffect(() => {
    if (!open) return;
    place();
    const close = () => setOpen(false);
    const key = (event: KeyboardEvent) => event.key === "Escape" && close();
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("resize", close); window.removeEventListener("scroll", close, true); window.removeEventListener("keydown", key); };
  }, [open]);

  return <>
    <button ref={buttonRef} type="button" disabled={disabled} aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open} aria-controls={menuId} onClick={() => { if (!open) place(); setOpen((shown) => !shown); }} className={`inline-flex items-center justify-between gap-2 text-left outline-none disabled:cursor-not-allowed disabled:opacity-50 ${className}`}>
      <span className="min-w-0 truncate">{selected?.label ?? String(value)}</span><IconChevronDown className={`h-4 w-4 flex-none text-muted transition-transform duration-150 ${open ? "rotate-180" : ""}`} />
    </button>
    {open && createPortal(<>
      <button type="button" aria-label="关闭选择菜单" className="fixed inset-0 z-[11990] cursor-default" onClick={() => setOpen(false)} />
      <div id={menuId} role="listbox" aria-label={ariaLabel} style={{ left: position.left, top: position.top, minWidth: position.width }} className={`fixed z-[12000] max-h-[300px] overflow-auto rounded-xl border border-edge bg-white p-1.5 shadow-[0_18px_50px_rgba(15,23,42,.18)] dark:bg-[#252525] dark:shadow-[0_20px_60px_rgba(0,0,0,.48)] ${menuClassName}`}>
        {options.map((option) => <button key={option.value} type="button" role="option" aria-selected={option.value === String(value)} disabled={option.disabled} onClick={() => { onChange(option.value); setOpen(false); }} className={`flex min-h-9 w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors disabled:opacity-40 ${option.value === String(value) ? "bg-bg-gray font-semibold text-ink dark:bg-white/10" : "text-ink-2 hover:bg-bg-gray dark:hover:bg-white/[.07]"}`}>
          <span className="min-w-0 flex-1 truncate">{option.label}</span>{option.value === String(value) && <IconCheck className="h-4 w-4 flex-none" />}
        </button>)}
      </div>
    </>, document.body)}
  </>;
}
