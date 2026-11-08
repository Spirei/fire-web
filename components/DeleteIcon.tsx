"use client";

/** Built-in shared trash icon; independent of host-mounted icon files. */
export default function DeleteIcon({
  size = 15,
  className = ""
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg className={`flex-none ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M4 6h16M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 6l1 14a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-14M10 10v7m4-7v7"/>
    </svg>
  );
}
