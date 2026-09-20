"use client";

import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { CURRENT_VERSION } from "@/lib/versions";

/**
 * 设置桌面窗口（页面内嵌形态）：无遮罩、不悬浮，
 * 默认 960px 宽、靠左，按住标题栏可拖动，位置自动保存。默认皮肤为 Orca 中性灰。
 */
export default function SettingsWindow({ children }: { children: ReactNode }) {
  const [futuOnline, setFutuOnline] = useState<boolean | null>(null);
  const [fixed, setFixed] = useState<boolean>(false);
  const [editing, setEditing] = useState(false);
  // auto=true 表示当前分区是「常驻可编辑 + 自动保存」（如站点信息），标题栏不再显示铅笔/完成
  const [autoEdit, setAutoEdit] = useState(false);
  // 监听内容区广播的编辑状态：编辑中标题栏铅笔切换为「✓ 完成」并高亮
  useEffect(() => {
    const onEditState = (e: Event) => {
      const detail = (e as CustomEvent<{ editing?: boolean; auto?: boolean }>).detail;
      setEditing(Boolean(detail?.editing));
      setAutoEdit(Boolean(detail?.auto));
    };
    window.addEventListener("fire:settings-edit-state", onEditState);
    return () => window.removeEventListener("fire:settings-edit-state", onEditState);
  }, []);
  const fixedInitialized = useRef(false);
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const posRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const dragRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const STORAGE_KEY = "fire:settings-window-pos";

  // 挂载后再恢复位置：避免水合不一致，默认最左边 (0,0)
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") as { x?: number; y?: number } | null;
      const x = saved?.x;
      const y = saved?.y;
      if (
        typeof x === "number" &&
        typeof y === "number" &&
        Number.isFinite(x) &&
        Number.isFinite(y) &&
        x >= 0 &&
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
  }, []);

  // 挂载后再恢复已保存固定态：避免「已固定窗口」标题 / 填充 / 透明度在水合时不一致
  useEffect(() => {
    if (fixedInitialized.current) return;
    try {
      setFixed(localStorage.getItem("fire:settings-window-fixed") === "1");
    } catch {
      /* 忽略 */
    }
    fixedInitialized.current = true;
  }, []);

  useEffect(() => {
    if (!dragging || !dragRef.current) return;
    function onMove(e: MouseEvent) {
      const d = dragRef.current;
      if (!d) return;
      const maxX = Math.max(0, window.innerWidth - 200);
      const nextX = Math.min(maxX, Math.max(0, d.baseX + e.clientX - d.startX));
      const nextY = Math.max(0, d.baseY + e.clientY - d.startY);
      posRef.current = { x: nextX, y: nextY };
      setPos(posRef.current);
    }
    function onUp() {
      dragRef.current = null;
      setDragging(false);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(posRef.current));
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
  }, [dragging]);

  function onTitleMouseDown(e: ReactMouseEvent<HTMLDivElement>) {
    if (fixed) return;
    if ((e.target as HTMLElement).closest("a,button")) return;
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startY: e.clientY, baseX: posRef.current.x, baseY: posRef.current.y };
    setDragging(true);
  }

  function toggleFixed() {
    setFixed((f) => {
      const next = !f;
      try {
        localStorage.setItem("fire:settings-window-fixed", next ? "1" : "0");
      } catch {
        /* 忽略 */
      }
      return next;
    });
  }

  useEffect(() => {
    let cancelled = false;
    fetch("/api/health")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled) setFutuOnline(Boolean(data?.data?.futuOpenD?.available));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className={`sv-win-root sv-orca w-full max-w-[960px]`} style={{ transform: `translate(${pos.x}px, ${pos.y}px)` }}>
      <div className="sw-window flex h-[min(780px,calc(100vh-120px))] flex-col overflow-hidden rounded-[10px] border shadow-[0_12px_40px_rgba(0,0,0,.12)]">
        {/* 窗口标题栏 */}
        <div
          onMouseDown={onTitleMouseDown}
          title="按住拖动窗口"
          className="sw-titlebar flex h-[42px] flex-none select-none items-center gap-3 border-b px-4 touch-none"
        >
          <div className="flex gap-2" aria-hidden>
            <i className="h-3 w-3 rounded-full bg-[#ff5f57]" />
            <i className="h-3 w-3 rounded-full bg-[#febc2e]" />
            <i className="h-3 w-3 rounded-full bg-[#28c840]" />
          </div>
          <span className="ml-auto flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => window.dispatchEvent(new Event("fire:settings-cmd-open"))}
              title="搜索设置（⌘K）"
              aria-label="搜索设置"
              className="flex items-center justify-center"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                <circle cx="11" cy="11" r="7" />
                <path d="m21 21-4.3-4.3" />
              </svg>
            </button>
            {/* 标题栏只负责「进入编辑」（永远铅笔，编辑中高亮）；保存只有一个入口 —— 分区头部那颗按钮，
                避免同时出现 ✓ 和「保存」两个都能提交的按钮。站点信息是自动保存，不需要这个入口。 */}
            {!autoEdit && <button
              type="button"
              disabled={editing}
              onClick={() => window.dispatchEvent(new Event("fire:settings-edit-active"))}
              title={editing ? "正在编辑，改完点分区里的「保存」" : "编辑当前设置"}
              aria-label={editing ? "正在编辑" : "编辑当前设置"}
              className={`flex h-6 w-6 items-center justify-center rounded-md transition-colors ${editing ? "text-[#3297f6]" : "hover:bg-white/10"}`}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" />
              </svg>
            </button>}
            <button
              type="button"
              onClick={toggleFixed}
              title={fixed ? "已固定窗口（点击解锁拖动）" : "固定窗口（锁定当前位置）"}
              aria-label="固定窗口"
              className={`flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-white/10 ${fixed ? "opacity-100" : "opacity-60"}`}
            >
              <svg viewBox="0 0 24 24" fill={fixed ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                <path d="M14 4v5l3 3v2H7v-2l3-3V4" />
                <path d="M9 4h6" />
                <path d="M12 14v6" />
              </svg>
            </button>
            <button type="button" title="全站配色" aria-label="全站配色" onClick={() => window.dispatchEvent(new Event("fire:open-palette"))} className="flex h-6 w-6 items-center justify-center rounded-md">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-4 w-4" aria-hidden="true"><path d="M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1-4c-1-1 0-3 2-3h2a3 3 0 0 0 3-3 9 9 0 0 0-9-8Z"/><circle cx="7" cy="10" r=".7"/><circle cx="11" cy="7" r=".7"/><circle cx="16" cy="8" r=".7"/></svg>
            </button>
            <span className="text-[10.5px] opacity-70">v{CURRENT_VERSION.version.replace(/^v/, "")}</span>
          </span>
        </div>

        {/* 窗口主体 */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>

        {/* 底部状态栏（所有版本统一） */}
          <div className="sw-statusbar flex h-[26px] flex-none items-center gap-4 border-t px-4 text-[10.5px]">
          <span className="inline-flex items-center gap-1.5 text-[#0fa07b]">
            <i className={`h-1.5 w-1.5 rounded-full ${futuOnline === null ? "bg-[#d1d5db]" : futuOnline ? "bg-[#0fa07b]" : "bg-[#e5a13b]"}`} />
            {futuOnline === null ? "检测富途 OpenD…" : futuOnline ? "富途 OpenD 已连接" : "富途 OpenD 未连接"}
          </span>
          <span>行情源：{futuOnline ? "富途" : "腾讯 + Yahoo 备用"}</span>
          <span className="ml-auto">修改自动保存</span>
        </div>
      </div>
    </div>
  );
}
