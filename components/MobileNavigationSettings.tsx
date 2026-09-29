"use client";

import { useEffect, useRef, useState } from "react";
import type { TabConfig } from "@/lib/types";
import { mobileWorkspaceGroups, moveMobileNavigation, MOBILE_NAV_LABELS } from "@/lib/workspaceNavigation";
import { NAV_ICONS } from "@/lib/navIcons";
import { IconDots } from "@tabler/icons-react";
import SafeAssetImage from "./SafeAssetImage";
import { showToast } from "@/lib/toast";

export default function MobileNavigationSettings({ tabs, order, icons, onSave }: {
  tabs: TabConfig[];
  order: string[];
  icons: Record<string, string>;
  onSave: (order: string[]) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(order);
  const [saving, setSaving] = useState(false);
  const drag = useRef<{ key: string } | null>(null);
  const savingRef = useRef(false);
  const pendingRef = useRef<string[] | null>(null);
  const savedRef = useRef(order);
  const [mouseDrag, setMouseDrag] = useState(false);
  useEffect(() => {
    if (!savingRef.current && !pendingRef.current) {
      savedRef.current = order;
      setDraft(order);
    }
  }, [order]);
  const groups = mobileWorkspaceGroups(tabs, draft);
  const currentKeys = [...groups.primary, ...groups.more].map(item => item.key);

  async function flush() {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      while (pendingRef.current) {
        const next = pendingRef.current;
        pendingRef.current = null;
        let saved = false;
        try { saved = await onSave(next); } catch { /* 交由下方统一处理。 */ }
        if (saved) savedRef.current = next;
        else if (!pendingRef.current) {
          setDraft(savedRef.current);
          showToast("导航顺序保存失败，已恢复原顺序", "err");
        }
      }
    }
    finally { savingRef.current = false; setSaving(false); }
  }

  function move(from: number, to: number) {
    const next = moveMobileNavigation(currentKeys, from, to);
    if (next.join("|") === currentKeys.join("|")) return;
    setDraft(next);
    pendingRef.current = next;
    void flush();
  }

  return <div className="mobile-nav-editor">
    <div className="mobile-nav-preview" aria-label="底部入口预览">{groups.primary.map((item, index) => <span key={item.key} className={index === 0 ? "mobile-nav-preview-item is-selected" : "mobile-nav-preview-item"}><span className="mobile-nav-preview-icon" aria-hidden="true"><SafeAssetImage src={icons[item.key.toUpperCase()]} fallback={NAV_ICONS[item.key] ?? null} className="nav-custom-icon h-5 w-5 object-contain" /></span><span>{MOBILE_NAV_LABELS[item.key] ?? item.label}</span></span>)}<span className="mobile-nav-preview-item text-muted"><IconDots size={20} stroke={1.8} aria-hidden="true"/><span>更多</span></span></div>
    {(["primary", "more"] as const).map(group => <div key={group} className="mt-5">
      <h5 className="mobile-nav-group-title">{group === "primary" ? "底部入口" : "更多功能"}</h5>
      <ol className="mobile-nav-sort-list">{groups[group].map((item, index) => { const position = group === "primary" ? index : groups.primary.length + index; return <li key={item.key} onDragOver={event => { if (drag.current) event.preventDefault(); }} onDrop={event => {
        event.preventDefault();
        const source = drag.current;
        drag.current = null;
        if (source) void move(currentKeys.indexOf(source.key), position);
      }}>
        <span role="img" aria-label={`拖动${MOBILE_NAV_LABELS[item.key] ?? item.label}排序`} title="拖动排序" onPointerEnter={event => setMouseDrag(event.pointerType === "mouse")} onPointerDown={event => setMouseDrag(event.pointerType === "mouse")} draggable={mouseDrag} className="mobile-nav-drag" onDragStart={event => { drag.current = { key: item.key }; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", item.key); }} onDragEnd={() => { drag.current = null; }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">{[6,12,18].flatMap(y => [9,15].map(x => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.5"/>))}</svg>
        </span>
        <span className="mobile-nav-item-icon" aria-hidden="true"><SafeAssetImage src={icons[item.key.toUpperCase()]} fallback={NAV_ICONS[item.key] ?? null} className="nav-custom-icon h-5 w-5 object-contain" /></span>
        <span className="mobile-nav-item-label">{item.label}</span>
        <button type="button" disabled={position === 0} aria-label={`上移${item.label}`} onClick={() => move(position, position - 1)}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m6 14 6-6 6 6"/></svg></button>
        <button type="button" disabled={position === currentKeys.length - 1} aria-label={`下移${item.label}`} onClick={() => move(position, position + 1)}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m6 10 6 6 6-6"/></svg></button>
      </li>; })}</ol>
    </div>)}
    {saving && <p className="mobile-nav-saving" role="status">正在保存顺序…</p>}
  </div>;
}
