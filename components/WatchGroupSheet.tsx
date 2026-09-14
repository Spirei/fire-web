"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { marketMeta, type StockRecord } from "@/lib/types";
import AppModal from "@/components/AppModal";
import MarketIcon from "@/components/MarketIcon";
import DeleteIcon from "@/components/DeleteIcon";
import StockSearch from "@/components/StockSearch";
import { groupCount, groupVisible, type WatchGroup } from "@/lib/watchGroups";
import { showToast } from "@/lib/toast";
import type { SearchMatch } from "@/lib/types";

interface Props {
  initialView?: "grid" | "manage";
  groups: WatchGroup[];
  records: StockRecord[];
  selectedId: string;
  onSelect: (id: string) => void;
  onClose: () => void;
  onCreate: (name: string) => Promise<boolean>;
  onUpdate: (id: string, input: { name?: string; icon?: string; visible?: number }) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
  onReorder: (order: string[]) => Promise<boolean>;
  onUploadIcon: (id: string, file: File) => Promise<boolean>;
  onAssignRecords: (ids: string[], groupId: string) => Promise<boolean>;
  onRemoveRecords: (ids: string[]) => Promise<boolean>;
  onDeleteRecords: (ids: string[]) => Promise<boolean>;
  onReorderRecords: (groupId: string, ids: string[]) => Promise<boolean>;
  onAddRecord: (groupId: string, match: SearchMatch) => Promise<boolean>;
  onImport: (groupId: string) => void;
  /** 券商图标兜底（分组无自定义图标时按分组名匹配，如长桥证劵） */
  brokerIcons?: Record<string, string>;
  /** 行情板已经解析出的分组图标（含代表股票图标兜底），保证两处显示一致 */
  resolvedGroupIcons?: Record<string, string>;
}

/** 自定义分组图标按钮：相机悬停叠加在图标上（点击上传，带动画） */
function GroupIconButton({
  icon,
  uploadBusy,
  onUpload
}: {
  icon: React.ReactNode;
  uploadBusy: boolean;
  onUpload: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onUpload}
      disabled={uploadBusy}
      title="上传分组图标"
      aria-label="上传分组图标"
      className="group relative flex h-7 w-7 flex-none items-center justify-center overflow-hidden rounded-full ring-1 ring-black/10 transition-all duration-300 hover:scale-110 hover:ring-2 hover:ring-brand/60 active:scale-95 dark:ring-white/15"
    >
      {icon}
      <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/45 text-white opacity-0 transition-opacity duration-300 group-hover:opacity-100">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
          <path d="M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4z" />
          <circle cx="12" cy="13" r="3" />
        </svg>
      </span>
    </button>
  );
}

interface ManageRowProps {
  g: WatchGroup;
  count: number;
  visible: boolean;
  icon: React.ReactNode;
  drag: Record<string, unknown>;
  onEye: () => void;
  onRename: () => void;
  onDelete?: () => void;
}

