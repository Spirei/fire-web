"use client";

import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

/**
 * 可拖动桌面窗口（与设置窗口同款）：按住标题栏拖动整个容器，
 * 位置自动保存到 localStorage；默认 (0,0) 靠左。
 */
export default function useDraggableWindow(storageKey: string, locked = false) {
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const posRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const dragRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number; minX: number; maxX: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  // 挂载后恢复位置，避免水合不一致；默认最左边 (0,0)
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || "null") as { x?: number; y?: number } | null;
      const x = saved?.x;
      const y = saved?.y;
      if (
        typeof x === "number" &&
        typeof y === "number" &&
        Number.isFinite(x) &&
        Number.isFinite(y) &&
        x > -10000 &&
        y >= 0 &&
        x < 10000 &&
        y < 10000
      ) {
        const restored = { x, y };
        posRef.current = restored;
        setPos(restored);
      }
    } catch {
      /* 忽略损坏的本地位置 */
    }
  }, [storageKey]);

  useEffect(() => {
    if (!dragging || !dragRef.current) return;
    function onMove(e: MouseEvent) {
      const d = dragRef.current;
      if (!d) return;
      const nextX = Math.min(d.maxX, Math.max(d.minX, d.baseX + e.clientX - d.startX));
      const nextY = Math.max(0, d.baseY + e.clientY - d.startY);
      posRef.current = { x: nextX, y: nextY };
      setPos(posRef.current);
    }
    function onUp() {
      dragRef.current = null;
      setDragging(false);
      try {
        localStorage.setItem(storageKey, JSON.stringify(posRef.current));
      } catch {
        /* localStorage 不可用时仅本次拖动生效 */
      }
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging, storageKey]);

  function onTitleMouseDown(e: ReactMouseEvent<HTMLDivElement>) {
    if (locked || window.innerWidth < 768) return;
    if ((e.target as HTMLElement).closest("a,button,input,select,textarea,[data-drag-skip]")) return;
    e.preventDefault();
    const panel = e.currentTarget.closest("main") as HTMLElement | null;
    const panelRect = panel?.getBoundingClientRect();
    const boundaryRect = panel?.parentElement?.getBoundingClientRect();
    const baseX = posRef.current.x;
    const minX = panelRect && boundaryRect ? baseX + boundaryRect.left - panelRect.left : -window.innerWidth + 200;
    const maxX = panelRect && boundaryRect ? baseX + boundaryRect.right - panelRect.right : window.innerWidth - 200;
    dragRef.current = { startX: e.clientX, startY: e.clientY, baseX, baseY: posRef.current.y, minX, maxX };
    setDragging(true);
  }

  return { pos, dragging, onTitleMouseDown };
}
