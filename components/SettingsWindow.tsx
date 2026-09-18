"use client";

import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { CURRENT_VERSION } from "@/lib/versions";

/** 设置页视觉版本（对应 public/mockups 预览稿）：调色盘下拉切换，选中后整体换肤 */
const SETTINGS_VERSIONS: { key: string; label: string; swatches: string[] }[] = [
  { key: "orca", label: "Orca 中性灰", swatches: ["#f5f5f5", "#ffffff", "#0a0a0a"] },
  { key: "v1", label: "V1 富途橙", swatches: ["#171c26", "#ffffff", "#ff9828"] },
  { key: "v5", label: "V5 Notion", swatches: ["#f7f6f3", "#ffffff", "#37352f"] },
  { key: "v7", label: "V7 Claude", swatches: ["#211f1b", "#f5f4ef", "#d97757"] },
  { key: "v14", label: "V14 极简风", swatches: ["#26262b", "#1c1c1c", "#b4b8ff"] },
  { key: "v16", label: "V16 极简青绿", swatches: ["#0e1714", "#ffffff", "#0e9f7e"] },
  { key: "v17", label: "V17 石墨黑金", swatches: ["#101013", "#fffdf8", "#c9a45c"] },
  { key: "okx", label: "OKX 风", swatches: ["#0b0e11", "#ffffff", "#00b7ff"] },
  { key: "binance", label: "币安风", swatches: ["#0b0e11", "#ffffff", "#f0b90b"] }
];

/**
 * 设置桌面窗口（页面内嵌形态）：无遮罩、不悬浮，
 * 默认 960px 宽、靠左，按住标题栏可拖动，位置自动保存。默认皮肤为 Orca 中性灰。
 */
export default function SettingsWindow({ children }: { children: ReactNode }) {
  const [futuOnline, setFutuOnline] = useState<boolean | null>(null);
  const [variant, setVariant] = useState<string>("orca");
  const [variantOpen, setVariantOpen] = useState(false);
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

  // 挂载后再恢复已保存主题：避免服务端固定 sv-v14、客户端读到 localStorage 不一致而水合报错
  useEffect(() => {
    try {
      const saved = localStorage.getItem("fire:settings-version");
      if (saved && SETTINGS_VERSIONS.some((v) => v.key === saved)) setVariant(saved);
    } catch {
      /* 忽略 */
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

  function pickVariant(key: string) {
    setVariant(key);
    setVariantOpen(false);
    try {
      localStorage.setItem("fire:settings-version", key);
    } catch {
      /* 忽略 */
    }
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
    <div className={`sv-win-root sv-${variant} w-full max-w-[960px]`} style={{ transform: `translate(${pos.x}px, ${pos.y}px)` }}>
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
            {/* 风格切换（V1 / V5 / V7 / V14 / V16） */}
            <span className="sv-variant relative">
              <button
                type="button"
                onClick={() => setVariantOpen((o) => !o)}
                title="风格切换"
                aria-label="风格切换"
                className="flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-white/10"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                  <path d="m12 3 8.2 4.6L12 12.2 3.8 7.6Z" />
                  <path d="m3.8 12.3 8.2 4.6 8.2-4.6" opacity="0.72" />
                  <path d="m3.8 16.9 8.2 4.6 8.2-4.6" opacity="0.45" />
                </svg>
              </button>
              {variantOpen && (
                <div className="sv-menu absolute right-0 top-full z-50 mt-1.5 w-44 overflow-hidden rounded-xl border py-1 shadow-pop">
                  {SETTINGS_VERSIONS.map((v) => (
                    <button
                      key={v.key}
                      type="button"
                      onClick={() => pickVariant(v.key)}
                      className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12px] transition-colors ${variant === v.key ? "font-semibold" : ""}`}
                    >
                      <span className="flex h-4 w-7 flex-none items-center overflow-hidden rounded-[4px] border border-black/10 dark:border-white/15">
                        {v.swatches.map((c, i) => (
                          <i key={i} className="h-full flex-1" style={{ backgroundColor: c }} />
                        ))}
                      </span>
                      {(() => {
                        const m = v.label.match(/^(V\d+)\s+(.*)$/);
                        return m ? (
                          <><span className="font-serif">{m[1]}</span><span> {m[2]}</span></>
                        ) : (
                          v.label
                        );
                      })()}
                      {variant === v.key && <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" className="ml-auto h-3 w-3"><path d="m5 13 4 4L19 7" /></svg>}
                    </button>
                  ))}
                </div>
              )}
            </span>
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
