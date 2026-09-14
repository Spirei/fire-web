"use client";

import { useEffect, useRef, useState } from "react";

const ICON_PATHS: Record<string, React.ReactNode> = {
  site: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18Z" />
    </>
  ),
  sitemanage: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2.5" />
      <path d="M3 9h18" />
      <path d="M9 21V9" />
    </>
  ),
  stocks: (
    <>
      <path d="M3 3v18h18" />
      <path d="M7 15.5 10 12l3 2.5 4.5-6" />
    </>
  ),
  features: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="2" />
      <rect x="14" y="3" width="7" height="7" rx="2" />
      <rect x="3" y="14" width="7" height="7" rx="2" />
      <path d="M17.5 14v7M14 17.5h7" />
    </>
  ),
  profile: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21v-1.5a5 5 0 0 1 5-5h6a5 5 0 0 1 5 5V21" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="5.5" rx="8" ry="3" />
      <path d="M4 5.5v13c0 1.66 3.58 3 8 3s8-1.34 8-3v-13" />
      <path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" />
    </>
  ),
  api: (
    <>
      <path d="m8 6-6 6 6 6" />
      <path d="m16 6 6 6-6 6" />
      <path d="m13.5 4-3 16" />
    </>
  ),
  cron: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8h.01" />
      <path d="M12 12v4" />
    </>
  ),
  about: (
    <>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M12 10.8v4.8" />
      <path d="M12 7.6h.01" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <circle cx="9" cy="10" r="1.8" />
      <path d="m4 18 5-5 3.5 3.5L17 12l3 3" />
    </>
  ),
  list: (
    <>
      <path d="M8 6h13" /><path d="M8 12h13" /><path d="M8 18h13" />
      <circle cx="3.5" cy="6" r="1" fill="currentColor" stroke="none" />
      <circle cx="3.5" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="3.5" cy="18" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  tag: (
    <>
      <path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8Z" />
      <circle cx="7.5" cy="7.5" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  plug: (
    <>
      <path d="M9 3v6" /><path d="M15 3v6" />
      <path d="M5 9h14v3a7 7 0 0 1-7 7h0a7 7 0 0 1-7-7Z" />
      <path d="M12 19v3" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="m11 12 9-9" /><path d="M17 6l3 3" /><path d="M14 9l2 2" />
    </>
  ),
  home: (
    <>
      <path d="m3 11 9-7 9 7" />
      <path d="M5 9.5V21h14V9.5" />
      <path d="M10 21v-6h4v6" />
    </>
  ),
  pen: (
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </>
  ),
  trade: (
    <>
      <path d="M3 17 9 11l3.5 3L20 7" />
      <path d="M15 7h5v5" />
      <path d="M3 21h18" />
    </>
  ),
  model: (
    <>
      <path d="M12 3.2 14.1 8l4.7 2.1-4.7 2.1L12 17l-2.1-4.8-4.7-2.1L9.9 8Z" />
      <path d="M18.3 15.2 19.2 17l1.8.8-1.8.8-.9 1.9-.8-1.9-1.9-.8 1.9-.8Z" />
    </>
  )
};

export function SubNavIcon({ name, className = "h-[17px] w-[17px]" }: { name: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      {ICON_PATHS[name] || ICON_PATHS.site}
    </svg>
  );
}

export default function SettingsHeader({
  name,
  title,
  desc,
  action,
  hideIcon = false
}: {
  name: string;
  title: string;
  desc?: string;
  action?: React.ReactNode;
  hideIcon?: boolean;
}) {
  return (
    <div className="settings-section-heading flex items-center gap-3">
      {!hideIcon && (
        <span className="settings-heading-icon flex h-10 w-10 flex-none items-center justify-center rounded-xl border border-edge text-muted">
          <SubNavIcon name={name} className="h-5 w-5" />
        </span>
      )}
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h3 className="text-base font-bold">{title}</h3>
          {action}
        </div>
        {desc && <p className="mt-0.5 text-xs text-muted">{desc}</p>}
      </div>
    </div>
  );
}

export function SettingsSection({
  icon,
  title,
  desc,
  children,
  action,
  titleAction,
  className,
  id,
  collapsible = false,
  defaultOpen = true,
  storageKey,
  summary,
  reveal = false
}: {
  icon: string;
  title: string;
  desc?: string;
  children: React.ReactNode;
  action?: React.ReactNode;
  titleAction?: React.ReactNode;
  className?: string;
  id?: string;
  collapsible?: boolean;
  defaultOpen?: boolean;
  storageKey?: string;
  summary?: string;
  /** 为 true 时强制展开（用于「点了编辑却看不到内容」的场景） */
  reveal?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const hydrated = useRef(false);

  useEffect(() => {
    if (!collapsible) return;
    const key = `fire:collapse:${storageKey || title}`;
    try {
      const saved = localStorage.getItem(key);
      if (saved !== null) setOpen(saved === "1");
      hydrated.current = true;
    } catch {
      hydrated.current = true;
    }
  }, [collapsible, storageKey, title]);

  // 进入编辑态时把分区自动展开：否则用户点了「编辑」却因为折叠看不到任何内容
  useEffect(() => {
    if (reveal) setOpen(true);
  }, [reveal]);

  useEffect(() => {
    if (!collapsible || !hydrated.current) return;
    const key = `fire:collapse:${storageKey || title}`;
    try {
      localStorage.setItem(key, open ? "1" : "0");
    } catch {
      /* 忽略 */
    }
  }, [open, collapsible, storageKey, title]);

  return (
    <section id={id} className={`settings-section-card${collapsible ? " is-accordion" : ""} ${className || ""}`}>
      <div
        className={`settings-section-top flex items-start justify-between gap-4 ${collapsible ? "cursor-pointer select-none" : ""}`}
        onClick={collapsible ? () => setOpen((o) => !o) : undefined}
      >
        <div className="flex min-w-0 items-start gap-3.5">
          <span className="settings-section-icon flex h-8 w-8 flex-none items-center justify-center rounded-md">
            <SubNavIcon name={icon} className="h-4 w-4" />
          </span>
          <div className="min-w-0 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="leading-tight">{title}</h4>
              {titleAction && <span className="settings-section-title-action inline-flex" onClick={(e) => e.stopPropagation()}>{titleAction}</span>}
            </div>
            {desc && <p className="max-w-3xl leading-6">{desc}</p>}
            {summary && !open && <p className="settings-section-summary">{summary}</p>}
          </div>
        </div>
        <div className="flex flex-none items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          {action}
          {collapsible && (
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              aria-label={open ? "折叠" : "展开"}
              title={open ? "折叠" : "展开"}
              className="settings-section-chevron inline-flex h-8 w-8 items-center justify-center"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={`h-[18px] w-[18px] transition-transform duration-200 ${open ? "rotate-90" : ""}`}
              >
                <path d="m9 6 6 6-6 6" />
              </svg>
            </button>
          )}
        </div>
      </div>
      {collapsible ? (
        <div className={`settings-section-body grid transition-[grid-template-rows,opacity] duration-200 ease-out ${open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`}>
          <div className="min-h-0 overflow-hidden">{children}</div>
        </div>
      ) : (
        <div className="settings-section-body">{children}</div>
      )}
    </section>
  );
}
