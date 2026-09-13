"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { showToast } from "@/lib/toast";
import {
  DEFAULT_HOLDING_COLUMNS,
  HOLDING_COLUMN_LABELS,
  normalizeHoldingColumns,
  type HoldingColumnPreference
} from "@/lib/holdingColumns";

const CACHE_KEY = "fire:holding-columns:v1";
const UPDATE_EVENT = "fire:holding-columns-updated";

function cachedColumns() {
  try {
    return normalizeHoldingColumns(JSON.parse(localStorage.getItem(CACHE_KEY) || "null"));
  } catch {
    return DEFAULT_HOLDING_COLUMNS.map((item) => ({ ...item }));
  }
}

export function useHoldingColumns() {
  // 服务端与客户端首帧保持一致，再于绘制前恢复本地列设置，避免持仓表整体水合重建。
  const [columns, setColumns] = useState<HoldingColumnPreference[]>(() =>
    DEFAULT_HOLDING_COLUMNS.map((item) => ({ ...item }))
  );

  useLayoutEffect(() => {
    setColumns(cachedColumns());
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((data) => {
        if (cancelled || !data?.settings?.holdingColumns) return;
        const next = normalizeHoldingColumns(data.settings.holdingColumns);
        setColumns(next);
        localStorage.setItem(CACHE_KEY, JSON.stringify(next));
      })
      .catch(() => {});
    const sync = (event: Event) => {
      const detail = (event as CustomEvent<HoldingColumnPreference[]>).detail;
      setColumns(detail ? normalizeHoldingColumns(detail) : cachedColumns());
    };
    window.addEventListener(UPDATE_EVENT, sync);
    return () => {
      cancelled = true;
      window.removeEventListener(UPDATE_EVENT, sync);
    };
  }, []);

  const saveColumns = async (nextValue: HoldingColumnPreference[]) => {
    const next = normalizeHoldingColumns(nextValue);
    if (!next.some((item) => item.visible)) {
      showToast("至少保留一列", "err");
      return false;
    }
    const previous = columns;
    setColumns(next);
    localStorage.setItem(CACHE_KEY, JSON.stringify(next));
    window.dispatchEvent(new CustomEvent(UPDATE_EVENT, { detail: next }));
    try {
      const response = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ holdingColumns: next })
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || "保存列设置失败");
      window.dispatchEvent(new Event("fire:settings-updated"));
      return true;
    } catch (error) {
      setColumns(previous);
      localStorage.setItem(CACHE_KEY, JSON.stringify(previous));
      window.dispatchEvent(new CustomEvent(UPDATE_EVENT, { detail: previous }));
      showToast(error instanceof Error ? error.message : "保存列设置失败", "err");
      return false;
    }
  };

  return { columns, saveColumns };
}

export function HoldingColumnsButton({ onClick }: { onClick: () => void }) {
  return <button type="button" onClick={onClick} title="显示与排序持仓列" aria-label="显示与排序持仓列" className="group inline-flex h-9 w-9 flex-none items-center justify-center rounded-[9px] border border-edge-strong bg-white text-muted shadow-sm transition-all duration-200 hover:-translate-y-px hover:bg-brand-hover hover:text-ink active:scale-[.97] dark:bg-[#1c222d]">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-[17px] w-[17px] transition-transform duration-200 group-hover:scale-105">
      <path d="M4 5h16l-6.35 7.15v5.25l-3.3 1.65v-6.9L4 5Z" />
    </svg>
  </button>;
}

/** 扁平复选框（参考图样式）：选中 = 白底黑勾，未选中 = 透明 + 浅边框 */
export function FlatCheckbox({
  checked,
  onChange,
  label,
  dim = false,
  stretch = true
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  dim?: boolean;
  /** 是否拉伸占满整行（持仓管理器默认拉伸；紧凑列表传 false 避免文字与拖动手柄之间出现大段空白） */
  stretch?: boolean;
}) {
  return (
    <label className={`flex min-w-0 cursor-pointer items-center gap-2.5 text-[13px] font-medium ${stretch ? "flex-1" : ""}`}>
      <span
        className={`flex h-[15px] w-[15px] flex-none items-center justify-center rounded-[3px] border transition-colors ${
          checked
            ? "border-transparent bg-ink text-white dark:bg-white dark:text-black"
            : "border-edge-strong bg-transparent text-transparent dark:border-white/25"
        }`}
      >
        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3">
          <path d="m2.4 6.4 2.5 2.5 4.7-5.8" />
        </svg>
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        onMouseDown={(event) => event.preventDefault()}
        className="sr-only"
      />
      <span className={checked ? (dim ? "text-muted" : "text-ink") : "text-muted"}>{label}</span>
    </label>
  );
}

