"use client";

/** 全站统一删除图标（苹果 SF Symbols trash）：浅色用 trash，深色用 trash.fill */
export default function DeleteIcon({
  size = 15,
  className = ""
}: {
  size?: number;
  className?: string;
}) {
  return (
    <span className={`inline-flex flex-none items-center justify-center ${className}`} aria-hidden>
      <img src="/icons/trash.svg" alt="" className="dark:hidden" style={{ width: size, height: size }} />
      <img src="/icons/trash.fill.svg" alt="" className="hidden dark:block" style={{ width: size, height: size }} />
    </span>
  );
}
