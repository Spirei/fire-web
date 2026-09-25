"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import Link from "next/link";
import { useRouter } from "next/navigation";
import ModelImporter, { type ImportedModelRow, type ImportReport } from "./ModelImporter";
import { modelAccent } from "./modelAccent";
import { usePersistedState } from "@/lib/usePersistedState";
import { showToast } from "@/lib/toast";

const CHAPTERS = [
  { label: "封面", en: "COVER", era: "车型档案" },
  { label: "原件", en: "THE ORIGINAL", era: "发布前" },
  { label: "体检", en: "INSPECTION", era: "发布前" },
  { label: "调校", en: "THE WORKBENCH", era: "发布中" },
  { label: "附件", en: "THE EDITION", era: "发布中" },
  { label: "验收", en: "THE PROOF", era: "发布前" },
  { label: "维护", en: "AFTER RELEASE", era: "发布后" }
] as const;

const BOOK_HEIGHTS = [380, 475, 338, 393, 455, 530, 474, 405];

function bookHeight(model: ImportedModelRow) {
  const identity = `${model.id} ${model.label}`.toLowerCase();
  if (identity.includes("gulf")) return 380;
  if (identity.includes("mcl35")) return 475;
  if (identity.includes("mp4/6") || identity.includes("mp46")) return 338;
  if (identity.includes("mp4/5") || identity.includes("mp45")) return 393;
  if (identity.includes("mcl39")) return 455;
  if (identity.includes("amr26")) return 530;
  if (identity.includes("amr23")) return 474;
  const hash = [...model.id].reduce((value, character) => value * 31 + character.charCodeAt(0), 0) >>> 0;
  return BOOK_HEIGHTS[hash % BOOK_HEIGHTS.length];
}

function bookWidth(bytes?: number) {
  if (!bytes || bytes <= 0) return 56;
  const megabytes = bytes / 1048576;
  return Math.round(Math.max(46, Math.min(84, 48 + 12 * Math.log2(megabytes / 20))));
}

function bookTheme(model?: ImportedModelRow) {
  if (!model) return { cover: "#e8e4d6", ink: "#202328", edge: "#b5ae93", pattern: "lines" };
  const identity = `${model.id} ${model.label} ${model.file}`.toLowerCase();
  const accent = modelAccent(encodeURIComponent(model.file));
  if (identity.includes("gulf")) return { cover: "#76b6c9", ink: "#173746", edge: "#467d91", pattern: "gulf" };
  if (identity.includes("amr") || identity.includes("aston")) return { cover: "#14564e", ink: "#e8e2cd", edge: "#0c3935", pattern: "racing" };
  if (identity.includes("mp45") || identity.includes("mp4/5")) return { cover: "#db3e32", ink: "#fff2df", edge: "#9b302b", pattern: "chevron" };
  if (identity.includes("mp46") || identity.includes("mp4/6")) return { cover: "#f3ecda", ink: "#2c2b27", edge: "#c5b9a5", pattern: "redband" };
  if (identity.includes("mcl39")) return { cover: "#f18a27", ink: "#242d31", edge: "#ba5919", pattern: "papaya" };
  if (identity.includes("mcl35")) return { cover: "#e87723", ink: "#253642", edge: "#a84e1c", pattern: "arcs" };
  return { cover: accent, ink: "#fff2df", edge: "#985126", pattern: "lines" };
}

type Turn = "next" | "previous" | null;
type Stage = "upload" | "inspect" | "tune" | "assets" | "maintain" | "none";

function stageForPage(page: number): Stage {
  return ({ 1: "upload", 2: "inspect", 3: "tune", 4: "assets", 6: "maintain" } as Record<number, Stage>)[page] ?? "none";
}

function shortDate(value: string) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(date);
}

function fileSize(bytes: number) { return `${(bytes / 1048576).toFixed(1)} MB`; }

