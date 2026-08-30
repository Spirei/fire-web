"use client";

import { useRef, useState } from "react";
import type { StockRecord } from "@/lib/types";
import AppModal from "@/components/AppModal";
import MarketIcon from "@/components/MarketIcon";
import DeleteIcon from "@/components/DeleteIcon";
import { groupCount, groupVisible, type WatchGroup } from "@/lib/watchGroups";
import { showToast } from "@/lib/toast";

interface Props {
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
  /** 券商图标兜底（分组无自定义图标时按分组名匹配，如长桥证劵） */
  brokerIcons?: Record<string, string>;
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
    <div {...drag} className="flex items-center gap-2 rounded-[10px] px-2 py-2 transition-colors hover:bg-brand-hover">
      <svg viewBox="0 0 24 24" fill="currentColor" className="drag-handle h-3.5 w-3.5 flex-none cursor-grab text-faint">
        <circle cx="9" cy="6" r="1.4" /><circle cx="15" cy="6" r="1.4" />
        <circle cx="9" cy="12" r="1.4" /><circle cx="15" cy="12" r="1.4" />
        <circle cx="9" cy="18" r="1.4" /><circle cx="15" cy="18" r="1.4" />
      </svg>
      {icon}
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{g.name}</span>
      <span className="text-xs tabular-nums text-faint">{count}</span>
      <button
        type="button"
        onClick={onEye}
        title={visible ? "隐藏分组" : "显示分组"}
        aria-label={visible ? "隐藏分组" : "显示分组"}
        className="flex h-7 w-7 flex-none items-center justify-center rounded-full text-muted transition-colors hover:bg-black/5 hover:text-ink dark:hover:bg-white/10"
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
        className="flex h-7 w-7 flex-none items-center justify-center rounded-full text-muted transition-colors hover:bg-black/5 hover:text-ink dark:hover:bg-white/10"
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
          className="inline-flex h-7 w-7 flex-none items-center justify-center rounded-[8px] border border-edge text-faint transition-all duration-200 hover:border-down/40 hover:bg-down/10 hover:text-down active:scale-[.97] dark:border-white/10 dark:hover:bg-down/20"
        >
          <DeleteIcon size={14} />
        </button>
      )}
    </div>
  );
}

