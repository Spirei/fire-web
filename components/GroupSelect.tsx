"use client";

import { useEffect, useMemo, useRef, useState } from "react";

interface Props {
  value: string;
  onChange: (value: string) => void;
  groups: string[];
  /** 券商名称 → 图标 URL（素材库-券商图标） */
  brokerIcons?: Record<string, string>;
}

function BrokerIcon({ url, name, size = 20 }: { url?: string; name: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  if (url && !failed) {
    return <img src={url} alt="" onError={() => setFailed(true)} className="flex-none rounded-full object-cover" style={{ width: size, height: size }} />;
  }
  return (
    <span
      className="flex flex-none items-center justify-center rounded-full bg-bg-gray text-[10px] font-bold text-muted"
      style={{ width: size, height: size }}
    >
      {(name || "?").slice(0, 1)}
    </span>
  );
}

export default function GroupSelect({ value, onChange, groups, brokerIcons = {} }: Props) {
  const options = useMemo(() => [...new Set(groups.filter((g) => g.trim()))], [groups]);
  const [open, setOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setCustomOpen(value !== "" && !options.includes(value));
    setDraft(value);
  }, [value, options]);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const selected = options.includes(value) ? value : "";

  if (customOpen) {
    return (
      <div className="flex gap-2">
        <input
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            onChange(e.target.value);
          }}
          className="field min-w-0 flex-1"
          placeholder="输入新券商名称"
          autoFocus
        />
        <button
          type="button"
          onClick={() => {
            setCustomOpen(false);
            setDraft("");
            onChange("");
          }}
          className="btn btn-ghost btn-sm flex-none"
          title="返回选择已有券商"
        >
          已有券商
        </button>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="field flex items-center justify-between gap-2 text-left"
      >
        <span className="flex min-w-0 items-center gap-2">
          {selected ? <BrokerIcon url={brokerIcons[selected]} name={selected} /> : null}
          <span className={selected ? "truncate" : "truncate text-faint"}>{selected || "无券商"}</span>
        </span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`h-3.5 w-3.5 flex-none text-faint transition-transform ${open ? "rotate-180" : ""}`}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="popover-in absolute left-0 right-0 top-full z-30 mt-1.5 max-h-64 overflow-y-auto rounded-[12px] border border-edge bg-white p-1 shadow-pop dark:border-[#3b4354] dark:bg-[#1c1c1e]">
          <button
            type="button"
            onClick={() => {
              onChange("");
              setOpen(false);
            }}
            className={`flex w-full items-center gap-2 rounded-[8px] px-2 py-1.5 text-left text-sm ${
              !selected ? "bg-[#2a2f3a] font-semibold text-white dark:bg-white/15" : "text-ink-2 hover:bg-[#f2f3f5] dark:hover:bg-white/[0.07]"
            }`}
          >
            无券商
          </button>
          {options.map((g) => (
            <button
              key={g}
              type="button"
              onClick={() => {
                onChange(g);
                setOpen(false);
              }}
              className={`flex w-full items-center gap-2 rounded-[8px] px-2 py-1.5 text-left text-sm ${
                selected === g ? "bg-[#2a2f3a] font-semibold text-white dark:bg-white/15" : "text-ink-2 hover:bg-[#f2f3f5] dark:hover:bg-white/[0.07]"
              }`}
            >
              <BrokerIcon url={brokerIcons[g]} name={g} />
              <span className="min-w-0 flex-1 truncate">{g}</span>
              {selected === g && (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5 flex-none">
                  <path d="m5 13 4 4L19 7" />
                </svg>
              )}
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              setCustomOpen(true);
              setDraft(value);
              setOpen(false);
            }}
            className="mt-0.5 flex w-full items-center gap-2 rounded-[8px] px-2 py-1.5 text-left text-sm text-muted transition-colors hover:bg-[#f2f3f5] dark:hover:bg-white/[0.07]"
          >
            ＋ 自定义新券商…
          </button>
        </div>
      )}
    </div>
  );
}
