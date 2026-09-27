"use client";

import { useEffect, useRef, useState } from "react";
import type { TabConfig } from "@/lib/types";
import { mobileWorkspaceGroups, moveMobileNavigation, MOBILE_NAV_LABELS } from "@/lib/workspaceNavigation";
import { NAV_ICONS } from "@/lib/navIcons";
import { IconDots, IconArrowUpRight, IconArrowDownRight } from "@tabler/icons-react";

export default function MobileNavigationSettings({ tabs, order, onSave }: {
  tabs: TabConfig[];
  order: string[];
  onSave: (order: string[]) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(order);
  const [saving, setSaving] = useState(false);
  const drag = useRef<{ key: string } | null>(null);
  const savingRef = useRef(false);
  const [mouseDrag, setMouseDrag] = useState(false);
  useEffect(() => { setDraft(order); }, [order]);
  const groups = mobileWorkspaceGroups(tabs, draft);
  const saved = mobileWorkspaceGroups(tabs, order);
  const currentKeys = [...groups.primary, ...groups.more].map(item => item.key);
  const savedKeys = [...saved.primary, ...saved.more].map(item => item.key);
  const changed = currentKeys.join("|") !== savedKeys.join("|") || (draft.length === 0 && order.length > 0);

  function move(from: number, to: number) {
    if (saving) return;
    setDraft(moveMobileNavigation(currentKeys, from, to));
  }

  async function save() {
    if (savingRef.current || !changed) return;
    savingRef.current = true;
    setSaving(true);
    try { await onSave(draft.length ? currentKeys : []); }
    finally { savingRef.current = false; setSaving(false); }
  }

  return <div className="mobile-nav-editor">
    <div className="mobile-nav-preview" aria-label="底部入口预览">{groups.primary.map(item => <span key={item.key}><span className="mobile-nav-preview-icon" aria-hidden="true">{NAV_ICONS[item.key]}</span><span>{MOBILE_NAV_LABELS[item.key] ?? item.label}</span></span>)}<span className="text-muted"><IconDots size={20} stroke={1.8} aria-hidden="true"/><span>更多</span></span></div>
    {(["primary", "more"] as const).map(group => <div key={group} className="mt-5">
      <h5 className="mobile-nav-group-title">{group === "primary" ? "底部入口" : "更多功能"}</h5>
      <ol className="mobile-nav-sort-list">{groups[group].map((item, index) => { const position = group === "primary" ? index : groups.primary.length + index; return <li key={item.key} onDragOver={event => { if (drag.current && !saving) event.preventDefault(); }} onDrop={event => {
        event.preventDefault();
        const source = drag.current;
        drag.current = null;
        if (source) move(currentKeys.indexOf(source.key), position);
      }}>
        <span role="img" aria-label={`拖动${MOBILE_NAV_LABELS[item.key] ?? item.label}排序`} title="拖动排序" onPointerEnter={event => setMouseDrag(event.pointerType === "mouse")} onPointerDown={event => setMouseDrag(event.pointerType === "mouse")} draggable={!saving && mouseDrag} className="mobile-nav-drag" onDragStart={event => { drag.current = { key: item.key }; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", item.key); }} onDragEnd={() => { drag.current = null; }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">{[6,12,18].flatMap(y => [9,15].map(x => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.5"/>))}</svg>
        </span>
        <span className="mobile-nav-item-label">{item.label}</span>
        <button type="button" className="mobile-nav-transfer" disabled={saving || currentKeys.length <= 4} aria-label={`${group === "more" ? "放入底部" : "移到更多"}${item.label}`} title={group === "more" ? "放入第4个入口，原入口移入更多" : "移到更多，下一项补入底部"} onClick={() => move(position, group === "more" ? 3 : 4)}>{group === "more" ? <IconArrowUpRight size={18}/> : <IconArrowDownRight size={18}/>}</button>
        <button type="button" disabled={saving || position === 0} aria-label={`上移${item.label}`} onClick={() => move(position, position - 1)}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m6 14 6-6 6 6"/></svg></button>
        <button type="button" disabled={saving || position === currentKeys.length - 1} aria-label={`下移${item.label}`} onClick={() => move(position, position + 1)}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m6 10 6 6 6-6"/></svg></button>
      </li>; })}</ol>
    </div>)}
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3"><button type="button" className="btn btn-line btn-sm" disabled={saving} onClick={() => setDraft([])}>恢复默认</button><button type="button" className="btn btn-primary btn-sm" disabled={saving || !changed} onClick={() => void save()}>{saving ? "保存中…" : "保存"}</button></div>
  </div>;
}
