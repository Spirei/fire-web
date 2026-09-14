"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, ReactNode } from "react";
import { showToast } from "@/lib/toast";
import AppSelect from "@/components/AppSelect";
import LibraryAttachmentsView, { FinancialAttachments } from "@/components/LibraryAttachmentsView";
import DeleteIcon from "@/components/DeleteIcon";

interface Entry {
  name: string;
  rel: string;
  isDir: boolean;
  size: number;
  mtime: string;
  ext: string;
}

interface ListData {
  path: string;
  dirs: Entry[];
  files: Entry[];
}

type ViewMode = "list" | "grid" | "tree";
type SortMode = "mtime" | "name" | "size";
type ConflictMode = "error" | "replace" | "keep-both";
type UploadStatus = "queued" | "uploading" | "conflict" | "done" | "error" | "cancelled";

interface UploadTask {
  id: string;
  file: File;
  dir: string;
  status: UploadStatus;
  progress: number;
  error?: string;
}

interface FileOperation {
  mode: "rename" | "move" | "copy";
  entry: Entry;
}

const inputCls = "h-[36px] rounded-[10px] border border-edge-strong bg-white px-3 text-sm text-ink outline-none transition-shadow focus:border-edge-strong focus:shadow-[0_0_0_3px_rgba(107,114,128,.14)] dark:bg-[#151a26] dark:text-[#e5e7eb]";

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fileType(ext: string): string {
  const value = ext.toLowerCase();
  if (value === "pdf") return "PDF 文档";
  if (["xlsx", "xls"].includes(value)) return "Excel 表格";
  if (value === "csv") return "CSV 数据";
  if (value === "json") return "JSON 数据";
  if (value === "xml") return "XML 文档";
  if (["png", "jpg", "jpeg", "webp", "gif", "svg"].includes(value)) return "图片";
  if (["zip", "rar", "7z", "tar", "gz"].includes(value)) return "压缩文件";
  return value ? `${value.toUpperCase()} 文件` : "文件";
}

function FolderIcon({ className = "h-4 w-4" }: { className?: string }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></svg>;
}

function FileIcon({ ext, className = "h-4 w-4" }: { ext: string; className?: string }) {
  const kind = ext === "xml" || ext === "json" || ext === "txt" || ext === "csv" ? "text-brand-deep" : ext === "pdf" ? "text-up" : ext === "xlsx" || ext === "xls" ? "text-down" : "text-faint";
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={`${className} ${kind}`}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" /><path d="M14 3v5h5" /></svg>;
}

function DownloadIcon({ className = "h-4 w-4" }: { className?: string }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5" /><path d="M12 15V3" /></svg>;
}

function UploadIcon({ className = "h-4 w-4" }: { className?: string }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m17 8-5-5-5 5" /><path d="M12 3v12" /></svg>;
}

function FolderPlusIcon({ className = "h-4 w-4" }: { className?: string }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /><path d="M12 11v5M9.5 13.5h5" /></svg>;
}

function RefreshIcon({ className = "h-4 w-4" }: { className?: string }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></svg>;
}

function CloseIcon({ className = "h-4 w-4" }: { className?: string }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={className}><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>;
}

function ViewIcon({ mode }: { mode: ViewMode }) {
  if (mode === "grid") return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4"><rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" /><rect x="4" y="14" width="6" height="6" rx="1" /><rect x="14" y="14" width="6" height="6" rx="1" /></svg>;
  if (mode === "tree") return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="h-4 w-4"><path d="M7 4v16M7 8h5M7 16h5" /><rect x="12" y="5" width="8" height="6" rx="1.5" /><rect x="12" y="13" width="8" height="6" rx="1.5" /></svg>;
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="h-4 w-4"><path d="M9 6h11M9 12h11M9 18h11" /><circle cx="5" cy="6" r="1" fill="currentColor" stroke="none" /><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="5" cy="18" r="1" fill="currentColor" stroke="none" /></svg>;
}

function TrashIcon({ className = "h-4 w-4" }: { className?: string }) {
  const match = /h-\[?(\d+(?:\.5)?)px?\]?/.exec(className);
  return <DeleteIcon size={match ? parseFloat(match[1]) : 16} />;
}

function ExtBadge({ ext }: { ext: string }) {
  return ext ? <span className="attachment-ext-badge">{ext}</span> : null;
}

function LoadingState() {
  return <div className="attachment-loading-state" aria-label="正在加载附件"><span /><span /><span /></div>;
}

function isPreviewable(entry: Entry): boolean {
  return !entry.isDir && ["png", "jpg", "jpeg", "webp", "gif", "svg", "pdf", "txt", "md", "csv", "json", "xml"].includes(entry.ext);
}

function AttachmentModalShell({ children, onClose, labelledBy, alert = false, wide = false }: { children: ReactNode; onClose: () => void; labelledBy: string; alert?: boolean; wide?: boolean }) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const focusables = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])') ?? []);
    requestAnimationFrame(() => focusables()[0]?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previous?.focus();
    };
  }, []);
  return <div className="attachment-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeRef.current(); }}><div ref={dialogRef} className={`attachment-modal ${wide ? "is-wide" : ""}`} role={alert ? "alertdialog" : "dialog"} aria-modal="true" aria-labelledby={labelledBy}>{children}</div></div>;
}