export function HoldingColumnManager({ columns, onSave, onClose }: { columns: HoldingColumnPreference[]; onSave: (columns: HoldingColumnPreference[]) => Promise<boolean>; onClose: () => void }) {
  const [rows, setRows] = useState(() => normalizeHoldingColumns(columns));
  const dragIndex = useRef<number | null>(null);
  const allVisible = rows.every((item) => item.visible);
  const persist = async (next: HoldingColumnPreference[], message: string) => {
    setRows(next);
    if (await onSave(next)) showToast(message);
  };
  const toggleAll = () => {
    if (allVisible) {
      const next = rows.map((item) => ({ ...item, visible: item.key === "identity" }));
      persist(next, "已仅保留名称 / 代码列");
      return;
    }
    persist(rows.map((item) => ({ ...item, visible: true })), "已显示全部持仓列");
  };
  const toggle = (index: number) => {
    const next = rows.map((item, i) => i === index ? { ...item, visible: !item.visible } : item);
    if (!next.some((item) => item.visible)) return showToast("至少保留一列", "err");
    persist(next, "列显示设置已自动保存");
  };
  const drop = (to: number) => {
    if (dragIndex.current === null) return;
    const from = dragIndex.current;
    dragIndex.current = null;
    if (from === to) return;
    const next = [...rows];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    persist(next, "拖动成功，持仓列顺序已全局同步");
  };
  // 窄面板浮层（参考图：约 20-25% 宽、紧凑行、可滚动），替代大弹窗
  return (
    <div className="fixed inset-0 z-[9999] flex items-start justify-center p-6 pt-[12vh]">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full max-w-[320px] overflow-clip rounded-[16px] border border-edge bg-white shadow-pop dark:bg-[#1c1c1e]">
        <div className="flex items-center justify-between gap-2 border-b border-edge px-4 py-3">
          <h3 className="text-base font-semibold text-ink">需要显示哪些列</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="inline-flex h-7 w-7 flex-none items-center justify-center rounded-full text-ink-2 transition-colors hover:bg-black/5 dark:hover:bg-white/10"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-3.5 w-3.5">
              <path d="M18 6 6 18" /><path d="m6 6 12 12" />
            </svg>
          </button>
        </div>
        <div className="max-h-[55vh] overflow-y-auto py-1.5">
          <div className="mx-2 flex items-center rounded-[8px] px-2 py-1.5 transition-colors hover:bg-bg-gray">
            <FlatCheckbox checked={allVisible} onChange={toggleAll} label="全部" />
          </div>
          {rows.map((item, index) => (
            <div key={item.key} onDragOver={(event) => event.preventDefault()} onDrop={() => drop(index)} className="mx-2 flex items-center gap-1.5 rounded-[8px] px-2 py-1.5 transition-colors hover:bg-bg-gray">
              <FlatCheckbox checked={item.visible} onChange={() => toggle(index)} label={HOLDING_COLUMN_LABELS[item.key]} dim={!item.visible} />
              <button type="button" draggable onDragStart={(event) => { dragIndex.current = index; event.dataTransfer.effectAllowed = "move"; }} onDragEnd={() => { dragIndex.current = null; }} className="drag-handle inline-flex h-6 w-6 cursor-grab items-center justify-center rounded-md text-muted transition-colors hover:bg-bg-gray hover:text-ink active:cursor-grabbing" aria-label={`拖动 ${HOLDING_COLUMN_LABELS[item.key]} 排序`} title="拖动排序">
                <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4"><circle cx="8" cy="6" r="1.4" /><circle cx="16" cy="6" r="1.4" /><circle cx="8" cy="12" r="1.4" /><circle cx="16" cy="12" r="1.4" /><circle cx="8" cy="18" r="1.4" /><circle cx="16" cy="18" r="1.4" /></svg>
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
