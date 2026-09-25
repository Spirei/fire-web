"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import ModelImporter, { type ImportedModelRow, type ImportReport } from "./ModelImporter";
import { usePersistedState } from "@/lib/usePersistedState";

const CHAPTERS = [
  { label: "封面", en: "COVER", era: "车型档案" },
  { label: "原件", en: "THE ORIGINAL", era: "发布前" },
  { label: "体检", en: "INSPECTION", era: "发布前" },
  { label: "调校", en: "THE WORKBENCH", era: "发布中" },
  { label: "附件", en: "THE EDITION", era: "发布中" },
  { label: "验收", en: "THE PROOF", era: "发布前" },
  { label: "维护", en: "AFTER RELEASE", era: "发布后" }
] as const;

const COLORS = [
  { cover: "#e8e4d6", ink: "#202328", edge: "#b5ae93", height: 380, width: 68 },
  { cover: "#a8cdd5", ink: "#173139", edge: "#6d99a6", height: 475, width: 57 },
  { cover: "#bd493a", ink: "#fff4e4", edge: "#91352f", height: 338, width: 54 },
  { cover: "#ed312a", ink: "#ffe8d2", edge: "#9c2b2b", height: 393, width: 68 },
  { cover: "#eb006b", ink: "#fff7e9", edge: "#aa0753", height: 455, width: 59 },
  { cover: "#f1e7d0", ink: "#1a2222", edge: "#b9ab8f", height: 530, width: 65 },
  { cover: "#1b54a6", ink: "#f6e9d0", edge: "#163c73", height: 474, width: 56 },
  { cover: "#e2c0ac", ink: "#342626", edge: "#ab8574", height: 405, width: 61 },
  { cover: "#4d8eb5", ink: "#f8e2df", edge: "#336481", height: 494, width: 67 },
  { cover: "#353d41", ink: "#e7c7ae", edge: "#1d2527", height: 408, width: 64 },
  { cover: "#c4c984", ink: "#252c22", edge: "#899257", height: 344, width: 54 }
];

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
  const [shelfDragging, setShelfDragging] = useState(false);
  const [unsavedDraft, setUnsavedDraft] = useState(false);
  const [method, setMethod] = usePersistedState<"local" | "online">("fire:showcase:processing-method", "local");
  const [qa, setQa] = usePersistedState<Record<string, boolean[]>>("fire:showcase:qa-checks", {});
  const timers = useRef<number[]>([]);
  const touchX = useRef<number | null>(null);
  const shelfDrag = useRef<{ x: number; left: number; moved: boolean } | null>(null);
  const shelfDragUntil = useRef(0);
  const book = existing.find((item) => item.id === bookId);
  const isNew = bookId === "new";
  const selected = Boolean(book || isNew);
  const effectiveMethod = book?.builtin ? "local" : method;
  const palette = book ? COLORS[existing.findIndex((item) => item.id === book.id) % COLORS.length] : COLORS[0];
  const label = book?.label ?? "未命名车型";

  const syncUrl = useCallback((id: string, nextPage: number) => {
    const url = new URL(window.location.href);
    if (id) { url.searchParams.set("book", id); url.searchParams.set("page", String(nextPage)); }
    else { url.searchParams.delete("book"); url.searchParams.delete("page"); }
    window.history.pushState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);
  const goTo = useCallback((id: string, nextPage: number) => {
    timers.current.forEach(window.clearTimeout);
    timers.current = [];
    setTurn(null);
    setBookId(id);
    setPage(nextPage);
    syncUrl(id, nextPage);
  }, [syncUrl]);
  const confirmDiscard = useCallback(() => window.confirm("原件尚未保存，离开画册后需要重新上传。确定离开吗？"), []);
  const leaveTo = useCallback((id: string, nextPage: number) => {
    const discarding = bookId === "new" && unsavedDraft && (id !== "new" || nextPage === 0);
    if (discarding && !confirmDiscard()) return;
    if (discarding) setUnsavedDraft(false);
    goTo(id, nextPage);
  }, [bookId, confirmDiscard, goTo, unsavedDraft]);
  const flip = useCallback((direction: "next" | "previous") => {
    if (turn || !selected) return;
    const next = Math.min(CHAPTERS.length - 1, Math.max(0, page + (direction === "next" ? 1 : -1)));
    if (next === page) return;
    if (isNew && unsavedDraft && next === 0) {
      if (!confirmDiscard()) return;
      setUnsavedDraft(false);
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce), (max-width: 620px)").matches) { goTo(bookId, next); return; }
    setTurn(direction);
    timers.current.push(window.setTimeout(() => { setPage(next); syncUrl(bookId, next); }, 265));
    timers.current.push(window.setTimeout(() => setTurn(null), 560));
  }, [bookId, confirmDiscard, goTo, isNew, page, selected, syncUrl, turn, unsavedDraft]);
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
      setTurn(null);
    };
    window.addEventListener("popstate", pop);
    return () => { window.removeEventListener("popstate", pop); timers.current.forEach(window.clearTimeout); };
  }, [bookId, confirmDiscard, existing, page, syncUrl, unsavedDraft]);
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
        className={`mbl-shelf-scroll${shelfDragging ? " is-dragging" : ""}`}
        aria-label="横向滚动书架"
        tabIndex={0}
        onPointerDown={(event) => {
          if (event.pointerType !== "mouse" || event.button !== 0 || event.currentTarget.scrollWidth <= event.currentTarget.clientWidth) return;
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
        {existing.map((model, index) => { const color = COLORS[index % COLORS.length]; return <button key={model.id} type="button" className="mbl-spine" onClick={() => goTo(model.id, 0)} style={{ "--spine-bg": color.cover, "--spine-ink": color.ink, "--spine-edge": color.edge, "--spine-height": `${color.height}px`, "--spine-width": `${color.width}px` } as React.CSSProperties} aria-label={`打开 ${model.label} 车型画册`}>
          <span className="mbl-spine-rule" aria-hidden="true" /><span className={`mbl-spine-title${model.label.length > 16 ? " is-long" : ""}`}>{model.label}</span><span className="mbl-spine-number">{String(index + 1).padStart(2, "0")}</span>
          <span className="mbl-spine-peek" aria-hidden="true">{model.cover ? <img src={model.cover} alt="" /> : <b>{model.label}</b>}<small>{model.note || "MODEL ARCHIVE"}</small></span>
        </button>; })}
        <button type="button" className="mbl-spine mbl-spine-new" onClick={() => goTo("new", 0)} aria-label="新建车型画册"><span>＋</span><small>NEW<br />VOLUME</small></button>
      </div></div>
      <div className="mbl-shelf-caption"><span>SELECT A VOLUME TO OPEN</span><span>← DRAG TO EXPLORE →</span></div>
    </section> : <section className="mbl-reader" aria-label={`${label} 车型画册`} onTouchStart={(event) => { touchX.current = event.touches[0]?.clientX ?? null; }} onTouchEnd={(event) => { if (touchX.current === null) return; const delta = (event.changedTouches[0]?.clientX ?? touchX.current) - touchX.current; touchX.current = null; if (Math.abs(delta) > 90) flip(delta < 0 ? "next" : "previous"); }}>
      <div className="mbl-reader-top"><button type="button" onClick={() => leaveTo("", 0)}>← 返回书架</button><span>FIRE / {label.toUpperCase()}</span><span>{String(page + 1).padStart(2, "0")} / {String(CHAPTERS.length).padStart(2, "0")}</span></div>
      <div className={`mbl-book${page === 0 ? " is-cover" : ""}${turn ? ` is-turning-${turn}` : ""}`}>
        {page === 0 ? <div className="mbl-cover" style={{ "--cover-edge": palette.edge } as React.CSSProperties}>
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
            <div className="mbl-page-kicker"><span>MODEL / {bookId.toUpperCase()}</span><span>{shortDate(book?.updatedAt ?? "")}</span></div>
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
        {turn && <div className="mbl-turn-sheet" aria-hidden="true"><span /><span /></div>}
      </div>
      <nav className="mbl-reader-controls" aria-label="书页导航"><button type="button" onClick={() => flip("previous")} disabled={page === 0 || Boolean(turn)} aria-label="上一页">←</button><span>{CHAPTERS[page].era} <i>·</i> {CHAPTERS[page].label}</span><button type="button" onClick={() => flip("next")} disabled={page === CHAPTERS.length - 1 || Boolean(turn)} aria-label="下一页">→</button></nav>
      <div className="mbl-chapter-dots" aria-label="快速跳转章节">{CHAPTERS.map((chapter, index) => <button key={chapter.en} type="button" onClick={() => leaveTo(bookId, index)} className={index === page ? "active" : ""} aria-current={index === page ? "page" : undefined} aria-label={`跳到${chapter.label}`} title={chapter.label} />)}</div>
    </section>}
    <footer className="mbl-footer"><span>FIRE ARCHIVE © 2026</span><span>MODELS, KEPT IN MOTION.</span></footer>
  </main>;
}