/** 翻页只复制可见 DOM；交互组件仍只有底层那一份，不会重复提交或加载。 */
function clonePageVisual(source: Element | null): HTMLElement | null {
  if (!(source instanceof HTMLElement)) return null;
  const copyVisible = (node: Node): Node | null => {
    // 工作台中未激活的步骤可能带有整套 3D 控件，不能每翻一页都复制。
    if (node instanceof HTMLElement && node.hidden) return null;
    const copy = node.cloneNode(false);
    if (copy instanceof Element) copy.removeAttribute("id");
    for (const child of node.childNodes) {
      const clonedChild = copyVisible(child);
      if (clonedChild) copy.appendChild(clonedChild);
    }
    if (node instanceof HTMLElement && copy instanceof HTMLElement) {
      if (node.scrollTop) copy.scrollTop = node.scrollTop;
      if (node.scrollLeft) copy.scrollLeft = node.scrollLeft;
      if (node instanceof HTMLInputElement && copy instanceof HTMLInputElement) {
        copy.value = node.value;
        copy.checked = node.checked;
      } else if (node instanceof HTMLTextAreaElement && copy instanceof HTMLTextAreaElement) copy.value = node.value;
      else if (node instanceof HTMLSelectElement && copy instanceof HTMLSelectElement) copy.value = node.value;
      // 大幅 WebGL 画布的 GPU 回读会卡住主线程；动画纸面保留容器即可。
      if (node instanceof HTMLCanvasElement && copy instanceof HTMLCanvasElement && node.width * node.height <= 262144) {
        try { copy.getContext("2d")?.drawImage(node, 0, 0); } catch { /* 无法读取的画布保持纸面底色。 */ }
      }
    }
    return copy;
  };
  return copyVisible(source) as HTMLElement;
}

function ReadonlyInspection({ model }: { model: ImportedModelRow }) {
  const [report, setReport] = useState<ImportReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { setReport(null); setError(""); }, [model.id]);
  async function inspect() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/showcase/models/inspect?id=${encodeURIComponent(model.id)}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "体检失败");
      setReport(data.report);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "体检失败"); }
    finally { setBusy(false); }
  }
  return <div className="mbl-inspection">
    <div className="mbl-inspection-intro"><span>ORIGINAL FILE</span><strong>{model.file}</strong><small>读取现有原件，不修改文件。</small></div>
    <button type="button" className="mbl-paper-button" onClick={() => void inspect()} disabled={busy || model.present === false}>{busy ? "正在检查…" : report ? "重新体检 ↗" : "检查原件 ↗"}</button>
    {model.present === false && <p className="mbl-alert">原件缺失。请先恢复 uploads 卷里的模型文件。</p>}
    {error && <p className="mbl-alert" role="alert">{error}</p>}
    {report && <div className="mbl-inspection-result" aria-live="polite">
      <p className={report.ok ? "mbl-result-ok" : "mbl-result-bad"}>{report.ok ? "结构通过" : "需要处理"}<span>{fileSize(report.bytes)}</span></p>
      <div className="mbl-metrics"><span>网格<b>{report.info.meshes.length}</b></span><span>材质<b>{report.info.materials.length}</b></span><span>贴图<b>{report.info.images.length}</b></span><span>三角面<b>{report.info.totalTriangles.toLocaleString()}</b></span></div>
      {[...report.errors, ...report.warnings].map((line, index) => <p className="mbl-report-line" key={`${index}-${line}`}>{line}</p>)}
      <details><summary>查看材质与贴图</summary><div className="mbl-report-details">{report.info.materials.map((material, index) => <span key={`${material.name}-${index}`}>{material.name || `材质 ${index + 1}`}</span>)}</div></details>
    </div>}
  </div>;
}

