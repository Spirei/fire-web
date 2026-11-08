"use client";

import type { ReactNode } from "react";
import { IconWallet, IconNews, IconPhoto, IconDatabase, IconFolder, IconAdjustmentsHorizontal, IconUser, IconPalette, IconChevronRight, IconShieldLock, IconKey, IconShieldCheck } from "@tabler/icons-react";
import { usePersistedState } from "@/lib/usePersistedState";
import { preloadView } from "@/lib/viewPreload";

type Item = { key: string; label: string; icon: ReactNode };
const groups = [
  { key: "investment", label: "投资", icon: IconWallet, keys: ["holdings", "assets", "pnl", "watchlist", "fire"] },
  { key: "feed", label: "动态", icon: IconNews, keys: ["trading"] },
  { key: "resources", label: "资源", icon: IconPhoto, keys: ["library", "cards"] },
  { key: "data", label: "数据", icon: IconDatabase, keys: ["global", "quote-pool", "earnings", "celebs"] },
  { key: "management", label: "管理", icon: IconFolder, keys: ["activities"] },
  { key: "system", label: "系统", icon: IconAdjustmentsHorizontal, keys: ["system-overview", "background-tasks", "backup-recovery", "api-migration", "settings"] },
  { key: "personal", label: "个人", icon: IconUser, keys: ["users"] }
];

export default function PlatformNavigation({ items, activeKey, onSelect, onSettings, onDrop, onDragStart, onDragEnd }: {
  items: Item[]; activeKey: string; onSelect: (key: string) => void; onSettings: (sub: string) => void;
  onDrop: (key: string) => void; onDragStart: (key: string) => void; onDragEnd: () => void;
}) {
  const [expanded, setExpanded] = usePersistedState<Record<string, boolean>>("fire:platform-navigation-expanded", {});
  return <div className="platform-navigation">{groups.map(group => {
    const children = items.filter(item => group.keys.includes(item.key));
    if (!children.length && group.key !== "personal") return null;
    const open = expanded?.[group.key] === true;
    return <section key={group.key}>
      <button type="button" className="platform-group" aria-label={group.label} aria-expanded={open} aria-controls={`platform-group-${group.key}`} onClick={() => setExpanded(previous => ({ ...previous, [group.key]: !open }))}>
        <group.icon size={21} stroke={1.5} /><span>{group.label}</span><IconChevronRight className={open ? "is-expanded" : ""} size={17} stroke={1.6} />
      </button>
      <div id={`platform-group-${group.key}`} hidden={!open} className="platform-group-children">
        {children.map(item => <button type="button" key={item.key} className={`fire-sidebar-item platform-child ${activeKey === item.key ? "fire-sidebar-item-active" : ""}`} aria-label={item.label} aria-current={activeKey === item.key ? "page" : undefined} onClick={() => onSelect(item.key)} onPointerEnter={event => { if (event.pointerType === "mouse") preloadView(item.key); }} onFocus={() => preloadView(item.key)} draggable onDragStart={event => { event.stopPropagation(); event.dataTransfer.effectAllowed="move"; event.dataTransfer.setData("text/plain", item.key); onDragStart(item.key); }} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); event.stopPropagation(); onDrop(item.key); }} onDragEnd={onDragEnd}>
          {item.icon}<span className="fire-sidebar-label truncate">{item.label}</span>
        </button>)}

      </div>
    </section>;
  })}</div>;
}
PlatformNavigation.AppearanceIcon = function AppearanceIcon() { return <IconPalette size={23} stroke={1.5} />; };