/** 管理分组行（模块作用域组件：避免组件内部定义导致的每次重渲染卸载重挂） */
function ManageRow({ g, count, visible, icon, drag, onEye, onRename, onDelete }: ManageRowProps) {
  return (
    <div {...drag} className="group/row relative flex items-center gap-2 rounded-[10px] px-2 py-2 transition-colors hover:bg-brand-hover/60 dark:hover:bg-white/[.06]">
      <svg viewBox="0 0 24 24" fill="currentColor" className="drag-handle h-3.5 w-3.5 flex-none cursor-grab text-faint">
        <circle cx="9" cy="6" r="1.4" /><circle cx="15" cy="6" r="1.4" />
        <circle cx="9" cy="12" r="1.4" /><circle cx="15" cy="12" r="1.4" />
        <circle cx="9" cy="18" r="1.4" /><circle cx="15" cy="18" r="1.4" />
      </svg>
      {icon}
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{g.name}</span>
      <span className="mr-1 w-8 flex-none text-right text-xs tabular-nums text-faint transition-opacity group-hover/row:opacity-0 group-focus-within/row:opacity-0">{count}</span>
      <div className="absolute right-1.5 flex items-center gap-0.5 rounded-[9px] border border-edge bg-white/95 p-0.5 opacity-0 shadow-sm backdrop-blur-md transition-all duration-150 group-hover/row:opacity-100 group-focus-within/row:opacity-100 dark:bg-[#252c38]/95 [@media(hover:none)]:static [@media(hover:none)]:border-0 [@media(hover:none)]:bg-transparent [@media(hover:none)]:p-0 [@media(hover:none)]:opacity-100 [@media(hover:none)]:shadow-none">
      <button
        type="button"
        onClick={onEye}
        title={visible ? "隐藏分组" : "显示分组"}
        aria-label={visible ? "隐藏分组" : "显示分组"}
        className="flex h-6 w-6 flex-none items-center justify-center rounded-md text-muted transition-colors hover:bg-black/5 hover:text-ink dark:hover:bg-white/10"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
          {visible ? (
            <>
              <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
              <circle cx="12" cy="12" r="3" />
            </>
          ) : (
            <>
              <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
              <path d="m1 1 22 22" />
            </>
          )}
        </svg>
      </button>
      <button
        type="button"
        onClick={onRename}
        title="重命名"
        aria-label="重命名"
        className="flex h-6 w-6 flex-none items-center justify-center rounded-md text-muted transition-colors hover:bg-black/5 hover:text-ink dark:hover:bg-white/10"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
          <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
        </svg>
      </button>
      {onDelete && (
        <button
          type="button"
          onClick={onDelete}
          title="删除分组"
          aria-label="删除分组"
          className="inline-flex h-6 w-6 flex-none items-center justify-center rounded-md text-faint transition-all duration-150 hover:bg-down/10 hover:text-down active:scale-95 dark:hover:bg-down/20"
        >
          <DeleteIcon size={14} />
        </button>
      )}
      </div>
    </div>
  );
}

