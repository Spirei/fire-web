"use client";

import { Children, isValidElement, useRef, useState, type ReactNode } from "react";
import { useWorkspaceSearchParams as useSearchParams } from "@/lib/workspacePanel";

type PaneProps = { name: string; title: string; summary?: ReactNode; heading?: boolean; children: ReactNode };
export function SettingsManagedPane({ children }: PaneProps) { return <>{children}</>; }

/** Keep forms mounted so navigating back never discards an unsaved draft. */
export default function SettingsManagedGroup({ scope, children, editing = false, onReorder, inline = false, headings = true }: { scope: string; children: ReactNode; editing?: boolean; onReorder?: (from: number, to: number) => void; inline?: boolean; headings?: boolean }) {
  const params = useSearchParams();
  const panes = Children.toArray(children).filter(isValidElement<PaneProps>);
  const requested = params.get("panel");
  const active = panes.find(pane => `${scope}:${pane.props.name}` === requested);
  const [announcement, setAnnouncement] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const scroll = useRef(0);
  const dragged = useRef<number | null>(null);
  function navigate(name?: string) {
    const container = root.current?.closest(".sc-detail-dialog-scroll");
    if (name) scroll.current = container?.scrollTop || 0;
    const url = new URL(window.location.href);
    if (name) url.searchParams.set("panel", `${scope}:${name}`); else url.searchParams.delete("panel");
    window.history.pushState(null, "", url);
    setAnnouncement(name ? panes.find(pane => pane.props.name === name)?.props.title || "" : "已返回概览");
    requestAnimationFrame(() => {
      if (container) container.scrollTop = name ? 0 : scroll.current;
      const target = name ? root.current?.querySelector<HTMLButtonElement>(".settings-managed-back") : Array.from(root.current?.querySelectorAll<HTMLButtonElement>("[data-pane]") || []).find(button => button.dataset.pane === active?.props.name);
      target?.focus();
    });
  }
  if (inline) return <div ref={root} className="settings-managed is-inline" data-scope={scope} data-editing={editing || undefined}>
    {panes.map(pane => <section key={pane.props.name} className="settings-managed-inline-section">
      {headings && pane.props.heading !== false && <h3 className="settings-clean-heading">{pane.props.title}</h3>}
      <div className="settings-managed-content">{pane}</div>
    </section>)}
  </div>;
  return <div ref={root} className="settings-managed" data-scope={scope} data-editing={editing || undefined}>
    <span className="sr-only" aria-live="polite">{announcement}</span>
    {active && <div className="settings-managed-heading"><button type="button" className="settings-managed-back" onClick={() => navigate()} aria-label="返回概览">‹</button><h3>{active.props.title}</h3></div>}
    {!active && <div className="settings-managed-list">{panes.map((pane, index) => <button type="button" key={pane.props.name} data-pane={pane.props.name} className="settings-managed-entry" draggable={Boolean(onReorder && panes.length > 1)} onDragStart={event => { dragged.current = index; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", pane.props.name); }} onDragOver={event => { if (onReorder) event.preventDefault(); }} onDrop={event => { event.preventDefault(); if (dragged.current !== null) onReorder?.(dragged.current, index); dragged.current = null; }} onDragEnd={() => { dragged.current = null; }} onClick={() => navigate(pane.props.name)}>{onReorder && panes.length > 1 && <span className="settings-managed-drag" title="拖动调整优先级" aria-hidden="true">⠿</span>}<span className="settings-managed-copy"><b>{pane.props.title}</b>{pane.props.summary && <small>{pane.props.summary}</small>}</span><span aria-hidden="true">›</span></button>)}</div>}
    {panes.map(pane => <div key={pane.props.name} className="settings-managed-content" hidden={active !== pane}>{pane}</div>)}
  </div>;
}
