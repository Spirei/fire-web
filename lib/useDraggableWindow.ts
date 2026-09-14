"use client";

import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

const WINDOW_EDGE_GUTTER = 12;

/**
 * 可拖动桌面窗口（与设置窗口同款）：按住标题栏拖动整个容器，
 * 位置自动保存到 localStorage；默认 (0,0) 靠左。
 */
export default function useDraggableWindow(storageKey: string, locked = false) {
  const windowRef = useRef<HTMLElement | null>(null);
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

  // 保存的位置可能来自较宽的窗口，或来自侧栏间距调整前。恢复后重新夹在
  // 当前内容区内，并留出一圈安全间距，避免卡片边框贴住外层侧栏/视口。
  useLayoutEffect(() => {
    const panel = windowRef.current;
    const boundary = panel?.parentElement;
    if (!panel || !boundary) return;
    const panelRect = panel.getBoundingClientRect();
    const boundaryRect = boundary.getBoundingClientRect();
    const availableGutter = Math.max(0, (boundaryRect.width - panelRect.width) / 2);
    const gutter = Math.min(WINDOW_EDGE_GUTTER, availableGutter);
    const leftDelta = boundaryRect.left + gutter - panelRect.left;
    const rightDelta = boundaryRect.right - gutter - panelRect.right;
    let nextX = posRef.current.x;
    if (leftDelta > 0) nextX += leftDelta;
    else if (rightDelta < 0) nextX += rightDelta;
    if (nextX === posRef.current.x) return;
    posRef.current = { ...posRef.current, x: nextX };
    setPos(posRef.current);
    try {
      localStorage.setItem(storageKey, JSON.stringify(posRef.current));
    } catch {
      /* localStorage 不可用时仅修正本次布局 */
    }
  }, [storageKey, pos.x]);

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
    const gutter = panelRect && boundaryRect
      ? Math.min(WINDOW_EDGE_GUTTER, Math.max(0, (boundaryRect.width - panelRect.width) / 2))
      : 0;
    const minX = panelRect && boundaryRect ? baseX + boundaryRect.left + gutter - panelRect.left : -window.innerWidth + 200;
    const maxX = panelRect && boundaryRect ? baseX + boundaryRect.right - gutter - panelRect.right : window.innerWidth - 200;
    dragRef.current = { startX: e.clientX, startY: e.clientY, baseX, baseY: posRef.current.y, minX, maxX };
    setDragging(true);
  }

  return { pos, dragging, onTitleMouseDown, windowRef };
}