export default function WatchGroupSheet({
  initialView = "grid",
  groups,
  records,
  selectedId,
  onSelect,
  onClose,
  onCreate,
  onUpdate,
  onDelete,
  onReorder,
  onUploadIcon,
  onAssignRecords,
  onRemoveRecords,
  onDeleteRecords,
  onReorderRecords,
  onAddRecord,
  onImport,
  brokerIcons = {},
  resolvedGroupIcons = {}
}: Props) {
  const [view, setView] = useState<"grid" | "manage">(initialView);
  const [newName, setNewName] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [rename, setRename] = useState<{ id: string; label: string } | null>(null);
  const [renameText, setRenameText] = useState("");
  const [uploadBusy, setUploadBusy] = useState(false);
  const [activeGroupId, setActiveGroupId] = useState(() => groups.some((g) => g.id === selectedId) ? selectedId : "");
  const [memberSelection, setMemberSelection] = useState<Set<string>>(new Set());
  const [pendingMemberIds, setPendingMemberIds] = useState<Set<string>>(new Set());
  const [pinnedMemberIds, setPinnedMemberIds] = useState<Set<string>>(new Set());
  const [moveMenuOpen, setMoveMenuOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const uploadTarget = useRef<string | null>(null);
  const dragIndex = useRef<number | null>(null);

  const customGroups = groups.filter((g) => g.kind === "custom");
  const allGroups: { g: WatchGroup; count: number }[] = groups.map((g) => ({ g, count: groupCount(g, records) }));
  const activeGroup = groups.find((g) => g.id === activeGroupId);
  const activeMembers = useMemo(() => {
    if (!activeGroup) return activeGroupId === "" ? records : [];
    const members = records.filter((record) => activeGroup.kind === "market" ? record.market === activeGroup.market : record.watchGroupId === activeGroup.id)
      .sort((a, b) => activeGroup.kind === "custom" ? (a.watchGroupSort ?? 0) - (b.watchGroupSort ?? 0) : 0);
    return members.filter((record) => !pendingMemberIds.has(record.id))
      .sort((a, b) => Number(pinnedMemberIds.has(b.id)) - Number(pinnedMemberIds.has(a.id)));
  }, [activeGroup, activeGroupId, pendingMemberIds, pinnedMemberIds, records]);

  useEffect(() => {
    try {
      setPinnedMemberIds(new Set(JSON.parse(localStorage.getItem("fire:watch-pinned") || "[]") as string[]));
    } catch { setPinnedMemberIds(new Set()); }
  }, []);

  useEffect(() => {
    if (!activeGroup || activeGroup.kind !== "custom") return;
    setPendingMemberIds((prev) => {
      if (prev.size === 0) return prev;
      const stillHere = new Set(records.filter((record) => record.watchGroupId === activeGroup.id).map((record) => record.id));
      const next = new Set([...prev].filter((id) => stillHere.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [activeGroup, records]);

  useEffect(() => {
    if (activeGroupId && !activeGroup) setActiveGroupId("");
  }, [activeGroup, activeGroupId]);

  useEffect(() => {
    setMemberSelection(new Set());
    setMoveMenuOpen(false);
  }, [activeGroupId]);

  function pick(id: string) {
    onSelect(id);
  }

  function toggleVisibility(g: WatchGroup) {
    const count = groupCount(g, records);
    void onUpdate(g.id, { visible: groupVisible(g, count) ? 0 : 1 });
    if (groupVisible(g, count) && selectedId === g.id) onSelect("");
  }

  function onDrop(to: number) {
    if (dragIndex.current == null) {
      dragIndex.current = null;
      return;
    }
    const from = dragIndex.current;
    dragIndex.current = null;
    if (from === to) return;
    const moved = [...groups];
    const [item] = moved.splice(from, 1);
    moved.splice(to, 0, item);
    void onReorder(moved.map((g) => g.id));
    showToast("分组顺序已更新");
  }

  function rowDragProps(index: number) {
    return {
      draggable: true,
      onPointerDown: (e: React.PointerEvent) => {
        if ((e.target as HTMLElement).closest(".drag-handle")) dragIndex.current = index;
      },
      onDragStart: (e: React.DragEvent) => {
        // dragstart 的 target 是 draggable 行本身，先由手柄的 pointerdown 解锁本次拖动。
        if (dragIndex.current !== index) {
          e.preventDefault();
          return;
        }
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", gIndexToken(index));
      },
      onDragOver: (e: React.DragEvent) => e.preventDefault(),
      onDrop: () => onDrop(index),
      onDragEnd: () => {
        dragIndex.current = null;
      }
    };
  }

  function gIndexToken(index: number) {
    return `watch-group:${index}`;
  }

  function confirmRename() {
    if (!rename) return;
    const newLabel = renameText.trim();
    if (!newLabel || newLabel === rename.label) {
      setRename(null);
      return;
    }
    void onUpdate(rename.id, { name: newLabel });
    setRename(null);
  }

  async function removeGroup(g: WatchGroup) {
    if (!confirm(`删除分组「${g.name}」？该分组下股票的所属分组将被清空。`)) return;
    const ok = await onDelete(g.id);
    if (ok && selectedId === g.id) onSelect("");
  }

  async function addGroup() {
    const name = newName.trim();
    if (!name) return;
    if (customGroups.some((g) => g.name === name)) {
      showToast("分组已存在", "err");
      return;
    }
    if (await onCreate(name)) {
      setNewName("");
      setAddOpen(false);
    }
  }

  async function uploadIcon(g: WatchGroup, f: File) {
    setUploadBusy(true);
    try {
      const ok = await onUploadIcon(g.id, f);
      if (ok) showToast(`分组「${g.name}」图标已更新`, "ok");
    } finally {
      setUploadBusy(false);
      uploadTarget.current = null;
    }
  }

  function groupIcon(g: WatchGroup, size = 20) {
    if (g.kind === "market") return <MarketIcon market={g.market} size={size} />;
    const src = resolvedGroupIcons[g.id] || g.icon || brokerIcons[g.name];
    if (src) return <img src={src} alt="" className="flex-none rounded-full object-cover" style={{ width: size, height: size }} />;
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px] flex-none text-muted">
        <path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0l-7.2-7.2A2 2 0 0 1 2.8 12V4a1 1 0 0 1 1-1h8a2 2 0 0 1 1.4.6l7.4 7.4a2 2 0 0 1 0 2.8z" />
        <circle cx="7.5" cy="7.5" r="1" fill="currentColor" />
      </svg>
    );
  }

  function exportMembers() {
    if (!activeGroup || activeMembers.length === 0) return;
    const text = [["代码", "名称", "市场"], ...activeMembers.map((record) => [record.code, record.name, marketMeta(record.market).label])]
      .map((row) => row.join("\t")).join("\n");
    const url = URL.createObjectURL(new Blob([`\ufeff${text}`], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}.txt`;
    link.click();
    URL.revokeObjectURL(url);
    showToast(`已导出「${activeGroup.name}」`);
  }

  async function removeSelectedMembers() {
    if (!activeGroup || activeGroup.kind !== "custom" || memberSelection.size === 0) return;
    if (await onRemoveRecords([...memberSelection])) setMemberSelection(new Set());
  }

  async function moveSelectedMembers(groupId: string) {
    if (memberSelection.size === 0) return;
    const ids = [...memberSelection];
    setPendingMemberIds((prev) => new Set([...prev, ...ids]));
    setMemberSelection(new Set());
    setMoveMenuOpen(false);
    if (!(await onAssignRecords(ids, groupId))) {
      setPendingMemberIds((prev) => new Set([...prev].filter((id) => !ids.includes(id))));
      setMemberSelection(new Set(ids));
    }
  }

  async function removeMember(id: string) {
    setPendingMemberIds((prev) => new Set(prev).add(id));
    if (!(await onRemoveRecords([id]))) setPendingMemberIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
  }

  async function moveMember(id: string, target: "top" | "up" | "down") {
    const scope = activeGroup?.kind === "custom" ? activeGroup.id : activeGroup?.kind === "market" ? `market:${activeGroup.market}` : "__all";
    const ids = activeMembers.map((record) => record.id);
    const from = ids.indexOf(id);
    const pinned = pinnedMemberIds.has(id);
    const sectionStart = pinned ? 0 : ids.findIndex((item) => !pinnedMemberIds.has(item));
    const sectionEnd = pinned ? ids.findLastIndex((item) => pinnedMemberIds.has(item)) : ids.length - 1;
    const to = target === "top" ? Math.max(0, sectionStart) : target === "up" ? from - 1 : from + 1;
    if (from < 0 || to < Math.max(0, sectionStart) || to > sectionEnd || from === to) return;
    ids.splice(from, 1);
    ids.splice(to, 0, id);
    await onReorderRecords(scope, ids);
  }

  async function togglePinnedMember(id: string) {
    const previous = pinnedMemberIds;
    const next = new Set(previous);
    if (next.has(id)) next.delete(id); else next.add(id);
    setPinnedMemberIds(next);
    localStorage.setItem("fire:watch-pinned", JSON.stringify([...next]));
    const ids = activeMembers.map((record) => record.id)
      .sort((a, b) => Number(next.has(b)) - Number(next.has(a)));
    const scope = activeGroup?.kind === "custom" ? activeGroup.id : activeGroup?.kind === "market" ? `market:${activeGroup.market}` : "__all";
    if (!(await onReorderRecords(scope, ids))) {
      setPinnedMemberIds(previous);
      localStorage.setItem("fire:watch-pinned", JSON.stringify([...previous]));
    }
  }

  async function deleteMember(id: string) {
    const record = activeMembers.find((item) => item.id === id);
    if (!record || !confirm(`从自选股中删除「${record.name}」？`)) return;
    setPendingMemberIds((prev) => new Set(prev).add(id));
    if (!(await onDeleteRecords([id]))) setPendingMemberIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
  }

  return (
    <AppModal
      title={view === "grid" ? `全部分组 (${groups.length + 1})` : "编辑自选分组"}
      desc={view === "manage" ? undefined : "点击分组快速筛选，隐藏的分组也能在这里查看"}
      onClose={onClose}
      size={view === "manage" ? "xl" : "md"}
      className={view === "manage" ? "!max-w-[1120px] !overflow-hidden" : ""}
    >
      {view === "manage" && (
        <button
          type="button"
          onClick={() => setView("grid")}
          className="mb-3 inline-flex items-center gap-1 rounded-full bg-bg-gray px-3 py-1.5 text-xs font-medium text-muted transition-all duration-200 hover:-translate-y-px hover:bg-brand-hover hover:text-ink active:scale-[.97]"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
            <path d="m15 18-6-6 6-6" />
          </svg>
          返回全部分组
        </button>
      )}

      {view === "grid" ? (
        <>
          <div className="grid grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={() => pick("")}
              className={`flex items-center gap-2 rounded-[12px] px-3 py-3 text-left text-sm font-medium transition-all duration-200 hover:-translate-y-px ${
                selectedId === ""
                  ? "border border-edge-strong bg-white text-ink-2 shadow-sm dark:bg-[#26282e] dark:text-white"
                  : "border border-transparent bg-bg-gray text-ink hover:bg-brand-hover"
              }`}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px] flex-none text-muted">
                <rect x="4" y="4" width="6" height="6" rx="1.5" />
                <rect x="14" y="4" width="6" height="6" rx="1.5" />
                <rect x="4" y="14" width="6" height="6" rx="1.5" />
                <rect x="14" y="14" width="6" height="6" rx="1.5" />
              </svg>
              <span className="min-w-0 flex-1 truncate">全部</span>
              <span className={`text-xs tabular-nums ${selectedId === "" ? "text-muted" : "text-faint"}`}>{records.length}</span>
            </button>
            {allGroups.map(({ g, count }) => {
              const selected = selectedId === g.id;
              return (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => pick(g.id)}
                  className={`flex items-center gap-2 rounded-[12px] px-3 py-3 text-left text-sm font-medium transition-all duration-200 hover:-translate-y-px ${
                    selected
                      ? "border border-edge-strong bg-white text-ink-2 shadow-sm dark:bg-[#26282e] dark:text-white"
                      : "border border-transparent bg-bg-gray text-ink hover:bg-brand-hover"
                  }`}
                >
                  {groupIcon(g)}
                  <span className="min-w-0 flex-1 truncate">{g.name}</span>
                  <span className={`text-xs tabular-nums ${selected ? "text-muted" : "text-faint"}`}>{count}</span>
                </button>
              );
            })}
          </div>
          <div className="mt-4 flex items-center justify-between border-t border-edge pt-3">
            <button
              type="button"
              onClick={() => setView("manage")}
              className="inline-flex items-center gap-1.5 rounded-full bg-bg-gray px-4 py-2 text-xs font-semibold text-ink-2 transition-all duration-200 hover:-translate-y-px hover:bg-brand-hover active:scale-[.97]"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
              管理分组
            </button>
            <button
              type="button"
              onClick={() => {
                setNewName("");
                setView("manage");
                setAddOpen(true);
              }}
              className="inline-flex items-center gap-1.5 rounded-full bg-bg-gray px-4 py-2 text-xs font-semibold text-ink-2 transition-all duration-200 hover:-translate-y-px hover:bg-brand-hover active:scale-[.97]"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="h-3.5 w-3.5">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 8v8M8 12h8" />
              </svg>
              新建分组
            </button>
          </div>
        </>
      ) : (
        <div className="watch-group-manage grid h-[min(620px,calc(100vh-190px))] min-h-[420px] gap-5 md:grid-cols-[240px_minmax(0,1fr)]">
          <aside className="watch-group-sidebar flex min-h-0 flex-col rounded-2xl border border-edge p-3">
            <h4 className="px-2 pb-2 text-sm font-bold text-ink">自选分组</h4>
            <div className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
              <button type="button" onClick={() => setActiveGroupId("")} className={`flex w-full items-center gap-2 rounded-xl border px-3 py-2.5 text-left transition-colors ${activeGroupId === "" ? "border-edge-strong bg-white shadow-sm dark:bg-[#26282e]" : "border-transparent hover:bg-brand-hover"}`}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5 flex-none text-muted"><rect x="4" y="4" width="6" height="6" rx="1.5"/><rect x="14" y="4" width="6" height="6" rx="1.5"/><rect x="4" y="14" width="6" height="6" rx="1.5"/><rect x="14" y="14" width="6" height="6" rx="1.5"/></svg>
                <span className="min-w-0 flex-1 text-sm font-semibold text-ink">全部</span>
                <span className="text-xs tabular-nums text-faint">{records.length}</span>
              </button>
              {groups.map((g, i) => {
                const count = groupCount(g, records);
                return (
                  <div key={g.id} onClick={() => setActiveGroupId(g.id)} className={`rounded-xl border transition-colors ${activeGroupId === g.id ? "border-edge-strong bg-white shadow-sm dark:bg-[#26282e]" : "border-transparent"}`}>
                    <ManageRow g={g} count={count} visible={groupVisible(g, count)}
                      icon={g.kind === "custom" ? <GroupIconButton icon={groupIcon(g)} uploadBusy={uploadBusy} onUpload={() => { uploadTarget.current = g.id; fileRef.current?.click(); }} /> : <span className="flex-none">{groupIcon(g)}</span>}
                      drag={rowDragProps(i)} onEye={() => toggleVisibility(g)}
                      onRename={() => { setRename({ id: g.id, label: g.name }); setRenameText(g.name); }}
                      onDelete={g.kind === "custom" ? () => void removeGroup(g) : undefined} />
                  </div>
                );
              })}
              <div className="pt-2">
                <button type="button" onClick={() => { setNewName(""); setAddOpen(true); }} className="inline-flex h-9 w-full items-center justify-center rounded-full border border-edge-strong bg-white px-4 text-xs font-semibold text-ink-2 shadow-sm transition-[transform,box-shadow] hover:-translate-y-px active:scale-[.98] dark:bg-[#1c222d] dark:text-white">添加分组</button>
              </div>
            </div>
          </aside>

          <section className="flex min-h-0 min-w-0 flex-col overflow-hidden">
            <div className="watch-group-toolbar mb-3 flex flex-wrap items-center justify-between gap-3">
              <div><h4 className="text-base font-bold text-ink">{activeGroup?.name ?? "全部"}</h4><p className="mt-0.5 text-xs text-muted">{activeMembers.length} 只股票</p></div>
              <div className="flex items-center gap-2">
                <div className="relative">
                  <button type="button" disabled={memberSelection.size === 0} onClick={() => setMoveMenuOpen((open) => !open)} className="btn btn-ghost btn-sm disabled:opacity-40">移动到分组{memberSelection.size ? ` (${memberSelection.size})` : ""}</button>
                  {moveMenuOpen && <div className="absolute right-0 top-full z-30 mt-2 min-w-[190px] rounded-xl border border-edge bg-white p-1.5 shadow-pop dark:bg-[#1b2230]">
                    {customGroups.filter((group) => group.id !== activeGroup?.id).map((group) => <button key={group.id} type="button" onClick={() => void moveSelectedMembers(group.id)} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-semibold text-muted hover:bg-brand-hover hover:text-ink">{groupIcon(group, 16)}<span className="min-w-0 flex-1 truncate">{group.name}</span></button>)}
                    {activeGroup?.kind === "custom" && <><div className="my-1 border-t border-edge"/><button type="button" onClick={() => void removeSelectedMembers()} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-semibold text-muted hover:bg-down/10 hover:text-down"><DeleteIcon size={14}/>移出当前分组</button></>}
                  </div>}
                </div>
                <button type="button" disabled={!activeMembers.length} onClick={exportMembers} className="inline-flex h-9 items-center justify-center rounded-full bg-[#111] px-5 text-xs font-semibold text-white shadow-sm transition-[transform,box-shadow] hover:-translate-y-px active:scale-[.98] disabled:pointer-events-none disabled:bg-bg-gray disabled:text-faint disabled:shadow-none dark:bg-white dark:text-[#111] dark:disabled:bg-white/5 dark:disabled:text-white/30">导出</button>
                <button type="button" onClick={() => onImport(activeGroup?.kind === "custom" ? activeGroup.id : "")} className="inline-flex h-9 items-center justify-center rounded-full border border-edge-strong bg-white px-5 text-xs font-semibold text-ink-2 shadow-sm transition-[transform,box-shadow] hover:-translate-y-px active:scale-[.98] dark:bg-[#1c222d] dark:text-white">导入</button>
              </div>
            </div>
            <div className="relative z-20 mb-3">
              {activeGroup?.kind === "custom" ? (
                <StockSearch securitiesOnly placeholder="搜索市场股票并添加到当前分组" onSelect={(match) => void onAddRecord(activeGroup.id, match)} />
              ) : (
                <div className="flex h-[42px] items-center gap-2.5 rounded-full border border-edge bg-bg-gray/50 px-4 text-sm text-faint">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-4 w-4"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
                  市场分组自动归类，无需手动添加
                </div>
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-auto rounded-2xl border border-edge">
              <table className="w-full min-w-[520px] text-sm">
                <thead className="sticky top-0 z-10 bg-bg-gray text-xs text-muted"><tr>
                  <th className="w-12 px-4 py-3 text-left"><input className="watch-checkbox" type="checkbox" aria-label="全选当前列表" checked={activeMembers.length > 0 && activeMembers.every((r) => memberSelection.has(r.id))} onChange={() => setMemberSelection((prev) => activeMembers.every((r) => prev.has(r.id)) ? new Set() : new Set(activeMembers.map((r) => r.id)))} /></th>
                  <th className="px-2 py-3 text-left font-semibold">代码</th><th className="px-2 py-3 text-left font-semibold">名称</th><th className="px-2 py-3 text-left font-semibold">市场</th><th className="w-36 px-3 py-3 text-right font-semibold">操作</th>
                </tr></thead>
                <tbody>{activeMembers.map((record, index) => <tr key={record.id} className="group/stock border-t border-edge transition-colors hover:bg-brand-hover">
                  <td className="px-4 py-4"><input className="watch-checkbox" type="checkbox" aria-label={`选择 ${record.name}`} checked={memberSelection.has(record.id)} onChange={() => setMemberSelection((prev) => { const next = new Set(prev); if (next.has(record.id)) next.delete(record.id); else next.add(record.id); return next; })} /></td>
                  <td className="px-2 py-4 font-semibold text-ink-2">{record.code}</td><td className="px-2 py-4 text-ink">{record.name}</td><td className="px-2 py-4 text-muted"><span className="inline-flex items-center" title={marketMeta(record.market).label} aria-label={marketMeta(record.market).label}><MarketIcon market={record.market} size={24} /></span></td>
                  <td className="px-3 py-3 text-right"><span className="inline-flex gap-1">
                    <button type="button" disabled={index === 0} onClick={() => void moveMember(record.id, "up")} title="上移" aria-label={`将 ${record.name} 上移`} className="grid h-7 w-7 place-items-center rounded-lg text-muted opacity-0 transition-opacity duration-150 hover:bg-brand-hover hover:text-ink group-hover/stock:opacity-100 group-focus-within/stock:opacity-100 disabled:opacity-0 group-hover/stock:disabled:opacity-25">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="m6 14 6-6 6 6" /></svg>
                    </button>
                    <button type="button" disabled={index === activeMembers.length - 1} onClick={() => void moveMember(record.id, "down")} title="下移" aria-label={`将 ${record.name} 下移`} className="grid h-7 w-7 place-items-center rounded-lg text-muted opacity-0 transition-opacity duration-150 hover:bg-brand-hover hover:text-ink group-hover/stock:opacity-100 group-focus-within/stock:opacity-100 disabled:opacity-0 group-hover/stock:disabled:opacity-25">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="m6 10 6 6 6-6" /></svg>
                    </button>
                    <button type="button" onClick={() => void togglePinnedMember(record.id)} title={pinnedMemberIds.has(record.id) ? "取消置顶" : "置顶"} aria-label={`${pinnedMemberIds.has(record.id) ? "取消置顶" : "置顶"} ${record.name}`} className={`grid h-7 w-7 place-items-center rounded-full opacity-0 transition-all duration-150 hover:text-ink group-hover/stock:opacity-100 group-focus-within/stock:opacity-100 ${pinnedMemberIds.has(record.id) ? "bg-[#d8dbe1] text-[#252a33] shadow-[inset_0_0_0_1px_rgba(37,42,51,.08)] dark:bg-[#343943] dark:text-white dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,.1)]" : "text-muted hover:bg-brand-hover"}`}>
                      <svg viewBox="0 0 24 24" fill="currentColor" className="h-[15px] w-[15px]"><path d="M9 3.5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v4.15l2.6 2.6a1 1 0 0 1-.7 1.7H13v7.55a1 1 0 0 1-2 0v-7.55H7.1a1 1 0 0 1-.7-1.7L9 7.65V3.5Z" /></svg>
                    </button>
                    <button type="button" onClick={() => activeGroup?.kind === "custom" ? void removeMember(record.id) : void deleteMember(record.id)} title={activeGroup?.kind === "custom" ? "移出分组" : "删除自选股"} className="grid h-7 w-7 place-items-center rounded-lg text-muted opacity-0 transition-opacity duration-150 hover:bg-down/10 hover:text-down group-hover/stock:opacity-100 group-focus-within/stock:opacity-100"><DeleteIcon size={14} /></button>
                  </span></td>
                </tr>)}</tbody>
              </table>
              {activeMembers.length === 0 && <div className="flex min-h-[300px] items-center justify-center text-sm text-faint">该分组暂无股票</div>}
            </div>
            {activeGroup?.kind === "market" && <p className="mt-2 text-xs text-faint">市场分组按股票市场自动归类，可查看和导出；成员调整请在自定义分组中进行。</p>}
          </section>
        </div>
      )}

      {rename && (
        <div className="absolute inset-0 z-50 flex items-center justify-center rounded-[28px] bg-black/25 p-5 backdrop-blur-[2px]" role="dialog" aria-modal="true" aria-label="修改分组名称" onMouseDown={(e) => e.target === e.currentTarget && setRename(null)}>
          <div className="w-full max-w-[380px] rounded-[22px] border border-white/70 bg-white p-5 shadow-[0_24px_70px_rgba(15,23,42,.24)] dark:border-white/10 dark:bg-[#1d232e] dark:shadow-[0_28px_80px_rgba(0,0,0,.55)]">
            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
                <h4 className="text-base font-bold text-ink">修改分组名称</h4>
                <p className="mt-1 text-xs text-muted">为“{rename.label}”输入一个新名称</p>
              </div>
              <button type="button" onClick={() => setRename(null)} aria-label="关闭修改名称弹窗" className="grid h-8 w-8 flex-none place-items-center rounded-full text-muted transition-colors hover:bg-bg-gray hover:text-ink">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-4 w-4"><path d="M18 6 6 18M6 6l12 12" /></svg>
              </button>
            </div>
            <input
              value={renameText}
              onChange={(e) => setRenameText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") confirmRename(); if (e.key === "Escape") { e.stopPropagation(); setRename(null); } }}
              autoFocus
              maxLength={24}
              placeholder="输入分组名称"
              className="h-11 w-full rounded-xl border border-edge-strong bg-bg-gray px-3.5 text-sm font-medium text-ink outline-none transition-all placeholder:text-faint focus:border-brand focus:bg-white focus:ring-4 focus:ring-brand/10 dark:focus:bg-[#252c38]"
            />
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setRename(null)} className="h-9 rounded-full border border-edge bg-white px-4 text-xs font-semibold text-ink-2 transition-colors hover:bg-brand-hover dark:border-white/10 dark:bg-[#1c222d] dark:text-white/80 dark:hover:bg-white/10">取消</button>
              <button type="button" onClick={confirmRename} disabled={!renameText.trim()} className="h-9 rounded-full bg-[#111] px-5 text-xs font-semibold text-white shadow-sm transition-all hover:-translate-y-px active:scale-[.98] disabled:pointer-events-none disabled:opacity-40 dark:bg-white dark:text-[#111]">保存</button>
            </div>
          </div>
        </div>
      )}

      {addOpen && (
        <div className="absolute inset-0 z-50 flex items-center justify-center rounded-[28px] bg-black/25 p-5 backdrop-blur-[2px]" role="dialog" aria-modal="true" aria-label="添加分组" onMouseDown={(e) => e.target === e.currentTarget && setAddOpen(false)}>
          <div className="w-full max-w-[380px] rounded-[22px] border border-white/70 bg-white p-5 shadow-[0_24px_70px_rgba(15,23,42,.24)] dark:border-white/10 dark:bg-[#1d232e] dark:shadow-[0_28px_80px_rgba(0,0,0,.55)]">
            <div className="mb-4 flex items-start justify-between gap-4">
              <div><h4 className="text-base font-bold text-ink">添加分组</h4><p className="mt-1 text-xs text-muted">创建一个新的自选分组</p></div>
              <button type="button" onClick={() => setAddOpen(false)} aria-label="关闭添加分组弹窗" className="grid h-8 w-8 flex-none place-items-center rounded-full text-muted transition-colors hover:bg-bg-gray hover:text-ink">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-4 w-4"><path d="M18 6 6 18M6 6l12 12" /></svg>
              </button>
            </div>
            <input value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void addGroup(); if (e.key === "Escape") { e.stopPropagation(); setAddOpen(false); } }} autoFocus maxLength={24} placeholder="输入分组名称" className="h-11 w-full rounded-xl border border-edge-strong bg-bg-gray px-3.5 text-sm font-medium text-ink outline-none transition-all placeholder:text-faint focus:border-brand focus:bg-white focus:ring-4 focus:ring-brand/10 dark:focus:bg-[#252c38]" />
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setAddOpen(false)} className="h-9 rounded-full border border-edge bg-white px-4 text-xs font-semibold text-ink-2 transition-colors hover:bg-brand-hover dark:border-white/10 dark:bg-[#1c222d] dark:text-white/80 dark:hover:bg-white/10">取消</button>
              <button type="button" onClick={() => void addGroup()} disabled={!newName.trim()} className="h-9 rounded-full bg-[#111] px-5 text-xs font-semibold text-white shadow-sm transition-all hover:-translate-y-px active:scale-[.98] disabled:pointer-events-none disabled:opacity-40 dark:bg-white dark:text-[#111]">添加</button>
            </div>
          </div>
        </div>
      )}

      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/gif,image/webp,image/svg+xml"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          const g = groups.find((x) => x.id === uploadTarget.current);
          if (f && g) void uploadIcon(g, f);
        }}
      />
    </AppModal>
  );
}
