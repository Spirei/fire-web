"use client";

import { useEffect, useRef, useState } from "react";
import type { TabConfig } from "@/lib/types";
import { mobileWorkspaceGroups, MOBILE_NAV_LABELS } from "@/lib/workspaceNavigation";

export default function MobileNavigationSettings({ tabs, order, onSave }: {
  tabs: TabConfig[];
  order: string[];
  onSave: (order: string[]) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(order);
  const [saving, setSaving] = useState(false);
  const drag = useRef<{ key: string; group: string } | null>(null);
  const savingRef = useRef(false);
  useEffect(() => { setDraft(order); }, [order]);
  const groups = mobileWorkspaceGroups(tabs, draft);
  const saved = mobileWorkspaceGroups(tabs, order);
  const currentKeys = [...groups.primary, ...groups.more].map(item => item.key);
  const savedKeys = [...saved.primary, ...saved.more].map(item => item.key);
  const changed = currentKeys.join("|") !== savedKeys.join("|") || (draft.length === 0 && order.length > 0);

  function move(group: "primary" | "more", from: number, to: number) {
    if (saving || from === to || from < 0 || from >= groups[group].length || to < 0 || to >= groups[group].length) return;
    const next = [...groups[group]];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    setDraft([...(group === "primary" ? next : groups.primary), ...(group === "more" ? next : groups.more)].map(item => item.key));
  }

  async function save() {
    if (savingRef.current || !changed) return;
    savingRef.current = true;
    setSaving(true);
    try { await onSave(draft.length ? currentKeys : []); }
    finally { savingRef.current = false; setSaving(false); }
  }

  return <div className="mobile-nav-editor">
    <div className="mobile-nav-preview" aria-label="底部入口预览">{groups.primary.map(item => <span key={item.key}>{MOBILE_NAV_LABELS[item.key] ?? item.label}</span>)}<span className="text-muted">更多</span></div>
    {(["primary", "more"] as const).map(group => <div key={group} className="mt-5">
      <h5 className="mb-2 text-sm font-semibold text-ink">{group === "primary" ? "底部入口" : "更多功能"}</h5>
      <ol className="mobile-nav-sort-list">{groups[group].map((item, index) => <li key={item.key} onDragOver={event => { if (drag.current?.group === group && !saving) event.preventDefault(); }} onDrop={event => {
        event.preventDefault();
        const source = drag.current;
        drag.current = null;
        if (source?.group === group) move(group, groups[group].findIndex(row => row.key === source.key), index);
      }}>
        <span role="img" aria-label={`拖动${MOBILE_NAV_LABELS[item.key] ?? item.label}排序`} title="拖动排序" draggable={!saving} className="mobile-nav-drag" onDragStart={event => { drag.current = { key: item.key, group }; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", item.key); }} onDragEnd={() => { drag.current = null; }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">{[6,12,18].flatMap(y => [9,15].map(x => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.5"/>))}</svg>
        </span>
        <span className="min-w-0 flex-1 text-sm font-medium text-ink">{MOBILE_NAV_LABELS[item.key] ?? item.label}</span>
        <button type="button" disabled={saving || index === 0} aria-label={`上移${MOBILE_NAV_LABELS[item.key] ?? item.label}`} onClick={() => move(group, index, index - 1)}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m6 14 6-6 6 6"/></svg></button>
        <button type="button" disabled={saving || index === groups[group].length - 1} aria-label={`下移${MOBILE_NAV_LABELS[item.key] ?? item.label}`} onClick={() => move(group, index, index + 1)}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m6 10 6 6 6-6"/></svg></button>
      </li>)}</ol>
    </div>)}
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3"><button type="button" className="btn btn-line btn-sm" disabled={saving} onClick={() => setDraft([])}>恢复默认</button><button type="button" className="btn btn-primary btn-sm" disabled={saving || !changed} onClick={() => void save()}>{saving ? "保存中…" : "保存"}</button></div>
  </div>;
}
