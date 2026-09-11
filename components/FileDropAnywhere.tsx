"use client";

import { useEffect, useState } from "react";

/**
 * 全站拖拽上传：把文件拖到页面任意位置松手，就落到「离鼠标最近的那个上传控件」上。
 *
 * 站内上传入口有三十多个（头像 / 站点图标 / 背景 / 卡面 / 附件 / 截图导入 …），
 * 逐个改成交互式拖放区既啰嗦又难保持一致，所以统一在窗口层做：
 *   - 拖拽经过时给最近的目标加蓝色描边，并浮出提示条，松手即触发它的 change 事件；
 *   - `accept` 能对上的目标优先（拖图片不会落到只收 csv 的入口上）；
 *   - 页面内自带拖放区的元素（比如新增卡片的卡面框）已经 preventDefault 过，这里直接让位；
 *   - 拖到没有上传控件的页面就什么都不做（但会拦住浏览器直接打开文件）。
 */
interface DropTarget {
  input: HTMLInputElement;
  anchor: HTMLElement;
  rect: DOMRect;
  accept: string;
}

/** accept 里的一项能否匹配拖进来的文件（.png / image/* / image/png） */
function acceptMatches(accept: string, file: File | null, mime: string): boolean {
  if (!accept.trim()) return true;
  const tokens = accept.split(",").map((token) => token.trim().toLowerCase()).filter(Boolean);
  const type = (file?.type || mime || "").toLowerCase();
  const name = (file?.name || "").toLowerCase();
  return tokens.some((token) => {
    if (token === "*" || token === "*/*") return true;
    if (token.endsWith("/*")) return type.startsWith(token.slice(0, -1));
    if (token.startsWith(".")) return name.endsWith(token);
    return type === token;
  });
}

export default function FileDropAnywhere() {
  const [active, setActive] = useState(false);

  useEffect(() => {
    let marked: HTMLElement | null = null;
    let cached: { list: DropTarget[]; at: number } = { list: [], at: 0 };

    const listTargets = (): DropTarget[] => {
      const now = performance.now();
      if (now - cached.at < 500) return cached.list;
      const list: DropTarget[] = [];
      document.querySelectorAll<HTMLInputElement>('input[type="file"]').forEach((input) => {
        if (input.disabled) return;
        const anchor = (input.closest("label") ?? input.parentElement ?? input) as HTMLElement;
        const rect = anchor.getBoundingClientRect();
        if (rect.width < 8 || rect.height < 8) return;
        if (rect.bottom < -200 || rect.top > window.innerHeight + 200) return;
        list.push({ input, anchor, rect, accept: input.accept || "" });
      });
      cached = { list, at: now };
      return list;
    };

    const clearMark = () => {
      if (!marked) return;
      marked.style.outline = "";
      marked.style.outlineOffset = "";
      marked.style.transition = "";
      marked = null;
    };

    const mark = (anchor: HTMLElement) => {
      if (marked === anchor) return;
      clearMark();
      marked = anchor;
      anchor.style.transition = "outline-color .15s ease";
      anchor.style.outline = "2px solid #3297f6";
      anchor.style.outlineOffset = "3px";
    };

    /** 就近取目标：先筛 accept 能对上的，再比鼠标到目标中心的距离 */
    const nearest = (x: number, y: number, file: File | null, mime: string): DropTarget | null => {
      const all = listTargets();
      if (all.length === 0) return null;
      const matched = all.filter((target) => acceptMatches(target.accept, file, mime));
      const pool = matched.length > 0 ? matched : all;
      let best: DropTarget | null = null;
      let bestDistance = Number.POSITIVE_INFINITY;
      pool.forEach((target) => {
        const dx = x - (target.rect.left + target.rect.width / 2);
        const dy = y - (target.rect.top + target.rect.height / 2);
        const distance = dx * dx + dy * dy;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = target;
        }
      });
      return best;
    };

    const onDragOver = (event: DragEvent) => {
      if (event.defaultPrevented) return;
      if (!event.dataTransfer?.types.includes("Files")) return;
      const mime = event.dataTransfer.items[0]?.type ?? "";
      const target = nearest(event.clientX, event.clientY, null, mime);
      if (!target) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setActive(true);
      mark(target.anchor);
    };

    const onDrop = (event: DragEvent) => {
      if (event.defaultPrevented) {
        setActive(false);
        clearMark();
        return;
      }
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length === 0) return;
      // 有文件就一律拦住默认行为，避免浏览器直接打开它
      event.preventDefault();
      setActive(false);
      const target = nearest(event.clientX, event.clientY, files[0], files[0].type);
      clearMark();
      if (!target) return;
      const transfer = new DataTransfer();
      files.forEach((file) => transfer.items.add(file));
      target.input.files = transfer.files;
      target.input.dispatchEvent(new Event("input", { bubbles: true }));
      target.input.dispatchEvent(new Event("change", { bubbles: true }));
    };

    const onDragLeave = (event: DragEvent) => {
      if (event.relatedTarget) return;
      setActive(false);
      clearMark();
    };
    const onDragEnd = () => {
      setActive(false);
      clearMark();
    };

    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("dragend", onDragEnd);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("dragend", onDragEnd);
      clearMark();
    };
  }, []);

  if (!active) return null;
  return (
    <>
      <div className="pointer-events-none fixed inset-3 z-[10018] rounded-2xl border-2 border-dashed border-[#3297f6]/60" />
      <div className="pointer-events-none fixed inset-x-0 top-6 z-[10019] flex justify-center">
        <div className="rounded-full bg-[#111]/92 px-4 py-2 text-xs font-semibold text-white shadow-pop backdrop-blur">
          松手即可上传 · 会放到蓝色描边的那个上传位置
        </div>
      </div>
    </>
  );
}