export default function AttachmentsView() {
  // 分类状态 URL 持久化：刷新保持当前分类（?category=docs|reports|library）
  const [category, setCategory] = useState<"docs" | "reports" | "library">(() => {
    if (typeof window === "undefined") return "docs";
    const seg = new URLSearchParams(window.location.search).get("category");
    return seg === "reports" || seg === "library" ? seg : "docs";
  });
  useEffect(() => {
    const url = new URL(window.location.href);
    if (category === "docs") url.searchParams.delete("category");
    else url.searchParams.set("category", category);
    window.history.replaceState({}, "", url.toString());
  }, [category]);
  const [path, setPath] = useState("");
  const [dirs, setDirs] = useState<Entry[]>([]);
  const [files, setFiles] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [sort, setSort] = useState<SortMode>("mtime");
  const [mkDirOpen, setMkDirOpen] = useState(false);
  const [newDirName, setNewDirName] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [confirmDel, setConfirmDel] = useState<Entry | null>(null);
  const [recursiveDelete, setRecursiveDelete] = useState(false);
  const [selected, setSelected] = useState<Entry | null>(null);
  const [preview, setPreview] = useState<Entry | null>(null);
  const [operation, setOperation] = useState<FileOperation | null>(null);
  const [operationName, setOperationName] = useState("");
  const [targetDir, setTargetDir] = useState("");
  const [operationConflict, setOperationConflict] = useState<ConflictMode>("keep-both");
  const [directories, setDirectories] = useState<string[]>([""]);
  const [uploadTasks, setUploadTasks] = useState<UploadTask[]>([]);
  const [treeExpanded, setTreeExpanded] = useState<Set<string>>(new Set());
  const [treeChildren, setTreeChildren] = useState<Record<string, ListData>>({});
  const [treeVersion, setTreeVersion] = useState(0);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const uploadXhrs = useRef<Map<string, XMLHttpRequest>>(new Map());
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentPathRef = useRef(path);
  currentPathRef.current = path;

  const invalidateTree = useCallback(() => {
    setTreeChildren({});
    setTreeExpanded(new Set());
    setTreeVersion((value) => value + 1);
  }, []);

  const load = useCallback(async (rel: string) => {
    setLoading(true);
    setLoadError("");
    try {
      const res = await fetch(`/api/attachments?path=${encodeURIComponent(rel)}`);
      const data = (await res.json()) as ListData & { error?: string };
      if (!res.ok) throw new Error(data.error || "读取失败");
      setDirs(data.dirs ?? []);
      setFiles(data.files ?? []);
    } catch (err) {
      const message = err instanceof Error ? err.message : "读取附件失败";
      setLoadError(message);
      showToast(message, "err");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setSelected(null);
    setSearch("");
    load(path);
  }, [path, load]);

  const crumbs = useMemo(() => {
    const parts = path ? path.split("/") : [];
    return parts.map((part, index) => ({ name: part, rel: parts.slice(0, index + 1).join("/") }));
  }, [path]);

  const visibleDirs = useMemo(() => {
    const query = search.trim().toLowerCase();
    return [...dirs].filter((entry) => !query || entry.name.toLowerCase().includes(query)).sort((a, b) => sort === "mtime" ? b.mtime.localeCompare(a.mtime) : a.name.localeCompare(b.name, "zh-CN"));
  }, [dirs, search, sort]);

  const visibleFiles = useMemo(() => {
    const query = search.trim().toLowerCase();
    return [...files].filter((entry) => !query || entry.name.toLowerCase().includes(query)).sort((a, b) => {
      if (sort === "name") return a.name.localeCompare(b.name, "zh-CN");
      if (sort === "size") return b.size - a.size;
      return b.mtime.localeCompare(a.mtime);
    });
  }, [files, search, sort]);

  const totalSize = useMemo(() => files.reduce((sum, entry) => sum + entry.size, 0), [files]);
  const resultCount = visibleDirs.length + visibleFiles.length;

  async function refresh(withToast = true) {
    invalidateTree();
    await load(path);
    if (withToast) showToast("文件列表已更新", "ok");
  }

  function updateUploadTask(id: string, patch: Partial<UploadTask>) {
    setUploadTasks((current) => current.map((task) => task.id === id ? { ...task, ...patch } : task));
  }

  function scheduleReload(targetPath: string) {
    if (reloadTimer.current) clearTimeout(reloadTimer.current);
    reloadTimer.current = setTimeout(() => {
      invalidateTree();
      if (targetPath === currentPathRef.current) void load(targetPath);
    }, 180);
  }

  function sendUpload(task: UploadTask, conflict: ConflictMode = "error") {
    const form = new FormData();
    form.append("action", "upload");
    form.append("dir", task.dir);
    form.append("file", task.file);
    form.append("conflict", conflict);
    const xhr = new XMLHttpRequest();
    uploadXhrs.current.set(task.id, xhr);
    updateUploadTask(task.id, { status: "uploading", progress: 0, error: undefined });
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) updateUploadTask(task.id, { progress: Math.min(99, Math.round(event.loaded / event.total * 100)) });
    };
    xhr.onload = () => {
      uploadXhrs.current.delete(task.id);
      let response: { error?: string } | null = null;
      try { response = JSON.parse(xhr.responseText); } catch { /* 空响应 */ }
      if (xhr.status >= 200 && xhr.status < 300) {
        updateUploadTask(task.id, { status: "done", progress: 100 });
        scheduleReload(task.dir);
      } else if (xhr.status === 409) {
        updateUploadTask(task.id, { status: "conflict", progress: 0, error: response?.error || "同名文件已存在" });
      } else {
        updateUploadTask(task.id, { status: "error", progress: 0, error: response?.error || "上传失败" });
      }
    };
    xhr.onerror = () => {
      uploadXhrs.current.delete(task.id);
      updateUploadTask(task.id, { status: "error", progress: 0, error: "网络异常，请重试" });
    };
    xhr.onabort = () => {
      uploadXhrs.current.delete(task.id);
      updateUploadTask(task.id, { status: "cancelled", progress: 0, error: "已取消" });
    };
    xhr.open("POST", "/api/attachments");
    xhr.send(form);
  }

  function uploadFiles(filesArr: File[]) {
    if (filesArr.length === 0) return;
    const tasks = filesArr.map<UploadTask>((file, index) => ({
      id: `${Date.now()}-${index}-${Math.random().toString(36).slice(2)}`,
      file,
      dir: path,
      status: file.size > 50 * 1024 * 1024 ? "error" : "queued",
      progress: 0,
      error: file.size > 50 * 1024 * 1024 ? "超过单文件 50 MB 限制" : undefined
    }));
    setUploadTasks((current) => [...tasks, ...current].slice(0, 40));
    tasks.filter((task) => task.status === "queued").forEach((task) => sendUpload(task));
  }

  async function handleUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(event.target.files ?? []);
    event.target.value = "";
    uploadFiles(picked);
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDragActive(true);
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDragActive(false);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragActive(false);
    uploadFiles(Array.from(event.dataTransfer.files ?? []));
  }

  async function createDir() {
    const name = newDirName.trim();
    if (!name) return;
    setBusy(true);
    try {
      const body = new FormData();
      body.append("action", "mkdir");
      body.append("parent", path);
      body.append("name", name);
      const res = await fetch("/api/attachments", { method: "POST", body });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "创建失败");
      showToast(`已创建目录 ${name}`, "ok");
      setMkDirOpen(false);
      setNewDirName("");
      invalidateTree();
      await load(path);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "创建目录失败", "err");
    } finally {
      setBusy(false);
    }
  }

  async function remove(entry: Entry) {
    setConfirmDel(null);
    try {
      const force = entry.isDir && recursiveDelete ? "&force=1" : "";
      const res = await fetch(`/api/attachments?path=${encodeURIComponent(entry.rel)}${force}`, { method: "DELETE" });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "删除失败");
      setSelected((current) => current?.rel === entry.rel ? null : current);
      showToast(`已删除 ${entry.name}`, "ok");
      setRecursiveDelete(false);
      invalidateTree();
      await load(path);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "删除失败", "err");
    }
  }

  useEffect(() => () => {
    uploadXhrs.current.forEach((xhr) => xhr.abort());
    if (reloadTimer.current) clearTimeout(reloadTimer.current);
  }, []);

  async function toggleTree(dir: string) {
    const next = new Set(treeExpanded);
    if (next.has(dir)) {
      next.delete(dir);
      setTreeExpanded(next);
      return;
    }
    next.add(dir);
    setTreeExpanded(next);
    if (!treeChildren[dir]) {
      try {
        const res = await fetch(`/api/attachments?path=${encodeURIComponent(dir)}`);
        const data = await res.json();
        if (res.ok) setTreeChildren((current) => ({ ...current, [dir]: data }));
      } catch {
        showToast("目录展开失败，请重试", "err");
      }
    }
  }

  function cancelUpload(task: UploadTask) {
    const xhr = uploadXhrs.current.get(task.id);
    if (xhr) xhr.abort();
    else updateUploadTask(task.id, { status: "cancelled", progress: 0, error: "已取消" });
  }

  function retryUpload(task: UploadTask, conflict: ConflictMode = "error") {
    sendUpload(task, conflict);
  }

  async function openOperation(mode: FileOperation["mode"], entry: Entry) {
    setOperation({ mode, entry });
    setOperationName(entry.name);
    setTargetDir(path);
    setOperationConflict(mode === "rename" ? "error" : "keep-both");
    if (mode !== "rename") {
      try {
        const response = await fetch("/api/attachments?action=directories");
        const body = await response.json().catch(() => null);
        if (!response.ok) throw new Error(body?.error || "目录读取失败");
        setDirectories(Array.isArray(body?.directories) ? body.directories : [""]);
      } catch (error) {
        showToast(error instanceof Error ? error.message : "目录读取失败", "err");
      }
    }
  }

  async function runOperation() {
    if (!operation) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.append("action", operation.mode);
      form.append("source", operation.entry.rel);
      form.append("conflict", operationConflict);
      if (operation.mode === "rename") form.append("name", operationName.trim());
      else form.append("targetDir", targetDir);
      const response = await fetch("/api/attachments", { method: "POST", body: form });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error || "操作失败");
      showToast(operation.mode === "rename" ? "已重命名" : operation.mode === "move" ? "已移动" : "已复制", "ok");
      setSelected(null);
      setOperation(null);
      invalidateTree();
      await load(path);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "操作失败", "err");
    } finally {
      setBusy(false);
    }
  }

  async function copyEntryPath(entry: Entry) {
    try {
      await navigator.clipboard.writeText(entry.rel);
      showToast("已复制相对路径", "ok");
    } catch {
      showToast("复制失败", "err");
    }
  }

  return (
    <div className="attachments-page">
      <input ref={fileRef} type="file" multiple className="hidden" onChange={handleUpload} />
      <header className="attachments-page-header">
        <div className="attachments-title-group"><span className="attachments-title-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-[22px] w-[22px]"><path d="M4 6a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.4.6L12.4 6H18a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z" /><path d="M4 10h16" /></svg></span><div><h2>附件管理</h2></div></div>
        {category === "docs" && <div className="attachments-summary" aria-label="当前目录统计"><span><strong>{dirs.length}</strong> 个文件夹</span><span><strong>{files.length}</strong> 个文件</span><span><strong>{fmtSize(totalSize)}</strong> 当前目录大小</span></div>}
      </header>

      <nav className="attachments-space-tabs" aria-label="附件分类">
        <button type="button" onClick={() => setCategory("docs")} className={category === "docs" ? "is-active" : ""}><FolderIcon className="h-4 w-4" /><span>文件管理</span></button>
        <button type="button" onClick={() => setCategory("reports")} className={category === "reports" ? "is-active" : ""}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" /><path d="M14 3v5h5" /><path d="M9 13h6M9 17h4" /></svg><span>财报文件</span></button>
        <button type="button" onClick={() => setCategory("library")} className={category === "library" ? "is-active" : ""}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9Z" /><path d="m4.4 7.7 7.6 4.2 7.6-4.2M12 12v9" /></svg><span>素材资源</span></button>
      </nav>

      {category === "library" ? <section className="attachments-library-shell"><LibraryAttachmentsView /></section> : category === "reports" ? <section className="attachments-library-shell"><FinancialAttachments standalone /></section> : (
        <section className={`attachments-drive-shell ${dragActive ? "is-dragging" : ""}`} onDragEnter={handleDragOver} onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>
          <div className="attachments-drive-header">
            <nav className="attachments-breadcrumb" aria-label="当前文件路径">
              <button type="button" onClick={() => setPath("")} className={!path ? "is-current" : ""}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4"><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5M9 21v-7h6v7" /></svg>全部文件</button>
              {crumbs.map((crumb) => <span key={crumb.rel}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3"><path d="m9 18 6-6-6-6" /></svg><button type="button" title={crumb.name} onClick={() => setPath(crumb.rel)} className={path === crumb.rel ? "is-current" : ""}>{crumb.name}</button></span>)}
            </nav>
            <div className="attachments-drive-header-actions">
              <div className="attachments-quick-actions" aria-label="当前目录操作">
                <button type="button" onClick={() => fileRef.current?.click()} className="is-primary" title="上传文件" aria-label="上传文件"><UploadIcon /></button>
                <button type="button" onClick={() => setMkDirOpen(true)} title="新建文件夹" aria-label="新建文件夹"><FolderPlusIcon /></button>
                <button type="button" onClick={() => refresh()} title="刷新文件列表" aria-label="刷新文件列表"><RefreshIcon /></button>
              </div>
              <label className="attachments-search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索当前目录" />{search && <button type="button" onClick={() => setSearch("")} aria-label="清除搜索"><CloseIcon className="h-3.5 w-3.5" /></button>}</label>
            </div>
          </div>

          <div className="attachments-commandbar">
            <div className="attachments-commandbar-secondary">
              <span className="attachments-result-count">{search ? `${resultCount} 项结果` : `${dirs.length + files.length} 项`}</span>
              <label className="attachments-sort-control"><span>排序</span><AppSelect value={sort} onChange={(value) => setSort(value as SortMode)} options={[{ value: "mtime", label: "最近修改" }, { value: "name", label: "名称" }, { value: "size", label: "文件大小" }]} ariaLabel="附件排序" /></label>
              <div className="attachments-view-switch" aria-label="视图模式">{(["list", "grid", "tree"] as ViewMode[]).map((mode) => <button key={mode} type="button" onClick={() => setViewMode(mode)} className={viewMode === mode ? "is-active" : ""} title={mode === "list" ? "列表" : mode === "grid" ? "网格" : "目录树"} aria-label={mode === "list" ? "列表视图" : mode === "grid" ? "网格视图" : "目录树视图"}><ViewIcon mode={mode} /></button>)}</div>
            </div>
          </div>

          {uploadTasks.length > 0 && <UploadQueue tasks={uploadTasks} retry={retryUpload} cancel={cancelUpload} clear={() => setUploadTasks((current) => current.filter((task) => task.status === "uploading" || task.status === "conflict" || task.status === "queued"))} />}

          <div className={`attachments-content-layout ${selected ? "has-details" : ""}`}>
            <main className="attachments-file-area">
              {loading ? <LoadingState /> : loadError ? <div className="attachments-load-error"><strong>文件列表加载失败</strong><span>{loadError}</span><button type="button" onClick={() => load(path)}>重新加载</button></div> : viewMode === "tree" ? <TreeView path={path} treeChildren={treeChildren} treeExpanded={treeExpanded} toggleTree={toggleTree} navigate={setPath} refresh={() => refresh(false)} refreshKey={treeVersion} onSelect={setSelected} /> : visibleDirs.length === 0 && visibleFiles.length === 0 ? (
                <div className="attachments-empty-state"><span><UploadIcon className="h-7 w-7" /></span><h3>{search ? "没有找到匹配内容" : "把文件拖到这里"}</h3><p>{search ? "请尝试其他关键词，或清除当前搜索。" : "支持批量上传，单个文件最大 50 MB。也可以先建立文件夹再归档。"}</p>{!search && <button type="button" onClick={() => fileRef.current?.click()}>选择文件</button>}</div>
              ) : viewMode === "grid" ? <GridView dirs={visibleDirs} files={visibleFiles} selected={selected} navigate={setPath} select={setSelected} requestDelete={(entry) => { setRecursiveDelete(false); setConfirmDel(entry); }} /> : <ListView dirs={visibleDirs} files={visibleFiles} selected={selected} navigate={setPath} select={setSelected} requestDelete={(entry) => { setRecursiveDelete(false); setConfirmDel(entry); }} />}
            </main>
            {selected && <><button type="button" className="attachment-details-backdrop" onClick={() => setSelected(null)} aria-label="关闭文件详情" /><DetailsPanel entry={selected} navigate={setPath} close={() => setSelected(null)} requestDelete={(entry) => { setRecursiveDelete(false); setConfirmDel(entry); }} preview={setPreview} operate={openOperation} copyPath={copyEntryPath} /></>}
          </div>
          {dragActive && <div className="attachments-drop-overlay" aria-hidden="true"><span><UploadIcon className="h-7 w-7" /></span><strong>释放以上传到「{path || "全部文件"}」</strong><small>支持多个文件，单个文件最大 50 MB</small></div>}
        </section>
      )}

      {mkDirOpen && <AttachmentModalShell onClose={() => setMkDirOpen(false)} labelledBy="attachment-new-folder-title"><span className="attachment-modal-icon"><FolderIcon className="h-5 w-5" /></span><h3 id="attachment-new-folder-title">新建文件夹</h3><p>将在「{path || "全部文件"}」中创建</p><input autoFocus value={newDirName} onChange={(event) => setNewDirName(event.target.value)} onKeyDown={(event) => event.key === "Enter" && createDir()} placeholder="输入文件夹名称" className={`${inputCls} mt-4 w-full`} /><div className="attachment-modal-actions"><button type="button" onClick={() => setMkDirOpen(false)}>取消</button><button type="button" onClick={createDir} disabled={busy || !newDirName.trim()} className="is-primary">创建</button></div></AttachmentModalShell>}

      {confirmDel && <AttachmentModalShell onClose={() => { setConfirmDel(null); setRecursiveDelete(false); }} labelledBy="attachment-delete-title" alert><span className="attachment-modal-icon is-danger"><TrashIcon className="h-5 w-5" /></span><h3 id="attachment-delete-title">删除“{confirmDel.name}”？</h3><p>{confirmDel.isDir ? "空文件夹可直接删除；如需同时删除其中全部内容，请明确勾选下方选项。" : "此操作无法撤销，请确认文件不再需要。"}</p>{confirmDel.isDir && <label className="attachment-danger-check"><input type="checkbox" checked={recursiveDelete} onChange={(event) => setRecursiveDelete(event.target.checked)} /><span>同时永久删除文件夹内的全部内容</span></label>}<div className="attachment-modal-actions"><button type="button" onClick={() => { setConfirmDel(null); setRecursiveDelete(false); }}>取消</button><button type="button" onClick={() => remove(confirmDel)} className="is-danger">删除</button></div></AttachmentModalShell>}

      {operation && <AttachmentModalShell onClose={() => setOperation(null)} labelledBy="attachment-operation-title"><span className="attachment-modal-icon"><FolderIcon className="h-5 w-5" /></span><h3 id="attachment-operation-title">{operation.mode === "rename" ? "重命名" : operation.mode === "move" ? "移动到" : "复制到"}</h3><p className="truncate" title={operation.entry.rel}>{operation.entry.rel}</p>{operation.mode === "rename" ? <label className="attachment-field"><span>新名称</span><input value={operationName} onChange={(event) => setOperationName(event.target.value)} onKeyDown={(event) => event.key === "Enter" && runOperation()} className={inputCls} /></label> : <label className="attachment-field"><span>目标文件夹</span><AppSelect value={targetDir} onChange={setTargetDir} className={inputCls} options={directories.map((directory) => ({ value: directory, label: directory || "全部文件" }))} ariaLabel="目标文件夹" /></label>}<label className="attachment-field"><span>遇到同名项目</span><AppSelect value={operationConflict} onChange={(value) => setOperationConflict(value as ConflictMode)} className={inputCls} options={[{ value: "keep-both", label: "保留两者（自动编号）" }, { value: "error", label: "停止并提示" }, { value: "replace", label: "替换已有项目" }]} ariaLabel="同名项目处理方式" /></label><div className="attachment-modal-actions"><button type="button" onClick={() => setOperation(null)}>取消</button><button type="button" className="is-primary" disabled={busy || (operation.mode === "rename" && !operationName.trim())} onClick={runOperation}>{busy ? "处理中…" : "确认"}</button></div></AttachmentModalShell>}

      {preview && <AttachmentModalShell onClose={() => setPreview(null)} labelledBy="attachment-preview-title" wide><div className="attachment-preview-head"><div><h3 id="attachment-preview-title">{preview.name}</h3><p>{fileType(preview.ext)} · {fmtSize(preview.size)}</p></div><button type="button" onClick={() => setPreview(null)} aria-label="关闭预览"><CloseIcon /></button></div><div className="attachment-preview-body">{["png", "jpg", "jpeg", "webp", "gif", "svg"].includes(preview.ext) ? <img src={`/api/attachments?action=preview&path=${encodeURIComponent(preview.rel)}`} alt={preview.name} /> : <iframe src={`/api/attachments?action=preview&path=${encodeURIComponent(preview.rel)}`} title={preview.name} sandbox={preview.ext === "pdf" ? undefined : "allow-same-origin"} />}</div><div className="attachment-modal-actions"><a className="attachment-modal-link" href={`/api/attachments?action=download&path=${encodeURIComponent(preview.rel)}`}><DownloadIcon />下载</a><button type="button" onClick={() => setPreview(null)}>关闭</button></div></AttachmentModalShell>}
    </div>
  );
}

function UploadQueue({ tasks, retry, cancel, clear }: { tasks: UploadTask[]; retry: (task: UploadTask, conflict?: ConflictMode) => void; cancel: (task: UploadTask) => void; clear: () => void }) {
  const active = tasks.some((task) => task.status === "uploading" || task.status === "queued" || task.status === "conflict");
  return <section className="attachment-upload-queue" aria-label="上传任务">
    <div className="attachment-upload-queue-head"><div><strong>上传任务</strong><span>{tasks.filter((task) => task.status === "done").length}/{tasks.length} 已完成</span></div><button type="button" onClick={clear} disabled={active && tasks.every((task) => ["uploading", "queued", "conflict"].includes(task.status))}>清理已结束</button></div>
    <div className="attachment-upload-items">{tasks.map((task) => <div key={task.id} className={`attachment-upload-item is-${task.status}`}><FileIcon ext={task.file.name.split(".").pop() ?? ""} className="h-4 w-4" /><div className="attachment-upload-info"><strong title={task.file.name}>{task.file.name}</strong><span>{task.error || (task.status === "done" ? "上传完成" : task.status === "uploading" ? `${task.progress}%` : task.status === "queued" ? "等待上传" : "")}</span><i><b style={{ width: `${task.progress}%` }} /></i></div><div className="attachment-upload-actions">{task.status === "uploading" && <button type="button" onClick={() => cancel(task)}>取消</button>}{task.status === "error" && <button type="button" onClick={() => retry(task)}>重试</button>}{task.status === "conflict" && <><button type="button" onClick={() => retry(task, "keep-both")}>保留两者</button><button type="button" onClick={() => retry(task, "replace")}>替换</button><button type="button" onClick={() => cancel(task)}>跳过</button></>}</div></div>)}</div>
  </section>;
}

function rowKeyboard(event: React.KeyboardEvent, entry: Entry, select: (entry: Entry) => void, navigate: (path: string) => void) {
  if (event.key === " ") { event.preventDefault(); select(entry); }
  if (event.key === "Enter") { event.preventDefault(); entry.isDir ? navigate(entry.rel) : select(entry); }
}

function ListView({ dirs, files, selected, navigate, select, requestDelete }: { dirs: Entry[]; files: Entry[]; selected: Entry | null; navigate: (path: string) => void; select: (entry: Entry) => void; requestDelete: (entry: Entry) => void }) {
  return <div className="attachment-list" role="table" aria-label="文件列表">
    <div className="attachment-list-head" role="row"><span role="columnheader">名称</span><span role="columnheader">类型</span><span role="columnheader">大小</span><span role="columnheader">修改时间</span><span role="columnheader">操作</span></div>
    {dirs.map((entry) => <div key={entry.rel} tabIndex={0} className={`attachment-list-row is-folder ${selected?.rel === entry.rel ? "is-selected" : ""}`} role="row" onClick={() => select(entry)} onDoubleClick={() => navigate(entry.rel)} onKeyDown={(event) => rowKeyboard(event, entry, select, navigate)}><button type="button" className="attachment-name-cell" onClick={(event) => { event.stopPropagation(); select(entry); }} title={entry.name}><span className="attachment-item-icon is-folder"><FolderIcon className="h-[19px] w-[19px]" /></span><span><strong>{entry.name}</strong><small>单击选择，双击打开</small></span></button><span className="attachment-type-cell">文件夹</span><span className="attachment-size-cell">—</span><span className="attachment-date-cell">{fmtTime(entry.mtime)}</span><span className="attachment-row-actions"><button type="button" onClick={(event) => { event.stopPropagation(); requestDelete(entry); }} title="删除文件夹"><TrashIcon className="h-4 w-4" /></button><button type="button" onClick={(event) => { event.stopPropagation(); navigate(entry.rel); }} title="打开文件夹"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4"><path d="m9 18 6-6-6-6" /></svg></button></span></div>)}
    {files.map((entry) => <div key={entry.rel} tabIndex={0} className={`attachment-list-row ${selected?.rel === entry.rel ? "is-selected" : ""}`} role="row" onClick={() => select(entry)} onKeyDown={(event) => rowKeyboard(event, entry, select, navigate)}><button type="button" className="attachment-name-cell" onClick={() => select(entry)} title={entry.name}><span className="attachment-item-icon"><FileIcon ext={entry.ext} className="h-[19px] w-[19px]" /></span><span><strong>{entry.name}</strong><small>{entry.ext ? entry.ext.toUpperCase() : "文件"}</small></span></button><span className="attachment-type-cell">{fileType(entry.ext)}</span><span className="attachment-size-cell">{fmtSize(entry.size)}</span><span className="attachment-date-cell">{fmtTime(entry.mtime)}</span><span className="attachment-row-actions"><a href={`/api/attachments?action=download&path=${encodeURIComponent(entry.rel)}`} onClick={(event) => event.stopPropagation()} title="下载"><DownloadIcon className="h-4 w-4" /></a><button type="button" onClick={(event) => { event.stopPropagation(); requestDelete(entry); }} title="删除"><TrashIcon className="h-4 w-4" /></button></span></div>)}
  </div>;
}

function GridView({ dirs, files, selected, navigate, select, requestDelete }: { dirs: Entry[]; files: Entry[]; selected: Entry | null; navigate: (path: string) => void; select: (entry: Entry) => void; requestDelete: (entry: Entry) => void }) {
  return <div className="attachment-grid">
    {dirs.map((entry) => <article key={entry.rel} tabIndex={0} className={`attachment-grid-card is-folder ${selected?.rel === entry.rel ? "is-selected" : ""}`} onClick={() => select(entry)} onDoubleClick={() => navigate(entry.rel)} onKeyDown={(event) => rowKeyboard(event, entry, select, navigate)}><button type="button" className="attachment-grid-preview" onClick={(event) => { event.stopPropagation(); select(entry); }}><FolderIcon className="h-12 w-12" /></button><div className="attachment-grid-meta"><strong title={entry.name}>{entry.name}</strong><small>文件夹 · {fmtTime(entry.mtime).slice(0, 10)}</small></div><span className="attachment-grid-actions"><button type="button" onClick={(event) => { event.stopPropagation(); navigate(entry.rel); }} title="打开文件夹"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4"><path d="m9 18 6-6-6-6" /></svg></button><button type="button" onClick={(event) => { event.stopPropagation(); requestDelete(entry); }} title="删除文件夹"><TrashIcon className="h-4 w-4" /></button></span></article>)}
    {files.map((entry) => <article key={entry.rel} tabIndex={0} className={`attachment-grid-card ${selected?.rel === entry.rel ? "is-selected" : ""}`} onClick={() => select(entry)} onKeyDown={(event) => rowKeyboard(event, entry, select, navigate)}><button type="button" className="attachment-grid-preview" onClick={() => select(entry)}><FileIcon ext={entry.ext} className="h-11 w-11" /><ExtBadge ext={entry.ext} /></button><div className="attachment-grid-meta"><strong title={entry.name}>{entry.name}</strong><small>{fmtSize(entry.size)} · {fmtTime(entry.mtime).slice(0, 10)}</small></div><span className="attachment-grid-actions"><a href={`/api/attachments?action=download&path=${encodeURIComponent(entry.rel)}`} onClick={(event) => event.stopPropagation()} title="下载"><DownloadIcon className="h-4 w-4" /></a><button type="button" onClick={(event) => { event.stopPropagation(); requestDelete(entry); }} title="删除"><TrashIcon className="h-4 w-4" /></button></span></article>)}
  </div>;
}

function DetailsPanel({ entry, navigate, close, requestDelete, preview, operate, copyPath }: { entry: Entry; navigate: (path: string) => void; close: () => void; requestDelete: (entry: Entry) => void; preview: (entry: Entry) => void; operate: (mode: FileOperation["mode"], entry: Entry) => void; copyPath: (entry: Entry) => void }) {
  const image = !entry.isDir && ["png", "jpg", "jpeg", "webp", "gif", "svg"].includes(entry.ext);
  return <aside className="attachment-details" aria-label="文件详情" role="dialog"><div className="attachment-details-head"><strong>详细信息</strong><button type="button" onClick={close} aria-label="关闭详情"><CloseIcon /></button></div><div className={`attachment-details-visual ${entry.isDir ? "is-folder" : ""}`}>{image ? <img src={`/api/attachments?action=preview&path=${encodeURIComponent(entry.rel)}`} alt="" /> : entry.isDir ? <FolderIcon className="h-12 w-12" /> : <FileIcon ext={entry.ext} className="h-12 w-12" />}</div><h3 title={entry.name}>{entry.name}</h3><span className="attachment-details-kind">{entry.isDir ? "文件夹" : fileType(entry.ext)}</span><dl><div><dt>位置</dt><dd title={entry.rel}>{entry.rel.includes("/") ? entry.rel.slice(0, entry.rel.lastIndexOf("/")) : "全部文件"}</dd></div><div><dt>修改时间</dt><dd>{fmtTime(entry.mtime)}</dd></div><div><dt>大小</dt><dd>{entry.isDir ? "—" : fmtSize(entry.size)}</dd></div><div><dt>相对路径</dt><dd className="attachment-copy-path"><span title={entry.rel}>{entry.rel}</span><button type="button" onClick={() => copyPath(entry)} title="复制路径">复制</button></dd></div></dl><div className="attachment-details-actions">{entry.isDir ? <button type="button" className="is-primary" onClick={() => navigate(entry.rel)}>打开</button> : <a className="is-primary" href={`/api/attachments?action=download&path=${encodeURIComponent(entry.rel)}`}><DownloadIcon className="h-4 w-4" />下载</a>}{isPreviewable(entry) && <button type="button" onClick={() => preview(entry)}>预览</button>}<button type="button" onClick={() => operate("rename", entry)}>重命名</button><button type="button" onClick={() => operate("move", entry)}>移动</button><button type="button" onClick={() => operate("copy", entry)}>复制</button><button type="button" onClick={() => requestDelete(entry)}><TrashIcon className="h-4 w-4" />删除</button></div></aside>;
}

function TreeView({ path, treeChildren, treeExpanded, toggleTree, navigate, refresh, refreshKey, onSelect }: { path: string; treeChildren: Record<string, ListData>; treeExpanded: Set<string>; toggleTree: (dir: string) => void; navigate: (path: string) => void; refresh: () => void; refreshKey: number; onSelect: (entry: Entry) => void }) {
  const [root, setRoot] = useState<ListData | null>(null);
  const [error, setError] = useState("");
  const [retryKey, setRetryKey] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setError("");
    fetch("/api/attachments?path=").then(async (response) => { const data = await response.json().catch(() => null); if (!response.ok || !data) throw new Error(data?.error || "目录树加载失败"); if (!cancelled) setRoot(data); }).catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "目录树加载失败"); });
    return () => { cancelled = true; };
  }, [retryKey, refreshKey]);
  if (error && !root) return <div className="attachments-tree-error"><p>{error}</p><button type="button" onClick={() => setRetryKey((key) => key + 1)}>重新加载</button></div>;
  if (!root) return <LoadingState />;
  function renderDir(dir: Entry, depth: number): ReactNode {
    const children = treeChildren[dir.rel];
    const expanded = treeExpanded.has(dir.rel);
    return <div key={dir.rel}><div className={`attachment-tree-row ${path === dir.rel ? "is-current" : ""}`} style={{ paddingLeft: 14 + depth * 18 }}><button type="button" onClick={() => toggleTree(dir.rel)} className={`attachment-tree-chevron ${expanded ? "is-expanded" : ""}`} aria-label={expanded ? "收起文件夹" : "展开文件夹"}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m9 18 6-6-6-6" /></svg></button><FolderIcon className="h-4 w-4" /><button type="button" onClick={() => navigate(dir.rel)} onDoubleClick={() => toggleTree(dir.rel)} title={dir.name}>{dir.name}</button></div>{expanded && children && <div>{children.dirs.map((child) => renderDir(child, depth + 1))}{children.files.map((file) => <button type="button" key={file.rel} className="attachment-tree-file" style={{ paddingLeft: 50 + depth * 18 }} onClick={() => onSelect(file)}><FileIcon ext={file.ext} className="h-4 w-4" /><span title={file.name}>{file.name}</span><small>{fmtSize(file.size)}</small></button>)}</div>}</div>;
  }
  return <div className="attachments-tree"><div className="attachments-tree-heading"><span>全部文件</span><button type="button" onClick={refresh} title="刷新目录树"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></svg></button></div>{root.dirs.length === 0 && root.files.length === 0 ? <p className="attachments-tree-empty">还没有任何目录</p> : <>{root.dirs.map((dir) => renderDir(dir, 0))}{root.files.map((file) => <button type="button" key={file.rel} className="attachment-tree-file" onClick={() => onSelect(file)}><FileIcon ext={file.ext} className="h-4 w-4" /><span title={file.name}>{file.name}</span><small>{fmtSize(file.size)}</small></button>)}</>}</div>;
}
