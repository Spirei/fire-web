"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { renderMarkdown } from "@/lib/markdown";
import { showToast } from "@/lib/toast";
import { copyText } from "@/lib/clipboard";
import ThemeToggle from "@/components/ThemeToggle";
import Toaster from "@/components/Toaster";
import "./api-docs.css";

type Mode = "read" | "edit";

interface TocItem {
  level: number;
  text: string;
  slug: string;
}

interface TocGroup {
  level: number;
  text: string;
  slug: string;
  children: TocItem[];
}

function extractToc(md: string): TocGroup[] {
  const groups: TocGroup[] = [];
  let cur: TocGroup | null = null;
  let inCode = false;
  for (const line of md.split("\n")) {
    const t = line.trim();
    if (t.startsWith("```")) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    const m = /^(#{1,3})\s+(.+)$/.exec(t);
    if (!m) continue;
    const level = m[1].length;
    const raw = m[2].trim();
    const text = raw.replace(/\*\*/g, "").trim();
    const slug =
      raw
        .toLowerCase()
        .replace(/[^\w\u4e00-\u9fa5]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60) || `sec-${level}`;
    if (level === 1) continue; // 文档主标题不进目录
    // 「6. 路由清单」章节的 6.1-6.14 都收进 6 作为子项；
    // 未编号的细节标题（请求 / 响应示例 / 字段说明等）不进目录。
    const subSection = /^(\d+)\.\d+\b/.exec(text);
    const parentSection = /^(\d+)\./.exec(cur?.text ?? "");
    if (level === 2 && subSection && cur && parentSection?.[1] === subSection[1]) {
      cur.children.push({ level: 3, text, slug });
    } else if (level === 2) {
      cur = { level, text, slug, children: [] };
      groups.push(cur);
    } else if (level === 3 && cur) {
      if (/^\d+\.\d+\b/.test(text)) {
        cur.children.push({ level, text, slug });
      }
    } else {
      groups.push({ level, text, slug, children: [] });
    }
  }
  return groups;
}

export default function ApiDocsPage() {
  const [mode, setMode] = useState<Mode>("read");
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const [saving, setSaving] = useState(false);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set());
  const contentRef = useRef<HTMLDivElement | null>(null);
  const navRef = useRef<HTMLElement | null>(null);
  const savedContent = useRef("");
  const [markerY, setMarkerY] = useState(40);
  const [hoverSlug, setHoverSlug] = useState<string | null>(null);
  const toc = useMemo(() => extractToc(content), [content]);
  const previewHtml = useMemo(() => renderMarkdown(content), [content]);
  // 路由表首列方法（GET/POST/PUT/DELETE）渲染为彩色徽标，便于扫读
  const methodHtml = useMemo(
    () => previewHtml.replace(/<td>(GET|POST|PUT|DELETE|PATCH)<\/td>/g, (_m, p: string) => `<td><span class="api-method ${p.toLowerCase()}">${p}</span></td>`),
    [previewHtml]
  );
  const docStats = useMemo(() => {
    const lines = content ? content.split("\n").length : 0;
    const endpoints = new Set<string>();
    for (const match of content.matchAll(/(?:GET|POST|PUT|DELETE)\s+(`?\/api[^`\s]+`?)/g)) {
      endpoints.add(match[1]);
    }
    return { lines, endpoints: endpoints.size };
  }, [content]);

  useEffect(() => {
    fetch("/api/api-docs")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (typeof d?.data?.content === "string") {
          setContent(d.data.content);
          savedContent.current = d.data.content;
        }
        setLoading(false);
      })
      .catch(() => setLoading(false));
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setIsAdmin(d?.user?.role === "admin"))
      .catch(() => {});
  }, []);

  // Markdown 内容由 HTML 渲染器生成，统一用事件委托处理代码块/关键路径复制。
  useEffect(() => {
    const copyFrom = async (target: HTMLElement) => {
      const button = target.closest<HTMLElement>("[data-copy-code]");
      const inline = target.closest<HTMLElement>("[data-copy-inline]");
      const trigger = button || inline;
      if (!trigger) return;
      const source = button?.closest("pre")?.querySelector("code") || inline;
      const text = source?.textContent?.trim() ?? "";
      if (!text) return;
      const ok = await copyText(text);
      if (!ok) {
        showToast("复制失败，请手动复制", "err");
        return;
      }
      showToast("已复制");
      if (button) {
        const previousTitle = button.getAttribute("title") || "复制代码";
        const previousLabel = button.getAttribute("aria-label") || "复制代码";
        button.setAttribute("title", "已复制");
        button.setAttribute("aria-label", "已复制");
        button.classList.add("is-copied");
        window.setTimeout(() => {
          button.setAttribute("title", previousTitle);
          button.setAttribute("aria-label", previousLabel);
          button.classList.remove("is-copied");
        }, 1400);
      }
    };
    const onClick = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement) void copyFrom(target);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const target = event.target;
      if (!(target instanceof HTMLElement) || !target.closest("[data-copy-inline], [data-copy-code]")) return;
      event.preventDefault();
      void copyFrom(target);
    };
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  // 阅读模式：滚动监听，目录高亮当前章节
  useEffect(() => {
    if (mode !== "read") return;
    const obs = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (visible?.target?.id) setActiveSlug(visible.target.id);
      },
      { root: contentRef.current, rootMargin: "0px 0px -72% 0px", threshold: 0 }
    );
    toc.forEach((t) => {
      const el = document.getElementById(t.slug);
      if (el) obs.observe(el);
      t.children.forEach((c) => {
        const cel = document.getElementById(c.slug);
        if (cel) obs.observe(cel);
      });
    });
    return () => obs.disconnect();
  }, [mode, toc]);

  // 滚动到新章节时展开其分组；手动收起不触发重复展开。
  useEffect(() => {
    if (!activeSlug || mode !== "read") return;
    const group = toc.find((g) => g.slug === activeSlug || g.children.some((c) => c.slug === activeSlug));
    if (group) {
      setOpenGroups((prev) => new Set(prev).add(group.slug));
    }
  }, [activeSlug, toc, mode]);

  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const update = () => {
      let slug = hoverSlug || activeSlug || toc[0]?.slug;
      const parent = toc.find(group => group.children.some(child => child.slug === slug));
      if (parent && !openGroups.has(parent.slug)) slug = parent.slug;
      const row = Array.from(nav.querySelectorAll<HTMLElement>("[data-toc-row]"))
        .find((item) => item.dataset.tocRow === slug);
      if (row) setMarkerY(row.getBoundingClientRect().top - nav.getBoundingClientRect().top + nav.scrollTop + row.offsetHeight / 2);
    };
    update();
    const observer = new ResizeObserver(update);
    const tree = nav.querySelector(".api-reference-tree");
    if (tree) observer.observe(tree);
    return () => observer.disconnect();
  }, [activeSlug, hoverSlug, openGroups, mode, loading, toc]);

  function jump(slug: string) {
    const el = document.getElementById(slug);
    if (el) {
      el.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
      setActiveSlug(slug);
    }
  }

  function toggleGroup(slug: string) {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }

  async function save() {
    if (saving || !isAdmin) return;
    setSaving(true);
    try {
      const res = await fetch("/api/api-docs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content })
      });
      const d = await res.json().catch(() => null);
      if (res.ok) {
        savedContent.current = content;
        showToast("API 规范文档已保存", "ok");
        setMode("read");
      } else {
        showToast(d?.message || "保存失败，请重试", "err");
      }
    } catch {
      showToast("保存失败，请重试", "err");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="api-docs-shell api-reference-shell min-h-screen">
      <Toaster />
      <div className="api-reference-window mx-auto max-w-7xl px-4 sm:px-6">
        {/* 顶部栏：返回 / 数据源 / 编辑·保存 */}
        <div className="api-reference-toolbar mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="api-reference-lights" aria-hidden="true"><i /><i /><i /></span>
            <Link
              href="/settings"
              className="inline-flex items-center gap-1.5 rounded-full border border-edge bg-white px-3 py-1.5 text-xs font-semibold text-muted transition-colors hover:text-brand-deep dark:bg-white/5 dark:hover:text-[#8ec2ff]"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
                <path d="m12 19-7-7 7-7" />
                <path d="M19 12H5" />
              </svg>
              返回设置
            </Link>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-edge bg-white px-3 py-1.5 text-[11px] text-faint dark:bg-white/5">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
                <path d="M14 2v6h6" />
              </svg>
              docs/api-spec.md
            </span>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            {mode === "read" ? (
              isAdmin && (
                <button
                  type="button"
                  onClick={() => setMode("edit")}
                  className="inline-flex items-center gap-1.5 rounded-full border border-edge-strong bg-white px-3.5 py-1.5 text-xs font-bold text-ink-2 shadow-sm transition-all duration-200 hover:-translate-y-px hover:bg-brand-hover hover:shadow-[0_6px_16px_rgba(0,0,0,.08)] active:translate-y-0 active:scale-[.97] dark:bg-[#1c1c1e] dark:text-white dark:hover:bg-[#26282e]"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
                    <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                  </svg>
                  编辑文档
                </button>
              )
            ) : (
              <>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => {
                    setMode("read");
                    setContent(savedContent.current);
                  }}
                  className="inline-flex items-center gap-1.5 rounded-full border border-edge bg-white px-3.5 py-1.5 text-xs font-semibold text-muted transition-colors hover:text-ink dark:bg-white/5"
                >
                  取消
                </button>
                <button
                  type="button"
                  disabled={saving}
                  onClick={save}
                  className="inline-flex items-center gap-1.5 rounded-full border border-edge-strong bg-white px-3.5 py-1.5 text-xs font-bold text-ink-2 shadow-sm transition-all duration-200 hover:-translate-y-px hover:bg-brand-hover hover:shadow-[0_6px_16px_rgba(0,0,0,.08)] active:translate-y-0 active:scale-[.97] disabled:opacity-60 dark:bg-[#1c1c1e] dark:text-white dark:hover:bg-[#26282e]"
                >
                  {saving ? (
                    <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.3" />
                      <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
                      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" />
                      <path d="M17 21v-8H7v8" />
                      <path d="M7 3v5h8" />
                    </svg>
                  )}
                  保存
                </button>
              </>
            )}
          </div>
        </div>

        <section className="api-reference-heading mb-6 border-b pb-6">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="min-w-0">
              <div className="mb-2 flex items-center gap-1.5 text-xs text-[#a8a6a1] dark:text-[#6f6f6f]">
                <span>Developer center</span>
                <span>/</span>
                <span className="text-[#787774] dark:text-[#a0a0a0]">API reference</span>
              </div>
              <div className="flex items-center gap-3">
                <div>
                  <h1 className="text-2xl font-bold tracking-[-0.02em] text-[#37352f] dark:text-[#e0e0e0]">API 开发接口</h1>
                  <p className="mt-1 max-w-xl text-[13px] leading-5 text-[#787774] dark:text-[#a0a0a0]">面向 Web、iOS 与自动化客户端的统一接口参考。请求、响应、鉴权与错误码集中维护，修改后即时同步。</p>
                </div>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2 sm:min-w-[300px]">
              <div className="api-docs-stat"><span className="api-docs-stat-value">{toc.length}</span><span className="api-docs-stat-label">章节</span></div>
              <div className="api-docs-stat"><span className="api-docs-stat-value">{docStats.endpoints || "—"}</span><span className="api-docs-stat-label">接口</span></div>
              <div className="api-docs-stat"><span className="api-docs-stat-value">{docStats.lines || "—"}</span><span className="api-docs-stat-label">行规范</span></div>
            </div>
          </div>
        </section>

        {loading ? (
          <div className="rounded-lg border border-[#e9e9e7] bg-white p-8 dark:border-[#2b2b2b] dark:bg-[#191919]">
            <div className="h-4 w-40 animate-pulse rounded bg-bg-gray dark:bg-white/10" />
            <div className="mt-4 h-3 w-full animate-pulse rounded bg-bg-gray dark:bg-white/10" />
            <div className="mt-2 h-3 w-3/4 animate-pulse rounded bg-bg-gray dark:bg-white/10" />
          </div>
        ) : mode === "read" ? (
          <>
            {toc.length > 1 && (
              <div className="api-docs-mobile-toc mb-4 flex gap-2 overflow-x-auto pb-1 lg:hidden">
                {toc.map((g) => (
                  <button key={g.slug} type="button" onClick={() => jump(g.slug)} className={`flex-none rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${activeSlug === g.slug ? "border-edge-strong bg-white text-ink shadow-sm dark:bg-[#252c3a] dark:text-white" : "border-edge bg-white/70 text-muted hover:bg-white dark:border-white/10 dark:bg-white/[0.04] dark:hover:bg-white/[0.08]"}`}>
                    {g.text}
                  </button>
                ))}
              </div>
            )}
            <div data-has-toc={toc.length > 1} className="api-reference-layout grid gap-5 lg:grid-cols-[268px_minmax(0,1fr)]">
            {/* 左侧目录大纲 */}
            {toc.length > 1 && (
              <aside className="hidden lg:block">
                <nav ref={navRef} aria-label="API 文档目录" onPointerLeave={() => setHoverSlug(null)} className="api-docs-toc overflow-y-auto">
                  <span className="api-reference-ruler" aria-hidden="true" />
                  <span className="api-reference-marker" aria-hidden="true" style={{ transform: `translateY(${markerY}px)` }}><i /></span>
                  <div className="mb-2 flex items-center justify-between px-2">
                    <p className="flex items-center gap-1.5 text-[11px] font-bold tracking-widest text-faint">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3">
                      <path d="m3 7 6-4 6 4-6 4Z" />
                      <path d="M9 3v5" />
                      <path d="M15 7h6" />
                      <path d="m21 17-3-4-3 4" />
                      <path d="M18 13v8" />
                      <path d="M3 17h6" />
                      <path d="m9 13 3 4 3-4" />
                    </svg>
                    目录
                    </p>
                    <span className="rounded-full bg-bg-gray px-2 py-0.5 text-[10px] font-semibold text-faint dark:bg-white/10">{toc.length} 章</span>
                  </div>
                  <div className="api-reference-tree flex flex-col gap-0.5">
                    {toc.map((g, index) => {
                      const open = openGroups.has(g.slug);
                      const active =
                        activeSlug === g.slug || g.children.some((c) => c.slug === activeSlug);
                      return (
                        <div key={g.slug}>
                          <button
                            data-toc-row={g.slug}
                            onPointerEnter={() => setHoverSlug(g.slug)}
                            onFocus={() => setHoverSlug(g.slug)}
                            onBlur={() => setHoverSlug(null)}
                            aria-current={activeSlug === g.slug ? "location" : undefined}
                            data-current={active || undefined}
                            type="button"
                            aria-expanded={g.children.length > 0 ? open : undefined}
                            onClick={() => (g.children.length > 0 ? toggleGroup(g.slug) : jump(g.slug))}
                            className="api-docs-toc-item flex w-full items-center text-left leading-snug"
                          >
                            <span className={`api-reference-pip pip-${index % 7}`} aria-hidden="true" />
                            <span className="min-w-0 break-words whitespace-normal">{g.text}</span>
                            {g.children.length > 0 && (
                              <svg
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                className={`ml-auto h-3 w-3 flex-none transition-transform duration-200 ${open ? "rotate-180" : ""}`}
                                aria-hidden="true"
                              >
                                <path d="m6 9 6 6 6-6" />
                              </svg>
                            )}
                          </button>
                          <div className={`api-reference-children ${open ? "is-open" : ""}`} inert={!open}><div>
                            {g.children.map((c) => (
                              <button
                                data-toc-row={c.slug}
                                onPointerEnter={() => setHoverSlug(c.slug)}
                                onFocus={() => setHoverSlug(c.slug)}
                                onBlur={() => setHoverSlug(null)}
                                aria-current={activeSlug === c.slug ? "location" : undefined}
                                key={c.slug}
                                type="button"
                                tabIndex={open ? 0 : -1}
                                onClick={() => jump(c.slug)}
                                className="ml-4 mt-0.5 flex w-[calc(100%-1rem)] items-center gap-1 rounded-lg px-2 py-1 text-left leading-snug transition-colors"
                                style={{ paddingLeft: 10 }}
                              >
                                <span className="min-w-0 break-words whitespace-normal">{c.text}</span>
                              </button>
                            ))}</div></div>
                        </div>
                      );
                    })}
                  </div>
                </nav>
              </aside>
            )}
            {/* 文档内容 */}
            <article
              ref={contentRef}
              className="markdown-body api-docs-paper min-w-0"
              dangerouslySetInnerHTML={{ __html: methodHtml }}
            />
            </div>
          </>
        ) : (
          /* 编辑模式：左源码编辑 + 右实时预览 */
          <div className="api-reference-editor-layout grid gap-4 lg:grid-cols-2">
            <section className="api-docs-editor-pane overflow-hidden rounded-lg border border-[#e9e9e7] bg-white dark:border-[#2b2b2b] dark:bg-[#191919]">
              <div className="flex items-center justify-between border-b border-edge bg-bg-gray/60 px-4 py-3 text-xs font-semibold text-muted dark:border-white/10 dark:bg-white/5">
                <span className="flex items-center gap-1.5">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
                    <path d="m8 6-6 6 6 6" />
                    <path d="m16 6 6 6-6 6" />
                  </svg>
                  Markdown 编辑
                </span>
                <span className="text-[10px] text-faint">Ctrl/⌘ 不受影响 · 实时预览</span>
              </div>
              <textarea
                aria-label="Markdown 编辑"
                disabled={saving}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                spellCheck={false}
                className="h-[70vh] w-full resize-none bg-[#0d1117] p-4 font-mono text-[13px] leading-relaxed text-[#e6edf3] outline-none selection:bg-white/20"
              />
            </section>
            <section className="api-docs-editor-pane overflow-hidden rounded-lg border border-[#e9e9e7] bg-white dark:border-[#2b2b2b] dark:bg-[#191919]">
              <div className="flex items-center justify-between border-b border-edge bg-bg-gray/60 px-4 py-3 text-xs font-semibold text-muted dark:border-white/10 dark:bg-white/5">
                <span className="flex items-center gap-1.5">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
                    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                  实时预览
                </span>
                <span className="text-[10px] text-faint">{content.length} 字符</span>
              </div>
              <div className="markdown-body api-docs-paper h-[70vh] overflow-y-auto bg-white p-5 dark:bg-[#0d1117] sm:p-7">
                <article dangerouslySetInnerHTML={{ __html: methodHtml }} />
              </div>
            </section>
          </div>
        )}
      </div>
    </main>
  );
}
