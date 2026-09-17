"use client";

import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

const WINDOW_EDGE_GUTTER = 12;

type Offset = { x: number; y: number };
type Rect = { left: number; right: number; width: number };

/**
 * 面板「还没有加位移」时的矩形：transform 是纯平移，所以拿当前矩形减去当前位移即可反推出来。
 * 居中基准（mx-auto 得到的那个位置）就是这个矩形。
 */
export function baseRectFrom(rect: Rect, offset: Offset): Rect {
  return { left: rect.left - offset.x, right: rect.right - offset.x, width: rect.width };
}

/** 内容区左右各留的安全边距（内容区比面板还窄时为 0）。 */
export function edgeGutter(panelWidth: number, boundaryWidth: number) {
  return Math.min(WINDOW_EDGE_GUTTER, Math.max(0, (boundaryWidth - panelWidth) / 2));
}

/** 把用户位置夹进内容区（只算 X，纵向不动）；内容区比面板还窄时贴左。 */
export function clampOffsetX(userX: number, base: Rect, bounds: Rect): number {
  const gutter = edgeGutter(base.width, bounds.width);
  const minX = bounds.left + gutter - base.left;
  const maxX = bounds.right - gutter - base.right;
  return maxX >= minX ? Math.min(maxX, Math.max(minX, userX)) : minX;
}

/**
 * 可拖动桌面窗口（与设置窗口同款）：按住标题栏拖动整个容器，
 * 位置自动保存到 localStorage；默认 (0,0) 靠左。
 *
 * 布局是「居中 + 位移」：面板由 mx-auto 居中，再用 translate 偏移。内容区比保存位置对应的
 * 窗口窄时（换显示器、窗口缩小、窄屏打开），偏移会露在内容区外，需要夹回来 —— 但**只夹渲染、
 * 不写回 localStorage**。之前这里会把夹过的值持久化，等于用户钉好的位置被静默改成靠中间的值，
 * 之后再打开就一直停在中间（表现为「过一段时间卡片跑到中间」）。用户的位置是唯一真相：
 * 夹紧只在当前这场布局里生效，窗口变宽后卡片会回到用户放的地方。
 */
export default function useDraggableWindow(storageKey: string, locked = false) {
  const windowRef = useRef<HTMLElement | null>(null);
  /** 用户保存的位置（唯一真相，只有拖动结束才写） */
  const posRef = useRef<Offset>({ x: 0, y: 0 });
  /** 渲染用的位置：正常情况下等于用户位置，露在内容区外时被夹回来 */
  const [pos, setPos] = useState<Offset>({ x: 0, y: 0 });
  const dragRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number; minX: number; maxX: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  /** 布局变化（窗口尺寸 / 内容区宽度）时重算一次夹紧 */
  const [layoutTick, setLayoutTick] = useState(0);

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

  // 渲染位置 = 用户位置夹进当前内容区（**不写回 localStorage**）：
  // 内容区暂时比保存位置窄时只影响这一帧的显示，窗口变宽后卡片会回到用户放的位置。
  useLayoutEffect(() => {
    const panel = windowRef.current;
    const boundary = panel?.parentElement;
    if (!panel || !boundary) return;
    const bounds = boundary.getBoundingClientRect();
    const base = baseRectFrom(panel.getBoundingClientRect(), pos);
    const clampedX = clampOffsetX(posRef.current.x, base, bounds);
    if (clampedX === pos.x) return;
    setPos({ x: clampedX, y: posRef.current.y });
  }, [storageKey, pos.x, pos.y, layoutTick]);

  // 内容区宽度 / 窗口尺寸变化后重算一次：换显示器、侧栏收放、窗口缩放都能跟上
  useEffect(() => {
    const bump = () => setLayoutTick((value) => value + 1);
    window.addEventListener("resize", bump);
    const boundary = windowRef.current?.parentElement ?? null;
    const observer = boundary && typeof ResizeObserver === "function" ? new ResizeObserver(bump) : null;
    if (boundary && observer) observer.observe(boundary);
    return () => {
      window.removeEventListener("resize", bump);
      observer?.disconnect();
    };
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
    const baseX = posRef.current.x;
    // 拖动边界用「居中基准」算，不再拿带位移的矩形去叠加，避免位移被反复叠加/吃掉
    const boundary = panel?.parentElement ?? null;
    const bounds = boundary?.getBoundingClientRect();
    const base = panel ? baseRectFrom(panel.getBoundingClientRect(), pos) : null;
    const gutter = base && bounds ? edgeGutter(base.width, bounds.width) : 0;
    const minX = base && bounds ? bounds.left + gutter - base.left : -window.innerWidth + 200;
    const maxX = base && bounds ? bounds.right - gutter - base.right : window.innerWidth - 200;
    dragRef.current = { startX: e.clientX, startY: e.clientY, baseX, baseY: posRef.current.y, minX, maxX };
    setDragging(true);
  }

  return { pos, dragging, onTitleMouseDown, windowRef };
}
