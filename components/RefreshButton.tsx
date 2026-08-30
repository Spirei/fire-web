"use client";

import { useState } from "react";

/** 全站统一刷新按钮：小尺寸方形描边 + 循环箭头（参考图：约 24px、图标占 50%），刷新中旋转 */
export default function RefreshButton({
  onClick,
  title = "刷新",
  className = ""
}: {
  onClick: () => void;
  title?: string;
  className?: string;
}) {
  const [turning, setTurning] = useState(false);
  const handleClick = () => {
    setTurning(true);
    window.setTimeout(() => setTurning(false), 650);
    onClick();
  };
  return (
    <button
      type="button"
      onClick={handleClick}
      title={title}
      aria-label={title}
      className={`inline-flex h-6 w-6 flex-none items-center justify-center rounded-[7px] border border-edge bg-white text-muted shadow-sm transition-all duration-200 hover:-translate-y-px hover:bg-brand-hover hover:text-ink active:scale-[.97] dark:border-white/10 dark:bg-[#1c222d] dark:text-white/70 dark:hover:bg-white/10 dark:hover:text-white ${className}`}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={`h-3.5 w-3.5 ${turning ? "animate-spin" : ""}`}
        style={turning ? { animationDuration: "0.6s", animationIterationCount: 1 } : undefined}
      >
        <path d="M20 11a8 8 0 0 0-14.9-4" />
        <path d="M4 5v5h5" />
        <path d="M4 13a8 8 0 0 0 14.9 4" />
        <path d="M20 19v-5h-5" />
      </svg>
    </button>
  );
}