export default function ModelBookLibrary({ existing, initialBookId = "", initialPage = 0 }: { existing: ImportedModelRow[]; initialBookId?: string; initialPage?: number }) {
  const router = useRouter();
  const [bookId, setBookId] = useState(initialBookId);
  const [page, setPage] = useState(initialPage);
  const [turn, setTurn] = useState<Turn>(null);
  const [turnFromPage, setTurnFromPage] = useState<number | null>(null);
  const [shelfDragging, setShelfDragging] = useState(false);
  const [orderedIds, setOrderedIds] = useState(() => existing.map((item) => item.id));
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; after: boolean } | null>(null);
  const [orderSaving, setOrderSaving] = useState(false);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [hoverX, setHoverX] = useState(0);
  const [coverBusy, setCoverBusy] = useState(false);
  const [bookDragging, setBookDragging] = useState(false);
  const [unsavedDraft, setUnsavedDraft] = useState(false);
  const [method, setMethod] = usePersistedState<"local" | "online">("fire:showcase:processing-method", "local");
  const [qa, setQa] = usePersistedState<Record<string, boolean[]>>("fire:showcase:qa-checks", {});
  const timers = useRef<number[]>([]);
  const turnRef = useRef(false);
  const bookRef = useRef<HTMLDivElement | null>(null);
  const flipOverlayRef = useRef<HTMLDivElement | null>(null);
  const touchX = useRef<number | null>(null);
  const shelfDrag = useRef<{ x: number; left: number; moved: boolean } | null>(null);
  const shelfDragUntil = useRef(0);
  const orderSavingRef = useRef(false);
  const coverInputRef = useRef<HTMLInputElement | null>(null);
  const shelfScrollRef = useRef<HTMLDivElement | null>(null);
  const mouseTurnStart = useRef<{ x: number; y: number } | null>(null);
  const book = existing.find((item) => item.id === bookId);
  const isNew = bookId === "new";
  const selected = Boolean(book || isNew);
  const effectiveMethod = book?.builtin ? "local" : method;
  const palette = bookTheme(book);
  const label = book?.label ?? "未命名车型";
  const orderedBooks = orderedIds.map((id) => existing.find((item) => item.id === id)).filter((item): item is ImportedModelRow => Boolean(item));
  const hoveredBook = existing.find((item) => item.id === hoverId);

  useEffect(() => { if (!orderSavingRef.current) setOrderedIds(existing.map((item) => item.id)); }, [existing]);
  useEffect(() => () => { timers.current.forEach(window.clearTimeout); }, []);

  const saveOrder = useCallback(async (ids: string[]) => {
    if (orderSavingRef.current || ids.join("|") === orderedIds.join("|")) return;
    const previous = orderedIds;
    orderSavingRef.current = true;
    setOrderSaving(true);
    setOrderedIds(ids);
    try {
      const response = await fetch("/api/showcase/models/order", {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "排序保存失败");
      showToast("顺序已保存，首页车型条同步");
      router.refresh();
    } catch (cause) {
      setOrderedIds(previous);
      showToast(cause instanceof Error ? cause.message : "排序保存失败", "err");
    } finally {
      orderSavingRef.current = false;
      setOrderSaving(false);
    }
  }, [orderedIds, router]);

  const moveBook = useCallback((sourceId: string, targetId: string, after: boolean) => {
    if (sourceId === targetId || orderSavingRef.current) return;
    const next = orderedIds.filter((id) => id !== sourceId);
    const at = next.indexOf(targetId);
    next.splice(at < 0 ? next.length : at + Number(after), 0, sourceId);
    void saveOrder(next);
  }, [orderedIds, saveOrder]);

  const uploadBookCover = useCallback(async (file: File) => {
    if (!book) return;
    setCoverBusy(true);
    try {
      const response = await fetch(`/api/showcase/models/cover?id=${encodeURIComponent(book.id)}&name=${encodeURIComponent(file.name)}`, {
        method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "封面上传失败");
      showToast("封面已更新");
      router.refresh();
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : "封面上传失败", "err");
    } finally { setCoverBusy(false); }
  }, [book, router]);

  const syncUrl = useCallback((id: string, nextPage: number) => {
    const url = new URL(window.location.href);
    if (id) { url.searchParams.set("book", id); url.searchParams.set("page", String(nextPage)); }
    else { url.searchParams.delete("book"); url.searchParams.delete("page"); }
    window.history.pushState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);
  const clearFlipVisual = useCallback(() => {
    timers.current.forEach(window.clearTimeout);
    timers.current = [];
    flipOverlayRef.current?.replaceChildren();
    turnRef.current = false;
    setTurn(null);
    setTurnFromPage(null);
  }, []);
  const goTo = useCallback((id: string, nextPage: number) => {
    clearFlipVisual();
    setBookId(id);
    setPage(nextPage);
    syncUrl(id, nextPage);
  }, [clearFlipVisual, syncUrl]);
  const confirmDiscard = useCallback(() => window.confirm("原件尚未保存，离开画册后需要重新上传。确定离开吗？"), []);
  const leaveTo = useCallback((id: string, nextPage: number) => {
    const discarding = bookId === "new" && unsavedDraft && (id !== "new" || nextPage === 0);
    if (discarding && !confirmDiscard()) return;
    if (discarding) setUnsavedDraft(false);
    goTo(id, nextPage);
  }, [bookId, confirmDiscard, goTo, unsavedDraft]);
  const flip = useCallback((direction: "next" | "previous") => {
    if (turnRef.current || !selected) return;
    const next = Math.min(CHAPTERS.length - 1, Math.max(0, page + (direction === "next" ? 1 : -1)));
    if (next === page) return;
    if (isNew && unsavedDraft && next === 0) {
      if (!confirmDiscard()) return;
      setUnsavedDraft(false);
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce), (max-width: 620px)").matches) { goTo(bookId, next); return; }
    const bookElement = bookRef.current;
    const overlay = flipOverlayRef.current;
    if (!bookElement || !overlay) { goTo(bookId, next); return; }
    const opening = page === 0;
    const closing = next === 0;
    const mode = opening ? "opening" : closing ? "closing" : "spread";
    const front = clonePageVisual(bookElement.querySelector(opening ? ".mbl-cover" : direction === "next" ? ".mbl-page-right" : ".mbl-page-left"));
    const stationary = opening ? null : clonePageVisual(bookElement.querySelector(direction === "next" ? ".mbl-page-left" : ".mbl-page-right"));
    if (!front) { goTo(bookId, next); return; }
    turnRef.current = true;
    flushSync(() => { setTurn(direction); setTurnFromPage(page); setPage(next); });
    syncUrl(bookId, next);
    // 合上封面时底层已经是真正的整张封面，不能再把它复制到半张纸的背面。
    const back = closing ? null : clonePageVisual(bookElement.querySelector(direction === "next" ? ".mbl-page-left" : ".mbl-page-right"));
    if (!closing && !back) { goTo(bookId, next); return; }
    const scene = document.createElement("div");
    scene.className = `mbl-flip-scene is-${mode} is-${direction}`;
    if (stationary) {
      const still = document.createElement("div");
      still.className = "mbl-flip-stationary";
      still.append(stationary);
      scene.append(still);
    }
    const sheet = document.createElement("div");
    sheet.className = "mbl-flip-sheet";
    const frontFace = document.createElement("div");
    frontFace.className = "mbl-flip-face mbl-flip-front";
    frontFace.append(front);
    const backFace = document.createElement("div");
    backFace.className = "mbl-flip-face mbl-flip-back";
    if (back) backFace.append(back);
    sheet.append(frontFace, backFace);
    const pivot = document.createElement("div");
    pivot.className = "mbl-flip-pivot";
    pivot.append(sheet);
    scene.append(pivot);
    overlay.replaceChildren(scene);
    const finishTurn = (event: AnimationEvent) => {
      if (event.target !== sheet) return;
      sheet.removeEventListener("animationend", finishTurn);
      clearFlipVisual();
    };
    sheet.addEventListener("animationend", finishTurn);
    timers.current.push(window.setTimeout(clearFlipVisual, 1200));
  }, [bookId, clearFlipVisual, confirmDiscard, goTo, isNew, page, selected, syncUrl, unsavedDraft]);
  useEffect(() => {
    const pop = () => {
      const query = new URLSearchParams(window.location.search);
      const id = query.get("book") ?? "";
      const nextPage = Math.min(6, Math.max(0, Number(query.get("page")) || 0));
      if (bookId === "new" && unsavedDraft && (id !== "new" || nextPage === 0)) {
        if (!confirmDiscard()) { syncUrl(bookId, page); return; }
        setUnsavedDraft(false);
      }
      setBookId(id === "new" || existing.some((item) => item.id === id) ? id : "");
      setPage(nextPage);
      clearFlipVisual();
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, [bookId, clearFlipVisual, confirmDiscard, existing, page, syncUrl, unsavedDraft]);
  useEffect(() => {
    if (bookId !== "new" || !unsavedDraft) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [bookId, unsavedDraft]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!selected || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLElement && event.target.isContentEditable) return;
      if (event.key === "Escape") leaveTo("", 0);
      if (event.key === "ArrowRight") flip("next");
      if (event.key === "ArrowLeft") flip("previous");
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [flip, leaveTo, selected]);
  useEffect(() => { window.scrollTo(0, 0); }, [bookId, page]);

  const handleSaved = useCallback((id: string) => { setUnsavedDraft(false); goTo(id, page === 6 ? 6 : 4); router.refresh(); }, [goTo, page, router]);
  const importerStage = isNew ? stageForPage(page) : page === 3 || page === 4 || page === 6 ? stageForPage(page) : "none";
  const qaChecks = qa[bookId] ?? [];
  const toggleQa = (index: number) => setQa((previous) => {
    const next = [...(previous[bookId] ?? [])];
    next[index] = !next[index];
    return { ...previous, [bookId]: next };
  });

  return <main className="mbl" style={{ "--book-color": palette.cover, "--book-ink": palette.ink } as React.CSSProperties}>
    <header className="mbl-header">
      <Link href="/" className="mbl-brand" aria-label="返回 Fire 首页" onClick={(event) => { if (bookId === "new" && unsavedDraft && !confirmDiscard()) event.preventDefault(); }}>F<span>IRE</span><i> / </i>MODEL LIBRARY</Link>
      <div className="mbl-header-right"><span>{String(existing.length).padStart(2, "0")} VOLUMES</span><Link href="/showcase/import" onClick={(event) => { if (bookId === "new" && unsavedDraft && !confirmDiscard()) event.preventDefault(); }}>管理台 ↗</Link></div>
    </header>

    {!selected ? <section className="mbl-library" aria-labelledby="library-title">
      <div className="mbl-library-title"><p>THE ARCHIVE · FIRE SHOWCASE</p><h1 id="library-title">车型画册<span>.</span></h1><span>每台车，都是一段从原件到发布的故事。</span></div>
      <div
        ref={shelfScrollRef}
        className={`mbl-shelf-scroll${shelfDragging ? " is-dragging" : ""}`}
        aria-label="横向滚动书架"
        aria-busy={orderSaving}
        tabIndex={0}
        onPointerDown={(event) => {
          if (event.pointerType !== "mouse" || event.button !== 0 || event.currentTarget.scrollWidth <= event.currentTarget.clientWidth || (event.target instanceof Element && event.target.closest(".mbl-spine"))) return;
          shelfDrag.current = { x: event.clientX, left: event.currentTarget.scrollLeft, moved: false };
        }}
        onPointerMove={(event) => {
          const drag = shelfDrag.current;
          if (!drag) return;
          const distance = event.clientX - drag.x;
          if (Math.abs(distance) > 5) { drag.moved = true; setShelfDragging(true); }
          if (drag.moved) { event.preventDefault(); event.currentTarget.scrollLeft = drag.left - distance; }
        }}
        onPointerUp={() => {
          if (shelfDrag.current?.moved) shelfDragUntil.current = Date.now() + 180;
          shelfDrag.current = null;
          setShelfDragging(false);
        }}
        onPointerLeave={() => {
          if (shelfDrag.current?.moved) shelfDragUntil.current = Date.now() + 180;
          shelfDrag.current = null;
          setShelfDragging(false);
        }}
        onPointerCancel={() => { shelfDrag.current = null; setShelfDragging(false); }}
        onClickCapture={(event) => {
          if (Date.now() < shelfDragUntil.current) { event.preventDefault(); event.stopPropagation(); }
        }}
      ><div className="mbl-shelf" aria-label="车型书架">
        {orderedBooks.map((model, index) => { const color = bookTheme(model); return <button key={model.id} type="button" draggable={!orderSaving} data-pattern={color.pattern} className={`mbl-spine${dragId === model.id ? " is-dragged" : ""}${dropTarget?.id === model.id ? ` is-drop-${dropTarget.after ? "after" : "before"}` : ""}`} onClick={() => { if (Date.now() >= shelfDragUntil.current) goTo(model.id, 0); }} onKeyDown={(event) => {
          if (!event.altKey || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
          event.preventDefault();
          const nextIndex = index + (event.key === "ArrowRight" ? 1 : -1);
          const target = orderedBooks[nextIndex];
          if (target) moveBook(model.id, target.id, nextIndex > index);
        }} onPointerEnter={(event) => {
          if (event.pointerType !== "mouse" || dragId) return;
          const shelf = shelfScrollRef.current?.getBoundingClientRect();
          const rect = event.currentTarget.getBoundingClientRect();
          setHoverX(Math.max(75, Math.min((shelf?.width ?? rect.width) - 75, rect.left + rect.width / 2 - (shelf?.left ?? 0))));
          setHoverId(model.id);
        }} onPointerLeave={() => setHoverId((current) => current === model.id ? null : current)} onFocus={(event) => {
          const shelf = shelfScrollRef.current?.getBoundingClientRect();
          const rect = event.currentTarget.getBoundingClientRect();
          setHoverX(Math.max(75, Math.min((shelf?.width ?? rect.width) - 75, rect.left + rect.width / 2 - (shelf?.left ?? 0))));
          setHoverId(model.id);
        }} onBlur={() => setHoverId((current) => current === model.id ? null : current)} onDragStart={(event) => {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", model.id);
          shelfDrag.current = null;
          setShelfDragging(false);
          setHoverId(null);
          setDragId(model.id);
        }} onDragOver={(event) => {
          if (!dragId || dragId === model.id) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          const rect = event.currentTarget.getBoundingClientRect();
          const after = event.clientX > rect.left + rect.width / 2;
          setDropTarget((current) => current?.id === model.id && current.after === after ? current : { id: model.id, after });
        }} onDrop={(event) => {
          event.preventDefault();
          const source = dragId ?? event.dataTransfer.getData("text/plain");
          if (source) moveBook(source, model.id, event.clientX > event.currentTarget.getBoundingClientRect().left + event.currentTarget.getBoundingClientRect().width / 2);
          shelfDragUntil.current = Date.now() + 250;
          setDragId(null); setDropTarget(null);
        }} onDragEnd={() => { shelfDragUntil.current = Date.now() + 250; setDragId(null); setDropTarget(null); }} style={{ "--spine-bg": color.cover, "--spine-ink": color.ink, "--spine-edge": color.edge, "--spine-scale": bookHeight(model) / 530, "--spine-width": `${bookWidth(model.sourceBytes)}px` } as React.CSSProperties} aria-label={`打开 ${model.label} 车型画册，拖动可排序`} title={model.sourceBytes ? `原件 ${fileSize(model.sourceBytes)}` : "原件大小未知"}>
          <span className="mbl-spine-rule" aria-hidden="true" /><span className={`mbl-spine-title${model.label.length > 16 ? " is-long" : ""}`}>{model.label}</span><span className="mbl-spine-number">{String(index + 1).padStart(2, "0")}</span><span className="mbl-spine-grip" aria-hidden="true">⠿</span>
        </button>; })}
        <button type="button" className="mbl-spine mbl-spine-new" onClick={() => goTo("new", 0)} onDragOver={(event) => { if (dragId) event.preventDefault(); }} onDrop={(event) => { event.preventDefault(); if (dragId) moveBook(dragId, orderedIds.at(-1) ?? dragId, true); setDragId(null); setDropTarget(null); }} aria-label="新建车型画册"><span>＋</span><small>NEW<br />VOLUME</small></button>
      </div></div>
      <div className="mbl-shelf-preview" aria-live="polite">{hoveredBook && !dragId && <div className="mbl-preview-stack" style={{ left: `${hoverX}px`, "--preview-color": bookTheme(hoveredBook).cover, "--preview-ink": bookTheme(hoveredBook).ink } as React.CSSProperties}><div className="mbl-preview-cover">{hoveredBook.cover ? <img src={hoveredBook.cover} alt={`${hoveredBook.label} 封面预览`} /> : <strong>{hoveredBook.label}</strong>}</div><small>{hoveredBook.label} <span>· {hoveredBook.note || "车型档案"}</span></small></div>}</div>
      <div className="mbl-shelf-caption" aria-live="polite"><span>{String(orderedBooks.length).padStart(2, "0")} VOLUMES / ONE SHELF</span><span>{orderSaving ? "正在保存顺序…" : "拖动排序 · 点击阅读"}</span></div>
    </section> : <section className="mbl-reader" aria-label={`${label} 车型画册`} onTouchStart={(event) => { touchX.current = event.touches[0]?.clientX ?? null; }} onTouchEnd={(event) => { if (touchX.current === null) return; const delta = (event.changedTouches[0]?.clientX ?? touchX.current) - touchX.current; touchX.current = null; if (Math.abs(delta) > 90) flip(delta < 0 ? "next" : "previous"); }}>
      <div className="mbl-reader-top"><button type="button" onClick={() => leaveTo("", 0)}>← 返回书架</button><span>FIRE / {label.toUpperCase()}</span><span>{String((turnFromPage ?? page) + 1).padStart(2, "0")} / {String(CHAPTERS.length).padStart(2, "0")}</span></div>
      <div ref={bookRef} className={`mbl-book${page === 0 ? " is-cover" : ""}${turn ? ` is-turning-${turn}` : ""}${bookDragging ? " is-dragging" : ""}`} onPointerDown={(event) => {
        if (event.pointerType !== "mouse" || event.button !== 0 || turn || (event.target instanceof Element && event.target.closest("button, a, input, textarea, select, [contenteditable], .mbl-page-content"))) return;
        if (page === 0 && event.target instanceof Element && !event.target.closest(".mbl-cover")) return;
        mouseTurnStart.current = { x: event.clientX, y: event.clientY };
        event.currentTarget.setPointerCapture(event.pointerId);
      }} onPointerMove={(event) => {
        if (!mouseTurnStart.current) return;
        if (Math.abs(event.clientX - mouseTurnStart.current.x) > 8) setBookDragging(true);
      }} onPointerUp={(event) => {
        const start = mouseTurnStart.current;
        mouseTurnStart.current = null;
        setBookDragging(false);
        if (!start) return;
        const dx = event.clientX - start.x;
        const dy = event.clientY - start.y;
        if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.4) flip(dx < 0 ? "next" : "previous");
      }} onPointerCancel={() => { mouseTurnStart.current = null; setBookDragging(false); }}>
        {page === 0 ? <div className="mbl-cover" data-pattern={palette.pattern} style={{ "--cover-edge": palette.edge } as React.CSSProperties}>
          <div className={`mbl-cover-art${book?.cover ? " has-image" : ""}`}>{book?.cover ? <>
            <div className="mbl-cover-heading"><span>FIRE · MOTOR ARCHIVE</span><strong>{label}</strong><i>{book.note || "A MODEL MONOGRAPH"}</i></div>
            <div className="mbl-cover-image"><img src={book.cover} alt={`${label} 封面`} /></div>
          </> : <div className="mbl-cover-typography"><span>FIRE · MOTOR ARCHIVE</span><strong>{label}</strong><i>{book?.note || "THE NEW EDITION"}</i></div>}</div>
          <div className="mbl-cover-footer"><span>THE COMPLETE MODEL STORY</span><span>VOL. {String(book ? existing.indexOf(book) + 1 : existing.length + 1).padStart(2, "0")}</span></div>
        </div> : <div className="mbl-spread">
          <div className="mbl-page mbl-page-left">
            <div className="mbl-page-kicker"><span>FIRE MODEL ARCHIVE</span><span>{CHAPTERS[page].era}</span></div>
            <div className="mbl-chapter"><span className="mbl-chapter-index">{String(page).padStart(2, "0")} / {String(CHAPTERS.length - 1).padStart(2, "0")}</span><p>{CHAPTERS[page].en}</p><h2>{CHAPTERS[page].label}<i>.</i></h2><div className="mbl-chapter-rule" /></div>
            <div className="mbl-chapter-copy">
              {page === 1 && <><p>一切从原件开始。</p><span>上传自包含的 GLB，原始文件会完整保留。模型名称、贴图与结构都从这里进入档案。</span></>}
              {page === 2 && <><p>先看清，再继续。</p><span>体检读取网格、材质与贴图信息。红色问题需要处理；提醒并不自动等于发布失败。</span></>}
              {page === 3 && <><p>让车回到正确的姿态。</p><span>在独立 3D 工作台里调方向、比例、轮子和漆面。保存后，它才进入正式车型清单。</span></>}
              {page === 4 && <><p>同一原件，两种去处。</p><span>轻量预览负责首页，高清副本服务移动端原画。可用本机工具手动交稿，也可交给群晖处理。</span></>}
              {page === 5 && <><p>发布不是点一下按钮。</p><span>逐档检查 1K、2K、4K、原画和失败重试。只有真实画面加载成功，才算验收完成。</span></>}
              {page === 6 && <><p>故事还可以继续修改。</p><span>更新封面、调整参数、从首页隐藏，或在确认后移出清单。原件和附件的生命周期在这里收尾。</span></>}
            </div>
            <div className="mbl-page-foot"><span>{label}</span><span>{String(page * 2).padStart(2, "0")}</span></div>
          </div>
          <div className="mbl-page mbl-page-right">
            <div className="mbl-page-kicker"><span>MODEL / {bookId.toUpperCase()}</span><div className="mbl-page-kicker-actions"><span>{shortDate(book?.updatedAt ?? "")}</span>{book && <button type="button" className="mbl-cover-action" title={book.cover ? "更换车型封面" : "设置车型封面"} aria-label={book.cover ? "更换车型封面" : "设置车型封面"} disabled={coverBusy} onClick={() => coverInputRef.current?.click()}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="15" rx="2"/><circle cx="8.5" cy="10" r="1.5"/><path d="m4 17 5-4 3 2 4-5 4 5"/></svg></button>}</div></div>
            <input ref={coverInputRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void uploadBookCover(file); }} />
            <div className="mbl-page-content">
              {page === 1 && book && <div className="mbl-existing-source"><span>FILE ON RECORD</span><h3>{book.label}</h3><p>{book.file}</p><div className="mbl-source-status">{book.present === false ? "● 原件缺失" : "● 原件已入库"}</div><small>已保存车型的原件不会在此页被覆盖。需要调参请翻到「调校」。</small></div>}
              {page === 2 && book && <ReadonlyInspection model={book} />}
              {page === 3 && book?.builtin && <div className="mbl-locked"><span>↗</span><h3>内置车型不在此调参</h3><p>这辆车随仓库分发，参数由源码维护。需要独立涂装或版本时，请建立新车型。</p><button type="button" onClick={() => goTo("new", 0)}>新建车型画册</button></div>}
              {page === 4 && <div className="mbl-method"><span>PROCESSING ROUTE</span><div role="group" aria-label="附件处理位置"><button type="button" className={effectiveMethod === "local" ? "active" : ""} aria-pressed={effectiveMethod === "local"} onClick={() => setMethod("local")}>本机工具</button><button type="button" disabled={Boolean(book?.builtin)} className={effectiveMethod === "online" ? "active" : ""} aria-pressed={effectiveMethod === "online"} onClick={() => setMethod("online")}>群晖处理</button></div>{effectiveMethod === "local" ? <p>{book?.builtin ? "内置车型不进入群晖队列，可手动替换预览与原画副本。" : "先在本机生成预览和压缩副本，再用下方入口逐一上传。"}<code>cd tools/model-optimizer && npm start</code></p> : <p>提交后由群晖串行处理；原件不变，任务进度和重试在下方显示。</p>}</div>}
              {page === 5 && <div className="mbl-proof"><h3>逐档验收</h3>{["1K · 首页预览", "2K · 细节", "4K · 高清", "RAW · 原画", "刷新 · 失败重试"].map((item, index) => <button key={item} type="button" disabled={!book || book.present === false} aria-pressed={Boolean(qaChecks[index])} onClick={() => toggleQa(index)}><span>{String(index + 1).padStart(2, "0")}</span><b>{item}</b><em>{qaChecks[index] ? "✓ 本机已确认" : "○ 待人工确认"}</em></button>)}<p>逐项在目标设备看到真实画面后再勾选；记录只保存在当前浏览器，不代表服务器自动验收。</p><Link href="/">打开首页验收 ↗</Link></div>}
              {isNew && (page === 4 || page === 5 || page === 6) && <div className="mbl-locked"><span>↗</span><h3>先完成调校与保存</h3><p>保存成功后，附件与发布后维护会自动关联到新车型。</p><button type="button" onClick={() => goTo("new", 3)}>回到调校页</button></div>}
              <div className="mbl-importer-mount" hidden={!([1, 2, 3, 4, 6].includes(page) && (isNew || Boolean(book)) && !(isNew && page >= 4) && !(book?.builtin && page === 3))}>
                <ModelImporter key={bookId} existing={existing} mode="book" processingMethod={effectiveMethod} bookStage={importerStage} focusModelId={book?.id} onInspected={() => goTo(bookId, 2)} onRetryUpload={() => goTo(bookId, 1)} onSaved={handleSaved} onRemoved={() => goTo("", 0)} onDraftStateChange={setUnsavedDraft} />
              </div>
            </div>
            <div className="mbl-page-foot"><span>{CHAPTERS[page].en}</span><span>{String(page * 2 + 1).padStart(2, "0")}</span></div>
          </div>
          <div className="mbl-fold" aria-hidden="true" />
        </div>}
        <div className="mbl-flip-overlay" ref={flipOverlayRef} aria-hidden="true" inert />
        {page < CHAPTERS.length - 1 && <button type="button" className="mbl-corner-next" onClick={() => flip("next")} disabled={Boolean(turn)} aria-label="翻到下一页" title="翻到下一页"><span aria-hidden="true">↗</span></button>}
      </div>
      <nav className="mbl-reader-controls" aria-label="书页导航"><button type="button" onClick={() => flip("previous")} disabled={page === 0 || Boolean(turn)} aria-label="上一页">←</button><span className="mbl-reader-position"><strong>{String(turnFromPage ?? page).padStart(2, "0")} / {String(CHAPTERS.length - 1).padStart(2, "0")}</strong><small>拖动、滑动或使用方向键</small></span><button type="button" onClick={() => flip("next")} disabled={page === CHAPTERS.length - 1 || Boolean(turn)} aria-label="下一页">→</button></nav>
      <div className="mbl-chapter-dots" aria-label="快速跳转章节">{CHAPTERS.map((chapter, index) => <button key={chapter.en} type="button" onClick={() => leaveTo(bookId, index)} className={index === (turnFromPage ?? page) ? "active" : ""} aria-current={index === (turnFromPage ?? page) ? "page" : undefined} aria-label={`跳到${chapter.label}`} title={chapter.label} />)}</div>
    </section>}
    <footer className="mbl-footer"><span>FIRE ARCHIVE © 2026</span><span>MODELS, KEPT IN MOTION.</span></footer>
  </main>;
}