export default function WatchGroupSheet({
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
  brokerIcons = {}
}: Props) {
  const [view, setView] = useState<"grid" | "manage">("grid");
  const [newName, setNewName] = useState("");
  const [rename, setRename] = useState<{ id: string; label: string } | null>(null);
  const [renameText, setRenameText] = useState("");
  const [uploadBusy, setUploadBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const uploadTarget = useRef<string | null>(null);
  const dragIndex = useRef<number | null>(null);
  const dragSection = useRef<"M" | "G" | null>(null);

  const marketGroups = groups.filter((g) => g.kind === "market");
  const customGroups = groups.filter((g) => g.kind === "custom");
  const allGroups: { g: WatchGroup; count: number }[] = groups.map((g) => ({ g, count: groupCount(g, records) }));

  function pick(id: string) {
    onSelect(id);
  }

  function toggleVisibility(g: WatchGroup) {
    const count = groupCount(g, records);
    void onUpdate(g.id, { visible: groupVisible(g, count) ? 0 : 1 });
    if (groupVisible(g, count) && selectedId === g.id) onSelect("");
  }

  function onDrop(section: "M" | "G") {
    if (dragIndex.current == null || dragSection.current !== section) {
      dragIndex.current = null;
      dragSection.current = null;
      return;
    }
    const from = dragIndex.current;
    const sectionGroups = section === "M" ? marketGroups : customGroups;
    const to = Math.min(Math.max(from, 0), sectionGroups.length - 1);
    dragIndex.current = null;
    dragSection.current = null;
    if (from === to) return;
    const moved = [...sectionGroups];
    const [item] = moved.splice(from, 1);
    moved.splice(to, 0, item);
    // 整体顺序 = 市场分区 + 自定义分区（保持各自分区连续）
    const marketIds = (section === "M" ? moved : marketGroups).map((g) => g.id);
    const customIds = (section === "G" ? moved : customGroups).map((g) => g.id);
    void onReorder([...marketIds, ...customIds]);
    showToast("分组顺序已更新");
  }

  function rowDragProps(section: "M" | "G", index: number) {
    return {
      draggable: true,
      onDragStart: (e: React.DragEvent) => {
        // 只允许拖动手柄发起拖动：避免 HTML5 拖拽吃掉行内按钮（相机/眼睛/铅笔/删除）的点击
        if (!(e.target as HTMLElement).closest(".drag-handle")) {
          e.preventDefault();
          return;
        }
        dragIndex.current = index;
        dragSection.current = section;
      },
      onDragOver: (e: React.DragEvent) => e.preventDefault(),
      onDrop: () => onDrop(section),
      onDragEnd: () => {
        dragIndex.current = null;
        dragSection.current = null;
      }
    };
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

  function addGroup() {
    const name = newName.trim();
    if (!name) return;
    if (customGroups.some((g) => g.name === name)) {
      showToast("分组已存在", "err");
      return;
    }
    void onCreate(name).then((ok) => ok && setNewName(""));
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
    const src = g.icon || brokerIcons[g.name];
    if (src) return <img src={src} alt="" className="flex-none rounded-full object-cover" style={{ width: size, height: size }} />;
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px] flex-none text-muted">
        <path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0l-7.2-7.2A2 2 0 0 1 2.8 12V4a1 1 0 0 1 1-1h8a2 2 0 0 1 1.4.6l7.4 7.4a2 2 0 0 1 0 2.8z" />
        <circle cx="7.5" cy="7.5" r="1" fill="currentColor" />
      </svg>
    );
  }

  return (
    <AppModal
      title={view === "grid" ? `全部分组 (${groups.length + 1})` : "管理分组"}
      desc={view === "manage" ? "拖动排序 · 相机图标 · 眼睛显隐 · 铅笔重命名" : "点击分组快速筛选，隐藏的分组也能在这里查看"}
      onClose={onClose}
      size="md"
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
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-[18px] w-[18px] flex-none text-muted">
                <circle cx="12" cy="12" r="9" />
                <path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" />
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
        <div className="space-y-5">
          <section>
            <h4 className="mb-1.5 text-xs font-semibold text-faint">市场分组</h4>
            <div className="space-y-1">
              {marketGroups.map((g, i) => {
                const count = groupCount(g, records);
                return (
                  <ManageRow
                    key={g.id}
                    g={g}
                    count={count}
                    visible={groupVisible(g, count)}
                    icon={<span className="flex-none">{groupIcon(g)}</span>}
                    drag={rowDragProps("M", i)}
                    onEye={() => toggleVisibility(g)}
                    onRename={() => {
                      setRename({ id: g.id, label: g.name });
                      setRenameText(g.name);
                    }}
                  />
                );
              })}
            </div>
          </section>

          <section>
            <h4 className="mb-1.5 text-xs font-semibold text-faint">我的分组</h4>
            {customGroups.length === 0 ? (
              <p className="rounded-[10px] bg-bg-gray px-3 py-3 text-xs text-faint">暂无自定义分组，下方新建分组</p>
            ) : (
              <div className="space-y-1">
                {customGroups.map((g, i) => {
                  const count = groupCount(g, records);
                  return (
                    <ManageRow
                      key={g.id}
                      g={g}
                      count={count}
                      visible={groupVisible(g, count)}
                      icon={
                        <GroupIconButton
                          icon={groupIcon(g)}
                          uploadBusy={uploadBusy}
                          onUpload={() => {
                            uploadTarget.current = g.id;
                            fileRef.current?.click();
                          }}
                        />
                      }
                      drag={rowDragProps("G", i)}
                      onEye={() => toggleVisibility(g)}
                      onRename={() => {
                        setRename({ id: g.id, label: g.name });
                        setRenameText(g.name);
                      }}
                      onDelete={() => removeGroup(g)}
                    />
                  );
                })}
              </div>
            )}
          </section>

          {rename && (
            <div className="flex items-center gap-2">
              <input
                value={renameText}
                onChange={(e) => setRenameText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && confirmRename()}
                autoFocus
                className="min-w-0 flex-1 rounded-full border border-edge-strong bg-white px-4 py-2 text-sm outline-none dark:bg-[#26282e] dark:text-white"
                placeholder="修改名称"
              />
              <button type="button" onClick={confirmRename} className="rounded-full bg-ink px-4 py-2 text-xs font-semibold text-white transition-transform active:scale-[.97] dark:bg-white dark:text-black">
                确定
              </button>
              <button type="button" onClick={() => setRename(null)} className="rounded-full bg-bg-gray px-4 py-2 text-xs font-medium text-muted transition-colors hover:bg-brand-hover">
                取消
              </button>
            </div>
          )}

          <div className="flex items-center gap-2 border-t border-edge pt-4">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addGroup()}
              placeholder="新建分组，如：科技 / 核心持仓"
              className="min-w-0 flex-1 rounded-full border border-edge-strong bg-white px-4 py-2 text-sm outline-none dark:bg-[#26282e] dark:text-white"
            />
            <button type="button" onClick={addGroup} className="rounded-full bg-ink px-4 py-2 text-xs font-semibold text-white transition-transform active:scale-[.97] dark:bg-white dark:text-black">
              添加
            </button>
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
