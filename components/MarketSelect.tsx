"use client";

import { useEffect, useRef, useState } from "react";
import MarketIcon from "@/components/MarketIcon";

interface MarketOption {
  key: string;
  label: string;
  flag: string;
}

export default function MarketSelect({
  value,
  onChange,
  options
}: {
  value: string;
  onChange: (v: string) => void;
  options: MarketOption[];
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const current = options.find((o) => o.key === value) ?? options[0];
  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="field flex cursor-pointer items-center gap-2 text-left"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {current && <MarketIcon market={current.key} flag={current.flag} size={18} />}
        <span className="min-w-0 flex-1 truncate text-sm text-ink">
          {current ? `${current.label}（${current.key}）` : "选择市场"}
        </span>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`h-4 w-4 flex-none text-faint transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="popover-in absolute left-0 right-0 top-full z-30 mt-1.5 max-h-64 overflow-y-auto rounded-[12px] border border-edge bg-white p-1 shadow-pop">
          {options.map((o) => (
            <button
              key={o.key}
              type="button"
              onClick={() => {
                onChange(o.key);
                setOpen(false);
              }}
              className={`flex w-full items-center gap-2.5 rounded-[8px] px-2.5 py-2.5 text-left text-sm transition-colors duration-150 ${
                o.key === value ? "bg-brand-light font-semibold text-brand-deep" : "text-ink-2 hover:bg-brand-hover"
              }`}
            >
              <MarketIcon market={o.key} flag={o.flag} size={18} />
              <span className="min-w-0 flex-1 truncate">{o.label}</span>
              <span className="flex-none font-mono text-[11px] text-faint">{o.key}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
