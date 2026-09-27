"use client";

import { useEffect, useState, type ReactNode } from "react";
import AppModal from "./AppModal";
import { mobileWorkspaceGroups, MOBILE_NAV_LABELS } from "@/lib/workspaceNavigation";

type Item = { key: string; label: string; icon: ReactNode };

export default function WorkspaceNavigation({ items, order, activeKey, onSelect, onPrepare }: { items: Item[]; order?: string[]; activeKey: string; onSelect: (key: string) => void; onPrepare?: (key: string) => void }) {
  const [open, setOpen] = useState(false);
  useEffect(() => { setOpen(false); }, [activeKey]);
  const { primary: primaryItems, more: secondaryItems } = mobileWorkspaceGroups(items, order);
  const primaryKeys = primaryItems.map(item => item.key);
  const labels = MOBILE_NAV_LABELS;
  return <div className="workspace-mobile-navigation">
    <nav className="workspace-bottom-tabs" aria-label="主要工作区">
      <div className="workspace-dock-main">
      {primaryItems.map(item => <button type="button" key={item.key} aria-current={item.key === activeKey || (item.key === "assets" && activeKey === "pnl") ? "page" : undefined} onPointerDown={() => { if (item.key !== activeKey) onPrepare?.(item.key); }} onKeyDown={event => { if ((event.key === "Enter" || event.key === " ") && item.key !== activeKey) onPrepare?.(item.key); }} onClick={() => onSelect(item.key)}>
        <span className="workspace-navigation-icon" aria-hidden="true">{item.icon}</span><span>{labels[item.key]}</span>
      </button>)}
      </div>
    <button type="button" className="workspace-menu-trigger" aria-current={!primaryKeys.includes(activeKey) && activeKey !== "pnl" ? "page" : undefined} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg><span>更多</span>
    </button>
    </nav>
    {open && <AppModal title="更多" size="lg" className="workspace-navigation-modal" onClose={() => setOpen(false)}>
      <nav className="workspace-navigation-list" aria-label="工作区分类">{secondaryItems.map(item => <button type="button" key={item.key} aria-current={item.key === activeKey ? "page" : undefined} onPointerDown={() => { if (item.key !== activeKey) onPrepare?.(item.key); }} onKeyDown={event => { if ((event.key === "Enter" || event.key === " ") && item.key !== activeKey) onPrepare?.(item.key); }} onClick={() => { setOpen(false); onSelect(item.key); }}>
        <span className="workspace-navigation-icon" aria-hidden="true">{item.icon}</span><span className="workspace-navigation-label">{item.label}</span><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>
      </button>)}</nav>
    </AppModal>}
  </div>;
}
