"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CURRENT_VERSION, type VersionEntry, type ChangeKind } from "@/lib/versions";
import { VERSIONS } from "@/lib/versions-history";

function SectionTitle({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-bg-gray text-muted dark:bg-white/5">
        {icon}
      </span>
      <h4 className="text-[13px] font-bold tracking-wide text-ink">{title}</h4>
    </div>
  );
}

export default function VersionModal({
  onClose,
  initialVersion = CURRENT_VERSION.version
}: {
  onClose: () => void;
  initialVersion?: string;
}) {
  const [active, setActive] = useState<VersionEntry>(
    VERSIONS.find((v) => v.version === initialVersion) ?? CURRENT_VERSION
  );
  const [closing, setClosing] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});
  const [flash, setFlash] = useState<string | null>(null);

  function goTo(kind: string) {
    const el = sectionRefs.current[kind];
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    setFlash(kind);
    window.setTimeout(() => setFlash((f) => (f === kind ? null : f)), 1500);
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
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
    closeTimer.current = setTimeout(() => onClose(), 180);
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4 sm:p-8"
      role="dialog"
      aria-modal="true"
      aria-label="版本记录"
    >
      <div
        className={`modal-scrim absolute inset-0 ${closing ? "modal-overlay-closing" : "modal-overlay"}`}
        onClick={requestClose}
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className={`relative w-full max-w-[720px] max-h-[calc(100vh-2rem)] overflow-y-auto rounded-[26px] border border-black/8 bg-white p-6 shadow-[0_24px_64px_rgba(0,0,0,.22)] outline-none dark:border-white/10 dark:bg-[#1c1c1e] dark:shadow-[0_24px_64px_rgba(0,0,0,.5)] sm:p-7 ${
          closing ? "rb-modal-closing" : "rb-modal"
        }`}
      >
        <div className="mb-5 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-[19px] font-bold leading-snug text-ink">版本记录</h3>
            <p className="mt-1 text-[13px] text-muted">Fire · 每次更新、修复与安全加固都会记录在版本号中</p>
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

        {/* 版本切换（未来多版本时启用） */}
        {VERSIONS.length > 1 && (
          <div className="mb-5 flex flex-wrap gap-2">
            {VERSIONS.map((v) => (
              <button
                key={v.version}
                type="button"
                onClick={() => setActive(v)}
                className={`relative rounded-full px-3.5 py-1.5 text-[12px] font-semibold transition-colors duration-200 ${
                  active.version === v.version
                    ? "bg-white text-ink-2 border border-edge-strong shadow-sm shadow-sm active:bg-bg-gray"
                    : "text-muted hover:bg-brand-hover hover:text-ink dark:hover:bg-white/5"
                }`}
              >
                {v.version}
                <span
                  className={`absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-bold leading-none ${
                    active.version === v.version ? "bg-white text-brand-deep shadow-sm" : "bg-white text-ink-2 border border-edge-strong shadow-sm"
                  }`}
                  title={`${v.changes.length} 项更新`}
                >
                  {v.changes.length}
                </span>
              </button>
            ))}
          </div>
        )}

        {(() => {
          const countBy = (k: ChangeKind) => active.changes.filter((c) => c.kind === k).length;
          const stats = [
            { label: "新功能", n: countBy("feature"), cls: "bg-brand-light text-brand-deep dark:bg-white/10 dark:text-white" },
            { label: "修复", n: countBy("fix"), cls: "bg-bg-gray text-ink-2 dark:bg-white/5 dark:text-muted" },
            { label: "安全", n: countBy("security"), cls: "bg-amber-50 text-amber-700 dark:bg-amber-400/10 dark:text-amber-300" },
            { label: "前端版本", n: active.frontend.length, cls: "bg-bg-gray text-ink-2 dark:bg-white/5 dark:text-muted" }
          ];
          const groups: { kind: ChangeKind; title: string; desc: string; dot: string }[] = [
            { kind: "feature", title: "新功能", desc: "新增能力与界面优化", dot: "bg-brand" },
            { kind: "fix", title: "修复", desc: "问题修复与细节完善", dot: "bg-[#9aa1ab]" },
            { kind: "security", title: "安全", desc: "安全加固与权限修复", dot: "bg-amber-500" }
          ];
          const statToKind: Record<string, string> = {
            新功能: "feature",
            修复: "fix",
            安全: "security",
            前端版本: "frontend"
          };
          return (
            <div className="space-y-5">
              {/* 总结 */}
              <section className="overflow-hidden rounded-[16px] border border-edge">
                <div className="border-b border-edge bg-bg-gray/40 px-4 py-3.5 dark:bg-white/5">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <span className="text-[15px] font-bold text-ink">{active.software[0]?.name}</span>
                    <span className="rounded-full bg-bg-gray px-2.5 py-0.5 text-[12px] font-bold text-ink-2 dark:bg-white/10 dark:text-white">
                      {active.version}
                    </span>
                    <span className="text-[12px] text-muted">{active.date}</span>
                  </div>
                  <p className="mt-2 text-[13px] leading-relaxed text-ink-2">{active.summary}</p>
                </div>
                <div className="flex flex-wrap gap-2 px-4 py-3">
                  {stats.map((s) => (
                    <button
                      key={s.label}
                      type="button"
                      onClick={() => goTo(statToKind[s.label])}
                      title={`查看${s.label}详细更新`}
                      className={`group inline-flex cursor-pointer items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold transition-all duration-200 hover:ring-2 hover:ring-brand/30 ${s.cls}`}
                    >
                      {s.label}
                      <span className="tabular-nums">{s.n}</span>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-2.5 w-2.5 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
                        <path d="m9 6 6 6-6 6" />
                      </svg>
                    </button>
                  ))}
                </div>
              </section>

              {/* 详细更新（按类型分组） */}
              <section>
                <SectionTitle
                  icon={
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
                      <path d="M3 3v18h18" />
                      <path d="M7 15.5 10 12l3 2.5 4.5-6" />
                    </svg>
                  }
                  title="详细更新"
                />
                <div className="space-y-4">
                  {groups.map((g) => {
                    const items = active.changes.filter((c) => c.kind === g.kind);
                    if (items.length === 0) return null;
                    return (
                      <div
                        key={g.kind}
                        ref={(el) => {
                          sectionRefs.current[g.kind] = el;
                        }}
                        className={`rounded-[14px] transition-all duration-300 ${
                          flash === g.kind ? "ring-2 ring-brand/35 bg-brand-light/20 dark:bg-white/[0.06]" : ""
                        }`}
                      >
                        <div className="mb-2 flex flex-wrap items-center gap-2">
                          <span className={`h-2 w-2 flex-none rounded-full ${g.dot}`} />
                          <span className="text-[13px] font-bold text-ink">{g.title}</span>
                          <span className="text-[11px] text-faint">{g.desc}</span>
                          <span className="ml-auto rounded-full bg-bg-gray px-2 py-0.5 text-[11px] font-semibold text-muted dark:bg-white/5">
                            {items.length} 项
                          </span>
                        </div>
                        <ol className="space-y-2">
                          {items.map((c, i) => (
                            <li
                              key={c.title}
                              className="flex items-start gap-3 rounded-[12px] border border-edge bg-bg-gray/40 px-3.5 py-3 transition-colors hover:border-edge-strong/25 dark:bg-white/5"
                            >
                              <span className="mt-0.5 flex h-6 w-6 flex-none items-center justify-center rounded-full bg-white text-[12px] font-bold text-ink-2 ring-1 ring-edge dark:bg-white/10 dark:text-white">
                                {i + 1}
                              </span>
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="mt-1.5 h-3.5 w-3.5 flex-none text-brand">
                                <path d="m9 6 6 6-6 6" />
                              </svg>
                              <div className="min-w-0 flex-1">
                                <span className="block text-[13px] font-bold text-ink">{c.title}</span>
                                <p className="mt-1 text-[12px] leading-relaxed text-muted">{c.desc}</p>
                              </div>
                            </li>
                          ))}
                        </ol>
                      </div>
                    );
                  })}
                </div>
              </section>

              {/* 前端版本 */}
              <section
                ref={(el) => {
                  sectionRefs.current.frontend = el;
                }}
                className={`rounded-[14px] transition-all duration-300 ${
                  flash === "frontend" ? "ring-2 ring-brand/35 bg-brand-light/20 dark:bg-white/[0.06]" : ""
                }`}
              >
                <SectionTitle
                  icon={
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
                      <path d="m8 6-6 6 6 6" />
                      <path d="m16 6 6 6-6 6" />
                      <path d="m13.5 4-3 16" />
                    </svg>
                  }
                  title="前端版本"
                />
                <div className="grid gap-2 sm:grid-cols-2">
                  {active.frontend.map((item) => (
                    <div key={item.name} className="flex items-center justify-between gap-3 rounded-[12px] border border-edge bg-bg-gray/40 px-3.5 py-2.5 dark:bg-white/5">
                      <div className="min-w-0">
                        <span className="block truncate text-[13px] font-semibold text-ink">{item.name}</span>
                        <span className="block truncate text-[11px] text-faint">{item.desc}</span>
                      </div>
                      <span className="flex-none rounded-md bg-white px-2 py-0.5 text-[11px] font-semibold text-ink-2 ring-1 ring-edge dark:bg-white/10 dark:text-white">
                        {item.version}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          );
        })()}
      </div>
    </div>,
    document.body
  );
}
