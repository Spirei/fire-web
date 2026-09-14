"use client";

import { useEffect, useRef, useState } from "react";

export default function SidebarPet({ userId }: { userId: string }) {
  const storageKey = `fire:sidebar-pet:${userId}`;
  const rootRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [reacting, setReacting] = useState(false);

  useEffect(() => {
    try { setVisible(localStorage.getItem(storageKey) !== "hidden"); } catch { /* 存储不可用时保持显示 */ }
  }, [storageKey]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [menuOpen]);

  function setPetVisible(next: boolean) {
    setVisible(next);
    try { localStorage.setItem(storageKey, next ? "visible" : "hidden"); } catch { /* 忽略存储异常 */ }
  }

  function greet() {
    setReacting(true);
    window.setTimeout(() => setReacting(false), 520);
  }

  return (
    <div ref={rootRef} className="sidebar-pet-root">
      {visible ? (
        <button type="button" className={`sidebar-pet ${reacting ? "is-reacting" : ""}`} onClick={() => setMenuOpen((open) => !open)} onDoubleClick={greet} aria-expanded={menuOpen} aria-label="小火苗宠物设置" title="单击设置，双击互动">
          <svg viewBox="0 0 32 32" aria-hidden="true">
            <path className="sidebar-pet-flame" d="M16 3c1.2 4.8 7.7 6.4 7.7 13.2A7.7 7.7 0 0 1 16 24a7.7 7.7 0 0 1-7.7-7.8c0-3.8 2.2-6.6 5.1-9.4.1 3 1.2 4.2 2.4 5.1C18 9.5 18.3 6.2 16 3Z" />
            <path className="sidebar-pet-face" d="M12.1 17.2c.8.7 1.7 1.1 3.9 1.1s3.1-.4 3.9-1.1" />
            <circle className="sidebar-pet-eye" cx="12.7" cy="14.6" r="1" />
            <circle className="sidebar-pet-eye" cx="19.3" cy="14.6" r="1" />
          </svg>
          <span className="sidebar-pet-heart" aria-hidden="true">♥</span>
        </button>
      ) : (
        <button type="button" className="sidebar-pet-restore" onClick={() => setMenuOpen(true)} aria-label="显示宠物设置" title="显示宠物设置">
          <svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 3c1.2 4.8 7.7 6.4 7.7 13.2A7.7 7.7 0 0 1 16 24a7.7 7.7 0 0 1-7.7-7.8c0-3.8 2.2-6.6 5.1-9.4.1 3 1.2 4.2 2.4 5.1C18 9.5 18.3 6.2 16 3Z" /></svg>
        </button>
      )}
      {menuOpen && (
        <div className="sidebar-pet-menu" role="dialog" aria-label="宠物设置">
          <div>
            <strong>小火苗</strong>
            <span>轻量桌面宠物</span>
          </div>
          <button type="button" role="switch" aria-checked={visible} onClick={() => setPetVisible(!visible)} className="sidebar-pet-switch">
            <span />
          </button>
        </div>
      )}
    </div>
  );
}
